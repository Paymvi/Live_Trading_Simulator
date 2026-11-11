import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { TicketSchema, allowedFor, newId } from '../domain/orders';
import { isDecimalString } from '../domain/money';
import { RULES } from '../domain/rules';
import { etDate } from '../domain/calendar';
import type { Instrument, QuoteState } from '../domain/types';
import { EngineError, type Engine } from './engine';
import { applyImport, exportCsv, exportJson, snapshotDb, validateImport } from './backup';
import { analytics, bars, benchmark, marketSession, orderView, recap, summary } from './views';
import { isLoopback, type Gate } from './security';
import type { Watchlist } from './db';

export interface AppContext {
  engine: Engine;
  gate: Gate;
  webDir: string;
  backupDir: string;
  startedAt: number;
  lan: { enabled: boolean; urls: string[]; fingerprint: string | null };
  keys: { configured: () => { configured: boolean; keyIdHint: string | null }; save: (k: { keyId: string; secret: string } | null) => Promise<string> };
  status: () => Record<string, unknown>;
  shutdown: () => void;
  runBackup: () => Promise<string>;
}

type Handler = (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray, body: unknown, url: URL) => unknown | Promise<unknown>;
class HttpError extends Error { constructor(readonly status: number, msg: string) { super(msg); } }

const json = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > limit) throw new HttpError(413, 'Request too large'); chunks.push(c as Buffer); }
  if (!n) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

const parse = <S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> => {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
};
const dec = z.string().refine(isDecimalString, 'must be a decimal number');
const loopbackOnly = (req: IncomingMessage) => { if (!isLoopback(req)) throw new HttpError(403, 'This action is only available on the computer running the service.'); };

