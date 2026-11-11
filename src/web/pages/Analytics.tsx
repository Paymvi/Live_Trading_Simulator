import { useState } from 'react';
import { useApi } from '../api';
import { useApp } from '../App';
import { LineChart } from '../charts';
import { Badge, Card, Explain, Help, Pnl, Stat, Table, Tabs, dur, pct, qty, time, usd } from '../ui';

interface A {
  trades: { orderId: string; symbol: string; direction: string; qty: string; gross: string; fees: string; net: string; openedAt: number; closedAt: number; holdMs: number; entry: string; exit: string }[];
  stats: { count: number; wins: number; losses: number; breakeven: number; winRate: number | null; avgWin: string | null; avgLoss: string | null; expectancy: string | null; profitFactor: number | null; profitFactorNote: string | null; best: { symbol: string; net: string } | null; worst: { symbol: string; net: string } | null; avgHoldMs: number | null; grossRealized: string; netRealized: string; tradeFees: string };
  costs: { fees: string; interest: string; borrow: string };
  equityCurve: { ts: number; equity: string }[];
  daily: { date: string; pnl: string; ret: number | null; flows: string; equity: string }[];
  weekly: { period: string; pnl: string; ret: number | null }[];
  monthly: { period: string; pnl: string; ret: number | null }[];
  drawdown: { pct: number; amount: string };
  twr: number | null;
  staleValuations: number;
}

export function Analytics() {
  const { account, theme } = useApp();
  const [tab, setTab] = useState<'perf' | 'trades' | 'calendar' | 'bench' | 'recap'>(location.hash.endsWith('recap') ? 'recap' : 'perf');
  const a = useApi<A>(account ? `/api/accounts/${account.id}/analytics` : null, { accountId: account?.id, intervalMs: 30_000 });
  const d = a.data;
  return (
    <div className="page">
      <h1>Analytics</h1>
      <Tabs label="Analytics sections" value={tab} onChange={setTab} items={[['perf', 'Performance'], ['trades', 'Trades'], ['calendar', 'Calendar'], ['bench', 'Benchmark'], ['recap', 'Daily recap']]} />
      {!d ? <div className="empty">{a.error ?? 'Loading…'}</div> : tab === 'perf' ? <>
        <div className="stats">
          <Stat label="Time-weighted return" help="twr" value={pct(d.twr)} />
          <Stat label="Max drawdown" help="max_drawdown" value={pct(-d.drawdown.pct)} sub={usd(-Number(d.drawdown.amount))} />
          <Stat label="Closed trades" help="counted_trade" value={d.stats.count} sub={`${d.stats.wins} won · ${d.stats.losses} lost · ${d.stats.breakeven} even`} />
          <Stat label="Win rate" help="win_rate" value={d.stats.winRate === null ? <span className="muted">undefined</span> : pct(d.stats.winRate, 1)} />
          <Stat label="Average win" help="avg_win" value={<Pnl v={d.stats.avgWin} />} />
          <Stat label="Average loss" help="avg_loss" value={<Pnl v={d.stats.avgLoss} />} />
          <Stat label="Expectancy / trade" help="expectancy" value={<Pnl v={d.stats.expectancy} />} />
          <Stat label="Profit factor" help="profit_factor" value={d.stats.profitFactor === null ? <span className="muted small">{d.stats.profitFactorNote}</span> : d.stats.profitFactor.toFixed(2)} />
          <Stat label="Avg holding time" help="holding_time" value={dur(d.stats.avgHoldMs)} />
          <Stat label="Best / worst trade" value={<><Pnl v={d.stats.best?.net} /> / <Pnl v={d.stats.worst?.net} /></>} sub={`${d.stats.best?.symbol ?? '—'} / ${d.stats.worst?.symbol ?? '—'}`} />
          <Stat label="Net realized" help="realized" value={<Pnl v={d.stats.netRealized} />} sub={`Gross ${usd(d.stats.grossRealized)} − trade fees ${usd(d.stats.tradeFees)}`} />
          <Stat label="All costs" help="fees" value={usd(Number(d.costs.fees) + Number(d.costs.interest) + Number(d.costs.borrow))} sub={`Fees ${usd(d.costs.fees)} · interest ${usd(d.costs.interest)} · borrow ${usd(d.costs.borrow)}`} />
        </div>
        {d.staleValuations > 0 && <div className="alert warn">{d.staleValuations} valuation snapshot(s) used stale prices; the curve may be inaccurate around them.</div>}
        <Card title="Equity curve">{d.equityCurve.length > 1 ? <LineChart theme={theme} label="Equity curve" series={[{ name: 'Net liq', color: '--accent', points: d.equityCurve.map((p) => ({ t: p.ts, v: Number(p.equity) })) }]} /> : <div className="empty">Not enough history yet.</div>}</Card>
        <div className="cols">
          <Card title="Weekly P&L"><PeriodTable rows={d.weekly} /></Card>
          <Card title="Monthly P&L"><PeriodTable rows={d.monthly} /></Card>
        </div>
        <Explain>Statistics are about past simulated decisions, not predictions. A positive expectancy or daily average is not future income.</Explain>
      </> : tab === 'trades' ? (
        <Card title={<>Closed trades<Help k="counted_trade" /></>} actions={account && <a href={`/api/export/csv?accountId=${account.id}&kind=trades`} className="ghost">Export CSV</a>}>
          <Table rows={d.trades} rowKey={(t) => t.orderId} initialSort={['c', -1]} empty="No closed trades yet." cols={[
            { key: 'c', label: 'Closed', render: (t) => time(t.closedAt), sort: (t) => t.closedAt },
            { key: 's', label: 'Symbol', render: (t) => <>{t.symbol} {t.direction === 'short' && <Badge tone="warn">short</Badge>}</>, sort: (t) => t.symbol },
            { key: 'q', label: 'Qty', render: (t) => qty(t.qty), className: 'num' },
            { key: 'e', label: 'Entry → exit', render: (t) => `${usd(t.entry, 2)} → ${usd(t.exit, 2)}`, className: 'num' },
            { key: 'h', label: 'Held', render: (t) => dur(t.holdMs), sort: (t) => t.holdMs, className: 'num' },
            { key: 'f', label: 'Fees', render: (t) => usd(t.fees), className: 'num' },
            { key: 'n', label: 'Net P&L', render: (t) => <Pnl v={t.net} />, sort: (t) => Number(t.net), className: 'num' },
          ]} />
        </Card>
      ) : tab === 'calendar' ? <Calendar daily={d.daily} /> : tab === 'bench' ? <Benchmark /> : <Recap />}
    </div>
  );
}

