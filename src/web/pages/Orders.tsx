import { useState } from 'react';
import { api, useApi } from '../api';
import { useApp } from '../App';
import { Badge, Card, ErrorBox, Explain, Field, Help, Modal, Table, Tabs, qty, time, usd } from '../ui';
import type { OrderRow } from '../types';
import type { Fill } from '../../domain/types';

const ACTIVE = ['pending_activation', 'waiting_condition', 'open', 'triggered'];
const tone = (s: string) => (s === 'filled' ? 'good' : s === 'rejected' ? 'bad' : s === 'canceled' || s === 'expired' || s === 'replaced' ? 'neutral' : 'info');
const statusLabel = (o: OrderRow) => (ACTIVE.includes(o.status) && Number(o.filledQty) > 0 ? 'partially filled' : o.status.replace(/_/g, ' '));

export function describe(o: OrderRow): string {
  const px = o.type === 'limit' ? ` @ ${usd(o.limitPrice)}` : o.type === 'stop' ? ` stop ${usd(o.stopPrice)}` : o.type === 'stop_limit' ? ` stop ${usd(o.stopPrice)} lmt ${usd(o.limitPrice)}`
    : o.type.startsWith('trailing') ? ` trail ${o.trailType === 'percent' ? `${o.trailValue}%` : usd(o.trailValue)}${o.stopPrice ? ` (stop now ${usd(o.stopPrice)})` : ''}${o.type === 'trailing_stop_limit' ? ` offset ${usd(o.limitOffset)}` : ''}` : '';
  return `${o.side.replace(/_/g, ' ')} ${qty(o.qty)} ${o.symbol} ${o.type.replace(/_/g, ' ')}${px} · ${o.tif.toUpperCase()}${o.extended ? ' EXT' : ''}${o.aon ? ' AON' : ''}`;
}

