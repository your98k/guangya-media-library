#!/usr/bin/env node
/**
 * index.mjs — 真实 worker 骨架主循环。
 *
 * 与示例 worker 的区别：这个 worker 真的去聚合站检索、验光鸭分享、
 * 按可配置的版本偏好选版，并在开启 GUANGYA_INGEST 且配置齐全时真转存。
 * 默认 dry-run：只检索验源出报告，不动网盘。
 *
 * 环境变量一览见 worker/real/README.md。这里只列主循环用到的：
 *   API_BASE            面板地址，默认 http://localhost:8080
 *   WORKER_TOKEN        面板 worker 令牌（必填，与面板一致）
 *   WORKER_POLL_SECONDS 请求队列轮询间隔秒数，默认 15
 *   WATCH_POLL_MINUTES  自主追更轮询间隔分钟数，默认 30，设 0 关闭
 * 两个循环并行：请求队列循环领取面板请求；自主追更轮询自己定时查
 * 已登记来源补缺集（watchpoll.mjs），日常自动化不依赖任何智能体。
 */

import * as panel from './panel.mjs';
import { handlers, refreshVersionSettings } from './tasks.mjs';
import { startWatchPoll } from './watchpoll.mjs';
import { tmdbConfigured } from './tmdb.mjs';
import { guangyaConfigured } from './guangya.mjs';
import { jiaofuConfigured, miniConfigured } from './sources.mjs';
import { drivembyConfigured, drivembyRefreshUrl } from './drivemby.mjs';
import { ConfigMissing, SourceUnavailable, ShareInvalid, NotImplemented } from './errors.mjs';

const POLL_MS = Math.max(2000, Number(process.env.WORKER_POLL_SECONDS || 15) * 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[real-worker]', ...a);

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (!stopping) log(`收到 ${sig}，处理完当前请求后退出…`);
    stopping = true;
  });
}

function failureNote(e) {
  if (e instanceof ConfigMissing) {
    return `缺少配置：${e.missing.join('、')}。请对照 worker/real/README.md 的环境变量表补齐后重新提交。`;
  }
  if (e instanceof SourceUnavailable) return `检索失败：${e.message}。请人工检查该站登录态/网络后重试。`;
  if (e instanceof ShareInvalid) return `分享不可用：${e.message}`;
  if (e instanceof NotImplemented) return e.message;
  return `处理失败：${e.message}`;
}

async function handleOne(req) {
  log(`处理 #${req.id} ${req.kind} ${req.payload?.title || req.payload?.query || ''}`);
  try {
    await panel.update(req.id, { status: 'processing', progress_percent: 5, progress_stage: '真实 worker 已领取' });
    const handler = handlers[req.kind];
    if (!handler) {
      await panel.update(req.id, { status: 'failed', result_note: `未知请求类型：${req.kind}` });
      return;
    }
    await handler(req);
  } catch (e) {
    log(`#${req.id} 失败：${e.message}`);
    await panel.update(req.id, { status: 'failed', progress_stage: '失败', result_note: failureNote(e) }).catch(() => {});
  }
}

async function main() {
  const { apiBase, hasToken } = panel.panelConfig();
  log('真实 worker 骨架启动');
  log(`面板：${apiBase}（WORKER_TOKEN ${hasToken ? '已设置' : '未设置！worker 接口会被面板拒绝'}）`);
  log(`TMDB 搜索：${tmdbConfigured() ? '开（TMDB_API_KEY 已配置）' : '关（未配置 TMDB_API_KEY，search 请求会如实失败）'}`);
  log(`聚合站检索：教父网 ${jiaofuConfigured() ? '开' : '关（未配置 JIAOFU_COOKIE）'}；迷你影视 ${miniConfigured() ? '开' : '关（未配置 MINI_COOKIE）'}`);
  log(`光鸭接口：${guangyaConfigured() ? '开（登录态已配置）' : '关（未配置 GUANGYA_COOKIE / GUANGYA_SESSION_FILE，验源与转存不可用）'}`);
  log(`真转存：${process.env.GUANGYA_INGEST === 'on' ? '开（GUANGYA_INGEST=on）' : '关（dry-run：只检索验源出报告，不动网盘）'}`);
  log(`版本偏好回退值：VERSION_POLICY=${String(process.env.VERSION_POLICY || '（未设置）').toLowerCase()}（仅面板从未保存过「选版设置」时作映射默认，面板保存后以面板为准）`);
  log(`Drivemby 联动：${drivembyConfigured() ? `开（${drivembyRefreshUrl()}）` : '关（未配置 DRIVEMBY_TOKEN）'}`);
  log(`请求轮询间隔：${POLL_MS / 1000}s`);

  const fmtSettings = ({ settings, source }) =>
    `选版设置：模式 ${settings.version_mode}；依据 ${settings.version_criteria.join(' > ')}；文件大小 ${settings.version_size_prefer === 'smaller' ? '越小越好' : '越大越好'}；来源 ${source === 'panel' ? '面板设置' : 'env 回退（VERSION_POLICY）'}`;
  log(fmtSettings(await refreshVersionSettings()));

  // 自主追更轮询与请求队列循环并行（WATCH_POLL_MINUTES 控制，默认 30 分钟）
  const stopWatchPoll = startWatchPoll({ isStopping: () => stopping });

  let lastSettingsLogKey = '';
  while (!stopping) {
    try {
      const vs = await refreshVersionSettings();
      const pending = await panel.getPending();
      if (pending.length) {
        const key = JSON.stringify(vs);
        if (key !== lastSettingsLogKey) {
          log(`本轮${fmtSettings(vs)}`);
          lastSettingsLogKey = key;
        }
      }
      for (const req of pending) {
        if (stopping) break;
        if (req.status !== 'pending') continue;
        await handleOne(req);
      }
    } catch (e) {
      log('轮询失败（稍后重试）：', e.message);
    }
    // 分段睡眠，方便 SIGTERM 及时生效
    for (let waited = 0; waited < POLL_MS && !stopping; waited += 500) await sleep(Math.min(500, POLL_MS - waited));
  }
  stopWatchPoll();
  log('已退出');
}

main().catch((e) => {
  console.error('[real-worker] 主循环异常退出：', e);
  process.exit(1);
});
