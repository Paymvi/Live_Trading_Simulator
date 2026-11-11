import { D, min, max, type Dec } from './money';
import type { ExecutionModel } from './rules';
import type { Instrument, MarketEvent, Order, QuoteState } from './types';
import { remaining } from './accounting';

/**
 * Causal fill model. Pure functions: given an order, the latest quote state, the event that just arrived
 * and the model, decide trailing updates, triggers and fills. The service applies the result atomically.
 */

export const isBuy = (o: Pick<Order, 'side'>) => o.side === 'buy' || o.side === 'buy_to_cover';
const isStopType = (o: Order) => o.type === 'stop' || o.type === 'stop_limit' || o.type === 'trailing_stop' || o.type === 'trailing_stop_limit';
const isTrailing = (o: Order) => o.type === 'trailing_stop' || o.type === 'trailing_stop_limit';

/** Minimum price increment: crypto from the asset, equities $0.01 at/above $1 and $0.0001 below. */
export function tickFor(inst: Instrument, px: Dec): Dec {
  if (inst.priceIncrement) return D(inst.priceIncrement);
  return px.gte(1) ? D('0.01') : D('0.0001');
}

/** Executable touch on our side: buys hit the ask, sells the bid. Returns why not when not executable. */
export function touch(q: QuoteState | undefined, buy: boolean, model: ExecutionModel, now: number, notBefore: number):
  { ok: true; price: Dec; size: Dec } | { ok: false; reason: string } {
  if (!q || !q.bid || !q.ask || q.quoteTs === null) return { ok: false, reason: 'No bid/ask quote available yet' };
  if (q.quoteTs < notBefore) return { ok: false, reason: 'Waiting for a quote newer than order acceptance + latency' };
  if (!q.live) return { ok: false, reason: 'Quote not confirmed live (stream disconnected or reconnected since it was received)' };
  if (now - q.quoteTs > model.maxQuoteAgeMs) return { ok: false, reason: `Latest quote is older than ${model.maxQuoteAgeMs / 1000}s` };
  const bid = D(q.bid), ask = D(q.ask);
  const price = buy ? ask : bid;
  const size = D((buy ? q.askSize : q.bidSize) ?? 0);
  if (price.lte(0) || size.lte(0)) return { ok: false, reason: buy ? 'No displayed ask' : 'No displayed bid' };
  if (bid.gt(0) && ask.gt(0)) {
    if (ask.lt(bid)) return { ok: false, reason: 'Crossed quote ignored' };
    const mid = bid.plus(ask).div(2);
    if (ask.minus(bid).div(mid).times(100).gt(model.maxSpreadPct)) return { ok: false, reason: `Spread wider than ${model.maxSpreadPct}% — treated as not executable` };
  }
  return { ok: true, price, size: size.times(model.liquidityMultiplier) };
}

/** Current trailing stop price derived from the reference (high-water for sells, low-water for buys). */
export function trailingStopPrice(o: Order, ref: Dec): Dec {
  const tv = D(o.trailValue ?? 0);
  const delta = o.trailType === 'percent' ? ref.times(tv).div(100) : tv;
  return isBuy(o) ? ref.plus(delta) : ref.minus(delta);
}

export interface Evaluation {
  trailRef?: string;
  stopPrice?: string;
  triggered?: boolean;
  fill?: { qty: Dec; price: Dec; touch: Dec; size: Dec };
  cancelRest?: string; // IOC / FOK remainder cancellation reason
  waiting: string; // human-readable reason when nothing happened
}

/** Reference price an event contributes for trailing / stop checks on this side. */
function refPrices(o: Order, ev: MarketEvent, basis: ExecutionModel['stopTriggerBasis']): Dec[] {
  const out: Dec[] = [];
  if (ev.kind === 'trade' && basis !== 'quote') out.push(D(ev.price));
  if (ev.kind === 'quote' && basis !== 'trade') {
    const p = isBuy(o) ? D(ev.ask) : D(ev.bid); // sell stops watch the bid, buy stops watch the ask
    if (p.gt(0)) out.push(p);
  }
  return out;
}

