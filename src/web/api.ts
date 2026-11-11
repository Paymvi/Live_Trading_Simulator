import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { QuoteState } from '../domain/types';

export class ApiError extends Error { constructor(msg: string, readonly status: number) { super(msg); } }

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(path, {
    method: opts.method ?? 'GET',
    headers: { 'x-lts-client': '1', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new ApiError(data?.error ?? `HTTP ${r.status}`, r.status);
  return data as T;
}

// ---------------------------------------------------------------- live store (WebSocket)
export interface ServiceStatus {
  service: { pid: number; startedAt: number; heartbeat: number; mode: string };
  market: { session: string; label: string; etDate: string };
  streams: { scope: string; label: string; state: string; message: string; feed: string; delay: string; symbolLimit: number | null; subscribed: string[]; lastMessageAt: number | null; lastEventAt: number | null; connectedSince: number | null }[];
  events: { events: number; dropped: number; duplicates: number; lastEventAt: number | null; lastEventSymbol: string | null };
  notStreamed: string[];
  gaps: { id: number; scope: string; startTs: number; endTs: number | null; reason: string }[];
  backups: { last: { ts: number; file: string | null; ok: number; message: string }[] };
  corp: { ok: boolean; checkedAt: number | null; message: string; blocked: string[] };
  provider: { alpacaConfigured: boolean; catalog: number };
  lan: { enabled: boolean; urls: string[]; fingerprint: string | null };
}

interface LiveState { connected: boolean; status: ServiceStatus | null; quotes: Record<string, QuoteState>; accountVersion: Record<string, number>; lastMessage: number }
let state: LiveState = { connected: false, status: null, quotes: {}, accountVersion: {}, lastMessage: 0 };
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const set = (p: Partial<LiveState>) => { state = { ...state, ...p }; emit(); };

let ws: WebSocket | null = null;
const views = new Map<number, string[]>();
let viewSeq = 0;
function sendViews() {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'view', symbols: [...new Set([...views.values()].flat())] }));
}
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { set({ connected: true }); sendViews(); };
  ws.onclose = () => { set({ connected: false }); setTimeout(connect, 2000); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const now = Date.now();
    if (m.type === 'quote') state = { ...state, quotes: { ...state.quotes, [m.quote.symbol]: m.quote }, lastMessage: now };
    else if (m.type === 'status' || m.type === 'hello') state = { ...state, status: m.status, lastMessage: now };
    else if (m.type === 'account') state = { ...state, accountVersion: { ...state.accountVersion, [m.accountId]: (state.accountVersion[m.accountId] ?? 0) + 1 }, lastMessage: now };
    emit();
  };
}
connect();

export function useLive<T>(sel: (s: LiveState) => T): T {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => sel(state));
}

/** Subscribe the server to quotes for symbols currently on screen. */
export function useQuotes(symbols: string[]): Record<string, QuoteState> {
  const key = symbols.join(',');
  useEffect(() => {
    const id = ++viewSeq;
    views.set(id, key ? key.split(',') : []);
    sendViews();
    return () => { views.delete(id); sendViews(); };
  }, [key]);
  return useLive((s) => s.quotes);
}

/** Fetch JSON; refetch when deps change, when the account changes on the server, and optionally on an interval. */
export function useApi<T>(path: string | null, opts: { accountId?: string | null; intervalMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const version = useLive((s) => (opts.accountId ? s.accountVersion[opts.accountId] ?? 0 : 0));
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((x) => x + 1), []);
  const pathRef = useRef(path);
  pathRef.current = path;
  useEffect(() => {
    if (!path) { setData(null); return; }
    let live = true;
    const t = setTimeout(() => {
      api<T>(path).then((d) => { if (live && pathRef.current === path) { setData(d); setError(null); } }).catch((e) => live && setError((e as Error).message));
    }, version ? 150 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [path, version, tick]);
  useEffect(() => {
    if (!opts.intervalMs || !path) return;
    const i = setInterval(() => { if (document.visibilityState === 'visible') reload(); }, opts.intervalMs);
    return () => clearInterval(i);
  }, [opts.intervalMs, path, reload]);
  return { data, error, reload };
}

export function usePref<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => { try { const r = localStorage.getItem(key); return r ? (JSON.parse(r) as T) : initial; } catch { return initial; } });
  const save = useCallback((x: T) => { setV(x); try { localStorage.setItem(key, JSON.stringify(x)); } catch { /* storage unavailable */ } }, [key]);
  return [v, save];
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
