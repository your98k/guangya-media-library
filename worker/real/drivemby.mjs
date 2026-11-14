/**
 * drivemby.mjs — Drivemby 联动：入库后通知 Drivemby 刷新对应目录，
 * 让播放端（海报墙/Emby 兼容接口）尽快看到新文件。
 *
 * 接口：POST <DRIVEMBY_REFRESH_URL>，请求头 Authorization: Bearer <DRIVEMBY_TOKEN>，
 * 请求体 {"path": "/影视/动漫/<作品夹>/Season 1"}（光鸭内的完整目录路径）。
 * HTTP 200 视为成功。默认地址 https://drivemby.com/api/hooks/refresh。
 *
 * 约定（与现行运维规则一致）：
 * - 未配置 DRIVEMBY_TOKEN 时整个联动关闭，refreshDir 直接跳过；
 * - 刷新失败不算入库失败：本函数永不抛错，只返回 {ok:false, reason}，
 *   由调用方记日志并在 result_note 末尾附一句。
 */

const DEFAULT_REFRESH_URL = 'https://drivemby.com/api/hooks/refresh';

export function drivembyConfigured() {
  return Boolean(process.env.DRIVEMBY_TOKEN);
}

export function drivembyRefreshUrl() {
  return process.env.DRIVEMBY_REFRESH_URL || DEFAULT_REFRESH_URL;
}

/**
 * 刷新一个目录。返回 {ok:true} | {ok:false, skipped:true, reason} | {ok:false, reason}。
 */
export async function refreshDir(path) {
  const token = process.env.DRIVEMBY_TOKEN || '';
  if (!token) return { ok: false, skipped: true, reason: '未配置 DRIVEMBY_TOKEN，Drivemby 联动关闭' };
  if (!path) return { ok: false, reason: '目录路径为空' };
  try {
    const r = await fetch(drivembyRefreshUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ path }),
    });
    const text = await r.text().catch(() => '');
    if (r.status === 200) return { ok: true };
    return { ok: false, reason: `HTTP ${r.status}${text ? `：${text.slice(0, 120)}` : ''}` };
  } catch (e) {
    return { ok: false, reason: `网络错误：${e.message}` };
  }
}
