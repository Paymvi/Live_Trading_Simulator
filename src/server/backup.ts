import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { isDecimalString } from '../domain/money';
import { RULES } from '../domain/rules';
import type { Account, Fill, LedgerEntry, Lot, Order } from '../domain/types';
import type { LotClose, Valuation } from '../domain/analytics';
import type { JournalEntry, Store, Watchlist } from './db';

export const BACKUP_FORMAT = 'live-trading-simulator-backup';
export const BACKUP_FORMAT_VERSION = 1;
const KEEP_AUTO = 14;

// ---------------------------------------------------------------- database snapshots
/** Consistent online snapshot of the SQLite database (SQLite backup API). */
export async function snapshotDb(store: Store, dir: string, label: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `${label}-${stamp}.sqlite`);
  try {
    await store.db.backup(file);
    store.logBackup(Date.now(), file, true, `${label} snapshot written`);
    if (label === 'auto') rotate(dir, 'auto-');
    return file;
  } catch (e) {
    store.logBackup(Date.now(), null, false, `${label} snapshot failed: ${(e as Error).message}`);
    throw e;
  }
}

function rotate(dir: string, prefix: string) {
  const files = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.sqlite'))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const x of files.slice(KEEP_AUTO)) unlinkSync(join(dir, x.f));
}

// ---------------------------------------------------------------- JSON export
export interface AccountBundle {
  account: Account; ledger: LedgerEntry[]; orders: Order[]; orderEvents: { orderId: string; ts: number; type: string; message: string; data: string | null }[];
  fills: Fill[]; lots: Lot[]; lotCloses: LotClose[]; valuations: Valuation[]; journal: JournalEntry[]; violations: { ts: number; kind: string; detail: string }[];
}
export interface BackupFile {
  format: typeof BACKUP_FORMAT; formatVersion: number; schemaVersion: number; exportedAt: string; rulesVersion: string;
  executionModel: unknown; accounts: AccountBundle[]; watchlists: Watchlist[]; checksum: string;
}

const checksum = (b: Pick<BackupFile, 'accounts' | 'watchlists'>) => createHash('sha256').update(JSON.stringify({ a: b.accounts, w: b.watchlists })).digest('hex');

export function bundle(store: Store, accountId: string): AccountBundle {
  const account = store.account(accountId);
  if (!account) throw new Error('Account not found');
  const orders = store.orders(accountId);
  return {
    account, ledger: store.ledger(accountId), orders,
    orderEvents: store.db.prepare('SELECT order_id as orderId, ts, type, message, data FROM order_events WHERE account_id=? ORDER BY id').all(accountId) as AccountBundle['orderEvents'],
    fills: store.fills(accountId), lots: store.lots(accountId), lotCloses: store.lotCloses(accountId), valuations: store.valuations(accountId),
    journal: store.journal(accountId), violations: store.violations(accountId),
  };
}

export function exportJson(store: Store, accountIds: string[] | null): BackupFile {
  const ids = accountIds ?? store.accounts().map((a) => a.id);
  const accounts = ids.map((id) => bundle(store, id));
  const watchlists = accountIds ? [] : store.watchlists();
  return {
    format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, schemaVersion: store.schemaVersion, exportedAt: new Date().toISOString(),
    rulesVersion: RULES.version, executionModel: store.setting('execution_model', {}), accounts, watchlists, checksum: checksum({ accounts, watchlists }),
  };
}

