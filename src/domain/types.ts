// Normalized domain types shared by the service, tests and UI. Decimals are strings.

export type AssetClass = 'equity' | 'crypto';
export type DataMode = 'live' | 'demo';
export type AccountType = 'cash' | 'margin';
export type Side = 'buy' | 'sell' | 'sell_short' | 'buy_to_cover';
export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit' | 'trailing_stop' | 'trailing_stop_limit';
export type TIF = 'day' | 'gtc' | 'ioc' | 'fok';
export type OrderStatus =
  | 'pending_activation' // OTO/OTOCO child waiting for its primary order to fill
  | 'waiting_condition' // contingent order waiting for its price condition
  | 'open'
  | 'triggered' // stop reached; now behaves as market / limit
  | 'filled'
  | 'canceled'
  | 'expired'
  | 'rejected'
  | 'replaced';
export const ACTIVE_STATUSES: OrderStatus[] = ['pending_activation', 'waiting_condition', 'open', 'triggered'];
export type CalendarId = 'nyse' | '24x7';
export type Session = 'pre' | 'regular' | 'post' | 'closed' | 'continuous';

export interface Instrument {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  exchange: string;
  calendar: CalendarId;
  fractionable: boolean;
  marginable: boolean;
  shortable: boolean;
  easyToBorrow: boolean | null;
  qtyDecimals: number; // max decimals allowed in quantity
  minQty: string;
  priceIncrement: string | null; // crypto tick; equities use $0.01 / $0.0001 rule
  provider: 'alpaca' | 'demo';
}

/** One normalized market-data event. ts = exchange/provider timestamp (ms), receivedAt = local clock (ms). */
export type MarketEvent =
  | { kind: 'quote'; symbol: string; ts: number; receivedAt: number; bid: string; ask: string; bidSize: string; askSize: string; feed: string }
  | { kind: 'trade'; symbol: string; ts: number; receivedAt: number; price: string; size: string; feed: string };

export interface QuoteState {
  symbol: string;
  feed: string;
  bid: string | null;
  ask: string | null;
  bidSize: string | null;
  askSize: string | null;
  quoteTs: number | null;
  last: string | null;
  lastSize: string | null;
  lastTs: number | null;
  receivedAt: number;
  prevClose: string | null;
  dayOpen: string | null;
  /** True while the stream that delivered this quote has stayed connected since. Seeds from REST snapshots are never live. */
  live: boolean;
}

export interface ConditionTerm { symbol: string; field: 'last' | 'bid' | 'ask'; op: 'gte' | 'lte'; value: string }
export interface Condition { logic: 'all' | 'any'; terms: ConditionTerm[] }

export interface Order {
  id: string;
  accountId: string;
  clientKey: string | null;
  parentId: string | null; // OTO: activates when parent fills
  ocoId: string | null; // OCO group: a fill on one cancels the others
  groupId: string | null; // ties all legs of one ticket together for display
  symbol: string;
  assetClass: AssetClass;
  side: Side;
  qty: string;
  filledQty: string;
  avgFillPrice: string | null;
  type: OrderType;
  limitPrice: string | null;
  stopPrice: string | null;
  trailType: 'amount' | 'percent' | null;
  trailValue: string | null;
  limitOffset: string | null; // trailing stop limit: distance of limit from the trailing stop
  trailRef: string | null; // high-water (sell) / low-water (buy) mark
  tif: TIF;
  extended: boolean;
  aon: boolean;
  condition: Condition | null;
  status: OrderStatus;
  createdAt: number;
  acceptedAt: number | null; // time from which market data may fill/trigger it
  triggeredAt: number | null;
  expiresAt: number | null;
  closedAt: number | null;
  rejectReason: string | null;
  replacesId: string | null;
  estPrice: string | null; // price assumption used for reservations
  modelVersion: string;
  note: string | null;
}

export interface Lot {
  id: string;
  accountId: string;
  symbol: string;
  assetClass: AssetClass;
  direction: 'long' | 'short';
  openQty: string;
  origQty: string;
  price: string; // per-unit cost (long) or proceeds (short), split-adjusted
  openFee: string; // fee allocated to the remaining open quantity
  openedAt: number;
  openFillId: string;
  fundedUnsettledUntil: string | null; // cash account: date the funds used to buy settle (GFV tracking)
}

export interface LedgerEntry {
  id: string;
  accountId: string;
  ts: number;
  kind: 'INITIAL' | 'DEPOSIT' | 'WITHDRAWAL' | 'BUY' | 'SELL' | 'SHORT' | 'COVER' | 'FEE' | 'INTEREST' | 'BORROW_FEE' | 'DIVIDEND' | 'ADJUSTMENT';
  amount: string; // + credit, - debit
  settleDate: string | null; // YYYY-MM-DD; null = settled immediately
  symbol: string | null;
  orderId: string | null;
  fillId: string | null;
  memo: string;
}

export interface Fill {
  id: string;
  orderId: string;
  accountId: string;
  symbol: string;
  side: Side;
  qty: string;
  price: string;
  fees: string;
  ts: number; // simulated execution time
  eventTs: number; // timestamp of the market event used
  quote: string; // JSON of the quote used
  model: string; // JSON of execution assumptions
  reconstructed: boolean;
}

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  mode: DataMode;
  initialCash: string;
  createdAt: number;
  archived: boolean;
  rulesVersion: string;
  restrictedUntil: string | null; // cash account settled-cash-only restriction (YYYY-MM-DD)
}
