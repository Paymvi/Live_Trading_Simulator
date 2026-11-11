import { useContext, useState } from 'react';
import { api, useApi, useLive } from '../api';
import { useApp } from '../App';
import { Badge, Card, ErrorBox, Explain, ExplainCtx, Field, Help, Table, Tabs, ago, time, usd } from '../ui';
import { CreateAccount } from './CreateAccount';
import type { AccountRow } from '../types';

type Section = 'accounts' | 'providers' | 'execution' | 'appearance' | 'backups' | 'phone' | 'health' | 'rules';

export function Settings({ themePref, setThemePref }: { themePref: string; setThemePref: (v: 'system' | 'light' | 'dark') => void }) {
  const initial = (location.hash.split('/')[2] as Section) || 'accounts';
  const [sec, setSec] = useState<Section>(initial);
  return (
    <div className="page">
      <h1>Settings & data</h1>
      <Tabs label="Settings sections" value={sec} onChange={(s) => { setSec(s); history.replaceState(null, '', `#/settings/${s}`); }} items={[['accounts', 'Accounts'], ['providers', 'Providers'], ['execution', 'Execution model'], ['appearance', 'Appearance & help'], ['backups', 'Backups'], ['phone', 'Phone access'], ['health', 'Data health'], ['rules', 'Rules & sources']]} />
      {sec === 'accounts' && <Accounts />}
      {sec === 'providers' && <Providers />}
      {sec === 'execution' && <Execution />}
      {sec === 'appearance' && <Appearance themePref={themePref} setThemePref={setThemePref} />}
      {sec === 'backups' && <Backups />}
      {sec === 'phone' && <Phone />}
      {sec === 'health' && <Health />}
      {sec === 'rules' && <Rules />}
    </div>
  );
}

function Accounts() {
  const { accounts, reloadAccounts, setAccountId, account } = useApp();
  const [err, setErr] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [reset, setReset] = useState<AccountRow | null>(null);
  const [cashFor, setCashFor] = useState<AccountRow | null>(null);
  const run = async (f: () => Promise<unknown>) => { setErr(null); try { await f(); reloadAccounts(); } catch (e) { setErr((e as Error).message); } };
  return (
    <>
      <ErrorBox error={err} />
      <Card title="Accounts" actions={<button className="primary" onClick={() => setShowNew(!showNew)}>+ New account</button>}>
        {showNew && <CreateAccount onDone={() => setShowNew(false)} />}
        <Table rows={accounts} rowKey={(a) => a.id} cols={[
          { key: 'n', label: 'Name', render: (a) => <><strong>{a.name}</strong> {a.id === account?.id && <Badge tone="info">current</Badge>} {a.archived && <Badge>archived</Badge>} {a.mode === 'demo' && <Badge tone="demo">DEMO</Badge>}</> },
          { key: 't', label: 'Type', render: (a) => a.type },
          { key: 'e', label: 'Value', render: (a) => usd(a.equity), className: 'num' },
          { key: 'c', label: 'Created', render: (a) => time(a.createdAt) },
          { key: 'x', label: 'Actions', render: (a) => (
            <div className="row wrap gap">
              {!a.archived && a.id !== account?.id && <button className="ghost" onClick={() => setAccountId(a.id)}>Switch to</button>}
              <button className="ghost" onClick={() => { const n = prompt('New name', a.name); if (n) void run(() => api(`/api/accounts/${a.id}`, { method: 'PATCH', body: { name: n } })); }}>Rename</button>
              <button className="ghost" onClick={() => void run(() => api(`/api/accounts/${a.id}`, { method: 'PATCH', body: { archived: !a.archived } }))}>{a.archived ? 'Unarchive' : 'Archive'}</button>
              <a className="ghost" href={`/api/export?accountId=${a.id}`}>Export JSON</a>
              <a className="ghost" href={`/api/export/csv?accountId=${a.id}&kind=fills`}>Trades CSV</a>
              <a className="ghost" href={`/api/export/csv?accountId=${a.id}&kind=ledger`}>Ledger CSV</a>
              <button className="ghost" onClick={() => setCashFor(a)}>Deposit / withdraw</button>
              <button className="ghost danger" onClick={() => setReset(a)}>Reset…</button>
            </div>) },
        ]} />
      </Card>
      {cashFor && <CashFlow a={cashFor} onDone={() => { setCashFor(null); reloadAccounts(); }} />}
      {reset && <ResetBox a={reset} onDone={() => { setReset(null); reloadAccounts(); }} />}
    </>
  );
}

