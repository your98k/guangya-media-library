import type {
  Board, Catalog, Issue, PanelRequest, ShowScanState,
  UnclassifiedSchedule, WatchLinkGroup, WatchScanStatus,
} from './types';

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Error((data.error as string) || `请求失败（${r.status}）`);
  return data as T;
}
const post = <T,>(url: string, body: unknown) => req<T>(url, { method: 'POST', body: JSON.stringify(body) });

export const api = {
  board: () => req<{ has_snapshot: boolean; board: Board | null }>('/api/board'),
  catalog: () => req<{ has_snapshot: boolean; catalog: Catalog | null }>('/api/catalog'),
  watchLinks: () => req<{ has_synced: boolean; links: WatchLinkGroup[] }>('/api/watch-links'),
  issues: () => req<{ has_synced: boolean; issues: Issue[] }>('/api/issues'),
  watchScanStatus: () => req<WatchScanStatus>('/api/watch-scan-status'),
  showScanStates: () => req<{ states: ShowScanState[] }>('/api/watch-show-scan-states'),
  unclassifiedSchedule: () => req<UnclassifiedSchedule>('/api/unclassified-scan-schedule'),
  requests: () => req<{ requests: PanelRequest[] }>('/api/requests'),
  latestCatalogRefresh: () => req<{ request: PanelRequest | null }>('/api/requests/latest-catalog-refresh'),

  submitSearch: (body: { mode: string; query: string; id_type?: string }) =>
    post<{ request: PanelRequest }>('/api/requests/search', body),
  submitAdd: (body: Record<string, unknown>) => post<{ request: PanelRequest }>('/api/requests/add', body),
  submitFix: (body: Record<string, unknown>) => post<{ request: PanelRequest; already_open?: boolean }>('/api/requests/fix', body),
  submitScan: (trigger: string) => post<{ request: PanelRequest }>('/api/requests/scan', { trigger }),
  submitWatchscan: (body: Record<string, unknown>) => post<{ request: PanelRequest }>('/api/requests/watchscan', body),
  submitLink: (body: Record<string, unknown>) => post<{ request: PanelRequest }>('/api/requests/link', body),
  submitCatalogRefresh: () => post<{ request: PanelRequest; already_open?: boolean }>('/api/requests/catalog-refresh', {}),
  finalizeSearch: (id: number, tmdbIds: number[]) =>
    post<{ request: PanelRequest }>(`/api/requests/search/${id}/finalize`, { tmdb_ids: tmdbIds }),
  cancelRequest: (id: number) => post<{ request: PanelRequest }>(`/api/requests/${id}/cancel`, {}),
  deleteRequest: (id: number) => req<{ deleted: boolean }>(`/api/requests/${id}`, { method: 'DELETE' }),
  cleanupFinished: () => post<{ deleted: number }>('/api/requests/cleanup-finished', {}),
  setShowScanControl: (body: Record<string, unknown>) => post<{ ok: boolean }>('/api/watch-show-scan-control', body),
  setUnclassifiedSchedule: (body: Record<string, unknown>) =>
    post<UnclassifiedSchedule>('/api/unclassified-scan-schedule', body),
};
