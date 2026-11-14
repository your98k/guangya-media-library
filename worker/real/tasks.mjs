/**
 * tasks.mjs — 各类请求的真实处理逻辑。
 *
 * 总原则（诚实边界）：
 * - 面板只排队，活在这里干；干不成如实把请求标 failed 并写明原因，绝不假成功。
 * - 默认 dry-run：检索、验源、按面板「选版设置」选版（面板未设置时回退
 *   env VERSION_POLICY 的映射）、把候选报告写进 result_note，不动网盘。
 *   只有 GUANGYA_INGEST=on 且光鸭登录态已配置、且该剧的入库
 *   文件夹已知（GUANGYA_LIBRARY_MAP）时，才真正转存+改名。
 * - 真转存成功后，若配置了 Drivemby，会逐个入库目录触发一次刷新；
 *   刷新失败只在 result_note 末尾附一句，不影响入库结果。
 */

import * as panel from './panel.mjs';
import * as tmdb from './tmdb.mjs';
import * as guangya from './guangya.mjs';
import * as sources from './sources.mjs';
import * as rules from './rules.mjs';
import { refreshDir, drivembyConfigured } from './drivemby.mjs';
import { ConfigMissing, ShareInvalid } from './errors.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[real-worker]', ...a);

/* ---------------- 通用小工具 ---------------- */

const progress = (req, percent, stage) =>
  panel.update(req.id, { status: 'processing', progress_percent: percent, progress_stage: stage });
const done = (req, note, extra = {}) =>
  panel.update(req.id, { status: 'done', progress_percent: 100, progress_stage: '完成', result_note: note, ...extra });
const failed = (req, note) =>
  panel.update(req.id, { status: 'failed', progress_stage: '失败', result_note: note });

function ingestEnabled() {
  return process.env.GUANGYA_INGEST === 'on' && guangya.guangyaConfigured();
}

/* ---------------- 选版设置（面板优先，env 回退） ---------------- */

let activeSettings = rules.defaultSettings();
let activeSettingsSource = 'env';

/** 当前生效的选版设置（由 refreshVersionSettings 每轮刷新）。 */
export function currentSettings() {
  return activeSettings;
}

/** 本轮设置来源：'panel'（面板已保存）| 'env'（VERSION_POLICY 回退）。 */
export function currentSettingsSource() {
  return activeSettingsSource;
}

/**
 * 从面板拉最新选版设置；面板不可达或接口 404 时回退到 env 映射。
 * 每轮轮询开始时由 index.mjs 调用；不抛错。
 */
export async function refreshVersionSettings() {
  try {
    const s = await panel.getSettings();
    activeSettings = rules.normalizeSettings(s);
    activeSettingsSource = 'panel';
  } catch {
    activeSettings = rules.defaultSettings();
    activeSettingsSource = 'env';
  }
  return { settings: activeSettings, source: activeSettingsSource };
}

function ingestBlockers(title) {
  const out = [];
  if (process.env.GUANGYA_INGEST !== 'on') out.push('GUANGYA_INGEST 未开启');
  if (!guangya.guangyaConfigured()) out.push('未配置光鸭登录态（GUANGYA_COOKIE / GUANGYA_SESSION_FILE）');
  if (title && !libraryMap()[title]) out.push(`GUANGYA_LIBRARY_MAP 未配置《${title}》的入库文件夹`);
  return out;
}

let libraryMapCache = null;
export function libraryMap() {
  if (libraryMapCache) return libraryMapCache;
  try {
    libraryMapCache = JSON.parse(process.env.GUANGYA_LIBRARY_MAP || '{}');
  } catch {
    log('GUANGYA_LIBRARY_MAP 不是合法 JSON，已按空表处理');
    libraryMapCache = {};
  }
  return libraryMapCache;
}

export function findShow(board, { tmdb_id, title, show_key } = {}) {
  const shows = board?.shows || [];
  if (show_key) {
    const byKey = shows.find((s) => s.key === show_key);
    if (byKey) return byKey;
  }
  if (tmdb_id != null) {
    const byId = shows.find((s) => s.tmdb_id != null && Number(s.tmdb_id) === Number(tmdb_id));
    if (byId) return byId;
  }
  if (title) {
    return shows.find((s) => s.title === title) || shows.find((s) => s.title?.includes(title) || title.includes(s.title || ''));
  }
  return null;
}

export function findLinkGroup(linksData, show, { tmdb_id, title } = {}) {
  const groups = linksData?.links || [];
  const tid = tmdb_id ?? show?.tmdb_id;
  const t = title || show?.title;
  if (tid != null) {
    const byId = groups.find((g) => g.tmdb_id != null && Number(g.tmdb_id) === Number(tid));
    if (byId) return byId;
  }
  if (t) return groups.find((g) => g.title === t) || groups.find((g) => g.title?.includes(t) || t.includes(g.title || ''));
  return null;
}

function findCatalogEntry(catalog, show, title) {
  const cats = catalog?.categories || {};
  for (const [catName, items] of Object.entries(cats)) {
    for (const it of items || []) {
      if (show?.tmdb_id != null && it.tmdb_id != null && Number(it.tmdb_id) === Number(show.tmdb_id)) {
        return { category: catName, entry: it };
      }
      if ((title || show?.title) && it.title === (title || show?.title)) return { category: catName, entry: it };
    }
  }
  return null;
}

/**
 * 推导 Drivemby 刷新用的光鸭目录路径：/影视/<分类>/<作品夹>[/Season N]。
 * 作品夹名优先取目录快照的 folder_name，其次按「片名 (年份)」约定拼；
 * 拿不到季信息时只刷作品夹路径。
 */
