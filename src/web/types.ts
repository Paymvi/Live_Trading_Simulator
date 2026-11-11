import type { Account, Instrument, Order, OrderType, Side, TIF } from '../domain/types';

export type { Account, Instrument, Order, OrderType, Side, TIF };
export type AccountRow = Account & { equity: string | null };
export type OrderRow = Order & { remaining: string; waitingReason: string; instrumentName: string };
export interface PositionRow {
  symbol: string; name: string; assetClass: string; direction: 'long' | 'short'; qty: string; avgPrice: string; costBasis: string;
  mark: { price: string | null; source: string; ts: number | null; stale: boolean }; marketValue: string; unrealized: string; unrealizedPct: number | null;
  dayChange: string | null; weight: number | null; lots: { id: string; qty: string; price: string; openedAt: number; openFee: string; fundedUnsettledUntil: string | null }[];
}
export interface Summary {
  account: Account;
  rules: { version: string; current: string };
  balances: Record<string, string> & { restricted: boolean; staleMarks: string[] };
  totals: Record<string, string | number | null>;
  positions: PositionRow[];
  openOrders: OrderRow[];
  recent: { orderId: string; ts: number; type: string; message: string }[];
  violations: { ts: number; kind: string; detail: string }[];
}
export type InstrumentView = Instrument & { allowed: { types: OrderType[]; tifs: TIF[]; sides: Side[]; extended: boolean; strategies: ('single' | 'oco' | 'oto' | 'otoco')[] }; streamed: boolean };
export interface Preview {
  errors: string[]; warnings: string[]; info: string[];
  legs: { order: Order; estValue: string; estFees: string; feeLines: string[] }[];
  before: Record<string, string>; after: Record<string, string>;
}
