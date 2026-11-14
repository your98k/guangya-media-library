/**
 * watchpoll.mjs — 自主追更轮询（与请求队列循环并行、互不阻塞）。
 *
 * 定位：部署在 Docker 里，轮询、验源、转存、改名、转移、排重、选版、
 * 看板刷新、Drivemby 刷新都是确定性活，本来就该全自动——不需要任何
 * AI 智能体参与。不能保证全自动的只有「去聚合站搜新源、失效换源」
 * （在 tasks.mjs 的 fix 里），那类活受站点登录墙/验证码/改版影响。
 *
 * 每 WATCH_POLL_MINUTES 一轮（默认 30，设 0 关闭）：
 * - 从面板读追更看板、来源链接清单与逐部扫描控制；
 * - 被暂停（enabled=false）的剧跳过；没到更新时间（next_expected 在
 *   未来且无待补集）的剧跳过，不浪费请求；
 * - 其余逐部 walkShare 全部来源，与库内 Season 文件夹现有集号比对；
 * - 有缺集时按当前选版设置选版（best 取最优 / any_upgrade 先到先存，
 *   升级替换与 fix/watchscan 共用 tasks.mjs 的同一套实现）；
 * - GUANGYA_INGEST=on 且配置齐全 → 真转存→按模板改名→同集排重→
 *   回写看板→触发 Drivemby 刷新；未开真转存 → 只做「观察」：查源、
 *   比对、把发现打日志并回写该剧扫描状态说明，不建假请求、不动网盘。
 * 单部出错只记日志、继续下一部；部与部之间留 SOURCE_DELAY_MS 间隔。
 */

import * as panel from './panel.mjs';
import * as guangya from './guangya.mjs';
import * as rules from './rules.mjs';
import {
  refreshVersionSettings, currentSettings, libraryMap, findLinkGroup,
  loadExistingByEp, planUpgrades, applyUpgrades, dedupeFolder,
  ingestChosen, markBoardFixed, drivePathsFor, drivembySuffix,
} from './tasks.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[real-worker][watchpoll]', ...a);
const SOURCE_DELAY_MS = Math.max(0, Number(process.env.SOURCE_DELAY_MS || 1500));

export function watchPollMinutes() {
  const n = Number(process.env.WATCH_POLL_MINUTES ?? 30);
  return Number.isFinite(n) ? n : 30;
}

function findShowState(states, show) {
  return (states || []).find((s) =>
    (show.key && s.show_key === show.key)
    || (show.tmdb_id != null && s.tmdb_id != null && Number(s.tmdb_id) === Number(show.tmdb_id))
    || (show.title && s.title === show.title));
}

/** next_expected 顺延：只认看板 cadence 里明确的每日/每周，其余保持原值。 */
function advanceNextExpected(show, boardShow, fixedSet) {
  const notes = [];
  const next = [];
  for (const ne of boardShow.next_expected || []) {
    const se = rules.parsePendingEpisode(ne.episode);
    if (!se || !fixedSet.has(se.episode)) { next.push(ne); continue; }
    let days = 0;
    if (/每日|日更/.test(show.cadence || '')) days = 1;
    else if (/每周|周更/.test(show.cadence || '')) days = 7;
    if (!days) {
      notes.push(`《${show.title}》${ne.episode} 已入库，但 cadence「${show.cadence || '无'}」看不出顺延周期，next_expected 保持原值`);
      next.push(ne);
      continue;
    }
    const at = new Date(new Date(ne.at).getTime() + days * 86400e3).toISOString();
    next.push({ episode: `S${rules.padEp(se.season || 1)}E${rules.padEp(se.episode + 1)}`, at });
  }
  return { next, notes };
}

