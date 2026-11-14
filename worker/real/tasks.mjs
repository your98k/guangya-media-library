/**
 * tasks.mjs — 各类请求的真实处理逻辑。
 *
 * 总原则（诚实边界）：
 * - 面板只排队，活在这里干；干不成如实把请求标 failed 并写明原因，绝不假成功。
 * - 默认 dry-run：检索、验源、按规则选版、把候选报告写进 result_note，
 *   不动网盘。只有 GUANGYA_INGEST=on 且光鸭登录态已配置、且该剧的入库
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

function ingestBlockers(title) {
  const out = [];
  if (process.env.GUANGYA_INGEST !== 'on') out.push('GUANGYA_INGEST 未开启');
  if (!guangya.guangyaConfigured()) out.push('未配置光鸭登录态（GUANGYA_COOKIE / GUANGYA_SESSION_FILE）');
  if (title && !libraryMap()[title]) out.push(`GUANGYA_LIBRARY_MAP 未配置《${title}》的入库文件夹`);
  return out;
}

let libraryMapCache = null;
function libraryMap() {
  if (libraryMapCache) return libraryMapCache;
  try {
    libraryMapCache = JSON.parse(process.env.GUANGYA_LIBRARY_MAP || '{}');
  } catch {
    log('GUANGYA_LIBRARY_MAP 不是合法 JSON，已按空表处理');
    libraryMapCache = {};
  }
  return libraryMapCache;
}

function findShow(board, { tmdb_id, title, show_key } = {}) {
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

function findLinkGroup(linksData, show, { tmdb_id, title } = {}) {
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
function drivePathsFor(show, catalog, seasons = []) {
  const found = findCatalogEntry(catalog, show, show?.title);
  const folderName = found?.entry?.folder_name || (show?.year ? `${show.title} (${show.year})` : show?.title || '');
  const category = found?.category || show?.category || '';
  const base = category ? `/影视/${category}/${folderName}` : `/影视/${folderName}`;
  const ss = [...new Set(seasons.filter((s) => Number.isFinite(s)))];
  return ss.length ? ss.map((s) => `${base}/Season ${s}`) : [base];
}

/** 对每个入库目录调一次 Drivemby 刷新，返回要附在 result_note 末尾的话（未配置时返回 ''）。 */
async function drivembySuffix(paths) {
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
async function ingestChosen({ sourceUrl, code, folderId, show, season, chosen }) {
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
async function markBoardFixed(show, fixedEps, season) {
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
  const liveAction = (show?.category || '') === '剧集';

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

  await progress(req, 50, '逐个验分享并按规则选版');
  const evaluated = [];
  for (const cand of gyCandidates) {
    try {
      const files = await guangya.walkShare(cand.url);
      const pick = wantedEps.length
        ? rules.pickEpisodes(files, wantedEps, { liveAction })
        : { chosen: new Map(), unmet: [] };
      evaluated.push({ cand, files, pick });
    } catch (e) {
      evaluated.push({ cand, error: e });
    }
  }
  const usable = evaluated.filter((e) => !e.error);
  usable.sort((a, b) =>
    (b.pick.chosen.size - a.pick.chosen.size) ||
    ([...b.pick.chosen.values()].reduce((s, f) => s + f.size, 0) - [...a.pick.chosen.values()].reduce((s, f) => s + f.size, 0)));
  const best = usable[0];
  const bestCovers = best && (wantedEps.length ? best.pick.chosen.size > 0 : best.files.length > 0);

  const reportLines = [
    `检索：《${displayTitle}》 教父网/迷你影视共 ${candidates.length} 条候选（光鸭 ${gyCandidates.length}、磁力 ${magnetCount}）`,
    ...report.map((r) => `  ${r.site}：${r.status === 'ok' ? `返回 ${r.count ?? 0} 条` : r.status === 'unconfigured' ? r.reason : `不可用（${r.reason}）`}`),
  ];
  for (const e of usable) {
    const parts = [...e.pick.chosen.entries()].map(([ep, f]) => `E${ep} ${rules.formatBytes(f.size)}`);
    reportLines.push(`候选 ${e.cand.url}（${e.cand.site}，共 ${e.files.length} 个文件）${wantedEps.length ? `：可补 ${parts.join('、') || '无'}` : ''}`);
    if (e.pick.unmet?.length) reportLines.push(`  未满足（无合格版本）：${e.pick.unmet.map((x) => `E${x}`).join('、')}`);
  }
  for (const e of evaluated.filter((x) => x.error)) {
    reportLines.push(`候选 ${e.cand.url}：验源失败（${e.error.message}）`);
  }

  if (!bestCovers) {
    await failed(req, ['两站均未找到符合规则的替代源，需要人工提供链接。', ...reportLines].join('\n'));
    return;
  }

  const blockers = ingestBlockers(displayTitle);
  const folderId = libraryMap()[displayTitle];
  const canIngest = !blockers.length;
  const dryRun = async (why) => {
    await progress(req, 90, 'dry-run：整理候选报告');
    await done(req, [
      `dry-run：已找到候选，未执行转存（原因：${why}）`,
      ...reportLines,
      wantedEps.length
        ? `首选来源可补：${[...best.pick.chosen.entries()].map(([ep, f]) => `E${ep}（${f.name}，${rules.formatBytes(f.size)}）`).join('、')}`
        : `首选来源可用：${best.cand.url}（共 ${best.files.length} 个文件）`,
    ].join('\n'));
  };

  // 有待补集：走转存路径（或 dry-run 出报告）
  if (wantedEps.length) {
    if (!canIngest) {
      await dryRun(blockers.join('；') || '未开启真转存');
      return;
    }
    await progress(req, 75, '正在转存并改名');
    const { catalog } = await panel.getCatalog().catch(() => ({ catalog: null }));
    const res = await ingestChosen({
      sourceUrl: best.cand.url, folderId, show: { title: displayTitle, year: show?.year }, season, chosen: best.pick.chosen,
    });
    const fixedEps = [...best.pick.chosen.keys()].filter((ep) => !res.lost.includes(ep));
    if (fixedEps.length) await markBoardFixed({ key: show?.key, title: displayTitle }, fixedEps, season);
    const suffix = await drivembySuffix(drivePathsFor(show || { title: displayTitle }, catalog, [season]));
    await done(req, [
      `已从 ${best.cand.site} 补入 ${res.renamed.length} 集：${res.renamed.join('、')}`,
      res.lost.length ? `以下集数转存后未在目标文件夹找到（落地延迟或被改名），请人工复查：${res.lost.map((e) => `E${e}`).join('、')}` : '',
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

  await done(req, [
    'dry-run：已找到候选，未执行转存（本次情形无需转存或无法判定入库目标）',
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
    const eps = [...new Set(files.map((f) => rules.parseEpisodeNo(f.name)).filter((x) => x != null))].sort((a, b) => a - b);
    const total = files.reduce((s, f) => s + f.size, 0);
    const folderId = libraryMap()[url];
    if (ingestEnabled() && folderId) {
      await progress(req, 75, '正在转存');
      await guangya.saveShareFiles(url, folderId, files.map((f) => f.id), p.code);
      // 这里只知道目标文件夹 ID、不知道其完整路径，无法按路径触发 Drivemby 刷新，故不调。
      await done(req, `已验明并转存：分享共 ${files.length} 个文件（合计 ${rules.formatBytes(total)}）已转存到 GUANGYA_LIBRARY_MAP 中该链接对应的文件夹；因请求里没有作品信息，未做改名与看板更新，请人工归类。`);
      return;
    }
    await done(req, [
      `dry-run：已验明分享可打开，未执行转存。`,
      `分享内容：共 ${files.length} 个文件，合计 ${rules.formatBytes(total)}${eps.length ? `，识别集数：${eps.map((e) => `E${e}`).join('、')}` : ''}。`,
      `未转存原因：${ingestBlockers('').join('；') || 'GUANGYA_LIBRARY_MAP 未按分享链接配置入库文件夹'}。`,
    ].join('\n'));
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
    const available = new Map(); // ep -> {file, url}
    const sourceNotes = [];
    for (const l of group.links) {
      try {
        const files = await guangya.walkShare(l.url, l.code);
        let count = 0;
        for (const f of files) {
          const ep = rules.parseEpisodeNo(f.name);
          if (ep == null) continue;
          count++;
          const prev = available.get(ep);
          if (!prev || f.size > prev.file.size) available.set(ep, { file: f, url: l.url, code: l.code });
        }
        sourceNotes.push(`来源 ${l.url}：${files.length} 个文件`);
      } catch (e) {
        sourceNotes.push(`来源 ${l.url}：查失败（${e.message}）`);
      }
    }
    const have = rules.parseLibraryHave(show.library_have);
    const pendingEps = (show.pending || []).map(rules.parsePendingEpisode).filter(Boolean).map((x) => x.episode);
    const newEps = [...available.keys()].filter((ep) => !have.has(ep)).sort((a, b) => a - b);
    const stillMissing = pendingEps.filter((ep) => !available.has(ep));

    let ingestNote = '';
    let drvSuffix = '';
    const folderId = libraryMap()[show.title];
    const ingestible = newEps.filter((ep) => pendingEps.includes(ep));
    if (ingestible.length && ingestEnabled() && folderId) {
      await progress(req, 75, '正在补入新集');
      // 按来源分组逐个转存（同一集只取已选定的最大文件所在来源）
      const bySource = new Map();
      for (const ep of ingestible) {
        const hit = available.get(ep);
        if (!bySource.has(hit.url)) bySource.set(hit.url, { code: hit.code, chosen: new Map() });
        bySource.get(hit.url).chosen.set(ep, hit.file);
      }
      const fixed = [];
      for (const [url, { code, chosen }] of bySource) {
        const season = (show.pending || []).map(rules.parsePendingEpisode).find(Boolean)?.season || 1;
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

    await done(req, [
      `《${show.title}》扫描完成：来源共提供 ${available.size} 集，库内已有 ${have.size} 集。`,
      newEps.length ? `新发现（库内没有）：${newEps.map((e) => `E${e}`).join('、')}。` : '没有新集。',
      stillMissing.length ? `待补仍缺：${stillMissing.map((e) => `E${e}`).join('、')}。` : '',
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
