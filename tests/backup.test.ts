import { describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyImport, exportCsv, exportJson, snapshotDb, validateImport } from '../src/server/backup';
import { Store } from '../src/server/db';
import { setup } from './helpers';

function populated() {
  const t = setup();
  const a = t.account('margin', '50000');
  t.quote('XYZ', '100', '100.02');
  t.place(t.ticket(a.id, 'XYZ', [{ qty: '10' }]));
  t.quote('XYZ', '100', '100.02');
  t.place(t.ticket(a.id, 'XYZ', [{ side: 'sell', qty: '4' }]));
  t.quote('XYZ', '101', '101.02');
  t.place(t.ticket(a.id, 'XYZ', [{ side: 'sell', qty: '6', type: 'limit', limitPrice: '150', tif: 'gtc' }]));
  t.store.putJournal({ id: 'j1', accountId: a.id, ts: 1, symbol: 'XYZ', orderId: null, strategy: 'test', tags: ['a'], entryReason: 'r', exitReason: '', review: '' });
  return { t, a };
}

describe('backup export / import', () => {
  it('round-trips an account as a copy with new ids and identical balances', () => {
    const { t, a } = populated();
    const file = JSON.parse(JSON.stringify(exportJson(t.store, [a.id])));
    const v = validateImport(t.store, file);
    expect(v.preview.ok).toBe(true);
    expect(v.preview.accounts[0]!.exists).toBe(true);
    const [newId] = applyImport(t.store, v.file!, 'copy', null);
    expect(newId).not.toBe(a.id);
    expect(t.engine.state(newId!).balances.cash.toFixed(2)).toBe(t.engine.state(a.id).balances.cash.toFixed(2));
    expect(t.store.orders(newId!)).toHaveLength(3);
    expect(t.store.lotCloses(newId!)).toHaveLength(1);
    expect(t.store.journal(newId!)).toHaveLength(1);
  });

  it('replace restores the exact account state into a fresh database', () => {
    const { t, a } = populated();
    const file = JSON.parse(JSON.stringify(exportJson(t.store, null)));
    const fresh = new Store(':memory:');
    const v = validateImport(fresh, file);
    applyImport(fresh, v.file!, 'replace', null);
    expect(fresh.account(a.id)!.name).toBe(a.name);
    expect(fresh.ledger(a.id)).toEqual(t.store.ledger(a.id));
    expect(fresh.lots(a.id)).toEqual(t.store.lots(a.id));
  });

  it('rejects corrupt, tampered or incompatible files without changing anything', () => {
    const { t, a } = populated();
    const file = JSON.parse(JSON.stringify(exportJson(t.store, [a.id])));
    expect(validateImport(t.store, { hello: 1 }).preview.errors[0]).toContain('Not a Live Trading Simulator backup');
    expect(validateImport(t.store, { ...file, formatVersion: 99 }).preview.errors[0]).toContain('Unsupported');
    const tampered = JSON.parse(JSON.stringify(file));
    tampered.accounts[0].ledger[0].amount = '999999999';
    expect(validateImport(t.store, tampered).preview.errors.join()).toContain('Checksum');
    const bad = JSON.parse(JSON.stringify(file));
    bad.accounts[0].ledger[0].amount = 'NaN';
    expect(validateImport(t.store, bad).preview.ok).toBe(false);
  });

  it('import is all-or-nothing: a failure mid-apply rolls back', () => {
    const { t, a } = populated();
    const file = JSON.parse(JSON.stringify(exportJson(t.store, [a.id])));
    const v = validateImport(t.store, file);
    const before = t.store.accounts().length;
    const original = t.store.putFill.bind(t.store);
    t.store.putFill = () => { throw new Error('disk full (simulated)'); };
    expect(() => applyImport(t.store, v.file!, 'replace', null)).toThrow('disk full');
    t.store.putFill = original;
    expect(t.store.accounts()).toHaveLength(before);
    expect(t.store.orders(a.id)).toHaveLength(3); // replace's delete was rolled back too
  });

  it('CSV export neutralises spreadsheet formulas', () => {
    const { t, a } = populated();
    t.engine.cashFlow(a.id, 'DEPOSIT', '10', '=HYPERLINK("x")');
    const csv = exportCsv(t.store, a.id, 'ledger');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(exportCsv(t.store, a.id, 'fills').split('\r\n')[0]).toContain('fill_id');
    expect(csv).toMatch(/,BUY,-1000\.20,/); // negative amounts stay numeric
  });

  it('takes a consistent SQLite snapshot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lts-'));
    const store = new Store(join(dir, 'db.sqlite'));
    const file = await snapshotDb(store, join(dir, 'b'), 'auto');
    expect(existsSync(file)).toBe(true);
    const copy = new Store(file);
    expect(copy.schemaVersion).toBe(store.schemaVersion);
    copy.close(); store.close();
  });
});