export function drivePathsFor(show, catalog, seasons = []) {
  const found = findCatalogEntry(catalog, show, show?.title);
  const folderName = found?.entry?.folder_name || (show?.year ? `${show.title} (${show.year})` : show?.title || '');
  const category = found?.category || show?.category || '';
  const base = category ? `/影视/${category}/${folderName}` : `/影视/${folderName}`;
  const ss = [...new Set(seasons.filter((s) => Number.isFinite(s)))];
  return ss.length ? ss.map((s) => `${base}/Season ${s}`) : [base];
}

/** 对每个入库目录调一次 Drivemby 刷新，返回要附在 result_note 末尾的话（未配置时返回 ''）。 */
export async function drivembySuffix(paths) {
  if (!drivembyConfigured()) return '';
  const failures = [];
  for (const p of paths) {
    const r = await refreshDir(p);
    if (!r.ok && !r.skipped) failures.push(`${p}（${r.reason}）`);
  }
  if (failures.length) return `；Drivemby 刷新失败：${failures.join('、')}（不影响本次入库，可稍后在 Drivemby 侧手动刷新）`;
  return '；已通知 Drivemby 刷新入库目录';
}

/**
 * 真转存：把 chosen（集号→分享内文件）从 sourceUrl 转存进 folderId，
 * 落地后按名匹配并按库内模板改名。返回 {saved, renamed:[新名], lost:[集号]}。
 * 注意 restore_share 落地有延迟，这里等 3 秒后按名找一次，找不到的集号
 * 如实报 lost（不假装改名成功），部署者可按 lost 清单人工复查。
 */
export async function ingestChosen({ sourceUrl, code, folderId, show, season, chosen }) {
  const files = [...chosen.values()];
  await guangya.saveShareFiles(sourceUrl, folderId, files.map((f) => f.id), code);
  await sleep(3000);
  const landed = await guangya.listFolder(folderId);
  const byName = new Map(landed.map((f) => [f.name, f]));
  const renamed = [];
  const lost = [];
  for (const [ep, file] of chosen) {
    const targetName = rules.buildLibraryFileName({
      title: show.title, year: show.year, season, episode: ep, sourceName: file.name,
    });
    const landedFile = byName.get(file.name);
    if (!landedFile) { lost.push(ep); continue; }
    if (landedFile.name !== targetName) await guangya.renameFile(landedFile.id, targetName);
    renamed.push(targetName);
  }
  return { saved: files.length, renamed, lost };
}

/** 入库后回写看板：把已补集号从 pending 移除，并给 library_have 追加说明。 */
export async function markBoardFixed(show, fixedEps, season) {
  const { board } = await panel.getBoard();
  if (!board?.shows) return;
  const target = board.shows.find((s) => s.key === show.key) || findShow(board, show);
  if (!target) return;
  const fixedSet = new Set(fixedEps);
  target.pending = (target.pending || []).filter((p) => {
    const se = rules.parsePendingEpisode(p);
    return !(se && se.season === season && fixedSet.has(se.episode));
  });
  const labels = fixedEps.map((e) => `S${rules.padEp(season)}E${rules.padEp(e)}`).join('、');
  target.library_have = `${target.library_have || ''}；已补 ${labels}`.replace(/^；/, '');
  board.generated_at = new Date().toISOString();
  await panel.pushBoard(board);
}

/* ---------------- 升级替换与排重（fix / watchscan / 自主轮询共用同一套实现） ---------------- */

/** 列出库内某 Season 文件夹现有文件，按集号归拢：Map<集号, 文件>（同集多份时留最大的一份作比对基准）。 */
export async function loadExistingByEp(folderId) {
  const items = await guangya.listFolder(folderId);
  const byEp = new Map();
  for (const it of items) {
    if (it.isDir) continue;
    const ep = rules.parseEpisodeNo(it.name);
    if (ep == null) continue;
    const prev = byEp.get(ep);
    if (!prev || Number(it.size) > Number(prev.size)) byEp.set(ep, it);
  }
  return byEp;
}

/**
 * 规划升级（any_upgrade 模式）：在已走过的候选分享里，为库内已有的集找更优版本。
 * shares: [{url, code, site, files}]（按优先顺序，先到先得）；
 * skipEps: 本轮刚补的新集，不重复动。返回 [{ep, cand, file, existing}]（按集号升序）。
 */
export function planUpgrades(shares, existingByEp, skipEps, settings) {
  const out = [];
  const planned = new Set();
  for (const sh of shares || []) {
    for (const f of sh.files || []) {
      const ep = rules.parseEpisodeNo(f.name);
      if (ep == null || planned.has(ep) || skipEps.has(ep)) continue;
      const existing = existingByEp.get(ep);
      if (!existing) continue;
      if (rules.isBetter(f, existing, settings)) {
        out.push({ ep, cand: sh, file: f, existing });
        planned.add(ep);
      }
    }
  }
  return out.sort((a, b) => a.ep - b.ep);
}

/**
 * 执行或报告升级替换，返回 {lines, replaced}：
 * - 非真转存条件（dry-run 等）→ 只列出可升级项与新旧对比；
 * - 真转存但未配置 GUANGYA_QUARANTINE_FOLDER_ID → 只报告、不替换；
 * - 条件齐全 → 逐集替换：新版转存进 Season 文件夹并确认落地 → 旧版移入
 *   隔离文件夹 → 新版按库内模板改名。单集失败只记该集，不中断其余集。
 */
