/**
 * guangya.mjs — 光鸭云盘 Web API 客户端（骨架版原创实现，零依赖）。
 *
 * 接口事实（端点/参数/响应形状）来自对光鸭 Web API 的公开观察：
 * - 基础地址 https://api.guangyapan.com，全部 POST + JSON；
 * - 响应信封 {code, msg, data}：code 为 0/缺省表示成功；110/117/118 表示登录态失效；
 * - 分享访问先用 /userres/v1/get_share_access_token {shareId, code} 换 accessToken，
 *   分享类业务码：200/201/202 = 分享已失效，203/209 = 提取码错误；
 * - 分享文件列表 /userres/v1/get_share_page_files_list {accessToken, cursor, pageSize,
 *   orderBy, sortType, parentId?}，data.list 项为 {fileId, fileName, fileSize, resType}
 *   （resType=2 为文件夹），靠 data.hasMore + data.cursor 游标翻页；
 * - 自有文件列表 /userres/v1/file/get_file_list {parentId, page, pageSize, ...}，
 *   靠 data.hasMore / data.total 页码翻页；
 * - 转存 /userres/v1/restore_share {accessToken, fileIds, parentId, shareCode}，
 *   code 204 = 不能转存自己创建的分享；
 * - 改名 /userres/v1/file/rename {fileId, newName}；
 *   移动 /userres/v1/file/move_file {fileIds, parentId}。
 *
 * 登录态（二选一，由部署者提供，本仓库不含任何真实凭证）：
 * - GUANGYA_COOKIE：浏览器登录光鸭网页版后的 Cookie 请求头原文，
 *   以 Cookie 头随请求发送（服务端是否接受 Cookie 鉴权取决于其当前策略，
 *   不被接受时请改用下面的会话文件方式）；
 * - GUANGYA_SESSION_FILE：指向一个 JSON 文件，形如 {"accessToken": "..."}
 *   （也接受 access_token / token 字段，或 {"cookie": "..."}），
 *   accessToken 以 Authorization: Bearer 发送（与官方客户端一致）。
 * 两者都没配置时，所有方法抛 ConfigMissing。
 */

import { readFile } from 'node:fs/promises';
import { ConfigMissing, GuangyaError, ShareInvalid } from './errors.mjs';

const API_BASE = 'https://api.guangyapan.com';
const AUTH_EXPIRED_CODES = new Set([110, 117, 118]);
const SHARE_INVALID_CODES = new Set([200, 201, 202]);
const SHARE_CODE_CODES = new Set([203, 209]);
const MAX_WALK_ITEMS = 5000;
const MAX_WALK_DEPTH = 12;

let sessionCache = null;

export function guangyaConfigured() {
  return Boolean(process.env.GUANGYA_COOKIE || process.env.GUANGYA_SESSION_FILE);
}

async function loadSession() {
  if (sessionCache) return sessionCache;
  const cookie = process.env.GUANGYA_COOKIE || '';
  if (cookie) {
    sessionCache = { cookie };
    return sessionCache;
  }
  const file = process.env.GUANGYA_SESSION_FILE || '';
  if (file) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'));
    } catch (e) {
      throw new GuangyaError(`读取 GUANGYA_SESSION_FILE 失败：${e.message}`);
    }
    const token = parsed.accessToken || parsed.access_token || parsed.token || '';
    if (token) sessionCache = { accessToken: token };
    else if (parsed.cookie) sessionCache = { cookie: String(parsed.cookie) };
    else throw new GuangyaError('GUANGYA_SESSION_FILE 里没有 accessToken 或 cookie 字段');
    return sessionCache;
  }
  throw new ConfigMissing('GUANGYA_COOKIE', 'GUANGYA_SESSION_FILE');
}

