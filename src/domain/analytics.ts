import { D, ZERO, type Dec } from './money';
import { etDate } from './calendar';
import type { LedgerEntry } from './types';

export interface LotClose {
  id: string; accountId: string; lotId: string; fillId: string; orderId: string; symbol: string;
  direction: 'long' | 'short'; qty: string; openPrice: string; closePrice: string;
  openedAt: number; closedAt: number; gross: string; fees: string;
}
export interface Valuation { ts: number; equity: string; cash: string; longValue: string; shortValue: string; stale: number }

/**
 * A counted trade = one closing order (all of its fills). Closing a position in three separate orders
 * produces three trades. Net P&L = gross lot P&L - the opening fees allocated to the closed quantity - closing fees.
 */
export interface Trade { orderId: string; symbol: string; direction: 'long' | 'short'; qty: Dec; gross: Dec; fees: Dec; net: Dec; openedAt: number; closedAt: number; holdMs: number; entry: Dec; exit: Dec }

export function buildTrades(closes: LotClose[]): Trade[] {
  const by = new Map<string, LotClose[]>();
  for (const c of closes) by.set(c.orderId, [...(by.get(c.orderId) ?? []), c]);
  return [...by.entries()].map(([orderId, cs]) => {
    const qty = cs.reduce((a, c) => a.plus(c.qty), ZERO);
    const gross = cs.reduce((a, c) => a.plus(c.gross), ZERO);
    const fees = cs.reduce((a, c) => a.plus(c.fees), ZERO);
    const holdW = cs.reduce((a, c) => a.plus(D(c.qty).times(c.closedAt - c.openedAt)), ZERO);
    const entry = cs.reduce((a, c) => a.plus(D(c.qty).times(c.openPrice)), ZERO).div(qty);
    const exit = cs.reduce((a, c) => a.plus(D(c.qty).times(c.closePrice)), ZERO).div(qty);
    return {
      orderId, symbol: cs[0]!.symbol, direction: cs[0]!.direction, qty, gross, fees, net: gross.minus(fees),
      openedAt: Math.min(...cs.map((c) => c.openedAt)), closedAt: Math.max(...cs.map((c) => c.closedAt)),
      holdMs: holdW.div(qty).toNumber(), entry, exit,
    };
  }).sort((a, b) => a.closedAt - b.closedAt);
}

export interface TradeStats {
  count: number; wins: number; losses: number; breakeven: number;
  winRate: number | null; avgWin: Dec | null; avgLoss: Dec | null; expectancy: Dec | null;
  profitFactor: number | null; profitFactorNote: string | null;
  best: Trade | null; worst: Trade | null; avgHoldMs: number | null;
  grossRealized: Dec; netRealized: Dec; tradeFees: Dec;
}

export function tradeStats(trades: Trade[]): TradeStats {
  const wins = trades.filter((t) => t.net.gt(0)), losses = trades.filter((t) => t.net.lt(0));
  const sumNet = (ts: Trade[]) => ts.reduce((a, t) => a.plus(t.net), ZERO);
  const gw = sumNet(wins), gl = sumNet(losses).abs();
  let profitFactor: number | null = null, profitFactorNote: string | null = null;
  if (trades.length === 0) profitFactorNote = 'No closed trades yet';
  else if (gl.eq(0)) profitFactorNote = wins.length ? 'Undefined: no losing trades' : 'Undefined: no wins or losses';
  else profitFactor = gw.div(gl).toNumber();
  const decided = wins.length + losses.length;
  const sorted = [...trades].sort((a, b) => a.net.cmp(b.net));
  return {
    count: trades.length, wins: wins.length, losses: losses.length, breakeven: trades.length - decided,
    winRate: decided ? wins.length / decided : null,
    avgWin: wins.length ? gw.div(wins.length) : null,
    avgLoss: losses.length ? gl.neg().div(losses.length) : null,
    expectancy: trades.length ? sumNet(trades).div(trades.length) : null,
    profitFactor, profitFactorNote,
    best: sorted.at(-1) ?? null, worst: sorted[0] ?? null,
    avgHoldMs: trades.length ? trades.reduce((a, t) => a + t.holdMs, 0) / trades.length : null,
    grossRealized: trades.reduce((a, t) => a.plus(t.gross), ZERO), netRealized: sumNet(trades),
    tradeFees: trades.reduce((a, t) => a.plus(t.fees), ZERO),
  };
}

export const EXTERNAL_KINDS: LedgerEntry['kind'][] = ['INITIAL', 'DEPOSIT', 'WITHDRAWAL'];