export async function applyUpgrades({ upgrades, folderId, show, season, settings }) {
  if (!upgrades.length) return { lines: [], replaced: [] };
  const describe = (u) => `E${u.ep}：库内「${u.existing.name}」（${rules.describeFile(u.existing)}）→ 更优「${u.file.name}」（${rules.describeFile(u.file)}，来源 ${u.cand.site || u.cand.url}）`;
  if (!ingestEnabled() || !folderId) {
    return { lines: upgrades.map((u) => `可升级（先存后优）：${describe(u)}`), replaced: [] };
  }
  const quarantineId = process.env.GUANGYA_QUARANTINE_FOLDER_ID || '';
  if (!quarantineId) {
    return {
      lines: [
        `发现更优版本，未配置 GUANGYA_QUARANTINE_FOLDER_ID，未替换：${upgrades.map((u) => `E${u.ep}`).join('、')}。`,
        ...upgrades.map(describe),
      ],
      replaced: [],
    };
  }
  const lines = [];
  const replaced = [];
  for (const u of upgrades) {
    try {
      await guangya.saveShareFiles(u.cand.url, folderId, [u.file.id], u.cand.code);
      await sleep(3000);
      const landed = await guangya.listFolder(folderId);
      const landedFile = landed.find((f) => f.name === u.file.name && f.id !== u.existing.id);
      if (!landedFile) {
        lines.push(`E${u.ep} 升级替换未完成：新版转存后未在目标文件夹找到，旧版未动。`);
        continue;
      }
      await guangya.moveFile(u.existing.id, quarantineId);
      const targetName = rules.buildLibraryFileName({
        title: show.title, year: show.year, season, episode: u.ep, sourceName: u.file.name,
      });
      if (landedFile.name !== targetName) await guangya.renameFile(landedFile.id, targetName);
      replaced.push(u.ep);
      lines.push(`已升级替换 ${describe(u)}；旧版已移入隔离文件夹，新版已改名为「${targetName}」。`);
    } catch (e) {
      lines.push(`E${u.ep} 升级替换失败：${e.message}（请人工复查该集新旧文件状态）。`);
    }
  }
  return { lines, replaced };
}

/**
 * 排重：某 Season 文件夹里同一集多份时，按选版设置留最优的一份，
 * 其余移入 GUANGYA_QUARANTINE_FOLDER_ID；未配隔离夹则全部保留并说明。
 * 返回说明行数组（无重复时为空数组）。
 */
export async function dedupeFolder(folderId, settings) {
  const items = await guangya.listFolder(folderId);
  const byEp = new Map();
  for (const it of items) {
    if (it.isDir) continue;
    const ep = rules.parseEpisodeNo(it.name);
    if (ep == null) continue;
    if (!byEp.has(ep)) byEp.set(ep, []);
    byEp.get(ep).push(it);
  }
  const dupEps = [...byEp.entries()].filter(([, list]) => list.length > 1);
  if (!dupEps.length) return [];
  const quarantineId = process.env.GUANGYA_QUARANTINE_FOLDER_ID || '';
  if (!quarantineId) {
    return [`同集多份未处理（未配置 GUANGYA_QUARANTINE_FOLDER_ID）：${dupEps.map(([ep, list]) => `E${ep} 共 ${list.length} 份`).join('、')}。`];
  }
  const lines = [];
  for (const [ep, list] of dupEps.sort((a, b) => a[0] - b[0])) {
    const keep = list.reduce((best, f) => (rules.compareFiles(f, best, settings) > 0 ? f : best), list[0]);
    const moved = [];
    for (const f of list) {
      if (f.id === keep.id) continue;
      try {
        await guangya.moveFile(f.id, quarantineId);
        moved.push(f.name);
      } catch (e) {
        lines.push(`E${ep} 排重移动「${f.name}」失败：${e.message}`);
      }
    }
    if (moved.length) lines.push(`排重 E${ep}：保留「${keep.name}」，多余 ${moved.length} 份已移入隔离文件夹。`);
  }
  return lines;
}

/* ---------------- search ---------------- */

export async function handleSearch(req) {
  const p = req.payload || {};
  await progress(req, 30, '正在查询 TMDB');
  let results = [];
  if (p.mode === 'tmdb_id') {
    const type = p.id_type === 'movie' ? 'movie' : 'tv';
    if (type === 'movie') {
      const d = await tmdb.movieDetails(p.query);
      results = [d];
    } else {
      const d = await tmdb.tvDetails(p.query);
      results = [{
        tmdb_id: d.tmdb_id, title: d.title, year: d.year, media_type: 'tv',
        overview: d.overview, poster_url: d.poster_url, vote_average: null,
      }];
    }
  } else {
    const [tv, mv] = p.id_type === 'movie'
      ? [[], await tmdb.searchMovie(p.query)]
      : p.id_type === 'tv'
        ? [await tmdb.searchTv(p.query), []]
        : [await tmdb.searchTv(p.query), await tmdb.searchMovie(p.query)];
    results = [...tv, ...mv].slice(0, 20);
  }
  // 标记哪些已经在库（按目录快照的 tmdb_id / 片名粗匹配）
  try {
    const { catalog } = await panel.getCatalog();
    const ids = new Set();
    const titles = new Set();
    for (const items of Object.values(catalog?.categories || {})) {
      for (const it of items || []) {
        if (it.tmdb_id != null) ids.add(Number(it.tmdb_id));
        if (it.title) titles.add(it.title);
      }
    }
    for (const r of results) {
      if ((r.tmdb_id != null && ids.has(Number(r.tmdb_id))) || titles.has(r.title)) r.in_library = true;
    }
  } catch { /* 目录读不到不影响搜索结果 */ }
  await panel.update(req.id, { results });
  await done(req, `共 ${results.length} 条结果（5 分钟内有效，勾选提交后定稿）`);
}

/* ---------------- fix ---------------- */

