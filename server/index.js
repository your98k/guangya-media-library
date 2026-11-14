'use strict';
/**
 * guangya-media-library server
 * Serves the panel UI (client/dist) and the REST API.
 * The panel itself stores state only; real Guangya automation lives in an
 * external "worker" that talks to the /api/worker/* endpoints (see docs/API.md).
 */
const path = require('path');
const express = require('express');
const { initDb } = require('./db');

const db = initDb();
const app = express();
app.use(express.json({ limit: '8mb' }));

const PORT = process.env.PORT || 8080;
const WORKER_TOKEN = process.env.WORKER_TOKEN || '';
const nowIso = () => new Date().toISOString();
const FINISHED = ['done', 'failed', 'cancelled', 'expired'];
const SHARE_URL_RE = /^https:\/\/www\.guangyapan\.com\/s\/[A-Za-z0-9]+_[A-Za-z0-9_-]+\/?$/;

const parseJson = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

/* ---------------- snapshots & state helpers ---------------- */

function getSnapshot(key) {
  const row = db.prepare('SELECT json, updated_at FROM snapshots WHERE key = ?').get(key);
  if (!row) return null;
  return { data: parseJson(row.json, null), updated_at: row.updated_at };
}
function setSnapshot(key, data) {
  db.prepare('INSERT INTO snapshots (key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
    .run(key, JSON.stringify(data), nowIso());
}
function getSingleton(table) {
  const row = db.prepare(`SELECT json FROM ${table} WHERE id = 1`).get();
  return row ? parseJson(row.json, {}) : {};
}
function setSingleton(table, obj) {
  db.prepare(`INSERT INTO ${table} (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json`)
    .run(JSON.stringify(obj));
}
function getMeta(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

/* ---------------- requests helpers ---------------- */

function rowToRequest(r) {
  const resultsWrap = parseJson(r.results_json, null);
  let results = null, results_at = null, expired = false;
  if (resultsWrap) {
    results = resultsWrap.items || null;
    results_at = resultsWrap.results_at || null;
    const payload = parseJson(r.payload_json, {});
    if (results_at && !payload.finalized) {
      expired = Date.now() - new Date(results_at).getTime() > 5 * 60 * 1000;
    }
    if (expired) results = (results || []).map((x) => ({ ...x, poster_url: '' }));
  }
  return {
    id: r.id, kind: r.kind, status: r.status,
    payload: parseJson(r.payload_json, {}),
    progress_percent: r.progress_percent, progress_stage: r.progress_stage,
    result_note: r.result_note, results, results_at, results_expired: expired,
    found_count: r.found_count, organized_count: r.organized_count, taken_count: r.taken_count,
    trigger: r.trigger, created_at: r.created_at, updated_at: r.updated_at,
  };
}
function insertRequest(kind, payload, extra = {}) {
  const t = nowIso();
  const info = db.prepare(`INSERT INTO requests (kind, status, payload_json, trigger, created_at, updated_at)
    VALUES (?, 'pending', ?, ?, ?, ?)`)
    .run(kind, JSON.stringify(payload || {}), extra.trigger || null, t, t);
  return db.prepare('SELECT * FROM requests WHERE id = ?').get(info.lastInsertRowid);
}
function getRequest(id) {
  return db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
}

/* ---------------- health ---------------- */

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'guangya-media-library', time: nowIso() }));

/* ---------------- UI reads ---------------- */

app.get('/api/board', (req, res) => {
  const snap = getSnapshot('board');
  res.json({ has_snapshot: !!snap, board: snap ? snap.data : null, updated_at: snap ? snap.updated_at : null });
});

app.get('/api/catalog', (req, res) => {
  const snap = getSnapshot('catalog');
  res.json({ has_snapshot: !!snap, catalog: snap ? snap.data : null, updated_at: snap ? snap.updated_at : null });
});

