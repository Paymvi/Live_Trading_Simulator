import type { Instrument, MarketEvent, QuoteState } from '../domain/types';
import type { Store } from './db';
import { AlpacaProvider, IEX_SYMBOL_LIMIT, type AlpacaKeys } from './providers/alpaca';
import { DemoProvider } from './providers/demo';
import type { Snapshot, StreamCallbacks, StreamScope, StreamStatus } from './providers/types';

export interface Demand { engine: string[]; clients: string[]; watchlists: string[] }

/**
 * Market hub: owns provider connections, normalizes and de-duplicates events, tracks liveness per
 * connection ("epoch") and records monitoring gaps. Snapshots seed display state but are never
 * marked live, so they can never fill an order.
 */
export class MarketHub {
  readonly quotes = new Map<string, QuoteState>();
  private epoch = new Map<StreamScope, number>();
  private quoteEpoch = new Map<string, number>();
  private gapIds = new Map<StreamScope, number>();
  private lastQuoteKey = new Map<string, string>();
  alpaca: AlpacaProvider | null = null;
  readonly demo: DemoProvider;
  stats = { events: 0, dropped: 0, duplicates: 0, lastEventAt: null as number | null, lastEventSymbol: null as string | null };
  streamed = new Set<string>();
  notStreamed: string[] = [];
  onEvent: (ev: MarketEvent) => void = () => {};
  onQuote: (q: QuoteState) => void = () => {};
  onConnection: (scope: StreamScope, up: boolean, hadGap: boolean) => void = () => {};
  private demand: Demand = { engine: [], clients: [], watchlists: [] };
  private pollTimer: NodeJS.Timeout | null = null;

  private cb: StreamCallbacks;
  constructor(private store: Store, demoIntervalMs = 1000, private clock: () => number = Date.now) {
    this.cb = { event: (ev: MarketEvent, scope: StreamScope) => this.ingest(ev, scope), connection: (s: StreamScope, up: boolean, r: string) => this.connection(s, up, r) };
    this.demo = new DemoProvider(this.cb, demoIntervalMs);
  }

  setKeys(keys: AlpacaKeys | null) {
    this.alpaca?.stop();
    this.alpaca = keys ? new AlpacaProvider(keys, this.cb) : null;
    this.applyDemand();
  }

  instrument(symbol: string): Instrument | undefined {
    return this.demo.instruments().find((i) => i.symbol === symbol) ?? this.store.instrument<Instrument>(symbol);
  }

  scopeOf(i: Instrument): StreamScope { return i.provider === 'demo' ? 'demo' : i.assetClass === 'crypto' ? 'alpaca-crypto' : 'alpaca-equity'; }

  quote(symbol: string): QuoteState | undefined {
    const q = this.quotes.get(symbol);
    if (!q) return undefined;
    const inst = this.instrument(symbol);
    const live = !!inst && q.live && this.quoteEpoch.get(symbol) === (this.epoch.get(this.scopeOf(inst)) ?? 0) && this.isUp(this.scopeOf(inst));
    return { ...q, live };
  }

  private isUp(scope: StreamScope): boolean {
    if (scope === 'demo') return this.demo.status.state === 'connected';
    const s = scope === 'alpaca-equity' ? this.alpaca?.equity.status : this.alpaca?.crypto.status;
    return s?.state === 'connected';
  }

  /** Validate, de-duplicate and apply an event. Out-of-order events are dropped (never re-applied). */
  ingest(ev: MarketEvent, scope: StreamScope): boolean {
    const now = this.clock();
    if (!Number.isFinite(ev.ts) || ev.ts > now + 5_000) { this.stats.dropped++; return false; }
    const prev = this.quotes.get(ev.symbol);
    const ep = this.epoch.get(scope) ?? 0;
    const q: QuoteState = prev ?? { symbol: ev.symbol, feed: ev.feed, bid: null, ask: null, bidSize: null, askSize: null, quoteTs: null, last: null, lastSize: null, lastTs: null, receivedAt: now, prevClose: null, dayOpen: null, live: true };
    if (ev.kind === 'quote') {
      const key = `${ev.ts}|${ev.bid}|${ev.ask}|${ev.bidSize}|${ev.askSize}`;
      if (this.lastQuoteKey.get(ev.symbol) === key) { this.stats.duplicates++; return false; }
      if (q.quoteTs !== null && ev.ts < q.quoteTs && this.quoteEpoch.get(ev.symbol) === ep && q.live) { this.stats.dropped++; return false; }
      this.lastQuoteKey.set(ev.symbol, key);
      Object.assign(q, { bid: ev.bid, ask: ev.ask, bidSize: ev.bidSize, askSize: ev.askSize, quoteTs: ev.ts });
    } else {
      if (q.lastTs !== null && ev.ts < q.lastTs && q.live && this.quoteEpoch.get(ev.symbol) === ep) { this.stats.dropped++; return false; }
      if (q.lastTs === ev.ts && q.last === ev.price && q.lastSize === ev.size) { this.stats.duplicates++; return false; }
      Object.assign(q, { last: ev.price, lastSize: ev.size, lastTs: ev.ts });
    }
    q.feed = ev.feed; q.receivedAt = now; q.live = true;
    this.quoteEpoch.set(ev.symbol, ep);
    this.quotes.set(ev.symbol, q);
    this.stats.events++; this.stats.lastEventAt = now; this.stats.lastEventSymbol = ev.symbol;
    this.onEvent(ev);
    this.onQuote(this.quote(ev.symbol)!);
    return true;
  }