export async function handleFix(req) {
  const p = req.payload || {};
  const title = p.title || '';
  await progress(req, 10, '读取看板与来源链接');
  const { board } = await panel.getBoard();
  const show = findShow(board, p);
  const displayTitle = show?.title || title;
  if (!displayTitle) {
    await failed(req, '修复请求缺少作品信息（title/tmdb_id），且看板里找不到对应作品，无法处理。');
    return;
  }
  const linksData = await panel.getWatchLinks();
  const group = findLinkGroup(linksData, show, p);
  const SETTINGS = currentSettings();

  // 待补集：优先看板 pending，其次从问题文本里抠集号
  let wanted = (show?.pending || []).map(rules.parsePendingEpisode).filter(Boolean);
  if (!wanted.length && p.issue_text) wanted = rules.extractEpisodesFromText(p.issue_text);
  const wantedEps = [...new Set(wanted.map((w) => w.episode))];
  const season = wanted[0]?.season || 1;

  // 分享失效类：先验现有来源，找出确实死了的链接
  const deadLinks = [];
  if (p.issue_type === 'share_invalid' && group?.links?.length && guangya.guangyaConfigured()) {
    await progress(req, 18, '验证现有来源是否已失效');
    for (const l of group.links) {
      try { await guangya.walkShare(l.url, l.code); }
      catch (e) { if (e instanceof ShareInvalid) deadLinks.push(l); }
    }
  }

  await progress(req, 30, '在聚合站检索替代源');
  const { candidates, report } = await sources.searchAll(displayTitle);
  if (report.every((r) => r.status === 'unconfigured')) {
    throw new ConfigMissing('JIAOFU_COOKIE', 'MINI_COOKIE');
  }
  const gyCandidates = candidates.filter((c) => c.kind === 'guangyapan');
  const magnetCount = candidates.filter((c) => c.kind === 'magnet').length;

  await progress(req, 50, '逐个验分享并按选版设置挑版本');
  const evaluated = [];
  for (const cand of gyCandidates) {
    try {
      const files = await guangya.walkShare(cand.url);
      const pick = wantedEps.length
        ? rules.pickBySettings(files, wantedEps, SETTINGS)
        : { chosen: new Map(), unmet: [] };
      evaluated.push({ cand, files, pick });
    } catch (e) {
      evaluated.push({ cand, error: e });
    }
  }
  const usable = evaluated.filter((e) => !e.error);
  // 来源排序：先比能补上的集数（多者优先）；any_upgrade 模式同覆盖时保持
  // 检索顺序（先到先存）；best 模式再比所选文件的综合评分，最后比总体积。
  const totalSize = (e) => [...e.pick.chosen.values()].reduce((s, f) => s + Number(f.size), 0);
  const qualityIndex = (e) => [...e.pick.chosen.values()].reduce((s, f) => {
    const sc = rules.scoreFile(f);
    return s + sc.resolution * 100 + sc.hdr * 10;
  }, 0);
  usable.sort((a, b) => {
    const byCoverage = b.pick.chosen.size - a.pick.chosen.size;
    if (byCoverage !== 0) return byCoverage;
    if (SETTINGS.version_mode === 'any_upgrade') return 0;
    const byQuality = qualityIndex(b) - qualityIndex(a);
    if (byQuality !== 0) return byQuality;
    return SETTINGS.version_size_prefer === 'smaller' ? totalSize(a) - totalSize(b) : totalSize(b) - totalSize(a);
  });
  const best = usable[0];
  const bestCovers = best && (wantedEps.length ? best.pick.chosen.size > 0 : best.files.length > 0);

  const reportLines = [
    `检索：《${displayTitle}》 教父网/迷你影视共 ${candidates.length} 条候选（光鸭 ${gyCandidates.length}、磁力 ${magnetCount}）`,
    ...report.map((r) => `  ${r.site}：${r.status === 'ok' ? `返回 ${r.count ?? 0} 条` : r.status === 'unconfigured' ? r.reason : `不可用（${r.reason}）`}`),
  ];
  for (const e of usable) {
    const parts = [...e.pick.chosen.entries()].map(([ep, f]) => `E${ep} ${rules.formatBytes(f.size)}`);
    reportLines.push(`候选 ${e.cand.url}（${e.cand.site}，共 ${e.files.length} 个文件）${wantedEps.length ? `：可补 ${parts.join('、') || '无'}` : ''}`);
    if (e.pick.unmet?.length) reportLines.push(`  未满足（候选里没有这一集）：${e.pick.unmet.map((x) => `E${x}`).join('、')}`);
  }
  for (const e of evaluated.filter((x) => x.error)) {
    reportLines.push(`候选 ${e.cand.url}：验源失败（${e.error.message}）`);
  }

  if (!bestCovers) {
    await failed(req, [`两站均未找到可用的替代源（选版设置：模式 ${SETTINGS.version_mode}、依据 ${SETTINGS.version_criteria.join(' > ')}），需要人工提供链接。`, ...reportLines].join('\n'));
    return;
  }

  const blockers = ingestBlockers(displayTitle);
  const folderId = libraryMap()[displayTitle];
  const canIngest = !blockers.length;

  // any_upgrade 模式：新集处理完之后再做升级检查（不阻塞新集入库）。
  // dry-run 时只列出可升级项；真转存时按 applyUpgrades 的条件执行替换。
  const runUpgradeCheck = async () => {
    if (SETTINGS.version_mode !== 'any_upgrade' || !folderId || !guangya.guangyaConfigured()) {
      return { lines: [], replaced: [] };
    }
    try {
      await progress(req, 85, '正在检查已入库集数有无更优版本');
      const existingByEp = await loadExistingByEp(folderId);
      const shares = usable.map((e) => ({ url: e.cand.url, code: e.cand.code, site: e.cand.site, files: e.files }));
      const upgrades = planUpgrades(shares, existingByEp, new Set(wantedEps), SETTINGS);
      return await applyUpgrades({
        upgrades, folderId, show: { title: displayTitle, year: show?.year }, season, settings: SETTINGS,
      });
    } catch (e) {
      return { lines: [`升级检查未完成：${e.message}`], replaced: [] };
    }
  };

  const dryRun = async (why, extraLines = []) => {
    await progress(req, 90, 'dry-run：整理候选报告');
    await done(req, [
      `dry-run：已找到候选，未执行转存（原因：${why}）`,
      ...reportLines,
      wantedEps.length
        ? `首选来源可补：${[...best.pick.chosen.entries()].map(([ep, f]) => `E${ep}（${f.name}，${rules.formatBytes(f.size)}）`).join('、')}`
        : `首选来源可用：${best.cand.url}（共 ${best.files.length} 个文件）`,
      ...extraLines,
    ].join('\n'));
  };

  // 有待补集：走转存路径（或 dry-run 出报告）
  if (wantedEps.length) {
    if (!canIngest) {
      const up = await runUpgradeCheck();
      await dryRun(blockers.join('；') || '未开启真转存', up.lines);
      return;
    }
    await progress(req, 75, '正在转存并改名');
    const { catalog } = await panel.getCatalog().catch(() => ({ catalog: null }));
    const res = await ingestChosen({
      sourceUrl: best.cand.url, folderId, show: { title: displayTitle, year: show?.year }, season, chosen: best.pick.chosen,
    });
    const fixedEps = [...best.pick.chosen.keys()].filter((ep) => !res.lost.includes(ep));
    if (fixedEps.length) await markBoardFixed({ key: show?.key, title: displayTitle }, fixedEps, season);
    const up = await runUpgradeCheck();
    const suffix = (res.renamed.length || up.replaced.length)
      ? await drivembySuffix(drivePathsFor(show || { title: displayTitle }, catalog, [season]))
      : '';
    await done(req, [
      `已从 ${best.cand.site} 补入 ${res.renamed.length} 集：${res.renamed.join('、')}`,
      res.lost.length ? `以下集数转存后未在目标文件夹找到（落地延迟或被改名），请人工复查：${res.lost.map((e) => `E${e}`).join('、')}` : '',
      ...up.lines,
      ...reportLines,
    ].filter(Boolean).join('\n') + suffix);
    return;
  }

  // 无待补集、分享失效：换源（把死链替换为验过的可用来源，不需要入库文件夹）
  if (p.issue_type === 'share_invalid' && deadLinks.length) {
    if (!(process.env.GUANGYA_INGEST === 'on' && guangya.guangyaConfigured())) {
      await dryRun(process.env.GUANGYA_INGEST !== 'on' ? 'GUANGYA_INGEST 未开启' : '未配置光鸭登录态');
      return;
    }
    const all = await panel.getWatchLinks();
    const groups = all.links || [];
    const g = findLinkGroup({ links: groups }, show, p);
    if (g) {
      const deadUrls = new Set(deadLinks.map((l) => l.url));
      g.links = g.links.filter((l) => !deadUrls.has(l.url));
      if (!g.links.some((l) => l.url === best.cand.url)) {
        g.links.push({ slot: 0, url: best.cand.url, ...(best.cand.code ? { code: best.cand.code } : {}) });
      }
      g.links = g.links.map((l, i) => ({ ...l, slot: i + 1 }));
      await panel.pushLinks(groups);
    }
    await done(req, [
      `已换源：移除失效链接 ${deadLinks.length} 条，接入验过的可用来源 ${best.cand.url}（${best.cand.site}，共 ${best.files.length} 个文件）。`,
      ...reportLines,
    ].join('\n'));
    return;
  }

  const up = await runUpgradeCheck();
  await done(req, [
    'dry-run：已找到候选，未执行转存（本次情形无需转存或无法判定入库目标）',
    ...up.lines,
    ...reportLines,
  ].join('\n'));
}

