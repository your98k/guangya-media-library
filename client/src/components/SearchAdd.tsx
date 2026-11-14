import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { api } from '../api';
import type { PanelRequest } from '../types';
import { sizedPoster } from '../util';

export interface SearchAddHandle { provideLink: (title: string) => void }

const SearchAdd = forwardRef<SearchAddHandle, {
  requests: PanelRequest[];
  onChanged: () => void;
  flash: (msg: string, ok: boolean) => void;
}>(function SearchAdd({ requests, onChanged, flash }, ref) {
  const [tab, setTab] = useState<'search' | 'link'>('search');
  const [mode, setMode] = useState<'name' | 'tmdb_id'>('name');
  const [query, setQuery] = useState('');
  const [idType, setIdType] = useState<'tv' | 'movie'>('tv');
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [related, setRelated] = useState('');
  const [, setTick] = useState(0);
  const urlRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    provideLink: (title: string) => {
      setTab('link');
      setRelated(title);
      setTimeout(() => urlRef.current?.focus(), 50);
    },
  }));

  // tick every 20s so the 5-minute expiry countdown stays honest
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 20000);
    return () => clearInterval(t);
  }, []);

  const searches = requests.filter((r) => r.kind === 'search' && r.results && r.results.length > 0);

  const submitSearch = async () => {
    if (!query.trim()) return;
    try {
      await api.submitSearch({ mode, query: query.trim(), id_type: idType });
      flash('搜索已提交，等待后台返回结果', true); onChanged();
    } catch (e) { flash(e instanceof Error ? e.message : '提交失败', false); }
  };

  const submitPicks = async (r: PanelRequest) => {
    const picks = (r.results ?? []).filter((x) => selected[x.tmdb_id]);
    if (picks.length === 0) { flash('先勾选要入库的结果', false); return; }
    try {
      for (const p of picks) {
        await api.submitAdd({ source: 'tmdb', tmdb_id: p.tmdb_id, title: p.title, year: p.year, media_type: p.media_type, poster_url: p.poster_url });
      }
      await api.finalizeSearch(r.id, picks.map((p) => p.tmdb_id));
      flash(`已提交 ${picks.length} 部入库`, true); onChanged();
    } catch (e) { flash(e instanceof Error ? e.message : '提交失败', false); }
  };

  const submitLink = async () => {
    try {
      await api.submitAdd({ source: 'link', url: url.trim(), code: code.trim() || undefined, related_title: related || undefined });
      flash('链接已提交，等待后台处理', true);
      setUrl(''); setCode(''); onChanged();
    } catch (e) { flash(e instanceof Error ? e.message : '提交失败', false); }
  };

  return (
    <section className="panel">
      <h2>搜索 / 添加到影视库</h2>
      <div className="tabs">
        <button className={tab === 'search' ? 'on' : ''} onClick={() => setTab('search')}>TMDB 搜索</button>
        <button className={tab === 'link' ? 'on' : ''} onClick={() => setTab('link')}>光鸭分享链接</button>
      </div>

      {tab === 'search' && (
        <>
          <div className="form-grid">
            <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
              <option value="name">按片名</option>
              <option value="tmdb_id">按 TMDB ID</option>
            </select>
            {mode === 'tmdb_id' && (
              <select value={idType} onChange={(e) => setIdType(e.target.value as typeof idType)}>
                <option value="tv">剧集</option>
                <option value="movie">电影</option>
              </select>
            )}
            <input type="text" placeholder={mode === 'name' ? '输入片名关键词' : '输入 TMDB 数字 ID'}
              value={query} onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitSearch()} />
            <button className="primary" onClick={submitSearch}>搜索</button>
          </div>
          {searches.map((r) => {
            const remainMs = r.results_at ? new Date(r.results_at).getTime() + 5 * 60 * 1000 - Date.now() : 0;
            const finalized = !!r.payload.finalized;
            return (
              <div key={r.id} style={{ marginTop: 12 }}>
                <div className="meta">
                  搜索「{String(r.payload.query ?? '')}」
                  {finalized
                    ? ` · 已提交 ${String(r.payload.submitted_count ?? 0)} 部`
                    : r.results_expired
                      ? ' · 结果已过期（超过 5 分钟），请重新搜索'
                      : ` · 结果保留 ${Math.max(0, Math.ceil(remainMs / 1000))} 秒，勾选后提交`}
                </div>
                <div className="results-grid">
                  {(r.results ?? []).map((x) => (
                    <label className="result-item" key={x.tmdb_id}>
                      {x.poster_url && !r.results_expired
                        ? <img src={sizedPoster(x.poster_url)} alt={x.title} loading="lazy" />
                        : <div className="ph2">{r.results_expired ? '已过期' : '无海报'}</div>}
                      <div className="grow">
                        <div className="t">{x.title} {x.in_library && <span className="badge">库内已有</span>}</div>
                        <div className="meta">{x.year ?? ''} · {x.media_type === 'movie' ? '电影' : '剧集'}{x.vote_average != null ? ` · ★${x.vote_average}` : ''}</div>
                        <div className="o">{x.overview}</div>
                      </div>
                      {!finalized && !r.results_expired && (
                        <input type="checkbox" checked={!!selected[x.tmdb_id]}
                          onChange={(e) => setSelected({ ...selected, [x.tmdb_id]: e.target.checked })} />
                      )}
                    </label>
                  ))}
                </div>
                {!finalized && !r.results_expired && (
                  <div style={{ marginTop: 8 }}>
                    <button className="primary small" onClick={() => submitPicks(r)}>提交所选入库</button>
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}

      {tab === 'link' && (
        <div className="form-grid">
          {related && <span className="badge">为《{related}》提供链接</span>}
          <input ref={urlRef} type="url" placeholder="https://www.guangyapan.com/s/<id>_<后缀>（必须完整）"
            value={url} onChange={(e) => setUrl(e.target.value)} />
          <input style={{ width: 130 }} placeholder="提取码（可选）" value={code} onChange={(e) => setCode(e.target.value)} />
          <button className="primary" onClick={submitLink}>提交链接</button>
          <span className="meta">链接不完整（缺 _后缀）会被直接拒绝并提示，不会静默失败。</span>
        </div>
      )}
    </section>
  );
});

export default SearchAdd;
