import { useApi } from '../api';
import { useApp } from '../App';
import { LineChart } from '../charts';
import { Badge, Card, Explain, Help, Pnl, Stat, Table, pct, qty, time, usd } from '../ui';
import type { Summary } from '../types';
import { OrdersTable } from './Orders';

export function Overview() {
  const { account, theme, go } = useApp();
  const sm = useApi<Summary>(account ? `/api/accounts/${account.id}/summary` : null, { accountId: account?.id, intervalMs: 3000 });
  const an = useApi<{ equityCurve: { ts: number; equity: string }[] }>(account ? `/api/accounts/${account.id}/analytics` : null, { accountId: account?.id, intervalMs: 60_000 });
  const recap = useApi<{ closedTrades: { symbol: string; net: string; direction: string; qty: string }[]; openContributions: { symbol: string; dayChange: string | null }[]; fees: string; interest: string; dayPnl: string | null; dividends: string }>(account ? `/api/accounts/${account.id}/recap` : null, { accountId: account?.id, intervalMs: 15_000 });
  const s = sm.data;
  if (!s) return <div className="empty">{sm.error ?? 'Loading account…'}</div>;
  const b = s.balances, t = s.totals;
  const exposure = Number(b.equity) > 0 ? (Number(b.longValue) + Number(b.shortValue)) / Number(b.equity) : null;
  return (
    <div className="page">
      <h1 className="sr">Overview</h1>
      {b.restricted && <div className="alert warn">Cash account restricted to settled cash until {s.account.restrictedUntil} (good faith violations).<Help k="gfv" /></div>}
      {Number(b.marginCall) > 0 && <div className="alert bad">Margin call: equity is {usd(b.marginCall)} below the maintenance requirement. New opening orders are blocked; deposit fictional funds or reduce positions.<Help k="margin_call" /></div>}
      {b.staleMarks.length > 0 && <div className="alert warn">Stale valuation for {b.staleMarks.join(', ')} — no fresh live price.<Help k="stale" /></div>}
      <div className="stats">
        <Stat label="Net liquidation value" help="net_liq" value={usd(b.equity)} sub={<>{s.account.type} account · {s.account.mode === 'demo' ? 'DEMO data' : 'live data'}</>} />
        <Stat label="Day P&L" help="day_pnl" value={<Pnl v={t.dayPnl as string} />} />
        <Stat label="Total P&L" help="total_pnl" value={<Pnl v={t.totalPnl as string} />} sub={<>{pct(t.totalReturnOnFlows as number)} on {usd(t.externalFlows as string, 0)} external cash<Help k="external_flows" /></>} />
        <Stat label={s.account.type === 'cash' ? 'Cash available to trade' : 'Buying power'} help="buying_power" value={usd(b.buyingPower)} sub={s.account.type === 'margin' ? <>Non-margin: {usd(b.nonMarginBuyingPower)}</> : <>Settled {usd(b.settledCash)}<Help k="settled_cash" /></>} />
        <Stat label="Cash" help="cash" value={usd(b.cash)} sub={<>Reserved {usd(b.reservedCash)}<Help k="reserved" />{Number(b.unsettledCredits) > 0 && <> · unsettled {usd(b.unsettledCredits)}<Help k="unsettled" /></>}</>} />
        <Stat label="Realized / unrealized" help="realized" value={<><Pnl v={t.realizedGross as string} /> / <Pnl v={t.unrealized as string} /></>} sub={<>Gross of fees<Help k="unrealized" /></>} />
        <Stat label="Costs" help="fees" value={usd(Number(t.fees) + Number(t.interest) + Number(t.borrowFees))} sub={<>Fees {usd(t.fees as string)} · interest {usd(t.interest as string)} · borrow {usd(t.borrowFees as string)}</>} />
        <Stat label="Exposure" value={pct(exposure, 0)} sub={<>Long {usd(b.longValue, 0)} · short {usd(b.shortValue, 0)}{s.account.type === 'margin' && <> · debit {usd(b.marginDebit, 0)}<Help k="margin_debit" /></>}</>} />
      </div>
      <Explain>Net liquidation value = cash {usd(b.cash)} + long positions {usd(b.longValue)} − short positions {usd(b.shortValue)} = {usd(b.equity)}. Deposits and starting capital are excluded from P&L.</Explain>
      <div className="cols">
        <Card title="Account value">
          {an.data && an.data.equityCurve.length > 1
            ? <LineChart theme={theme} label="Account value over time" height={220} series={[{ name: 'Net liq', color: '--accent', points: an.data.equityCurve.map((p) => ({ t: p.ts, v: Number(p.equity) })) }]} />
            : <div className="empty">The chart fills in as the service records valuations (every 5 minutes and on each fill).</div>}
        </Card>
        <Card title="Today's recap">
          {recap.data ? <>
            <div className="kv"><span>Day P&L</span><Pnl v={recap.data.dayPnl} /></div>
            {recap.data.closedTrades.map((c, i) => <div className="kv" key={i}><span>Closed {c.direction} {qty(c.qty)} {c.symbol}</span><Pnl v={c.net} /></div>)}
            {recap.data.openContributions.map((c) => <div className="kv" key={c.symbol}><span>Open {c.symbol} (today's move)</span><Pnl v={c.dayChange} /></div>)}
            {Number(recap.data.fees) !== 0 && <div className="kv"><span>Fees today</span><Pnl v={-Number(recap.data.fees)} /></div>}
            {Number(recap.data.interest) !== 0 && <div className="kv"><span>Interest/borrow today</span><Pnl v={-Number(recap.data.interest)} /></div>}
            {!recap.data.closedTrades.length && !recap.data.openContributions.length && <div className="empty">No trades or open positions today.</div>}
            <a href="#/analytics/recap" className="link">Full daily recap →</a>
          </> : null}
        </Card>
      </div>
      <Card title="Positions" actions={<a href="#/portfolio">All positions →</a>}>
        <Table rows={s.positions} rowKey={(p) => p.symbol + p.direction} onRow={(p) => go(`/instrument/${encodeURIComponent(p.symbol)}`)}
          empty={<>No positions. <a href="#/markets">Find an instrument</a> to place a simulated trade.</>}
          cols={[
            { key: 's', label: 'Symbol', render: (p) => <><strong>{p.symbol}</strong> {p.direction === 'short' && <Badge tone="warn">short</Badge>}</> },
            { key: 'q', label: 'Qty', render: (p) => qty(p.qty), className: 'num' },
            { key: 'm', label: 'Mark', render: (p) => <>{usd(p.mark.price, 2)} {p.mark.stale && <Badge tone="warn">stale</Badge>}</>, className: 'num' },
            { key: 'v', label: 'Value', render: (p) => usd(p.marketValue), className: 'num' },
            { key: 'd', label: 'Day', render: (p) => <Pnl v={p.dayChange} />, className: 'num' },
            { key: 'u', label: 'Unrealized', render: (p) => <Pnl v={p.unrealized}>{usd(p.unrealized)} ({pct(p.unrealizedPct, 1)})</Pnl>, className: 'num' },
          ]} />
      </Card>
      <Card title="Open orders" actions={<a href="#/orders">All orders →</a>}>
        <OrdersTable rows={s.openOrders} compact />
      </Card>
      <Card title="Recent activity">
        {s.recent.length ? <ul className="activity">{s.recent.slice(0, 12).map((e, i) => <li key={i}><span className="muted small">{time(e.ts)}</span> <Badge>{e.type.replace(/_/g, ' ')}</Badge> {e.message}</li>)}</ul> : <div className="empty">No activity yet.</div>}
      </Card>
    </div>
  );
}