export function evaluateOrder(o: Order, q: QuoteState | undefined, ev: MarketEvent, model: ExecutionModel, inst: Instrument, now: number): Evaluation {
  const res: Evaluation = { waiting: '' };
  const acceptedAt = o.acceptedAt ?? Infinity;
  if (ev.ts < acceptedAt + model.latencyMs) return { waiting: 'Market data predates order acceptance + latency' };
  const buy = isBuy(o);
  let stop = o.stopPrice ? D(o.stopPrice) : null;

  if (o.status === 'open' && isStopType(o)) {
    const refs = refPrices(o, ev, model.stopTriggerBasis);
    if (isTrailing(o)) {
      let ref = o.trailRef ? D(o.trailRef) : null;
      for (const p of refs) if (ref === null || (buy ? p.lt(ref) : p.gt(ref))) ref = p;
      if (ref === null) return { waiting: 'Waiting for first eligible price to anchor the trail' };
      if (!o.trailRef || !ref.eq(o.trailRef)) {
        res.trailRef = ref.toFixed();
        stop = trailingStopPrice(o, ref).toDecimalPlaces(4);
        res.stopPrice = stop.toFixed();
      }
      stop = stop ?? trailingStopPrice(o, ref);
    }
    const hit = refs.some((p) => (buy ? p.gte(stop!) : p.lte(stop!)));
    if (!hit) return { ...res, waiting: `Waiting: ${buy ? 'ask/trade must rise to' : 'bid/trade must fall to'} stop $${stop!.toFixed(2)}` };
    res.triggered = true;
    // A triggered stop becomes a market/limit order that is sent after latency: it cannot fill on the triggering event.
    return { ...res, waiting: 'Stop triggered — order sent; fills on the next eligible quote' };
  }

  if (o.status !== 'open' && o.status !== 'triggered') return { waiting: 'Not active' };
  const notBefore = (o.status === 'triggered' ? (o.triggeredAt ?? acceptedAt) : acceptedAt) + model.latencyMs;
  if (ev.ts < notBefore) return { waiting: 'Waiting for latency after trigger' };
  const t = touch(q, buy, model, now, notBefore);
  const isImmediate = o.tif === 'ioc' || o.tif === 'fok';
  if (!t.ok) return isImmediate ? { cancelRest: `${o.tif.toUpperCase()}: ${t.reason}`, waiting: t.reason } : { waiting: t.reason };

  let limit: Dec | null = null;
  if (o.type === 'limit' || o.type === 'stop_limit') limit = D(o.limitPrice!);
  if (o.type === 'trailing_stop_limit') {
    const off = D(o.limitOffset ?? 0);
    limit = buy ? D(o.stopPrice!).plus(off) : D(o.stopPrice!).minus(off);
  }
  if (limit && (buy ? t.price.gt(limit) : t.price.lt(limit))) {
    const msg = `${buy ? 'Ask' : 'Bid'} $${t.price.toFixed()} is ${buy ? 'above' : 'below'} limit $${limit.toFixed()}`;
    return isImmediate ? { cancelRest: `${o.tif.toUpperCase()}: ${msg}`, waiting: msg } : { waiting: msg };
  }
  const slip = t.price.times(model.slippageBps).div(10_000);
  let price = buy ? t.price.plus(slip) : t.price.minus(slip);
  if (limit) price = buy ? min(price, limit) : max(price, limit);
  price = price.toDecimalPlaces(inst.assetClass === 'crypto' ? 8 : 4);

  const rem = remaining(o);
  let qty = rem.lte(t.size) ? rem : t.size;
  qty = qty.toDecimalPlaces(inst.qtyDecimals, 1 /* ROUND_DOWN */);
  if ((o.aon || o.tif === 'fok') && qty.lt(rem)) {
    const msg = `Displayed size ${t.size.toFixed()} < remaining ${rem.toFixed()} (all-or-none)`;
    return o.tif === 'fok' ? { cancelRest: `FOK: ${msg}`, waiting: msg } : { waiting: msg };
  }
  if (qty.lte(0)) return { waiting: 'Displayed size too small' };
  res.fill = { qty, price, touch: t.price, size: t.size };
  if (o.tif === 'ioc' && qty.lt(rem)) res.cancelRest = 'IOC: remainder canceled after partial fill';
  res.waiting = '';
  return res;
}


/** Contingent condition check against the latest quote states. */
export function conditionMet(o: Order, quotes: (s: string) => QuoteState | undefined, notBefore: number): boolean {
  if (!o.condition) return true;
  const check = o.condition.terms.map((t) => {
    const q = quotes(t.symbol);
    if (!q) return false;
    const [v, ts] = t.field === 'last' ? [q.last, q.lastTs] : t.field === 'bid' ? [q.bid, q.quoteTs] : [q.ask, q.quoteTs];
    if (!v || ts === null || ts < notBefore) return false;
    return t.op === 'gte' ? D(v).gte(t.value) : D(v).lte(t.value);
  });
  return o.condition.logic === 'all' ? check.every(Boolean) : check.some(Boolean);
}