async function pollShow(show, { linksData, states, settings, ingest, pollMs }) {
  const title = show.title || '';
  const state = findShowState(states, show);
  if (state && state.enabled === false) {
    log(`《${title}》已暂停自动扫描，跳过`);
    return;
  }
  const pendingParsed = (show.pending || []).map(rules.parsePendingEpisode).filter(Boolean);
  const dueNext = (show.next_expected || [])
    .map((ne) => ({ ne, se: rules.parsePendingEpisode(ne.episode) }))
    .filter((x) => x.se && new Date(x.ne.at).getTime() <= Date.now());
  if (!pendingParsed.length && !(show.next_expected || []).length) {
    log(`《${title}》无待补集与下集信息，跳过`);
    return;
  }
  if (!pendingParsed.length && !dueNext.length) {
    log(`《${title}》未到更新时间（下集 ${(show.next_expected || []).map((n) => n.episode).join('、')}），跳过`);
    return;
  }
  const group = findLinkGroup(linksData, show, { tmdb_id: show.tmdb_id, title });
  if (!group?.links?.length) {
    log(`《${title}》没有登记来源链接，跳过`);
    return;
  }

  const targetMap = new Map(); // ep -> season
  for (const p of pendingParsed) targetMap.set(p.episode, p.season || 1);
  for (const x of dueNext) if (!targetMap.has(x.se.episode)) targetMap.set(x.se.episode, x.se.season || 1);
  const targetEps = [...targetMap.keys()];
  const season = targetMap.get(targetEps[0]) || 1;

  // 逐个来源展开分享，按集号归拢候选（保持来源顺序）
  const walkedShares = [];
  const candidatesByEp = new Map();
  for (const l of group.links) {
    try {
      const files = await guangya.walkShare(l.url, l.code);
      walkedShares.push({ url: l.url, code: l.code, site: l.url, files });
      for (const f of files) {
        const ep = rules.parseEpisodeNo(f.name);
        if (ep == null || !targetMap.has(ep)) continue;
        if (!candidatesByEp.has(ep)) candidatesByEp.set(ep, []);
        candidatesByEp.get(ep).push({ file: f, url: l.url, code: l.code });
      }
    } catch (e) {
      log(`《${title}》来源 ${l.url} 查失败：${e.message}`);
    }
  }
  if (!walkedShares.length) {
    log(`《${title}》全部来源都查失败，本轮跳过`);
    return;
  }

  // 与库内现有集号比对（能列库内文件夹时以实查为准，否则用看板进度文本兜底）
  const folderId = libraryMap()[title];
  let existingByEp = new Map();
  if (folderId && guangya.guangyaConfigured()) {
    existingByEp = await loadExistingByEp(folderId).catch(() => new Map());
  }
  const haveSet = existingByEp.size
    ? new Set(existingByEp.keys())
    : rules.parseLibraryHave(show.library_have);

  // 缺集选版：best 取评分最优，any_upgrade 取先到的
  const missing = [];
  for (const ep of targetEps) {
    if (haveSet.has(ep)) continue;
    const list = candidatesByEp.get(ep) || [];
    if (!list.length) continue;
    const hit = settings.version_mode === 'any_upgrade'
      ? list[0]
      : list.reduce((best, e) => (rules.compareFiles(e.file, best.file, settings) > 0 ? e : best), list[0]);
    missing.push({ ep, ...hit });
  }
  const notYet = targetEps.filter((ep) => !haveSet.has(ep) && !candidatesByEp.has(ep));

  const showIngest = ingest && !!folderId;
  const ref = { show_key: show.key, tmdb_id: show.tmdb_id ?? undefined, title };
  const writeState = (stage) => panel.pushShowScanStates([{
    ...ref,
    scan_active: false,
    progress_stage: stage,
    progress_at_ms: Date.now(),
    last_scan_at_ms: Date.now(),
    next_scan_at_ms: Date.now() + (state?.interval_minutes ? state.interval_minutes * 60000 : pollMs),
  }]).catch(() => {});

  /* ---- 观察模式：只查、只报，不动网盘、不建假请求 ---- */
  if (!showIngest) {
    if (missing.length) {
      for (const m of missing) {
        log(`《${title}》发现第 ${m.ep} 集未入库（dry-run）：${m.file.name}（${rules.describeFile(m.file)}，来源 ${m.url}）`);
      }
      await writeState(`观察（dry-run）：发现 ${missing.map((m) => `E${m.ep}`).join('、')} 未入库`);
    } else {
      log(`《${title}》已查来源：${notYet.length ? `目标集 ${notYet.map((e) => `E${e}`).join('、')} 来源里暂未出现` : '无缺集'}`);
      await writeState(notYet.length ? `已查来源，${notYet.map((e) => `E${e}`).join('、')} 暂未出现` : '已查来源，无缺集');
    }
    if (settings.version_mode === 'any_upgrade' && existingByEp.size) {
      const upgrades = planUpgrades(walkedShares, existingByEp, new Set(targetEps), settings);
      const up = await applyUpgrades({ upgrades, folderId, show, season, settings });
      for (const line of up.lines) log(`《${title}》${line}`);
    }
    return;
  }

  /* ---- 真转存模式 ---- */
  const fixedEps = [];
  if (missing.length) {
    const bySource = new Map();
    for (const m of missing) {
      if (!bySource.has(m.url)) bySource.set(m.url, { code: m.code, chosen: new Map() });
      bySource.get(m.url).chosen.set(m.ep, m.file);
    }
    for (const [url, { code, chosen }] of bySource) {
      const res = await ingestChosen({ sourceUrl: url, code, folderId, show, season, chosen });
      const ok = [...chosen.keys()].filter((ep) => !res.lost.includes(ep));
      fixedEps.push(...ok);
      log(`《${title}》从 ${url} 补入 ${res.renamed.length} 集：${res.renamed.join('、')}${res.lost.length ? `；未落地待复查：${res.lost.map((e) => `E${e}`).join('、')}` : ''}`);
    }
  }

  const dedupeLines = await dedupeFolder(folderId, settings);
  for (const line of dedupeLines) log(`《${title}》${line}`);

  let replaced = [];
  if (settings.version_mode === 'any_upgrade') {
    const existingNow = await loadExistingByEp(folderId).catch(() => existingByEp);
    const upgrades = planUpgrades(walkedShares, existingNow, new Set(fixedEps), settings);
    const up = await applyUpgrades({ upgrades, folderId, show, season, settings });
    replaced = up.replaced;
    for (const line of up.lines) log(`《${title}》${line}`);
  }

  if (fixedEps.length) {
    // 回写看板：先移除 pending 并更新 library_have，再顺延 next_expected
    await markBoardFixed(show, fixedEps, season);
    const { board } = await panel.getBoard();
    const bs = board?.shows?.find((s) => s.key === show.key);
    if (bs) {
      const { next, notes } = advanceNextExpected(show, bs, new Set(fixedEps));
      for (const n of notes) log(n);
      bs.next_expected = next;
      board.generated_at = new Date().toISOString();
      await panel.pushBoard(board);
    }
  }

  if (fixedEps.length || replaced.length) {
    const { catalog } = await panel.getCatalog().catch(() => ({ catalog: null }));
    const suffix = await drivembySuffix(drivePathsFor(show, catalog, [season]));
    if (suffix) log(`《${title}》Drivemby：${suffix.replace(/^；/, '')}`);
  }

  await writeState(fixedEps.length
    ? `轮询完成：补入 ${fixedEps.map((e) => `E${e}`).join('、')}${replaced.length ? `，升级替换 ${replaced.map((e) => `E${e}`).join('、')}` : ''}`
    : (notYet.length ? `已查来源，${notYet.map((e) => `E${e}`).join('、')} 暂未出现` : '已查来源，无缺集'));
  log(`《${title}》本轮处理完毕（缺集补入 ${fixedEps.length} 集、升级替换 ${replaced.length} 集）`);
}

