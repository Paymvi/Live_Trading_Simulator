import { Store } from '../src/server/db';
import { MarketHub } from '../src/server/market';
import { Engine } from '../src/server/engine';
import { etToMs } from '../src/domain/calendar';
import type { TicketInput, LegInput } from '../src/domain/orders';
import type { Instrument } from '../src/domain/types';
import type { AlpacaProvider } from '../src/server/providers/alpaca';

// Deterministic fixtures for tests only. Nothing here is used by the running app.
export const XYZ: Instrument = { symbol: 'XYZ', name: 'Test Equity XYZ', assetClass: 'equity', exchange: 'TEST', calendar: 'nyse', fractionable: true, marginable: true, shortable: true, easyToBorrow: true, qtyDecimals: 3, minQty: '0.001', priceIncrement: null, provider: 'alpaca' };
export const LOW: Instrument = { ...XYZ, symbol: 'LOW', name: 'Test low-priced', fractionable: false, qtyDecimals: 0, minQty: '1' };
export const BTC: Instrument = { symbol: 'BTC/USD', name: 'Test Bitcoin', assetClass: 'crypto', exchange: 'CRYPTO', calendar: '24x7', fractionable: true, marginable: false, shortable: false, easyToBorrow: null, qtyDecimals: 8, minQty: '0.0001', priceIncrement: '0.01', provider: 'alpaca' };

export function setup(start = etToMs('2026-11-10', 10 * 60)) {
  let now = start;
  const store = new Store(':memory:');
  const hub = new MarketHub(store, 1e9, () => now);
  const up = { equity: true, crypto: true };
  const fake = {
    equity: { status: { get state() { return up.equity ? 'connected' : 'connecting'; } } },
    crypto: { status: { get state() { return up.crypto ? 'connected' : 'connecting'; } } },
    setSymbols() {}, stop() {}, snapshots: async () => [], statuses: () => [],
  };
  hub.alpaca = fake as unknown as AlpacaProvider;
  store.putInstruments([XYZ, LOW, BTC]);
  const engine = new Engine(store, hub, () => now);
  engine.setModel({ latencyMs: 100, slippageBps: 0, liquidityMultiplier: 1, maxSpreadPct: 5 });
  const scope = (s: string) => (s === 'BTC/USD' ? 'alpaca-crypto' : s.startsWith('DEMO') ? 'demo' : 'alpaca-equity') as 'alpaca-equity';
  let key = 0;
  const t = {
    store, hub, engine,
    get now() { return now; },
    advance(ms: number) { now += ms; },
    set(ms: number) { now = ms; },
    quote(symbol: string, bid: string, ask: string, size = '100', dt = 1000) {
      now += dt;
      return hub.ingest({ kind: 'quote', symbol, ts: now, receivedAt: now, bid, ask, bidSize: size, askSize: size, feed: 'test' }, scope(symbol));
    },
    trade(symbol: string, price: string, size = '100', dt = 1000) {
      now += dt;
      return hub.ingest({ kind: 'trade', symbol, ts: now, receivedAt: now, price, size, feed: 'test' }, scope(symbol));
    },
    disconnect(kind: 'equity' | 'crypto' = 'equity') { up[kind] = false; (hub as unknown as { connection: (s: string, u: boolean, r: string) => void }).connection(kind === 'equity' ? 'alpaca-equity' : 'alpaca-crypto', false, 'test'); },
    reconnect(kind: 'equity' | 'crypto' = 'equity') { up[kind] = true; (hub as unknown as { connection: (s: string, u: boolean, r: string) => void }).connection(kind === 'equity' ? 'alpaca-equity' : 'alpaca-crypto', true, 'test'); },
    account(type: 'cash' | 'margin' = 'cash', initialCash = '100000') { return engine.createAccount({ name: `T ${type}`, type, mode: 'live', initialCash }); },
    ticket(accountId: string, symbol: string, legs: Partial<LegInput>[], strategy: TicketInput['strategy'] = 'single', extra: Partial<TicketInput> = {}): TicketInput {
      return { accountId, symbol, clientKey: `test-key-${++key}`, strategy, legs: legs.map((l) => ({ side: 'buy', qty: '10', type: 'market', tif: 'day', ...l })) as LegInput[], ...extra };
    },
    place(input: TicketInput) {
      const r = engine.place(input);
      if (r.preview?.errors.length) throw new Error(r.preview.errors.join(' | '));
      return r.orders;
    },
    order(id: string) { return store.order(id)!; },
    balances(accountId: string) { return engine.state(accountId).balances; },
  };
  return t;
}
