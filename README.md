# 光鸭影视库 guangya-media-library

> **English summary:** A self-hosted web panel for managing a Guangya (光鸭云盘) media library: a watch board for tracked shows, a full-library poster catalog, an unclassified-folder auto-scan panel, TMDB search & share-link submission, and a request queue. The panel stores state in local SQLite; the actual cloud-drive automation lives in an external "worker" that talks to a token-protected API (an example worker is included). Unofficial third-party project, not affiliated with Guangya. Demo seed data is entirely fictional.

一个自托管的影视库管理面板，配合外部自动化（worker）管理光鸭云盘里的影视库：

- **追更看板**：每部在追的作品一张卡——海报、库内进度、待补集数、下集时间、来源链接（条数不限，2 条显示「双源」、≥3 条显示「N 源」）、链接管理、逐部独立的扫描控制（立即扫描这部 / 暂停恢复 / 自定义间隔 / 实时进度条）、取消追更；顶部有全局扫描进度条；缺集、分享失效等问题卡带「让系统修复 / 我来提供链接」。
- **全量目录**：整个影视库的海报墙（电影 / 剧集 / 动漫分组），分批加载、海报懒加载、片名筛选、总量统计，一键提交目录刷新。
- **未分类影视面板**：自动整理扫描的开关、自定义间隔（15 分钟–7 天）、上次/下次扫描时间、手动扫描与实时进度。
- **搜索 / 添加**：TMDB 按片名或 ID 搜索（结果 5 分钟内有效，勾选提交后定稿）；光鸭分享链接提交（**链接格式会被严格校验，不完整的链接当场报错，不会静默失败**）。
- **我的请求**：全部请求与状态、进度、结果说明；可取消、删除、一键清理已结束记录；失败记录可一键转「提供链接」。

面板本身只负责**管理与展示**，不直接操作网盘：查分享、转存、改名、枚举目录等真实自动化由外部 **worker** 通过带令牌的接口对接（见下方「Worker 接口」）。仓库自带一个示例 worker 演示这个接缝。

## 快速开始（Docker）

```bash
git clone <your-fork-url> guangya-media-library
cd guangya-media-library
cp .env.example .env   # 改掉 WORKER_TOKEN
docker compose up -d
```

打开 http://localhost:8080 即可。首次启动会自动写入一套**虚构的示例数据**（示例剧目、示例链接、本地 SVG 示例海报），方便先看界面长什么样；接入自己的 worker 推送真实快照后即被替换。

可选：让示例 worker 跑起来（在宿主机上）：

```bash
WORKER_TOKEN=与.env一致 API_BASE=http://localhost:8080 npm run worker
```

## 本地开发

```bash
npm run install:all   # 安装 server 与 client 依赖
npm run dev           # server(:8080, node --watch) + client(:5173, vite, /api 已代理)
npm run build         # 构建前端到 client/dist（生产环境由 server 直接托管）
npm start             # 生产方式启动（需先 build）
```

## Worker 接口

自动化与面板之间只有一层 REST 接口（完整文档见 [docs/API.md](docs/API.md)）：

- worker 轮询 `GET /api/worker/requests/pending` 领取请求，用 `POST /api/worker/requests/:id` 回写进度与结果；
- worker 把追更看板、全量目录、来源链接、问题列表、扫描时钟以快照/合并方式推回面板（`/api/worker/board`、`/api/worker/catalog`、`/api/worker/watch-links` 等）；
- 全部 worker 接口需要请求头 `Authorization: Bearer <WORKER_TOKEN>`。

`worker/example-worker.mjs` 是一个零依赖示例：搜索请求在配置 `TMDB_API_KEY` 时走真实 TMDB，否则返回明确标注的演示结果；其余请求模拟完成并在结果说明里写清真实实现应做什么。**真正的光鸭自动化就接在这个位置**：领取请求 → 操作网盘 → 回写结果与快照。

## 数据与隐私

- 本项目**不包含任何真实分享链接、账号、令牌或个人数据**；仓库里的演示内容全部为虚构示例。
- 运行数据全部保存在本地 `data/app.db`（SQLite），不上传任何服务器。
- UI 接口默认无鉴权：请勿把面板直接暴露到公网，建议放在内网或反向代理（含鉴权）之后。

## 项目结构

```
client/            React + Vite + TypeScript 前端（追更看板/目录/未分类/搜索/我的请求）
server/            Express + better-sqlite3 后端（UI 接口 + Worker 接口 + SQLite）
worker/            示例 worker（零依赖 Node 脚本）
docs/API.md        全部接口文档
Dockerfile         多阶段构建（构建前端 → node:20-slim 运行）
docker-compose.yml 单服务编排（./data 持久化卷）
```

## 与光鸭的关系

本项目是**非官方的第三方开源项目**，与光鸭云盘官方无关；「光鸭」名称仅用于说明用途。项目只提供管理面板与接口，不包含任何网盘账号功能本身，使用者需自行实现/接入自己有权使用的自动化。

## License

MIT
