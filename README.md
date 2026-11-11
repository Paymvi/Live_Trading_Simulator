# Live Trading Simulator

A personal **paper-trading** app that follows live US markets with **fictional money**, modeled on Fidelity's rules where they apply. Nothing here can place a real trade: the code only reads market data.

- Stocks & ETFs (real-time IEX quotes) and crypto via a **free** Alpaca market-data key; a clearly labeled **DEMO** mode works with no key.
- Independent cash/margin accounts (default $100,000, any amount you choose), long/short, FIFO lots, settlement, margin interest, fees.
- Market, limit, stop, stop limit, trailing stop ($/%), trailing stop limit; DAY/GTC/IOC/FOK, all-or-none, extended hours; OCO, OTO, bracket (OTOCO), contingent and multi-contingent orders; preview, modify, cancel, full history.
- Analytics, daily calendar, benchmarks, daily recap, journal, Explanation Mode, light/dark themes, desktop and phone layouts.
- Local SQLite database, rotating snapshots, JSON/CSV export and validated import. No cloud.

See [docs/COVERAGE.md](docs/COVERAGE.md) for what data is live, delayed or unavailable (with sources), and [docs/EXECUTION.md](docs/EXECUTION.md) for how fills and accounting work and where they differ from reality.

## Windows setup

1. Install **Node.js 22.12 or newer** (LTS) from https://nodejs.org/.
2. Double-click **`start.cmd`**. The first run installs dependencies and builds the app (a few minutes). A console window opens and your browser opens to **http://localhost:5180**.
3. Create an account. Choose **DEMO** to try it right away, or **Live markets** after adding a key (below).

| Action | How |
|---|---|
| Start | Double-click `start.cmd` (or `npm run build` once, then `npm start`) |
| Open the app | http://localhost:5180 |
| Stop | Close the console window, press Ctrl+C in it, or double-click `stop.cmd` |
| Phone access | `start-lan.cmd` instead of `start.cmd` (see below) |
| After updating the code | `npm run build`, then start again |

**What keeps running:** closing the *browser* is fine. The engine keeps monitoring orders while the console window is open. Closing that window, shutting down, or putting the computer to **sleep** stops monitoring. Those periods are recorded as gaps and no fills are invented for them. Nothing is installed as a system service, and no startup task or firewall rule is created.

## Free API key (live data)

1. Sign up at https://app.alpaca.markets/signup (free; no funding needed).
2. In the dashboard, select **Paper Trading** → **API Keys** → generate.
3. In the app: **Settings → Providers** → paste the Key ID and Secret → *Verify & save*. Alternatively, copy `.env.example` to `.env` and fill in `ALPACA_KEY_ID` / `ALPACA_SECRET_KEY`, then restart.

Keys live only in the git-ignored `.env` file on this computer. They are never sent to the browser, logged, or included in exports. Alpaca allows **one** live stream connection per key, so don't run another app on the same key at the same time.

## Phone access (optional, same Wi-Fi)

1. Start with **`start-lan.cmd`**. The console prints `https://<your-PC-IP>:5181` and a certificate fingerprint. If Windows asks whether Node.js may accept connections, allow **Private networks** only.
2. On the phone, open that address. The certificate is self-signed: check that the SHA-256 fingerprint matches the one in **Settings → Phone access** before accepting the warning.
3. On the computer, open **Settings → Phone access → Generate pairing code** and enter it on the phone (valid 10 minutes, single use, burns after 5 wrong tries). Revoke devices there.

The phone uses the **same accounts stored on the computer**, and only while the computer is on and the service is running. This is not cloud sync. Unpaired devices get no data. Host and origin checks and HTTPS are always enforced, and API keys and the pairing code can only be managed from the computer.

## Backups & restore

- **Automatic:** a consistent SQLite snapshot at startup and every 6 hours while the service runs (14 kept) in `data\backups\`. Also before every reset and import. Nothing runs while the service is off.
- **Manual:** Settings → Backups → *Download all accounts (JSON)*, or per account. CSV exports of trades/executions and the ledger are in Settings → Accounts. Backups contain no API keys.
- **Restore JSON:** Settings → Backups → choose file → review the preview → *import as new copies* (never overwrites) or *replace accounts with the same id*. Files are validated (format, checksum, references) before anything changes, and applied in one transaction: all or nothing.
- **Restore a database snapshot:** stop the service, copy `data\lts.db` aside, copy the chosen `data\backups\*.sqlite` to `data\lts.db`, delete `data\lts.db-wal` and `data\lts.db-shm` if present, start again.

## Development

```
npm install
npm run dev:server     # service on :5180 (tsx watch)
npm run dev:web        # Vite dev server on :5173 (proxies API calls to the service)
npm run check          # typecheck + lint + unit tests + production build
npm run e2e            # Playwright end-to-end tests in installed Microsoft Edge (DEMO data, temp data folder)
```

Layout: `src/domain` (pure, framework-free rules/accounting/execution), `src/server` (service, SQLite, providers, API), `src/web` (React UI), `tests` (deterministic unit tests), `e2e` (browser tests).

Notes: `npm test` runs Vitest through `scripts/test.mjs` to work around a Vitest drive-letter issue on Windows. The remaining `npm audit` findings are in dev-only tooling (Vitest UI server, typescript-eslint/minimatch). They are not part of the running app (`npm audit --omit=dev` is clean). The Vitest version that fixes them currently crashes npm 10.9's installer.
