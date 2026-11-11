import { D, ZERO, cents, min, str, type Dec } from '../domain/money';
import { RULES, DEFAULT_MODEL, computeFees, marginRatePct, type ExecutionModel } from '../domain/rules';
import { addDays, dayOrderExpiry, etDate, sessionAt, settleDate } from '../domain/calendar';
import {
  buildPositions, computeBalances, initialRate, markFor, matchLotsFifo, orderCostEstimate, remaining, type Balances, type Mark, type Position,
} from '../domain/accounting';
import { conditionMet, evaluateOrder, isBuy } from '../domain/execution';
import { newId, previewTicket, priceErr, type TicketInput, type TicketPreview } from '../domain/orders';
import type { Account, AccountType, DataMode, Fill, LedgerEntry, Lot, MarketEvent, Order, QuoteState } from '../domain/types';
import type { LotClose } from '../domain/analytics';
import type { Store } from './db';
import type { MarketHub } from './market';

const ACTIVE = new Set(['pending_activation', 'waiting_condition', 'open', 'triggered']);
export const isActive = (o: Order) => ACTIVE.has(o.status);

export interface AccountState {
  account: Account; ledger: LedgerEntry[]; lots: Lot[]; positions: Position[]; activeOrders: Order[]; balances: Balances; marks: Map<string, Mark>;
}

export class EngineError extends Error { constructor(msg: string, readonly status = 400) { super(msg); } }

export class Engine {
  model: ExecutionModel;
  /** Latest "why is this order still waiting" explanation per order (in memory, recomputed on events). */
  readonly waiting = new Map<string, string>();
  onChange: (accountId: string) => void = () => {};
  private lastTick: number | null = null;
  private lastValuation = new Map<string, number>();

  constructor(readonly store: Store, readonly hub: MarketHub, readonly clock: () => number = Date.now) {
    this.model = { ...DEFAULT_MODEL, ...store.setting<Partial<ExecutionModel>>('execution_model', {}) };
    hub.onEvent = (ev) => this.onEvent(ev);
    hub.onConnection = (scope, up, hadGap) => this.onConnection(scope, up, hadGap);
    this.refreshDemand();
  }

  now() { return this.clock(); }

  setModel(m: Partial<ExecutionModel>) {
    const next = { ...this.model, ...m };
    if (!(next.latencyMs >= 0 && next.latencyMs <= 60_000) || !(next.slippageBps >= 0 && next.slippageBps <= 500) || !(next.liquidityMultiplier > 0 && next.liquidityMultiplier <= 100)
      || !(next.maxQuoteAgeMs >= 1000) || !(next.maxSpreadPct > 0) || !['quote', 'trade', 'either'].includes(next.stopTriggerBasis) || !/^\d+(\.\d+)?$/.test(next.borrowAnnualPct))
      throw new EngineError('Execution model value out of range');
    next.version = `exec-1+${Date.now().toString(36)}`;
    this.model = next;
    this.store.setSetting('execution_model', next);
  }

  // ------------------------------------------------------------------ accounts
  createAccount(p: { name: string; type: AccountType; mode: DataMode; initialCash: string }): Account {
    const amt = D(p.initialCash);
    if (!p.name.trim() || p.name.length > 60) throw new EngineError('Account name is required (max 60 characters).');
    if (amt.lt(0) || amt.gt('1000000000') || amt.decimalPlaces() > 2) throw new EngineError('Starting balance must be between $0 and $1,000,000,000 with at most 2 decimals.');
    const now = this.now();
    const a: Account = { id: newId('acc'), name: p.name.trim(), type: p.type, mode: p.mode, initialCash: amt.toFixed(2), createdAt: now, archived: false, rulesVersion: RULES.version, restrictedUntil: null };
    this.store.tx(() => {
      this.store.putAccount(a);
      this.store.putLedger({ id: newId('led'), accountId: a.id, ts: now, kind: 'INITIAL', amount: amt.toFixed(2), settleDate: null, symbol: null, orderId: null, fillId: null, memo: 'Starting fictional capital' });
      this.snapshotValuation(a.id, now, true);
    });
    return a;
  }

  account(id: string): Account {
    const a = this.store.account(id);
    if (!a) throw new EngineError('Account not found', 404);
    return a;
  }

  updateAccount(id: string, p: { name?: string; archived?: boolean }) {
    const a = this.account(id);
    if (p.name !== undefined) { if (!p.name.trim() || p.name.length > 60) throw new EngineError('Invalid name'); a.name = p.name.trim(); }
    if (p.archived !== undefined) {
      if (p.archived && this.store.activeOrders(id).length) throw new EngineError('Cancel open orders before archiving this account.');
      a.archived = p.archived;
    }
    this.store.putAccount(a);
    this.onChange(id);
    return a;
  }

