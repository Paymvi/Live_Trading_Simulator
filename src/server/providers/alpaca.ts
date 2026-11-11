import WebSocket from 'ws';
import type { Instrument, MarketEvent } from '../../domain/types';
import { num, type BarsResult, type Bar, type CorpAction, type Snapshot, type StreamCallbacks, type StreamScope, type StreamStatus } from './types';

/**
 * Alpaca market data (free "Basic" plan): real-time IEX stocks/ETFs (30 streamed symbols), crypto,
 * historical bars (SIP data must be >= 15 min old on the free plan). Only GET data endpoints and the
 * read-only assets list are used. This module must never call order endpoints.
 */
const DATA = 'https://data.alpaca.markets';
const ASSETS = 'https://paper-api.alpaca.markets/v2/assets';
const STREAM_EQUITY = 'wss://stream.data.alpaca.markets/v2/iex';
const STREAM_CRYPTO = 'wss://stream.data.alpaca.markets/v1beta3/crypto/us';
export const IEX_SYMBOL_LIMIT = 30;

export interface AlpacaKeys { keyId: string; secret: string }

class AlpacaStream {
  private ws: WebSocket | null = null;
  private want = new Set<string>();
  private have = new Set<string>();
  private backoff = 1000;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private fatal = false;
  status: StreamStatus;

  constructor(private scope: StreamScope, private url: string, private keys: AlpacaKeys, private cb: StreamCallbacks, label: string, feed: string, limit: number | null) {
    this.status = { scope, label, state: 'closed', message: 'Idle (no symbols requested)', feed, delay: 'Real-time', symbolLimit: limit, subscribed: [], lastMessageAt: null, lastEventAt: null, connectedSince: null };
  }

  setSymbols(symbols: string[]) {
    this.want = new Set(symbols);
    if (this.want.size && !this.ws && !this.fatal && !this.timer) this.connect();
    else this.sync();
  }

  private connect() {
    if (this.stopped) return;
    this.status.state = 'connecting';
    this.status.message = 'Connecting';
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on('message', (raw) => this.onMessage(raw.toString()));
    ws.on('close', (code) => this.onClose(`socket closed (${code})`));
    ws.on('error', (e) => { this.status.message = `Socket error: ${e.message}`; });
  }

  private onMessage(raw: string) {
    const now = Date.now();
    this.status.lastMessageAt = now;
    let msgs: Record<string, unknown>[];
    try { msgs = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(msgs)) return;
    for (const m of msgs) {
      const T = m.T;
      if (T === 'success' && m.msg === 'connected') this.ws?.send(JSON.stringify({ action: 'auth', key: this.keys.keyId, secret: this.keys.secret }));
      else if (T === 'success' && m.msg === 'authenticated') {
        this.status.state = 'connected'; this.status.message = 'Authenticated'; this.status.connectedSince = now; this.backoff = 1000;
        this.have.clear(); this.sync();
        this.cb.connection(this.scope, true, 'connected');
      } else if (T === 'error') {
        const code = Number(m.code);
        this.status.state = 'error';
        this.status.message = `Alpaca error ${code}: ${String(m.msg)}${code === 406 ? ' — Alpaca allows one stream connection per key; close other apps using this key.' : ''}`;
        if (code === 402 || code === 409) { this.fatal = true; this.ws?.close(); } // bad keys / plan does not include this feed
      } else if (T === 'subscription') {
        this.status.subscribed = [...new Set([...(m.quotes as string[] ?? []), ...(m.trades as string[] ?? [])])];
      } else if (T === 'q' || T === 't') {
        const ev = this.toEvent(m, now);
        if (ev) { this.status.lastEventAt = now; this.cb.event(ev, this.scope); }
      }
    }
  }

  private toEvent(m: Record<string, unknown>, now: number): MarketEvent | null {
    const symbol = typeof m.S === 'string' ? m.S : null;
    const ts = typeof m.t === 'string' ? Date.parse(m.t) : NaN;
    if (!symbol || !Number.isFinite(ts)) return null;
    const feed = this.scope === 'alpaca-equity' ? 'iex' : 'alpaca-crypto-us';
    if (m.T === 'q') {
      const bid = num(m.bp), ask = num(m.ap), bidSize = num(m.bs), askSize = num(m.as);
      if (bid === null || ask === null || bidSize === null || askSize === null) return null;
      return { kind: 'quote', symbol, ts, receivedAt: now, bid, ask, bidSize, askSize, feed };
    }
    const price = num(m.p), size = num(m.s);
    if (price === null || size === null) return null;
    return { kind: 'trade', symbol, ts, receivedAt: now, price, size, feed };
  }

