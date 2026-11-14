/**
 * panel.mjs — 面板 worker 接口客户端。
 *
 * 面板地址 API_BASE（默认 http://localhost:8080）；worker 接口需要
 * 请求头 Authorization: Bearer <WORKER_TOKEN>。UI 侧 GET（看板/目录/
 * 链接/问题）无鉴权，这里也统一带上令牌头，无副作用。
 */

const API_BASE = (process.env.API_BASE || 'http://localhost:8080').replace(/\/$/, '');
const TOKEN = process.env.WORKER_TOKEN || '';

export function panelConfig() {
  return { apiBase: API_BASE, hasToken: Boolean(TOKEN) };
}

async function call(path, body) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`面板接口 ${path} -> ${r.status} ${data.error || ''}`);
  return data;
}

/** 领取全部 pending + processing 请求（旧在前）。 */
export async function getPending() {
  const { requests } = await call('/api/worker/requests/pending');
  return requests || [];
}

/** 合并式回写一条请求：{status?, progress_percent?, progress_stage?, result_note?, results?, found_count?, ...} */
export async function update(id, patch) {
  return call(`/api/worker/requests/${id}`, patch);
}

/** 全量替换追更看板快照（board 为完整看板 JSON）。 */
export async function pushBoard(board) {
  return call('/api/worker/board', board);
}

/** 全量替换全量目录快照。 */
export async function pushCatalog(catalog) {
  return call('/api/worker/catalog', catalog);
}

/** 全量同步来源链接：{links:[{tmdb_id, title, links:[{slot, url, code?}]}]} */
export async function pushLinks(links) {
  return call('/api/worker/watch-links', { links });
}

/** 全量同步问题列表：{issues:[{tmdb_id, title, issue_type, issue_text, updated_at_text?}]} */
export async function pushIssues(issues) {
  return call('/api/worker/issues', { issues });
}

/** 合并写入全局扫描状态（任意子集字段）。 */
export async function pushScanStatus(patch) {
  return call('/api/worker/watch-scan-status', patch);
}

/** 按作品合并写入逐部扫描状态：{states:[{show_key?|tmdb_id?|title, ...}]} */
export async function pushShowScanStates(states) {
  return call('/api/worker/watch-show-scan-states', { states });
}

/** 定时（scheduled）未分类扫描结束后回写扫描时钟。 */
export async function pushUnclassifiedClock(lastScanAtMs, nextScanAtMs) {
  return call('/api/worker/unclassified-scan-clock', {
    last_scan_at_ms: lastScanAtMs,
    next_scan_at_ms: nextScanAtMs,
  });
}

/* ---- UI 侧只读（供任务计算上下文，无需令牌） ---- */

/** 当前看板快照：{has_snapshot, board:{shows:[...]}} */
export async function getBoard() {
  return call('/api/board');
}

/** 当前目录快照：{has_snapshot, catalog:{categories:{...}}} */
export async function getCatalog() {
  return call('/api/catalog');
}

/** 当前来源链接分组：{has_synced, links:[{tmdb_id, title, links:[...]}]} */
export async function getWatchLinks() {
  return call('/api/watch-links');
}

/** 未分类自动扫描设置：{enabled, interval_minutes, ...} */
export async function getUnclassifiedSchedule() {
  return call('/api/unclassified-scan-schedule');
}

/** 逐部扫描状态：{states:[{show_key, tmdb_id, title, enabled, interval_minutes, ...}]} */
export async function getShowScanStates() {
  return call('/api/watch-show-scan-states');
}