  resetAccount(id: string, initialCash?: string) {
    const a = this.account(id);
    const amt = D(initialCash ?? a.initialCash);
    if (amt.lt(0) || amt.decimalPlaces() > 2) throw new EngineError('Invalid starting balance');
    const now = this.now();
    this.store.tx(() => {
      this.store.deleteAccountData(id, false);
      Object.assign(a, { initialCash: amt.toFixed(2), createdAt: now, restrictedUntil: null, rulesVersion: RULES.version });
      this.store.putAccount(a);
      this.store.putLedger({ id: newId('led'), accountId: id, ts: now, kind: 'INITIAL', amount: amt.toFixed(2), settleDate: null, symbol: null, orderId: null, fillId: null, memo: 'Starting fictional capital (account reset)' });
      this.snapshotValuation(id, now, true);
    });
    this.refreshDemand();
    this.onChange(id);
  }

  /** Explicit fictional deposits/withdrawals. They are external cash flows, never counted as trading returns. */
  cashFlow(id: string, kind: 'DEPOSIT' | 'WITHDRAWAL', amount: string, memo: string) {
    const amt = D(amount);
    if (amt.lte(0) || amt.decimalPlaces() > 2 || amt.gt('1000000000')) throw new EngineError('Amount must be a positive dollar amount.');
    const st = this.state(id);
    if (kind === 'WITHDRAWAL') {
      const b = st.balances;
      const free = (st.account.type === 'cash' ? b.settledCash : b.cash.minus(b.shortProceeds)).minus(b.reservedCash);
      if (amt.gt(free)) throw new EngineError(`You can withdraw at most $${free.toFixed(2)} (settled cash not reserved for orders; short-sale proceeds are not withdrawable; margin loans are not withdrawn).`);
    }
    const now = this.now();
    this.store.tx(() => {
      this.store.putLedger({ id: newId('led'), accountId: id, ts: now, kind, amount: (kind === 'WITHDRAWAL' ? amt.neg() : amt).toFixed(2), settleDate: null, symbol: null, orderId: null, fillId: null, memo: memo.slice(0, 200) || (kind === 'DEPOSIT' ? 'Fictional deposit' : 'Fictional withdrawal') });
      this.snapshotValuation(id, now, true);
    });
    this.onChange(id);
  }

  marks(symbols: Iterable<string>): Map<string, Mark> {
    const m = new Map<string, Mark>();
    for (const s of symbols) m.set(s, markFor(this.hub.quote(s), this.now(), this.model.maxSpreadPct));
    return m;
  }

  instrumentsFor(symbols: Iterable<string>) {
    const m = new Map<string, NonNullable<ReturnType<MarketHub['instrument']>>>();
    for (const s of symbols) { const i = this.hub.instrument(s); if (i) m.set(s, i); }
    return m;
  }

  state(accountId: string): AccountState {
    const account = this.account(accountId);
    const ledger = this.store.ledger(accountId);
    const lots = this.store.lots(accountId).filter((l) => D(l.openQty).gt(0));
    const activeOrders = this.store.activeOrders(accountId);
    const syms = new Set([...lots.map((l) => l.symbol), ...activeOrders.map((o) => o.symbol)]);
    const marks = this.marks(syms);
    const positions = buildPositions(lots, marks);
    const balances = computeBalances(account, ledger, positions, activeOrders, this.instrumentsFor(syms), etDate(this.now()));
    return { account, ledger, lots, positions, activeOrders, balances, marks };
  }

  // ------------------------------------------------------------------ orders
  private ticketContext(input: TicketInput, replacing?: Order) {
    const inst = this.hub.instrument(input.symbol);
    if (!inst) throw new EngineError(`Unknown instrument ${input.symbol}. Search for it first.`, 404);
    const st = this.state(input.accountId);
    const syms = new Set([inst.symbol, ...st.positions.map((p) => p.symbol), ...st.activeOrders.map((o) => o.symbol)]);
    return {
      now: this.now(), account: st.account, instrument: inst, instruments: this.instrumentsFor(syms),
      quote: this.hub.quote(inst.symbol), quoteOf: (s: string) => this.hub.quote(s),
      positions: st.positions, openOrders: st.activeOrders, ledger: st.ledger, model: this.model, replacing,
    };
  }

