import { z } from 'zod';
import { D, ZERO, isDecimalString, type Dec } from './money';
import { RULES, computeFees, type ExecutionModel } from './rules';
import { calendarKnown, dayOrderExpiry, etDate, sessionAt, sessionEndMs, sessionLabel } from './calendar';
import { computeBalances, markFor, reservedShares, type Balances, type Position } from './accounting';
import { isBuy, tickFor } from './execution';
import type { Account, Instrument, LedgerEntry, Order, OrderType, QuoteState, Side, TIF } from './types';

const dec = z.string().refine(isDecimalString, 'must be a decimal number');
export const LegSchema = z.object({
  side: z.enum(['buy', 'sell', 'sell_short', 'buy_to_cover']),
  qty: dec,
  type: z.enum(['market', 'limit', 'stop', 'stop_limit', 'trailing_stop', 'trailing_stop_limit']),
  limitPrice: dec.nullish(),
  stopPrice: dec.nullish(),
  trailType: z.enum(['amount', 'percent']).nullish(),
  trailValue: dec.nullish(),
  limitOffset: dec.nullish(),
  tif: z.enum(['day', 'gtc', 'ioc', 'fok']),
  extended: z.boolean().optional(),
  aon: z.boolean().optional(),
});
export const TicketSchema = z.object({
  accountId: z.string().min(1),
  symbol: z.string().min(1).max(32),
  clientKey: z.string().min(8).max(80),
  strategy: z.enum(['single', 'oco', 'oto', 'otoco']),
  legs: z.array(LegSchema).min(1).max(3),
  condition: z.object({
    logic: z.enum(['all', 'any']),
    terms: z.array(z.object({ symbol: z.string().min(1).max(32), field: z.enum(['last', 'bid', 'ask']), op: z.enum(['gte', 'lte']), value: dec })).min(1).max(2),
  }).nullish(),
  note: z.string().max(500).nullish(),
});
export type LegInput = z.infer<typeof LegSchema>;
export type TicketInput = z.infer<typeof TicketSchema>;

export interface TicketContext {
  now: number;
  account: Account;
  instrument: Instrument;
  instruments: Map<string, Instrument>;
  quote: QuoteState | undefined;
  quoteOf: (s: string) => QuoteState | undefined;
  positions: Position[];
  openOrders: Order[];
  ledger: LedgerEntry[];
  model: ExecutionModel;
  replacing?: Order; // modification: the order being replaced (its reservations are released)
}

export interface LegPreview {
  order: Order;
  estValue: string;
  estFees: string;
  feeLines: string[];
}
export interface TicketPreview {
  errors: string[];
  warnings: string[];
  info: string[];
  legs: LegPreview[];
  before: Balances;
  after: Balances;
}

const LEG_COUNT = { single: 1, oco: 2, oto: 2, otoco: 3 } as const;
const STOP_TYPES: OrderType[] = ['stop', 'stop_limit', 'trailing_stop', 'trailing_stop_limit'];
const SIDE_LABEL: Record<Side, string> = { buy: 'Buy', sell: 'Sell', sell_short: 'Sell short', buy_to_cover: 'Buy to cover' };
export const sideLabel = (s: Side) => SIDE_LABEL[s];
const closes = (open: Side, exit: Side) => (open === 'buy' && exit === 'sell') || (open === 'sell_short' && exit === 'buy_to_cover');

