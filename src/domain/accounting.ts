import { D, ZERO, max, type Dec } from './money';
import { RULES } from './rules';
import type { Account, Instrument, LedgerEntry, Lot, Order, QuoteState } from './types';

export interface Mark { price: Dec | null; source: 'mid' | 'last' | 'prev_close' | 'none'; ts: number | null; stale: boolean }

/** Valuation (marking) method — separate from execution pricing. Mid of a sane quote, else last trade, else previous close. */
export function markFor(q: QuoteState | undefined, now: number, maxSpreadPct = 5): Mark {
  if (!q) return { price: null, source: 'none', ts: null, stale: true };
  const STALE_MS = 5 * 60_000;
  if (q.bid && q.ask && D(q.bid).gt(0) && D(q.ask).gte(D(q.bid))) {
    const mid = D(q.bid).plus(q.ask).div(2);
    if (D(q.ask).minus(q.bid).div(mid).times(100).lte(maxSpreadPct)) {
      // Prefer a newer last trade when the quote is older.
      if (!(q.last && q.lastTs && q.quoteTs && q.lastTs > q.quoteTs + 60_000))
        return { price: mid, source: 'mid', ts: q.quoteTs, stale: now - (q.quoteTs ?? 0) > STALE_MS };
    }
  }
  if (q.last) return { price: D(q.last), source: 'last', ts: q.lastTs, stale: now - (q.lastTs ?? 0) > STALE_MS };
  if (q.prevClose) return { price: D(q.prevClose), source: 'prev_close', ts: null, stale: true };
  return { price: null, source: 'none', ts: null, stale: true };
}

export interface Position {
  symbol: string;
  assetClass: Lot['assetClass'];
  direction: 'long' | 'short';
  qty: Dec;
  costBasis: Dec; // long: cost; short: proceeds
  avgPrice: Dec;
  mark: Mark;
  marketValue: Dec; // positive for both directions
  unrealized: Dec;
  lots: Lot[];
}

export function buildPositions(lots: Lot[], marks: Map<string, Mark>): Position[] {
  const by = new Map<string, Lot[]>();
  for (const l of lots) if (D(l.openQty).gt(0)) {
    const k = `${l.symbol}|${l.direction}`;
    by.set(k, [...(by.get(k) ?? []), l]);
  }
  return [...by.values()].map((ls) => {
    const f = ls[0]!;
    const qty = ls.reduce((a, l) => a.plus(l.openQty), ZERO);
    const costBasis = ls.reduce((a, l) => a.plus(D(l.openQty).times(l.price)), ZERO);
    const mark = marks.get(f.symbol) ?? { price: null, source: 'none', ts: null, stale: true };
    const px = mark.price ?? costBasis.div(qty); // unmarked positions carry at cost and are flagged stale
    const marketValue = qty.times(px);
    const unrealized = f.direction === 'long' ? marketValue.minus(costBasis) : costBasis.minus(marketValue);
    return { symbol: f.symbol, assetClass: f.assetClass, direction: f.direction, qty, costBasis, avgPrice: costBasis.div(qty), mark, marketValue, unrealized, lots: ls };
  });
}

export interface Balances {
  cash: Dec;
  settledCash: Dec;
  unsettledCredits: Dec;
  shortProceeds: Dec;
  longValue: Dec;
  shortValue: Dec;
  equity: Dec; // net liquidation value
  marginDebit: Dec;
  reservedCash: Dec; // estimated cost of open buy orders
  reservedRequirement: Dec; // margin requirement of open opening orders
  initialRequirement: Dec;
  maintenanceRequirement: Dec;
  excessEquity: Dec;
  buyingPower: Dec; // marginable securities (cash accounts: cash available to trade)
  nonMarginBuyingPower: Dec;
  marginCall: Dec; // maintenance deficiency (0 if none)
  restricted: boolean;
  staleMarks: string[];
}

const isMarginable = (i: Instrument | undefined, px: Dec) => !!i && i.assetClass === 'equity' && i.marginable && px.gt(RULES.margin.lowPriceFull);

export function initialRate(i: Instrument | undefined, px: Dec): Dec {
  return isMarginable(i, px) ? D(RULES.margin.initialLong) : D(1);
}

function maintLong(i: Instrument | undefined, qty: Dec, px: Dec): Dec {
  const mv = qty.times(px);
  if (!isMarginable(i, px)) return mv;
  if (px.lt(RULES.margin.lowPriceFloor)) return max(mv.times(RULES.margin.maintLong), qty.times(RULES.margin.lowPricePerShare));
  return mv.times(RULES.margin.maintLong);
}

/** Remaining quantity of an order. */
export const remaining = (o: Order) => D(o.qty).minus(o.filledQty);

/** Estimated cash needed for a buy order (incl. crypto fee). */
export function orderCostEstimate(o: Pick<Order, 'assetClass' | 'estPrice'>, qty: Dec): Dec {
  const v = qty.times(o.estPrice ?? 0);
  return o.assetClass === 'crypto' ? v.times(1 + Number(RULES.commissions.cryptoPct.value)) : v;
}

