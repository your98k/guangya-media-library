# API 文档

面板分两组接口：**UI 接口**（页面使用，无鉴权——请勿直接暴露到公网，建议放在反代/内网之后）与 **Worker 接口**（外部自动化使用，需 `Authorization: Bearer <WORKER_TOKEN>`，服务端设置了 `WORKER_TOKEN` 环境变量时强制校验）。

所有响应均为 JSON。错误统一为 `{ "error": "中文说明" }` + 对应 HTTP 状态码。

---

## UI 读取

### GET /api/health
```json
{ "ok": true, "service": "guangya-media-library", "time": "2026-01-01T00:00:00.000Z" }
```

### GET /api/board — 追更看板快照
```json
{
  "has_snapshot": true,
  "board": {
    "generated_at": "2026-01-01T00:00:00.000Z",
    "watch_total": 1,
    "shows": [{
      "key": "demo", "title": "示例剧", "year": 2026, "category": "剧集",
      "tmdb_id": 12345, "poster_url": "https://image.tmdb.org/t/p/w500/xxx.jpg",
      "library_have": "S01 E01–E10 全齐", "pending": ["S01E11"],
      "next_expected": [{ "episode": "S01E11", "at": "2026-01-03T20:00:00+08:00" }],
      "cadence": "每周 1 集", "spec": "选版说明"
    }]
  },
  "updated_at": "2026-01-01T00:00:00.000Z"
}
```

### GET /api/catalog — 全量目录快照
```json
{
  "has_snapshot": true,
  "catalog": {
    "generated_at": "2026-01-01T00:00:00.000Z",
    "totals": { "titles": 100, "episodes": 5000, "size_bytes": 123456789 },
    "posters": { "12345": "https://image.tmdb.org/t/p/w500/xxx.jpg" },
    "categories": {
      "电影": [{ "title": "某电影", "year": 2024, "tmdb_id": 12345, "poster_url": "", "seasons": null, "episodes": 1, "size_bytes": 1000, "folder_name": "某电影 (2024) {tmdb-12345}" }],
      "剧集": [], "动漫": []
    }
  }
}
```
海报取值顺序：条目 `poster_url` → `posters[tmdb_id]` → 片名占位。

### GET /api/watch-links — 追更来源链接（按作品分组）
```json
{ "has_synced": true, "links": [{ "tmdb_id": 12345, "title": "示例剧", "links": [{ "slot": 1, "url": "https://www.guangyapan.com/s/...", "code": "1234" }] }] }
```

### GET /api/issues — 问题列表
```json
{ "has_synced": true, "issues": [{ "id": 1, "tmdb_id": 12345, "title": "示例剧", "issue_type": "missing_episodes", "issue_text": "缺 S01E11", "updated_at_text": "2026-01-01" }] }
```
`issue_type`：`missing_episodes`（缺集）/ `share_invalid`（分享失效）/ `other`。

### GET /api/watch-scan-status — 全局扫描状态
```json
{ "has_synced": true, "last_scan_at": "...", "next_scan_at": "...", "sweep_active": false, "progress_percent": null, "progress_stage": null, "shows_total": 10, "shows_done": 0 }
```

### GET /api/watch-show-scan-states — 逐部扫描状态
```json
{ "states": [{ "show_key": "demo", "tmdb_id": 12345, "title": "示例剧", "enabled": true, "interval_minutes": null, "last_scan_at_ms": 0, "next_scan_at_ms": 0, "scan_active": false, "progress_percent": null, "progress_stage": null, "progress_at_ms": null }] }
```
`interval_minutes` 为 null 表示按官方更新窗口扫描。

### GET /api/unclassified-scan-schedule — 未分类自动扫描设置
```json
{ "enabled": true, "interval_minutes": 120, "last_scan_at": "...", "next_scan_at": "..." }
```

### GET /api/requests — 我的请求（最新在前，最多 300 条）
### GET /api/requests/latest-catalog-refresh — 最近一次目录刷新请求（无则 request=null）
请求对象：
```json
{
  "id": 1, "kind": "search", "status": "done",
  "payload": { "mode": "name", "query": "示例" },
  "progress_percent": 100, "progress_stage": "完成",
  "result_note": "共 2 条结果", "results": null, "results_at": null, "results_expired": false,
  "found_count": null, "organized_count": null, "taken_count": null,
  "trigger": null, "created_at": "...", "updated_at": "..."
}
```
`kind`：`search` / `add` / `fix` / `scan` / `watchscan` / `link` / `catalog_refresh`；
`status`：`pending` / `processing` / `done` / `failed` / `cancelled` / `expired`。
搜索请求的 `results` 在写回 5 分钟后自动标记 `results_expired=true` 且海报被清空（用户已 finalize 的除外）。

