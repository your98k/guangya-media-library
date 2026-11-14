/**
 * rules.mjs — 选版规则（纯函数，可独立测试）。
 *
 * 只有两条是硬规则，其余是「选版设置」，由使用者在面板里自己抉择：
 * - 硬规则：一集只存一个版本；只补缺集（不在待补清单里的集数一律不碰）；
 * - 选版设置（面板「选版设置」，worker 每轮从面板读取；面板未设置时回退
 *   环境变量 VERSION_POLICY 的映射，见 settingsFromPolicy/defaultSettings）：
 *   模式 best = 只存评分最优的一个；any_upgrade = 先到先存、发现更优后替换；
 *   评分按 version_criteria 的顺序逐维度比（分辨率 / 画质 / 文件大小），
 *   文件大小的方向由 version_size_prefer 决定。纯个人口味，没有对错。
 * - 改名只写可证实的规格：源文件名里没写的规格字段不编造。
 */

// 与面板 server/index.js 里 SHARE_URL_RE 完全一致的分享链接形状校验。
export const SHARE_URL_RE = /^https:\/\/www\.guangyapan\.com\/s\/[A-Za-z0-9]+_[A-Za-z0-9_-]+\/?$/;

export function isGuangyaShareUrl(url) {
  return typeof url === 'string' && SHARE_URL_RE.test(url.trim());
}

const FULLWIDTH_DIGITS = /[０-９]/g;
function normalizeName(name) {
  return String(name ?? '')
    .replace(FULLWIDTH_DIGITS, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/．/g, '.');
}

/**
 * 从文件名解析季/集：返回 { season, episode } 或 null。
 * 支持：S01E12 / s1e5 / 第12集 / 第 12 話 / EP12 出现在 S 标记之后等常见写法。
 */
export function parseSeasonEpisode(name) {
  const s = normalizeName(name);
  let m = s.match(/S(\d{1,2})\s*[-._ ]?\s*E(\d{1,4})/i);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = s.match(/第\s*(\d{1,4})\s*[集話话回]/);
  if (m) return { season: null, episode: Number(m[1]) };
  m = s.match(/\bEP?\s*[-._ ]?\s*(\d{1,4})\b/i);
  if (m) return { season: null, episode: Number(m[1]) };
  return null;
}

/**
 * 从文件名解析集号（不分季），解析不到返回 null。
 * 覆盖三种来源命名：
 * 1. S01E12 → 12；第12集 → 12；
 * 2. 开头裸数字：「12 4k.mp4」「012.mkv」「12.2160p.WEB-DL.mkv」→ 12。
 *    裸数字只认 1–3 位，避免把年份开头的文件名（如 2026xxx）误判成集号。
 */
export function parseEpisodeNo(name) {
  const se = parseSeasonEpisode(name);
  if (se) return se.episode;
  const s = normalizeName(name);
  const m = s.match(/^(\d{1,3})(?=[\s._\-]|$)/);
  if (m) return Number(m[1]);
  return null;
}

/**
 * 从看板 pending 条目（如 "S01E11"）解析出 { season, episode }；解析不到返回 null。
 */
export function parsePendingEpisode(text) {
  const se = parseSeasonEpisode(text);
  return se && se.episode != null ? se : null;
}

/**
 * 从自由文本（如问题说明 issue_text）里提取所有 SxxExx 集号。
 */
export function extractEpisodesFromText(text) {
  const s = normalizeName(text);
  const out = [];
  const re = /S(\d{1,2})\s*[-._ ]?\s*E(\d{1,4})/gi;
  let m;
  while ((m = re.exec(s))) out.push({ season: Number(m[1]), episode: Number(m[2]) });
  const re2 = /第\s*(\d{1,4})\s*[集話话]/g;
  while ((m = re2.exec(s))) out.push({ season: null, episode: Number(m[1]) });
  return out;
}

/**
 * 从库内进度文本 library_have（如 "S01 E01–E10 全齐"、"S01 E01-E218"）解析已有集号集合。
 * 只处理单季文本里出现的 E 起止范围；解析不到返回空集合（调用方应保守处理）。
 */
export function parseLibraryHave(text) {
  const s = normalizeName(text);
  const have = new Set();
  const range = s.match(/E(\d{1,4})\s*[–—~至-]\s*E?(\d{1,4})/i);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) have.add(i);
    return have;
  }
  const single = s.match(/E(\d{1,4})/i);
  if (single) have.add(Number(single[1]));
  return have;
}

/** 版本偏好合法值：max（高码）/ min（低码）/ any（有即可）。非法或未设置一律按 max。 */
export function normalizePolicy(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'min' || s === 'any' ? s : 'max';
}

