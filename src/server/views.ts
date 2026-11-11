import { D, ZERO, type Dec } from '../domain/money';
import { addDays, etDate, etToMs, sessionAt, sessionLabel } from '../domain/calendar';
import { aggregate, benchmarkSeries, buildTrades, dailyPnl, EXTERNAL_KINDS, isoWeek, maxDrawdown, timeWeightedReturn, tradeStats } from '../domain/analytics';
import { remaining } from '../domain/accounting';
import { RULES } from '../domain/rules';
import type { Order } from '../domain/types';
import type { Engine } from './engine';
import type { BarsResult } from './providers/types';

/** View models for the UI. Decimals are serialized as strings; ratios as numbers. */
const s = (d: Dec | null | undefined, dp?: number) => (d == null ? null : dp === undefined ? d.toFixed() : d.toDecimalPlaces(dp).toFixed());

export function orderView(engine: Engine, o: Order) {
  return { ...o, remaining: remaining(o).toFixed(), waitingReason: engine.explainWaiting(o), instrumentName: engine.hub.instrument(o.symbol)?.name ?? o.symbol };
}

function startOfDayEquity(engine: Engine, accountId: string, today: string): { base: Dec; flowsToday: Dec } {
  const vals = engine.store.valuations(accountId);
  const prior = [...vals].reverse().find((v) => etDate(v.ts) < today);
  const ledger = engine.store.ledger(accountId);
  const flowsToday = ledger.filter((e) => EXTERNAL_KINDS.includes(e.kind) && etDate(e.ts) === today).reduce((a, e) => a.plus(e.amount), ZERO);
  // flows that happened before the first valuation of a previous day are already in `prior`
  return { base: prior ? D(prior.equity) : ZERO, flowsToday: prior ? flowsToday : ledger.filter((e) => EXTERNAL_KINDS.includes(e.kind) && etDate(e.ts) <= today).reduce((a, e) => a.plus(e.amount), ZERO) };
}

export function summary(engine: Engine, accountId: string) {
  const st = engine.state(accountId);
  const now = engine.now();
  const today = etDate(now);
  const startToday = etToMs(today, 0);
  const b = st.balances;
  const ledger = st.ledger;
  const sumKind = (...k: string[]) => ledger.filter((e) => k.includes(e.kind)).reduce((a, e) => a.plus(e.amount), ZERO);
  const external = sumKind(...EXTERNAL_KINDS);
  const closes = engine.store.lotCloses(accountId);
  const realizedGross = closes.reduce((a, c) => a.plus(c.gross), ZERO);
  const unrealized = st.positions.reduce((a, p) => a.plus(p.unrealized), ZERO);
  const { base, flowsToday } = startOfDayEquity(engine, accountId, today);
  const positions = st.positions.map((p) => {
    const q = engine.hub.quote(p.symbol);
    const inst = engine.hub.instrument(p.symbol);
    const px = p.mark.price;
    let dayChange: Dec | null = null;
    if (px) {
      dayChange = p.lots.reduce((a, l) => {
        const ref = l.openedAt < startToday && q?.prevClose ? D(q.prevClose) : D(l.price);
        const diff = px.minus(ref).times(l.openQty);
        return a.plus(l.direction === 'long' ? diff : diff.neg());
      }, ZERO);
    }
    return {
      symbol: p.symbol, name: inst?.name ?? p.symbol, assetClass: p.assetClass, direction: p.direction, qty: s(p.qty), avgPrice: s(p.avgPrice, 4), costBasis: s(p.costBasis, 2),
      mark: { price: s(p.mark.price), source: p.mark.source, ts: p.mark.ts, stale: p.mark.stale }, marketValue: s(p.marketValue, 2), unrealized: s(p.unrealized, 2),
      unrealizedPct: p.costBasis.gt(0) ? p.unrealized.div(p.costBasis).toNumber() : null, dayChange: s(dayChange, 2),
      weight: b.equity.gt(0) ? p.marketValue.div(b.equity).toNumber() : null,
      lots: p.lots.map((l) => ({ id: l.id, qty: l.openQty, price: l.price, openedAt: l.openedAt, openFee: s(D(l.openFee), 2), fundedUnsettledUntil: l.fundedUnsettledUntil })),
    };
  });
  return {
    account: st.account,
    rules: { version: st.account.rulesVersion, current: RULES.version },
    balances: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v && typeof v === 'object' && 'toFixed' in v ? (v as Dec).toDecimalPlaces(2).toFixed() : v])),
    totals: {
      externalFlows: s(external, 2), totalPnl: s(b.equity.minus(external), 2),
      totalReturnOnFlows: external.gt(0) ? b.equity.minus(external).div(external).toNumber() : null,
      realizedGross: s(realizedGross, 2), unrealized: s(unrealized, 2),
      fees: s(sumKind('FEE').neg(), 2), interest: s(sumKind('INTEREST').neg(), 2), borrowFees: s(sumKind('BORROW_FEE').neg(), 2), dividends: s(sumKind('DIVIDEND'), 2),
      dayPnl: s(b.equity.minus(base).minus(flowsToday), 2),
    },
    positions,
    openOrders: st.activeOrders.map((o) => orderView(engine, o)),
    recent: engine.store.accountEvents(accountId, 30),
    violations: engine.store.violations(accountId),
  };
}

