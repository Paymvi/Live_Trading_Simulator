import { describe, expect, it } from 'vitest';
import { D } from '../src/domain/money';
import { etToMs } from '../src/domain/calendar';
import { Engine } from '../src/server/engine';
import { setup } from './helpers';

describe('accounts and accounting', () => {
  it('creates independent accounts with chosen starting capital', () => {
    const t = setup();
    const a = t.account('cash', '100000'), b = t.account('margin', '200000');
    expect(t.balances(a.id).equity.toFixed(2)).toBe('100000.00');
    expect(t.balances(b.id).equity.toFixed(2)).toBe('200000.00');
    expect(t.store.ledger(a.id)).toHaveLength(1);
    expect(t.store.ledger(a.id)[0]!.kind).toBe('INITIAL');
  });

  it('market buy fills at the ask after latency, never from earlier data', () => {
    const t = setup();
    const a = t.account();
    t.quote('XYZ', '99.99', '100.01');
    const [o] = t.place(t.ticket(a.id, 'XYZ', [{ qty: '10' }]));
    // a trade event arrives but the quote predates acceptance -> must not fill
    t.trade('XYZ', '100.00', '10', 50);
    expect(t.order(o!.id).status).toBe('open');
    t.quote('XYZ', '100.00', '100.02', '100', 200);
    const f = t.order(o!.id);
    expect(f.status).toBe('filled');
    expect(f.avgFillPrice).toBe('100.02');
    const b = t.balances(a.id);
    expect(b.cash.toFixed(2)).toBe('98999.80');
    // net liquidation = cash + positions at mark (mid 100.01)
    expect(b.equity.toFixed(2)).toBe(D('98999.80').plus(D('100.01').times(10)).toFixed(2));
  });

  it('sell realizes P&L with FIFO lots and settles T+1; regulatory fees on sales only', () => {
    const t = setup();
    const a = t.account();
    t.quote('XYZ', '100', '100');
    t.place(t.ticket(a.id, 'XYZ', [{ qty: '10' }]));
    t.quote('XYZ', '100', '100');
    t.quote('XYZ', '110', '110');
    t.place(t.ticket(a.id, 'XYZ', [{ qty: '5' }]));
    t.quote('XYZ', '110', '110');
    t.quote('XYZ', '120', '120.02');
    t.place(t.ticket(a.id, 'XYZ', [{ side: 'sell', qty: '12' }]));
    t.quote('XYZ', '120', '120.02');
    const closes = t.store.lotCloses(a.id);
    expect(closes.map((c) => [c.qty, c.openPrice])).toEqual([['10', '100'], ['2', '110']]);
    const gross = closes.reduce((s, c) => s.plus(c.gross), D(0));
    expect(gross.toFixed(2)).toBe('220.00'); // 10*20 + 2*10
    const sale = t.store.ledger(a.id).find((e) => e.kind === 'SELL')!;
    expect(sale.settleDate).toBe('2026-11-11');
    const fee = t.store.ledger(a.id).find((e) => e.kind === 'FEE')!;
    expect(fee.amount).toBe('-0.03'); // SEC 1440*20.60/1e6 = 0.0297 -> 0.03; TAF paused Oct-Dec 2026
    expect(t.balances(a.id).unsettledCredits.toFixed(2)).toBe('1440.00');
  });
});

