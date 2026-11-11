// Stops a running simulator service gracefully (POST /api/shutdown on localhost), falling back to killing its PID.
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = resolve(root, process.env.LTS_DATA_DIR ?? 'data');
let lock;
try { lock = JSON.parse(readFileSync(join(data, 'service.lock'), 'utf8')); } catch { console.log('No running simulator service found.'); process.exit(0); }
const alive = () => { try { process.kill(lock.pid, 0); return true; } catch { return false; } };
try {
  await fetch(`http://127.0.0.1:${lock.port}/api/shutdown`, { method: 'POST', headers: { 'x-lts-client': '1', 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(3000) });
} catch { /* fall through */ }
for (let i = 0; i < 20 && alive(); i++) await new Promise((r) => setTimeout(r, 250));
if (alive()) { process.kill(lock.pid); console.log(`Service (pid ${lock.pid}) killed.`); } else console.log('Simulator service stopped.');