/* ---------------- add ---------------- */

export async function handleAdd(req) {
  const p = req.payload || {};

  if (p.stop_tracking) {
    // 取消追更：面板侧的看板/链接都是快照，worker 直接全量回写移除该剧即可。
    const { board } = await panel.getBoard();
    const show = findShow(board, p);
    if (show && board?.shows) {
      board.shows = board.shows.filter((s) => s.key !== show.key);
      board.watch_total = board.shows.length;
      board.generated_at = new Date().toISOString();
      await panel.pushBoard(board);
    }
    const linksData = await panel.getWatchLinks();
    const groups = linksData?.links || [];
    const kept = groups.filter((g) => !(show && g.title === show.title) && g.title !== p.title);
    if (kept.length !== groups.length) await panel.pushLinks(kept);
    await done(req, `已取消追更《${p.title || show?.title || ''}》：已从追更看板与来源清单移除（已入库文件不删）。`);
    return;
  }

  if (p.source === 'link') {
    const url = String(p.url || '').trim();
    if (!rules.isGuangyaShareUrl(url)) {
      await failed(req, '分享链接格式不正确：应为 https://www.guangyapan.com/s/<id>_<后缀> 的完整链接（id 与后缀之间的下划线不能丢）。');
      return;
    }
    await progress(req, 40, '正在验分享');
    const files = await guangya.walkShare(url, p.code);
    const SETTINGS = currentSettings();
    const total = files.reduce((s, f) => s + Number(f.size), 0);

    // 只排重语义（用户提交的链接）：不拿规格偏好去拒绝任何一集——
    // 按集号分组，一集多版本时用当前选版设置留最优的一个；与库内已有集
    // 比对后只处理缺集。无法解析集号的文件原样保留（无法判重）。
    const byEp = new Map();
    const noEpFiles = [];
    for (const f of files) {
      const ep = rules.parseEpisodeNo(f.name);
      if (ep == null) { noEpFiles.push(f); continue; }
      if (!byEp.has(ep)) byEp.set(ep, []);
      byEp.get(ep).push(f);
    }
    const kept = [];
    const droppedDup = [];
    for (const [ep, list] of [...byEp.entries()].sort((a, b) => a[0] - b[0])) {
      const best = list.reduce((b, f) => (rules.compareFiles(f, b, SETTINGS) > 0 ? f : b), list[0]);
      kept.push({ ep, file: best });
      for (const f of list) if (f.id !== best.id) droppedDup.push({ ep, file: f });
    }

    const folderId = libraryMap()[url];
    let existingEps = new Set();
    if (folderId && guangya.guangyaConfigured()) {
      const byEpExisting = await loadExistingByEp(folderId).catch(() => new Map());
      existingEps = new Set(byEpExisting.keys());
    }
    const toIngest = kept.filter((k) => !existingEps.has(k.ep));
    const skippedHave = kept.filter((k) => existingEps.has(k.ep));
    const transferFiles = [...toIngest.map((k) => k.file), ...noEpFiles];

    const lines = [
      '按只排重处理用户提交链接：不按规格偏好拒绝任何一集，只保证一集留一个版本、且不与库内重复。',
      `分享共 ${files.length} 个文件（合计 ${rules.formatBytes(total)}），识别到 ${byEp.size} 集${noEpFiles.length ? `，另有 ${noEpFiles.length} 个文件无法解析集号（原样保留）` : ''}。`,
      droppedDup.length
        ? `同集多版本已按选版设置留最优一份，舍弃 ${droppedDup.length} 个：${droppedDup.map((d) => `E${d.ep}「${d.file.name}」`).join('、')}。`
        : '没有同集多版本，无舍弃。',
      skippedHave.length ? `库内已有、跳过：${skippedHave.map((k) => `E${k.ep}`).join('、')}。` : '',
    ];

    if (ingestEnabled() && folderId) {
      if (transferFiles.length) {
        await progress(req, 75, '正在转存');
        await guangya.saveShareFiles(url, folderId, transferFiles.map((f) => f.id), p.code);
      }
      // 这里只知道目标文件夹 ID、不知道其完整路径，无法按路径触发 Drivemby 刷新，故不调。
      lines.push(transferFiles.length
        ? `已转存 ${transferFiles.length} 个文件（缺集 ${toIngest.length} 集${noEpFiles.length ? `＋无集号文件 ${noEpFiles.length} 个` : ''}）到 GUANGYA_LIBRARY_MAP 中该链接对应的文件夹；因请求里没有作品信息，未做改名与看板更新，请人工归类。`
        : '没有需要转存的新文件（识别到的集数都已在库内）。');
      await done(req, lines.filter(Boolean).join('\n'));
      return;
    }
    lines.push(`dry-run：未执行转存。待转存缺集：${toIngest.length ? toIngest.map((k) => `E${k.ep}「${k.file.name}」`).join('、') : '无'}。未转存原因：${ingestBlockers('').join('；') || 'GUANGYA_LIBRARY_MAP 未按分享链接配置入库文件夹'}。`);
    await done(req, lines.filter(Boolean).join('\n'));
    return;
  }

  if (p.source === 'tmdb') {
    // 只有 TMDB 条目、没有任何来源链接时，worker 无从入库——如实失败，
    // 不标 done。这是骨架版的有意选择（见 worker/real/README.md）。
    await failed(req, `仅凭 TMDB 条目（${p.title || p.tmdb_id}）无法自动入库：需要该作品的光鸭分享链接。请用面板的「光鸭分享链接」方式重新提交，或为 worker 扩展按片名检索来源的实现。`);
    return;
  }

  await failed(req, '无法识别的添加请求（缺少 source）。');
}