export function analytics(engine: Engine, accountId: string) {
  const ledger = engine.store.ledger(accountId);
  const vals = engine.store.valuations(accountId);
  const st = engine.state(accountId);
  const live = { ts: engine.now(), equity: st.balances.equity.toDecimalPlaces(2).toFixed(), cash: st.balances.cash.toFixed(2), longValue: '0', shortValue: '0', stale: st.balances.staleMarks.length };
  const allVals = [...vals, live];
  const trades = buildTrades(engine.store.lotCloses(accountId));
  const stats = tradeStats(trades);
  const daily = dailyPnl(allVals, ledger);
  const dd = maxDrawdown(allVals.map((v) => ({ ts: v.ts, equity: D(v.equity) })));
  const sumKind = (k: string) => ledger.filter((e) => e.kind === k).reduce((a, e) => a.plus(e.amount), ZERO).neg();
  const step = Math.max(1, Math.floor(allVals.length / 1500));
  return {
    trades: trades.map((t) => ({ ...t, qty: s(t.qty), gross: s(t.gross, 2), fees: s(t.fees, 2), net: s(t.net, 2), entry: s(t.entry, 4), exit: s(t.exit, 4) })).reverse(),
    stats: {
      ...stats, avgWin: s(stats.avgWin, 2), avgLoss: s(stats.avgLoss, 2), expectancy: s(stats.expectancy, 2), grossRealized: s(stats.grossRealized, 2), netRealized: s(stats.netRealized, 2), tradeFees: s(stats.tradeFees, 2),
      best: stats.best ? { symbol: stats.best.symbol, net: s(stats.best.net, 2), closedAt: stats.best.closedAt } : null,
      worst: stats.worst ? { symbol: stats.worst.symbol, net: s(stats.worst.net, 2), closedAt: stats.worst.closedAt } : null,
    },
    costs: { fees: s(sumKind('FEE'), 2), interest: s(sumKind('INTEREST'), 2), borrow: s(sumKind('BORROW_FEE'), 2) },
    equityCurve: allVals.filter((_, i) => i % step === 0 || i === allVals.length - 1).map((v) => ({ ts: v.ts, equity: v.equity })),
    daily: daily.map((d) => ({ date: d.date, equity: s(d.equity, 2), flows: s(d.flows, 2), pnl: s(d.pnl, 2), ret: d.ret })),
    weekly: aggregate(daily, isoWeek).map((x) => ({ ...x, pnl: s(x.pnl, 2) })),
    monthly: aggregate(daily, (d) => d.slice(0, 7)).map((x) => ({ ...x, pnl: s(x.pnl, 2) })),
    drawdown: { pct: dd.pct, amount: s(dd.amount, 2), peakTs: dd.peakTs, troughTs: dd.troughTs },
    twr: timeWeightedReturn(daily),
    staleValuations: vals.filter((v) => v.stale > 0).length,
  };
}

export function recap(engine: Engine, accountId: string, date: string) {
  const start = etToMs(date, 0), end = etToMs(addDays(date, 1), 0);
  const ledger = engine.store.ledger(accountId).filter((e) => e.ts >= start && e.ts < end);
  const trades = buildTrades(engine.store.lotCloses(accountId).filter((c) => c.closedAt >= start && c.closedAt < end));
  const sm = summary(engine, accountId);
  const isToday = date === etDate(engine.now());
  const daily = dailyPnl(engine.store.valuations(accountId), engine.store.ledger(accountId)).find((d) => d.date === date);
  const sumKind = (k: string) => ledger.filter((e) => e.kind === k).reduce((a, e) => a.plus(e.amount), ZERO);
  return {
    date, isToday,
    dayPnl: isToday ? sm.totals.dayPnl : s(daily?.pnl ?? null, 2),
    closedTrades: trades.map((t) => ({ orderId: t.orderId, symbol: t.symbol, direction: t.direction, qty: s(t.qty), net: s(t.net, 2), gross: s(t.gross, 2), fees: s(t.fees, 2), holdMs: t.holdMs })),
    realizedNet: s(trades.reduce((a, t) => a.plus(t.net), ZERO), 2),
    openContributions: isToday ? sm.positions.map((p) => ({ symbol: p.symbol, direction: p.direction, dayChange: p.dayChange, unrealized: p.unrealized })) : [],
    fees: s(sumKind('FEE').neg(), 2), interest: s(sumKind('INTEREST').plus(sumKind('BORROW_FEE')).neg(), 2), dividends: s(sumKind('DIVIDEND'), 2),
    flows: s(ledger.filter((e) => EXTERNAL_KINDS.includes(e.kind)).reduce((a, e) => a.plus(e.amount), ZERO), 2),
    note: isToday ? 'Open-position contributions compare the current mark with the previous close (or the entry price for positions opened today).' : 'Past-day open-position contributions are not stored; the day total comes from end-of-day valuations.',
  };
}