/**
 * 核心选版：对每个待补集号，从候选文件里按版本偏好挑出唯一要存的那个。
 *
 * @param {Array<{id:string,name:string,size:number}>} files 候选文件（可来自多个分享，调用方按来源分别调用）
 * @param {number[]} wantedEpisodes 待补集号
 * @param {{policy?: string}} opts policy: max 每集取最大 / min 每集取最小 / any 每集取第一个找到的
 * @returns {{chosen: Map<number, object>, unmet: number[]}}
 *   chosen: 集号 → 选中的文件；unmet: 候选里根本没有的集号。
 */
export function pickEpisodes(files, wantedEpisodes, { policy = 'max' } = {}) {
  const pol = normalizePolicy(policy);
  const wanted = new Set(wantedEpisodes);
  const byEp = new Map();
  for (const f of files || []) {
    const ep = parseEpisodeNo(f.name);
    if (ep == null || !wanted.has(ep)) continue;
    if (!byEp.has(ep)) byEp.set(ep, []);
    byEp.get(ep).push(f);
  }
  const chosen = new Map();
  const unmet = [];
  for (const ep of wanted) {
    const cands = byEp.get(ep) || [];
    if (!cands.length) {
      unmet.push(ep);
      continue;
    }
    if (pol === 'any') {
      chosen.set(ep, cands[0]);
    } else {
      const sorted = [...cands].sort((a, b) => Number(a.size) - Number(b.size));
      chosen.set(ep, pol === 'min' ? sorted[0] : sorted[sorted.length - 1]);
    }
  }
  return { chosen, unmet };
}

/* ---------- 面板选版设置：映射、规整、评分与比较 ---------- */

export const VERSION_CRITERIA = ['resolution', 'hdr', 'size'];

/**
 * 环境变量 VERSION_POLICY → 选版设置（与服务端 /api/settings 的映射保持一致）。
 * max → 只存最优·只看大小·越大越好；min → 只存最优·只看大小·越小越好；
 * any → 先存后优·只看大小·越大越好。
 */
export function settingsFromPolicy(policy) {
  const p = normalizePolicy(policy);
  if (p === 'min') return { version_mode: 'best', version_criteria: ['size'], version_size_prefer: 'smaller' };
  if (p === 'any') return { version_mode: 'any_upgrade', version_criteria: ['size'], version_size_prefer: 'bigger' };
  return { version_mode: 'best', version_criteria: ['size'], version_size_prefer: 'bigger' };
}

/** 回退默认：VERSION_POLICY 已设置时按它映射；完全没设时用多维度默认。 */
export function defaultSettings() {
  const p = String(process.env.VERSION_POLICY || '').trim().toLowerCase();
  if (p) return settingsFromPolicy(p);
  return { version_mode: 'best', version_criteria: ['resolution', 'hdr', 'size'], version_size_prefer: 'bigger' };
}

/** 把面板返回的设置规整成可信形状（非法字段逐项回退到回退默认）。 */
export function normalizeSettings(s) {
  const d = defaultSettings();
  if (!s || typeof s !== 'object') return d;
  const criteria = Array.isArray(s.version_criteria)
    ? [...new Set(s.version_criteria.filter((x) => VERSION_CRITERIA.includes(x)))]
    : [];
  return {
    version_mode: ['best', 'any_upgrade'].includes(s.version_mode) ? s.version_mode : d.version_mode,
    version_criteria: criteria.length ? criteria : d.version_criteria,
    version_size_prefer: ['bigger', 'smaller'].includes(s.version_size_prefer) ? s.version_size_prefer : d.version_size_prefer,
  };
}

/**
 * 从文件名解析评分维度（分享列表里能拿到的只有文件名与字节数，故只评三维）：
 * - resolution 档位：2160p/4K/UHD/3840=4、1080p/1920=3、720p/1280=2、576p/480p=1、无标记=0；
 * - hdr 档位：杜比视界（DoVi / Dolby Vision / DV）=5、HDR10+=4、
 *   HDR10 与 HDR Vivid=3、HLG=2、SDR=1、无标记=0；
 * - size：文件字节数。
 * 注：码率不在维度内——分享列表没有时长信息，码率无法精确计算，故不评。
 */
export function scoreFile(file) {
  const s = normalizeName(file?.name || '');
  let resolution = 0;
  if (/2160p/i.test(s) || /\b4k\b/i.test(s) || /3840/.test(s) || /\buhd\b/i.test(s)) resolution = 4;
  else if (/1080p/i.test(s) || /1920/.test(s)) resolution = 3;
  else if (/720p/i.test(s) || /1280/.test(s)) resolution = 2;
  else if (/576p|480p/i.test(s)) resolution = 1;
  let hdr = 0;
  if (/dovi|dolby\s*vision|杜比视界|\bdv\b/i.test(s)) hdr = 5;
  else if (/hdr10\+|hdr10\s*plus/i.test(s)) hdr = 4;
  else if (/hdr10/i.test(s) || /hdr\s*vivid|hdrvivid|菁彩/i.test(s)) hdr = 3;
  else if (/\bhlg\b/i.test(s)) hdr = 2;
  else if (/\bsdr\b/i.test(s)) hdr = 1;
  return { resolution, hdr, size: Number(file?.size) || 0 };
}