  preview(input: TicketInput): TicketPreview {
    const ctx = this.ticketContext(input);
    const p = previewTicket(input, ctx);
    if (this.store.setting<{ blocked: string[] }>('corp_status', { blocked: [] }).blocked.includes(input.symbol))
      p.errors.push(`${input.symbol} has a corporate action that could not be applied reliably; trading it is blocked until resolved (see Settings → Data health).`);
    const symbols = [input.symbol, ...(input.condition?.terms.map((t) => t.symbol) ?? [])];
    for (const s of symbols) {
      if (!this.hub.instrument(s)) p.errors.push(`Unknown condition symbol ${s}.`);
      else if (!this.hub.canStream(s)) p.errors.push(`${s} cannot be monitored: ${this.hub.alpaca ? 'the free IEX stream is limited to 30 symbols and all slots are used by open orders/positions' : 'no live data provider is configured (add an Alpaca key in Settings)'}.`);
    }
    return p;
  }

  place(input: TicketInput): { orders: Order[]; preview: TicketPreview | null; duplicate: boolean } {
    const existing = this.store.orderByKey(input.accountId, input.clientKey);
    if (existing) { // idempotent resubmission (double click, second tab, retry after timeout)
      const group = existing.groupId ? this.store.orders(input.accountId).filter((o) => o.groupId === existing.groupId) : [existing];
      return { orders: group, preview: null, duplicate: true };
    }
    const preview = this.preview(input);
    if (preview.errors.length) return { orders: [], preview, duplicate: false };
    const now = this.now();
    const orders = preview.legs.map((l) => l.order);
    const primary = orders[0]!;
    this.store.tx(() => {
      for (const o of orders) {
        if (o.parentId === '(primary)') o.parentId = primary.id;
        this.store.putOrder(o);
        const why = o.status === 'pending_activation' ? 'waits for the primary order to fill'
          : o.status === 'waiting_condition' ? 'waits for its price condition' : ['regular', 'continuous'].includes(sessionAt(now, this.hub.instrument(o.symbol)!.calendar)) || o.extended ? 'is working' : 'is queued for the next regular session';
        this.store.orderEvent(o, now, 'accepted', `Accepted (simulated). Order ${why}.`, { estPrice: o.estPrice, model: this.model.version });
      }
    });
    this.refreshDemand();
    this.onChange(input.accountId);
    return { orders, preview, duplicate: false };
  }

  cancel(orderId: string, reason = 'Canceled by you', status: 'canceled' | 'expired' | 'rejected' = 'canceled', cascadeOco = true) {
    const o = this.store.order(orderId);
    if (!o) throw new EngineError('Order not found', 404);
    if (!isActive(o)) throw new EngineError(`Order is already ${o.status}.`);
    this.store.tx(() => this.closeOrder(o, status, reason, cascadeOco));
    this.refreshDemand();
    this.onChange(o.accountId);
  }

  private closeOrder(o: Order, status: 'canceled' | 'expired' | 'rejected', reason: string, cascadeOco: boolean) {
    const fresh = this.store.order(o.id)!;
    if (!isActive(fresh)) return;
    const now = this.now();
    Object.assign(fresh, { status, closedAt: now, rejectReason: status === 'rejected' ? reason : fresh.rejectReason });
    this.store.putOrder(fresh);
    const partial = D(fresh.filledQty).gt(0) ? ` after partial fill of ${fresh.filledQty}` : '';
    this.store.orderEvent(fresh, now, status, `${reason}${partial}.`);
    this.waiting.delete(fresh.id);
    if (cascadeOco && fresh.ocoId) for (const s of this.store.activeOrders(fresh.accountId).filter((x) => x.ocoId === fresh.ocoId && x.id !== fresh.id))
      this.closeOrder(s, 'canceled', 'Linked OCO order canceled together', false);
    if (D(fresh.filledQty).eq(0)) for (const c of this.store.activeOrders(fresh.accountId).filter((x) => x.parentId === fresh.id))
      this.closeOrder(c, 'canceled', 'Primary order ended without a fill, so this secondary order was canceled', false);
  }

