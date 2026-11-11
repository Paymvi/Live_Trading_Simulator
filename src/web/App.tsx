import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, useApi, useLive, usePref } from './api';
import { ago, Badge, ExplainCtx, Help, usd } from './ui';
import type { AccountRow } from './types';
import { Overview } from './pages/Overview';
import { Markets } from './pages/Markets';
import { InstrumentPage } from './pages/Instrument';
import { Portfolio } from './pages/Portfolio';
import { Orders } from './pages/Orders';
import { Analytics } from './pages/Analytics';
import { Journal } from './pages/Journal';
import { Settings } from './pages/Settings';
import { CreateAccount } from './pages/CreateAccount';
import { Pair } from './pages/Pair';

export const AppCtx = createContext<{ account: AccountRow | null; accounts: AccountRow[]; reloadAccounts: () => void; setAccountId: (id: string) => void; theme: string; go: (h: string) => void }>(null!);
export const useApp = () => useContext(AppCtx);

function useHash() {
  const [h, setH] = useState(location.hash.slice(1) || '/overview');
  useEffect(() => { const f = () => setH(location.hash.slice(1) || '/overview'); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return h;
}

const NAV: [string, string, string][] = [
  ['/overview', 'Overview', '◧'], ['/markets', 'Markets', '◎'], ['/portfolio', 'Portfolio', '▤'], ['/orders', 'Orders', '☰'],
  ['/analytics', 'Analytics', '◔'], ['/journal', 'Journal', '✎'], ['/settings', 'Settings', '⚙'],
];

export function App() {
  const [explain, setExplain] = usePref('lts.explain', true);
  const [themePref, setThemePref] = usePref<'system' | 'light' | 'dark'>('lts.theme', 'system');
  const [accountId, setAccountId] = usePref<string | null>('lts.account', null);
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => { const m = matchMedia('(prefers-color-scheme: dark)'); const f = () => setSystemDark(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  const theme = themePref === 'system' ? (systemDark ? 'dark' : 'light') : themePref;
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  const who = useApi<{ loopback: boolean; paired: boolean }>('/api/whoami');
  const accountsQ = useApi<AccountRow[]>(who.data && (who.data.loopback || who.data.paired) ? '/api/accounts' : null, { intervalMs: 10_000 });
  const accounts = useMemo(() => accountsQ.data ?? [], [accountsQ.data]);
  const account = accounts.find((a) => a.id === accountId && !a.archived) ?? accounts.find((a) => !a.archived) ?? null;
  const hash = useHash();
  const go = (h: string) => { location.hash = h; };

  if (who.data && !who.data.loopback && !who.data.paired) return <Pair />;
  const ctx = { account, accounts, reloadAccounts: accountsQ.reload, setAccountId, theme, go };
  const [, page, arg] = hash.split('/');
  let body: ReactNode;
  if (!accountsQ.data) body = <div className="empty">{accountsQ.error ? `Cannot reach the local service: ${accountsQ.error}` : 'Loading…'}</div>;
  else if (!account && page !== 'settings') body = <CreateAccount first />;
  else if (page === 'markets') body = <Markets />;
  else if (page === 'instrument' && arg) body = <InstrumentPage symbol={decodeURIComponent(arg)} />;
  else if (page === 'portfolio') body = <Portfolio />;
  else if (page === 'orders') body = <Orders />;
  else if (page === 'analytics') body = <Analytics />;
  else if (page === 'journal') body = <Journal />;
  else if (page === 'settings') body = <Settings themePref={themePref} setThemePref={setThemePref} />;
  else body = <Overview />;

  return (
    <ExplainCtx.Provider value={{ on: explain, toggle: () => setExplain(!explain) }}>
      <AppCtx.Provider value={ctx}>
        <a className="skip" href="#main">Skip to content</a>
        <div className="shell">
          <header className="top">
            <div className="brand"><span className="logo" aria-hidden>◆</span><span className="brand-t">Live Trading Simulator</span>
              <Badge tone="warn" title="Fictional money only. No real orders are ever sent.">SIMULATED</Badge>
              {account?.mode === 'demo' && <Badge tone="demo" title="This account uses synthetic DEMO prices">DEMO DATA</Badge>}
            </div>
            <div className="top-r">
              {accounts.length > 0 && (
                <label className="acct-sel">
                  <select aria-label="Current account" value={account?.id ?? ''} onChange={(e) => (e.target.value === '__new' ? go('/settings/accounts') : setAccountId(e.target.value))}>
                    {accounts.filter((a) => !a.archived).map((a) => <option key={a.id} value={a.id}>{a.name} · {a.type} · {a.mode === 'demo' ? 'DEMO' : 'live'} · {usd(a.equity, 0)}</option>)}
                    <option value="__new">+ New account…</option>
                  </select>
                </label>
              )}
              <button className={`chip ${explain ? 'on' : ''}`} aria-pressed={explain} onClick={() => setExplain(!explain)} title="Explanation Mode adds ? buttons next to terms and controls">Explain {explain ? 'on' : 'off'}</button>
              <button className="icon" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} onClick={() => setThemePref(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '☀' : '☾'}</button>
            </div>
          </header>
          <StatusStrip />
          <nav className="side" aria-label="Main">
            {NAV.map(([h, l, i]) => <a key={h} href={`#${h}`} className={hash.startsWith(h) || (h === '/markets' && hash.startsWith('/instrument')) ? 'on' : ''} aria-current={hash.startsWith(h) ? 'page' : undefined}><span aria-hidden className="nav-i">{i}</span><span className="nav-l">{l}</span></a>)}
          </nav>
          <main id="main" tabIndex={-1}>{body}</main>
        </div>
      </AppCtx.Provider>
    </ExplainCtx.Provider>
  );
}

function StatusStrip() {
  const { account } = useApp();
  const connected = useLive((s) => s.connected);
  const st = useLive((s) => s.status);
  const [, force] = useState(0);
  useEffect(() => { const i = setInterval(() => force((x) => x + 1), 1000); return () => clearInterval(i); }, []);
  if (!st) return <div className="strip"><Badge tone={connected ? 'info' : 'bad'}>{connected ? 'Connecting…' : 'Service unreachable — is the launcher window open?'}</Badge></div>;
  const hbAge = Date.now() - st.service.heartbeat;
  const scopes = account?.mode === 'demo' ? ['demo'] : ['alpaca-equity', 'alpaca-crypto'];
  const streams = st.streams.filter((s) => scopes.includes(s.scope));
  const openGaps = st.gaps.filter((g) => !g.endTs);
  const lastBackup = st.backups.last.find((b) => b.ok);
  const lastFail = st.backups.last[0] && !st.backups.last[0].ok ? st.backups.last[0] : null;
  const tone = (s: string) => (s === 'connected' ? 'good' : s === 'connecting' ? 'warn' : s === 'closed' ? 'neutral' : 'bad');
  return (
    <div className="strip" role="status" aria-live="polite">
      <Badge tone={connected && hbAge < 5000 ? 'good' : 'bad'} title="Local engine heartbeat">Engine {connected && hbAge < 5000 ? 'running' : 'NOT RESPONDING'}<Help k="heartbeat" /></Badge>
      <Badge tone={st.market.session === 'regular' ? 'good' : 'neutral'}>US stocks: {st.market.label}<Help k="session" /></Badge>
      {streams.map((s) => <Badge key={s.scope} tone={tone(s.state)} title={`${s.message}. Feed: ${s.feed}`}>{s.label}: {s.state === 'closed' ? 'idle' : s.state}{s.lastEventAt ? ` · ${ago(s.lastEventAt)}` : ''}</Badge>)}
      {account?.mode !== 'demo' && !st.provider.alpacaConfigured && <a href="#/settings/providers" className="badge warn">Add a free Alpaca key for live data →</a>}
      {st.events.lastEventAt && <span className="muted small">Last event {st.events.lastEventSymbol} {ago(st.events.lastEventAt)}</span>}
      {openGaps.length > 0 && <Badge tone="bad" title={openGaps.map((g) => g.reason).join('; ')}>Data gap in progress<Help k="gap" /></Badge>}
      {st.notStreamed.length > 0 && <Badge tone="warn" title={st.notStreamed.join(', ')}>{st.notStreamed.length} symbol(s) not streamed (30-symbol limit)</Badge>}
      {lastFail ? <Badge tone="bad" title={lastFail.message}>Backup failed</Badge> : <span className="muted small">Backup {ago(lastBackup?.ts)}</span>}
      {!st.corp.ok && <Badge tone="warn" title={st.corp.message}>Corporate actions unverified</Badge>}
    </div>
  );
}

export async function postJson<T>(path: string, body?: unknown, method = 'POST') { return api<T>(path, { method, body: body ?? {} }); }
