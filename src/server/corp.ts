import { D, ZERO, cents } from '../domain/money';
import { addDays, etDate, etToMs } from '../domain/calendar';
import { newId } from '../domain/orders';
import type { Engine } from './engine';
import type { CorpAction } from './providers/types';

export interface CorpStatus { ok: boolean; checkedAt: number | null; message: string; blocked: string[] }

/**
 * Applies verified corporate actions from Alpaca to live accounts:
 * splits adjust lots (quantity x ratio, price / ratio) and cancel open orders on the symbol;
 * cash dividends credit long holders (debit shorts, "payment in lieu") on the payable date.
 * If actions cannot be fetched, held symbols are reported as unverified; symbols with an action that
 * cannot be applied reliably are blocked from new orders.
 */
export async function processCorporateActions(engine: Engine): Promise<CorpStatus> {
  const store = engine.store;
  const now = engine.now();
  const today = etDate(now);
  const prev = store.setting<CorpStatus>('corp_status', { ok: true, checkedAt: null, message: 'Not checked yet', blocked: [] });
  const alpaca = engine.hub.alpaca;
  const accounts = store.accounts().filter((a) => a.mode === 'live' && !a.archived);
  const held = new Map<string, number>(); // symbol -> earliest lot open
  for (const a of accounts) for (const l of store.lots(a.id)) if (l.assetClass === 'equity') held.set(l.symbol, Math.min(held.get(l.symbol) ?? Infinity, l.openedAt));
  if (!held.size) { const s = { ...prev, ok: true, checkedAt: now, message: 'No live equity positions to check' }; store.setSetting('corp_status', s); return s; }
  if (!alpaca) { const s = { ...prev, ok: false, checkedAt: now, message: 'No data provider: dividends/splits for held stocks cannot be verified' }; store.setSetting('corp_status', s); return s; }
  let actions: CorpAction[];
  try {
    const start = etDate(Math.min(...held.values()));
    actions = await alpaca.corporateActions([...held.keys()], addDays(start, -1), addDays(today, 1));
  } catch (e) {
    const s = { ...prev, ok: false, checkedAt: now, message: `Corporate actions check failed: ${(e as Error).message}. Positions are not adjusted for any splits/dividends until it succeeds.` };
    store.setSetting('corp_status', s);
    return s;
  }
  const blocked = new Set(prev.blocked);
  let applied = 0;
  for (const ca of actions) {
    if (ca.exDate > today) continue;
    for (const a of accounts) {
      const key = `${ca.id}:${a.id}`;
      const rec = store.corpAction(key);
      if (rec?.status === 'applied' || rec?.status === 'not_applicable') continue;
      const lots = store.lots(a.id).filter((l) => l.symbol === ca.symbol);
      const exStart = etToMs(ca.exDate, 0);
      if (ca.type === 'cash_dividend') {
        // shares held going into the ex-date: lots opened before it, plus quantity closed on/after it
        const closes = store.lotCloses(a.id).filter((c) => c.symbol === ca.symbol && c.closedAt >= exStart);
        let longQ = ZERO, shortQ = ZERO;
        for (const l of lots.filter((x) => x.openedAt < exStart)) {
          const q = D(l.openQty).plus(closes.filter((c) => c.lotId === l.id).reduce((s, c) => s.plus(c.qty), ZERO));
          if (l.direction === 'long') longQ = longQ.plus(q); else shortQ = shortQ.plus(q);
        }
        const net = longQ.minus(shortQ);
        if (net.eq(0)) { store.putCorpAction(key, ca.symbol, 'not_applicable', ca); continue; }
        if (!ca.rate || !/^\d+(\.\d+)?$/.test(ca.rate)) { blocked.add(ca.symbol); store.putCorpAction(key, ca.symbol, 'blocked', ca); continue; }
        if (ca.payableDate && ca.payableDate > today) { store.putCorpAction(key, ca.symbol, 'pending', ca); continue; }
        const amount = cents(net.times(ca.rate));
        store.tx(() => {
          store.putLedger({ id: newId('led'), accountId: a.id, ts: now, kind: 'DIVIDEND', amount: amount.toFixed(2), settleDate: null, symbol: ca.symbol, orderId: null, fillId: null,
            memo: `${net.gt(0) ? 'Cash dividend' : 'Payment in lieu of dividend (short)'} $${ca.rate}/sh × ${net.abs().toFixed()} (ex ${ca.exDate}, pay ${ca.payableDate ?? 'n/a'}; source Alpaca)` });
          store.putCorpAction(key, ca.symbol, 'applied', ca);
        });
        applied++;
      } else {
        const before = lots.filter((l) => l.openedAt < exStart && D(l.openQty).gt(0));
        if (!before.length) { store.putCorpAction(key, ca.symbol, 'not_applicable', ca); continue; }
        if (!ca.oldRate || !ca.newRate || D(ca.oldRate).lte(0) || D(ca.newRate).lte(0)) { blocked.add(ca.symbol); store.putCorpAction(key, ca.symbol, 'blocked', ca); continue; }
        const ratio = D(ca.newRate).div(ca.oldRate);
        store.tx(() => {
          for (const l of before) {
            l.openQty = D(l.openQty).times(ratio).toDecimalPlaces(6).toFixed();
            l.origQty = D(l.origQty).times(ratio).toDecimalPlaces(6).toFixed();
            l.price = D(l.price).div(ratio).toDecimalPlaces(8).toFixed();
            store.putLot(l);
          }
          store.putLedger({ id: newId('led'), accountId: a.id, ts: now, kind: 'ADJUSTMENT', amount: '0', settleDate: null, symbol: ca.symbol, orderId: null, fillId: null,
            memo: `${ca.type === 'forward_split' ? 'Forward' : 'Reverse'} split ${ca.newRate}:${ca.oldRate} effective ${ca.exDate}; lot quantities and cost per share adjusted (source Alpaca). Fractional remainders are kept, not cashed out (approximation).` });
          store.putCorpAction(key, ca.symbol, 'applied', ca);
        });
        for (const o of store.activeOrders(a.id).filter((x) => x.symbol === ca.symbol)) engine.cancel(o.id, `Canceled because of the ${ca.type.replace('_', ' ')} on ${ca.exDate}; re-enter at split-adjusted prices`);
        applied++;
      }
    }
  }
  const s: CorpStatus = { ok: true, checkedAt: now, message: `Checked ${held.size} held symbol(s); ${applied} action(s) applied`, blocked: [...blocked] };
  store.setSetting('corp_status', s);
  for (const a of accounts) engine.onChange(a.id);
  return s;
}