const barCache = new Map<string, { at: number; data: BarsResult }>();
export async function bars(engine: Engine, symbol: string, range: string): Promise<BarsResult & { timeframe: string }> {
  const inst = engine.hub.instrument(symbol);
  if (!inst) throw new Error('Unknown instrument');
  const cfg: Record<string, [string, number, number]> = { // timeframe, lookback days, demo step minutes
    '1D': ['5Min', 4, 5], '5D': ['15Min', 8, 15], '1M': ['1Hour', 31, 60], '6M': ['1Day', 183, 1440], '1Y': ['1Day', 366, 1440], '5Y': ['1Week', 1830, 10080],
  };
  const [tf, days, step] = cfg[range] ?? cfg['1M']!;
  if (inst.provider === 'demo') return { ...engine.hub.demo.bars(symbol, step * 60_000, Math.min(400, Math.ceil((days * 1440) / step))), timeframe: tf };
  if (!engine.hub.alpaca) return { bars: [], source: 'none', note: 'Add a free Alpaca API key in Settings to load price history.', timeframe: tf };
  const key = `${symbol}|${range}`;
  const hit = barCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return { ...hit.data, timeframe: tf };
  const data = await engine.hub.alpaca.bars(symbol, inst.assetClass === 'crypto', tf, new Date(Date.now() - days * 86_400_000));
  if (range === '1D' && data.bars.length) { const last = etDate(data.bars.at(-1)!.t); data.bars = data.bars.filter((b) => etDate(b.t) === last); }
  barCache.set(key, { at: Date.now(), data });
  return { ...data, timeframe: tf };
}

export async function benchmark(engine: Engine, accountId: string, symbol: string) {
  const a = engine.account(accountId);
  const from = etDate(a.createdAt);
  const ledger = engine.store.ledger(accountId);
  const daily = dailyPnl([...engine.store.valuations(accountId)], ledger);
  if (a.mode === 'demo') return { available: false, reason: 'Benchmarks use real market history and are not shown for demo accounts.' };
  if (!engine.hub.alpaca) return { available: false, reason: 'Add a free Alpaca API key to load benchmark history.' };
  const start = new Date(etToMs(addDays(from, -7), 0));
  const [px, tr] = await Promise.all([engine.hub.alpaca.bars(symbol, false, '1Day', start, 'split'), engine.hub.alpaca.bars(symbol, false, '1Day', start, 'all')]);
  const toCloses = (r: BarsResult) => r.bars.map((b) => ({ date: etDate(b.t + 12 * 3600_000), close: String(b.c) }));
  const price = benchmarkSeries(toCloses(px), ledger, from), total = benchmarkSeries(toCloses(tr), ledger, from);
  if (price.length < 2) return { available: false, reason: `Not enough completed daily ${symbol} bars since account inception (${from}). Benchmarks need at least two trading-day closes; the free plan only serves bars older than 15 minutes.` };
  const firstDate = price[0]!.date;
  const acct = daily.filter((d) => d.date >= firstDate);
  return {
    available: true, symbol, from: firstDate, to: price.at(-1)!.date,
    series: price.map((p, i) => ({ date: p.date, priceReturnValue: s(p.value, 2), totalReturnValue: s(total[i]?.value ?? null, 2), account: s(acct.find((d) => d.date === p.date)?.equity ?? null, 2) })),
    accountTwr: timeWeightedReturn(acct),
    note: `Each fictional deposit buys ${symbol} at that day's close; withdrawals sell. "Price return" uses split-adjusted closes; "total return" uses split+dividend adjusted closes (Alpaca adjustment=all, an approximation of reinvested dividends). Only periods where both series exist are compared. Bars come from the consolidated SIP feed, available on the free plan once 15+ minutes old.`,
  };
}

export function marketSession(engine: Engine) {
  const now = engine.now();
  const s = sessionAt(now, 'nyse');
  return { session: s, label: sessionLabel(s), etDate: etDate(now) };
}