describe('order types', () => {
  it('limit buy waits until ask <= limit and never pays above the limit', () => {
    const t = setup();
    const a = t.account();
    t.quote('XYZ', '50.00', '50.10');
    const [o] = t.place(t.ticket(a.id, 'XYZ', [{ type: 'limit', limitPrice: '50.00' }]));
    t.quote('XYZ', '50.00', '50.05');
    expect(t.order(o!.id).status).toBe('open');
    expect(t.engine.explainWaiting(t.order(o!.id))).toContain('above limit');
    t.quote('XYZ', '49.90', '49.95');
    expect(t.order(o!.id).avgFillPrice).toBe('49.95');
  });

  it('stop triggers on the bid, fills on a later quote, and can fill below the stop', () => {
    const t = setup();
    const a = t.account();
    t.quote('XYZ', '100', '100.02');
    t.place(t.ticket(a.id, 'XYZ', [{ qty: '10' }]));
    t.quote('XYZ', '100', '100.02');
    const [s] = t.place(t.ticket(a.id, 'XYZ', [{ side: 'sell', type: 'stop', stopPrice: '95.00' }]));
    t.quote('XYZ', '96', '96.02');
    expect(t.order(s!.id).status).toBe('open');
    t.quote('XYZ', '94.50', '94.60'); // gap through the stop
    expect(t.order(s!.id).status).toBe('triggered');
    t.quote('XYZ', '94.00', '94.10');
    expect(t.order(s!.id).status).toBe('filled');
    expect(t.order(s!.id).avgFillPrice).toBe('94');
  });

  it('stop-limit can trigger and remain unfilled', () => {
    const t = setup();
    const a = t.account();
    t.quote('XYZ', '100', '100.02');
    t.place(t.ticket(a.id, 'XYZ', [{ qty: '10' }]));
    t.quote('XYZ', '100', '100.02');
    const [s] = t.place(t.ticket(a.id, 'XYZ', [{ side: 'sell', type: 'stop_limit', stopPrice: '95.00', limitPrice: '94.50' }]));
    t.quote('XYZ', '94.00', '94.10');
    t.quote('XYZ', '93.00', '93.10');
    expect(t.order(s!.id).status).toBe('triggered');
    expect(t.engine.explainWaiting(t.order(s!.id))).toContain('below limit');
    t.quote('XYZ', '94.60', '94.70');
    expect(t.order(s!.id).status).toBe('filled');
    expect(D(t.order(s!.id).avgFillPrice!).gte('94.5')).toBe(true);
  });

  it('trailing stop (percent) ratchets the high-water mark and triggers on a pullback', () => {
    const t = setup();
    const a = t.account();
    t.quote('XYZ', '100', '100');
    t.place(t.ticket(a.id, 'XYZ', [{ qty: '10' }]));
    t.quote('XYZ', '100', '100');
    const [s] = t.place(t.ticket(a.id, 'XYZ', [{ side: 'sell', type: 'trailing_stop', trailType: 'percent', trailValue: '5' }]));
    t.quote('XYZ', '100', '100.02');
    t.quote('XYZ', '110', '110.02');
    expect(t.order(s!.id).trailRef).toBe('110');
    expect(t.order(s!.id).stopPrice).toBe('104.5');
    t.quote('XYZ', '106', '106.02');
    expect(t.order(s!.id).trailRef).toBe('110'); // never ratchets down
    t.quote('XYZ', '104.40', '104.45');
    expect(t.order(s!.id).status).toBe('triggered');
    t.quote('XYZ', '104.30', '104.35');
    expect(t.order(s!.id).status).toBe('filled');
  });

  it('trailing stop limit ($ trail) uses stop minus offset as its limit', () => {
    const t = setup();
    const a = t.account();
    t.quote('XYZ', '50', '50');
    t.place(t.ticket(a.id, 'XYZ', [{ qty: '10' }]));
    t.quote('XYZ', '50', '50');
    const [s] = t.place(t.ticket(a.id, 'XYZ', [{ side: 'sell', type: 'trailing_stop_limit', trailType: 'amount', trailValue: '2', limitOffset: '0.50' }]));
    t.quote('XYZ', '52', '52.02');
    t.quote('XYZ', '49.90', '49.95'); // stop = 50 -> triggered; limit 49.50
    t.quote('XYZ', '49.00', '49.05');
    expect(t.order(s!.id).status).toBe('triggered');
    t.quote('XYZ', '49.60', '49.65');
    expect(t.order(s!.id).avgFillPrice).toBe('49.6');
  });

  it('partially fills large orders across quotes using displayed size', () => {
    const t = setup();
    const a = t.account();
    t.quote('XYZ', '10', '10.01', '100');
    const [o] = t.place(t.ticket(a.id, 'XYZ', [{ qty: '250' }]));
    t.quote('XYZ', '10', '10.01', '100');
    expect(t.order(o!.id).filledQty).toBe('100');
    t.quote('XYZ', '10', '10.02', '100');
    t.quote('XYZ', '10', '10.03', '100');
    const f = t.order(o!.id);
    expect(f.status).toBe('filled');
    expect(t.store.orderFills(o!.id)).toHaveLength(3);
    expect(f.avgFillPrice).toBe(D('10.01').times(100).plus(D('10.02').times(100)).plus(D('10.03').times(50)).div(250).toDecimalPlaces(6).toFixed());
  });

  it('IOC cancels the unfilled remainder; FOK cancels when size is insufficient', () => {
    const t = setup();
    const a = t.account();
    t.quote('XYZ', '10', '10.01', '100');
    const [ioc] = t.place(t.ticket(a.id, 'XYZ', [{ qty: '150', type: 'limit', limitPrice: '10.05', tif: 'ioc' }]));
    const [fok] = t.place(t.ticket(a.id, 'XYZ', [{ qty: '150', type: 'limit', limitPrice: '10.05', tif: 'fok' }]));
    t.quote('XYZ', '10', '10.01', '100');
    expect(t.order(ioc!.id).filledQty).toBe('100');
    expect(t.order(ioc!.id).status).toBe('canceled');
    expect(t.order(fok!.id).filledQty).toBe('0');
    expect(t.order(fok!.id).status).toBe('canceled');
  });

  it('all-or-none waits until enough displayed size', () => {
    const t = setup();
    const a = t.account();
    t.quote('XYZ', '10', '10.01', '100');
    const [o] = t.place(t.ticket(a.id, 'XYZ', [{ qty: '300', type: 'limit', limitPrice: '10.05', aon: true }]));
    t.quote('XYZ', '10', '10.01', '100');
    expect(t.order(o!.id).filledQty).toBe('0');
    t.quote('XYZ', '10', '10.02', '400');
    expect(t.order(o!.id).status).toBe('filled');
  });
});

