/**
 * sources.mjs — 聚合站检索适配器（教父网 / 迷你影视）。
 *
 * 职责：在聚合站按片名搜索，只收集两类结果：光鸭分享链接与磁力链接
 * （其他网盘链接一律丢弃——这是成文规矩：只存能进光鸭的）。
 *
 * 诚实边界（重要）：
 * - 两个站的搜索地址没有离线核实过，下面的 URL 模板是**待调整常量**，
 *   部署者按站点实际搜索页地址修改（搜一次站内搜索、看浏览器地址栏即可）。
 * - 站点 HTML 结构会变：所有提取逻辑都收拢在 extractCandidates /
 *   extractDetailLinks 两个小函数里，改版时只改这里。
 * - 需要登录态：JIAOFU_COOKIE / MINI_COOKIE（浏览器登录后复制的 Cookie 头）。
 *   没配 Cookie 时对应站点直接跳过（返回 []，只提示一次），不发请求。
 * - 出现登录墙 / 验证码 / 403 时抛 SourceUnavailable，如实上报，绝不硬闯。
 */

import { SourceUnavailable } from './errors.mjs';
import { isGuangyaShareUrl } from './rules.mjs';

/* ================= 待调整常量：搜索地址模板 =================
 * {q} 会被替换成 encodeURIComponent(片名)。
 * 教父网（xn--wcv59z.com 是「教父网」域名的 punycode 形式）与迷你影视
 * 的实际搜索路径请部署者自行核对后修改这两行。 */
export const JIAOFU_SEARCH_URL = 'https://www.xn--wcv59z.com/search/{q}';
export const MINI_SEARCH_URL = 'https://miniyingshi.com/search?q={q}';

const SOURCE_DELAY_MS = Math.max(0, Number(process.env.SOURCE_DELAY_MS || 1500));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const WALL_MARKERS = ['请先登录', '登录后查看', '人机验证', '滑动验证', '输入验证码', 'captcha', '安全验证', '访问过于频繁'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastFetchAt = new Map();
const loggedMissingCookie = new Set();

export function jiaofuConfigured() { return Boolean(process.env.JIAOFU_COOKIE); }
export function miniConfigured() { return Boolean(process.env.MINI_COOKIE); }

async function politeFetch(siteKey, url, cookie) {
  const last = lastFetchAt.get(siteKey) || 0;
  const wait = SOURCE_DELAY_MS - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  lastFetchAt.set(siteKey, Date.now());
  let r;
  try {
    r = await fetch(url, {
      headers: { Cookie: cookie, 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      redirect: 'follow',
    });
  } catch (e) {
    throw new SourceUnavailable(siteKey, `网络请求失败：${e.message}`);
  }
  if (r.status === 401 || r.status === 403) {
    throw new SourceUnavailable(siteKey, `返回 HTTP ${r.status}，多半是登录态失效或被风控，请重新准备 Cookie`);
  }
  if (!r.ok) throw new SourceUnavailable(siteKey, `返回 HTTP ${r.status}`);
  const html = await r.text();
  if (/\/login|signin/i.test(r.url) && /password/i.test(html)) {
    throw new SourceUnavailable(siteKey, '被重定向到登录页，Cookie 已失效');
  }
  for (const marker of WALL_MARKERS) {
    if (html.includes(marker)) throw new SourceUnavailable(siteKey, `页面出现「${marker}」，疑似登录墙/验证码，需要人工处理`);
  }
  return html;
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;|&amp;/g, ' ').trim();
}

/* ============ 提取器（站点改版时只改这里） ============ */

/** 从任意 HTML 里提取光鸭分享链接与磁力链接（锚点 + 纯文本两种出现形式）。 */
export function extractCandidates(html, site) {
  const found = new Map();
  const add = (url, kind, note) => {
    if (!found.has(url)) found.set(url, { site, title: note || '', url, kind, note: note || '' });
  };
  const anchorRe = /<a[^>]+href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html))) {
    const href = m[1].replace(/&amp;/g, '&');
    const text = stripTags(m[2]).slice(0, 120);
    if (href.startsWith('magnet:')) add(href, 'magnet', text);
    else if (isGuangyaShareUrl(href)) add(href, 'guangyapan', text);
  }
  const textRe = /https:\/\/www\.guangyapan\.com\/s\/[A-Za-z0-9]+_[A-Za-z0-9_-]+|magnet:\?xt=urn:btih:[A-Za-z0-9]+[^"<\s]*/g;
  for (const raw of html.match(textRe) || []) {
    if (raw.startsWith('magnet:')) add(raw, 'magnet', '');
    else if (isGuangyaShareUrl(raw)) add(raw, 'guangyapan', '');
  }
  return [...found.values()];
}

