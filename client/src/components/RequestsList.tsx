import { useState } from 'react';
import { api } from '../api';
import type { PanelRequest } from '../types';
import { fmtTime } from '../util';
import { ProgressBar } from './common';

const KIND_LABEL: Record<string, string> = {
  search: '搜索', add: '添加', fix: '修复', scan: '未分类扫描',
  watchscan: '单剧扫描', link: '链接操作', catalog_refresh: '目录刷新',
};
const STATUS_LABEL: Record<string, string> = {
  pending: '等待中', processing: '处理中', done: '已完成',
  failed: '失败', cancelled: '已取消', expired: '已过期',
};
const FINISHED = ['done', 'failed', 'cancelled', 'expired'];

export function requestTitle(r: PanelRequest): string {
  const p = r.payload;
  switch (r.kind) {
    case 'search': return `搜索「${String(p.query ?? '')}」`;
    case 'add':
      if (p.stop_tracking) return `取消追更《${String(p.title ?? '')}》`;
      return p.source === 'link' ? `链接添加 ${String(p.url ?? '')}` : `添加《${String(p.title ?? '')}》`;
    case 'fix': return `修复《${String(p.title ?? '')}》· ${String(p.issue_type ?? '')}`;
    case 'scan': return `未分类扫描（${r.trigger === 'scheduled' ? '定时' : '手动'}）`;
    case 'watchscan': return `扫描《${String(p.title ?? '')}》`;
    case 'link': return `链接${p.op === 'add' ? '新增' : p.op === 'replace' ? '替换' : '删除'}《${String(p.title ?? '')}》`;
    case 'catalog_refresh': return '刷新全量目录';
    default: return r.kind;
  }
}

export default function RequestsList({ requests, onChanged, flash, provideLink }: {
  requests: PanelRequest[];
  onChanged: () => void;
  flash: (msg: string, ok: boolean) => void;
  provideLink: (title: string) => void;
}) {
  const [confirmDel, setConfirmDel] = useState<number | null>(null);

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); flash(msg, true); onChanged(); }
    catch (e) { flash(e instanceof Error ? e.message : '操作失败', false); }
  };

  return (
    <section className="panel">
      <h2>
        我的请求
        <span className="grow" />
        <button className="small" onClick={() => act(() => api.cleanupFinished(), '已清理结束记录')}>清理已结束记录</button>
      </h2>
      {requests.length === 0 && <p className="hint">暂无请求记录。</p>}
      {requests.map((r) => (
        <div className="req" key={r.id}>
          <div className="req-head">
            <span className="badge gray">{KIND_LABEL[r.kind] ?? r.kind}</span>
            <span className="req-title">{requestTitle(r)}</span>
            <span className={`status ${r.status}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
            <span className="meta">{fmtTime(r.created_at)}</span>
            <span className="grow" />
            {['pending', 'processing'].includes(r.status) && (
              <button className="small" onClick={() => act(() => api.cancelRequest(r.id), '已取消')}>取消</button>
            )}
            {FINISHED.includes(r.status) && (confirmDel === r.id
              ? <>
                  <button className="small danger" onClick={() => act(async () => { await api.deleteRequest(r.id); setConfirmDel(null); }, '已删除')}>确认删除</button>
                  <button className="small" onClick={() => setConfirmDel(null)}>算了</button>
                </>
              : <button className="small" onClick={() => setConfirmDel(r.id)}>删除</button>)}
            {r.status === 'failed' && (r.kind === 'fix' || r.kind === 'add') && (
              <button className="small primary" onClick={() => provideLink(String(r.payload.title ?? ''))}>提供链接</button>
            )}
          </div>
          {r.status === 'processing' && (
            <div style={{ marginTop: 6 }}>
              <ProgressBar percent={r.progress_percent} stage={r.progress_stage} label="处理中" />
            </div>
          )}
          {r.kind === 'scan' && r.found_count != null && (
            <div className="note">发现 {r.found_count} · 整理 {r.organized_count ?? 0} · 被抢先 {r.taken_count ?? 0}</div>
          )}
          {r.result_note && <div className="note">{r.result_note}</div>}
        </div>
      ))}
    </section>
  );
}