describe('linked orders', () => {
  it('OCO: one leg executes, the other is canceled; shares are reserved once', () => {
    const t = setup();
    const a = t.account();
    t.quote('XYZ', '100', '100');
    t.place(t.ticket(a.id, 'XYZ', [{ qty: '10' }]));
    t.quote('XYZ', '100', '100.02');
    const [tp, sl] = t.place(t.ticket(a.id, 'XYZ', [{ side: 'sell', type: 'limit', limitPrice: '110' }, { side: 'sell', type: 'stop', stopPrice: '90' }], 'oco'));
    // shares are held once for the pair: another 10-share sell is rejected
    expect(t.engine.preview(t.ticket(a.id, 'XYZ', [{ side: 'sell', qty: '1' }])).errors.join()).toContain('Not enough shares');
    t.quote('XYZ', '110', '110.02');
    expect(t.order(tp!.id).status).toBe('filled');
    expect(t.order(sl!.id).status).toBe('canceled');
  });

  it('linked race: both OCO legs executable on one event -> exactly one fills', () => {
    const t = setup();
    const a = t.account();
    t.quote('XYZ', '100', '100');
    t.place(t.ticket(a.id, 'XYZ', [{ qty: '10' }]));
    t.quote('XYZ', '100', '100.02');
    const [l1, l2] = t.place(t.ticket(a.id, 'XYZ', [{ side: 'sell', type: 'limit', limitPrice: '99' }, { side: 'sell', type: 'limit', limitPrice: '98' }], 'oco'));
    t.quote('XYZ', '100', '100.02');
    const st = [t.order(l1!.id).status, t.order(l2!.id).status].sort();
    expect(st).toEqual(['canceled', 'filled']);
    expect(t.engine.state(a.id).positions).toHaveLength(0);
  });

  it('OTOCO: children activate sized to partial primary fills, then resize; exits are one-cancels-other', () => {
    const t = setup();
    const a = t.account();
    t.quote('XYZ', '50', '50.01', '100');
    const [p, tp, sl] = t.place(t.ticket(a.id, 'XYZ', [
      { qty: '200', type: 'limit', limitPrice: '50.05', tif: 'gtc' },
      { side: 'sell', qty: '200', type: 'limit', limitPrice: '55', tif: 'gtc' },
      { side: 'sell', qty: '200', type: 'stop', stopPrice: '45', tif: 'gtc' },
    ], 'otoco'));
    expect(t.order(tp!.id).status).toBe('pending_activation');
    t.quote('XYZ', '50', '50.01', '100');
    expect(t.order(p!.id).filledQty).toBe('100');
    expect(t.order(tp!.id).status).toBe('open');
    expect(t.order(tp!.id).qty).toBe('100');
    t.quote('XYZ', '50', '50.02', '100');
    expect(t.order(tp!.id).qty).toBe('200');
    expect(t.order(sl!.id).qty).toBe('200');
    t.quote('XYZ', '55', '55.02');
    t.quote('XYZ', '55', '55.02');
    expect(t.order(tp!.id).status).toBe('filled');
    expect(t.order(sl!.id).status).toBe('canceled');
    expect(t.engine.state(a.id).positions).toHaveLength(0);
  });

  it('OTO: canceling an unfilled primary cancels the secondary', () => {
    const t = setup();
    const a = t.account();
    t.quote('XYZ', '50', '50.01');
    const [p, c] = t.place(t.ticket(a.id, 'XYZ', [{ type: 'limit', limitPrice: '40' }, { side: 'sell', type: 'limit', limitPrice: '60' }], 'oto'));
    t.engine.cancel(p!.id);
    expect(t.order(c!.id).status).toBe('canceled');
  });

  it('contingent order waits for its condition on another symbol, then fills only on later data', () => {
    const t = setup();
    const a = t.account();
    t.quote('XYZ', '50', '50.01');
    t.quote('LOW', '20', '20.01');
    const [o] = t.place(t.ticket(a.id, 'XYZ', [{ qty: '1' }], 'single', { condition: { logic: 'all', terms: [{ symbol: 'LOW', field: 'last', op: 'gte', value: '21' }] } }));
    t.quote('XYZ', '50', '50.01');
    expect(t.order(o!.id).status).toBe('waiting_condition');
    t.trade('LOW', '21.10');
    expect(t.order(o!.id).status).toBe('open');
    t.quote('XYZ', '50', '50.02');
    expect(t.order(o!.id).status).toBe('filled');
  });
});