// ---------------------------------------------------------------- CSV export
// Spreadsheet formula-injection guard: text starting with = + - @ gets a ' prefix; plain numbers stay numeric.
const csvCell = (v: unknown) => {
  const raw = v === null || v === undefined ? '' : String(v);
  const s = /^[=+\-@]/.test(raw) && !/^-?\d+(\.\d+)?$/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(s) || s !== raw ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (head: string[], rows: unknown[][]) => [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

export function exportCsv(store: Store, accountId: string, kind: 'fills' | 'ledger' | 'trades'): string {
  if (kind === 'fills') return csv(['fill_id', 'order_id', 'time_utc', 'symbol', 'side', 'qty', 'price', 'fees', 'quote_event_time_utc', 'reconstructed'],
    store.fills(accountId).map((f) => [f.id, f.orderId, new Date(f.ts).toISOString(), f.symbol, f.side, f.qty, f.price, f.fees, new Date(f.eventTs).toISOString(), f.reconstructed]));
  if (kind === 'trades') return csv(['closing_order_id', 'lot_id', 'symbol', 'direction', 'qty', 'open_price', 'close_price', 'opened_utc', 'closed_utc', 'gross_pnl', 'fees', 'net_pnl'],
    store.lotCloses(accountId).map((c) => [c.orderId, c.lotId, c.symbol, c.direction, c.qty, c.openPrice, c.closePrice, new Date(c.openedAt).toISOString(), new Date(c.closedAt).toISOString(), c.gross, c.fees, (Number(c.gross) - Number(c.fees)).toFixed(6)]));
  return csv(['entry_id', 'time_utc', 'kind', 'amount', 'settle_date', 'symbol', 'order_id', 'memo'],
    store.ledger(accountId).map((e) => [e.id, new Date(e.ts).toISOString(), e.kind, e.amount, e.settleDate, e.symbol, e.orderId, e.memo]));
}

// ---------------------------------------------------------------- import
const dec = z.string().refine(isDecimalString);
const ts = z.number().int().nonnegative();
const AccountZ = z.object({ id: z.string().min(1), name: z.string().min(1).max(60), type: z.enum(['cash', 'margin']), mode: z.enum(['live', 'demo']), initialCash: dec, createdAt: ts, archived: z.boolean(), rulesVersion: z.string(), restrictedUntil: z.string().nullable() });
const LedgerZ = z.object({ id: z.string(), accountId: z.string(), ts, kind: z.enum(['INITIAL', 'DEPOSIT', 'WITHDRAWAL', 'BUY', 'SELL', 'SHORT', 'COVER', 'FEE', 'INTEREST', 'BORROW_FEE', 'DIVIDEND', 'ADJUSTMENT']), amount: dec, settleDate: z.string().nullable(), symbol: z.string().nullable(), orderId: z.string().nullable(), fillId: z.string().nullable(), memo: z.string() });
const OrderZ = z.object({ id: z.string(), accountId: z.string(), symbol: z.string(), side: z.enum(['buy', 'sell', 'sell_short', 'buy_to_cover']), qty: dec, filledQty: dec, status: z.string(), type: z.string(), tif: z.string(), createdAt: ts }).passthrough();
const FillZ = z.object({ id: z.string(), orderId: z.string(), accountId: z.string(), symbol: z.string(), qty: dec, price: dec, fees: dec, ts }).passthrough();
const LotZ = z.object({ id: z.string(), accountId: z.string(), symbol: z.string(), direction: z.enum(['long', 'short']), openQty: dec, origQty: dec, price: dec, openFee: dec, openedAt: ts }).passthrough();
const LotCloseZ = z.object({ id: z.string(), accountId: z.string(), lotId: z.string(), orderId: z.string(), qty: dec, gross: dec.or(z.string().regex(/^-?\d+(\.\d+)?$/)), fees: dec, closedAt: ts }).passthrough();
const BundleZ = z.object({
  account: AccountZ, ledger: z.array(LedgerZ), orders: z.array(OrderZ), orderEvents: z.array(z.object({ orderId: z.string(), ts, type: z.string(), message: z.string(), data: z.string().nullable() })),
  fills: z.array(FillZ), lots: z.array(LotZ), lotCloses: z.array(LotCloseZ), valuations: z.array(z.object({ ts, equity: z.string(), cash: z.string() }).passthrough()),
  journal: z.array(z.object({ id: z.string(), accountId: z.string(), ts }).passthrough()), violations: z.array(z.object({ ts, kind: z.string(), detail: z.string() })),
});
const FileZ = z.object({
  format: z.literal(BACKUP_FORMAT), formatVersion: z.number().int(), schemaVersion: z.number().int(), exportedAt: z.string(), rulesVersion: z.string(),
  executionModel: z.unknown(), accounts: z.array(BundleZ).max(500), watchlists: z.array(z.object({ id: z.string(), name: z.string(), symbols: z.array(z.string()) })), checksum: z.string(),
});

export interface ImportPreview {
  ok: boolean; errors: string[]; warnings: string[];
  accounts: { id: string; name: string; type: string; mode: string; orders: number; fills: number; ledger: number; exists: boolean }[];
  watchlists: number; exportedAt: string | null; rulesVersion: string | null;
}

export function validateImport(store: Store, raw: unknown): { preview: ImportPreview; file: BackupFile | null } {
  const errors: string[] = [], warnings: string[] = [];
  const empty: ImportPreview = { ok: false, errors, warnings, accounts: [], watchlists: 0, exportedAt: null, rulesVersion: null };
  if (!raw || typeof raw !== 'object' || (raw as { format?: unknown }).format !== BACKUP_FORMAT) { errors.push('Not a Live Trading Simulator backup file.'); return { preview: empty, file: null }; }
  const v = (raw as { formatVersion?: unknown }).formatVersion;
  if (v !== BACKUP_FORMAT_VERSION) { errors.push(`Unsupported backup format version ${String(v)} (this app reads version ${BACKUP_FORMAT_VERSION}).`); return { preview: empty, file: null }; }
  const parsed = FileZ.safeParse(raw);
  if (!parsed.success) {
    errors.push(...parsed.error.issues.slice(0, 8).map((i) => `Invalid data at ${i.path.join('.')}: ${i.message}`));
    return { preview: empty, file: null };
  }
  const file = raw as BackupFile; // validated above; keep the raw object so the checksum covers exactly what was exported
  if (checksum(file) !== file.checksum) errors.push('Checksum mismatch: the file was modified or is corrupt.');
  if (file.schemaVersion > store.schemaVersion) errors.push(`Backup comes from a newer app (schema ${file.schemaVersion}).`);
  for (const b of file.accounts) {
    const id = b.account.id;
    const foreign = [...b.ledger, ...b.orders, ...b.fills, ...b.lots, ...b.lotCloses, ...b.journal].find((x) => x.accountId !== id);
    if (foreign) errors.push(`Account "${b.account.name}": contains rows belonging to another account.`);
    const orderIds = new Set(b.orders.map((o) => o.id));
    if (b.fills.some((f) => !orderIds.has(f.orderId))) errors.push(`Account "${b.account.name}": fills reference missing orders.`);
    const lotIds = new Set(b.lots.map((l) => l.id));
    if (b.lotCloses.some((c) => !lotIds.has(c.lotId))) errors.push(`Account "${b.account.name}": lot closes reference missing lots.`);
    if (!b.ledger.some((e) => e.kind === 'INITIAL')) warnings.push(`Account "${b.account.name}": no starting-capital entry.`);
  }
  if (file.rulesVersion !== RULES.version) warnings.push(`Backup used rules ${file.rulesVersion}; current rules are ${RULES.version}. Past fills are kept as recorded.`);
  const preview: ImportPreview = {
    ok: errors.length === 0, errors, warnings, watchlists: file.watchlists.length, exportedAt: file.exportedAt, rulesVersion: file.rulesVersion,
    accounts: file.accounts.map((b) => ({ id: b.account.id, name: b.account.name, type: b.account.type, mode: b.account.mode, orders: b.orders.length, fills: b.fills.length, ledger: b.ledger.length, exists: !!store.account(b.account.id) })),
  };
  return { preview, file: errors.length ? null : file };
}

/**
 * Apply a validated backup in ONE transaction (all or nothing).
 * mode 'copy': every account is imported as a new account (all ids re-keyed, no collisions).
 * mode 'replace': accounts with the same id are fully replaced; others are added.
 */
export function applyImport(store: Store, file: BackupFile, mode: 'copy' | 'replace', selected: string[] | null) {
  const sfx = randomBytes(3).toString('hex');
  const k = (id: string | null | undefined) => (id == null ? id ?? null : mode === 'copy' ? `${id}~${sfx}` : id);
  const imported: string[] = [];
  store.tx(() => {
    for (const b of file.accounts.filter((x) => !selected || selected.includes(x.account.id))) {
      const accId = k(b.account.id)!;
      if (mode === 'replace') store.deleteAccountData(b.account.id, true);
      store.putAccount({ ...b.account, id: accId, name: mode === 'copy' ? `${b.account.name} (imported)`.slice(0, 60) : b.account.name });
      for (const e of b.ledger) store.putLedger({ ...e, id: k(e.id)!, accountId: accId, orderId: k(e.orderId), fillId: k(e.fillId) });
      for (const o of b.orders) store.putOrder({ ...o, id: k(o.id)!, accountId: accId, parentId: k(o.parentId), ocoId: k(o.ocoId), groupId: k(o.groupId), replacesId: k(o.replacesId), clientKey: k(o.clientKey) });
      for (const e of b.orderEvents) store.orderEvent({ id: k(e.orderId)!, accountId: accId }, e.ts, e.type, e.message, e.data ? JSON.parse(e.data) : undefined);
      for (const f of b.fills) store.putFill({ ...f, id: k(f.id)!, orderId: k(f.orderId)!, accountId: accId });
      for (const l of b.lots) store.putLot({ ...l, id: k(l.id)!, accountId: accId, openFillId: k(l.openFillId)! });
      for (const c of b.lotCloses) store.putLotClose({ ...c, id: k(c.id)!, accountId: accId, lotId: k(c.lotId)!, fillId: k(c.fillId)!, orderId: k(c.orderId)! });
      for (const v of b.valuations) store.putValuation(accId, v);
      for (const j of b.journal) store.putJournal({ ...j, id: k(j.id)!, accountId: accId, orderId: k(j.orderId) });
      for (const v of b.violations) store.addViolation(accId, v.ts, v.kind, v.detail);
      imported.push(accId);
    }
    if (!selected) for (const w of file.watchlists) store.putWatchlist(mode === 'copy' ? { ...w, id: `${w.id}~${sfx}`, name: `${w.name} (imported)` } : w);
  });
  return imported;
}