  private connection(scope: StreamScope, up: boolean, reason: string) {
    const now = this.clock();
    const hadGap = this.gapIds.has(scope);
    if (!up) {
      this.epoch.set(scope, (this.epoch.get(scope) ?? 0) + 1); // every quote from before the disconnect stops being live
      if (!this.gapIds.has(scope)) this.gapIds.set(scope, this.store.openGap(scope, now, `Stream disconnected: ${reason}`));
    } else {
      this.epoch.set(scope, (this.epoch.get(scope) ?? 0) + 1);
      const id = this.gapIds.get(scope);
      if (id !== undefined) { this.store.closeGap(id, now); this.gapIds.delete(scope); }
    }
    this.onConnection(scope, up, hadGap);
  }

  /** Called when the whole process was suspended (sleep): invalidate every quote and record a gap. */
  systemGap(from: number, to: number) {
    for (const s of ['alpaca-equity', 'alpaca-crypto', 'demo'] as StreamScope[]) this.epoch.set(s, (this.epoch.get(s) ?? 0) + 1);
    const id = this.store.openGap('system', from, 'Service did not run (computer asleep or process paused)');
    this.store.closeGap(id, to);
  }

  setDemand(d: Partial<Demand>) { this.demand = { ...this.demand, ...d }; this.applyDemand(); }

  private applyDemand() {
    const ordered = [...new Set([...this.demand.engine, ...this.demand.clients, ...this.demand.watchlists])];
    const eq: string[] = [], cr: string[] = [], dm: string[] = [], over: string[] = [];
    for (const s of ordered) {
      const i = this.instrument(s);
      if (!i) continue;
      if (i.provider === 'demo') dm.push(s);
      else if (i.assetClass === 'crypto') cr.push(s);
      else if (eq.length < IEX_SYMBOL_LIMIT) eq.push(s);
      else over.push(s);
    }
    this.demo.setSymbols(dm);
    this.alpaca?.setSymbols(eq, cr);
    this.streamed = new Set([...dm, ...(this.alpaca ? [...eq, ...cr] : [])]);
    this.notStreamed = this.alpaca ? over : [...eq, ...cr, ...over];
    if (!this.pollTimer) { this.pollTimer = setInterval(() => void this.pollOverflow(), 60_000); this.pollTimer.unref(); }
    void this.seed([...dm, ...eq, ...cr, ...over].filter((s) => !this.quotes.has(s)));
  }

  canStream(symbol: string): boolean {
    const i = this.instrument(symbol);
    if (!i) return false;
    if (i.provider === 'demo' || i.assetClass === 'crypto') return true;
    if (!this.alpaca) return false;
    const engineEquities = this.demand.engine.filter((s) => this.instrument(s)?.assetClass === 'equity' && this.instrument(s)?.provider === 'alpaca');
    return engineEquities.includes(symbol) || new Set(engineEquities).size < IEX_SYMBOL_LIMIT;
  }

  /** Seed display state from REST snapshots (never live / never executable). */
  async seed(symbols: string[]) {
    const live = symbols.filter((s) => this.instrument(s)?.provider === 'alpaca');
    for (const s of symbols.filter((s) => this.instrument(s)?.provider === 'demo')) this.applySnapshot(this.demo.snapshot(s));
    if (!this.alpaca || !live.length) return;
    const eq = live.filter((s) => this.instrument(s)?.assetClass === 'equity'), cr = live.filter((s) => this.instrument(s)?.assetClass === 'crypto');
    try { for (const snap of await this.alpaca.snapshots(eq, cr)) this.applySnapshot(snap); } catch { /* shown via stream status */ }
  }

  private async pollOverflow() { if (this.notStreamed.length) await this.seed(this.notStreamed); }

  private applySnapshot(s: Snapshot | null) {
    if (!s) return;
    const prev = this.quotes.get(s.symbol);
    if (prev?.live && this.streamed.has(s.symbol)) { prev.prevClose = s.prevClose ?? prev.prevClose; prev.dayOpen = s.dayOpen ?? prev.dayOpen; return; }
    const q: QuoteState = {
      symbol: s.symbol, feed: 'snapshot', bid: s.bid ?? null, ask: s.ask ?? null, bidSize: s.bidSize ?? null, askSize: s.askSize ?? null,
      quoteTs: s.quoteTs ?? null, last: s.last ?? null, lastSize: s.lastSize ?? null, lastTs: s.lastTs ?? null,
      receivedAt: Date.now(), prevClose: s.prevClose ?? null, dayOpen: s.dayOpen ?? null, live: false,
    };
    this.quotes.set(s.symbol, q);
    this.onQuote(q);
  }

  statuses(): StreamStatus[] {
    const alp: StreamStatus[] = this.alpaca ? this.alpaca.statuses() : [
      { scope: 'alpaca-equity', label: 'Alpaca IEX (stocks/ETFs)', state: 'disabled', message: 'No API key configured', feed: 'IEX', delay: 'Real-time', symbolLimit: IEX_SYMBOL_LIMIT, subscribed: [], lastMessageAt: null, lastEventAt: null, connectedSince: null },
      { scope: 'alpaca-crypto', label: 'Alpaca crypto (US venue)', state: 'disabled', message: 'No API key configured', feed: 'Alpaca crypto', delay: 'Real-time', symbolLimit: null, subscribed: [], lastMessageAt: null, lastEventAt: null, connectedSince: null },
    ];
    return [...alp, this.demo.status];
  }

  stop() { this.alpaca?.stop(); this.demo.stop(); if (this.pollTimer) clearInterval(this.pollTimer); }
}
