import type { Instrument, MarketEvent } from '../../domain/types';

export interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }
export interface BarsResult { bars: Bar[]; source: string; note: string }
export type StreamScope = 'alpaca-equity' | 'alpaca-crypto' | 'demo';

export interface StreamStatus {
  scope: StreamScope;
  label: string;
  state: 'disabled' | 'connecting' | 'connected' | 'error' | 'closed';
  message: string;
  feed: string;
  delay: string;
  symbolLimit: number | null;
  subscribed: string[];
  lastMessageAt: number | null;
  lastEventAt: number | null;
  connectedSince: number | null;
}

export interface Snapshot {
  symbol: string;
  bid?: string; ask?: string; bidSize?: string; askSize?: string; quoteTs?: number;
  last?: string; lastSize?: string; lastTs?: number;
  prevClose?: string; dayOpen?: string;
}

export interface CorpAction { id: string; type: 'cash_dividend' | 'forward_split' | 'reverse_split'; symbol: string; exDate: string; payableDate: string | null; rate?: string; oldRate?: string; newRate?: string }

export interface StreamCallbacks {
  event: (ev: MarketEvent, scope: StreamScope) => void;
  connection: (scope: StreamScope, up: boolean, reason: string) => void;
}

export const num = (v: unknown): string | null => (typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? v : null);

export type { Instrument };