function CashFlow({ a, onDone }: { a: AccountRow; onDone: () => void }) {
  const [kind, setKind] = useState<'DEPOSIT' | 'WITHDRAWAL'>('DEPOSIT');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card title={`Fictional deposit / withdrawal — ${a.name}`}>
      <Explain>Deposits and withdrawals are recorded as external cash flows. They change the balance but never count as gains or losses, and performance metrics adjust for them.<Help k="external_flows" /></Explain>
      <div className="grid-fields">
        <Field label="Type"><select value={kind} onChange={(e) => setKind(e.target.value as 'DEPOSIT')}><option value="DEPOSIT">Deposit</option><option value="WITHDRAWAL">Withdrawal</option></select></Field>
        <Field label="Amount (USD)"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Memo"><input value={memo} onChange={(e) => setMemo(e.target.value)} /></Field>
      </div>
      <ErrorBox error={err} />
      <div className="row gap"><button className="primary" onClick={async () => { try { await api(`/api/accounts/${a.id}/cash`, { method: 'POST', body: { kind, amount: amount.replace(/[$,]/g, ''), memo } }); onDone(); } catch (e) { setErr((e as Error).message); } }}>Record</button><button className="ghost" onClick={onDone}>Cancel</button></div>
    </Card>
  );
}

function ResetBox({ a, onDone }: { a: AccountRow; onDone: () => void }) {
  const [text, setText] = useState('');
  const [cash, setCash] = useState(a.initialCash);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card title={`Reset ${a.name}?`} className="danger-card">
      <p>This deletes every order, fill, lot, ledger entry, valuation and journal entry of this account and starts over with fresh fictional capital. Other accounts are not affected.</p>
      <p><strong>Back up first:</strong> <a href={`/api/export?accountId=${a.id}`}>Download this account's backup (JSON)</a>. The service also writes a database snapshot automatically before resetting.</p>
      <div className="grid-fields">
        <Field label="New starting balance"><input inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} /></Field>
        <Field label='Type RESET to confirm'><input value={text} onChange={(e) => setText(e.target.value)} /></Field>
      </div>
      <ErrorBox error={err} />
      <div className="row gap"><button className="danger" disabled={text !== 'RESET'} onClick={async () => { try { await api(`/api/accounts/${a.id}/reset`, { method: 'POST', body: { confirm: 'RESET', initialCash: cash.replace(/[$,]/g, '') } }); onDone(); } catch (e) { setErr((e as Error).message); } }}>Reset account</button><button className="ghost" onClick={onDone}>Cancel</button></div>
    </Card>
  );
}

