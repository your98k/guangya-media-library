import { useMemo, useState } from 'react';
import { api } from '../api';
import type { Catalog, PanelRequest } from '../types';
import { fmtBytes, fmtTime, sizedPoster } from '../util';

const PAGE = 24;

export default function CatalogSection({ catalog, latestRefresh, onChanged, flash }: {
  catalog: Catalog | null;
  latestRefresh: PanelRequest | null;
  onChanged: () => void;
  flash: (msg: string, ok: boolean) => void;
}) {
  const [filter, setFilter] = useState('');
  const [visible, setVisible] = useState<Record<string, number>>({});

  const categories = useMemo(() => {
    if (!catalog) return [];
    return Object.entries(catalog.categories).map(([name, entries]) => ({
      name,
      entries: entries.filter((e) => !filter || e.title.includes(filter)),
      total: entries.length,
    }));
  }, [catalog, filter]);

  const refresh = async () => {
    try {
      const r = await api.submitCatalogRefresh();
      flash(r.already_open ? '已有一次目录刷新在进行中' : '已提交目录刷新，等待后台处理', true);
      onChanged();
    } catch (e) { flash(e instanceof Error ? e.message : '提交失败', false); }
  };

  return (
    <section className="panel">
      <h2>
        全量目录
        {catalog && <span className="badge gray">{catalog.totals.titles} 部 · {catalog.totals.episodes} 集 · {fmtBytes(catalog.totals.size_bytes)}</span>}
        <span className="grow" />
        <button className="small" onClick={refresh}>刷新目录</button>
      </h2>
      <p className="hint">
        目录快照时间：{catalog ? fmtTime(catalog.generated_at) : '—'}
        {latestRefresh && <> · 最近刷新：{latestRefresh.status}{latestRefresh.result_note ? `（${latestRefresh.result_note}）` : ''} · {fmtTime(latestRefresh.updated_at)}</>}
      </p>
      <div className="form-grid" style={{ marginBottom: 6 }}>
        <input type="text" placeholder="按片名筛选…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {!catalog && <p className="hint">暂无目录快照（等待后台推送）。</p>}
      {categories.map(({ name, entries, total }) => {
        const n = visible[name] ?? PAGE;
        return (
          <div key={name}>
            <h3 className="cat-title">{name}（{filter ? `${entries.length}/` : ''}{total}）</h3>
            <div className="catalog-grid">
              {entries.slice(0, n).map((e) => {
                const poster = e.poster_url || (e.tmdb_id != null ? catalog?.posters[String(e.tmdb_id)] : '') || '';
                return (
                  <div className="cat-item" key={e.folder_name}>
                    {poster
                      ? <img src={sizedPoster(poster, 'w185')} alt={e.title} loading="lazy" decoding="async" />
                      : <div className="ph">{e.title}</div>}
                    <div className="n">{e.title}</div>
                    <div className="m">{e.year ?? ''}{e.seasons ? ` · ${e.seasons} 季` : ''} · {e.episodes} 集 · {fmtBytes(e.size_bytes)}</div>
                  </div>
                );
              })}
            </div>
            {entries.length > n && (
              <div style={{ textAlign: 'center', marginTop: 10 }}>
                <button onClick={() => setVisible({ ...visible, [name]: n + PAGE })}>显示更多（剩 {entries.length - n} 部）</button>
              </div>
            )}
            {entries.length === 0 && <p className="hint">无匹配条目</p>}
          </div>
        );
      })}
    </section>
  );
}
