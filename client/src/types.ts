export interface NextExpected { episode: string; at: string }

export interface BoardShow {
  key: string;
  title: string;
  year: number | null;
  category: string;
  tmdb_id: number | null;
  poster_url: string;
  library_have: string;
  pending: string[];
  next_expected: NextExpected[];
  cadence: string;
  spec: string;
}

export interface Board { generated_at: string; watch_total: number; shows: BoardShow[] }

export interface CatalogEntry {
  title: string;
  year: number | null;
  tmdb_id: number | null;
  poster_url: string;
  seasons: number | null;
  episodes: number;
  size_bytes: number;
  folder_name: string;
}

export interface Catalog {
  generated_at: string;
  totals: { titles: number; episodes: number; size_bytes: number };
  posters: Record<string, string>;
  categories: Record<string, CatalogEntry[]>;
}

export interface WatchLinkItem { slot: number; url: string; code?: string }
export interface WatchLinkGroup { tmdb_id: number | null; title: string | null; links: WatchLinkItem[] }

export interface Issue {
  id: number;
  tmdb_id: number | null;
  title: string | null;
  issue_type: string;
  issue_text: string;
  updated_at_text: string | null;
}

export interface WatchScanStatus {
  has_synced?: boolean;
  last_scan_at?: string | null;
  next_scan_at?: string | null;
  sweep_active?: boolean;
  progress_percent?: number | null;
  progress_stage?: string | null;
  shows_total?: number;
  shows_done?: number;
}

export interface ShowScanState {
  show_key: string;
  tmdb_id: number | null;
  title: string | null;
  enabled: boolean;
  interval_minutes: number | null;
  last_scan_at_ms: number | null;
  next_scan_at_ms: number | null;
  scan_active: boolean;
  progress_percent: number | null;
  progress_stage: string | null;
  progress_at_ms: number | null;
}

export interface UnclassifiedSchedule {
  enabled: boolean;
  interval_minutes: number;
  last_scan_at: string | null;
  next_scan_at: string | null;
}

export type VersionCriterion = 'resolution' | 'hdr' | 'size';

export interface VersionSettings {
  version_mode: 'best' | 'any_upgrade';
  version_criteria: VersionCriterion[];
  version_size_prefer: 'bigger' | 'smaller';
}

export type RequestKind = 'search' | 'add' | 'fix' | 'scan' | 'watchscan' | 'link' | 'catalog_refresh';
export type RequestStatus = 'pending' | 'processing' | 'done' | 'failed' | 'cancelled' | 'expired';

export interface SearchResultItem {
  tmdb_id: number;
  title: string;
  year: number | null;
  media_type: string;
  overview: string;
  poster_url: string;
  vote_average: number | null;
  in_library?: boolean;
}

export interface PanelRequest {
  id: number;
  kind: RequestKind;
  status: RequestStatus;
  payload: Record<string, unknown>;
  progress_percent: number | null;
  progress_stage: string | null;
  result_note: string | null;
  results: SearchResultItem[] | null;
  results_at: string | null;
  results_expired: boolean;
  found_count: number | null;
  organized_count: number | null;
  taken_count: number | null;
  trigger: string | null;
  created_at: string;
  updated_at: string;
}