---

## UI 写入

| 方法与路径 | 请求体 | 说明 |
|---|---|---|
| POST /api/requests/search | `{mode:"name"\|"tmdb_id", query, id_type?:"tv"\|"movie"}` | 提交 TMDB 搜索 |
| POST /api/requests/add | `{source:"link", url, code?}` 或 `{source:"tmdb", tmdb_id, title, year?, media_type?, poster_url?}` 或 `{stop_tracking:true, title, tmdb_id?}` | 链接添加 / TMDB 添加 / 取消追更 |
| POST /api/requests/fix | `{tmdb_id?, title, issue_type, issue_text}` | 修复请求；同作品同类问题已有未结束的修复时返回原请求并带 `already_open:true` |
| POST /api/requests/scan | `{trigger:"manual"\|"scheduled"}` | 未分类扫描 |
| POST /api/requests/watchscan | `{show_key?, tmdb_id?, title?}` | 单剧立即扫描 |
| POST /api/requests/link | `{op:"add"\|"replace"\|"delete", slot?, tmdb_id?, title, url?, code?}` | 追更卡链接管理 |
| POST /api/requests/catalog-refresh | `{}` | 刷新目录；已有进行中的刷新时返回原请求并带 `already_open:true` |
| POST /api/requests/search/:id/finalize | `{tmdb_ids:[...]}` | 定稿搜索：结果裁剪为已提交项、状态置 done、不再过期 |
| POST /api/requests/:id/cancel | `{}` | 取消等待中/处理中的请求 |
| DELETE /api/requests/:id | — | 删除已结束记录（未结束返回 409） |
| POST /api/requests/cleanup-finished | `{}` | 一键删除全部已结束记录，返回 `{deleted}` |
| POST /api/watch-show-scan-control | `{show_key?\|tmdb_id?\|title, enabled?, interval_minutes?}` | 逐部扫描开关/间隔（只写控制字段，不动时钟） |
| POST /api/unclassified-scan-schedule | `{enabled?, interval_minutes?}` | 未分类自动扫描开关/间隔（15–10080 分钟） |

**分享链接校验**：`source:"link"` 的添加与链接操作（add/replace）会校验 URL 必须符合
`https://www.guangyapan.com/s/<id>_<后缀>` 形状，不合格返回 400 与明确提示——不完整链接（例如丢了 `_后缀`）不会被静默吞掉。

---

## Worker 接口（需 Bearer 令牌）

| 方法与路径 | 请求体 | 说明 |
|---|---|---|
| GET /api/worker/requests/pending | — | 全部 pending + processing 请求（旧在前） |
| POST /api/worker/requests/:id | `{status?, progress_percent?, progress_stage?, result_note?, results?, found_count?, organized_count?, taken_count?}` | 合并式回写；传 `results`（搜索结果数组）时自动盖 `results_at` 时间戳，5 分钟后过期 |
| POST /api/worker/board | 完整看板 JSON（见 /api/board 的 board 形状） | 全量替换看板快照 |
| POST /api/worker/catalog | 完整目录 JSON | 全量替换目录快照 |
| POST /api/worker/watch-links | `{links:[{tmdb_id, title, links:[{slot, url, code?}]}]}` | 全量同步来源链接（条数不限） |
| POST /api/worker/issues | `{issues:[{tmdb_id, title, issue_type, issue_text, updated_at_text?}]}` | 全量同步问题列表 |
| POST /api/worker/watch-scan-status | 任意子集字段 | 合并写入全局扫描状态（时钟与进度互不覆盖） |
| POST /api/worker/watch-show-scan-states | `{states:[{show_key?\|tmdb_id?\|title, ...任意进度/时钟字段}]}` | 按作品合并写入逐部扫描状态 |
| POST /api/worker/unclassified-scan-clock | `{last_scan_at_ms, next_scan_at_ms}` | 定时扫描轮次结束后回写时钟 |

搜索结果条目形状：`{tmdb_id, title, year, media_type:"tv"|"movie", overview, poster_url, vote_average, in_library?}`。