export function OrdersTable({ rows, compact }: { rows: OrderRow[]; compact?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <Table rows={rows} rowKey={(o) => o.id} onRow={(o) => setOpen(o.id)} empty="No orders."
        cols={[
          { key: 'd', label: 'Order', render: (o) => <>{describe(o)}{o.ocoId && <Badge>OCO</Badge>}{o.parentId && <Badge>OTO exit</Badge>}{o.condition && <Badge>contingent</Badge>}</> },
          { key: 's', label: 'Status', render: (o) => <><Badge tone={tone(o.status)}>{statusLabel(o)}</Badge><Help k={o.status} /></> },
          { key: 'f', label: 'Filled', render: (o) => `${qty(o.filledQty)}${o.avgFillPrice ? ` @ ${usd(o.avgFillPrice, 4)}` : ''}`, className: 'num' },
          ...(compact ? [] : [{ key: 't', label: 'Created', render: (o: OrderRow) => time(o.createdAt), sort: (o: OrderRow) => o.createdAt }]),
          { key: 'w', label: 'Why / result', render: (o) => <span className="small muted">{ACTIVE.includes(o.status) ? o.waitingReason : o.rejectReason ?? ''}</span> },
        ]} />
      {open && <OrderDetail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

export function OrderDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { account } = useApp();
  const d = useApi<{ order: OrderRow; events: { ts: number; type: string; message: string }[]; fills: Fill[] }>(`/api/orders/${id}`, { accountId: account?.id, intervalMs: 3000 });
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<Record<string, string> | null>(null);
  const o = d.data?.order;
  const active = o && ACTIVE.includes(o.status);
  async function cancel() { setErr(null); try { await api(`/api/orders/${id}/cancel`, { method: 'POST', body: {} }); d.reload(); } catch (e) { setErr((e as Error).message); } }
  async function modify() {
    setErr(null);
    try {
      const body = Object.fromEntries(Object.entries(edit!).filter(([, v]) => v !== ''));
      await api(`/api/orders/${id}/modify`, { method: 'POST', body });
      onClose();
    } catch (e) { setErr((e as Error).message); }
  }
  return (
    <Modal title="Order details" onClose={onClose}>
      {!o ? <div className="empty">Loading…</div> : <>
        <p><strong>{describe(o)}</strong> <Badge tone={tone(o.status)}>{statusLabel(o)}</Badge></p>
        {active && <div className="alert info">{o.waitingReason}</div>}
        {o.rejectReason && <div className="alert bad">{o.rejectReason}</div>}
        <div className="kvs">
          <div className="kv"><span>Filled / remaining</span><span>{qty(o.filledQty)} / {qty(o.remaining)}{o.avgFillPrice && ` · avg ${usd(o.avgFillPrice, 4)}`}</span></div>
          {o.condition && <div className="kv"><span>Condition<Help k="contingent" /></span><span>{o.condition.terms.map((t) => `${t.symbol} ${t.field} ${t.op === 'gte' ? '≥' : '≤'} ${usd(t.value)}`).join(o.condition.logic === 'all' ? ' AND ' : ' OR ')}</span></div>}
          {o.trailRef && <div className="kv"><span>Trail reference (high/low-water)</span><span>{usd(o.trailRef, 4)}</span></div>}
          <div className="kv"><span>Expires</span><span>{time(o.expiresAt)}</span></div>
          <div className="kv"><span>Model</span><span className="small">{o.modelVersion}</span></div>
        </div>
        {active && o.status !== 'triggered' && (edit ? (
          <div className="legbox">
            <div className="grid-fields">
              {!o.ocoId && !o.parentId && !o.condition && <Field label="New total remaining qty"><input inputMode="decimal" value={edit.qty ?? ''} placeholder={o.remaining} onChange={(e) => setEdit({ ...edit, qty: e.target.value })} /></Field>}
              {['limit', 'stop_limit'].includes(o.type) && <Field label="Limit price"><input inputMode="decimal" value={edit.limitPrice ?? ''} placeholder={o.limitPrice ?? ''} onChange={(e) => setEdit({ ...edit, limitPrice: e.target.value })} /></Field>}
              {['stop', 'stop_limit'].includes(o.type) && <Field label="Stop price"><input inputMode="decimal" value={edit.stopPrice ?? ''} placeholder={o.stopPrice ?? ''} onChange={(e) => setEdit({ ...edit, stopPrice: e.target.value })} /></Field>}
              {o.type.startsWith('trailing') && <Field label={`Trail (${o.trailType === 'percent' ? '%' : '$'})`}><input inputMode="decimal" value={edit.trailValue ?? ''} placeholder={o.trailValue ?? ''} onChange={(e) => setEdit({ ...edit, trailValue: e.target.value })} /></Field>}
              {o.type === 'trailing_stop_limit' && <Field label="Limit offset"><input inputMode="decimal" value={edit.limitOffset ?? ''} placeholder={o.limitOffset ?? ''} onChange={(e) => setEdit({ ...edit, limitOffset: e.target.value })} /></Field>}
            </div>
            <Explain>Modifying is cancel-and-replace: the replacement is a new order accepted now, so it can only use market data from this moment on. A trailing order's high/low-water mark restarts.</Explain>
            <div className="row gap"><button className="primary" onClick={modify}>Submit modification</button><button className="ghost" onClick={() => setEdit(null)}>Back</button></div>
          </div>
        ) : <div className="row gap"><button className="ghost" onClick={() => setEdit({})}>Modify</button><button className="danger" onClick={cancel}>Cancel order</button></div>)}
        {active && o.status === 'triggered' && <div className="row gap"><button className="danger" onClick={cancel}>Cancel remaining</button></div>}
        <ErrorBox error={err} />
        {d.data!.fills.length > 0 && <>
          <h3>Executions</h3>
          <Table rows={d.data!.fills} rowKey={(f) => f.id} cols={[
            { key: 't', label: 'Time', render: (f) => time(f.ts) },
            { key: 'q', label: 'Qty', render: (f) => qty(f.qty), className: 'num' },
            { key: 'p', label: 'Price', render: (f) => usd(f.price, 4), className: 'num' },
            { key: 'f', label: 'Fees', render: (f) => usd(f.fees), className: 'num' },
            { key: 'b', label: 'Quote used', render: (f) => { const q = JSON.parse(f.quote); return <span className="small">bid {q.bid}×{q.bidSize} / ask {q.ask}×{q.askSize} ({q.feed})</span>; } },
          ]} />
        </>}
        <h3>Lifecycle</h3>
        <ol className="timeline">{d.data!.events.map((e, i) => <li key={i}><span className="muted small">{time(e.ts)}</span> <Badge>{e.type.replace(/_/g, ' ')}</Badge> {e.message}</li>)}</ol>
      </>}
    </Modal>
  );
}

export function Orders() {
  const { account } = useApp();
  const [tab, setTab] = useState<'active' | 'filled' | 'closed' | 'all' | 'fills'>('active');
  const orders = useApi<OrderRow[]>(account ? `/api/accounts/${account.id}/orders` : null, { accountId: account?.id, intervalMs: 5000 });
  const fills = useApi<Fill[]>(account && tab === 'fills' ? `/api/accounts/${account.id}/fills` : null, { accountId: account?.id });
  const rows = (orders.data ?? []).filter((o) => tab === 'all' || (tab === 'active' ? ACTIVE.includes(o.status) : tab === 'filled' ? o.status === 'filled' : !ACTIVE.includes(o.status) && o.status !== 'filled'));
  return (
    <div className="page">
      <h1>Orders</h1>
      <Explain>Click an order to see why it is waiting, its executions, the exact quote used for each fill, and its full history. Orders persist across restarts; the engine keeps working while the browser is closed as long as the launcher window stays open.</Explain>
      <Card actions={<Tabs label="Order filter" value={tab} onChange={setTab} items={[['active', 'Working'], ['filled', 'Filled'], ['closed', 'Canceled / rejected / expired'], ['all', 'All'], ['fills', 'Executions']]} />}>
        <ErrorBox error={orders.error} />
        {tab === 'fills' ? (
          <Table rows={fills.data ?? []} rowKey={(f) => f.id} empty="No executions yet." cols={[
            { key: 't', label: 'Time', render: (f) => time(f.ts), sort: (f) => f.ts },
            { key: 's', label: 'Symbol', render: (f) => f.symbol, sort: (f) => f.symbol },
            { key: 'd', label: 'Side', render: (f) => f.side.replace(/_/g, ' ') },
            { key: 'q', label: 'Qty', render: (f) => qty(f.qty), className: 'num' },
            { key: 'p', label: 'Price', render: (f) => usd(f.price, 4), className: 'num' },
            { key: 'f', label: 'Fees', render: (f) => usd(f.fees), className: 'num' },
          ]} />
        ) : <OrdersTable rows={rows} />}
      </Card>
    </div>
  );
}
