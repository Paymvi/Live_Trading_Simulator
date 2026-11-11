import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PORT = 5198;
export const BASE = `http://127.0.0.1:${PORT}`;
export const DATA = mkdtempSync(join(tmpdir(), 'lts-e2e-'));
let proc: ChildProcess | null = null;

export async function startServer() {
  proc = spawn(process.execPath, ['dist/server/main.js'], { env: { ...process.env, LTS_PORT: String(PORT), LTS_DATA_DIR: DATA, ALPACA_KEY_ID: '', ALPACA_SECRET_KEY: '' }, stdio: 'pipe' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/status`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}

export async function stopServer() {
  if (!proc) return;
  const p = proc;
  await fetch(`${BASE}/api/shutdown`, { method: 'POST', headers: { 'x-lts-client': '1', 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
  await new Promise((r) => p.once('exit', r));
  proc = null;
}

export const H = { 'x-lts-client': '1', 'content-type': 'application/json' };
export const api = async <T = unknown>(path: string, body?: unknown): Promise<T> => {
  const r = await fetch(BASE + path, { method: body === undefined ? 'GET' : 'POST', headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  return (await r.json()) as T;
};
