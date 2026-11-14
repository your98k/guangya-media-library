import { useState } from 'react';
import { api } from '../api';
import type { PanelRequest, UnclassifiedSchedule } from '../types';
import { fmtTime } from '../util';
import { ProgressBar } from './common';

export default function UnclassifiedPanel({ schedule, requests, onChanged, flash }: {
  schedule: UnclassifiedSchedule | null;
  requests: PanelRequest[];
  onChanged: () => void;
  flash: (msg: string, ok: boolean) => void;
}) {
  const [interval, setInterval] = useState('');
  const active = requests.find((r) => r.kind === 'scan' && ['pending', 'processing'].includes(r.status));
  const latest = requests.find((r) => r.kind === 'scan');

  const save = async (body: Record<string, unknown>, msg: string) => {
    try { await api.setUnclassifiedSchedule(body); flash(msg, true); onChanged(); }
    catch (e) { flash(e instanceof Error ? e.message : '保存失败', false); }
  };

  return (
    <section className="panel">
      <h2>未分类影视 · 自动整理</h2>
      <p className="hint">
        状态：{schedule?.enabled ? '自动扫描开启' : '自动扫描已暂停'}
        {schedule && <> · 间隔 {schedule.interval_minutes} 分钟 · 上次 {fmtTime(schedule.last_scan_at)} · 下次 {schedule.enabled ? fmtTime(schedule.next_scan_at) : '—（暂停中）'}</>}
        {latest && !active && <> · 最近一轮：{latest.status}{latest.found_count != null ? `（发现 ${latest.found_count} / 整理 ${latest.organized_count ?? 0} / 被抢先 ${latest.taken_count ?? 0}）` : ''}</>}
      </p>
      {active && (
        <div style={{ marginBottom: 10 }}>
          <ProgressBar
            percent={active.progress_percent}
            stage={active.progress_stage}
            label={active.trigger === 'scheduled' ? '自动扫描中' : '手动扫描中'} />
        </div>
      )}
      <div className="form-grid">
        <button className="primary" onClick={async () => {
          try { await api.submitScan('manual'); flash('已提交扫描，等待后台处理', true); onChanged(); }
          catch (e) { flash(e instanceof Error ? e.message : '提交失败', false); }
        }}>扫描未分类影视</button>
        <button onClick={() => save({ enabled: !(schedule?.enabled ?? true) }, schedule?.enabled ? '已暂停自动扫描' : '已恢复自动扫描')}>
          {schedule?.enabled ? '暂停自动扫描' : '恢复自动扫描'}
        </button>
        <input
          style={{ width: 130 }} type="number" min={15} max={10080}
          placeholder={schedule ? String(schedule.interval_minutes) : '间隔（分钟）'}
          value={interval} onChange={(e) => setInterval(e.target.value)} />
        <button onClick={() => interval && save({ interval_minutes: Number(interval) }, '扫描间隔已更新')}>设置间隔</button>
        <span className="meta">间隔范围 15 分钟 – 7 天</span>
      </div>
    </section>
  );
}