  modify(orderId: string, ch: { qty?: string; limitPrice?: string; stopPrice?: string; trailValue?: string; limitOffset?: string; tif?: Order['tif'] }): Order {
    const o = this.store.order(orderId);
    if (!o) throw new EngineError('Order not found', 404);
    if (!['open', 'waiting_condition', 'pending_activation'].includes(o.status)) throw new EngineError(o.status === 'triggered' ? 'A triggered stop is already executing and cannot be modified; cancel it instead.' : `Order is ${o.status}.`);
    const inst = this.hub.instrument(o.symbol)!;
    const linked = !!(o.ocoId || o.parentId || o.condition || this.store.activeOrders(o.accountId).some((c) => c.parentId === o.id));
    const newQty = ch.qty !== undefined ? D(ch.qty) : remaining(o);
    if (linked && (ch.qty !== undefined || ch.tif !== undefined)) throw new EngineError('For linked/conditional orders only prices can be modified. Cancel and re-enter to change quantity or time in force.');
    const leg = {
      side: o.side, qty: newQty.toFixed(), type: o.type, limitPrice: ch.limitPrice ?? o.limitPrice, stopPrice: ch.stopPrice ?? o.stopPrice,
      trailType: o.trailType, trailValue: ch.trailValue ?? o.trailValue, limitOffset: ch.limitOffset ?? o.limitOffset, tif: ch.tif ?? o.tif, extended: o.extended, aon: o.aon,
    };
    let replacement: Order;
    if (!linked) {
      const input: TicketInput = { accountId: o.accountId, symbol: o.symbol, clientKey: `${o.clientKey ?? o.id}~${Date.now().toString(36)}`, strategy: 'single', legs: [leg], note: o.note };
      const p = previewTicket(input, this.ticketContext(input, o));
      if (p.errors.length) throw new EngineError(p.errors.join(' '));
      replacement = p.legs[0]!.order;
    } else {
      for (const [n, v] of [['Limit price', leg.limitPrice], ['Stop price', leg.stopPrice]] as const)
        if ((n === 'Limit price' ? ['limit', 'stop_limit'] : ['stop', 'stop_limit']).includes(o.type)) { const e = priceErr(n, v, inst); if (e) throw new EngineError(e); }
      if (leg.trailValue !== null && o.type.startsWith('trailing') && D(leg.trailValue).lte(0)) throw new EngineError('Trail must be positive');
      replacement = { ...o, id: newId('ord'), clientKey: `${o.clientKey ?? o.id}~${Date.now().toString(36)}`, qty: newQty.toFixed(), filledQty: '0', avgFillPrice: null,
        limitPrice: leg.limitPrice, stopPrice: leg.stopPrice, trailValue: leg.trailValue, limitOffset: leg.limitOffset, trailRef: null, replacesId: o.id };
    }
    const now = this.now();
    Object.assign(replacement, { status: o.status, acceptedAt: o.status === 'open' ? now : null, condition: o.condition, ocoId: o.ocoId, parentId: o.parentId, groupId: o.groupId, createdAt: now, triggeredAt: null, replacesId: o.id });
    if (o.status !== 'open') replacement.expiresAt = o.expiresAt;
    this.store.tx(() => {
      const fresh = this.store.order(o.id)!;
      if (!['open', 'waiting_condition', 'pending_activation'].includes(fresh.status) || fresh.filledQty !== o.filledQty) throw new EngineError('The order changed while modifying (it may have filled). Review it and try again.', 409);
      Object.assign(fresh, { status: 'replaced', closedAt: now });
      this.store.putOrder(fresh);
      this.store.orderEvent(fresh, now, 'replaced', `Replaced by modified order ${replacement.id}.`);
      this.store.putOrder(replacement);
      this.store.orderEvent(replacement, now, 'accepted', `Modified order accepted (replaces ${o.id}). Market data before this moment cannot fill it.`);
      for (const c of this.store.activeOrders(o.accountId).filter((x) => x.parentId === o.id)) { c.parentId = replacement.id; this.store.putOrder(c); }
    });
    this.onChange(o.accountId);
    return replacement;
  }

  // ------------------------------------------------------------------ events
  private liveQuote = (s: string): QuoteState | undefined => { const q = this.hub.quote(s); return q?.live ? q : undefined; };

