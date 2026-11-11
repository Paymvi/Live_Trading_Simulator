import { useState } from 'react';
import { api, useApi } from '../api';
import { useApp } from '../App';
import { Badge, Card, ErrorBox, Explain, Field, time } from '../ui';

interface J { id?: string; accountId: string; ts?: number; symbol: string | null; orderId: string | null; strategy: string; tags: string[]; entryReason: string; exitReason: string; review: string }

export function Journal() {
  const { account } = useApp();
  const list = useApi<J[]>(account ? `/api/journal?accountId=${account.id}` : null);
  const [edit, setEdit] = useState<J | null>(null);
  const [tagText, setTagText] = useState('');
  const [filter, setFilter] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (!account) return null;
  const blank: J = { accountId: account.id, symbol: '', orderId: null, strategy: '', tags: [], entryReason: '', exitReason: '', review: '' };
  async function save() {
    setErr(null);
    try { await api('/api/journal', { method: 'PUT', body: { ...edit, symbol: edit!.symbol || null, tags: tagText.split(',').map((t) => t.trim()).filter(Boolean) } }); setEdit(null); list.reload(); } catch (e) { setErr((e as Error).message); }
  }
  const rows = (list.data ?? []).filter((j) => !filter || [j.symbol, j.strategy, ...j.tags].some((x) => x?.toLowerCase().includes(filter.toLowerCase())));
  return (
    <div className="page">
      <h1>Journal</h1>
      <Explain>Record why you entered and exited, which strategy you followed, and what you learned. Entries belong to this account and are included in backups.</Explain>
      <div className="row gap wrap"><button className="primary" onClick={() => { setEdit(blank); setTagText(''); }}>New entry</button>
        <label className="field inline"><span className="sr">Filter</span><input type="search" placeholder="Filter by symbol, strategy, tag" value={filter} onChange={(e) => setFilter(e.target.value)} /></label></div>
      {edit && (
        <Card title={edit.id ? 'Edit entry' : 'New entry'}>
          <div className="grid-fields">
            <Field label="Symbol"><input value={edit.symbol ?? ''} onChange={(e) => setEdit({ ...edit, symbol: e.target.value.toUpperCase() })} /></Field>
            <Field label="Strategy"><input value={edit.strategy} onChange={(e) => setEdit({ ...edit, strategy: e.target.value })} placeholder="e.g. breakout, mean reversion" /></Field>
            <Field label="Tags (comma separated)"><input value={tagText} onChange={(e) => setTagText(e.target.value)} /></Field>
          </div>
          <Field label="Entry reason"><textarea rows={3} value={edit.entryReason} onChange={(e) => setEdit({ ...edit, entryReason: e.target.value })} /></Field>
          <Field label="Exit reason"><textarea rows={3} value={edit.exitReason} onChange={(e) => setEdit({ ...edit, exitReason: e.target.value })} /></Field>
          <Field label="Review notes"><textarea rows={4} value={edit.review} onChange={(e) => setEdit({ ...edit, review: e.target.value })} /></Field>
          <ErrorBox error={err} />
          <div className="row gap"><button className="primary" onClick={save}>Save</button><button className="ghost" onClick={() => setEdit(null)}>Cancel</button></div>
        </Card>
      )}
      {rows.map((j) => (
        <Card key={j.id} title={<>{j.symbol ?? 'General'} {j.strategy && <Badge>{j.strategy}</Badge>} {j.tags.map((t) => <Badge key={t} tone="info">{t}</Badge>)}</>}
          actions={<><button className="ghost" onClick={() => { setEdit(j); setTagText(j.tags.join(', ')); }}>Edit</button><button className="ghost danger" onClick={async () => { if (confirm('Delete this entry?')) { await api(`/api/journal/${j.id}`, { method: 'DELETE' }); list.reload(); } }}>Delete</button></>}>
          <p className="muted small">{time(j.ts)}</p>
          {j.entryReason && <p><strong>Entry:</strong> {j.entryReason}</p>}
          {j.exitReason && <p><strong>Exit:</strong> {j.exitReason}</p>}
          {j.review && <p><strong>Review:</strong> {j.review}</p>}
        </Card>
      ))}
      {!rows.length && !edit && <div className="empty">No journal entries yet.</div>}
    </div>
  );
}
