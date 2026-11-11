import { useState } from 'react';
import { api } from '../api';
import { Card, ErrorBox } from '../ui';

export function Pair() {
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('Phone');
  const [err, setErr] = useState<string | null>(null);
  async function pair() {
    setErr(null);
    try { await api('/api/pair', { method: 'POST', body: { code, label } }); location.reload(); } catch (e) { setErr((e as Error).message); }
  }
  return (
    <div className="page narrow">
      <h1>Pair this device</h1>
      <Card>
        <p>This device is reaching the simulator running on your computer. On the computer, open <strong>Settings → Phone access</strong>, press <em>Generate pairing code</em>, and type the code here.</p>
        <p className="muted small">The phone uses the same accounts held on the computer, only while the computer and its service are running. This is not cloud sync. Trading is simulated.</p>
        <label className="field"><span className="field-l">Pairing code</span><input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoComplete="one-time-code" autoCapitalize="characters" /></label>
        <label className="field"><span className="field-l">Device name</span><input value={label} onChange={(e) => setLabel(e.target.value)} /></label>
        <ErrorBox error={err} />
        <button className="primary" onClick={pair}>Pair</button>
      </Card>
    </div>
  );
}