app.get('/api/watch-links', (req, res) => {
  const rows = db.prepare('SELECT * FROM watch_links ORDER BY title, slot').all();
  const grouped = new Map();
  for (const r of rows) {
    const k = `${r.tmdb_id ?? ''}|${r.title ?? ''}`;
    if (!grouped.has(k)) grouped.set(k, { tmdb_id: r.tmdb_id, title: r.title, links: [] });
    grouped.get(k).links.push({ slot: r.slot, url: r.url, code: r.code || undefined });
  }
  res.json({ has_synced: getMeta('watch_links_synced') === '1', links: [...grouped.values()] });
});

app.get('/api/issues', (req, res) => {
  const rows = db.prepare('SELECT * FROM issues ORDER BY id').all();
  res.json({ has_synced: getMeta('issues_synced') === '1', issues: rows });
});

app.get('/api/watch-scan-status', (req, res) => {
  res.json(getSingleton('watch_scan_state'));
});

app.get('/api/watch-show-scan-states', (req, res) => {
  const rows = db.prepare('SELECT * FROM watch_show_scan_state ORDER BY title').all();
  res.json({
    states: rows.map((r) => ({ show_key: r.show_key, tmdb_id: r.tmdb_id, title: r.title, ...parseJson(r.json, {}) })),
  });
});

app.get('/api/unclassified-scan-schedule', (req, res) => {
  res.json(getSingleton('unclassified_scan_schedule'));
});

app.get('/api/requests', (req, res) => {
  const rows = db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 300').all();
  res.json({ requests: rows.map(rowToRequest) });
});

app.get('/api/requests/latest-catalog-refresh', (req, res) => {
  const row = db.prepare("SELECT * FROM requests WHERE kind = 'catalog_refresh' ORDER BY id DESC LIMIT 1").get();
  res.json({ request: row ? rowToRequest(row) : null });
});

/* ---------------- UI writes ---------------- */

function badShareUrl(res) {
  return res.status(400).json({
    error: '分享链接格式不正确：应为 https://www.guangyapan.com/s/<id>_<后缀> 的完整链接（id 与后缀之间的下划线不能丢）。请重新复制完整链接。',
  });
}

app.post('/api/requests/search', (req, res) => {
  const { mode, query, id_type } = req.body || {};
  if (!query || !String(query).trim()) return res.status(400).json({ error: '搜索内容不能为空' });
  if (mode === 'tmdb_id' && !/^\d+$/.test(String(query).trim())) return res.status(400).json({ error: 'TMDB ID 必须是数字' });
  const row = insertRequest('search', { mode: mode || 'name', query: String(query).trim(), id_type: id_type || 'tv' });
  res.status(201).json({ request: rowToRequest(row) });
});

app.post('/api/requests/add', (req, res) => {
  const b = req.body || {};
  if (b.source === 'link') {
    if (!b.url || !SHARE_URL_RE.test(String(b.url).trim())) return badShareUrl(res);
  } else if (b.source === 'tmdb') {
    if (!b.tmdb_id || !b.title) return res.status(400).json({ error: 'TMDB 添加需要 tmdb_id 与 title' });
  } else if (!b.stop_tracking) {
    return res.status(400).json({ error: 'source 必须是 link 或 tmdb' });
  }
  const row = insertRequest('add', {
    source: b.source || null, url: b.url || null, code: b.code || null,
    tmdb_id: b.tmdb_id ?? null, title: b.title || null, year: b.year ?? null,
    media_type: b.media_type || null, poster_url: b.poster_url || null,
    stop_tracking: !!b.stop_tracking, related_title: b.related_title || null,
  });
  res.status(201).json({ request: rowToRequest(row) });
});

app.post('/api/requests/fix', (req, res) => {
  const b = req.body || {};
  if (!b.issue_type || !b.issue_text) return res.status(400).json({ error: '修复请求需要 issue_type 与 issue_text' });
  const open = db.prepare("SELECT * FROM requests WHERE kind = 'fix' AND status IN ('pending','processing')").all()
    .find((r) => { const p = parseJson(r.payload_json, {}); return p.issue_type === b.issue_type && (p.tmdb_id ?? null) === (b.tmdb_id ?? null) && p.title === b.title; });
  if (open) return res.status(200).json({ request: rowToRequest(open), already_open: true });
  const row = insertRequest('fix', { tmdb_id: b.tmdb_id ?? null, title: b.title || null, issue_type: b.issue_type, issue_text: b.issue_text });
  res.status(201).json({ request: rowToRequest(row) });
});