describe('funds, margin and shorts', () => {
  it('rejects buys beyond cash and re-checks funds at execution', () => {
    const t = setup();
    const a = t.account('cash', '1000');
    t.quote('XYZ', '100', '100.01');
    expect(t.engine.preview(t.ticket(a.id, 'XYZ', [{ qty: '20' }])).errors.join()).toMatch(/Insufficient/);
    const [o] = t.place(t.ticket(a.id, 'XYZ', [{ qty: '9' }])); // market: reserved at ask + 2% buffer
    // price jumps before the first eligible quote; cost now exceeds cash
    t.quote('XYZ', '114', '115', '100', 200);
    expect(t.order(o!.id).status).toBe('rejected');
    expect(t.order(o!.id).rejectReason).toContain('Insufficient cash');
  });

  it('reserves cash for open buy orders', () => {
    const t = setup();
    const a = t.account('cash', '10000');
    t.quote('XYZ', '100', '100.01');
    t.place(t.ticket(a.id, 'XYZ', [{ qty: '50', type: 'limit', limitPrice: '90' }]));
    expect(t.balances(a.id).reservedCash.toFixed(2)).toBe('4500.00');
    expect(t.balances(a.id).buyingPower.toFixed(2)).toBe('5500.00');
    expect(t.engine.preview(t.ticket(a.id, 'XYZ', [{ qty: '70', type: 'limit', limitPrice: '90' }])).errors.join()).toMatch(/Insufficient/);
  });

  it('margin: 2x buying power for marginable stock, 100% for low-priced stock', () => {
    const t = setup();
    const a = t.account('margin', '10000');
    t.quote('XYZ', '100', '100');
    t.quote('LOW', '2.50', '2.50');
    expect(t.balances(a.id).buyingPower.toFixed(2)).toBe('20000.00');
    expect(t.engine.preview(t.ticket(a.id, 'XYZ', [{ qty: '190', type: 'limit', limitPrice: '100' }])).errors).toEqual([]);
    expect(t.engine.preview(t.ticket(a.id, 'LOW', [{ qty: '5000', type: 'limit', limitPrice: '2.50' }])).errors.join()).toMatch(/Insufficient buying power/);
  });

  it('short sale: needs margin; proceeds are not buying power; cover realizes P&L', () => {
    const t = setup();
    const cash = t.account('cash');
    t.quote('XYZ', '100', '100.02');
    expect(t.engine.preview(t.ticket(cash.id, 'XYZ', [{ side: 'sell_short', qty: '10' }])).errors.join()).toContain('margin account');
    const m = t.account('margin', '10000');
    const before = t.balances(m.id).buyingPower;
    t.place(t.ticket(m.id, 'XYZ', [{ side: 'sell_short', qty: '50' }]));
    t.quote('XYZ', '100', '100.02');
    const b = t.balances(m.id);
    expect(b.shortProceeds.toFixed(2)).toBe('5000.00');
    expect(b.buyingPower.lt(before)).toBe(true); // proceeds did not increase buying power
    expect(b.equity.toFixed(0)).toBe('9999'); // marked at mid 100.01, minus fees
    t.place(t.ticket(m.id, 'XYZ', [{ side: 'buy_to_cover', qty: '50' }]));
    t.quote('XYZ', '90', '90.02');
    t.quote('XYZ', '90', '90.02');
    const c = t.store.lotCloses(m.id)[0]!;
    expect(D(c.gross).toFixed(2)).toBe('499.00'); // (100 - 90.02) * 50
    expect(t.engine.state(m.id).positions).toHaveLength(0);
  });

  it('flags a maintenance margin call', () => {
    const t = setup();
    const a = t.account('margin', '10000');
    t.quote('XYZ', '100', '100');
    t.place(t.ticket(a.id, 'XYZ', [{ qty: '199', type: 'limit', limitPrice: '100' }]));
    t.quote('XYZ', '100', '100', '500');
    t.quote('XYZ', '60', '60');
    expect(t.balances(a.id).marginCall.gt(0)).toBe(true);
    expect(t.engine.preview(t.ticket(a.id, 'XYZ', [{ qty: '1' }])).errors.join()).toContain('margin call');
  });

  it('records good faith violations and restricts to settled cash after three', () => {
    const t = setup();
    const a = t.account('cash', '1000');
    t.quote('XYZ', '100', '100');
    for (let i = 0; i < 4; i++) { // round 1 uses settled cash; rounds 2-4 buy with unsettled proceeds and sell same day
      t.place(t.ticket(a.id, 'XYZ', [{ qty: '9' }]));
      t.quote('XYZ', '100', '100');
      t.place(t.ticket(a.id, 'XYZ', [{ side: 'sell', qty: '9' }]));
      t.quote('XYZ', '100', '100');
    }
    expect(t.store.violations(a.id)).toHaveLength(3);
    expect(t.engine.account(a.id).restrictedUntil).toBe('2027-02-08');
    expect(t.engine.preview(t.ticket(a.id, 'XYZ', [{ qty: '1' }])).errors.join()).toMatch(/Insufficient settled cash/);
  });
});