function Providers() {
  const p = useApi<{ alpaca: { configured: boolean; keyIdHint: string | null }; statuses: { scope: string; label: string; state: string; message: string; feed: string; delay: string; symbolLimit: number | null; subscribed: string[] }[]; catalog: number }>('/api/provider', { intervalMs: 3000 });
  const who = useApi<{ loopback: boolean }>('/api/whoami');
  const [keyId, setKeyId] = useState('');
  const [secret, setSecret] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(remove = false) {
    setErr(null); setMsg(null); setBusy(true);
    try { const r = await api<{ message: string }>('/api/provider', { method: 'PUT', body: remove ? null : { keyId, secret } }); setMsg(r.message); setKeyId(''); setSecret(''); p.reload(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <>
      <Card title="Alpaca market data (free)">
        <p>Live accounts use <strong>Alpaca's free Basic market data</strong>: real-time quotes and trades from the <strong>IEX exchange</strong> for US stocks/ETFs (30 streamed symbols) and real-time crypto quotes. Historical charts use consolidated bars at least 15 minutes old.<Help k="iex" /></p>
        <ol className="plain">
          <li>Create a free account at <a href="https://app.alpaca.markets/signup" target="_blank" rel="noreferrer">app.alpaca.markets/signup</a> (no funding needed).</li>
          <li>In the dashboard, switch to <em>Paper Trading</em> and generate API keys.</li>
          <li>Paste them below. They are saved only in the local <code>.env</code> file on this computer and never sent to the browser again. The app only reads market data; it contains no code that sends orders to Alpaca.</li>
        </ol>
        <p>Status: {p.data?.alpaca.configured ? <Badge tone="good">key configured ({p.data.alpaca.keyIdHint})</Badge> : <Badge tone="warn">no key</Badge>} · instrument catalog: {p.data?.catalog ?? 0}</p>
        {who.data?.loopback ? (
          <>
            <div className="grid-fields">
              <Field label="API Key ID"><input value={keyId} onChange={(e) => setKeyId(e.target.value)} autoComplete="off" spellCheck={false} /></Field>
              <Field label="Secret Key"><input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" /></Field>
            </div>
            <div className="row gap"><button className="primary" disabled={busy || !keyId || !secret} onClick={() => save()}>{busy ? 'Verifying…' : 'Verify & save'}</button>{p.data?.alpaca.configured && <button className="ghost danger" onClick={() => save(true)}>Remove key</button>}</div>
          </>
        ) : <div className="alert info">Keys can only be changed on the computer running the service.</div>}
        {msg && <div className="alert good">{msg}</div>}
        <ErrorBox error={err} />
      </Card>
      <Card title="Streams">
        <Table rows={p.data?.statuses ?? []} rowKey={(s) => s.scope} cols={[
          { key: 'l', label: 'Stream', render: (s) => s.label },
          { key: 's', label: 'State', render: (s) => <Badge tone={s.state === 'connected' ? 'good' : s.state === 'error' ? 'bad' : 'neutral'}>{s.state}</Badge> },
          { key: 'f', label: 'Feed / delay', render: (s) => <span className="small">{s.feed} · {s.delay}</span> },
          { key: 'n', label: 'Symbols', render: (s) => `${s.subscribed.length}${s.symbolLimit ? ` / ${s.symbolLimit}` : ''}` },
          { key: 'm', label: 'Message', render: (s) => <span className="small">{s.message}</span> },
        ]} />
      </Card>
    </>
  );
}

function Execution() {
  const r = useApi<{ model: Record<string, string | number> }>('/api/rules');
  const [m, setM] = useState<Record<string, string | number> | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const model = m ?? r.data?.model;
  if (!model) return <div className="empty">Loading…</div>;
  const num = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setM({ ...model, [k]: e.target.value === '' ? '' : Number(e.target.value) });
  return (
    <Card title="Execution assumptions">
      <Explain>These assumptions decide how simulated orders fill. Every fill records the values used, so changing them affects only future fills. Marking (valuation) is separate: positions are valued at the quote midpoint.</Explain>
      <div className="grid-fields">
        <Field label="Latency (ms)" help="latency"><input type="number" min={0} value={model.latencyMs} onChange={num('latencyMs')} /></Field>
        <Field label="Slippage (basis points)" help="slippage"><input type="number" min={0} step={0.5} value={model.slippageBps} onChange={num('slippageBps')} /></Field>
        <Field label="Displayed size multiplier" help="liquidity" hint="1 = only the displayed top-of-book size fills per quote"><input type="number" min={0.01} step={0.1} value={model.liquidityMultiplier} onChange={num('liquidityMultiplier')} /></Field>
        <Field label="Max quote age (ms)"><input type="number" min={1000} value={model.maxQuoteAgeMs} onChange={num('maxQuoteAgeMs')} /></Field>
        <Field label="Max executable spread (%)" help="spread"><input type="number" min={0.1} step={0.1} value={model.maxSpreadPct} onChange={num('maxSpreadPct')} /></Field>
        <Field label="Stops trigger on" help="stop"><select value={model.stopTriggerBasis} onChange={(e) => setM({ ...model, stopTriggerBasis: e.target.value })}><option value="either">Quote (bid/ask) or trade</option><option value="quote">Quote only</option><option value="trade">Last trade only</option></select></Field>
        <Field label="Short borrow fee (%/yr, estimate)" help="borrow_fee"><input value={model.borrowAnnualPct} onChange={(e) => setM({ ...model, borrowAnnualPct: e.target.value })} /></Field>
      </div>
      <p className="muted small">Current model version: {model.version}</p>
      <ErrorBox error={err} />{msg && <div className="alert good">{msg}</div>}
      <button className="primary" onClick={async () => { setErr(null); try { await api('/api/settings/model', { method: 'PUT', body: model }); setMsg('Saved. Applies to fills from now on.'); setM(null); r.reload(); } catch (e) { setErr((e as Error).message); } }}>Save assumptions</button>
    </Card>
  );
}

function Appearance({ themePref, setThemePref }: { themePref: string; setThemePref: (v: 'system' | 'light' | 'dark') => void }) {
  const ex = useContext(ExplainCtx);
  return (
    <Card title="Appearance & Explanation Mode">
      <Field label="Theme"><select value={themePref} onChange={(e) => setThemePref(e.target.value as 'system')}><option value="system">Match system</option><option value="light">Light</option><option value="dark">Dark</option></select></Field>
      <label className="check"><input type="checkbox" checked={ex.on} onChange={ex.toggle} /> Explanation Mode — show “?” buttons and short explanations next to terms, controls, order states and statistics</label>
      <p className="muted small">Both preferences are stored in this browser only. Help buttons work with keyboard (Tab, Enter, Escape) and touch.</p>
    </Card>
  );
}

function Backups() {
  const b = useApi<{ log: { ts: number; file: string | null; ok: number; message: string }[]; dir: string }>('/api/backups', { intervalMs: 10_000 });
  const { accounts, reloadAccounts } = useApp();
  const [file, setFile] = useState<unknown>(null);
  const [preview, setPreview] = useState<{ ok: boolean; errors: string[]; warnings: string[]; accounts: { id: string; name: string; type: string; mode: string; orders: number; fills: number; ledger: number; exists: boolean }[]; watchlists: number; exportedAt: string | null } | null>(null);
  const [mode, setMode] = useState<'copy' | 'replace'>('copy');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function pick(f: File | undefined) {
    setErr(null); setMsg(null); setPreview(null);
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      setFile(data);
      setPreview(await api('/api/import/preview', { method: 'POST', body: data }));
    } catch (e) { setErr(`Could not read the file: ${(e as Error).message}`); }
  }
  async function apply() {
    setErr(null);
    try {
      const r = await api<{ imported: string[]; backup: string }>('/api/import/apply', { method: 'POST', body: { file, mode, accounts: null } });
      setMsg(`Imported ${r.imported.length} account(s). A pre-import snapshot was saved to ${r.backup}.`); setPreview(null); setFile(null); reloadAccounts();
    } catch (e) { setErr((e as Error).message); }
  }
  return (
    <>
      <Card title="Export">
        <div className="row wrap gap"><a className="primary" href="/api/export">Download all accounts (JSON)</a>
          {accounts.map((a) => <a key={a.id} className="ghost" href={`/api/export?accountId=${a.id}`}>{a.name}</a>)}</div>
        <Explain>Backups include accounts, orders and their history, fills, lots, ledger, valuations, journal, watchlists, rule and execution-model versions. API keys are never included.</Explain>
      </Card>
      <Card title="Import / restore">
        <Field label="Backup file (.json)"><input type="file" accept="application/json,.json" onChange={(e) => pick(e.target.files?.[0])} /></Field>
        {preview && (
          <div className="legbox">
            {preview.errors.map((e) => <div key={e} className="alert bad">{e}</div>)}
            {preview.warnings.map((e) => <div key={e} className="alert warn">{e}</div>)}
            <p>Exported {preview.exportedAt} · {preview.watchlists} watchlist(s)</p>
            <Table rows={preview.accounts} rowKey={(a) => a.id} cols={[
              { key: 'n', label: 'Account', render: (a) => <>{a.name} {a.exists && <Badge tone="warn">exists here</Badge>}</> },
              { key: 't', label: 'Type', render: (a) => `${a.type} · ${a.mode}` },
              { key: 'c', label: 'Contents', render: (a) => `${a.orders} orders · ${a.fills} fills · ${a.ledger} ledger rows` },
            ]} />
            {preview.ok && <>
              <Field label="How to import">
                <select value={mode} onChange={(e) => setMode(e.target.value as 'copy')}>
                  <option value="copy">Import as new copies (never overwrites; new ids)</option>
                  <option value="replace">Replace accounts with the same id (restore)</option>
                </select>
              </Field>
              <p className="muted small">The import is validated first and applied in one transaction. A database snapshot is taken automatically before anything changes.</p>
              <button className="primary" onClick={apply}>Import</button>
            </>}
          </div>
        )}
        {msg && <div className="alert good">{msg}</div>}
        <ErrorBox error={err} />
      </Card>
      <Card title="Automatic snapshots" actions={<button className="ghost" onClick={async () => { try { await api('/api/backups/run', { method: 'POST', body: {} }); b.reload(); } catch (e) { setErr((e as Error).message); } }}>Snapshot now</button>}>
        <p>While the service runs it writes a consistent SQLite snapshot at startup and every 6 hours (14 kept) to <code>{b.data?.dir}</code>. Nothing is backed up while the computer or service is off.</p>
        <Table rows={b.data?.log ?? []} rowKey={(r) => String(r.ts) + r.message} cols={[
          { key: 't', label: 'When', render: (r) => `${time(r.ts)} (${ago(r.ts)})` },
          { key: 's', label: 'Result', render: (r) => <Badge tone={r.ok ? 'good' : 'bad'}>{r.ok ? 'ok' : 'failed'}</Badge> },
          { key: 'm', label: 'Details', render: (r) => <span className="small">{r.message}{r.file ? ` — ${r.file}` : ''}</span> },
        ]} />
        <details><summary>How to restore a database snapshot</summary>
          <ol><li>Close the launcher window (or run <code>stop.cmd</code>).</li><li>Copy <code>data\lts.db</code> somewhere safe.</li><li>Copy the chosen snapshot from <code>data\backups</code> to <code>data\lts.db</code> and delete <code>data\lts.db-wal</code> / <code>data\lts.db-shm</code> if present.</li><li>Start the launcher again.</li></ol>
        </details>
      </Card>
    </>
  );
}

function Phone() {
  const st = useLive((s) => s.status);
  const who = useApi<{ loopback: boolean }>('/api/whoami');
  const sessions = useApi<{ id: string; label: string; createdAt: number; lastSeen: number }[]>(who.data?.loopback ? '/api/sessions' : null);
  const [code, setCode] = useState<{ code: string; expires: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card title="Phone access (optional, same Wi-Fi)">
      <p>Your phone can open the simulator running on this computer over your local network. It uses <strong>the same accounts held on this computer</strong> and only works while this computer is awake and the service is running — it is not cloud sync.</p>
      <ol className="plain">
        <li>Close the normal launcher and start <code>start-lan.cmd</code> instead. Windows may ask whether Node.js may accept connections on <em>private</em> networks — allow private only.</li>
        <li>On the phone, open the HTTPS address below. The certificate is self-signed: compare its SHA-256 fingerprint with the one shown here before accepting the warning.</li>
        <li>Press <em>Generate pairing code</em> here and enter it on the phone within 10 minutes. Each code works once; 5 wrong attempts burn it.</li>
      </ol>
      {st?.lan.enabled ? <>
        <p>Addresses: {st.lan.urls.map((u) => <code key={u} className="block">{u}</code>)}</p>
        <p className="small">Certificate fingerprint: <code className="break">{st.lan.fingerprint}</code></p>
        {who.data?.loopback && <button className="primary" onClick={async () => { setErr(null); try { setCode(await api('/api/pairing-code', { method: 'POST', body: {} })); } catch (e) { setErr((e as Error).message); } }}>Generate pairing code</button>}
        {code && <div className="alert info">Pairing code: <strong className="mono big">{code.code}</strong> (expires {time(code.expires)})</div>}
      </> : <div className="alert info">LAN mode is off. The service only listens on this computer (localhost).</div>}
      <ErrorBox error={err} />
      {who.data?.loopback && <>
        <h3>Paired devices</h3>
        <Table rows={sessions.data ?? []} rowKey={(s) => s.id} empty="No paired devices." cols={[
          { key: 'l', label: 'Device', render: (s) => s.label },
          { key: 'c', label: 'Paired', render: (s) => time(s.createdAt) },
          { key: 's', label: 'Last seen', render: (s) => ago(s.lastSeen) },
          { key: 'r', label: '', render: (s) => <button className="ghost danger" onClick={async () => { await api(`/api/sessions/${s.id}`, { method: 'DELETE' }); sessions.reload(); }}>Revoke</button> },
        ]} />
      </>}
    </Card>
  );
}

function Health() {
  const st = useLive((s) => s.status);
  if (!st) return <div className="empty">Waiting for service status…</div>;
  return (
    <>
      <Card title="Service">
        <div className="kvs">
          <div className="kv"><span>Heartbeat<Help k="heartbeat" /></span><span>{ago(st.service.heartbeat)}</span></div>
          <div className="kv"><span>Started</span><span>{time(st.service.startedAt)}</span></div>
          <div className="kv"><span>Events processed / dropped (out-of-order) / duplicates</span><span>{st.events.events} / {st.events.dropped} / {st.events.duplicates}</span></div>
          <div className="kv"><span>Last market event</span><span>{st.events.lastEventSymbol ?? '—'} {ago(st.events.lastEventAt)}</span></div>
          <div className="kv"><span>Corporate actions</span><span>{st.corp.message} {st.corp.checkedAt && `(${ago(st.corp.checkedAt)})`}</span></div>
          {st.corp.blocked.length > 0 && <div className="kv"><span>Blocked symbols</span><span>{st.corp.blocked.join(', ')}</span></div>}
          {st.notStreamed.length > 0 && <div className="kv"><span>Not streamed (over 30-symbol limit)</span><span>{st.notStreamed.join(', ')}</span></div>}
        </div>
      </Card>
      <Card title={<>Monitoring gaps<Help k="gap" /></>}>
        <Explain>Gaps are periods without live data: stream disconnects, the service being stopped, or the computer sleeping. No fills or triggers are invented for these periods; trailing stops may have missed highs/lows.</Explain>
        <Table rows={st.gaps} rowKey={(g) => String(g.id)} empty="No gaps recorded." cols={[
          { key: 's', label: 'Scope', render: (g) => g.scope },
          { key: 'f', label: 'From', render: (g) => time(g.startTs) },
          { key: 't', label: 'To', render: (g) => (g.endTs ? time(g.endTs) : <Badge tone="bad">ongoing</Badge>) },
          { key: 'r', label: 'Reason', render: (g) => <span className="small">{g.reason}</span> },
        ]} />
      </Card>
    </>
  );
}

function Rules() {
  const r = useApi<{ rules: Record<string, unknown> }>('/api/rules');
  if (!r.data) return <div className="empty">Loading…</div>;
  const rules = r.data.rules as Record<string, Record<string, unknown> | string | number>;
  return (
    <Card title={`Rule set ${String(rules.version)} (checked ${String(rules.checked)})`}>
      <Explain>Brokerage rules modeled after Fidelity where applicable, from official pages checked on the date shown. Items marked “estimate” are approximations or could not be verified and are labeled in the app.</Explain>
      {Object.entries(rules).filter(([, v]) => typeof v === 'object').map(([k, v]) => (
        <details key={k}><summary>{k} {(v as { estimate?: boolean }).estimate && <Badge tone="warn">estimate</Badge>}</summary>
          <pre className="pre">{JSON.stringify(v, null, 2)}</pre>
        </details>
      ))}
      <p className="small">Full coverage matrix and limitations: <code>docs/COVERAGE.md</code> and <code>docs/EXECUTION.md</code> in the project folder.</p>
    </Card>
  );
}