app.post('/api/requests/scan', (req, res) => {
  const trigger = (req.body && req.body.trigger) === 'scheduled' ? 'scheduled' : 'manual';
  const row = insertRequest('scan', {}, { trigger });
  res.status(201).json({ request: rowToRequest(row) });
});

app.post('/api/requests/watchscan', (req, res) => {
  const b = req.body || {};
  if (!b.title && !b.tmdb_id && !b.show_key) return res.status(400).json({ error: '需要指定要扫描的作品（title / tmdb_id / show_key）' });
  const row = insertRequest('watchscan', { tmdb_id: b.tmdb_id ?? null, title: b.title || null, show_key: b.show_key || null });
  res.status(201).json({ request: rowToRequest(row) });
});

app.post('/api/requests/link', (req, res) => {
  const b = req.body || {};
  if (!['add', 'replace', 'delete'].includes(b.op)) return res.status(400).json({ error: 'op 必须是 add / replace / delete' });
  if (!b.title && !b.tmdb_id) return res.status(400).json({ error: '需要指定作品（title 或 tmdb_id）' });
  if (b.op !== 'delete' && (!b.url || !SHARE_URL_RE.test(String(b.url).trim()))) return badShareUrl(res);
  const row = insertRequest('link', { op: b.op, slot: b.slot ?? null, tmdb_id: b.tmdb_id ?? null, title: b.title || null, url: b.url || null, code: b.code || null });
  res.status(201).json({ request: rowToRequest(row) });
});

app.post('/api/requests/catalog-refresh', (req, res) => {
  const open = db.prepare("SELECT * FROM requests WHERE kind = 'catalog_refresh' AND status IN ('pending','processing') ORDER BY id DESC LIMIT 1").get();
  if (open) return res.status(200).json({ request: rowToRequest(open), already_open: true });
  const row = insertRequest('catalog_refresh', {});
  res.status(201).json({ request: rowToRequest(row) });
});

app.post('/api/requests/cleanup-finished', (req, res) => {
  const info = db.prepare(`DELETE FROM requests WHERE status IN (${FINISHED.map(() => '?').join(',')})`).run(...FINISHED);
  res.json({ deleted: info.changes });
});