function PeriodTable({ rows }: { rows: { period: string; pnl: string; ret: number | null }[] }) {
  return <Table rows={[...rows].reverse()} rowKey={(r) => r.period} empty="No data yet." cols={[
    { key: 'p', label: 'Period', render: (r) => r.period },
    { key: 'v', label: 'P&L', render: (r) => <Pnl v={r.pnl} />, className: 'num' },
    { key: 'r', label: 'Return', render: (r) => pct(r.ret), className: 'num' },
  ]} />;
}

function Calendar({ daily }: { daily: A['daily'] }) {
  const months = [...new Set(daily.map((d) => d.date.slice(0, 7)))].reverse();
  const by = new Map(daily.map((d) => [d.date, d]));
  if (!months.length) return <div className="empty">No daily history yet.</div>;
  return <>{months.map((m) => {
    const [y, mo] = m.split('-').map(Number) as [number, number];
    const first = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
    const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const max = Math.max(1, ...daily.filter((d) => d.date.startsWith(m)).map((d) => Math.abs(Number(d.pnl))));
    return (
      <Card key={m} title={new Date(Date.UTC(y, mo - 1, 15)).toLocaleDateString([], { month: 'long', year: 'numeric' })}>
        <div className="cal" role="grid" aria-label={`Daily P&L ${m}`}>
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w, i) => <div key={i} className="cal-h" role="columnheader">{w}</div>)}
          {Array.from({ length: first }, (_, i) => <div key={`e${i}`} />)}
          {Array.from({ length: days }, (_, i) => {
            const date = `${m}-${String(i + 1).padStart(2, '0')}`;
            const d = by.get(date);
            const v = d ? Number(d.pnl) : 0;
            const a = Math.min(1, Math.abs(v) / max);
            return <div key={date} role="gridcell" className="cal-d" title={d ? `${date}: ${usd(d.pnl)} (${pct(d.ret)})` : date}
              style={d && v !== 0 ? { background: `color-mix(in srgb, var(${v > 0 ? '--pos' : '--neg'}) ${Math.round(15 + a * 60)}%, transparent)` } : undefined}>
              <span className="cal-n">{i + 1}</span>{d && <span className="cal-v">{v === 0 ? '0' : `${v > 0 ? '+' : ''}${Math.round(v).toLocaleString()}`}</span>}
            </div>;
          })}
        </div>
      </Card>
    );
  })}<Explain>Each day shows P&L excluding deposits/withdrawals. Days the service did not run have no valuation, so their change appears on the next recorded day.</Explain></>;
}

