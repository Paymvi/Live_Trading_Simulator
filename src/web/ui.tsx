import { cloneElement, createContext, useContext, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { EXPLAIN } from './explain';
import { fmtUsd } from '../domain/money';

// ---------------------------------------------------------------- Explanation Mode
export const ExplainCtx = createContext<{ on: boolean; toggle: () => void }>({ on: true, toggle: () => {} });

export function Help({ k, label }: { k: string; label?: string }) {
  const { on } = useContext(ExplainCtx);
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);
  const e = EXPLAIN[k];
  if (!on || !e) return null;
  return (
    <span className="help" ref={ref}>
      <button type="button" className="help-btn" aria-label={`Explain ${label ?? e.t}`} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>?</button>
      {open && (
        <span className="help-pop" id={id} role="dialog" aria-label={e.t}>
          <strong>{e.t}</strong>
          <span>{e.s}</span>
          {e.x && (more ? <span className="help-ex">{e.x}</span> : <button type="button" className="link" onClick={() => setMore(true)}>Example</button>)}
        </span>
      )}
    </span>
  );
}

/** Inline explanation sentence shown only in Explanation Mode. */
export function Explain({ children }: { children: ReactNode }) {
  const { on } = useContext(ExplainCtx);
  return on ? <p className="explain">{children}</p> : null;
}

// ---------------------------------------------------------------- formatting
export const usd = (v: string | number | null | undefined, dp = 2) => (v === null || v === undefined || v === '' ? '—' : fmtUsd(String(v), dp));
export const pct = (v: number | null | undefined, dp = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(dp)}%`);
export const qty = (v: string | null | undefined) => (v == null ? '—' : String(Number(v)) === v ? Number(v).toLocaleString() : v);
export const time = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
export const ago = (ms: number | null | undefined) => {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
export const dur = (ms: number | null | undefined) => {
  if (ms == null) return '—';
  const m = ms / 60000;
  return m < 60 ? `${m.toFixed(0)} min` : m < 1440 ? `${(m / 60).toFixed(1)} h` : `${(m / 1440).toFixed(1)} d`;
};

export function Pnl({ v, children }: { v: string | number | null | undefined; children?: ReactNode }) {
  const n = v == null ? 0 : Number(v);
  const cls = n > 0 ? 'pos' : n < 0 ? 'neg' : '';
  return <span className={cls}>{n > 0 ? '▲ ' : n < 0 ? '▼ ' : ''}{children ?? usd(v)}</span>;
}

export function Badge({ tone = 'neutral', children, title }: { tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'demo'; children: ReactNode; title?: string }) {
  return <span className={`badge ${tone}`} title={title}>{children}</span>;
}

export function Stat({ label, value, help, sub }: { label: string; value: ReactNode; help?: string; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}{help && <Help k={help} />}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || actions) && <header className="card-h"><h2>{title}</h2><div className="card-actions">{actions}</div></header>}
      {children}
    </section>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input,button,select,textarea')?.focus();
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('keydown', k); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header className="card-h"><h2>{title}</h2><button className="icon" aria-label="Close" onClick={onClose}>✕</button></header>
        {children}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: [T, string][]; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {items.map(([k, l]) => <button key={k} role="tab" aria-selected={value === k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>{l}</button>)}
    </div>
  );
}

export interface Col<T> { key: string; label: ReactNode; render: (r: T) => ReactNode; sort?: (r: T) => number | string; className?: string }
export function Table<T>({ rows, cols, rowKey, empty, onRow, initialSort }: { rows: T[]; cols: Col<T>[]; rowKey: (r: T) => string; empty?: ReactNode; onRow?: (r: T) => void; initialSort?: [string, 1 | -1] }) {
  const [sort, setSort] = useState<[string, 1 | -1] | null>(initialSort ?? null);
  const col = sort && cols.find((c) => c.key === sort[0]);
  const sorted = col?.sort ? [...rows].sort((a, b) => { const x = col.sort!(a), y = col.sort!(b); return (x < y ? -1 : x > y ? 1 : 0) * sort![1]; }) : rows;
  if (!rows.length) return <div className="empty">{empty ?? 'Nothing here yet.'}</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{cols.map((c) => (
          <th key={c.key} className={c.className} aria-sort={sort?.[0] === c.key ? (sort[1] === 1 ? 'ascending' : 'descending') : undefined}>
            {c.sort ? <button className="th-btn" onClick={() => setSort([c.key, sort?.[0] === c.key ? (-sort[1] as 1 | -1) : -1])}>{c.label}{sort?.[0] === c.key ? (sort[1] === 1 ? ' ↑' : ' ↓') : ''}</button> : c.label}
          </th>))}</tr></thead>
        <tbody>{sorted.map((r) => (
          <tr key={rowKey(r)} className={onRow ? 'click' : ''} onClick={onRow ? () => onRow(r) : undefined} tabIndex={onRow ? 0 : undefined} onKeyDown={onRow ? (e) => e.key === 'Enter' && onRow(r) : undefined}>
            {cols.map((c) => <td key={c.key} className={c.className} data-label={typeof c.label === 'string' ? c.label : undefined}>{c.render(r)}</td>)}
          </tr>))}</tbody>
      </table>
    </div>
  );
}

export function ErrorBox({ error }: { error: string | null | undefined }) {
  return error ? <div className="alert bad" role="alert">{error}</div> : null;
}

/** Label bound to its control by id; the help button stays outside the <label> so it never captures the label. */
export function Field({ label, help, children, hint }: { label: string; help?: string; children: ReactElement<{ id?: string; 'aria-describedby'?: string }>; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <span className="field-l"><label htmlFor={id}>{label}</label>{help && <Help k={help} label={label} />}</span>
      {cloneElement(children, { id, ...(hint ? { 'aria-describedby': `${id}-h` } : {}) })}
      {hint && <span className="field-hint" id={`${id}-h`}>{hint}</span>}
    </div>
  );
}
