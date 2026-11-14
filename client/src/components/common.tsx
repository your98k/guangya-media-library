export function ProgressBar({ percent, stage, label }: { percent: number | null; stage: string | null; label: string }) {
  const p = Math.max(0, Math.min(100, percent ?? 0));
  return (
    <div>
      <div className="progress"><div style={{ width: `${p}%` }} /></div>
      <div className="progress-label">
        <span>{label}{stage ? ` · ${stage}` : ''}</span>
        <span>{percent != null ? `${p}%` : ''}</span>
      </div>
    </div>
  );
}

export function PosterImg({ url, title, size = 'w185' }: { url: string; title: string; size?: 'w185' | 'w342' }) {
  if (!url) return <div className="poster-placeholder">{title}</div>;
  const src = url.replace(/\/t\/p\/w\d+\//, `/t/p/${size}/`);
  return <img className="poster" src={src} alt={title} loading="lazy" decoding="async" />;
}