/** OCO legs reserve once (the largest leg) — they can never all execute. */
function groupedMax(orders: Order[], f: (o: Order) => Dec): Dec {
  let total = ZERO;
  const oco = new Map<string, Dec>();
  for (const o of orders) {
    const v = f(o);
    if (o.ocoId) oco.set(o.ocoId, max(oco.get(o.ocoId) ?? ZERO, v));
    else total = total.plus(v);
  }
  for (const v of oco.values()) total = total.plus(v);
  return total;
}

const reservingStatus = (o: Order) => o.status === 'open' || o.status === 'triggered' || o.status === 'waiting_condition';

/** Shares of `symbol` committed to working sell orders (OCO legs counted once). */
export function reservedShares(orders: Order[], symbol: string, sides: Order['side'][], excludeId?: string): Dec {
  return groupedMax(orders.filter((o) => o.symbol === symbol && sides.includes(o.side) && reservingStatus(o) && o.id !== excludeId), remaining);
}

export function computeBalances(
  account: Account, ledger: LedgerEntry[], positions: Position[], openOrders: Order[],
  instruments: Map<string, Instrument>, today: string,
): Balances {
  const cash = ledger.reduce((a, e) => a.plus(e.amount), ZERO);
  const unsettledCredits = ledger.reduce((a, e) => (e.settleDate && e.settleDate > today && D(e.amount).gt(0) ? a.plus(e.amount) : a), ZERO);
  const settledCash = cash.minus(unsettledCredits);
  let longValue = ZERO, shortValue = ZERO, shortProceeds = ZERO, initReq = ZERO, maintReq = ZERO;
  const staleMarks: string[] = [];
  for (const p of positions) {
    const px = p.qty.gt(0) ? p.marketValue.div(p.qty) : ZERO;
    const inst = instruments.get(p.symbol);
    if (p.mark.stale) staleMarks.push(p.symbol);
    if (p.direction === 'long') {
      longValue = longValue.plus(p.marketValue);
      initReq = initReq.plus(p.marketValue.times(initialRate(inst, px)));
      maintReq = maintReq.plus(maintLong(inst, p.qty, px));
    } else {
      shortValue = shortValue.plus(p.marketValue);
      shortProceeds = shortProceeds.plus(p.costBasis);
      initReq = initReq.plus(p.marketValue.times(RULES.margin.initialShort));
      maintReq = maintReq.plus(p.marketValue.times(RULES.margin.maintShort));
    }
  }
  const equity = cash.plus(longValue).minus(shortValue);
  const freeCash = cash.minus(shortProceeds); // short-sale proceeds are collateral, not spendable cash
  const marginDebit = freeCash.lt(0) ? freeCash.neg() : ZERO;

  const working = openOrders.filter(reservingStatus);
  const buys = working.filter((o) => o.side === 'buy' || o.side === 'buy_to_cover');
  const reservedCash = groupedMax(buys, (o) => orderCostEstimate(o, remaining(o)));
  const reservedRequirement = groupedMax(working.filter((o) => o.side === 'buy' || o.side === 'sell_short'), (o) => {
    const px = D(o.estPrice ?? 0);
    const v = orderCostEstimate(o, remaining(o));
    return o.side === 'sell_short' ? remaining(o).times(px).times(RULES.margin.initialShort) : v.times(initialRate(instruments.get(o.symbol), px));
  });
  const restricted = !!account.restrictedUntil && account.restrictedUntil >= today;

  let buyingPower: Dec, nonMarginBuyingPower: Dec, excessEquity: Dec;
  if (account.type === 'cash') {
    // Fidelity lets cash accounts buy with unsettled sale proceeds (selling before they settle = good faith violation) unless restricted.
    buyingPower = max(ZERO, (restricted ? settledCash : cash).minus(reservedCash));
    nonMarginBuyingPower = buyingPower;
    excessEquity = buyingPower;
    initReq = longValue; maintReq = longValue;
  } else {
    excessEquity = equity.minus(initReq).minus(reservedRequirement);
    nonMarginBuyingPower = max(ZERO, excessEquity);
    buyingPower = equity.gte(RULES.margin.minEquity)
      ? nonMarginBuyingPower.div(RULES.margin.initialLong)
      : max(ZERO, freeCash.minus(reservedCash)); // below $2,000 equity: no borrowing
  }
  const marginCall = account.type === 'margin' && equity.lt(maintReq) ? maintReq.minus(equity) : ZERO;
  return {
    cash, settledCash, unsettledCredits, shortProceeds, longValue, shortValue, equity, marginDebit,
    reservedCash, reservedRequirement, initialRequirement: initReq, maintenanceRequirement: maintReq,
    excessEquity, buyingPower, nonMarginBuyingPower, marginCall, restricted, staleMarks,
  };
}

/** FIFO lot matching. Returns per-lot closes; the caller persists them. Throws if quantity exceeds open lots. */
export function matchLotsFifo(lots: Lot[], qty: Dec): { lot: Lot; qty: Dec }[] {
  const out: { lot: Lot; qty: Dec }[] = [];
  let left = qty;
  for (const l of [...lots].sort((a, b) => a.openedAt - b.openedAt || a.id.localeCompare(b.id))) {
    if (left.lte(0)) break;
    const take = D(l.openQty).lt(left) ? D(l.openQty) : left;
    if (take.lte(0)) continue;
    out.push({ lot: l, qty: take });
    left = left.minus(take);
  }
  if (left.gt(0)) throw new Error(`Not enough open quantity to close (short by ${left.toFixed()})`);
  return out;
}
