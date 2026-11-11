import { describe, expect, it } from 'vitest';
import { D } from '../src/domain/money';
import { dayOrderExpiry, etParts, etToMs, isTradingDay, nextRegularOpen, sessionAt, settleDate } from '../src/domain/calendar';
import { computeFees } from '../src/domain/rules';
import { benchmarkSeries, buildTrades, dailyPnl, maxDrawdown, tradeStats, timeWeightedReturn, type LotClose } from '../src/domain/analytics';
import type { LedgerEntry } from '../src/domain/types';

describe('calendar', () => {
  it('converts New York wall time across daylight-saving changes', () => {
    expect(new Date(etToMs('2026-03-06', 9 * 60 + 30)).toISOString()).toBe('2026-03-06T14:30:00.000Z'); // EST
    expect(new Date(etToMs('2026-03-09', 9 * 60 + 30)).toISOString()).toBe('2026-03-09T13:30:00.000Z'); // EDT
    expect(new Date(etToMs('2026-11-02', 9 * 60 + 30)).toISOString()).toBe('2026-11-02T14:30:00.000Z'); // back to EST
    expect(etParts(Date.parse('2026-07-01T20:00:00Z')).minutes).toBe(16 * 60);
  });

  it('knows holidays, early closes and sessions', () => {
    expect(isTradingDay('2026-11-26')).toBe(false); // Thanksgiving
    expect(isTradingDay('2026-07-03')).toBe(false); // Independence Day observed
    expect(isTradingDay('2026-11-28')).toBe(false); // Saturday
    expect(sessionAt(etToMs('2026-11-27', 12 * 60 + 59), 'nyse')).toBe('regular');
    expect(sessionAt(etToMs('2026-11-27', 13 * 60 + 1), 'nyse')).toBe('post'); // early close 1pm
    expect(sessionAt(etToMs('2026-11-10', 9 * 60 + 29), 'nyse')).toBe('closed'); // 9:28-9:30 gap
    expect(sessionAt(etToMs('2026-11-10', 7 * 60), 'nyse')).toBe('pre');
    expect(sessionAt(etToMs('2026-11-28', 12 * 60), '24x7')).toBe('continuous');
  });

  it('settles T+1 over weekends and holidays; day orders expire at the right close', () => {
    expect(settleDate(etToMs('2026-11-25', 11 * 60), 'nyse', 1)).toBe('2026-11-27'); // skips Thanksgiving
    expect(settleDate(etToMs('2026-11-13', 11 * 60), 'nyse', 1)).toBe('2026-11-16'); // Friday -> Monday
    expect(settleDate(etToMs('2026-11-13', 11 * 60), '24x7', 1)).toBeNull();
    expect(dayOrderExpiry(etToMs('2026-11-27', 8 * 60))).toBe(etToMs('2026-11-27', 13 * 60));
    expect(dayOrderExpiry(etToMs('2026-11-25', 17 * 60))).toBe(etToMs('2026-11-27', 13 * 60));
    expect(nextRegularOpen(etToMs('2026-11-25', 17 * 60))).toBe(etToMs('2026-11-27', 9 * 60 + 30));
  });
});

describe('fees', () => {
  it('applies SEC fee to sales; TAF outside the pause window; crypto 1%', () => {
    const before = computeFees('equity', 'sell', D(1000), D(50), etToMs('2026-09-15', 11 * 60));
    expect(before.secFee.toFixed(2)).toBe('1.03'); // 50,000 * 20.60 / 1e6 = 1.03
    expect(before.taf.toFixed(2)).toBe('0.17'); // 1000 * 0.000166 = 0.166 -> 0.17
    const paused = computeFees('equity', 'sell', D(1000), D(50), etToMs('2026-11-10', 11 * 60));
    expect(paused.taf.toFixed(2)).toBe('0.00');
    const cap = computeFees('equity', 'sell', D(100000), D(1), etToMs('2026-09-15', 11 * 60));
    expect(cap.taf.toFixed(2)).toBe('8.30');
    expect(computeFees('equity', 'buy', D(1000), D(50), etToMs('2026-09-15', 11 * 60)).total.toFixed(2)).toBe('0.00');
    expect(computeFees('crypto', 'buy', D('0.5'), D('60000'), Date.now()).total.toFixed(2)).toBe('300.00');
  });
});