  onEvent(ev: MarketEvent) {
    const now = this.now();
    const touched = new Set<string>();
    // 1. contingent orders whose condition references this symbol
    for (const o of this.store.activeOrders().filter((x) => x.status === 'waiting_condition' && x.condition?.terms.some((t) => t.symbol === ev.symbol))) {
      if (o.expiresAt && ev.ts >= o.expiresAt) continue;
      if (conditionMet(o, this.liveQuote, o.createdAt + this.model.latencyMs)) {
        this.store.tx(() => {
          const f = this.store.order(o.id)!;
          if (f.status !== 'waiting_condition') return;
          Object.assign(f, { status: 'open', acceptedAt: ev.ts });
          this.store.putOrder(f);
          this.store.orderEvent(f, now, 'condition_met', `Condition met on ${ev.symbol} ${ev.kind} at ${new Date(ev.ts).toISOString()}; order is now working.`);
        });
        touched.add(o.accountId);
      } else this.waiting.set(o.id, 'Waiting for its price condition to be met on fresh live data');
    }
    // 2. working orders on this symbol, oldest acceptance first
    const inst = this.hub.instrument(ev.symbol);
    if (!inst) return;
    const q = this.hub.quote(ev.symbol);
    const working = this.store.activeOrders().filter((o) => o.symbol === ev.symbol && (o.status === 'open' || o.status === 'triggered'))
      .sort((a, b) => (a.acceptedAt ?? 0) - (b.acceptedAt ?? 0) || a.createdAt - b.createdAt);
    for (const snap of working) {
      const o = this.store.order(snap.id)!; // re-read: an earlier fill may have canceled it (OCO)
      if (!isActive(o) || (o.status !== 'open' && o.status !== 'triggered')) continue;
      if (o.expiresAt && ev.ts >= o.expiresAt) continue;
      const s = sessionAt(ev.ts, inst.calendar);
      const okSession = s === 'continuous' || s === 'regular' || (o.extended && (s === 'pre' || s === 'post'));
      if (!okSession) { this.waiting.set(o.id, o.extended ? 'Outside its extended-hours session' : 'Market closed — waits for the regular session (9:30-16:00 ET)'); continue; }
      const r = evaluateOrder(o, q, ev, this.model, inst, now);
      if (r.trailRef || r.triggered) {
        this.store.tx(() => {
          const f = this.store.order(o.id)!;
          if (r.trailRef) { f.trailRef = r.trailRef; f.stopPrice = r.stopPrice ?? f.stopPrice; }
          if (r.triggered) {
            Object.assign(f, { status: 'triggered', triggeredAt: ev.ts });
            const basis = ev.kind === 'trade' ? `trade at $${ev.price}` : `${isBuy(f) ? 'ask' : 'bid'} $${isBuy(f) ? ev.ask : ev.bid}`;
            this.store.orderEvent(f, now, 'triggered', `Stop $${f.stopPrice} triggered by ${basis} (${ev.feed}). It now executes as a ${f.type === 'stop' || f.type === 'trailing_stop' ? 'market' : 'limit'} order; the stop price is not guaranteed.`);
          }
          this.store.putOrder(f);
        });
        touched.add(o.accountId);
      }
      if (r.fill) { this.applyFill(o.id, r.fill, ev, q!); touched.add(o.accountId); }
      if (r.cancelRest) { const f = this.store.order(o.id)!; if (isActive(f)) { this.cancel(f.id, r.cancelRest, 'canceled', false); touched.add(o.accountId); } }
      if (r.waiting) this.waiting.set(o.id, r.waiting); else this.waiting.delete(o.id);
    }
    for (const a of touched) this.onChange(a);
  }

