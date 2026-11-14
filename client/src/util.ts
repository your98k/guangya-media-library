export function fmtTime(v: string | number | null | undefined): string {
  if (v == null || v === '') return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}

export function fmtBytes(n: number): string {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** Load TMDB posters at display size; leave local/other URLs untouched. */
export function sizedPoster(url: string, size: 'w185' | 'w342' = 'w185'): string {
  if (!url) return '';
  return url.replace(/\/t\/p\/w\d+\//, `/t/p/${size}/`);
}