/* ---------------- watchscan ---------------- */

export async function handleWatchscan(req) {
  const p = req.payload || {};
  const { board } = await panel.getBoard();
  const show = findShow(board, p);
  if (!show) {
    await failed(req, '看板里找不到这部作品，无法扫描。');
    return;
  }
  const scanRef = { show_key: show.key, tmdb_id: show.tmdb_id ?? undefined, title: show.title };
  await panel.pushShowScanStates([{ ...scanRef, scan_active: true, progress_percent: 10, progress_stage: '正在查来源', progress_at_ms: Date.now() }]).catch(() => {});
  try {
    const linksData = await panel.getWatchLinks();
    const group = findLinkGroup(linksData, show, p);
    if (!group?.links?.length) {
      await done(req, `《${show.title}》没有登记任何来源链接，无从扫描。`);
      return;
    }
    await progress(req, 40, '正在逐个查来源');
    const SETTINGS = currentSettings();
    const walkedShares = []; // {url, code, site, files}，升级检查要用全量文件
    const candidatesByEp = new Map(); // ep -> [{file, url, code}]（按来源顺序）
    const sourceNotes = [];
    for (const l of group.links) {
      try {
        const files = await guangya.walkShare(l.url, l.code);
        walkedShares.push({ url: l.url, code: l.code, site: l.url, files });
        for (const f of files) {
          const ep = rules.parseEpisodeNo(f.name);
          if (ep == null) continue;
          if (!candidatesByEp.has(ep)) candidatesByEp.set(ep, []);
          candidatesByEp.get(ep).push({ file: f, url: l.url, code: l.code });
        }
        sourceNotes.push(`来源 ${l.url}：${files.length} 个文件`);
      } catch (e) {
        sourceNotes.push(`来源 ${l.url}：查失败（${e.message}）`);
      }
    }
    // 每集按选版设置定版：best 取评分最优，any_upgrade 取先到的。
    const available = new Map(); // ep -> {file, url, code}
    for (const [ep, list] of candidatesByEp) {
      available.set(ep, SETTINGS.version_mode === 'any_upgrade'
        ? list[0]
        : list.reduce((best, e) => (rules.compareFiles(e.file, best.file, SETTINGS) > 0 ? e : best), list[0]));
    }
    const have = rules.parseLibraryHave(show.library_have);
    const pendingEps = (show.pending || []).map(rules.parsePendingEpisode).filter(Boolean).map((x) => x.episode);
    const newEps = [...available.keys()].filter((ep) => !have.has(ep)).sort((a, b) => a - b);
    const stillMissing = pendingEps.filter((ep) => !available.has(ep));
    const season = (show.pending || []).map(rules.parsePendingEpisode).find(Boolean)?.season || 1;

    let ingestNote = '';
    let drvSuffix = '';
    const folderId = libraryMap()[show.title];
    const ingestible = newEps.filter((ep) => pendingEps.includes(ep));
    if (ingestible.length && ingestEnabled() && folderId) {
      await progress(req, 75, '正在补入新集');
      // 按来源分组逐个转存（同一集只转已选定的那个文件所在来源）
      const bySource = new Map();
      for (const ep of ingestible) {
        const hit = available.get(ep);
        if (!bySource.has(hit.url)) bySource.set(hit.url, { code: hit.code, chosen: new Map() });
        bySource.get(hit.url).chosen.set(ep, hit.file);
      }
      const fixed = [];
      for (const [url, { code, chosen }] of bySource) {
        const res = await ingestChosen({ sourceUrl: url, code, folderId, show, season, chosen });
        fixed.push(...[...chosen.keys()].filter((ep) => !res.lost.includes(ep)));
        ingestNote += ` 已从 ${url} 补入 ${res.renamed.length} 集${res.lost.length ? `（未落地待复查：${res.lost.map((e) => `E${e}`).join('、')}）` : ''}。`;
        if (fixed.length) {
          const { catalog } = await panel.getCatalog().catch(() => ({ catalog: null }));
          drvSuffix = await drivembySuffix(drivePathsFor(show, catalog, [season]));
        }
        if (fixed.length) await markBoardFixed(show, fixed, season);
      }
    } else if (ingestible.length) {
      ingestNote = ` 待补集已有来源但未转存（${ingestBlockers(show.title).join('；') || '未开启真转存'}）。`;
    }

    // any_upgrade 模式：新集补完后，对已入库的集做升级检查（与 fix 共用同一套实现）。
    let upgradeLines = [];
    if (SETTINGS.version_mode === 'any_upgrade' && folderId && guangya.guangyaConfigured()) {
      try {
        const existingByEp = await loadExistingByEp(folderId);
        const upgrades = planUpgrades(walkedShares, existingByEp, new Set(ingestible), SETTINGS);
        const up = await applyUpgrades({ upgrades, folderId, show, season, settings: SETTINGS });
        upgradeLines = up.lines;
        if (up.replaced.length && !drvSuffix) {
          const { catalog } = await panel.getCatalog().catch(() => ({ catalog: null }));
          drvSuffix = await drivembySuffix(drivePathsFor(show, catalog, [season]));
        }
      } catch (e) {
        upgradeLines = [`升级检查未完成：${e.message}`];
      }
    }

    await done(req, [
      `《${show.title}》扫描完成：来源共提供 ${available.size} 集，库内已有 ${have.size} 集。`,
      newEps.length ? `新发现（库内没有）：${newEps.map((e) => `E${e}`).join('、')}。` : '没有新集。',
      stillMissing.length ? `待补仍缺：${stillMissing.map((e) => `E${e}`).join('、')}。` : '',
      ...upgradeLines,
      ...sourceNotes,
      ingestNote.trim(),
    ].filter(Boolean).join('\n') + drvSuffix);
  } finally {
    const statesData = await panel.getShowScanStates().catch(() => null);
    const st = statesData?.states?.find((s) => s.show_key === show.key || (s.tmdb_id != null && Number(s.tmdb_id) === Number(show.tmdb_id)) || s.title === show.title);
    await panel.pushShowScanStates([{
      ...scanRef,
      scan_active: false, progress_percent: null, progress_stage: null, progress_at_ms: Date.now(),
      last_scan_at_ms: Date.now(),
      ...(st?.interval_minutes ? { next_scan_at_ms: Date.now() + st.interval_minutes * 60000 } : {}),
    }]).catch(() => {});
  }
}