  private applyFill(orderId: string, f: { qty: Dec; price: Dec; touch: Dec; size: Dec }, ev: MarketEvent, q: QuoteState) {
    const now = this.now();
    let refresh = false;
    this.store.tx(() => {
      const o = this.store.order(orderId)!;
      if (!isActive(o)) return;
      const fillId = `fil_${o.id}_${ev.kind}_${ev.ts}`;
      if (this.store.fill(fillId)) return; // idempotent: an event is never applied twice to the same order
      const inst = this.hub.instrument(o.symbol)!;
      const qty = min(f.qty, remaining(o));
      const price = f.price;
      const value = cents(qty.times(price));
      const fees = computeFees(o.assetClass, o.side, qty, price, now);
      const st = this.state(o.accountId);
      const a = st.account, b = st.balances;
      const today = etDate(now);
      const reject = (why: string) => { this.closeOrder(o, D(o.filledQty).gt(0) ? 'canceled' : 'rejected', why, true); refresh = true; };

      // execution-time checks (prices may have moved since placement)
      if (o.side === 'buy' || o.side === 'buy_to_cover') {
        const own = orderCostEstimate(o, remaining(o));
        const need = value.plus(fees.total);
        if (a.type === 'cash') {
          const avail = (b.restricted ? b.settledCash : b.cash).minus(b.reservedCash).plus(own);
          if (need.gt(avail)) return reject(`Insufficient cash at execution: needs $${need.toFixed(2)}, $${avail.toFixed(2)} available`);
        } else if (o.side === 'buy') {
          const ownReq = own.times(initialRate(inst, D(o.estPrice ?? price)));
          const req = need.times(initialRate(inst, price));
          if (req.gt(b.excessEquity.plus(ownReq))) return reject(`Insufficient buying power at execution: margin requirement $${req.toFixed(2)} exceeds excess equity`);
          if (need.gt(b.cash.minus(b.shortProceeds).minus(b.reservedCash).plus(own)) && b.equity.lt(RULES.margin.minEquity)) return reject('Borrowing on margin requires $2,000 of equity');
        }
      }
      if (o.side === 'sell_short') {
        const req = value.times(RULES.margin.initialShort);
        const ownReq = remaining(o).times(o.estPrice ?? price).times(RULES.margin.initialShort);
        if (req.gt(b.excessEquity.plus(ownReq))) return reject('Insufficient margin equity to short at the execution price');
      }
      const dir = o.side === 'buy' || o.side === 'sell' ? 'long' : 'short';
      const posLots = st.lots.filter((l) => l.symbol === o.symbol && l.direction === dir);
      if ((o.side === 'sell' || o.side === 'buy_to_cover') && posLots.reduce((x, l) => x.plus(l.openQty), ZERO).lt(qty)) return reject('Position is no longer large enough for this exit');

      // ledger
      const sd = settleDate(ev.ts, inst.calendar, RULES.settlement.equityTPlus);
      const kind = ({ buy: 'BUY', sell: 'SELL', sell_short: 'SHORT', buy_to_cover: 'COVER' } as const)[o.side];
      const signed = isBuy(o) ? value.neg() : value;
      const memo = `${kind} ${qty.toFixed()} ${o.symbol} @ $${price.toFixed()}`;
      this.store.putLedger({ id: newId('led'), accountId: o.accountId, ts: now, kind, amount: signed.toFixed(2), settleDate: sd, symbol: o.symbol, orderId: o.id, fillId, memo });
      if (fees.total.gt(0)) this.store.putLedger({ id: newId('led'), accountId: o.accountId, ts: now, kind: 'FEE', amount: fees.total.neg().toFixed(2), settleDate: sd, symbol: o.symbol, orderId: o.id, fillId, memo: fees.lines.join('; ') });

      // lots
      if (o.side === 'buy' || o.side === 'sell_short') {
        let fundedUnsettledUntil: string | null = null;
        if (a.type === 'cash' && o.side === 'buy' && value.plus(fees.total).gt(b.settledCash.minus(b.reservedCash).plus(orderCostEstimate(o, remaining(o))))) {
          fundedUnsettledUntil = st.ledger.filter((e) => e.settleDate && e.settleDate > today && D(e.amount).gt(0)).map((e) => e.settleDate!).sort().at(-1) ?? null;
        }
        this.store.putLot({ id: newId('lot'), accountId: o.accountId, symbol: o.symbol, assetClass: o.assetClass, direction: dir, openQty: qty.toFixed(), origQty: qty.toFixed(), price: price.toFixed(), openFee: fees.total.toFixed(), openedAt: now, openFillId: fillId, fundedUnsettledUntil });
      } else {
        for (const m of matchLotsFifo(posLots, qty)) {
          const l = m.lot;
          const openFeeShare = D(l.openFee).times(m.qty).div(l.openQty);
          const closeFeeShare = fees.total.times(m.qty).div(qty);
          const gross = dir === 'long' ? price.minus(l.price).times(m.qty) : D(l.price).minus(price).times(m.qty);
          const c: LotClose = { id: newId('lc'), accountId: o.accountId, lotId: l.id, fillId, orderId: o.id, symbol: o.symbol, direction: dir, qty: m.qty.toFixed(), openPrice: l.price, closePrice: price.toFixed(), openedAt: l.openedAt, closedAt: now, gross: gross.toDecimalPlaces(6).toFixed(), fees: openFeeShare.plus(closeFeeShare).toDecimalPlaces(6).toFixed() };
          this.store.putLotClose(c);
          if (a.type === 'cash' && dir === 'long' && l.fundedUnsettledUntil && l.fundedUnsettledUntil > today) this.goodFaithViolation(a, o, l, now);
          l.openQty = D(l.openQty).minus(m.qty).toFixed();
          l.openFee = D(l.openFee).minus(openFeeShare).toFixed();
          this.store.putLot(l);
        }
      }

      // fill + order
      const fill: Fill = {
        id: fillId, orderId: o.id, accountId: o.accountId, symbol: o.symbol, side: o.side, qty: qty.toFixed(), price: price.toFixed(), fees: fees.total.toFixed(2), ts: now, eventTs: ev.ts,
        quote: JSON.stringify({ bid: q.bid, ask: q.ask, bidSize: q.bidSize, askSize: q.askSize, quoteTs: q.quoteTs, last: q.last, feed: q.feed }),
        model: JSON.stringify({ ...this.model, touch: f.touch.toFixed(), availableSize: f.size.toFixed() }), reconstructed: false,
      };
      this.store.putFill(fill);
      const filled = D(o.filledQty).plus(qty);
      o.avgFillPrice = (o.avgFillPrice ? D(o.avgFillPrice).times(o.filledQty).plus(price.times(qty)) : price.times(qty)).div(filled).toDecimalPlaces(6).toFixed();
      o.filledQty = filled.toFixed();
      const done = filled.gte(o.qty);
      if (done) Object.assign(o, { status: 'filled', closedAt: now });
      this.store.putOrder(o);
      const slip = isBuy(o) ? price.minus(f.touch) : f.touch.minus(price);
      this.store.orderEvent(o, now, done ? 'filled' : 'partial_fill',
        `${done ? 'Filled' : 'Partially filled'} ${qty.toFixed()} @ $${price.toFixed()} (${isBuy(o) ? 'ask' : 'bid'} $${f.touch.toFixed()} on ${q.feed}, slippage $${slip.toFixed(4)}/unit, displayed size ${f.size.toFixed()}). ${done ? '' : `Remaining ${remaining(o).toFixed()} keeps working.`}`.trim(),
        { fillId, fees: fees.lines });

      // linked orders
      if (o.ocoId) for (const s of this.store.activeOrders(o.accountId).filter((x) => x.ocoId === o.ocoId && x.id !== o.id))
        this.closeOrder(s, 'canceled', 'OCO: the linked order executed', false);
      for (const c of this.store.activeOrders(o.accountId).filter((x) => x.parentId === o.id)) {
        const target = D(o.filledQty);
        const before = c.status;
        c.qty = (D(c.filledQty).gt(target) ? D(c.filledQty) : target).toFixed(); // secondary orders follow the primary's filled quantity
        if (c.status === 'pending_activation') {
          Object.assign(c, { status: 'open', acceptedAt: ev.ts, estPrice: c.limitPrice ?? c.stopPrice ?? price.toFixed(), expiresAt: inst.calendar === 'nyse' ? dayOrderExpiry(c.tif === 'gtc' ? now + RULES.gtcDays * 86_400_000 : now) : null });
        }
        this.store.putOrder(c);
        this.store.orderEvent(c, now, before === 'pending_activation' ? 'activated' : 'resized', before === 'pending_activation' ? `Primary order filled; this order is now working for ${c.qty}.` : `Primary filled more; quantity resized to ${c.qty}.`);
      }
      this.snapshotValuation(o.accountId, now, true);
      refresh = true;
    });
    if (refresh) this.refreshDemand();
  }