/** 从搜索结果 HTML 里挑同站详情页链接（标题相关的前若干条），供第二跳提取。 */
export function extractDetailLinks(html, baseUrl, titleHint, limit = 5) {
  const out = [];
  const seen = new Set();
  const anchorRe = /<a[^>]+href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  const hint = String(titleHint || '').slice(0, 4);
  while ((m = anchorRe.exec(html)) && out.length < limit) {
    let u;
    try { u = new URL(m[1], baseUrl); } catch { continue; }
    if (u.origin !== new URL(baseUrl).origin) continue;
    if (/\/(search|login|register|user|tag|category)/i.test(u.pathname)) continue;
    if (u.pathname.length < 4) continue;
    const text = stripTags(m[2]);
    if (hint && text && !text.includes(hint)) continue;
    const key = u.href;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/* ============ 站点搜索 ============ */

async function doSearch(siteKey, siteLabel, template, cookieEnv, title) {
  const cookie = process.env[cookieEnv] || '';
  if (!cookie) {
    if (!loggedMissingCookie.has(siteKey)) {
      loggedMissingCookie.add(siteKey);
      console.log(`[sources] ${siteLabel}未配置 ${cookieEnv}，跳过该站检索`);
    }
    return [];
  }
  const searchUrl = template.replace('{q}', encodeURIComponent(title));
  const html = await politeFetch(siteLabel, searchUrl, cookie);
  let candidates = extractCandidates(html, siteLabel);
  if (!candidates.length) {
    // 搜索页没直接给链接时，第二跳进详情页找（最多 5 页，带礼貌延迟）。
    const details = extractDetailLinks(html, searchUrl, title);
    for (const detailUrl of details) {
      const detailHtml = await politeFetch(siteLabel, detailUrl, cookie);
      candidates = candidates.concat(extractCandidates(detailHtml, siteLabel));
    }
  }
  const seen = new Set();
  return candidates.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
}

/** 教父网检索：返回 [{site, title, url, kind:'guangyapan'|'magnet', note}] */
export async function searchJiaofu(title) {
  return doSearch('jiaofu', '教父网', JIAOFU_SEARCH_URL, 'JIAOFU_COOKIE', title);
}

/** 迷你影视检索：返回同上形状。 */
export async function searchMiniys(title) {
  return doSearch('mini', '迷你影视', MINI_SEARCH_URL, 'MINI_COOKIE', title);
}

/**
 * 两站一起搜，逐站归纳状态，供任务层拼失败/成功说明：
 * { candidates, report: [{site, status:'ok'|'unconfigured'|'unavailable', reason?}] }
 */
export async function searchAll(title) {
  const report = [];
  const all = [];
  const jobs = [
    { label: '教父网', configured: jiaofuConfigured(), env: 'JIAOFU_COOKIE', fn: searchJiaofu },
    { label: '迷你影视', configured: miniConfigured(), env: 'MINI_COOKIE', fn: searchMiniys },
  ];
  for (const job of jobs) {
    if (!job.configured) {
      report.push({ site: job.label, status: 'unconfigured', reason: `未配置 ${job.env}` });
      continue;
    }
    try {
      const cands = await job.fn(title);
      all.push(...cands);
      report.push({ site: job.label, status: 'ok', count: cands.length });
    } catch (e) {
      if (e instanceof SourceUnavailable) report.push({ site: job.label, status: 'unavailable', reason: e.reason });
      else report.push({ site: job.label, status: 'unavailable', reason: e.message });
    }
  }
  const seen = new Set();
  const candidates = all.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
  return { candidates, report };
}