  private sync() {
    if (!this.ws || this.status.state !== 'connected') return;
    const add = [...this.want].filter((s) => !this.have.has(s));
    const del = [...this.have].filter((s) => !this.want.has(s));
    if (add.length) this.ws.send(JSON.stringify({ action: 'subscribe', quotes: add, trades: add }));
    if (del.length) this.ws.send(JSON.stringify({ action: 'unsubscribe', quotes: del, trades: del }));
    this.have = new Set(this.want);
    if (!this.want.size) { this.ws.close(); }
  }

  private onClose(reason: string) {
    const wasUp = this.status.state === 'connected';
    this.ws = null;
    this.status.connectedSince = null;
    if (wasUp) this.cb.connection(this.scope, false, reason);
    if (this.stopped) { this.status.state = 'closed'; return; }
    if (this.fatal) { this.status.state = 'error'; return; }
    if (!this.want.size) { this.status.state = 'closed'; this.status.message = 'Idle (no symbols requested)'; return; }
    this.status.state = 'connecting';
    this.status.message = `Reconnecting in ${Math.round(this.backoff / 1000)}s (${reason})`;
    this.timer = setTimeout(() => { this.timer = null; this.connect(); }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 60_000);
  }

  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.ws?.close(); }
}

export class AlpacaProvider {
  readonly equity: AlpacaStream;
  readonly crypto: AlpacaStream;
  constructor(private keys: AlpacaKeys, cb: StreamCallbacks) {
    this.equity = new AlpacaStream('alpaca-equity', STREAM_EQUITY, keys, cb, 'Alpaca IEX (stocks/ETFs)', 'IEX exchange only — not consolidated NBBO', IEX_SYMBOL_LIMIT);
    this.crypto = new AlpacaStream('alpaca-crypto', STREAM_CRYPTO, keys, cb, 'Alpaca crypto (US venue)', 'Alpaca crypto venue quotes', null);
  }