  private goodFaithViolation(a: Account, o: Order, l: Lot, now: number) {
    const detail = `Sold ${o.symbol} bought with funds that settle ${l.fundedUnsettledUntil} before they settled.`;
    this.store.addViolation(a.id, now, 'good_faith', detail);
    this.store.orderEvent(o, now, 'violation', `Good faith violation (cash account): ${detail}`);
    const since = now - RULES.cashAccount.windowDays * 86_400_000;
    const n = this.store.violations(a.id).filter((v) => v.kind === 'good_faith' && v.ts >= since).length;
    if (n >= RULES.cashAccount.gfvLimit) {
      a.restrictedUntil = addDays(etDate(now), RULES.cashAccount.restrictionDays);
      this.store.putAccount(a);
      this.store.orderEvent(o, now, 'restriction', `${n} good faith violations in 12 months: purchases limited to settled cash until ${a.restrictedUntil}.`);
    }
  }

  // ------------------------------------------------------------------ connection / time
  private onConnection(scope: string, up: boolean, hadGap: boolean) {
    if (up && !hadGap) return; // first connection, not the end of a gap
    const now = this.now();
    const affected = this.store.activeOrders().filter((o) => {
      const i = this.hub.instrument(o.symbol);
      return i && this.hub.scopeOf(i) === scope && (o.status === 'open' || o.status === 'triggered' || o.status === 'waiting_condition');
    });
    if (!affected.length) return;
    this.store.tx(() => {
      for (const o of affected) this.store.orderEvent(o, now, up ? 'monitoring_resumed' : 'monitoring_gap', up
        ? 'Market data stream reconnected. The order waits for a fresh quote; nothing was filled for the gap.'
        : `Market data stream disconnected. No fills or triggers are simulated until fresh data arrives${o.type.startsWith('trailing') ? '; the trailing high/low-water mark may miss prices during the gap' : ''}.`);
    });
    for (const a of new Set(affected.map((o) => o.accountId))) this.onChange(a);
  }

