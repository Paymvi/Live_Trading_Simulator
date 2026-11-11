import { useEffect, useMemo, useState } from 'react';
import { api, uid } from '../api';
import { useApp } from '../App';
import { Badge, ErrorBox, Explain, Field, Help, usd } from '../ui';
import type { InstrumentView, OrderType, Preview, Side, TIF } from '../types';
import type { QuoteState } from '../../domain/types';

type Strategy = 'single' | 'oco' | 'oto' | 'otoco';
interface Leg { side: Side; qty: string; type: OrderType; limitPrice: string; stopPrice: string; trailType: 'amount' | 'percent'; trailValue: string; limitOffset: string; tif: TIF; extended: boolean; aon: boolean }
interface Term { symbol: string; field: 'last' | 'bid' | 'ask'; op: 'gte' | 'lte'; value: string }

const TYPE_LABEL: Record<OrderType, string> = { market: 'Market', limit: 'Limit', stop: 'Stop (stop loss)', stop_limit: 'Stop limit', trailing_stop: 'Trailing stop', trailing_stop_limit: 'Trailing stop limit' };
const SIDE_LABEL: Record<Side, string> = { buy: 'Buy', sell: 'Sell', sell_short: 'Sell short', buy_to_cover: 'Buy to cover' };
const TIF_LABEL: Record<TIF, string> = { day: 'Day', gtc: 'Good \'til canceled', ioc: 'Immediate or cancel', fok: 'Fill or kill' };
const exitOf = (s: Side): Side => (s === 'sell_short' ? 'buy_to_cover' : 'sell');

