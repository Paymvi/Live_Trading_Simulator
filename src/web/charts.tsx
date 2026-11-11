import { useEffect, useRef } from 'react';
import { createChart, ColorType, type IChartApi, type UTCTimestamp } from 'lightweight-charts';

const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
// lightweight-charts renders UTC; shift so the axis shows the viewer's local time.
const local = (ms: number) => ((ms - new Date(ms).getTimezoneOffset() * 60_000) / 1000) as UTCTimestamp;

function useChart(height: number, theme: string, build: (c: IChartApi) => void, deps: unknown[]) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      height, width: el.current.clientWidth,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: css('--muted'), fontFamily: 'inherit' },
      grid: { vertLines: { color: css('--grid') }, horzLines: { color: css('--grid') } },
      rightPriceScale: { borderColor: css('--border') }, timeScale: { borderColor: css('--border'), timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 },
    });
    build(c);
    c.timeScale().fitContent();
    const ro = new ResizeObserver(() => el.current && c.applyOptions({ width: el.current.clientWidth }));
    ro.observe(el.current);
    return () => { ro.disconnect(); c.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height, theme, ...deps]);
  return el;
}

export interface BarPoint { t: number; o: number; h: number; l: number; c: number; v: number }

export function PriceChart({ bars, kind, height = 320, theme }: { bars: BarPoint[]; kind: 'candle' | 'line'; height?: number; theme: string }) {
  const el = useChart(height, theme, (c) => {
    const up = css('--pos'), down = css('--neg');
    if (kind === 'candle') {
      c.addCandlestickSeries({ upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down })
        .setData(bars.map((b) => ({ time: local(b.t), open: b.o, high: b.h, low: b.l, close: b.c })));
    } else c.addLineSeries({ color: css('--accent'), lineWidth: 2 }).setData(bars.map((b) => ({ time: local(b.t), value: b.c })));
    const vol = c.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' } });
    c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    vol.setData(bars.map((b) => ({ time: local(b.t), value: b.v, color: b.c >= b.o ? css('--pos-soft') : css('--neg-soft') })));
  }, [bars, kind]);
  return <div ref={el} className="chart" role="img" aria-label={`${kind === 'candle' ? 'Candlestick' : 'Line'} price chart with volume`} />;
}

export function LineChart({ series, height = 260, theme, label }: { series: { name: string; color: string; points: { t: number; v: number }[] }[]; height?: number; theme: string; label: string }) {
  const el = useChart(height, theme, (c) => {
    for (const s of series) {
      const seen = new Set<number>();
      const pts = s.points.map((p) => ({ time: local(p.t), value: p.v })).filter((p) => !seen.has(p.time) && (seen.add(p.time), true)).sort((a, b) => a.time - b.time);
      c.addLineSeries({ color: css(s.color) || s.color, lineWidth: 2, title: s.name }).setData(pts);
    }
  }, [series]);
  return <div ref={el} className="chart" role="img" aria-label={label} />;
}