/** 跑一轮自主追更轮询（不抛错，内部逐部兜底）。 */
export async function runWatchPollRound() {
  const minutes = watchPollMinutes();
  const pollMs = minutes * 60000;
  await refreshVersionSettings();
  const settings = currentSettings();
  const ingest = process.env.GUANGYA_INGEST === 'on' && guangya.guangyaConfigured()
    && Object.keys(libraryMap()).length > 0;
  if (!guangya.guangyaConfigured()) {
    log('未配置光鸭登录态（GUANGYA_COOKIE / GUANGYA_SESSION_FILE），本轮跳过');
    return;
  }
  const { board } = await panel.getBoard().catch(() => ({ board: null }));
  if (!board?.shows?.length) {
    log('看板为空，本轮跳过');
    return;
  }
  const linksData = await panel.getWatchLinks().catch(() => ({ links: [] }));
  const statesData = await panel.getShowScanStates().catch(() => ({ states: [] }));
  log(`开始一轮（共 ${board.shows.length} 部；模式 ${settings.version_mode}；${ingest ? '真转存' : '观察 dry-run'}）`);
  for (const show of board.shows) {
    try {
      await pollShow(show, { linksData, states: statesData?.states, settings, ingest, pollMs });
    } catch (e) {
      log(`《${show.title}》轮询出错：${e.message}（继续下一部）`);
    }
    await sleep(SOURCE_DELAY_MS);
  }
  log('本轮结束');
}

/**
 * 启动自主轮询定时器（与请求队列循环并行）。返回停止函数。
 * WATCH_POLL_MINUTES<=0 或非法 → 关闭。第一轮在启动 5 秒后跑，
 * 之后每隔设定间隔一轮；上一轮没跑完时跳过本次触发，不叠跑。
 */
export function startWatchPoll({ isStopping } = {}) {
  const minutes = watchPollMinutes();
  if (!(minutes > 0)) {
    log('自主追更轮询：关（WATCH_POLL_MINUTES 设为 0）');
    return () => {};
  }
  log(`自主追更轮询：开（每 ${minutes} 分钟一轮）`);
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running || (isStopping && isStopping())) return;
    running = true;
    try { await runWatchPollRound(); }
    catch (e) { log('本轮异常：', e.message); }
    finally { running = false; }
  };
  const first = setTimeout(tick, 5000);
  const timer = setInterval(tick, minutes * 60000);
  first.unref?.();
  timer.unref?.();
  return () => { stopped = true; clearTimeout(first); clearInterval(timer); };
}