  private async get<T>(url: string): Promise<T> {
    const r = await fetch(url, { headers: { 'APCA-API-KEY-ID': this.keys.keyId, 'APCA-API-SECRET-KEY': this.keys.secret }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`Alpaca ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return (await r.json()) as T;
  }

  async verify(): Promise<string> {
    await this.get(`${DATA}/v2/stocks/snapshots?symbols=SPY&feed=iex`);
    return 'Keys accepted by Alpaca market data (IEX feed).';
  }

  async instruments(): Promise<Instrument[]> {
    type A = { symbol: string; name: string; exchange: string; status: string; tradable: boolean; marginable: boolean; shortable: boolean; fractionable: boolean; easy_to_borrow?: boolean; borrow_status?: string; min_order_size?: string; min_trade_increment?: string; price_increment?: string };
    const [eq, cr] = await Promise.all([
      this.get<A[]>(`${ASSETS}?status=active&asset_class=us_equity`),
      this.get<A[]>(`${ASSETS}?status=active&asset_class=crypto`),
    ]);
    const decimals = (s?: string) => (s && s.includes('.') ? s.split('.')[1]!.replace(/0+$/, '').length : 0);
    const equities: Instrument[] = eq.filter((a) => a.tradable && a.exchange !== 'OTC').map((a) => ({
      symbol: a.symbol, name: a.name, assetClass: 'equity', exchange: a.exchange, calendar: 'nyse',
      fractionable: a.fractionable, marginable: a.marginable, shortable: a.shortable,
      easyToBorrow: a.borrow_status ? a.borrow_status === 'easy_to_borrow' : a.easy_to_borrow ?? null,
      qtyDecimals: a.fractionable ? 3 : 0, minQty: a.fractionable ? '0.001' : '1', priceIncrement: null, provider: 'alpaca',
    }));
    const cryptos: Instrument[] = cr.filter((a) => a.tradable && a.symbol.endsWith('/USD')).map((a) => ({
      symbol: a.symbol, name: a.name, assetClass: 'crypto', exchange: 'CRYPTO', calendar: '24x7',
      fractionable: true, marginable: false, shortable: false, easyToBorrow: null,
      qtyDecimals: Math.min(9, decimals(a.min_trade_increment) || 8), minQty: a.min_order_size ?? '0.0001',
      priceIncrement: a.price_increment ?? null, provider: 'alpaca',
    }));
    return [...equities, ...cryptos];
  }

  async snapshots(equities: string[], crypto: string[]): Promise<Snapshot[]> {
    const out: Snapshot[] = [];
    type Q = { bp: number; ap: number; bs: number; as: number; t: string };
    type T = { p: number; s: number; t: string };
    type B = { o: number; c: number };
    type S = { latestQuote?: Q; latestTrade?: T; dailyBar?: B; prevDailyBar?: B };
    const map = (symbol: string, s: S): Snapshot => ({
      symbol,
      ...(s.latestQuote ? { bid: num(s.latestQuote.bp) ?? undefined, ask: num(s.latestQuote.ap) ?? undefined, bidSize: num(s.latestQuote.bs) ?? undefined, askSize: num(s.latestQuote.as) ?? undefined, quoteTs: Date.parse(s.latestQuote.t) } : {}),
      ...(s.latestTrade ? { last: num(s.latestTrade.p) ?? undefined, lastSize: num(s.latestTrade.s) ?? undefined, lastTs: Date.parse(s.latestTrade.t) } : {}),
      prevClose: s.prevDailyBar ? num(s.prevDailyBar.c) ?? undefined : undefined,
      dayOpen: s.dailyBar ? num(s.dailyBar.o) ?? undefined : undefined,
    });
    if (equities.length) {
      const r = await this.get<Record<string, S>>(`${DATA}/v2/stocks/snapshots?feed=iex&symbols=${encodeURIComponent(equities.join(','))}`);
      for (const [k, v] of Object.entries(r)) if (v) out.push(map(k, v));
    }
    if (crypto.length) {
      const r = await this.get<{ snapshots: Record<string, S> }>(`${DATA}/v1beta3/crypto/us/snapshots?symbols=${encodeURIComponent(crypto.join(','))}`);
      for (const [k, v] of Object.entries(r.snapshots ?? {})) if (v) out.push(map(k, v));
    }
    return out;
  }

  /** Historical bars. Stocks use consolidated SIP bars, which the free plan only serves when >= 15 minutes old. */
  async bars(symbol: string, crypto: boolean, timeframe: string, start: Date, adjustment: 'split' | 'all' = 'split'): Promise<BarsResult> {
    const bars: Bar[] = [];
    let token: string | null = null;
    const end = new Date(Date.now() - 16 * 60_000);
    for (let page = 0; page < 10; page++) {
      const qs = new URLSearchParams({ timeframe, start: start.toISOString(), limit: '10000' });
      if (!crypto) { qs.set('end', end.toISOString()); qs.set('adjustment', adjustment); qs.set('feed', 'sip'); }
      if (token) qs.set('page_token', token);
      type RB = { t: string; o: number; h: number; l: number; c: number; v: number };
      if (crypto) {
        qs.set('symbols', symbol);
        const r = await this.get<{ bars: Record<string, RB[]>; next_page_token: string | null }>(`${DATA}/v1beta3/crypto/us/bars?${qs}`);
        for (const b of r.bars?.[symbol] ?? []) bars.push({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
        token = r.next_page_token;
      } else {
        const r = await this.get<{ bars: RB[] | null; next_page_token: string | null }>(`${DATA}/v2/stocks/${encodeURIComponent(symbol)}/bars?${qs}`);
        for (const b of r.bars ?? []) bars.push({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
        token = r.next_page_token;
      }
      if (!token) break;
    }
    return crypto
      ? { bars, source: 'Alpaca crypto (US venue)', note: 'Crypto bars from Alpaca\'s own venue.' }
      : { bars, source: 'Alpaca SIP (consolidated)', note: `Free plan: consolidated bars end 15+ minutes ago (${adjustment === 'all' ? 'split+dividend adjusted' : 'split-adjusted'}).` };
  }

  async corporateActions(symbols: string[], start: string, end: string): Promise<CorpAction[]> {
    if (!symbols.length) return [];
    type R = { corporate_actions: { cash_dividends?: Record<string, string | null>[]; forward_splits?: Record<string, string | null>[]; reverse_splits?: Record<string, string | null>[] } };
    const qs = new URLSearchParams({ symbols: symbols.join(','), types: 'cash_dividend,forward_split,reverse_split', start, end, limit: '1000' });
    const r = await this.get<R>(`${DATA}/v1/corporate-actions?${qs}`);
    const ca = r.corporate_actions ?? {};
    const out: CorpAction[] = [];
    for (const d of ca.cash_dividends ?? []) out.push({ id: `div:${d.id}`, type: 'cash_dividend', symbol: d.symbol!, exDate: d.ex_date!, payableDate: d.payable_date ?? null, rate: String(d.rate) });
    for (const d of ca.forward_splits ?? []) out.push({ id: `fsplit:${d.id}`, type: 'forward_split', symbol: d.symbol!, exDate: d.ex_date!, payableDate: d.payable_date ?? null, oldRate: String(d.old_rate), newRate: String(d.new_rate) });
    for (const d of ca.reverse_splits ?? []) out.push({ id: `rsplit:${d.id}`, type: 'reverse_split', symbol: d.symbol!, exDate: d.ex_date!, payableDate: d.payable_date ?? null, oldRate: String(d.old_rate), newRate: String(d.new_rate) });
    return out;
  }

  setSymbols(equities: string[], crypto: string[]) { this.equity.setSymbols(equities); this.crypto.setSymbols(crypto); }
  statuses(): StreamStatus[] { return [this.equity.status, this.crypto.status]; }
  stop() { this.equity.stop(); this.crypto.stop(); }
}
