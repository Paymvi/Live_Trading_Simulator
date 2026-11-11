import { useState } from 'react';
import { useApi } from '../api';
import { useApp } from '../App';
import { Badge, Card, Explain, Help, Pnl, Table, Tabs, pct, qty, time, usd } from '../ui';
import type { PositionRow, Summary } from '../types';

export function Portfolio() {
  const { account, go } = useApp();
  const sm = useApi<Summary>(account ? `/api/accounts/${account.id}/summary` : null, { accountId: account?.id, intervalMs: 3000 });
  const [view, setView] = useState<'table' | 'cards'>(() => (matchMedia('(max-width: 700px)').matches ? 'cards' : 'table'));
  const [open, setOpen] = useState<string | null>(null);
  const s = sm.data;
  if (!s) return <div className="empty">{sm.error ?? 'Loading…'}</div>;
  const total = s.positions.reduce((a, p) => a + Number(p.marketValue), 0);
  const cash = Number(s.balances.cash) - Number(s.balances.shortProceeds);
  const alloc = [...s.positions.map((p) => ({ k: p.symbol + (p.direction === 'short' ? ' (short)' : ''), v: Number(p.marketValue), short: p.direction === 'short' })), ...(cash > 0 ? [{ k: 'Free cash', v: cash, short: false }] : [])];
  const allocTotal = alloc.reduce((a, x) => a + x.v, 0) || 1;
  const cols = [
    { key: 's', label: 'Symbol', render: (p: PositionRow) => <><strong>{p.symbol}</strong> {p.direction === 'short' && <Badge tone="warn">short</Badge>} <span className="muted small">{p.name}</span></>, sort: (p: PositionRow) => p.symbol },
    { key: 'q', label: 'Qty', render: (p: PositionRow) => qty(p.qty), className: 'num', sort: (p: PositionRow) => Number(p.qty) },
    { key: 'a', label: 'Avg price', render: (p: PositionRow) => usd(p.avgPrice, 4), className: 'num' },
    { key: 'm', label: 'Mark', render: (p: PositionRow) => <>{usd(p.mark.price, 2)} <span className="muted small">{p.mark.source}</span>{p.mark.stale && <Badge tone="warn">stale</Badge>}</>, className: 'num' },
    { key: 'c', label: 'Cost basis', render: (p: PositionRow) => usd(p.costBasis), className: 'num', sort: (p: PositionRow) => Number(p.costBasis) },
    { key: 'v', label: 'Value', render: (p: PositionRow) => usd(p.marketValue), className: 'num', sort: (p: PositionRow) => Number(p.marketValue) },
    { key: 'd', label: 'Day', render: (p: PositionRow) => <Pnl v={p.dayChange} />, className: 'num', sort: (p: PositionRow) => Number(p.dayChange ?? 0) },
    { key: 'u', label: 'Unrealized', render: (p: PositionRow) => <Pnl v={p.unrealized}>{usd(p.unrealized)} ({pct(p.unrealizedPct, 1)})</Pnl>, className: 'num', sort: (p: PositionRow) => Number(p.unrealized) },
    { key: 'w', label: 'Weight', render: (p: PositionRow) => pct(p.weight, 1), className: 'num', sort: (p: PositionRow) => p.weight ?? 0 },
  ];
  return (
    <div className="page">
      <h1>Portfolio</h1>
      <div className="stats">
        <div className="stat"><div className="stat-label">Positions value</div><div className="stat-value">{usd(total)}</div></div>
        <div className="stat"><div className="stat-label">Unrealized<Help k="unrealized" /></div><div className="stat-value"><Pnl v={s.totals.unrealized as string} /></div></div>
        <div className="stat"><div className="stat-label">Realized (gross)<Help k="realized" /></div><div className="stat-value"><Pnl v={s.totals.realizedGross as string} /></div></div>
        <div className="stat"><div className="stat-label">Dividends</div><div className="stat-value">{usd(s.totals.dividends as string)}</div></div>
      </div>
      <Card title="Holdings" actions={<Tabs label="View" value={view} onChange={setView} items={[['table', 'Table'], ['cards', 'Cards']]} />}>
        {view === 'table' ? <Table rows={s.positions} cols={cols} rowKey={(p) => p.symbol + p.direction} onRow={(p) => setOpen(open === p.symbol ? null : p.symbol)} initialSort={['v', -1]} empty="No positions yet." />
          : <div className="cards">{s.positions.length ? s.positions.map((p) => (
            <button key={p.symbol + p.direction} className="pcard" onClick={() => setOpen(open === p.symbol ? null : p.symbol)}>
              <div className="row between"><strong>{p.symbol}</strong>{p.direction === 'short' && <Badge tone="warn">short</Badge>}<span>{usd(p.marketValue)}</span></div>
              <div className="row between small"><span>{qty(p.qty)} @ {usd(p.avgPrice, 2)}</span><Pnl v={p.unrealized} /></div>
            </button>)) : <div className="empty">No positions yet.</div>}</div>}
        {open && s.positions.filter((p) => p.symbol === open).map((p) => (
          <div key={p.direction} className="drill">
            <h3>{p.symbol} lots (FIFO)<Help k="lots_fifo" /></h3>
            <Table rows={p.lots} rowKey={(l) => l.id} cols={[
              { key: 'o', label: 'Opened', render: (l) => time(l.openedAt) },
              { key: 'q', label: 'Qty', render: (l) => qty(l.qty), className: 'num' },
              { key: 'p', label: 'Price', render: (l) => usd(l.price, 4), className: 'num' },
              { key: 'f', label: 'Opening fee', render: (l) => usd(l.openFee), className: 'num' },
              { key: 'u', label: 'Unrealized', render: (l) => <Pnl v={p.mark.price ? (Number(p.mark.price) - Number(l.price)) * Number(l.qty) * (p.direction === 'long' ? 1 : -1) : null} />, className: 'num' },
              { key: 'g', label: 'Settlement note', render: (l) => (l.fundedUnsettledUntil ? <Badge tone="warn">bought with unsettled funds (settle {l.fundedUnsettledUntil})</Badge> : '') },
            ]} />
            <button className="primary" onClick={() => go(`/instrument/${encodeURIComponent(p.symbol)}`)}>Trade {p.symbol}</button>
          </div>
        ))}
      </Card>
      <Card title="Allocation">
        <div className="alloc" role="img" aria-label="Allocation bar">{alloc.map((x, i) => <span key={x.k} style={{ flexGrow: x.v / allocTotal, background: `var(--c${i % 8})` }} title={`${x.k}: ${usd(x.v)}`} />)}</div>
        <ul className="legend">{alloc.map((x, i) => <li key={x.k}><span className="sw" style={{ background: `var(--c${i % 8})` }} />{x.k} {pct(x.v / allocTotal, 1)} <span className="muted">{usd(x.v, 0)}</span></li>)}</ul>
        <Explain>Allocation uses gross market values (shorts shown by size). Free cash excludes short-sale proceeds held as collateral.</Explain>
      </Card>
    </div>
  );
}