export function createApi(ctx: AppContext) {
  const { engine } = ctx;
  const store = engine.store;
  const ws = new WebSocketServer({ noServer: true });
  const clients = new Map<WebSocket, { symbols: Set<string>; accountId: string | null }>();

  const broadcast = (msg: unknown, filter?: (c: { symbols: Set<string>; accountId: string | null }) => boolean) => {
    const raw = JSON.stringify(msg);
    for (const [c, info] of clients) if (c.readyState === c.OPEN && (!filter || filter(info))) c.send(raw);
  };
  const quoteThrottle = new Map<string, number>();
  engine.hub.onQuote = (q: QuoteState) => {
    const now = Date.now();
    if (now - (quoteThrottle.get(q.symbol) ?? 0) < 250) return;
    quoteThrottle.set(q.symbol, now);
    broadcast({ type: 'quote', quote: q }, (c) => c.symbols.has(q.symbol));
  };
  engine.onChange = (accountId) => broadcast({ type: 'account', accountId });
  const clientDemand = () => engine.hub.setDemand({ clients: [...new Set([...clients.values()].flatMap((c) => [...c.symbols]))].slice(0, 60) });
  const watchDemand = () => engine.hub.setDemand({ watchlists: store.watchlists().flatMap((w) => w.symbols) });
  watchDemand();

  ws.on('connection', (sock) => {
    clients.set(sock, { symbols: new Set(), accountId: null });
    sock.send(JSON.stringify({ type: 'hello', status: ctx.status() }));
    sock.on('message', (raw) => {
      try {
        const m = JSON.parse(raw.toString()) as { type: string; symbols?: string[] };
        if (m.type === 'view' && Array.isArray(m.symbols)) {
          clients.get(sock)!.symbols = new Set(m.symbols.filter((s) => typeof s === 'string').slice(0, 40));
          clientDemand();
          for (const s of clients.get(sock)!.symbols) { const q = engine.hub.quote(s); if (q) sock.send(JSON.stringify({ type: 'quote', quote: q })); }
        }
      } catch { /* ignore malformed client messages */ }
    });
    sock.on('close', () => { clients.delete(sock); clientDemand(); });
  });
  setInterval(() => broadcast({ type: 'status', status: ctx.status() }), 2000).unref();

  const instrumentView = (i: Instrument) => ({ ...i, allowed: allowedFor(i), streamed: engine.hub.streamed.has(i.symbol) });
  const accountId = (u: URL) => { const id = u.searchParams.get('accountId'); if (!id) throw new HttpError(400, 'accountId required'); engine.account(id); return id; };

  const routes: [string, RegExp, Handler][] = [
    ['GET', /^\/api\/status$/, () => ctx.status()],
    ['GET', /^\/api\/whoami$/, (req) => ({ loopback: isLoopback(req), paired: ctx.gate.paired(req) })],
    ['GET', /^\/api\/rules$/, () => ({ rules: RULES, model: engine.model })],
    ['PUT', /^\/api\/settings\/model$/, (_q, _s, _m, body) => { engine.setModel(body as never); return engine.model; }],
    // accounts
    ['GET', /^\/api\/accounts$/, () => store.accounts().map((a) => ({ ...a, equity: (() => { try { return engine.state(a.id).balances.equity.toFixed(2); } catch { return null; } })() }))],
    ['POST', /^\/api\/accounts$/, (_q, _s, _m, body) => engine.createAccount(parse(z.object({ name: z.string(), type: z.enum(['cash', 'margin']), mode: z.enum(['live', 'demo']), initialCash: dec }), body))],
    ['PATCH', /^\/api\/accounts\/([\w~-]+)$/, (_q, _s, m, body) => engine.updateAccount(m[1]!, parse(z.object({ name: z.string().optional(), archived: z.boolean().optional() }), body))],
    ['POST', /^\/api\/accounts\/([\w~-]+)\/reset$/, async (_q, _s, m, body) => {
      const b = parse(z.object({ confirm: z.literal('RESET'), initialCash: dec.optional() }), body);
      const backup = await snapshotDb(store, ctx.backupDir, 'pre-reset');
      for (const o of store.activeOrders(m[1]!)) engine.cancel(o.id, 'Account reset');
      engine.resetAccount(m[1]!, b.initialCash);
      return { ok: true, backup };
    }],
    ['POST', /^\/api\/accounts\/([\w~-]+)\/cash$/, (_q, _s, m, body) => { const b = parse(z.object({ kind: z.enum(['DEPOSIT', 'WITHDRAWAL']), amount: dec, memo: z.string().max(200).default('') }), body); engine.cashFlow(m[1]!, b.kind, b.amount, b.memo); return { ok: true }; }],
    ['GET', /^\/api\/accounts\/([\w~-]+)\/summary$/, (_q, _s, m) => summary(engine, m[1]!)],
    ['GET', /^\/api\/accounts\/([\w~-]+)\/orders$/, (_q, _s, m) => store.orders(m[1]!).slice(0, 500).map((o) => orderView(engine, o))],
    ['GET', /^\/api\/accounts\/([\w~-]+)\/fills$/, (_q, _s, m) => store.fills(m[1]!).reverse()],
    ['GET', /^\/api\/accounts\/([\w~-]+)\/ledger$/, (_q, _s, m) => store.ledger(m[1]!).reverse()],
    ['GET', /^\/api\/accounts\/([\w~-]+)\/analytics$/, (_q, _s, m) => analytics(engine, m[1]!)],
    ['GET', /^\/api\/accounts\/([\w~-]+)\/recap$/, (_q, _s, m, _b, u) => recap(engine, m[1]!, u.searchParams.get('date') ?? etDate(engine.now()))],
    ['GET', /^\/api\/accounts\/([\w~-]+)\/benchmark$/, (_q, _s, m, _b, u) => benchmark(engine, m[1]!, (u.searchParams.get('symbol') ?? 'SPY').toUpperCase())],
    // orders
    ['POST', /^\/api\/orders\/preview$/, (_q, _s, _m, body) => engine.preview(parse(TicketSchema, body))],
    ['POST', /^\/api\/orders$/, (_q, _s, _m, body) => engine.place(parse(TicketSchema, body))],
    ['GET', /^\/api\/orders\/([\w~-]+)$/, (_q, _s, m) => { const o = store.order(m[1]!); if (!o) throw new HttpError(404, 'Order not found'); return { order: orderView(engine, o), events: store.orderEvents(o.id), fills: store.orderFills(o.id) }; }],
    ['POST', /^\/api\/orders\/([\w~-]+)\/cancel$/, (_q, _s, m) => { engine.cancel(m[1]!); return { ok: true }; }],
    ['POST', /^\/api\/orders\/([\w~-]+)\/modify$/, (_q, _s, m, body) => engine.modify(m[1]!, parse(z.object({ qty: dec.optional(), limitPrice: dec.optional(), stopPrice: dec.optional(), trailValue: dec.optional(), limitOffset: dec.optional(), tif: z.enum(['day', 'gtc', 'ioc', 'fok']).optional() }), body))],
    // market data
    ['GET', /^\/api\/instruments\/search$/, (_q, _s, _m, _b, u) => {
      const q = (u.searchParams.get('q') ?? '').trim();
      const mode = u.searchParams.get('mode');
      const demo = engine.hub.demo.instruments().filter((i) => i.symbol.includes(q.toUpperCase()) || i.name.toLowerCase().includes(q.toLowerCase()));
      const live = q && mode !== 'demo' ? store.searchInstruments<Instrument>(q) : [];
      return { results: (mode === 'demo' ? demo : mode === 'live' ? live : [...demo, ...live]).slice(0, 30).map(instrumentView), liveCatalog: store.instrumentCount() };
    }],
    ['GET', /^\/api\/instruments\/(.+)$/, (_q, _s, m) => { const i = engine.hub.instrument(decodeURIComponent(m[1]!)); if (!i) throw new HttpError(404, 'Unknown instrument'); return instrumentView(i); }],
    ['GET', /^\/api\/quotes$/, (_q, _s, _m, _b, u) => (u.searchParams.get('symbols') ?? '').split(',').filter(Boolean).slice(0, 60).map((s) => engine.hub.quote(s) ?? { symbol: s, missing: true })],
    ['GET', /^\/api\/bars$/, (_q, _s, _m, _b, u) => bars(engine, u.searchParams.get('symbol') ?? '', u.searchParams.get('range') ?? '1M')],
    ['GET', /^\/api\/watchlists$/, () => store.watchlists()],
    ['PUT', /^\/api\/watchlists$/, (_q, _s, _m, body) => {
      const w = parse(z.object({ id: z.string().optional(), name: z.string().min(1).max(40), symbols: z.array(z.string().max(32)).max(100) }), body);
      const wl: Watchlist = { id: w.id ?? newId('wl'), name: w.name, symbols: [...new Set(w.symbols)] };
      store.putWatchlist(wl); watchDemand(); return wl;
    }],
    ['DELETE', /^\/api\/watchlists\/([\w~-]+)$/, (_q, _s, m) => { store.deleteWatchlist(m[1]!); watchDemand(); return { ok: true }; }],
    // journal
    ['GET', /^\/api\/journal$/, (_q, _s, _m, _b, u) => store.journal(accountId(u))],
    ['PUT', /^\/api\/journal$/, (_q, _s, _m, body) => {
      const j = parse(z.object({ id: z.string().optional(), accountId: z.string(), symbol: z.string().max(32).nullable(), orderId: z.string().nullable(), strategy: z.string().max(80), tags: z.array(z.string().max(30)).max(20), entryReason: z.string().max(4000), exitReason: z.string().max(4000), review: z.string().max(8000) }), body);
      engine.account(j.accountId);
      const e = { ...j, id: j.id ?? newId('jr'), ts: Date.now() };
      store.putJournal(e); return e;
    }],
    ['DELETE', /^\/api\/journal\/([\w~-]+)$/, (_q, _s, m) => { store.deleteJournal(m[1]!); return { ok: true }; }],
    // backups
    ['GET', /^\/api\/backups$/, () => ({ log: store.backupLog(), dir: ctx.backupDir })],
    ['POST', /^\/api\/backups\/run$/, async () => ({ file: await ctx.runBackup() })],
    ['GET', /^\/api\/export$/, (_q, res, _m, _b, u) => {
      const id = u.searchParams.get('accountId');
      if (id) engine.account(id);
      const data = exportJson(store, id ? [id] : null);
      res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="lts-${id ? 'account' : 'all'}-${new Date().toISOString().slice(0, 10)}.json"`, 'cache-control': 'no-store' });
      res.end(JSON.stringify(data, null, 1));
      return undefined;
    }],
    ['GET', /^\/api\/export\/csv$/, (_q, res, _m, _b, u) => {
      const id = accountId(u);
      const kind = parse(z.enum(['fills', 'ledger', 'trades']), u.searchParams.get('kind'));
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="lts-${kind}-${new Date().toISOString().slice(0, 10)}.csv"`, 'cache-control': 'no-store' });
      res.end('﻿' + exportCsv(store, id, kind));
      return undefined;
    }],
    ['POST', /^\/api\/import\/preview$/, (_q, _s, _m, body) => validateImport(store, body).preview],
    ['POST', /^\/api\/import\/apply$/, async (_q, _s, _m, body) => {
      const b = parse(z.object({ file: z.unknown(), mode: z.enum(['copy', 'replace']), accounts: z.array(z.string()).nullable() }), body);
      const v = validateImport(store, b.file);
      if (!v.file) throw new HttpError(400, `Import rejected: ${v.preview.errors.join(' ')}`);
      const backup = await snapshotDb(store, ctx.backupDir, 'pre-import');
      const ids = applyImport(store, v.file, b.mode, b.accounts);
      engine.refreshDemand();
      for (const id of ids) engine.onChange(id);
      return { ok: true, imported: ids, backup };
    }],
    // provider keys (computer only; secrets never leave the server)
    ['GET', /^\/api\/provider$/, () => ({ alpaca: ctx.keys.configured(), statuses: engine.hub.statuses(), catalog: store.instrumentCount() })],
    ['PUT', /^\/api\/provider$/, async (req, _s, _m, body) => { loopbackOnly(req); const b = parse(z.object({ keyId: z.string().trim().min(8).max(100), secret: z.string().trim().min(8).max(200) }).nullable(), body); return { message: await ctx.keys.save(b) }; }],
    // phone access
    ['POST', /^\/api\/pairing-code$/, (req) => { loopbackOnly(req); if (!ctx.lan.enabled) throw new HttpError(400, 'Start the service in LAN mode first (start-lan.cmd).'); return { ...ctx.gate.newPairingCode(), urls: ctx.lan.urls, fingerprint: ctx.lan.fingerprint }; }],
    ['POST', /^\/api\/pair$/, (_req, res, _m, body) => {
      const b = parse(z.object({ code: z.string().max(20), label: z.string().max(60).default('Phone') }), body);
      const token = ctx.gate.pair(b.code, b.label);
      if (!token) throw new HttpError(401, 'Pairing code is wrong or expired. Generate a new one on the computer.');
      res.setHeader('set-cookie', `lts_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 180}`);
      return { ok: true };
    }],
    ['GET', /^\/api\/sessions$/, (req) => { loopbackOnly(req); return store.sessions(); }],
    ['DELETE', /^\/api\/sessions\/(\w+)$/, (req, _s, m) => { loopbackOnly(req); store.revokeSession(m[1]!); return { ok: true }; }],
    ['POST', /^\/api\/shutdown$/, (req) => { loopbackOnly(req); setTimeout(ctx.shutdown, 100); return { ok: true }; }],
    ['GET', /^\/api\/session$/, () => marketSession(engine)],
  ];

  const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
  const securityHeaders = (res: ServerResponse) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  };

  function serveStatic(path: string, res: ServerResponse) {
    const clean = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '');
    let file = join(ctx.webDir, clean);
    if (!file.startsWith(ctx.webDir) || !existsSync(file) || statSync(file).isDirectory()) file = join(ctx.webDir, 'index.html');
    if (!existsSync(file)) { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('Web UI not built. Run: npm run build'); return; }
    const ext = extname(file);
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': file.includes(`${'assets'}`) ? 'public, max-age=31536000, immutable' : 'no-cache' });
    createReadStream(file).pipe(res);
  }

  async function handle(req: IncomingMessage, res: ServerResponse, lanListener: boolean) {
    const url = new URL(req.url ?? '/', 'http://x');
    securityHeaders(res);
    const denied = ctx.gate.check(req, lanListener, url.pathname);
    if (denied) return json(res, denied[0], { error: denied[1] });
    if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
    const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
    if (!route) return json(res, 404, { error: 'Not found' });
    try {
      const body = await readBody(req, url.pathname === '/api/import/apply' || url.pathname === '/api/import/preview' ? 200 * 1024 * 1024 : 1024 * 1024);
      const out = await route[2](req, res, url.pathname.match(route[1])!, body, url);
      if (out !== undefined && !res.headersSent) json(res, 200, out);
    } catch (e) {
      const status = e instanceof HttpError || e instanceof EngineError ? e.status : 500;
      if (status === 500) console.error('[api]', req.method, url.pathname, (e as Error).message);
      if (!res.headersSent) json(res, status, { error: (e as Error).message });
    }
  }

  function upgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer, lanListener: boolean) {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws' || ctx.gate.check(req, lanListener, '/ws') || (lanListener && !ctx.gate.paired(req))) { socket.destroy(); return; }
    ws.handleUpgrade(req, socket, head, (s) => ws.emit('connection', s, req));
  }

  return { handle, upgrade, closeAll: () => { for (const c of clients.keys()) c.terminate(); ws.close(); } };
}