app.post('/api/requests/search/:id/finalize', (req, res) => {
  const row = getRequest(req.params.id);
  if (!row || row.kind !== 'search') return res.status(404).json({ error: '搜索请求不存在' });
  const ids = new Set((req.body && req.body.tmdb_ids) || []);
  const wrap = parseJson(row.results_json, { items: [], results_at: null });
  const kept = (wrap.items || []).filter((x) => ids.has(x.tmdb_id));
  const payload = { ...parseJson(row.payload_json, {}), finalized: true, submitted_count: kept.length };
  db.prepare('UPDATE requests SET results_json = ?, payload_json = ?, status = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify({ items: kept, results_at: wrap.results_at }), JSON.stringify(payload), 'done', nowIso(), row.id);
  res.json({ request: rowToRequest(getRequest(row.id)) });
});

app.post('/api/requests/:id/cancel', (req, res) => {
  const row = getRequest(req.params.id);
  if (!row) return res.status(404).json({ error: '请求不存在' });
  if (!['pending', 'processing'].includes(row.status)) return res.status(409).json({ error: '只有等待中/处理中的请求可以取消' });
  db.prepare("UPDATE requests SET status = 'cancelled', updated_at = ? WHERE id = ?").run(nowIso(), row.id);
  res.json({ request: rowToRequest(getRequest(row.id)) });
});

app.delete('/api/requests/:id', (req, res) => {
  const row = getRequest(req.params.id);
  if (!row) return res.status(404).json({ error: '请求不存在' });
  if (!FINISHED.includes(row.status)) return res.status(409).json({ error: '只能删除已结束的记录' });
  db.prepare('DELETE FROM requests WHERE id = ?').run(row.id);
  res.json({ deleted: true });
});

app.post('/api/watch-show-scan-control', (req, res) => {
  const b = req.body || {};
  if (!b.show_key && !b.title && !b.tmdb_id) return res.status(400).json({ error: '需要 show_key / title / tmdb_id 之一' });
  const key = b.show_key || (b.tmdb_id ? `tmdb-${b.tmdb_id}` : `title-${b.title}`);
  const existing = db.prepare('SELECT * FROM watch_show_scan_state WHERE show_key = ?').get(key)
    || (b.title ? db.prepare('SELECT * FROM watch_show_scan_state WHERE title = ?').get(b.title) : null);
  const cur = existing ? parseJson(existing.json, {}) : { enabled: true, interval_minutes: null, last_scan_at_ms: null, next_scan_at_ms: null, scan_active: false, progress_percent: null, progress_stage: null, progress_at_ms: null };
  if (typeof b.enabled === 'boolean') cur.enabled = b.enabled;
  if ('interval_minutes' in b) cur.interval_minutes = b.interval_minutes === null ? null : Math.max(1, Math.min(10080, Number(b.interval_minutes) || null));
  db.prepare('INSERT INTO watch_show_scan_state (show_key, tmdb_id, title, json) VALUES (?, ?, ?, ?) ON CONFLICT(show_key) DO UPDATE SET json = excluded.json')
    .run(existing ? existing.show_key : key, b.tmdb_id ?? (existing ? existing.tmdb_id : null), b.title || (existing ? existing.title : null), JSON.stringify(cur));
  res.json({ ok: true, show_key: existing ? existing.show_key : key, state: cur });
});

app.post('/api/unclassified-scan-schedule', (req, res) => {
  const b = req.body || {};
  const cur = getSingleton('unclassified_scan_schedule');
  const next = { enabled: true, interval_minutes: 120, last_scan_at: null, next_scan_at: null, ...cur };
  if (typeof b.enabled === 'boolean') next.enabled = b.enabled;
  if (b.interval_minutes != null) next.interval_minutes = Math.max(15, Math.min(10080, Number(b.interval_minutes) || 120));
  setSingleton('unclassified_scan_schedule', next);
  res.json(next);
});

/* ---------------- worker API ---------------- */

function workerAuth(req, res, next) {
  if (!WORKER_TOKEN) return next();
  const h = req.headers.authorization || '';
  if (h === `Bearer ${WORKER_TOKEN}`) return next();
  return res.status(401).json({ error: 'worker token 无效或缺失（Authorization: Bearer <WORKER_TOKEN>）' });
}
app.use('/api/worker', workerAuth);

app.get('/api/worker/requests/pending', (req, res) => {
  const rows = db.prepare("SELECT * FROM requests WHERE status IN ('pending','processing') ORDER BY id ASC").all();
  res.json({ requests: rows.map(rowToRequest) });
});

app.post('/api/worker/requests/:id', (req, res) => {
  const row = getRequest(req.params.id);
  if (!row) return res.status(404).json({ error: '请求不存在' });
  const b = req.body || {};
  const sets = ['updated_at = ?'];
  const vals = [nowIso()];
  const push = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };
  if (b.status && ['pending', 'processing', 'done', 'failed', 'cancelled', 'expired'].includes(b.status)) push('status', b.status);
  if (b.progress_percent != null) push('progress_percent', Math.max(0, Math.min(100, Number(b.progress_percent))));
  if (b.progress_stage != null) push('progress_stage', String(b.progress_stage));
  if (b.result_note != null) push('result_note', String(b.result_note));
  if (Array.isArray(b.results)) push('results_json', JSON.stringify({ items: b.results, results_at: nowIso() }));
  if (b.found_count != null) push('found_count', Number(b.found_count));
  if (b.organized_count != null) push('organized_count', Number(b.organized_count));
  if (b.taken_count != null) push('taken_count', Number(b.taken_count));
  vals.push(row.id);
  db.prepare(`UPDATE requests SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ request: rowToRequest(getRequest(row.id)) });
});

app.post('/api/worker/board', (req, res) => {
  if (!req.body || !Array.isArray(req.body.shows)) return res.status(400).json({ error: 'board 需要 { generated_at, watch_total, shows: [] }' });
  setSnapshot('board', req.body);
  res.json({ ok: true });
});

app.post('/api/worker/catalog', (req, res) => {
  if (!req.body || typeof req.body !== 'object' || !req.body.categories) return res.status(400).json({ error: 'catalog 需要 { generated_at, totals, posters, categories }' });
  setSnapshot('catalog', req.body);
  res.json({ ok: true });
});

app.post('/api/worker/watch-links', (req, res) => {
  const list = (req.body && req.body.links) || [];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM watch_links').run();
    const ins = db.prepare('INSERT INTO watch_links (tmdb_id, title, slot, url, code) VALUES (?, ?, ?, ?, ?)');
    for (const g of list) for (const l of g.links || []) ins.run(g.tmdb_id ?? null, g.title || null, l.slot, l.url, l.code || null);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('watch_links_synced', '1')").run();
  });
  tx();
  res.json({ ok: true, groups: list.length });
});

app.post('/api/worker/issues', (req, res) => {
  const list = (req.body && req.body.issues) || [];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM issues').run();
    const ins = db.prepare('INSERT INTO issues (tmdb_id, title, issue_type, issue_text, updated_at_text) VALUES (?, ?, ?, ?, ?)');
    for (const i of list) ins.run(i.tmdb_id ?? null, i.title || null, i.issue_type, i.issue_text, i.updated_at_text || null);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('issues_synced', '1')").run();
  });
  tx();
  res.json({ ok: true, count: list.length });
});

app.post('/api/worker/watch-scan-status', (req, res) => {
  const cur = getSingleton('watch_scan_state');
  setSingleton('watch_scan_state', { ...cur, ...(req.body || {}), has_synced: true });
  res.json({ ok: true });
});

app.post('/api/worker/watch-show-scan-states', (req, res) => {
  const states = (req.body && req.body.states) || [];
  for (const s of states) {
    const key = s.show_key || (s.tmdb_id ? `tmdb-${s.tmdb_id}` : `title-${s.title}`);
    if (!key) continue;
    const existing = db.prepare('SELECT * FROM watch_show_scan_state WHERE show_key = ?').get(key)
      || (s.title ? db.prepare('SELECT * FROM watch_show_scan_state WHERE title = ?').get(s.title) : null);
    const cur = existing ? parseJson(existing.json, {}) : {};
    const { show_key, tmdb_id, title, ...fields } = s;
    const merged = { ...cur, ...fields };
    db.prepare('INSERT INTO watch_show_scan_state (show_key, tmdb_id, title, json) VALUES (?, ?, ?, ?) ON CONFLICT(show_key) DO UPDATE SET json = excluded.json')
      .run(existing ? existing.show_key : key, tmdb_id ?? (existing ? existing.tmdb_id : null), title || (existing ? existing.title : null), JSON.stringify(merged));
  }
  res.json({ ok: true, count: states.length });
});

app.post('/api/worker/unclassified-scan-clock', (req, res) => {
  const b = req.body || {};
  const cur = getSingleton('unclassified_scan_schedule');
  const next = { ...cur };
  if (b.last_scan_at_ms != null) next.last_scan_at = new Date(b.last_scan_at_ms).toISOString();
  if (b.next_scan_at_ms != null) next.next_scan_at = b.next_scan_at_ms ? new Date(b.next_scan_at_ms).toISOString() : null;
  setSingleton('unclassified_scan_schedule', next);
  res.json({ ok: true, schedule: next });
});

/* ---------------- static client ---------------- */

const CLIENT_DIST = process.env.CLIENT_DIST || path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(CLIENT_DIST));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(CLIENT_DIST, 'index.html'), (err) => { if (err) next(); });
});

app.listen(PORT, () => {
  console.log(`guangya-media-library listening on :${PORT} (data: ${require('./db').DATA_DIR})`);
});
