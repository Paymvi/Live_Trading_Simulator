import Database from 'better-sqlite3';
import type { Account, Fill, LedgerEntry, Lot, Order } from '../domain/types';
import type { LotClose, Valuation } from '../domain/analytics';

/**
 * SQLite is the single source of truth. Entities are stored as JSON documents with indexed key columns,
 * which keeps migrations simple. All multi-row changes go through `tx()` (atomic).
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
   CREATE TABLE orders (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, status TEXT NOT NULL, symbol TEXT NOT NULL,
     client_key TEXT, data TEXT NOT NULL, UNIQUE(account_id, client_key));
   CREATE INDEX orders_active ON orders(status, symbol);
   CREATE TABLE order_events (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, account_id TEXT NOT NULL,
     ts INTEGER NOT NULL, type TEXT NOT NULL, message TEXT NOT NULL, data TEXT);
   CREATE INDEX order_events_order ON order_events(order_id);
   CREATE INDEX order_events_account ON order_events(account_id, ts);
   CREATE TABLE fills (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, account_id TEXT NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL);
   CREATE INDEX fills_account ON fills(account_id, ts);
   CREATE TABLE lots (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, symbol TEXT NOT NULL, data TEXT NOT NULL);
   CREATE INDEX lots_account ON lots(account_id, symbol);
   CREATE TABLE lot_closes (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, order_id TEXT NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL);
   CREATE INDEX lot_closes_account ON lot_closes(account_id, ts);
   CREATE TABLE ledger (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
   CREATE INDEX ledger_account ON ledger(account_id, ts);
   CREATE TABLE valuations (account_id TEXT NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(account_id, ts));
   CREATE TABLE journal (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL);
   CREATE TABLE violations (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);
   CREATE TABLE watchlists (id TEXT PRIMARY KEY, data TEXT NOT NULL);
   CREATE TABLE gaps (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, start_ts INTEGER NOT NULL, end_ts INTEGER, reason TEXT NOT NULL);
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, label TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
   CREATE TABLE corp_actions (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
   CREATE TABLE instruments (symbol TEXT PRIMARY KEY, data TEXT NOT NULL);
   CREATE TABLE backups (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, file TEXT, ok INTEGER NOT NULL, message TEXT NOT NULL);`,
];

export type Table = 'accounts' | 'orders' | 'fills' | 'lots' | 'lot_closes' | 'ledger' | 'journal' | 'watchlists';

export interface JournalEntry {
  id: string; accountId: string; ts: number; symbol: string | null; orderId: string | null;
  strategy: string; tags: string[]; entryReason: string; exitReason: string; review: string;
}
export interface Watchlist { id: string; name: string; symbols: string[] }

export class Store {
  readonly db: Database.Database;
  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  get schemaVersion(): number {
    const has = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
    if (!has) return 0;
    const r = this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined;
    return r ? Number(r.value) : 0;
  }

  private migrate() {
    const v = this.schemaVersion;
    if (v > MIGRATIONS.length) throw new Error(`Database schema v${v} is newer than this app (v${MIGRATIONS.length}). Update the app.`);
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[i]!);
        this.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)").run(String(i + 1));
      });
    }
  }

  tx<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }

  // ---- generic JSON document helpers ----
  private rows<T>(sql: string, ...p: unknown[]): T[] { return (this.db.prepare(sql).all(...p) as { data: string }[]).map((r) => JSON.parse(r.data) as T); }
  private row<T>(sql: string, ...p: unknown[]): T | undefined { const r = this.db.prepare(sql).get(...p) as { data: string } | undefined; return r ? (JSON.parse(r.data) as T) : undefined; }

  // accounts
  accounts(): Account[] { return this.rows<Account>('SELECT data FROM accounts ORDER BY rowid'); }
  account(id: string) { return this.row<Account>('SELECT data FROM accounts WHERE id=?', id); }
  putAccount(a: Account) { this.db.prepare('INSERT OR REPLACE INTO accounts(id,data) VALUES(?,?)').run(a.id, JSON.stringify(a)); }

  // orders
  order(id: string) { return this.row<Order>('SELECT data FROM orders WHERE id=?', id); }
  orderByKey(accountId: string, key: string) { return this.row<Order>('SELECT data FROM orders WHERE account_id=? AND client_key=?', accountId, key); }
  orders(accountId: string) { return this.rows<Order>('SELECT data FROM orders WHERE account_id=? ORDER BY rowid DESC', accountId); }
  activeOrders(accountId?: string) {
    const st = "status IN ('pending_activation','waiting_condition','open','triggered')";
    return accountId ? this.rows<Order>(`SELECT data FROM orders WHERE account_id=? AND ${st} ORDER BY rowid`, accountId)
      : this.rows<Order>(`SELECT data FROM orders WHERE ${st} ORDER BY rowid`);
  }
  putOrder(o: Order) {
    this.db.prepare('INSERT INTO orders(id,account_id,status,symbol,client_key,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, data=excluded.data')
      .run(o.id, o.accountId, o.status, o.symbol, o.clientKey, JSON.stringify(o));
  }
  orderEvent(o: Pick<Order, 'id' | 'accountId'>, ts: number, type: string, message: string, data?: unknown) {
    this.db.prepare('INSERT INTO order_events(order_id,account_id,ts,type,message,data) VALUES(?,?,?,?,?,?)').run(o.id, o.accountId, ts, type, message, data === undefined ? null : JSON.stringify(data));
  }
  orderEvents(orderId: string) { return this.db.prepare('SELECT ts,type,message,data FROM order_events WHERE order_id=? ORDER BY id').all(orderId) as { ts: number; type: string; message: string; data: string | null }[]; }
  accountEvents(accountId: string, limit: number) { return this.db.prepare('SELECT order_id as orderId,ts,type,message FROM order_events WHERE account_id=? ORDER BY id DESC LIMIT ?').all(accountId, limit) as { orderId: string; ts: number; type: string; message: string }[]; }

  // fills / lots / ledger
  fill(id: string) { return this.row<Fill>('SELECT data FROM fills WHERE id=?', id); }
  putFill(f: Fill) { this.db.prepare('INSERT INTO fills(id,order_id,account_id,ts,data) VALUES(?,?,?,?,?)').run(f.id, f.orderId, f.accountId, f.ts, JSON.stringify(f)); }
  fills(accountId: string) { return this.rows<Fill>('SELECT data FROM fills WHERE account_id=? ORDER BY ts', accountId); }
  orderFills(orderId: string) { return this.rows<Fill>('SELECT data FROM fills WHERE order_id=? ORDER BY ts', orderId); }
  lots(accountId: string) { return this.rows<Lot>('SELECT data FROM lots WHERE account_id=? ORDER BY rowid', accountId); }
  putLot(l: Lot) { this.db.prepare('INSERT OR REPLACE INTO lots(id,account_id,symbol,data) VALUES(?,?,?,?)').run(l.id, l.accountId, l.symbol, JSON.stringify(l)); }
  putLotClose(c: LotClose) { this.db.prepare('INSERT INTO lot_closes(id,account_id,order_id,ts,data) VALUES(?,?,?,?,?)').run(c.id, c.accountId, c.orderId, c.closedAt, JSON.stringify(c)); }
  lotCloses(accountId: string) { return this.rows<LotClose>('SELECT data FROM lot_closes WHERE account_id=? ORDER BY ts', accountId); }
  ledger(accountId: string) { return this.rows<LedgerEntry>('SELECT data FROM ledger WHERE account_id=? ORDER BY ts, rowid', accountId); }
  putLedger(e: LedgerEntry) { this.db.prepare('INSERT INTO ledger(id,account_id,ts,kind,data) VALUES(?,?,?,?,?)').run(e.id, e.accountId, e.ts, e.kind, JSON.stringify(e)); }

  // valuations
  putValuation(accountId: string, v: Valuation) { this.db.prepare('INSERT OR REPLACE INTO valuations(account_id,ts,data) VALUES(?,?,?)').run(accountId, v.ts, JSON.stringify(v)); }
  valuations(accountId: string) { return this.rows<Valuation>('SELECT data FROM valuations WHERE account_id=? ORDER BY ts', accountId); }

  // journal / watchlists
  journal(accountId: string) { return this.rows<JournalEntry>('SELECT data FROM journal WHERE account_id=? ORDER BY ts DESC', accountId); }
  putJournal(j: JournalEntry) { this.db.prepare('INSERT OR REPLACE INTO journal(id,account_id,ts,data) VALUES(?,?,?,?)').run(j.id, j.accountId, j.ts, JSON.stringify(j)); }
  deleteJournal(id: string) { this.db.prepare('DELETE FROM journal WHERE id=?').run(id); }
  watchlists() { return this.rows<Watchlist>('SELECT data FROM watchlists ORDER BY rowid'); }
  putWatchlist(w: Watchlist) { this.db.prepare('INSERT OR REPLACE INTO watchlists(id,data) VALUES(?,?)').run(w.id, JSON.stringify(w)); }
  deleteWatchlist(id: string) { this.db.prepare('DELETE FROM watchlists WHERE id=?').run(id); }

  // violations
  addViolation(accountId: string, ts: number, kind: string, detail: string) { this.db.prepare('INSERT INTO violations(account_id,ts,kind,detail) VALUES(?,?,?,?)').run(accountId, ts, kind, detail); }
  violations(accountId: string) { return this.db.prepare('SELECT ts,kind,detail FROM violations WHERE account_id=? ORDER BY ts DESC').all(accountId) as { ts: number; kind: string; detail: string }[]; }

  // gaps
  openGap(scope: string, start: number, reason: string): number { return Number(this.db.prepare('INSERT INTO gaps(scope,start_ts,reason) VALUES(?,?,?)').run(scope, start, reason).lastInsertRowid); }
  closeGap(id: number, end: number) { this.db.prepare('UPDATE gaps SET end_ts=? WHERE id=?').run(end, id); }
  gaps(limit = 50) { return this.db.prepare('SELECT id,scope,start_ts as startTs,end_ts as endTs,reason FROM gaps ORDER BY id DESC LIMIT ?').all(limit) as { id: number; scope: string; startTs: number; endTs: number | null; reason: string }[]; }
  closeDanglingGaps(end: number) { this.db.prepare('UPDATE gaps SET end_ts=? WHERE end_ts IS NULL').run(end); }

  // settings
  setting<T>(key: string, fallback: T): T { const r = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined; return r ? (JSON.parse(r.value) as T) : fallback; }
  setSetting(key: string, v: unknown) { this.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(v)); }

  // instruments cache
  putInstruments(list: { symbol: string }[]) {
    const st = this.db.prepare('INSERT OR REPLACE INTO instruments(symbol,data) VALUES(?,?)');
    this.tx(() => { for (const i of list) st.run(i.symbol, JSON.stringify(i)); });
  }
  instrument<T>(symbol: string) { return this.row<T>('SELECT data FROM instruments WHERE symbol=?', symbol); }
  searchInstruments<T>(q: string, limit = 25): T[] {
    const up = q.toUpperCase();
    return this.rows<T>(`SELECT data FROM instruments WHERE symbol LIKE ? OR data LIKE ? ORDER BY (symbol = ?) DESC, (symbol LIKE ?) DESC, length(symbol) LIMIT ?`,
      `${up}%`, `%"name":"%${q.replace(/[%_"]/g, '')}%`, up, `${up}%`, limit);
  }
  instrumentCount() { return (this.db.prepare('SELECT count(*) n FROM instruments').get() as { n: number }).n; }

  // corporate actions
  corpAction(id: string) { return this.db.prepare('SELECT status, data FROM corp_actions WHERE id=?').get(id) as { status: string; data: string } | undefined; }
  putCorpAction(id: string, symbol: string, status: string, data: unknown) { this.db.prepare('INSERT OR REPLACE INTO corp_actions(id,symbol,status,data) VALUES(?,?,?,?)').run(id, symbol, status, JSON.stringify(data)); }
  corpActions(status?: string) { return (status ? this.db.prepare('SELECT id,symbol,status,data FROM corp_actions WHERE status=?').all(status) : this.db.prepare('SELECT id,symbol,status,data FROM corp_actions').all()) as { id: string; symbol: string; status: string; data: string }[]; }

  // backups log
  logBackup(ts: number, file: string | null, ok: boolean, message: string) { this.db.prepare('INSERT INTO backups(ts,file,ok,message) VALUES(?,?,?,?)').run(ts, file, ok ? 1 : 0, message); }
  backupLog(limit = 20) { return this.db.prepare('SELECT ts,file,ok,message FROM backups ORDER BY id DESC LIMIT ?').all(limit) as { ts: number; file: string | null; ok: number; message: string }[]; }

  // sessions (LAN pairing)
  addSession(hash: string, label: string, now: number) { this.db.prepare('INSERT INTO sessions(token_hash,label,created_at,last_seen) VALUES(?,?,?,?)').run(hash, label, now, now); }
  session(hash: string) { return this.db.prepare('SELECT label,created_at as createdAt,last_seen as lastSeen FROM sessions WHERE token_hash=?').get(hash) as { label: string } | undefined; }
  touchSession(hash: string, now: number) { this.db.prepare('UPDATE sessions SET last_seen=? WHERE token_hash=?').run(now, hash); }
  sessions() { return this.db.prepare('SELECT substr(token_hash,1,8) as id,label,created_at as createdAt,last_seen as lastSeen FROM sessions').all(); }
  revokeSession(prefix: string) { this.db.prepare('DELETE FROM sessions WHERE substr(token_hash,1,8)=?').run(prefix); }

  /** Delete every row owned by an account (used by reset and replace-import). */
  deleteAccountData(accountId: string, includeAccount: boolean) {
    for (const t of ['orders', 'order_events', 'fills', 'lots', 'lot_closes', 'ledger', 'valuations', 'journal', 'violations'])
      this.db.prepare(`DELETE FROM ${t} WHERE account_id=?`).run(accountId);
    if (includeAccount) this.db.prepare('DELETE FROM accounts WHERE id=?').run(accountId);
  }

  close() { this.db.close(); }
}
