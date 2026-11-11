import { D, cents, centsUp, ZERO, type Dec } from './money';
import { etDate } from './calendar';
import type { AssetClass, Side } from './types';

/**
 * Versioned brokerage rule set. Values come from official pages checked on `checked`.
 * `estimate: true` marks values that are approximations or could not be verified; the UI labels them.
 */
export const RULES_VERSION = 'fidelity-2026-11-10';

export const RULES = {
  version: RULES_VERSION,
  checked: '2026-11-10',
  commissions: {
    equity: { perOrder: '0', source: 'https://www.fidelity.com/trading/commissions-margin-rate' },
    cryptoPct: { value: '0.01', source: 'https://www.fidelity.com/crypto/help/trading/trading-fees', note: '1% of executed value (Fidelity Crypto)' },
  },
  secFee: { perMillion: '20.60', effective: '2026-04-04', source: 'https://www.sec.gov/rules-regulations/fee-rate-advisories/2026-2', estimate: true, note: 'Rounding to the cent is an estimate.' },
  taf: {
    perShare: '0.000166', maxPerTrade: '8.30', source: 'https://www.finra.org/finramanual/org/bylaws_A_1/',
    pauseFrom: '2026-10-01', pauseTo: '2026-12-31', pauseSource: 'https://www.finra.org/rules-guidance/rule-filings/sr-finra-2026-021',
    estimate: true, note: 'Pause filed for immediate effectiveness; not independently confirmed. Whether Fidelity passes the TAF through is assumed.',
  },
  settlement: { equityTPlus: 1, source: 'https://www.fidelity.com/trading/faqs-trading-restrictions', cryptoNote: 'Crypto proceeds treated as settled immediately (assumption).' },
  cashAccount: {
    gfvLimit: 3, restrictionDays: 90, windowDays: 365,
    source: 'https://www.fidelity.com/trading/faqs-trading-restrictions',
  },
  margin: {
    minEquity: '2000',
    initialLong: '0.50', initialShort: '0.50',
    maintLong: '0.30', maintShort: '0.35',
    lowPriceFull: '3', lowPriceFloor: '10', lowPricePerShare: '3',
    minShortPrice: '5', // shortcut: low-priced short requirements not verified, so shorts under $5 are blocked
    source: 'https://www.fidelity.com/trading/faqs-margin',
    note: 'Fidelity base house maintenance 30% long / 35% short. Rules-based add-ons (concentration, liquidity) are not modeled.',
  },
  marginRate: {
    base: '10.825', effective: '2026-09-18', dayCount: 360, dayCountEstimate: true,
    tiers: [ // [minDebit, adjustment to base]
      ['250000', '-0.500'], ['100000', '-0.250'], ['50000', '-0.200'], ['25000', '0.750'], ['0', '1.250'],
    ] as [string, string][],
    note: 'Tiers above $499,999 are not published on the page we checked; the $250k tier is used.',
    source: 'https://www.fidelity.com/trading/commissions-margin-rate',
  },
  borrow: { annualPct: '0.50', estimate: true, note: 'Stock borrow fees are not observable from quotes. Default is an assumed easy-to-borrow rate; configurable.' },
  gtcDays: 180,
  intradayMargin: { note: 'FINRA replaced the pattern-day-trader rule with intraday margin standards effective 2026-06-04 (Reg. Notice 26-10). The simulator checks maintenance margin continuously instead of counting day trades.', source: 'https://www.finra.org/compliance-tools/weekly-archive/04152026' },
} as const;

export interface FeeBreakdown { commission: Dec; secFee: Dec; taf: Dec; total: Dec; lines: string[] }

export function computeFees(assetClass: AssetClass, side: Side, qty: Dec, price: Dec, ts: number): FeeBreakdown {
  const value = qty.times(price);
  const lines: string[] = [];
  if (assetClass === 'crypto') {
    const c = cents(value.times(RULES.commissions.cryptoPct.value));
    lines.push(`Crypto fee 1% of $${cents(value).toFixed(2)} = $${c.toFixed(2)}`);
    return { commission: c, secFee: ZERO, taf: ZERO, total: c, lines };
  }
  let secFee = ZERO, taf = ZERO;
  const isSale = side === 'sell' || side === 'sell_short';
  const date = etDate(ts);
  if (isSale) {
    if (date >= RULES.secFee.effective) {
      secFee = centsUp(value.times(RULES.secFee.perMillion).div(1_000_000));
      if (secFee.gt(0)) lines.push(`SEC Section 31 fee (est.) $${secFee.toFixed(2)}`);
    }
    const paused = date >= RULES.taf.pauseFrom && date <= RULES.taf.pauseTo;
    if (!paused) {
      taf = centsUp(qty.ceil().times(RULES.taf.perShare));
      if (taf.gt(RULES.taf.maxPerTrade)) taf = D(RULES.taf.maxPerTrade);
      if (taf.gt(0)) lines.push(`FINRA TAF (est.) $${taf.toFixed(2)}`);
    } else lines.push('FINRA TAF paused Oct 1-Dec 31 2026 (per filing)');
  }
  return { commission: ZERO, secFee, taf, total: secFee.plus(taf), lines };
}

export function marginRatePct(debit: Dec): Dec {
  for (const [minDebit, adj] of RULES.marginRate.tiers) if (debit.gte(minDebit)) return D(RULES.marginRate.base).plus(adj);
  return D(RULES.marginRate.base);
}

/** Execution model assumptions. Configurable per service; every fill records the values used. */
export interface ExecutionModel {
  version: string;
  latencyMs: number; // order may only use market data stamped >= acceptance + latency
  slippageBps: number; // adverse adjustment applied to the touch price
  liquidityMultiplier: number; // fraction of displayed top-of-book size we assume is available per quote
  maxQuoteAgeMs: number; // older quotes are not executable
  maxSpreadPct: number; // wider quotes are treated as not executable
  stopTriggerBasis: 'quote' | 'trade' | 'either';
  borrowAnnualPct: string;
}

export const DEFAULT_MODEL: ExecutionModel = {
  version: 'exec-1',
  latencyMs: 250,
  slippageBps: 2,
  liquidityMultiplier: 1,
  maxQuoteAgeMs: 120_000, // IEX only re-sends a quote when it changes; liveness is tracked separately per connection
  maxSpreadPct: 5,
  stopTriggerBasis: 'either',
  borrowAnnualPct: RULES.borrow.annualPct,
};
