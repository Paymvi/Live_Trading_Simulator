import { useEffect, useState } from 'react';
import { api, useApi, useQuotes } from '../api';
import { useApp } from '../App';
import { Badge, Card, ErrorBox, Explain, Help, Tabs, ago, usd } from '../ui';
import type { InstrumentView } from '../types';
import type { QuoteState } from '../../domain/types';

interface Watchlist { id: string; name: string; symbols: string[] }

export function QuoteCells({ q }: { q?: QuoteState }) {
  if (!q) return <span className="muted">no quote</span>;
  const chg = q.prevClose && (q.last ?? q.bid) ? (Number(q.last ?? q.bid) - Number(q.prevClose)) / Number(q.prevClose) : null;
  return (
    <span className="qcells">
      <span title="Bid × size">{q.bid ? `${usd(q.bid, Number(q.bid) < 1 ? 4 : 2)}` : '—'}<span className="muted small"> ×{q.bidSize ?? '—'}</span></span>
      <span title="Ask × size">{q.ask ? `${usd(q.ask, Number(q.ask) < 1 ? 4 : 2)}` : '—'}<span className="muted small"> ×{q.askSize ?? '—'}</span></span>
      <span title="Last trade">{usd(q.last)}</span>
      <span className={chg === null ? 'muted' : chg >= 0 ? 'pos' : 'neg'}>{chg === null ? '—' : `${chg >= 0 ? '+' : ''}${(chg * 100).toFixed(2)}%`}</span>
      <SourceBadge q={q} />
    </span>
  );
}

export function SourceBadge({ q }: { q: QuoteState }) {
  const ts = Math.max(q.quoteTs ?? 0, q.lastTs ?? 0);
  if (q.feed === 'demo') return <Badge tone="demo" title="Synthetic demo data">DEMO · {ago(ts)}</Badge>;
  if (!q.live) return <Badge tone="warn" title={`REST snapshot from ${new Date(ts).toLocaleString()}; not streaming, never used for fills`}>snapshot · {ago(ts)}</Badge>;
  return <Badge tone="good" title={`Live ${q.feed === 'iex' ? 'IEX exchange (not NBBO)' : q.feed} · ${new Date(ts).toLocaleString()}`}>{q.feed === 'iex' ? 'IEX live' : 'live'} · {ago(ts)}</Badge>;
}

export function Markets() {
  const { account, go } = useApp();
  const lists = useApi<Watchlist[]>('/api/watchlists');
  const [active, setActive] = useState<string>('');
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{ results: InstrumentView[]; liveCatalog: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const wl = lists.data?.find((w) => w.id === active) ?? lists.data?.[0];
  const quotes = useQuotes(wl?.symbols ?? []);
  const mode = account?.mode ?? 'live';

  useEffect(() => {
    const t = setTimeout(() => {
      if (!q.trim()) { setRes(null); return; }
      api<{ results: InstrumentView[]; liveCatalog: number }>(`/api/instruments/search?q=${encodeURIComponent(q)}&mode=${mode}`).then(setRes).catch((e) => setErr(e.message));
    }, 200);
    return () => clearTimeout(t);
  }, [q, mode]);

  async function save(w: Watchlist) { await api('/api/watchlists', { method: 'PUT', body: w }); lists.reload(); }
  async function newList() {
    const name = prompt('Watchlist name');
    if (!name) return;
    const w = await api<Watchlist>('/api/watchlists', { method: 'PUT', body: { name, symbols: [] } });
    lists.reload(); setActive(w.id);
  }
  const add = (sym: string) => { if (!wl) { void api<Watchlist>('/api/watchlists', { method: 'PUT', body: { name: 'My watchlist', symbols: [sym] } }).then(() => lists.reload()); return; } if (!wl.symbols.includes(sym)) void save({ ...wl, symbols: [...wl.symbols, sym] }); };

  return (
    <div className="page">
      <h1>Markets</h1>
      <Card title="Search">
        <label className="field"><span className="field-l">Symbol or name</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={mode === 'demo' ? 'Try DEMO' : 'e.g. AAPL, SPY, BTC/USD'} autoFocus />
        </label>
        {mode === 'demo' && <Explain>This is a DEMO account: only synthetic DEMO-* instruments are available.</Explain>}
        {mode === 'live' && res && res.liveCatalog === 0 && <div className="alert warn">The live instrument list is empty. <a href="#/settings/providers">Add a free Alpaca key</a> to search real stocks, ETFs and crypto.</div>}
        <ErrorBox error={err} />
        {res && (
          <ul className="results">
            {res.results.map((i) => (
              <li key={i.symbol}>
                <button className="result" onClick={() => go(`/instrument/${encodeURIComponent(i.symbol)}`)}>
                  <strong>{i.symbol}</strong> <span className="muted">{i.name}</span> <Badge tone={i.provider === 'demo' ? 'demo' : 'neutral'}>{i.provider === 'demo' ? 'DEMO' : i.assetClass === 'crypto' ? 'crypto' : i.exchange}</Badge>
                </button>
                <button className="ghost" onClick={() => add(i.symbol)} aria-label={`Add ${i.symbol} to watchlist`}>+ Watch</button>
              </li>
            ))}
            {!res.results.length && <li className="muted">No matches.</li>}
          </ul>
        )}
      </Card>
      <Card title={<>Watchlists<Help k="iex" /></>} actions={<button className="ghost" onClick={newList}>+ New list</button>}>
        {lists.data && lists.data.length > 0 && <Tabs label="Watchlists" value={wl?.id ?? ''} onChange={setActive} items={lists.data.map((w) => [w.id, w.name])} />}
        {!wl ? <div className="empty">No watchlists yet. Search above and press “+ Watch”.</div> : (
          <>
            <div className="wl-head"><span>Symbol</span><span className="qcells"><span>Bid<Help k="bid" /></span><span>Ask<Help k="ask" /></span><span>Last<Help k="last" /></span><span>Change</span><span>Source</span></span><span></span></div>
            {wl.symbols.map((s) => (
              <div key={s} className="wl-row">
                <button className="link strong" onClick={() => go(`/instrument/${encodeURIComponent(s)}`)}>{s}</button>
                <QuoteCells q={quotes[s]} />
                <button className="icon" aria-label={`Remove ${s}`} onClick={() => save({ ...wl, symbols: wl.symbols.filter((x) => x !== s) })}>✕</button>
              </div>
            ))}
            {!wl.symbols.length && <div className="empty">Empty list.</div>}
            <div className="row gap"><button className="ghost danger" onClick={async () => { if (confirm(`Delete watchlist "${wl.name}"?`)) { await api(`/api/watchlists/${wl.id}`, { method: 'DELETE' }); lists.reload(); } }}>Delete list</button></div>
            <Explain>Change is versus the previous close. Live stocks stream from the IEX exchange (free plan, 30 symbols max, open orders and positions take priority); extra symbols refresh from snapshots every minute and are labeled “snapshot”.</Explain>
          </>
        )}
      </Card>
      <Card title="Not available in this simulator">
        <ul className="plain">
          <li><strong>Options</strong> — the free feed is indicative only, so fills would be fabricated.<Help k="options_unavailable" /></li>
          <li><strong>Futures, forex, bonds, mutual funds</strong> — no permitted free real-time data; see docs/COVERAGE.md for what would be needed.</li>
        </ul>
      </Card>
    </div>
  );
}
