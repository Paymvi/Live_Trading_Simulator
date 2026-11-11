import type { Instrument, MarketEvent } from '../../domain/types';
import type { Bar, BarsResult, Snapshot, StreamCallbacks, StreamStatus } from './types';

/**
 * DEMO provider: synthetic random-walk prices for clearly named DEMO-* instruments.
 * It exists only so the app can be explored and tested without credentials or open markets.
 * Demo instruments are only tradable in demo accounts, and live accounts never see these prices.
 */
const base = { provider: 'demo' as const, calendar: '24x7' as const, easyToBorrow: true, priceIncrement: null };
export const DEMO_INSTRUMENTS: (Instrument & { start: number; vol: number; spread: number })[] = [
  { ...base, symbol: 'DEMO-AAA', name: 'Demo Alpha Corp (synthetic)', assetClass: 'equity', exchange: 'DEMO', fractionable: true, marginable: true, shortable: true, qtyDecimals: 3, minQty: '0.001', start: 100, vol: 0.0006, spread: 0.02 },
  { ...base, symbol: 'DEMO-BBB', name: 'Demo Beta Inc (synthetic)', assetClass: 'equity', exchange: 'DEMO', fractionable: false, marginable: true, shortable: true, qtyDecimals: 0, minQty: '1', start: 25, vol: 0.0012, spread: 0.01 },
  { ...base, symbol: 'DEMO-PENNY', name: 'Demo Low-Priced Co (synthetic)', assetClass: 'equity', exchange: 'DEMO', fractionable: false, marginable: true, shortable: true, qtyDecimals: 0, minQty: '1', start: 2.5, vol: 0.002, spread: 0.01 },
  { ...base, symbol: 'DEMO-ETF', name: 'Demo Broad Market ETF (synthetic)', assetClass: 'equity', exchange: 'DEMO', fractionable: true, marginable: true, shortable: true, qtyDecimals: 3, minQty: '0.001', start: 450, vol: 0.0003, spread: 0.02 },
  { ...base, symbol: 'DEMO-BTC/USD', name: 'Demo Coin (synthetic crypto)', assetClass: 'crypto', exchange: 'DEMO', fractionable: true, marginable: false, shortable: false, easyToBorrow: null, qtyDecimals: 8, minQty: '0.0001', priceIncrement: '0.01', start: 60000, vol: 0.0008, spread: 5 },
];

function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);
const round = (x: number, dp: number) => Math.round(x * 10 ** dp) / 10 ** dp;

export class DemoProvider {
  private timer: NodeJS.Timeout | null = null;
  private px = new Map<string, number>();
  private rand = rng(Date.now() & 0xffff);
  private symbols = new Set<string>();
  status: StreamStatus = { scope: 'demo', label: 'DEMO synthetic feed', state: 'closed', message: 'Idle', feed: 'Synthetic random walk — not market data', delay: 'n/a', symbolLimit: null, subscribed: [], lastMessageAt: null, lastEventAt: null, connectedSince: null };

  constructor(private cb: StreamCallbacks, private intervalMs = 1000) {
    for (const d of DEMO_INSTRUMENTS) this.px.set(d.symbol, d.start);
  }

  instruments(): Instrument[] { return DEMO_INSTRUMENTS.map(({ start: _s, vol: _v, spread: _p, ...i }) => i); }

  setSymbols(symbols: string[]) {
    this.symbols = new Set(symbols.filter((s) => this.px.has(s)));
    this.status.subscribed = [...this.symbols];
    if (this.symbols.size && !this.timer) {
      this.timer = setInterval(() => this.emit(), this.intervalMs);
      this.status.state = 'connected'; this.status.message = 'Generating synthetic quotes'; this.status.connectedSince = Date.now();
      this.cb.connection('demo', true, 'demo started');
    } else if (!this.symbols.size && this.timer) {
      clearInterval(this.timer); this.timer = null;
      this.status.state = 'closed'; this.status.message = 'Idle'; this.status.connectedSince = null;
      this.cb.connection('demo', false, 'no demo symbols requested');
    }
  }

  private emit() {
    const now = Date.now();
    for (const s of this.symbols) {
      const d = DEMO_INSTRUMENTS.find((x) => x.symbol === s)!;
      const p = this.px.get(s)! * (1 + (this.rand() - 0.5) * 2 * d.vol * 3);
      this.px.set(s, p);
      const dp = d.assetClass === 'crypto' ? 2 : p < 1 ? 4 : 2;
      const half = d.spread / 2;
      const bid = round(p - half, dp), ask = round(p + half, dp);
      const sz = () => String(d.assetClass === 'crypto' ? round(0.05 + this.rand(), 4) : 100 * (1 + Math.floor(this.rand() * 5)));
      const ev: MarketEvent = { kind: 'quote', symbol: s, ts: now, receivedAt: now, bid: String(bid), ask: String(ask), bidSize: sz(), askSize: sz(), feed: 'demo' };
      this.cb.event(ev, 'demo');
      if (this.rand() < 0.4) this.cb.event({ kind: 'trade', symbol: s, ts: now, receivedAt: now, price: String(this.rand() < 0.5 ? bid : ask), size: sz(), feed: 'demo' }, 'demo');
    }
    this.status.lastMessageAt = this.status.lastEventAt = now;
  }

  snapshot(symbol: string): Snapshot | null {
    const d = DEMO_INSTRUMENTS.find((x) => x.symbol === symbol);
    if (!d) return null;
    const p = this.px.get(symbol)!;
    return { symbol, last: String(round(p, 2)), lastTs: Date.now(), prevClose: String(d.start) };
  }

  /** Deterministic synthetic history ending at the current synthetic price. */
  bars(symbol: string, stepMs: number, count: number): BarsResult {
    const d = DEMO_INSTRUMENTS.find((x) => x.symbol === symbol);
    if (!d) return { bars: [], source: 'demo', note: '' };
    const r = rng(hash(symbol) + Math.floor(stepMs / 1000));
    const end = Math.floor(Date.now() / stepMs) * stepMs;
    let c = this.px.get(symbol)!;
    const bars: Bar[] = [];
    for (let i = 0; i < count; i++) {
      const o = c * (1 + (r() - 0.5) * d.vol * 40);
      const h = Math.max(o, c) * (1 + r() * d.vol * 10), l = Math.min(o, c) * (1 - r() * d.vol * 10);
      bars.push({ t: end - i * stepMs, o, h, l, c, v: Math.round(1000 + r() * 50000) });
      c = o;
    }
    return { bars: bars.reverse(), source: 'DEMO synthetic', note: 'Synthetic data for demo accounts only. Not real market history.' };
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