describe('data integrity, gaps and restarts', () => {
  it('drops out-of-order and duplicate events', () => {
    const t = setup();
    const ts = t.now + 1000;
    expect(t.hub.ingest({ kind: 'quote', symbol: 'XYZ', ts, receivedAt: ts, bid: '1', ask: '1.01', bidSize: '1', askSize: '1', feed: 't' }, 'alpaca-equity')).toBe(true);
    expect(t.hub.ingest({ kind: 'quote', symbol: 'XYZ', ts, receivedAt: ts, bid: '1', ask: '1.01', bidSize: '1', askSize: '1', feed: 't' }, 'alpaca-equity')).toBe(false);
    expect(t.hub.ingest({ kind: 'quote', symbol: 'XYZ', ts: ts - 10, receivedAt: ts, bid: '2', ask: '2.01', bidSize: '1', askSize: '1', feed: 't' }, 'alpaca-equity')).toBe(false);
    expect(t.hub.quote('XYZ')!.bid).toBe('1');
  });

  it('never fills during a disconnect and needs a fresh quote afterwards', () => {
    const t = setup();
    const a = t.account();
    t.quote('XYZ', '10', '10.01');
    const [o] = t.place(t.ticket(a.id, 'XYZ', [{ qty: '1', type: 'limit', limitPrice: '10.05' }]));
    t.disconnect();
    t.trade('XYZ', '10.00'); // arrives, but the quote is from before the disconnect
    expect(t.order(o!.id).status).toBe('open');
    expect(t.store.orderEvents(o!.id).some((e) => e.type === 'monitoring_gap')).toBe(true);
    t.reconnect();
    t.trade('XYZ', '10.00');
    expect(t.order(o!.id).status).toBe('open'); // still needs a quote received after reconnect
    t.quote('XYZ', '10', '10.01');
    expect(t.order(o!.id).status).toBe('filled');
    expect(t.store.gaps().some((g) => g.scope === 'alpaca-equity' && g.endTs)).toBe(true);
  });

  it('records a system gap after sleep and does not invent fills', () => {
    const t = setup();
    const a = t.account();
    t.quote('XYZ', '10', '10.01');
    const [o] = t.place(t.ticket(a.id, 'XYZ', [{ qty: '1', type: 'limit', limitPrice: '10.05' }]));
    t.engine.tick();
    t.advance(60 * 60_000);
    t.engine.tick();
    expect(t.store.gaps().some((g) => g.scope === 'system')).toBe(true);
    t.trade('XYZ', '10.00');
    expect(t.order(o!.id).status).toBe('open');
  });

  it('restart: orders persist and replayed events are not double-applied', () => {
    const t = setup();
    const a = t.account();
    t.quote('XYZ', '10', '10.01', '100');
    const [o] = t.place(t.ticket(a.id, 'XYZ', [{ qty: '300', type: 'limit', limitPrice: '10.05', tif: 'gtc' }]));
    t.quote('XYZ', '10', '10.01', '100');
    const ev = { kind: 'quote' as const, symbol: 'XYZ', ts: t.now, receivedAt: t.now, bid: '10', ask: '10.01', bidSize: '100', askSize: '100', feed: 'test' };
    // "restart": a new engine on the same database; the same event delivered again
    const engine2 = new Engine(t.store, t.hub, () => t.now);
    engine2.setModel({ latencyMs: 100, slippageBps: 0, liquidityMultiplier: 1 });
    engine2.onEvent(ev);
    expect(t.order(o!.id).filledQty).toBe('100');
    expect(t.store.orderFills(o!.id)).toHaveLength(1);
  });

  it('idempotent submission: the same client key never creates a second order', () => {
    const t = setup();
    const a = t.account();
    t.quote('XYZ', '10', '10.01');
    const input = t.ticket(a.id, 'XYZ', [{ qty: '1', type: 'limit', limitPrice: '9' }]);
    t.place(input);
    const again = t.engine.place(input);
    expect(again.duplicate).toBe(true);
    expect(t.store.orders(a.id)).toHaveLength(1);
  });

  it('modify replaces the order with a new acceptance time', () => {
    const t = setup();
    const a = t.account();
    t.quote('XYZ', '10', '10.01');
    const [o] = t.place(t.ticket(a.id, 'XYZ', [{ qty: '5', type: 'limit', limitPrice: '9' }]));
    t.advance(5000);
    const r = t.engine.modify(o!.id, { limitPrice: '10.02' });
    expect(t.order(o!.id).status).toBe('replaced');
    expect(r.acceptedAt).toBe(t.now);
    t.quote('XYZ', '10', '10.01');
    expect(t.order(r.id).status).toBe('filled');
  });
});