async function post(path, body, { shareEndpoint = false } = {}) {
  const session = await loadSession();
  const headers = { 'Content-Type': 'application/json', dt: '13' };
  if (session.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;
  if (session.cookie) headers.Cookie = session.cookie;
  let r;
  try {
    r = await fetch(`${API_BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  } catch (e) {
    throw new GuangyaError(`光鸭接口网络错误（${path}）：${e.message}`);
  }
  const envelope = await r.json().catch(() => null);
  if (!envelope || typeof envelope !== 'object') {
    throw new GuangyaError(`光鸭接口响应不是合法 JSON（${path}，HTTP ${r.status}）`);
  }
  const code = Number(envelope.code ?? 0);
  if (shareEndpoint) {
    if (SHARE_INVALID_CODES.has(code)) throw new ShareInvalid(envelope.msg || '分享已失效', code);
    if (SHARE_CODE_CODES.has(code)) throw new ShareInvalid(envelope.msg || '提取码错误', code);
  }
  if (r.status === 401 || AUTH_EXPIRED_CODES.has(code)) {
    throw new GuangyaError('光鸭登录态已失效，请重新准备 GUANGYA_COOKIE / GUANGYA_SESSION_FILE', code);
  }
  if (code !== 0) throw new GuangyaError(envelope.msg || `光鸭接口错误（${path}，code=${code}）`, code);
  return envelope.data ?? {};
}

/** 解析分享链接：/s/<shareId> 段、?code= 提取码、?shareCode= 转存用码。 */
export function parseShareRef(shareUrl, explicitCode) {
  const url = new URL(shareUrl);
  const parts = url.pathname.split('/').filter(Boolean);
  const idx = parts.indexOf('s');
  const shareId = idx >= 0 ? parts[idx + 1] : '';
  if (!shareId) throw new GuangyaError(`无法从链接解析分享 ID：${shareUrl}`);
  return {
    shareId,
    code: explicitCode || url.searchParams.get('code') || undefined,
    shareCode: url.searchParams.get('shareCode') || '',
  };
}

async function getShareAccessToken(ref) {
  const data = await post('/userres/v1/get_share_access_token', {
    shareId: ref.shareId,
    code: ref.code,
  }, { shareEndpoint: true });
  if (!data.accessToken) throw new ShareInvalid('分享访问令牌为空，分享可能已失效');
  return data.accessToken;
}

async function listShareChildren(accessToken, parentId) {
  const items = [];
  let cursor = 0;
  const seen = new Set();
  while (true) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const body = { accessToken, cursor, pageSize: 100, orderBy: 0, sortType: 0 };
    if (parentId) body.parentId = parentId;
    const data = await post('/userres/v1/get_share_page_files_list', body);
    for (const it of data.list || []) items.push(it);
    if (!data.hasMore) break;
    cursor = data.cursor;
  }
  return items;
}

/**
 * 递归展开一个分享，返回扁平文件清单 [{id, name, size, path}]。
 * path 为分享内的相对路径（含文件名），如 "Season 1/11.mkv"。
 * 分享失效/提取码错误抛 ShareInvalid；未配置登录态抛 ConfigMissing。
 */
export async function walkShare(shareUrl, code) {
  const ref = parseShareRef(shareUrl, code);
  const accessToken = await getShareAccessToken(ref);
  const out = [];
  async function walk(parentId, parentPath, depth) {
    if (depth > MAX_WALK_DEPTH) throw new GuangyaError('分享目录层级过深，已停止展开');
    const items = await listShareChildren(accessToken, parentId);
    for (const it of items) {
      if (out.length >= MAX_WALK_ITEMS) throw new GuangyaError(`分享文件数超过上限 ${MAX_WALK_ITEMS}，已停止展开`);
      const path = parentPath ? `${parentPath}/${it.fileName}` : it.fileName;
      if (Number(it.resType) === 2) {
        await walk(it.fileId, path, depth + 1);
      } else {
        out.push({ id: it.fileId, name: it.fileName, size: Number(it.fileSize) || 0, path });
      }
    }
  }
  await walk(null, '', 0);
  return out;
}

/** 列出自有文件夹的直接子项：[{id, name, size, isDir, parentId}]（自动翻页）。 */
export async function listFolder(folderId) {
  const out = [];
  let page = 0;
  const pageSize = 100;
  while (true) {
    const data = await post('/userres/v1/file/get_file_list', {
      parentId: folderId,
      page,
      pageSize,
      dirType: 0,
      orderBy: 0,
      sortType: 0,
      fileTypes: [],
      resType: 0,
      needPlayRecord: false,
      needSubFolderStat: true,
    });
    const list = data.list || [];
    for (const it of list) {
      out.push({
        id: it.fileId,
        name: it.fileName,
        size: Number(it.fileSize) || 0,
        isDir: Number(it.resType) === 2,
        parentId: it.parentId ?? folderId,
      });
    }
    const hasMore = typeof data.hasMore === 'boolean'
      ? data.hasMore
      : Number.isFinite(Number(data.total)) && (page + 1) * pageSize < Number(data.total);
    if (!hasMore || list.length === 0) break;
    page++;
  }
  return out;
}

/**
 * 把分享中的指定文件转存到目标文件夹（restore_share）。
 * 注意：转存是异步落地的，转存后目标文件夹里出现同名文件可能有几十秒延迟，
 * 调用方按名匹配改名前应留出等待/复查。
 */
export async function saveShareFiles(shareUrl, targetParentId, fileIds, code) {
  const ref = parseShareRef(shareUrl, code);
  const accessToken = await getShareAccessToken(ref);
  const session = await loadSession();
  const headers = { 'Content-Type': 'application/json', dt: '13' };
  if (session.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;
  if (session.cookie) headers.Cookie = session.cookie;
  const r = await fetch(`${API_BASE}/userres/v1/restore_share`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ accessToken, fileIds, parentId: targetParentId, shareCode: ref.shareCode }),
  });
  const envelope = await r.json().catch(() => null);
  const codeNum = Number(envelope?.code ?? 0);
  if (codeNum === 204) throw new GuangyaError('不能转存当前账号自己创建的分享', 204);
  if (r.status === 401 || AUTH_EXPIRED_CODES.has(codeNum)) {
    throw new GuangyaError('光鸭登录态已失效，请重新准备会话', codeNum);
  }
  if (codeNum !== 0) throw new GuangyaError(envelope?.msg || `转存失败（code=${codeNum}）`, codeNum);
  return envelope.data ?? {};
}

/** 改名：POST /userres/v1/file/rename {fileId, newName} */
export async function renameFile(id, newName) {
  return post('/userres/v1/file/rename', { fileId: id, newName });
}

/** 移动：POST /userres/v1/file/move_file {fileIds:[id], parentId} */
export async function moveFile(id, targetParentId) {
  return post('/userres/v1/file/move_file', { fileIds: [id], parentId: targetParentId });
}
