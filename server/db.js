'use strict';
/**
 * SQLite storage layer + first-boot seed data.
 * All panel state lives in one SQLite file at DATA_DIR/app.db.
 * Seed data is 100% fictional demo content (示例), no real links or accounts.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

function initDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(path.join(DATA_DIR, 'app.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      key TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS watch_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tmdb_id INTEGER,
      title TEXT,
      slot INTEGER NOT NULL,
      url TEXT NOT NULL,
      code TEXT
    );
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tmdb_id INTEGER,
      title TEXT,
      issue_type TEXT NOT NULL,
      issue_text TEXT NOT NULL,
      updated_at_text TEXT
    );
    CREATE TABLE IF NOT EXISTS watch_scan_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS watch_show_scan_state (
      show_key TEXT PRIMARY KEY,
      tmdb_id INTEGER,
      title TEXT,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS unclassified_scan_schedule (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payload_json TEXT NOT NULL DEFAULT '{}',
      progress_percent INTEGER,
      progress_stage TEXT,
      result_note TEXT,
      results_json TEXT,
      found_count INTEGER,
      organized_count INTEGER,
      taken_count INTEGER,
      trigger TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  seed(db);
  return db;
}

/* ---------------- seed (fictional demo data only) ---------------- */

function seed(db) {
  const has = db.prepare('SELECT value FROM meta WHERE key = ?').get('seeded');
  if (has) return;
  const now = new Date();
  const iso = (d) => d.toISOString();
  const inDays = (n, h = 10) => {
    const d = new Date(now);
    d.setDate(d.getDate() + n);
    d.setHours(h, 0, 0, 0);
    return iso(d);
  };

  const demoShows = [
    {
      key: 'demo-yuanhang',
      title: '远航纪事（示例）',
      year: 2026,
      category: '剧集',
      tmdb_id: null,
      poster_url: '/demo/poster1.svg',
      library_have: 'S01 E01–E10 全齐（示例数据）',
      pending: ['S01E11'],
      next_expected: [{ episode: 'S01E11', at: inDays(2, 20) }],
      cadence: '每周 1 集；更新时间 周三 20:00（示例）',
      spec: '示例选版说明：同集只存高码版，重复副本自动隔离。',
    },
    {
      key: 'demo-yunduan',
      title: '云端学院（示例）',
      year: 2025,
      category: '动漫',
      tmdb_id: null,
      poster_url: '/demo/poster2.svg',
      library_have: 'S01 E01–E24 全齐（示例数据）',
      pending: [],
      next_expected: [{ episode: 'S01E25', at: inDays(4, 10) }],
      cadence: '每周 1 集；更新时间 周六 10:00（示例）',
      spec: '示例选版说明：动漫单版本不套大小门槛。',
    },
    {
      key: 'demo-wuhai',
      title: '雾海来信（示例·无海报演示）',
      year: 2026,
      category: '剧集',
      tmdb_id: null,
      poster_url: '',
      library_have: 'S01 E01–E06（示例数据）',
      pending: [],
      next_expected: [{ episode: 'S01E07', at: inDays(1, 21) }],
      cadence: '每周 1 集；更新时间 周五 21:00（示例）',
      spec: '示例：本卡故意不设海报，演示片名占位效果。',
    },
  ];
  const board = { generated_at: iso(now), watch_total: demoShows.length, shows: demoShows };
  db.prepare('INSERT INTO snapshots (key, json, updated_at) VALUES (?, ?, ?)')
    .run('board', JSON.stringify(board), iso(now));

  const catalog = {
    generated_at: iso(now),
    totals: { titles: 6, episodes: 173, size_bytes: 483183820800 },
    posters: { '999001': '/demo/poster2.svg' },
    categories: {
      '电影': [
        { title: '示例电影：山海之间', year: 2024, tmdb_id: null, poster_url: '/demo/poster3.svg', seasons: null, episodes: 1, size_bytes: 12884901888, folder_name: '示例电影：山海之间 (2024)' },
        { title: '示例电影：无海报之作', year: 2023, tmdb_id: null, poster_url: '', seasons: null, episodes: 1, size_bytes: 8589934592, folder_name: '示例电影：无海报之作 (2023)' },
      ],
      '剧集': [
        { title: '远航纪事（示例）', year: 2026, tmdb_id: null, poster_url: '/demo/poster1.svg', seasons: 1, episodes: 10, size_bytes: 59055800320, folder_name: '远航纪事（示例） (2026)' },
        { title: '雾海来信（示例）', year: 2026, tmdb_id: null, poster_url: '', seasons: 1, episodes: 6, size_bytes: 32212254720, folder_name: '雾海来信（示例） (2026)' },
      ],
      '动漫': [
        { title: '云端学院（示例）', year: 2025, tmdb_id: 999001, poster_url: '', seasons: 1, episodes: 24, size_bytes: 38654705664, folder_name: '云端学院（示例） (2025) {tmdb-999001}' },
        { title: '纸飞机大赛（示例）', year: 2024, tmdb_id: null, poster_url: '/demo/poster3.svg', seasons: 2, episodes: 131, size_bytes: 331872604160, folder_name: '纸飞机大赛（示例） (2024)' },
      ],
    },
  };
  db.prepare('INSERT INTO snapshots (key, json, updated_at) VALUES (?, ?, ?)')
    .run('catalog', JSON.stringify(catalog), iso(now));

  const insLink = db.prepare('INSERT INTO watch_links (tmdb_id, title, slot, url, code) VALUES (?, ?, ?, ?, ?)');
  const EX = 'https://www.guangyapan.com/s/0000000000000000000_demo';
  insLink.run(null, '远航纪事（示例）', 1, EX, null);
  insLink.run(null, '远航纪事（示例）', 2, EX, '1234');
  insLink.run(null, '云端学院（示例）', 1, EX, null);
  insLink.run(null, '云端学院（示例）', 2, EX, null);
  insLink.run(null, '云端学院（示例）', 3, EX, null);
  insLink.run(null, '雾海来信（示例·无海报演示）', 1, EX, null);

  db.prepare('INSERT INTO issues (tmdb_id, title, issue_type, issue_text, updated_at_text) VALUES (?, ?, ?, ?, ?)')
    .run(null, '远航纪事（示例）', 'missing_episodes', '示例问题：S01E11 已过更新时间仍未入库（演示用，非真实问题）。', '示例时间');

  db.prepare('INSERT INTO watch_scan_state (id, json) VALUES (1, ?)')
    .run(JSON.stringify({ has_synced: true, last_scan_at: iso(now), next_scan_at: inDays(0, 23), sweep_active: false, progress_percent: null, progress_stage: null, shows_total: demoShows.length, shows_done: 0 }));

  const insShow = db.prepare('INSERT INTO watch_show_scan_state (show_key, tmdb_id, title, json) VALUES (?, ?, ?, ?)');
  for (const s of demoShows) {
    insShow.run(s.key, s.tmdb_id, s.title, JSON.stringify({
      enabled: true, interval_minutes: null,
      last_scan_at_ms: now.getTime() - 3600e3, next_scan_at_ms: now.getTime() + 3600e3,
      scan_active: false, progress_percent: null, progress_stage: null, progress_at_ms: null,
    }));
  }

  db.prepare('INSERT INTO unclassified_scan_schedule (id, json) VALUES (1, ?)')
    .run(JSON.stringify({ enabled: true, interval_minutes: 120, last_scan_at: iso(now), next_scan_at: inDays(0, 22) }));

  const setMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  setMeta.run('watch_links_synced', '1');
  setMeta.run('issues_synced', '1');
  setMeta.run('seeded', '1');
}

module.exports = { initDb, DATA_DIR };
