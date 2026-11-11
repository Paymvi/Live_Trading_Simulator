import { useState } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import { Card, ErrorBox, Explain, Field, Help } from '../ui';
import type { Account } from '../types';

export function CreateAccount({ first, onDone }: { first?: boolean; onDone?: () => void }) {
  const { reloadAccounts, setAccountId, go } = useApp();
  const [name, setName] = useState(first ? 'My practice account' : '');
  const [type, setType] = useState<'cash' | 'margin'>('cash');
  const [mode, setMode] = useState<'live' | 'demo'>('live');
  const [cash, setCash] = useState('100000');
  const [err, setErr] = useState<string | null>(null);
  async function create() {
    setErr(null);
    try {
      const a = await api<Account>('/api/accounts', { method: 'POST', body: { name, type, mode, initialCash: cash.replace(/[$,\s]/g, '') } });
      setAccountId(a.id); reloadAccounts(); onDone?.(); go('/overview');
    } catch (e) { setErr((e as Error).message); }
  }
  return (
    <div className={first ? 'page narrow' : ''}>
      {first && <h1>Create your first simulated account</h1>}
      <Card>
        <Explain>Accounts are independent: each has its own fictional cash, positions, orders, journal and performance history.</Explain>
        <div className="grid-fields">
          <Field label="Account name"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></Field>
          <Field label="Starting balance (fictional USD)" help="external_flows"><input inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} /></Field>
          <Field label="Account type" help={type === 'cash' ? 'cash_account' : 'margin_account'}>
            <select value={type} onChange={(e) => setType(e.target.value as 'cash' | 'margin')}><option value="cash">Cash account</option><option value="margin">Margin account (borrowing, short selling)</option></select>
          </Field>
          <Field label="Market data" hint={mode === 'demo' ? 'Synthetic DEMO-* instruments only — for learning the app without an API key or open market.' : 'Real market data from your free Alpaca key (stocks/ETFs via IEX, crypto).'}>
            <select value={mode} onChange={(e) => setMode(e.target.value as 'live' | 'demo')}><option value="live">Live markets</option><option value="demo">DEMO (synthetic prices)</option></select>
          </Field>
        </div>
        <div className="row gap wrap">{['25000', '100000', '200000', '1000000'].map((v) => <button key={v} className="chip" onClick={() => setCash(v)}>${Number(v).toLocaleString()}</button>)}</div>
        <ErrorBox error={err} />
        <button className="primary" onClick={create}>Create account</button>
        {first && <p className="muted small">Everything is stored only on this computer. <Help k="simulated" /></p>}
      </Card>
    </div>
  );
}