function Benchmark() {
  const { account, theme } = useApp();
  const [sym, setSym] = useState('SPY');
  const b = useApi<{ available: boolean; reason?: string; symbol: string; from: string; to: string; series: { date: string; priceReturnValue: string; totalReturnValue: string | null; account: string | null }[]; accountTwr: number | null; note: string }>(account ? `/api/accounts/${account.id}/benchmark?symbol=${sym}` : null);
  const d = b.data;
  const t = (date: string) => Date.parse(`${date}T21:00:00Z`);
  const last = d?.series?.at(-1), first = d?.series?.[0];
  return (
    <Card title={<>Benchmark comparison<Help k="benchmark" /></>} actions={<label className="field inline"><span className="sr">Benchmark</span><select value={sym} onChange={(e) => setSym(e.target.value)}><option>SPY</option><option>QQQ</option><option>IWM</option><option>VTI</option><option>DIA</option></select></label>}>
      {!d ? <div className="empty">{b.error ?? 'Loading…'}</div> : !d.available ? <div className="empty">{d.reason}</div> : <>
        <div className="stats">
          <Stat label="Account (time-weighted)" help="twr" value={pct(d.accountTwr)} />
          <Stat label={`${d.symbol} price return`} value={pct(first && last ? Number(last.priceReturnValue) / Number(first.priceReturnValue) - 1 : null)} sub="excludes dividends; deposit-adjusted value" />
          <Stat label={`${d.symbol} total return (approx.)`} value={pct(first?.totalReturnValue && last?.totalReturnValue ? Number(last.totalReturnValue) / Number(first.totalReturnValue) - 1 : null)} />
        </div>
        <LineChart theme={theme} label="Account versus benchmark" series={[
          { name: 'Account', color: '--accent', points: d.series.filter((p) => p.account).map((p) => ({ t: t(p.date), v: Number(p.account) })) },
          { name: `${d.symbol} price`, color: '--c3', points: d.series.map((p) => ({ t: t(p.date), v: Number(p.priceReturnValue) })) },
          { name: `${d.symbol} total`, color: '--c5', points: d.series.filter((p) => p.totalReturnValue).map((p) => ({ t: t(p.date), v: Number(p.totalReturnValue) })) },
        ]} />
        <p className="muted small">{d.from} → {d.to}. {d.note} Benchmark simple returns above include deposit timing effects only through the value series; compare time-weighted return with care when deposits are large.</p>
      </>}
    </Card>
  );
}

function Recap() {
  const { account } = useApp();
  const [date, setDate] = useState(() => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }));
  const r = useApi<{ dayPnl: string | null; closedTrades: { orderId: string; symbol: string; direction: string; qty: string; net: string; holdMs: number }[]; realizedNet: string; openContributions: { symbol: string; direction: string; dayChange: string | null; unrealized: string }[]; fees: string; interest: string; dividends: string; flows: string; note: string }>(account ? `/api/accounts/${account.id}/recap?date=${date}` : null, { accountId: account?.id });
  const d = r.data;
  return (
    <Card title="Daily recap" actions={<label className="field inline"><span className="sr">Date</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>}>
      {!d ? <div className="empty">Loading…</div> : <>
        <div className="kv big"><span>Day P&L (excl. deposits)</span><Pnl v={d.dayPnl} /></div>
        <h3>Completed decisions</h3>
        {d.closedTrades.length ? d.closedTrades.map((t) => <div className="kv" key={t.orderId}><span>Closed {t.direction} {qty(t.qty)} {t.symbol} after {dur(t.holdMs)}</span><Pnl v={t.net} /></div>) : <div className="muted">No positions closed this day.</div>}
        <h3>Open positions</h3>
        {d.openContributions.length ? d.openContributions.map((p) => <div className="kv" key={p.symbol}><span>{p.symbol} ({p.direction}) — today's move</span><Pnl v={p.dayChange} /></div>) : <div className="muted">{d.note}</div>}
        <h3>Other items</h3>
        <div className="kv"><span>Fees</span><Pnl v={-Number(d.fees)} /></div>
        <div className="kv"><span>Interest / borrow</span><Pnl v={-Number(d.interest)} /></div>
        <div className="kv"><span>Dividends</span><Pnl v={d.dividends} /></div>
        <div className="kv"><span>Deposits / withdrawals (not P&L)</span><span>{usd(d.flows)}</span></div>
        <p className="muted small">{d.note}</p>
      </>}
    </Card>
  );
}