let seq = 0;
export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(seq++ % 1296).toString(36).padStart(2, '0')}${Math.random().toString(36).slice(2, 8)}`;

/** Order types / TIFs offered for an instrument. The UI only shows these; validation enforces them. */
export function allowedFor(inst: Instrument): { types: OrderType[]; tifs: TIF[]; sides: Side[]; extended: boolean; strategies: TicketInput['strategy'][] } {
  if (inst.assetClass === 'crypto') return { types: ['market', 'limit'], tifs: ['gtc', 'ioc'], sides: ['buy', 'sell'], extended: false, strategies: ['single'] };
  return {
    types: ['market', 'limit', 'stop', 'stop_limit', 'trailing_stop', 'trailing_stop_limit'],
    tifs: ['day', 'gtc', 'ioc', 'fok'],
    sides: inst.shortable ? ['buy', 'sell', 'sell_short', 'buy_to_cover'] : ['buy', 'sell', 'buy_to_cover'],
    extended: inst.calendar === 'nyse',
    strategies: ['single', 'oco', 'oto', 'otoco'],
  };
}

export function priceErr(name: string, v: string | null | undefined, inst: Instrument): string | null {
  if (!v) return `${name} is required`;
  const p = D(v);
  if (p.lte(0)) return `${name} must be greater than 0`;
  if (!p.mod(tickFor(inst, p)).eq(0)) return `${name} $${v} is not a multiple of the minimum increment $${tickFor(inst, p).toFixed()}`;
  return null;
}

export function previewTicket(input: TicketInput, ctx: TicketContext): TicketPreview {
  const errors: string[] = [], warnings: string[] = [], info: string[] = [];
  const { instrument: inst, account, now } = ctx;
  const allowed = allowedFor(inst);
  const session = sessionAt(now, inst.calendar);
  const today = etDate(now);
  const others = ctx.openOrders.filter((o) => o.id !== ctx.replacing?.id);
  const before = computeBalances(account, ctx.ledger, ctx.positions, ctx.openOrders, ctx.instruments, today);

  if (account.archived) errors.push('This account is archived. Unarchive it to trade.');
  if (inst.provider === 'demo' && account.mode !== 'demo') errors.push('Demo instruments can only be traded in demo accounts.');
  if (inst.provider !== 'demo' && account.mode === 'demo') errors.push('Demo accounts can only trade DEMO-* instruments (synthetic data).');
  if (inst.calendar === 'nyse' && !calendarKnown(today)) errors.push(`The verified NYSE calendar does not cover ${today}; update src/domain/calendar.ts.`);
  if (!allowed.strategies.includes(input.strategy)) errors.push(`${input.strategy.toUpperCase()} orders are not available for ${inst.assetClass}.`);
  if (input.legs.length !== LEG_COUNT[input.strategy]) errors.push(`${input.strategy.toUpperCase()} needs exactly ${LEG_COUNT[input.strategy]} order leg(s).`);
  if (input.condition && inst.assetClass === 'crypto') errors.push('Contingent orders are only offered for stocks/ETFs.');

  const mark = markFor(ctx.quote, now).price;
  const pos = (dir: 'long' | 'short') => ctx.positions.find((p) => p.symbol === inst.symbol && p.direction === dir)?.qty ?? ZERO;
  const groupId = newId('grp');
  const ocoId = input.strategy === 'oco' || input.strategy === 'otoco' ? newId('oco') : null;
  const legs: LegPreview[] = [];
  const newOrders: Order[] = [];

  input.legs.forEach((leg, i) => {
    const L = input.legs.length > 1 ? `Leg ${i + 1}: ` : '';
    const isChild = (input.strategy === 'oto' || input.strategy === 'otoco') && i > 0;
    const qty = D(leg.qty);
    if (!allowed.types.includes(leg.type)) errors.push(`${L}${leg.type.replace(/_/g, ' ')} orders are not offered for ${inst.assetClass}.`);
    if (!allowed.tifs.includes(leg.tif)) errors.push(`${L}Time in force ${leg.tif.toUpperCase()} is not offered for ${inst.assetClass}.`);
    if (!allowed.sides.includes(leg.side)) errors.push(`${L}${SIDE_LABEL[leg.side]} is not available for ${inst.symbol}${leg.side === 'sell_short' && inst.assetClass === 'equity' ? ' (not shortable per provider)' : ''}.`);
    if (qty.lte(0)) errors.push(`${L}Quantity must be greater than 0.`);
    if (qty.decimalPlaces() > inst.qtyDecimals) errors.push(`${L}${inst.symbol} allows at most ${inst.qtyDecimals} decimal places in quantity.`);
    if (qty.gt(0) && qty.lt(inst.minQty)) errors.push(`${L}Minimum quantity is ${inst.minQty}.`);
    const fractional = !qty.isInteger();
    if (fractional && inst.assetClass === 'equity') {
      if (!inst.fractionable) errors.push(`${L}${inst.symbol} is not eligible for fractional shares.`);
      if (!['market', 'limit'].includes(leg.type) || leg.tif !== 'day' || leg.extended || input.strategy !== 'single' || input.condition)
        errors.push(`${L}Fractional quantities are only supported for single market or limit DAY orders in the regular session.`);
      if (leg.side === 'sell_short' || leg.side === 'buy_to_cover') errors.push(`${L}Fractional short sales are not supported.`);
    }
    if (leg.type === 'limit' || leg.type === 'stop_limit') { const e = priceErr('Limit price', leg.limitPrice, inst); if (e) errors.push(L + e); }
    if (leg.type === 'stop' || leg.type === 'stop_limit') { const e = priceErr('Stop price', leg.stopPrice, inst); if (e) errors.push(L + e); }
    if (leg.type === 'trailing_stop' || leg.type === 'trailing_stop_limit') {
      if (!leg.trailType || !leg.trailValue || D(leg.trailValue).lte(0)) errors.push(`${L}Trailing orders need a positive trail amount ($) or percent (%).`);
      else if (leg.trailType === 'percent' && D(leg.trailValue).gte(100)) errors.push(`${L}Trail percent must be below 100%.`);
      if (leg.type === 'trailing_stop_limit' && (!leg.limitOffset || D(leg.limitOffset).lt(0))) errors.push(`${L}Trailing stop limit needs a limit offset of $0 or more.`);
    }
    if ((leg.tif === 'ioc' || leg.tif === 'fok') && leg.type !== 'limit' && inst.assetClass === 'equity') errors.push(`${L}IOC and FOK are offered for limit orders only.`);
    if (leg.tif === 'ioc' && inst.assetClass === 'crypto' && leg.type !== 'limit') errors.push(`${L}IOC is offered for crypto limit orders only.`);
    if ((leg.tif === 'ioc' || leg.tif === 'fok') && (isChild || input.strategy !== 'single' || input.condition)) errors.push(`${L}IOC/FOK cannot be used inside conditional orders.`);
    if (leg.aon && (leg.type !== 'limit' || leg.tif === 'ioc' || leg.tif === 'fok')) errors.push(`${L}All-or-none is available on DAY/GTC limit orders only.`);
    if (leg.type === 'market' && inst.assetClass === 'equity' && leg.tif !== 'day') errors.push(`${L}Market orders are DAY orders.`);
    if (leg.extended) {
      if (!allowed.extended) errors.push(`${L}Extended-hours trading does not apply to ${inst.assetClass}.`);
      if (leg.type !== 'limit' || leg.tif !== 'day') errors.push(`${L}Extended-hours orders must be DAY limit orders (Fidelity).`);
      if (session !== 'pre' && session !== 'post') errors.push(`${L}Extended-hours orders are entered during pre-market (7:00-9:28 ET) or after hours (4:00-8:00 ET). Now: ${sessionLabel(session)}.`);
      if (input.strategy !== 'single' || input.condition) errors.push(`${L}Extended-hours orders cannot be conditional.`);
    }
    if (STOP_TYPES.includes(leg.type) && leg.stopPrice && mark && !isChild) {
      const sp = D(leg.stopPrice);
      if (isBuy(leg) && sp.lte(mark)) errors.push(`${L}A buy stop must be above the current price ($${mark.toFixed(2)}); otherwise it would trigger immediately.`);
      if (!isBuy(leg) && sp.gte(mark)) errors.push(`${L}A sell stop must be below the current price ($${mark.toFixed(2)}); otherwise it would trigger immediately.`);
    }
    if (isChild) {
      const primary = input.legs[0]!;
      if (!closes(primary.side, leg.side)) errors.push(`${L}Secondary orders must exit the primary position (${primary.side === 'buy' ? 'Sell' : 'Buy to cover'}).`);
      if (qty.gt(primary.qty)) errors.push(`${L}Secondary quantity cannot exceed the primary quantity.`);
    }

    // Position checks for orders that are active immediately.
    if (!isChild) {
      if (leg.side === 'sell') {
        const avail = pos('long').minus(reservedShares(others, inst.symbol, ['sell']));
        const thisTicket = input.strategy === 'oco' ? ZERO : newOrders.filter((o) => o.side === 'sell').reduce((a, o) => a.plus(o.qty), ZERO);
        if (pos('short').gt(0)) errors.push(`${L}You are short ${inst.symbol}; use Buy to cover.`);
        else if (qty.gt(avail.minus(thisTicket))) errors.push(`${L}Not enough shares: ${avail.toFixed()} available to sell (others are held for open orders). To sell shares you do not own, use Sell short in a margin account.`);
      }
      if (leg.side === 'buy_to_cover') {
        const avail = pos('short').minus(reservedShares(others, inst.symbol, ['buy_to_cover']));
        if (qty.gt(avail)) errors.push(`${L}Buy to cover quantity exceeds the open short position not already covered by open orders (${avail.toFixed()}).`);
      }
      if (leg.side === 'buy' && pos('short').gt(0)) errors.push(`${L}You are short ${inst.symbol}; use Buy to cover to close it.`);
      if (leg.side === 'sell_short') {
        if (account.type !== 'margin') errors.push(`${L}Short selling requires a margin account.`);
        if (pos('long').gt(0)) errors.push(`${L}You hold a long position in ${inst.symbol}; sell it before shorting.`);
        if (mark && mark.lt(RULES.margin.minShortPrice)) errors.push(`${L}Shorting stocks under $${RULES.margin.minShortPrice} is not modeled (low-priced short requirements could not be verified).`);
        if (inst.easyToBorrow === false) errors.push(`${L}${inst.symbol} is flagged hard-to-borrow by the data provider; borrow availability and fees cannot be simulated honestly.`);
        else warnings.push(`${L}Borrow availability is assumed and the borrow fee is an estimate (${ctx.model.borrowAnnualPct}%/yr).`);
      }
    }

    // Price assumption used for reservations / estimates.
    let est: Dec | null = null;
    const q = ctx.quote;
    const touchPx = q ? D((isBuy(leg) ? q.ask : q.bid) ?? 0) : ZERO;
    const ref = touchPx.gt(0) ? touchPx : mark;
    if (leg.type === 'limit' || leg.type === 'stop_limit') est = leg.limitPrice ? D(leg.limitPrice) : null;
    else if (leg.type === 'stop') est = leg.stopPrice ? (isBuy(leg) ? D(leg.stopPrice).times('1.02') : D(leg.stopPrice)) : null;
    else if (ref) est = isBuy(leg) ? ref.times('1.02') : ref; // 2% buffer for market/trailing buys
    if (!est) { if (!ref && !isChild) errors.push(`${L}No current quote for ${inst.symbol}; cannot estimate the order value yet.`); est = ZERO; }
    est = est.toDecimalPlaces(8);

    const fees = computeFees(inst.assetClass, leg.side, qty, est, now);
    let expiresAt: number | null = null;
    if (inst.calendar === 'nyse') {
      if (leg.extended) expiresAt = sessionEndMs(now, 'nyse');
      else if (leg.tif === 'gtc') expiresAt = dayOrderExpiry(now + RULES.gtcDays * 86_400_000);
      else if (leg.tif === 'day') expiresAt = dayOrderExpiry(now);
    }
    const order: Order = {
      id: newId('ord'), accountId: account.id, clientKey: i === 0 ? input.clientKey : `${input.clientKey}#${i}`,
      parentId: isChild ? '(primary)' : null,
      ocoId: (input.strategy === 'oco') || (input.strategy === 'otoco' && i > 0) ? ocoId : null,
      groupId: input.strategy === 'single' && !input.condition ? null : groupId,
      symbol: inst.symbol, assetClass: inst.assetClass, side: leg.side, qty: qty.toFixed(), filledQty: '0', avgFillPrice: null,
      type: leg.type, limitPrice: leg.limitPrice ?? null, stopPrice: leg.type.startsWith('trailing') ? null : leg.stopPrice ?? null,
      trailType: leg.trailType ?? null, trailValue: leg.trailValue ?? null, limitOffset: leg.limitOffset ?? null, trailRef: null,
      tif: leg.tif, extended: !!leg.extended, aon: !!leg.aon,
      condition: i === 0 && input.condition ? input.condition : null,
      status: isChild ? 'pending_activation' : i === 0 && input.condition ? 'waiting_condition' : 'open',
      createdAt: now, acceptedAt: isChild || (i === 0 && input.condition) ? null : now, triggeredAt: null,
      expiresAt, closedAt: null, rejectReason: null, replacesId: ctx.replacing?.id ?? null,
      estPrice: est.toFixed(), modelVersion: ctx.model.version, note: input.note ?? null,
    };
    newOrders.push(order);
    legs.push({ order, estValue: qty.times(est).toDecimalPlaces(2).toFixed(), estFees: fees.total.toFixed(2), feeLines: fees.lines });
  });
  if (input.strategy === 'oco' && input.legs.length === 2 && input.legs[0]!.side !== input.legs[1]!.side)
    errors.push('Both OCO legs must have the same action (for example two exits of the same position).');
  if (input.strategy === 'oco' && input.legs.every((l) => l.side === 'sell')) {
    const avail = pos('long').minus(reservedShares(others, inst.symbol, ['sell']));
    for (const l of input.legs) if (D(l.qty).gt(avail)) errors.push(`OCO leg quantity ${l.qty} exceeds the ${avail.toFixed()} shares available.`);
  }

  // Session information
  if (inst.calendar === 'nyse' && !input.legs.some((l) => l.extended) && session !== 'regular')
    info.push(`${sessionLabel(session)}: this order will wait for the next regular session (9:30 ET) before it can execute.`);
  if (inst.calendar === '24x7' && inst.provider === 'demo') info.push('DEMO instrument: synthetic prices on an always-open demo calendar.');

  // Cash account good-faith-violation warning
  if (account.type === 'cash' && input.legs[0]?.side === 'sell') {
    const risky = ctx.positions.find((p) => p.symbol === inst.symbol && p.direction === 'long')?.lots.some((l) => l.fundedUnsettledUntil && l.fundedUnsettledUntil > today);
    if (risky) warnings.push('Some of these shares were bought with unsettled funds. Selling before those funds settle is a good faith violation (3 in 12 months restricts the account for 90 days).');
  }

  const after = computeBalances(account, ctx.ledger, ctx.positions, [...others, ...newOrders.filter((o) => o.status !== 'pending_activation')], ctx.instruments, today);
  const opening = input.legs.some((l, i) => (l.side === 'buy' || l.side === 'sell_short') && !(i > 0 && input.strategy.startsWith('oto')));
  if (opening) {
    if (account.type === 'cash' && (before.restricted ? after.settledCash : after.cash).minus(after.reservedCash).lt(0))
      errors.push(`Insufficient ${before.restricted ? 'settled ' : ''}cash: this order needs about $${after.reservedCash.minus(before.reservedCash).toFixed(2)} but only $${before.buyingPower.toFixed(2)} is available to trade.`);
    if (account.type === 'margin') {
      if (after.excessEquity.lt(0)) errors.push(`Insufficient buying power: the order's margin requirement exceeds available excess equity ($${before.excessEquity.toFixed(2)}).`);
      const borrowing = after.cash.minus(after.shortProceeds).minus(after.reservedCash).lt(0) || input.legs.some((l) => l.side === 'sell_short');
      if (borrowing && before.equity.lt(RULES.margin.minEquity)) errors.push(`Borrowing on margin or short selling requires at least $${RULES.margin.minEquity} of equity.`);
      if (before.marginCall.gt(0)) errors.push('The account has an unmet margin call; only closing orders are allowed.');
    }
  }
  if (inst.provider === 'alpaca' && inst.assetClass === 'equity') info.push('Executions use IEX top-of-book only (not the consolidated NBBO); fills are estimates.');
  return { errors: [...new Set(errors)], warnings, info, legs, before, after };
}