describe('analytics', () => {
  const lc = (o: Partial<LotClose>): LotClose => ({ id: 'x', accountId: 'a', lotId: 'l', fillId: 'f', orderId: 'o1', symbol: 'X', direction: 'long', qty: '10', openPrice: '10', closePrice: '11', openedAt: 0, closedAt: 3_600_000, gross: '10', fees: '0', ...o });

  it('counts each closing order as one trade and computes statistics', () => {
    const trades = buildTrades([
      lc({ orderId: 'o1', gross: '10', fees: '1' }), lc({ orderId: 'o1', lotId: 'l2', gross: '5', fees: '0' }), // one trade from two lots
      lc({ orderId: 'o2', gross: '-20', fees: '1', closedAt: 7_200_000 }),
      lc({ orderId: 'o3', gross: '30', fees: '0', closedAt: 9_000_000 }),
    ]);
    expect(trades).toHaveLength(3);
    const s = tradeStats(trades);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.winRate).toBeCloseTo(2 / 3);
    expect(s.avgWin!.toFixed(2)).toBe('22.00');
    expect(s.avgLoss!.toFixed(2)).toBe('-21.00');
    expect(s.profitFactor).toBeCloseTo(44 / 21);
    expect(s.expectancy!.toFixed(2)).toBe('7.67');
    expect(s.best!.orderId).toBe('o3');
  });

  it('reports undefined statistics honestly', () => {
    const s = tradeStats([]);
    expect(s.winRate).toBeNull();
    expect(s.profitFactor).toBeNull();
    expect(s.profitFactorNote).toBe('No closed trades yet');
    expect(tradeStats(buildTrades([lc({})])).profitFactorNote).toBe('Undefined: no losing trades');
  });

  const led = (kind: LedgerEntry['kind'], amount: string, ts: number): LedgerEntry => ({ id: kind + ts, accountId: 'a', ts, kind, amount, settleDate: null, symbol: null, orderId: null, fillId: null, memo: '' });

  it('daily P&L and TWR exclude deposits and withdrawals', () => {
    const d1 = etToMs('2026-11-09', 12 * 60), d2 = etToMs('2026-11-10', 12 * 60), d3 = etToMs('2026-11-11', 12 * 60);
    const ledger = [led('INITIAL', '100000', d1), led('DEPOSIT', '50000', d2)];
    const vals = [{ ts: d1, equity: '101000', cash: '0', longValue: '0', shortValue: '0', stale: 0 }, { ts: d2, equity: '151000', cash: '0', longValue: '0', shortValue: '0', stale: 0 }, { ts: d3, equity: '148000', cash: '0', longValue: '0', shortValue: '0', stale: 0 }];
    const daily = dailyPnl(vals, ledger);
    expect(daily.map((d) => d.pnl.toFixed(0))).toEqual(['1000', '0', '-3000']);
    expect(timeWeightedReturn(daily)).toBeCloseTo(1.01 * (1 - 3000 / 151000) - 1, 10);
  });

  it('max drawdown is peak-to-trough', () => {
    const dd = maxDrawdown([100, 120, 90, 130, 117].map((e, i) => ({ ts: i, equity: D(e) })));
    expect(dd.pct).toBeCloseTo(0.25);
    expect(dd.amount.toFixed(0)).toBe('30');
  });

  it('benchmark buys units with each external cash flow at that day close', () => {
    const ledger = [led('INITIAL', '1000', etToMs('2026-11-09', 10 * 60)), led('DEPOSIT', '1000', etToMs('2026-11-11', 10 * 60))];
    const s = benchmarkSeries([{ date: '2026-11-09', close: '100' }, { date: '2026-11-10', close: '110' }, { date: '2026-11-11', close: '50' }], ledger, '2026-11-09');
    expect(s.map((x) => x.value.toFixed(0))).toEqual(['1000', '1100', '1500']);
  });
});