/* ---------------- scan（未分类） ---------------- */

export async function handleScan(req) {
  const folderId = process.env.GUANGYA_UNCLASSIFIED_FOLDER_ID || '';
  if (!folderId) throw new ConfigMissing('GUANGYA_UNCLASSIFIED_FOLDER_ID');
  await progress(req, 40, '正在枚举未分类文件夹');
  const items = await guangya.listFolder(folderId);
  const names = items.map((i) => `${i.isDir ? '📁 ' : ''}${i.name}`);
  await done(req, [
    `未分类文件夹共 ${items.length} 项。骨架版仅清点、未执行识别整理（识别作品→只补缺集→改名入库的完整整理逻辑请按部署规则扩展本 handler）。`,
    ...names.slice(0, 20),
    names.length > 20 ? `……其余 ${names.length - 20} 项略` : '',
  ].filter(Boolean).join('\n'), { found_count: items.length, organized_count: 0, taken_count: 0 });
  // 定时轮次回写扫描时钟（手动轮次也写 last，next 按面板设置推算；失败不影响结果）
  try {
    const sched = await panel.getUnclassifiedSchedule();
    const next = sched?.enabled && sched?.interval_minutes ? Date.now() + sched.interval_minutes * 60000 : null;
    await panel.pushUnclassifiedClock(Date.now(), next);
  } catch { /* 时钟回写失败不影响扫描结果 */ }
}

/* ---------------- catalog_refresh ---------------- */

