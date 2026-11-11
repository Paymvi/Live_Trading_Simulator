import { createHash, randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Store } from './db';

export interface SecurityConfig { port: number; lanPort: number; lan: boolean; dev: boolean }

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function lanAddresses(): string[] {
  return Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address);
}

export const isLoopback = (req: IncomingMessage) => {
  const a = req.socket.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
};

function cookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/**
 * Request gate. Blocks DNS-rebinding (Host allow-list), cross-site requests (Origin must match Host,
 * and state-changing requests need a custom header, which browsers cannot send cross-origin without
 * a CORS preflight that this server never approves), and unpaired LAN clients.
 */
export class Gate {
  private pairing: { code: string; expires: number; failures: number } | null = null;
  constructor(private cfg: SecurityConfig, private store: Store) {}

  allowedHosts(lanListener: boolean): Set<string> {
    if (!lanListener) {
      const h = new Set([`localhost:${this.cfg.port}`, `127.0.0.1:${this.cfg.port}`, `[::1]:${this.cfg.port}`]);
      if (this.cfg.dev) for (const p of [5173, 4173]) { h.add(`localhost:${p}`); h.add(`127.0.0.1:${p}`); }
      return h;
    }
    return new Set(lanAddresses().map((a) => `${a}:${this.cfg.lanPort}`));
  }

  /** Returns null when allowed, else [status, message]. */
  check(req: IncomingMessage, lanListener: boolean, path: string): [number, string] | null {
    const host = (req.headers.host ?? '').toLowerCase();
    const hosts = this.allowedHosts(lanListener);
    if (!hosts.has(host)) return [421, 'Host not allowed'];
    const origin = req.headers.origin;
    if (origin) {
      const ok = [...hosts].some((h) => origin === `http://${h}` || origin === `https://${h}`);
      if (!ok) return [403, 'Cross-origin request blocked'];
    }
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET');
    if (req.method === 'OPTIONS') return [403, 'CORS preflight not allowed'];
    if (mutating && path.startsWith('/api/') && req.headers['x-lts-client'] !== '1') return [403, 'Missing client header'];
    if (lanListener && !this.paired(req) && !(path === '/api/pair' || path === '/pair' || path.startsWith('/assets/') || path === '/' || path === '/index.html' || path === '/favicon.svg' || path === '/api/whoami'))
      return [401, 'This device is not paired. Open the app on the computer, generate a pairing code in Settings → Phone access, and enter it here.'];
    return null;
  }

  paired(req: IncomingMessage): boolean {
    const t = cookie(req, 'lts_session');
    if (!t) return false;
    const h = sha256(t);
    if (!this.store.session(h)) return false;
    this.store.touchSession(h, Date.now());
    return true;
  }

  newPairingCode(): { code: string; expires: number } {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = randomBytes(10);
    const code = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
    this.pairing = { code, expires: Date.now() + 10 * 60_000, failures: 0 };
    return { code, expires: this.pairing.expires };
  }

  /** Exchange a one-time pairing code for a long random session token (stored hashed). */
  pair(code: string, label: string): string | null {
    const p = this.pairing;
    if (!p || Date.now() > p.expires) return null;
    const a = Buffer.from(code.toUpperCase().replace(/[^A-Z0-9]/g, '').padEnd(10, '#').slice(0, 10)), b = Buffer.from(p.code);
    if (!timingSafeEqual(a, b)) {
      if (++p.failures >= 5) this.pairing = null; // brute-force protection: code burns after 5 misses
      return null;
    }
    this.pairing = null;
    const token = randomBytes(32).toString('base64url');
    this.store.addSession(sha256(token), label.slice(0, 60) || 'Phone', Date.now());
    return token;
  }
}

/** Self-signed TLS certificate for LAN mode, created once in the data folder. */
export async function ensureTls(dir: string): Promise<{ key: string; cert: string; fingerprint: string }> {
  mkdirSync(dir, { recursive: true });
  const kf = join(dir, 'key.pem'), cf = join(dir, 'cert.pem');
  const ips = lanAddresses();
  let regenerate = !existsSync(kf) || !existsSync(cf);
  if (!regenerate) {
    const san = new X509Certificate(readFileSync(cf)).subjectAltName ?? '';
    regenerate = ips.some((ip) => !san.includes(ip));
  }
  if (regenerate) {
    const selfsigned = (await import('selfsigned')).default;
    const pems = selfsigned.generate([{ name: 'commonName', value: 'Live Trading Simulator (local)' }], {
      days: 825, keySize: 2048, algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, ...ips.map((ip) => ({ type: 7, ip }))] }],
    });
    writeFileSync(kf, pems.private, { mode: 0o600 });
    writeFileSync(cf, pems.cert);
  }
  const cert = readFileSync(cf, 'utf8');
  return { key: readFileSync(kf, 'utf8'), cert, fingerprint: new X509Certificate(cert).fingerprint256 };
}