describe('sessions and calendar', () => {
  it('queues day orders while closed, fills after the open, expires at the close', () => {
    const t = setup(etToMs('2026-11-10', 8 * 60));
    const a = t.account();
    t.quote('XYZ', '10', '10.01');
    const [o] = t.place(t.ticket(a.id, 'XYZ', [{ qty: '1' }]));
    const [l] = t.place(t.ticket(a.id, 'XYZ', [{ qty: '1', type: 'limit', limitPrice: '5' }]));
    t.quote('XYZ', '10', '10.01');
    expect(t.order(o!.id).status).toBe('open'); // pre-market: not extended -> waits
    t.set(etToMs('2026-11-10', 9 * 60 + 31));
    t.quote('XYZ', '10', '10.02');
    expect(t.order(o!.id).status).toBe('filled');
    t.set(etToMs('2026-11-10', 16 * 60));
    t.engine.tick();
    expect(t.order(l!.id).status).toBe('expired');
  });

  it('extended-hours limit orders are accepted only during pre/post sessions', () => {
    const t = setup(etToMs('2026-11-10', 17 * 60));
    const a = t.account();
    t.quote('XYZ', '10', '10.01');
    const [o] = t.place(t.ticket(a.id, 'XYZ', [{ qty: '1', type: 'limit', limitPrice: '10.05', extended: true }]));
    t.quote('XYZ', '10', '10.01');
    expect(t.order(o!.id).status).toBe('filled');
    t.set(etToMs('2026-11-10', 12 * 60));
    t.quote('XYZ', '10', '10.01');
    expect(t.engine.preview(t.ticket(a.id, 'XYZ', [{ qty: '1', type: 'limit', limitPrice: '10', extended: true }])).errors.join()).toContain('Extended-hours orders are entered');
  });
});

describe('crypto', () => {
  it('charges 1% fee, allows fractional qty, trades 24/7, rejects shorts', () => {
    const t = setup(etToMs('2026-11-14', 3 * 60)); // Saturday 3am ET
    const a = t.account();
    t.quote('BTC/USD', '60000', '60010', '1');
    t.place(t.ticket(a.id, 'BTC/USD', [{ qty: '0.01', tif: 'gtc' }]));
    t.quote('BTC/USD', '60000', '60010', '1');
    const fee = t.store.ledger(a.id).find((e) => e.kind === 'FEE')!;
    expect(fee.amount).toBe('-6.00');
    expect(t.engine.preview(t.ticket(a.id, 'BTC/USD', [{ side: 'sell_short', qty: '0.01', tif: 'gtc' }])).errors.join()).toMatch(/not available/);
    expect(t.engine.preview(t.ticket(a.id, 'BTC/USD', [{ type: 'stop', stopPrice: '70000', qty: '0.01', tif: 'gtc' }])).errors.join()).toMatch(/not offered/);
  });
});
