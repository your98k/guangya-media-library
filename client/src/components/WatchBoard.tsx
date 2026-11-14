import { useMemo, useState } from 'react';
import { api } from '../api';
import type { Board, BoardShow, Issue, PanelRequest, ShowScanState, WatchLinkGroup, WatchScanStatus } from '../types';
import { fmtTime } from '../util';
import { PosterImg, ProgressBar } from './common';

const INTERVALS: { v: string; label: string }[] = [
  { v: '', label: '官方窗口' },
  { v: '30', label: '30 分钟' },
  { v: '60', label: '1 小时' },
  { v: '120', label: '2 小时' },
  { v: '360', label: '6 小时' },
  { v: '1440', label: '每天' },
];

function sourceBadge(count: number): string | null {
  if (count === 2) return '双源';
  if (count >= 3) return `${count} 源`;
  return null;
}

function matchLinks(show: BoardShow, groups: WatchLinkGroup[]): WatchLinkGroup | undefined {
  return groups.find((g) =>
    (show.tmdb_id != null && g.tmdb_id === show.tmdb_id) || g.title === show.title);
}
function matchState(show: BoardShow, states: ShowScanState[]): ShowScanState | undefined {
  return states.find((s) =>
    s.show_key === show.key || (show.tmdb_id != null && s.tmdb_id === show.tmdb_id) || s.title === show.title);
}
function matchManualScan(show: BoardShow, requests: PanelRequest[]): PanelRequest | undefined {
  return requests.find((r) => r.kind === 'watchscan' && ['pending', 'processing'].includes(r.status)
    && ((r.payload.show_key as string) === show.key
      || (show.tmdb_id != null && r.payload.tmdb_id === show.tmdb_id)
      || r.payload.title === show.title));
}

function WatchCard({ show, links, state, manualScan, onChanged, flash }: {
  show: BoardShow;
  links: WatchLinkGroup | undefined;
  state: ShowScanState | undefined;
  manualScan: PanelRequest | undefined;
  onChanged: () => void;
  flash: (msg: string, ok: boolean) => void;
}) {
  const [linkMgr, setLinkMgr] = useState(false);
  const [op, setOp] = useState<'add' | 'replace' | 'delete'>('add');
  const [slot, setSlot] = useState('');
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [confirmStop, setConfirmStop] = useState(false);
  const linkCount = links?.links.length ?? 0;
  const badge = sourceBadge(linkCount);

  const busy = async (fn: () => Promise<unknown>, okMsg: string) => {
    try { await fn(); flash(okMsg, true); onChanged(); }
    catch (e) { flash(e instanceof Error ? e.message : '操作失败', false); }
  };

  const submitLinkOp = () => busy(async () => {
    await api.submitLink({
      op, title: show.title, tmdb_id: show.tmdb_id,
      slot: slot ? Number(slot) : undefined,
      url: op === 'delete' ? undefined : url.trim(),
      code: code.trim() || undefined,
    });
    setUrl(''); setCode(''); setLinkMgr(false);
  }, '链接操作已提交，等待后台处理');

  const progress = manualScan
    ? { percent: manualScan.progress_percent, stage: manualScan.progress_stage, label: '手动扫描中' }
    : state?.scan_active
      ? { percent: state.progress_percent, stage: state.progress_stage, label: '自动扫描中' }
      : null;

  return (
    <div className="card">
      <div className="card-head">
        <PosterImg url={show.poster_url} title={show.title} />
        <div className="grow">
          <div className="card-title">
            {show.title}
            {badge && <span className="badge">{badge}</span>}
          </div>
          <div className="meta">{show.year ?? ''} · {show.category}</div>
          <div className="have">{show.library_have}</div>
          {show.pending.length > 0 && (
            <div className="chips" style={{ marginTop: 4 }}>
              {show.pending.map((p) => <span className="chip" key={p}>待补 {p}</span>)}
            </div>
          )}
          {show.next_expected.map((n) => (
            <div className="next-line" key={n.episode}>下集 {n.episode} · {fmtTime(n.at)}</div>
          ))}
        </div>
      </div>
      <div className="meta">{show.cadence}</div>
      <div className="spec">{show.spec}</div>

      <details className="links">
        <summary>来源链接（{linkCount} 条）</summary>
        {linkCount === 0 && <div className="meta" style={{ padding: '4px 0' }}>链接信息待同步</div>}
        {links?.links.map((l) => (
          <div className="link-row" key={l.slot}>
            #{l.slot} <a href={l.url} target="_blank" rel="noreferrer">{l.url}</a>
            {l.code ? ` · 提取码 ${l.code}` : ''}
          </div>
        ))}
        <div style={{ marginTop: 6 }}>
          <button className="small" onClick={() => setLinkMgr(!linkMgr)}>链接管理</button>
        </div>
        {linkMgr && (
          <div className="inline-form">
            <div className="row">
              <select value={op} onChange={(e) => setOp(e.target.value as typeof op)}>
                <option value="add">新增来源</option>
                <option value="replace">替换来源</option>
                <option value="delete">删除来源</option>
              </select>
              <input style={{ width: 90 }} placeholder="槽位号" value={slot} onChange={(e) => setSlot(e.target.value)} />
            </div>
            {op !== 'delete' && (
              <>
                <input type="url" placeholder="https://www.guangyapan.com/s/<id>_<后缀>" value={url} onChange={(e) => setUrl(e.target.value)} />
                <input placeholder="提取码（可选）" value={code} onChange={(e) => setCode(e.target.value)} />
              </>
            )}
            <button className="primary small" onClick={submitLinkOp}>提交链接操作</button>
          </div>
        )}
      </details>

      <div className="scan-box">
        <div className="meta">
          追更扫描：上次 {fmtTime(state?.last_scan_at_ms)} · 下次 {fmtTime(state?.next_scan_at_ms)}
          {state && !state.enabled ? ' · 已暂停自动扫描' : ''}
        </div>
        {progress && <ProgressBar percent={progress.percent} stage={progress.stage} label={progress.label} />}
        <div className="row">
          <button className="small primary" onClick={() => busy(
            () => api.submitWatchscan({ show_key: show.key, tmdb_id: show.tmdb_id, title: show.title }),
            '已提交，马上扫描这部')}>立即扫描这部</button>
          <button className="small" onClick={() => busy(
            () => api.setShowScanControl({ show_key: show.key, tmdb_id: show.tmdb_id, title: show.title, enabled: !(state?.enabled ?? true) }),
            state?.enabled ? '已暂停这部的自动扫描' : '已恢复这部的自动扫描')}>
            {state?.enabled === false ? '恢复自动扫描' : '暂停自动扫描'}
          </button>
          <select
            value={state?.interval_minutes != null ? String(state.interval_minutes) : ''}
            onChange={(e) => busy(
              () => api.setShowScanControl({
                show_key: show.key, tmdb_id: show.tmdb_id, title: show.title,
                interval_minutes: e.target.value === '' ? null : Number(e.target.value),
              }), '扫描间隔已更新')}>
            {INTERVALS.map((i) => <option key={i.v} value={i.v}>{i.label}</option>)}
          </select>
        </div>
        <div className="row">
          {!confirmStop
            ? <button className="small danger" onClick={() => setConfirmStop(true)}>取消追更</button>
            : <>
                <span className="meta">确认取消追更？已入库文件不删。</span>
                <button className="small danger" onClick={() => busy(async () => {
                  await api.submitAdd({ stop_tracking: true, title: show.title, tmdb_id: show.tmdb_id });
                  setConfirmStop(false);
                }, '已提交取消追更')}>确认取消</button>
                <button className="small" onClick={() => setConfirmStop(false)}>再想想</button>
              </>}
        </div>
      </div>
    </div>
  );
}

