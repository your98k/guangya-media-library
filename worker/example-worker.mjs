#!/usr/bin/env node
/**
 * example-worker.mjs — 示例 worker（无第三方依赖，只用 Node 18+ 自带 fetch）
 *
 * 职责：轮询面板的待处理请求，逐个标记处理中、上报进度、写回结果。
 * 这只是“接缝”演示：搜索可选用真实 TMDB（设 TMDB_API_KEY），其余请求
 * 模拟完成并在 result_note 里说明。真正的光鸭自动化（查分享、转存、
 * 改名、刷新目录快照等）就在这里接入：把每个 kind 的处理换成真实逻辑，
 * 再通过 /api/worker/* 把看板、目录、链接、问题、扫描时钟推回面板。
 *
 * 环境变量：
 *   API_BASE      面板地址，默认 http://localhost:8080
 *   WORKER_TOKEN  与服务端一致的令牌，默认 change-me
 *   TMDB_API_KEY  可选；设置后搜索请求走真实 TMDB
 *   POLL_MS       轮询间隔，默认 10000
 */
const API_BASE = (process.env.API_BASE || 'http://localhost:8080').replace(/\/$/, '');
const TOKEN = process.env.WORKER_TOKEN || 'change-me';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const POLL_MS = Number(process.env.POLL_MS || 10000);

const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, body) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${data.error || ''}`);
  return data;
}
const update = (id, body) => api(`/api/worker/requests/${id}`, body);

async function tmdbSearch(payload) {
  const key = encodeURIComponent(TMDB_API_KEY);
  let items = [];
  if (payload.mode === 'tmdb_id') {
    const type = payload.id_type === 'movie' ? 'movie' : 'tv';
    const r = await fetch(`https://api.themoviedb.org/3/${type}/${payload.query}?api_key=${key}&language=zh-CN`);
    if (!r.ok) throw new Error(`TMDB ${r.status}`);
    const d = await r.json();
    items = [d];
  } else {
    const r = await fetch(`https://api.themoviedb.org/3/search/multi?api_key=${key}&language=zh-CN&query=${encodeURIComponent(payload.query)}`);
    if (!r.ok) throw new Error(`TMDB ${r.status}`);
    const d = await r.json();
    items = (d.results || []).filter((x) => x.media_type === 'tv' || x.media_type === 'movie');
  }
  return items.slice(0, 20).map((x) => ({
    tmdb_id: x.id,
    title: x.title || x.name || '',
    year: Number(String(x.release_date || x.first_air_date || '').slice(0, 4)) || null,
    media_type: x.media_type || (payload.id_type === 'movie' ? 'movie' : 'tv'),
    overview: x.overview || '',
    poster_url: x.poster_path ? `https://image.tmdb.org/t/p/w500${x.poster_path}` : '',
    vote_average: x.vote_average ?? null,
  }));
}

function demoSearchResults(payload) {
  return [1, 2].map((n) => ({
    tmdb_id: 990000 + n,
    title: `示例搜索结果 ${n}（未配置 TMDB_API_KEY 的演示数据）`,
    year: 2026,
    media_type: payload.id_type === 'movie' ? 'movie' : 'tv',
    overview: `这是示例 worker 返回的演示结果，与「${payload.query}」无关。配置 TMDB_API_KEY 后将返回真实 TMDB 结果。`,
    poster_url: '',
    vote_average: null,
  }));
}

