import { useState } from 'react';
import { useApi, useQuotes } from '../api';
import { useApp } from '../App';
import { PriceChart, type BarPoint } from '../charts';
import { Badge, Card, Explain, Help, Pnl, Tabs, qty, usd } from '../ui';
import type { InstrumentView, Side, Summary } from '../types';
import { QuoteCells } from './Markets';
import { Ticket } from './Ticket';
import { OrdersTable } from './Orders';

const RANGES = ['1D', '5D', '1M', '6M', '1Y', '5Y'] as const;

export function InstrumentPage({ symbol }: { symbol: string }) {
  const { account, theme } = useApp();
  const inst = useApi<InstrumentView>(`/api/instruments/${encodeURIComponent(symbol)}`);
  const [range, setRange] = useState<(typeof RANGES)[number]>('1M');
  const [kind, setKind] = useState<'candle' | 'line'>('candle');
  const [side, setSide] = useState<Side | undefined>();
  const bars = useApi<{ bars: BarPoint[]; source: string; note: string; timeframe: string }>(inst.data ? `/api/bars?symbol=${encodeURIComponent(symbol)}&range=${range}` : null);
  const sm = useApi<Summary>(account ? `/api/accounts/${account.id}/summary` : null, { accountId: account?.id, intervalMs: 5000 });
  const quotes = useQuotes([symbol]);
  const q = quotes[symbol];
  if (inst.error) return <div className="page"><div className="alert bad">{inst.error}. <a href="#/markets">Search again</a></div></div>;
  const i = inst.data;
  if (!i) return <div className="empty">Loading…</div>;
  const positions = sm.data?.positions.filter((p) => p.symbol === symbol) ?? [];
  const orders = sm.data?.openOrders.filter((o) => o.symbol === symbol) ?? [];
  const mismatch = account && ((i.provider === 'demo') !== (account.mode === 'demo'));
  return (
    <div className="page">
      <div className="inst-head">
        <div>
          <h1>{i.symbol} <Badge tone={i.provider === 'demo' ? 'demo' : 'neutral'}>{i.provider === 'demo' ? 'DEMO synthetic' : i.assetClass === 'crypto' ? 'Crypto · 24/7' : i.exchange}</Badge></h1>
          <div className="muted">{i.name}</div>
        </div>
        <div className="quote-big"><QuoteCells q={q} /></div>
      </div>
      <div className="row wrap gap small muted">
        {i.assetClass === 'equity' && <span>{i.marginable ? 'Marginable' : 'Not marginable'} · {i.shortable ? `Shortable${i.easyToBorrow === false ? ' (hard to borrow)' : ''}` : 'Not shortable'} · {i.fractionable ? 'Fractional OK' : 'Whole shares'}</span>}
        {!i.streamed && i.provider !== 'demo' && <Badge tone="warn">Not streaming: quotes are snapshots until you place an order or the symbol gets a stream slot</Badge>}
      </div>
      {q && q.bid && q.ask && <Explain>Spread now: {usd(Number(q.ask) - Number(q.bid), 4)} ({((Number(q.ask) - Number(q.bid)) / ((Number(q.ask) + Number(q.bid)) / 2) * 100).toFixed(3)}%). Buys execute against the ask, sells against the bid.<Help k="spread" /></Explain>}
      <div className="cols wide-left">
        <Card title="Chart" actions={<><Tabs label="Range" value={range} onChange={setRange} items={RANGES.map((r) => [r, r])} /><Tabs label="Chart type" value={kind} onChange={setKind} items={[['candle', 'Candles'], ['line', 'Line']]} /></>}>
          {bars.data?.bars.length ? <PriceChart bars={bars.data.bars} kind={kind} theme={theme} /> : <div className="empty chart-empty">{bars.error ?? bars.data?.note ?? 'Loading history…'}</div>}
          {bars.data && <p className="muted small">{bars.data.source} · {bars.data.timeframe} bars · {bars.data.note}{i.provider !== 'demo' && <Help k="delayed_bars" />}</p>}
        </Card>
        <Card title={<>Trade {i.symbol} <Badge tone="warn">simulated</Badge></>}>
          {mismatch ? <div className="alert warn">{account?.mode === 'demo' ? 'This is a DEMO account; it can only trade DEMO-* instruments.' : 'DEMO instruments can only be traded in a demo account.'}</div>
            : <>
              <div className="row gap"><button className="buy" onClick={() => setSide('buy')}>Buy</button><button className="sell" onClick={() => setSide(positions.some((p) => p.direction === 'short') ? 'buy_to_cover' : 'sell')}>Sell</button></div>
              <Ticket inst={i} quote={q} initialSide={side} onPlaced={sm.reload} />
            </>}
        </Card>
      </div>
      <Card title="Your position">
        {positions.length ? positions.map((p) => (
          <div key={p.direction} className="kvs">
            <div className="kv"><span>{p.direction === 'long' ? 'Long' : 'Short'}<Help k={p.direction} /></span><strong>{qty(p.qty)}</strong></div>
            <div className="kv"><span>Average price<Help k="cost_basis" /></span><span>{usd(p.avgPrice, 4)}</span></div>
            <div className="kv"><span>Market value (mark {p.mark.source})<Help k="mark" /></span><span>{usd(p.marketValue)}</span></div>
            <div className="kv"><span>Unrealized</span><Pnl v={p.unrealized} /></div>
            <div className="kv"><span>Lots (FIFO)<Help k="lots_fifo" /></span><span>{p.lots.map((l) => `${qty(l.qty)} @ ${usd(l.price, 4)}`).join(' · ')}</span></div>
          </div>
        )) : <div className="empty">No position in {symbol}.</div>}
      </Card>
      <Card title="Open orders for this symbol"><OrdersTable rows={orders} compact /></Card>
    </div>
  );
}