/** End-of-day equity per ET date (last valuation of the day). */
export function dailyEquity(vals: Valuation[]): { date: string; equity: Dec }[] {
  const m = new Map<string, Dec>();
  for (const v of [...vals].sort((a, b) => a.ts - b.ts)) m.set(etDate(v.ts), D(v.equity));
  return [...m.entries()].map(([date, equity]) => ({ date, equity }));
}

export interface DailyPnl { date: string; equity: Dec; flows: Dec; pnl: Dec; ret: number | null }

/** Daily P&L excludes deposits/withdrawals: pnl_d = equity_d - equity_{d-1} - externalFlows_d. */
export function dailyPnl(vals: Valuation[], ledger: LedgerEntry[]): DailyPnl[] {
  const flows = new Map<string, Dec>();
  for (const e of ledger) if (EXTERNAL_KINDS.includes(e.kind)) flows.set(etDate(e.ts), (flows.get(etDate(e.ts)) ?? ZERO).plus(e.amount));
  const days = dailyEquity(vals);
  let prev = ZERO;
  const out: DailyPnl[] = [];
  let flowCarry = ZERO;
  // flows on days without valuations are attributed to the next valued day
  const flowDates = [...flows.keys()].sort();
  let fi = 0;
  for (const d of days) {
    let f = flowCarry;
    while (fi < flowDates.length && flowDates[fi]! <= d.date) { f = f.plus(flows.get(flowDates[fi]!)!); fi++; }
    flowCarry = ZERO;
    const pnl = d.equity.minus(prev).minus(f);
    const base = prev.plus(f);
    out.push({ date: d.date, equity: d.equity, flows: f, pnl, ret: base.gt(0) ? pnl.div(base).toNumber() : null });
    prev = d.equity;
  }
  return out;
}

export function aggregate(daily: DailyPnl[], key: (date: string) => string): { period: string; pnl: Dec; ret: number | null }[] {
  const m = new Map<string, { pnl: Dec; growth: number; any: boolean }>();
  for (const d of daily) {
    const k = key(d.date);
    const cur = m.get(k) ?? { pnl: ZERO, growth: 1, any: false };
    cur.pnl = cur.pnl.plus(d.pnl);
    if (d.ret !== null) { cur.growth *= 1 + d.ret; cur.any = true; }
    m.set(k, cur);
  }
  return [...m.entries()].map(([period, v]) => ({ period, pnl: v.pnl, ret: v.any ? v.growth - 1 : null }));
}

export function isoWeek(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const w = Math.ceil(((t.getTime() - y0.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(w).padStart(2, '0')}`;
}

/** Time-weighted return: compounds daily returns so deposits/withdrawals do not count as performance. */
export const timeWeightedReturn = (daily: DailyPnl[]): number | null =>
  daily.some((d) => d.ret !== null) ? daily.reduce((g, d) => g * (1 + (d.ret ?? 0)), 1) - 1 : null;

export function maxDrawdown(points: { ts: number; equity: Dec }[]): { pct: number; amount: Dec; peakTs: number | null; troughTs: number | null } {
  let peak: { ts: number; equity: Dec } | null = null;
  let best = { pct: 0, amount: ZERO, peakTs: null as number | null, troughTs: null as number | null };
  for (const p of points) {
    if (!peak || p.equity.gt(peak.equity)) peak = p;
    if (peak.equity.gt(0)) {
      const dd = peak.equity.minus(p.equity);
      const pct = dd.div(peak.equity).toNumber();
      if (pct > best.pct) best = { pct, amount: dd, peakTs: peak.ts, troughTs: p.ts };
    }
  }
  return best;
}

/**
 * Buy-and-hold benchmark aligned to the account's own external cash flows:
 * every deposit buys benchmark units at that day's close, every withdrawal sells them.
 * Dates with no benchmark close use the next available close.
 */
export function benchmarkSeries(closes: { date: string; close: string }[], ledger: LedgerEntry[], fromDate: string): { date: string; value: Dec }[] {
  const cs = closes.filter((c) => c.date >= fromDate).sort((a, b) => a.date.localeCompare(b.date));
  const flows = ledger.filter((e) => EXTERNAL_KINDS.includes(e.kind)).map((e) => ({ date: etDate(e.ts), amt: D(e.amount) })).sort((a, b) => a.date.localeCompare(b.date));
  let units = ZERO, fi = 0;
  const out: { date: string; value: Dec }[] = [];
  for (const c of cs) {
    const px = D(c.close);
    while (fi < flows.length && flows[fi]!.date <= c.date) { units = units.plus(flows[fi]!.amt.div(px)); fi++; }
    out.push({ date: c.date, value: units.times(px) });
  }
  return out;
}