export default function WatchBoard({ board, linkGroups, issues, states, scanStatus, requests, onChanged, flash, provideLink }: {
  board: Board | null;
  linkGroups: WatchLinkGroup[];
  issues: Issue[];
  states: ShowScanState[];
  scanStatus: WatchScanStatus;
  requests: PanelRequest[];
  onChanged: () => void;
  flash: (msg: string, ok: boolean) => void;
  provideLink: (title: string) => void;
}) {
  const shows = useMemo(() => board?.shows ?? [], [board]);
  return (
    <section className="panel">
      <h2>追更看板 {board && <span className="badge gray">共 {board.watch_total} 部 · {fmtTime(board.generated_at)} 更新</span>}</h2>
      <p className="hint">看板是后台同步的快照；每张卡可单独扫描、暂停与设置间隔。</p>

      {scanStatus.sweep_active && (
        <div className="sweep-bar">
          <ProgressBar
            percent={scanStatus.progress_percent ?? null}
            stage={scanStatus.progress_stage ?? null}
            label={`自动扫描中 · 已扫 ${scanStatus.shows_done ?? 0} / 共 ${scanStatus.shows_total ?? shows.length} 部`} />
        </div>
      )}

      {issues.map((i) => (
        <div className="issue-card" key={i.id}>
          <div className="t">⚠ {i.title ?? '未知作品'} · {i.issue_type === 'missing_episodes' ? '缺集' : i.issue_type === 'share_invalid' ? '分享失效' : '问题'}</div>
          <p>{i.issue_text}</p>
          <div className="row">
            <button className="small primary" onClick={async () => {
              try {
                await api.submitFix({ tmdb_id: i.tmdb_id, title: i.title, issue_type: i.issue_type, issue_text: i.issue_text });
                flash('已提交修复请求，等待后台处理', true); onChanged();
              } catch (e) { flash(e instanceof Error ? e.message : '提交失败', false); }
            }}>让系统修复</button>
            <button className="small" onClick={() => provideLink(i.title ?? '')}>我来提供链接</button>
          </div>
        </div>
      ))}

      <div className="grid">
        {shows.map((s) => (
          <WatchCard
            key={s.key}
            show={s}
            links={matchLinks(s, linkGroups)}
            state={matchState(s, states)}
            manualScan={matchManualScan(s, requests)}
            onChanged={onChanged}
            flash={flash}
          />
        ))}
      </div>
      {shows.length === 0 && <p className="hint">暂无追更数据（等待后台同步看板快照）。</p>}
    </section>
  );
}