export function Ticket({ inst, quote, initialSide, onPlaced }: { inst: InstrumentView; quote?: QuoteState; initialSide?: Side; onPlaced?: () => void }) {
  const { account } = useApp();
  const a = inst.allowed;
  const crypto = inst.assetClass === 'crypto';
  const ref = quote?.ask ?? quote?.last ?? '';
  const baseLeg = (side: Side, type: OrderType = 'market'): Leg => ({ side, qty: crypto ? '0.01' : '1', type, limitPrice: ref ? Number(ref).toFixed(2) : '', stopPrice: '', trailType: 'percent', trailValue: '5', limitOffset: '0.10', tif: crypto ? 'gtc' : 'day', extended: false, aon: false });
  const [strategy, setStrategy] = useState<Strategy>('single');
  const [legs, setLegs] = useState<Leg[]>([baseLeg(initialSide ?? 'buy')]);
  const [cond, setCond] = useState(false);
  const [terms, setTerms] = useState<Term[]>([{ symbol: inst.symbol, field: 'last', op: 'gte', value: '' }]);
  const [logic, setLogic] = useState<'all' | 'any'>('all');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [key, setKey] = useState(uid());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => { setStrategy('single'); setLegs([baseLeg(initialSide ?? 'buy')]); setPreview(null); setCond(false); setDone(null); setTerms([{ symbol: inst.symbol, field: 'last', op: 'gte', value: '' }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inst.symbol, initialSide]);

  const px = (m: number) => (ref ? (Number(ref) * m).toFixed(2) : '');
  const applyStrategy = (s: Strategy) => {
    setStrategy(s); setPreview(null);
    const p = legs[0]!;
    const entry = s === 'single' ? p : { ...p, type: (p.type === 'market' ? 'limit' : p.type) as OrderType, tif: 'gtc' as TIF, extended: false };
    const exit = exitOf(entry.side), up = entry.side === 'sell_short' ? 0.95 : 1.05, dn = entry.side === 'sell_short' ? 1.05 : 0.95;
    if (s === 'single') setLegs([entry]);
    if (s === 'oco') setLegs([{ ...baseLeg('sell', 'limit'), qty: p.qty, limitPrice: px(1.05), tif: 'gtc' }, { ...baseLeg('sell', 'stop'), qty: p.qty, stopPrice: px(0.95), tif: 'gtc' }]);
    if (s === 'oto') setLegs([entry, { ...baseLeg(exit, 'limit'), qty: entry.qty, limitPrice: px(up), tif: 'gtc' }]);
    if (s === 'otoco') setLegs([entry, { ...baseLeg(exit, 'limit'), qty: entry.qty, limitPrice: px(up), tif: 'gtc' }, { ...baseLeg(exit, 'stop'), qty: entry.qty, stopPrice: px(dn), tif: 'gtc' }]);
  };
  const upd = (i: number, p: Partial<Leg>) => {
    setPreview(null); setDone(null);
    setLegs((ls) => ls.map((l, j) => {
      if (j === i) return { ...l, ...p };
      if (i === 0 && (strategy === 'oto' || strategy === 'otoco')) return { ...l, ...(p.side ? { side: exitOf(p.side) } : {}), ...(p.qty ? { qty: p.qty } : {}) };
      return l;
    }));
  };

  const ticket = useMemo(() => ({
    accountId: account?.id ?? '', symbol: inst.symbol, clientKey: key, strategy,
    legs: legs.map((l) => ({
      side: l.side, qty: l.qty, type: l.type, tif: l.tif, extended: l.extended, aon: l.aon,
      limitPrice: ['limit', 'stop_limit'].includes(l.type) ? l.limitPrice : null,
      stopPrice: ['stop', 'stop_limit'].includes(l.type) ? l.stopPrice : null,
      trailType: l.type.startsWith('trailing') ? l.trailType : null, trailValue: l.type.startsWith('trailing') ? l.trailValue : null,
      limitOffset: l.type === 'trailing_stop_limit' ? l.limitOffset : null,
    })),
    condition: cond ? { logic, terms } : null,
  }), [account?.id, inst.symbol, key, strategy, legs, cond, logic, terms]);

  async function doPreview() {
    setBusy(true); setErr(null);
    try { setPreview(await api<Preview>('/api/orders/preview', { method: 'POST', body: ticket })); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function place() {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ orders: { id: string }[]; preview: Preview | null; duplicate: boolean }>('/api/orders', { method: 'POST', body: ticket });
      if (r.preview?.errors.length) { setPreview(r.preview); return; }
      setDone(`${r.duplicate ? 'Already submitted' : 'Order accepted'} (${r.orders.length} leg${r.orders.length > 1 ? 's' : ''}). Follow it in Orders.`);
      setPreview(null); setKey(uid()); onPlaced?.();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  if (!account) return null;
  const isChild = (i: number) => (strategy === 'oto' || strategy === 'otoco') && i > 0;
  const legName = (i: number) => strategy === 'single' ? '' : strategy === 'oco' ? `Order ${i + 1}` : i === 0 ? 'Primary (entry)' : strategy === 'otoco' ? (i === 1 ? 'Exit A (take profit)' : 'Exit B (protective stop)') : 'Secondary (exit)';

  return (
    <div className="ticket">
      <div className="row wrap gap">
        <Field label="Order kind" help={strategy}>
          <select value={strategy} onChange={(e) => applyStrategy(e.target.value as Strategy)}>
            {a.strategies.map((s) => <option key={s} value={s}>{{ single: 'Single order', oco: 'OCO (one cancels other)', oto: 'OTO (one triggers other)', otoco: 'Bracket (OTOCO)' }[s]}</option>)}
          </select>
        </Field>
        {inst.assetClass === 'equity' && strategy !== 'oco' && (
          <label className="check"><input type="checkbox" checked={cond} onChange={(e) => { setCond(e.target.checked); setPreview(null); }} /> Contingent (wait for a price condition)<Help k="contingent" /></label>
        )}
      </div>
      {crypto && <Explain>Crypto: market and limit orders, 1% fee, cash only, 24/7.<Help k="crypto_fee" /></Explain>}
      {cond && (
        <fieldset className="legbox">
          <legend>Condition{terms.length > 1 ? 's' : ''}</legend>
          {terms.map((t, i) => (
            <div className="row wrap gap" key={i}>
              <Field label="Symbol"><input value={t.symbol} onChange={(e) => setTerms(terms.map((x, j) => (j === i ? { ...x, symbol: e.target.value.toUpperCase() } : x)))} /></Field>
              <Field label="Price"><select value={t.field} onChange={(e) => setTerms(terms.map((x, j) => (j === i ? { ...x, field: e.target.value as Term['field'] } : x)))}><option value="last">Last trade</option><option value="bid">Bid</option><option value="ask">Ask</option></select></Field>
              <Field label="Is"><select value={t.op} onChange={(e) => setTerms(terms.map((x, j) => (j === i ? { ...x, op: e.target.value as Term['op'] } : x)))}><option value="gte">≥ at or above</option><option value="lte">≤ at or below</option></select></Field>
              <Field label="Value ($)"><input inputMode="decimal" value={t.value} onChange={(e) => { setTerms(terms.map((x, j) => (j === i ? { ...x, value: e.target.value } : x))); setPreview(null); }} /></Field>
              {i > 0 && <button className="ghost" onClick={() => setTerms(terms.slice(0, 1))}>Remove</button>}
            </div>
          ))}
          {terms.length === 1 ? <button className="ghost" onClick={() => setTerms([...terms, { symbol: inst.symbol, field: 'last', op: 'lte', value: '' }])}>+ Second condition (multi-contingent)</button>
            : <Field label="Combine"><select value={logic} onChange={(e) => setLogic(e.target.value as 'all' | 'any')}><option value="all">Both must be true (AND)</option><option value="any">Either is enough (OR)</option></select></Field>}
        </fieldset>
      )}
      {legs.map((l, i) => (
        <fieldset className="legbox" key={i}>
          {legName(i) && <legend>{legName(i)}</legend>}
          <div className="grid-fields">
            <Field label="Action" help={l.side}>
              <select value={l.side} disabled={isChild(i)} onChange={(e) => upd(i, { side: e.target.value as Side })}>
                {(isChild(i) ? [l.side] : a.sides).map((s) => <option key={s} value={s}>{SIDE_LABEL[s]}</option>)}
              </select>
            </Field>
            <Field label={crypto ? 'Quantity (coins)' : 'Quantity (shares)'} help={inst.fractionable ? 'fractional' : undefined}>
              <input inputMode="decimal" value={l.qty} onChange={(e) => upd(i, { qty: e.target.value.trim() })} />
            </Field>
            <Field label="Order type" help={l.type}>
              <select value={l.type} onChange={(e) => upd(i, { type: e.target.value as OrderType, ...(e.target.value !== 'limit' ? { extended: false, aon: false } : {}) })}>
                {a.types.filter((t) => !(l.extended && t !== 'limit')).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </select>
            </Field>
            {['limit', 'stop_limit'].includes(l.type) && <Field label="Limit price ($)" help="limit"><input inputMode="decimal" value={l.limitPrice} onChange={(e) => upd(i, { limitPrice: e.target.value.trim() })} /></Field>}
            {['stop', 'stop_limit'].includes(l.type) && <Field label="Stop price ($)" help="stop"><input inputMode="decimal" value={l.stopPrice} onChange={(e) => upd(i, { stopPrice: e.target.value.trim() })} /></Field>}
            {l.type.startsWith('trailing') && <>
              <Field label="Trail by" help="trail_type"><select value={l.trailType} onChange={(e) => upd(i, { trailType: e.target.value as 'amount' | 'percent' })}><option value="percent">Percent (%)</option><option value="amount">Dollars ($)</option></select></Field>
              <Field label={`Trail ${l.trailType === 'percent' ? '(%)' : '($)'}`}><input inputMode="decimal" value={l.trailValue} onChange={(e) => upd(i, { trailValue: e.target.value.trim() })} /></Field>
            </>}
            {l.type === 'trailing_stop_limit' && <Field label="Limit offset ($)" help="limit_offset"><input inputMode="decimal" value={l.limitOffset} onChange={(e) => upd(i, { limitOffset: e.target.value.trim() })} /></Field>}
            <Field label="Time in force" help={l.tif}>
              <select value={l.tif} onChange={(e) => upd(i, { tif: e.target.value as TIF })}>
                {a.tifs.filter((t) => (t === 'ioc' || t === 'fok' ? l.type === 'limit' && strategy === 'single' && !cond && !(crypto && t === 'fok') : !(l.type === 'market' && !crypto && t !== 'day'))).map((t) => <option key={t} value={t}>{TIF_LABEL[t]}</option>)}
              </select>
            </Field>
          </div>
          <div className="row wrap gap">
            {a.extended && strategy === 'single' && !cond && l.type === 'limit' && l.tif === 'day' && (
              <label className="check"><input type="checkbox" checked={l.extended} onChange={(e) => upd(i, { extended: e.target.checked })} /> Extended hours<Help k="extended" /></label>
            )}
            {l.type === 'limit' && (l.tif === 'day' || l.tif === 'gtc') && !crypto && (
              <label className="check"><input type="checkbox" checked={l.aon} onChange={(e) => upd(i, { aon: e.target.checked })} /> All or none<Help k="aon" /></label>
            )}
          </div>
        </fieldset>
      ))}
      <Explain>Previewing estimates cost, fees and buying-power impact without placing anything. Nothing executes until you confirm.</Explain>
      <div className="row gap">
        <button className="primary" onClick={doPreview} disabled={busy}>Preview order</button>
        {preview && preview.errors.length === 0 && <button className="confirm" onClick={place} disabled={busy}>Confirm simulated order</button>}
      </div>
      <ErrorBox error={err} />
      {done && <div className="alert good" role="status">{done}</div>}
      {preview && <PreviewView p={preview} />}
    </div>
  );
}

function PreviewView({ p }: { p: Preview }) {
  return (
    <div className="preview" aria-live="polite">
      {p.errors.map((e) => <div key={e} className="alert bad">{e}</div>)}
      {p.warnings.map((e) => <div key={e} className="alert warn">{e}</div>)}
      {p.info.map((e) => <div key={e} className="alert info">{e}</div>)}
      {p.legs.map((l, i) => (
        <div key={i} className="kv">
          <span>{p.legs.length > 1 ? `Leg ${i + 1}: ` : ''}{l.order.side.replace(/_/g, ' ')} {l.order.qty} {l.order.symbol} — {l.order.type.replace(/_/g, ' ')}</span>
          <span>Est. value {usd(l.estValue)} · est. fees {usd(l.estFees)} {l.order.status === 'pending_activation' && <Badge>activates on primary fill</Badge>}</span>
          {l.feeLines.map((f) => <span key={f} className="muted small">{f}</span>)}
        </div>
      ))}
      <table className="mini">
        <thead><tr><th></th><th>Now</th><th>After order</th></tr></thead>
        <tbody>
          <tr><td>Buying power<Help k="buying_power" /></td><td>{usd(p.before.buyingPower)}</td><td>{usd(p.after.buyingPower)}</td></tr>
          <tr><td>Reserved for orders<Help k="reserved" /></td><td>{usd(p.before.reservedCash)}</td><td>{usd(p.after.reservedCash)}</td></tr>
          <tr><td>Cash<Help k="cash" /></td><td>{usd(p.before.cash)}</td><td>{usd(p.after.cash)} <span className="muted small">(changes on fill)</span></td></tr>
        </tbody>
      </table>
      <p className="muted small">Estimates use the current quote (market buys add a 2% buffer). Actual fills use later live quotes, displayed size and the execution model in Settings.<Help k="slippage" /></p>
    </div>
  );
}
