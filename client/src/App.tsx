import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import CatalogSection from './components/Catalog';
import RequestsList from './components/RequestsList';
import SearchAdd, { type SearchAddHandle } from './components/SearchAdd';
import UnclassifiedPanel from './components/UnclassifiedPanel';
import WatchBoard from './components/WatchBoard';
import type {
  Board, Catalog, Issue, PanelRequest, ShowScanState,
  UnclassifiedSchedule, WatchLinkGroup, WatchScanStatus,
} from './types';

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 48 48" aria-label="光鸭影视库">
      <circle cx="24" cy="24" r="22" fill="#f97316" />
      <path d="M14 27c4-1 6-4 7-8 2 3 5 4 9 4 3 0 5 1 6 3-3 4-8 6-13 5-4 0-7-1-9-4z" fill="#fff" />
      <circle cx="31" cy="19" r="2.2" fill="#f97316" />
      <path d="M36 22l6 2-6 2z" fill="#fff" />
    </svg>
  );
}

export default function App() {
  const [board, setBoard] = useState<Board | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [linkGroups, setLinkGroups] = useState<WatchLinkGroup[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [scanStatus, setScanStatus] = useState<WatchScanStatus>({});
  const [showStates, setShowStates] = useState<ShowScanState[]>([]);
  const [schedule, setSchedule] = useState<UnclassifiedSchedule | null>(null);
  const [requests, setRequests] = useState<PanelRequest[]>([]);
  const [latestRefresh, setLatestRefresh] = useState<PanelRequest | null>(null);
  const [banner, setBanner] = useState<{ msg: string; ok: boolean } | null>(null);
  const searchAddRef = useRef<SearchAddHandle>(null);

  const flash = useCallback((msg: string, ok: boolean) => {
    setBanner({ msg, ok });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setTimeout(() => setBanner(null), 5000);
  }, []);

  const refresh = useCallback(async () => {
    const [b, c, l, i, ss, sh, sc, rq, lr] = await Promise.allSettled([
      api.board(), api.catalog(), api.watchLinks(), api.issues(),
      api.watchScanStatus(), api.showScanStates(), api.unclassifiedSchedule(),
      api.requests(), api.latestCatalogRefresh(),
    ]);
    if (b.status === 'fulfilled') setBoard(b.value.board);
    if (c.status === 'fulfilled') setCatalog(c.value.catalog);
    if (l.status === 'fulfilled') setLinkGroups(l.value.links);
    if (i.status === 'fulfilled') setIssues(i.value.issues);
    if (ss.status === 'fulfilled') setScanStatus(ss.value);
    if (sh.status === 'fulfilled') setShowStates(sh.value.states);
    if (sc.status === 'fulfilled') setSchedule(sc.value);
    if (rq.status === 'fulfilled') setRequests(rq.value.requests);
    if (lr.status === 'fulfilled') setLatestRefresh(lr.value.request);
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15000);
    return () => clearInterval(t);
  }, [refresh]);

  const provideLink = useCallback((title: string) => {
    searchAddRef.current?.provideLink(title);
  }, []);

  return (
    <div className="app">
      <div className="header">
        <Logo />
        <div>
          <h1>光鸭影视库</h1>
          <div className="sub">guangya-media-library · 自托管影视库管理面板（第三方开源项目，与光鸭官方无关）</div>
        </div>
      </div>

      {banner && <div className={banner.ok ? 'ok-banner' : 'error-banner'}>{banner.msg}</div>}

      <WatchBoard
        board={board} linkGroups={linkGroups} issues={issues} states={showStates}
        scanStatus={scanStatus} requests={requests}
        onChanged={() => void refresh()} flash={flash} provideLink={provideLink} />
      <CatalogSection catalog={catalog} latestRefresh={latestRefresh}
        onChanged={() => void refresh()} flash={flash} />
      <UnclassifiedPanel schedule={schedule} requests={requests}
        onChanged={() => void refresh()} flash={flash} />
      <SearchAdd ref={searchAddRef} requests={requests}
        onChanged={() => void refresh()} flash={flash} />
      <RequestsList requests={requests}
        onChanged={() => void refresh()} flash={flash} provideLink={provideLink} />

      <div className="footer">
        数据全部保存在本地 SQLite；面板只做管理与展示，查分享/转存等自动化由外部 worker 通过接口对接（见仓库 docs/API.md）。<br />
        首次启动的演示内容均为虚构示例数据。
      </div>
    </div>
  );
}