  /** Called every second by the service. */
  tick() {
    const now = this.now();
    if (this.lastTick !== null && now - this.lastTick > 15_000) {
      this.hub.systemGap(this.lastTick, now);
      const active = this.store.activeOrders();
      this.store.tx(() => {
        for (const o of active) this.store.orderEvent(o, now, 'monitoring_gap', `The service was not running from ${new Date(this.lastTick!).toISOString()} to ${new Date(now).toISOString()} (sleep or pause). No fills were invented for that period; the order waits for fresh data.`);
      });
    }
    this.lastTick = now;
    const changed = new Set<string>();
    for (const o of this.store.activeOrders()) {
      if (o.expiresAt && now >= o.expiresAt) {
        this.store.tx(() => this.closeOrder(o, 'expired', o.extended ? 'Extended-hours session ended' : o.tif === 'gtc' ? 'GTC order reached its 180-day limit' : 'Day order expired at the close', true));
        changed.add(o.accountId);
      } else if ((o.tif === 'ioc' || o.tif === 'fok') && o.status === 'open' && o.acceptedAt && now - o.acceptedAt > this.model.latencyMs + 10_000) {
        this.store.tx(() => this.closeOrder(o, 'canceled', `${o.tif.toUpperCase()}: no executable quote within 10 seconds`, true));
        changed.add(o.accountId);
      }
    }
    for (const a of this.store.accounts().filter((x) => !x.archived)) {
      if (this.accrue(a, now)) changed.add(a.id);
      if (now - (this.lastValuation.get(a.id) ?? 0) >= 5 * 60_000) this.snapshotValuation(a.id, now, false);
    }
    if (changed.size) this.refreshDemand();
    for (const a of changed) this.onChange(a);
  }

  /** Daily margin interest and short borrow fees for each completed ET day (uses the current balance as the estimate). */
  private accrue(a: Account, now: number): boolean {
    if (a.type !== 'margin') return false;
    const key = `accrued:${a.id}`;
    const today = etDate(now);
    let last = this.store.setting<string>(key, etDate(a.createdAt));
    if (last >= today) return false;
    const st = this.state(a.id);
    const debit = st.balances.marginDebit, shortValue = st.balances.shortValue;
    const rate = marginRatePct(debit), borrow = D(this.model.borrowAnnualPct);
    let any = false;
    this.store.tx(() => {
      while (last < today) {
        const day = last;
        last = addDays(last, 1);
        if (day < etDate(a.createdAt)) continue;
        const interest = cents(debit.times(rate).div(100).div(RULES.marginRate.dayCount));
        const bfee = cents(shortValue.times(borrow).div(100).div(360));
        if (interest.gt(0)) { any = true; this.store.putLedger({ id: newId('led'), accountId: a.id, ts: now, kind: 'INTEREST', amount: interest.neg().toFixed(2), settleDate: null, symbol: null, orderId: null, fillId: null, memo: `Margin interest for ${day}: $${debit.toFixed(2)} debit × ${rate.toFixed(3)}% / ${RULES.marginRate.dayCount} (estimate)` }); }
        if (bfee.gt(0)) { any = true; this.store.putLedger({ id: newId('led'), accountId: a.id, ts: now, kind: 'BORROW_FEE', amount: bfee.neg().toFixed(2), settleDate: null, symbol: null, orderId: null, fillId: null, memo: `Short borrow fee for ${day}: $${shortValue.toFixed(2)} × ${borrow.toFixed()}% / 360 (assumed rate)` }); }
      }
      this.store.setSetting(key, today);
    });
    return any;
  }

  snapshotValuation(accountId: string, now: number, force: boolean) {
    if (!force && now - (this.lastValuation.get(accountId) ?? 0) < 60_000) return;
    const st = this.state(accountId);
    const b = st.balances;
    this.store.putValuation(accountId, { ts: now, equity: str(b.equity.toDecimalPlaces(2)), cash: str(b.cash.toDecimalPlaces(2)), longValue: str(b.longValue.toDecimalPlaces(2)), shortValue: str(b.shortValue.toDecimalPlaces(2)), stale: b.staleMarks.length });
    this.lastValuation.set(accountId, now);
  }

  /** Symbols the engine must monitor: open orders, condition symbols, and positions (for valuation). */
  engineSymbols(): string[] {
    const orders = this.store.activeOrders();
    const s = new Set<string>([...orders.map((o) => o.symbol), ...orders.flatMap((o) => o.condition?.terms.map((t) => t.symbol) ?? [])]);
    for (const a of this.store.accounts().filter((x) => !x.archived)) for (const l of this.store.lots(a.id)) if (D(l.openQty).gt(0)) s.add(l.symbol);
    return [...s];
  }

  refreshDemand() { this.hub.setDemand({ engine: this.engineSymbols() }); }

  explainWaiting(o: Order): string {
    if (o.status === 'pending_activation') return 'Waiting for the primary order to fill. It activates (sized to the filled quantity) once it does.';
    if (o.status === 'waiting_condition') return this.waiting.get(o.id) ?? 'Waiting for its price condition on live data.';
    if (o.status === 'triggered') return this.waiting.get(o.id) ?? 'Stop triggered; executing at the next eligible quote.';
    if (o.status === 'open') return this.waiting.get(o.id) ?? 'Waiting for the next eligible market event.';
    return '';
  }
}
