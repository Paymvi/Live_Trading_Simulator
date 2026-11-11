import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './db';
import { MarketHub } from './market';
import { Engine } from './engine';
import { createApi } from './http';
import { Gate, ensureTls, lanAddresses } from './security';
import { snapshotDb } from './backup';
import { processCorporateActions } from './corp';
import { marketSession } from './views';
import { AlpacaProvider } from './providers/alpaca';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = new Set(process.argv.slice(2));
const ENV_FILE = join(ROOT, '.env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const PORT = Number(process.env.LTS_PORT ?? 5180);
const LAN_PORT = Number(process.env.LTS_LAN_PORT ?? 5181);
const DATA = resolve(ROOT, process.env.LTS_DATA_DIR ?? 'data');
const LAN = args.has('--lan');
const DEV = args.has('--dev') || process.env.LTS_DEV === '1';
const BACKUP_DIR = join(DATA, 'backups');
const log = (...a: unknown[]) => console.log(new Date().toLocaleTimeString(), '|', ...a);

mkdirSync(DATA, { recursive: true });

// ---- single instance: one engine per data folder ----
const LOCK = join(DATA, 'service.lock');
function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, port: PORT, startedAt: Date.now() }));
      closeSync(fd);
      return;
    } catch {
      let pid = 0;
      try { pid = JSON.parse(readFileSync(LOCK, 'utf8')).pid; } catch { /* unreadable lock = stale */ }
      let alive = false;
      try { if (pid) { process.kill(pid, 0); alive = true; } } catch { alive = false; }
      if (alive) { console.error(`Another simulator service (pid ${pid}) is already running on this data folder. Stop it first (stop.cmd).`); process.exit(2); }
      unlinkSync(LOCK); // stale lock from a crash
    }
  }
}
acquireLock();

const store = new Store(join(DATA, 'lts.db'));
store.closeDanglingGaps(Date.now());
const hub = new MarketHub(store);
const engine = new Engine(store, hub);
const gate = new Gate({ port: PORT, lanPort: LAN_PORT, lan: LAN, dev: DEV }, store);
const startedAt = Date.now();
let lastTick = Date.now();
const lastShutdown = store.setting<number | null>('last_heartbeat', null);
if (lastShutdown) {
  const id = store.openGap('system', lastShutdown, 'Service was stopped (or the computer was off/asleep)');
  store.closeGap(id, startedAt);
  store.tx(() => { for (const o of store.activeOrders()) store.orderEvent(o, startedAt, 'monitoring_gap', `Service was not running from ${new Date(lastShutdown).toISOString()} until ${new Date(startedAt).toISOString()}. No fills or triggers were simulated for that period; the order resumes on fresh live data.`); });
}

// ---- credentials: server-side .env only ----
function readKeys() {
  const keyId = process.env.ALPACA_KEY_ID?.trim(), secret = process.env.ALPACA_SECRET_KEY?.trim();
  return keyId && secret ? { keyId, secret } : null;
}
async function refreshInstruments() {
  if (!hub.alpaca) return;
  try {
    const list = await hub.alpaca.instruments();
    store.putInstruments(list);
    store.setSetting('instruments_loaded', Date.now());
    log(`Loaded ${list.length} instruments from Alpaca.`);
  } catch (e) { log('Instrument list failed:', (e as Error).message); }
}
async function saveKeys(k: { keyId: string; secret: string } | null): Promise<string> {
  if (k) await new AlpacaProvider(k, { event: () => {}, connection: () => {} }).verify().catch((e) => { throw new Error(`Alpaca rejected the keys: ${(e as Error).message}`); });
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).filter((l) => !/^ALPACA_(KEY_ID|SECRET_KEY)=/.test(l)) : [];
  if (k) lines.push(`ALPACA_KEY_ID=${k.keyId}`, `ALPACA_SECRET_KEY=${k.secret}`);
  writeFileSync(ENV_FILE, lines.filter((l, i) => l || i < lines.length - 1).join('\n') + '\n', { mode: 0o600 });
  if (k) { process.env.ALPACA_KEY_ID = k.keyId; process.env.ALPACA_SECRET_KEY = k.secret; } else { delete process.env.ALPACA_KEY_ID; delete process.env.ALPACA_SECRET_KEY; }
  hub.setKeys(readKeys());
  engine.refreshDemand();
  if (k) void refreshInstruments();
  return k ? 'Keys saved to the local .env file and verified with Alpaca.' : 'Keys removed.';
}
hub.setKeys(readKeys());