async function handle(req) {
  const p = req.payload || {};
  console.log(`[worker] 处理 #${req.id} ${req.kind}`);
  await update(req.id, { status: 'processing', progress_percent: 20, progress_stage: '示例 worker 已领取' });
  await sleep(600);

  if (req.kind === 'search') {
    await update(req.id, { progress_percent: 60, progress_stage: TMDB_API_KEY ? '正在查询 TMDB' : '生成演示结果' });
    const results = TMDB_API_KEY ? await tmdbSearch(p) : demoSearchResults(p);
    // 注意：搜索请求写回 results 后保持 processing 不合适——这里直接置 done 前
    // 先写结果（结果带 5 分钟有效期，用户勾选提交后由面板 finalize 定稿）。
    await update(req.id, { results });
    await update(req.id, { status: 'done', progress_percent: 100, progress_stage: '完成', result_note: `共 ${results.length} 条结果（5 分钟内有效）` });
    return;
  }

  if (req.kind === 'scan') {
    await update(req.id, { progress_percent: 70, progress_stage: '示例：假装正在整理未分类文件夹' });
    await sleep(600);
    await update(req.id, {
      status: 'done', progress_percent: 100, progress_stage: '完成',
      found_count: 0, organized_count: 0, taken_count: 0,
      result_note: '示例 worker：未接入真实光鸭自动化，本轮模拟完成（发现 0 项）。真实实现应在此枚举「未分类影视」文件夹、识别作品并只补缺集入库。',
    });
    await api('/api/worker/unclassified-scan-clock', {
      last_scan_at_ms: Date.now(), next_scan_at_ms: Date.now() + 120 * 60 * 1000,
    });
    return;
  }

  if (req.kind === 'watchscan') {
    await update(req.id, { progress_percent: 70, progress_stage: '示例：假装正在查这部的来源' });
    await sleep(600);
    await api('/api/worker/watch-show-scan-states', {
      states: [{
        show_key: p.show_key || undefined, tmdb_id: p.tmdb_id ?? undefined, title: p.title || undefined,
        last_scan_at_ms: Date.now(), next_scan_at_ms: Date.now() + 3600e3, scan_active: false,
        progress_percent: null, progress_stage: null, progress_at_ms: Date.now(),
      }],
    });
    await update(req.id, { status: 'done', progress_percent: 100, progress_stage: '完成', result_note: '示例 worker：模拟扫描完成，未发现新集。真实实现应在此检查该剧全部分享来源并补入缺集。' });
    return;
  }

  if (req.kind === 'catalog_refresh') {
    await update(req.id, { status: 'done', progress_percent: 100, progress_stage: '完成', result_note: '示例 worker：未重新枚举网盘，目录快照保持不变。真实实现应枚举「影视」根目录后 POST /api/worker/catalog。' });
    return;
  }

  // add / fix / link：统一模拟完成并说明接缝
  const notes = {
    add: p.stop_tracking
      ? '示例 worker：已模拟取消追更。真实实现应把该剧移出追更状态并刷新看板快照（已入库文件不删）。'
      : '示例 worker：已模拟入库。真实实现应在此校验分享、查库缺集、转存、改名，并刷新看板/目录快照。',
    fix: '示例 worker：已模拟修复流程。真实实现应在此寻找同规格或更高规格的替代来源、验明可打开后换源并补齐缺集。',
    link: '示例 worker：已模拟链接操作。真实实现应验明新链接可打开后更新来源清单，并 POST /api/worker/watch-links 全量同步。',
  };
  await update(req.id, { status: 'done', progress_percent: 100, progress_stage: '完成', result_note: notes[req.kind] || '示例 worker：模拟完成。' });
}

async function loop() {
  console.log(`[worker] 启动：API_BASE=${API_BASE} TMDB=${TMDB_API_KEY ? 'on' : 'off(demo)'}`);
  for (;;) {
    try {
      const { requests } = await api('/api/worker/requests/pending');
      for (const req of requests) {
        if (req.status !== 'pending') continue;
        try { await handle(req); }
        catch (e) {
          console.error(`[worker] #${req.id} 失败:`, e.message);
          await update(req.id, { status: 'failed', result_note: `示例 worker 处理失败：${e.message}` }).catch(() => {});
        }
      }
    } catch (e) {
      console.error('[worker] 轮询失败（稍后重试）:', e.message);
    }
    await sleep(POLL_MS);
  }
}

loop();
