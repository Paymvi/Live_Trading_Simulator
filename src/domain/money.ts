import Decimal from 'decimal.js';

// All money and quantities are decimal strings at rest and Decimal in computation. Never JS floats.
export const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -30, toExpPos: 40 });
export type Dec = Decimal;

export const D = (v: Decimal.Value | null | undefined): Decimal => new Dec(v ?? 0);
export const ZERO = D(0);
export const str = (d: Decimal): string => d.toFixed();
/** Round to cents, half-up (cash postings). */
export const cents = (d: Decimal): Decimal => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
export const centsUp = (d: Decimal): Decimal => d.toDecimalPlaces(2, Decimal.ROUND_UP);
export const max = (a: Decimal, b: Decimal): Decimal => (a.gte(b) ? a : b);
export const min = (a: Decimal, b: Decimal): Decimal => (a.lte(b) ? a : b);
export const sum = (xs: Decimal[]): Decimal => xs.reduce((a, b) => a.plus(b), ZERO);
export const isDecimalString = (s: unknown): s is string =>
  typeof s === 'string' && /^-?\d+(\.\d+)?$/.test(s) && s.length < 40;

export function fmtUsd(v: Decimal.Value, dp = 2): string {
  const d = D(v);
  const sign = d.isNeg() ? '-' : '';
  const [i, f] = d.abs().toFixed(dp).split('.');
  return `${sign}$${(i ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f ? '.' + f : ''}`;
}