/**
 * 按选版设置比较两个同集文件：沿 version_criteria 顺序逐维度比，
 * 分辨率/画质恒为档位大者优，文件大小按 version_size_prefer 定方向；
 * 全部维度平局时再以文件大小定胜负（方向同 size_prefer）。
 * 返回正数 = a 更优，负数 = b 更优，0 = 完全平局。
 */
export function compareFiles(a, b, settings) {
  const st = normalizeSettings(settings);
  const sa = scoreFile(a);
  const sb = scoreFile(b);
  for (const dim of st.version_criteria) {
    let d = 0;
    if (dim === 'resolution') d = sa.resolution - sb.resolution;
    else if (dim === 'hdr') d = sa.hdr - sb.hdr;
    else if (dim === 'size') {
      d = sa.size - sb.size;
      if (st.version_size_prefer === 'smaller') d = -d;
    }
    if (d !== 0) return d;
  }
  return st.version_size_prefer === 'smaller' ? sb.size - sa.size : sa.size - sb.size;
}

/** candidate 是否严格优于 existing（升级替换的判据）。 */
export function isBetter(candidate, existing, settings) {
  return compareFiles(candidate, existing, settings) > 0;
}

/**
 * 按选版设置选版：对每个待补集号挑出唯一要存的那个。
 * mode=best 取 compareFiles 最优；mode=any_upgrade 取第一个找到的（先到先存）。
 * 返回形状与 pickEpisodes 相同：{chosen: Map<集号, 文件>, unmet: 集号[]}。
 */
export function pickBySettings(files, wantedEpisodes, settings) {
  const st = normalizeSettings(settings);
  const wanted = new Set(wantedEpisodes);
  const byEp = new Map();
  for (const f of files || []) {
    const ep = parseEpisodeNo(f.name);
    if (ep == null || !wanted.has(ep)) continue;
    if (!byEp.has(ep)) byEp.set(ep, []);
    byEp.get(ep).push(f);
  }
  const chosen = new Map();
  const unmet = [];
  for (const ep of wanted) {
    const cands = byEp.get(ep) || [];
    if (!cands.length) {
      unmet.push(ep);
      continue;
    }
    chosen.set(ep, st.version_mode === 'any_upgrade'
      ? cands[0]
      : cands.reduce((best, f) => (compareFiles(f, best, st) > 0 ? f : best), cands[0]));
  }
  return { chosen, unmet };
}

const RES_TIER_LABEL = ['无标记', '480p/576p', '720p', '1080p', '2160p/4K'];
const HDR_TIER_LABEL = ['无标记', 'SDR', 'HLG', 'HDR10·Vivid', 'HDR10+', '杜比视界'];

/** 一行可读规格描述（用于日志与 result_note 的新旧对比）。 */
export function describeFile(f) {
  const sc = scoreFile(f);
  return `${RES_TIER_LABEL[sc.resolution]} / ${HDR_TIER_LABEL[sc.hdr]} / ${formatBytes(sc.size)}`;
}

/**
 * 从源文件名里提取可证实的分辨率标记（用于改名时回填，不编造）：
 * 文件名写了 2160p / 4K / 1080p / 720p 才返回对应标记，否则返回 ''。
 */
export function extractResolutionTag(name) {
  const s = String(name ?? '');
  if (/2160p/i.test(s) || /\b4k\b/i.test(s) || /3840/.test(s)) return '2160p';
  if (/1080p/i.test(s) || /1920/.test(s)) return '1080p';
  if (/720p/i.test(s)) return '720p';
  return '';
}

/** 集号补零（E11 → "11"，E5 → "05"）。 */
export function padEp(n, width = 2) {
  return String(n).padStart(width, '0');
}

/**
 * 按库内模板生成入库文件名：`${title}.${year}.S01E${nn}.第${n}集${.分辨率}${ext}`。
 * 季号缺省 1；分辨率只在源文件名带标记时才写入；扩展名沿用源文件。
 */
export function buildLibraryFileName({ title, year, season = 1, episode, sourceName }) {
  const extMatch = String(sourceName ?? '').match(/(\.[A-Za-z0-9]{2,5})$/);
  const ext = extMatch ? extMatch[1].toLowerCase() : '.mkv';
  const res = extractResolutionTag(sourceName);
  const yearPart = year ? `.${year}` : '';
  const resPart = res ? `.${res}` : '';
  return `${title}${yearPart}.S${padEp(season)}E${padEp(episode)}.第${episode}集${resPart}${ext}`;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}KB`;
  return `${n}B`;
}