function parseFolderName(folderName) {
  const m = String(folderName).match(/^(.*?)\s*\((\d{4})\)\s*(?:\{tmdb-(\d+)\}|\[tmdbid=(\d+)\])?\s*$/);
  if (m) return { title: m[1].trim(), year: Number(m[2]) || null, tmdb_id: m[3] || m[4] ? Number(m[3] || m[4]) : null };
  return { title: String(folderName), year: null, tmdb_id: null };
}

export async function handleCatalogRefresh(req) {
  let catIds;
  try {
    catIds = JSON.parse(process.env.GUANGYA_CATEGORY_IDS || '');
  } catch { /* fallthrough */ }
  if (!catIds || typeof catIds !== 'object' || !Object.keys(catIds).length) {
    throw new ConfigMissing('GUANGYA_CATEGORY_IDS');
  }
  await progress(req, 20, '正在枚举影视库目录');
  const categories = { '电影': [], '剧集': [], '动漫': [] };
  let totalEpisodes = 0;
  let totalBytes = 0;
  for (const [catName, folderId] of Object.entries(catIds)) {
    if (!categories[catName]) categories[catName] = [];
    const titleFolders = await guangya.listFolder(folderId);
    for (const tf of titleFolders.filter((x) => x.isDir)) {
      const meta = parseFolderName(tf.name);
      const children = await guangya.listFolder(tf.id);
      const seasonDirs = children.filter((x) => x.isDir);
      let episodes = 0;
      let size = 0;
      if (!seasonDirs.length) {
        const files = children.filter((x) => !x.isDir);
        episodes = files.length;
        size = files.reduce((s, f) => s + f.size, 0);
      } else {
        for (const sd of seasonDirs) {
          const files = (await guangya.listFolder(sd.id)).filter((x) => !x.isDir);
          episodes += files.length;
          size += files.reduce((s, f) => s + f.size, 0);
        }
      }
      categories[catName].push({
        title: meta.title, year: meta.year, tmdb_id: meta.tmdb_id,
        poster_url: '', seasons: seasonDirs.length || (catName === '电影' ? null : 1),
        episodes, size_bytes: size, folder_name: tf.name,
      });
      totalEpisodes += episodes;
      totalBytes += size;
    }
  }
  const titles = Object.values(categories).reduce((s, arr) => s + arr.length, 0);
  const catalog = {
    generated_at: new Date().toISOString(),
    totals: { titles, episodes: totalEpisodes, size_bytes: totalBytes },
    posters: {},
    categories,
  };
  await panel.pushCatalog(catalog);
  await done(req, `目录已刷新：共 ${titles} 部、${totalEpisodes} 集、${rules.formatBytes(totalBytes)}（海报未在骨架版抓取，条目 poster_url 留空，面板会按 TMDB 对照/占位显示）。`);
}

/* ---------------- link ---------------- */

export async function handleLink(req) {
  const p = req.payload || {};
  const linksData = await panel.getWatchLinks();
  const groups = linksData?.links || [];
  let group = findLinkGroup({ links: groups }, null, p);
  if (!group) {
    if (p.op === 'delete') {
      await failed(req, '找不到这部作品的来源清单，无法删除。');
      return;
    }
    group = { tmdb_id: p.tmdb_id ?? null, title: p.title || '', links: [] };
    groups.push(group);
  }
  group.links = [...(group.links || [])].sort((a, b) => a.slot - b.slot);

  if (p.op === 'delete') {
    if (p.slot == null) {
      await failed(req, '删除链接需要指定 slot（第几条）。');
      return;
    }
    const before = group.links.length;
    group.links = group.links.filter((l) => l.slot !== Number(p.slot));
    if (group.links.length === before) {
      await failed(req, `第 ${p.slot} 条链接不存在，无法删除。`);
      return;
    }
  } else {
    const url = String(p.url || '').trim();
    if (!rules.isGuangyaShareUrl(url)) {
      await failed(req, '分享链接格式不正确：应为 https://www.guangyapan.com/s/<id>_<后缀> 的完整链接（id 与后缀之间的下划线不能丢）。');
      return;
    }
    if (!guangya.guangyaConfigured()) throw new ConfigMissing('GUANGYA_COOKIE', 'GUANGYA_SESSION_FILE');
    await progress(req, 50, '正在验新链接');
    const files = await guangya.walkShare(url, p.code);
    if (p.op === 'replace') {
      const target = group.links.find((l) => l.slot === Number(p.slot));
      if (!target) {
        await failed(req, `第 ${p.slot} 条链接不存在，无法替换。`);
        return;
      }
      target.url = url;
      if (p.code) target.code = p.code; else delete target.code;
    } else { // add
      const slot = p.slot != null ? Number(p.slot) : (group.links.reduce((mx, l) => Math.max(mx, l.slot), 0) + 1);
      if (group.links.some((l) => l.slot === slot)) {
        await failed(req, `第 ${slot} 条位置已被占用，请换一个 slot 或用替换。`);
        return;
      }
      group.links.push({ slot, url, ...(p.code ? { code: p.code } : {}) });
    }
    group.links.sort((a, b) => a.slot - b.slot);
    group.links = group.links.map((l, i) => ({ ...l, slot: i + 1 }));
    await panel.pushLinks(groups);
    await done(req, `已${p.op === 'replace' ? '替换' : '新增'}《${group.title}》的来源链接并验明可打开（分享共 ${files.length} 个文件），来源清单已同步。`);
    return;
  }

  group.links = group.links.map((l, i) => ({ ...l, slot: i + 1 }));
  await panel.pushLinks(groups);
  await done(req, `已删除《${group.title}》第 ${p.slot} 条来源链接，来源清单已同步。`);
}

export const handlers = {
  search: handleSearch,
  fix: handleFix,
  add: handleAdd,
  watchscan: handleWatchscan,
  scan: handleScan,
  catalog_refresh: handleCatalogRefresh,
  link: handleLink,
};