async function runBackup() { return snapshotDb(store, BACKUP_DIR, 'auto'); }
const lanInfo: { enabled: boolean; urls: string[]; fingerprint: string | null } = { enabled: false, urls: [], fingerprint: null };

const status = () => ({
  service: { pid: process.pid, startedAt, heartbeat: lastTick, version: '1.0.0', mode: LAN ? 'lan' : 'localhost' },
  market: marketSession(engine),
  streams: hub.statuses(),
  events: hub.stats,
  notStreamed: hub.notStreamed,
  gaps: store.gaps(10),
  backups: { last: store.backupLog(5) },
  corp: store.setting('corp_status', { ok: true, checkedAt: null, message: 'Not checked yet', blocked: [] }),
  provider: { alpacaConfigured: !!hub.alpaca, catalog: store.instrumentCount() },
  lan: lanInfo,
});

let shuttingDown = false;
const api = createApi({
  engine, gate, webDir: join(ROOT, 'dist', 'web'), backupDir: BACKUP_DIR, startedAt, lan: lanInfo,
  keys: { configured: () => { const k = readKeys(); return { configured: !!k, keyIdHint: k ? `…${k.keyId.slice(-4)}` : null }; }, save: saveKeys },
  status, shutdown: () => shutdown('stop requested'), runBackup,
});

const server = createServer((req, res) => void api.handle(req, res, false));
server.on('upgrade', (req, sock, head) => api.upgrade(req, sock, head, false));
server.on('error', (e: NodeJS.ErrnoException) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Is the simulator already running? (set LTS_PORT to change)` : e.message);
  shutdown('listen failed', 1);
});
server.listen(PORT, '127.0.0.1', () => {
  log(`Live Trading Simulator (FICTIONAL MONEY) running at http://localhost:${PORT}`);
  log(hub.alpaca ? 'Alpaca market data key found.' : 'No Alpaca key yet: demo mode works; add a free key in Settings → Providers for live data.');
  log('Keep this window open. Closing it (or sleeping the computer) stops order monitoring.');
});

let lanServer: ReturnType<typeof createHttpsServer> | null = null;
if (LAN) {
  void ensureTls(join(DATA, 'tls')).then((tls) => {
    lanServer = createHttpsServer({ key: tls.key, cert: tls.cert }, (req, res) => void api.handle(req, res, true));
    lanServer.on('upgrade', (req, sock, head) => api.upgrade(req, sock, head, true));
    lanServer.listen(LAN_PORT, '0.0.0.0', () => {
      const urls = lanAddresses().map((a) => `https://${a}:${LAN_PORT}`);
      Object.assign(lanInfo, { enabled: true, urls, fingerprint: tls.fingerprint });
      log(`Phone access (LAN, HTTPS, pairing required): ${urls.join('  ')}`);
      log(`Certificate SHA-256 fingerprint: ${tls.fingerprint}`);
      log('Generate a pairing code on this computer: Settings → Phone access.');
    });
  });
}

// ---- timers ----
const tick = setInterval(() => {
  try { engine.tick(); lastTick = Date.now(); store.setSetting('last_heartbeat', lastTick); } catch (e) { log('tick error', (e as Error).message); }
}, 1000);
const SIX_HOURS = 6 * 3600_000;
const backupTimer = setInterval(() => void runBackup().catch((e) => log('Backup failed:', e.message)), SIX_HOURS);
const corpTimer = setInterval(() => void processCorporateActions(engine).catch((e) => log('Corporate actions failed:', e.message)), SIX_HOURS);
setTimeout(() => {
  void runBackup().then((f) => log('Startup backup:', f)).catch((e) => log('Backup failed:', e.message));
  void processCorporateActions(engine).catch(() => {});
  const loaded = store.setting<number>('instruments_loaded', 0);
  if (hub.alpaca && Date.now() - loaded > 24 * 3600_000) void refreshInstruments();
}, 3000);

function shutdown(reason: string, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Stopping (${reason})…`);
  for (const t of [tick, backupTimer, corpTimer]) clearInterval(t);
  hub.stop();
  api.closeAll();
  server.close();
  lanServer?.close();
  try { store.setSetting('last_heartbeat', Date.now()); store.close(); } catch { /* already closed */ }
  try { unlinkSync(LOCK); } catch { /* ignore */ }
  setTimeout(() => process.exit(code), 200);
}
process.on('SIGINT', () => shutdown('Ctrl+C'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('window closed'));
process.on('uncaughtException', (e) => { console.error('Fatal:', e); shutdown('fatal error', 1); });
