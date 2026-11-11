import type { CalendarId, Session } from './types';

// NYSE holidays and early closes, from the NYSE Group 2026-2028 calendar announcement (checked 2026-11-10):
// https://ir.theice.com/press/news-details/2025/NYSE-Group-Announces-2026-2027-and-2028-Holiday-and-Early-Closings-Calendar/default.aspx
export const NYSE_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
  '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19', '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25',
]);
export const NYSE_EARLY_CLOSES = new Set(['2026-11-27', '2026-12-24', '2027-11-26', '2028-07-03', '2028-11-24']); // 1:00 pm ET
export const CALENDAR_FIRST = '2026-01-01';
export const CALENDAR_LAST = '2028-12-31';

// Fidelity extended-hours windows (Fidelity Viewpoints "After Hours Trading", Aug 20 2026).
export const PRE_OPEN = 7 * 60; // 7:00
export const PRE_CLOSE = 9 * 60 + 28; // 9:28
export const REG_OPEN = 9 * 60 + 30;
export const REG_CLOSE = 16 * 60;
export const EARLY_CLOSE = 13 * 60;
export const POST_CLOSE = 20 * 60;
// shortcut: after-hours end on early-close days assumed 17:00 (NYSE Arca late session); Fidelity does not publish it.
export const EARLY_POST_CLOSE = 17 * 60;

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

export interface EtParts { date: string; minutes: number; seconds: number; y: number; mo: number; d: number; h: number; mi: number }

export function etParts(ms: number): EtParts {
  const p: Record<string, string> = {};
  for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  const y = Number(p.year), mo = Number(p.month), d = Number(p.day), h = Number(p.hour), mi = Number(p.minute), s = Number(p.second);
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: h * 60 + mi, seconds: s, y, mo, d, h, mi };
}

function tzOffset(ms: number): number {
  const p = etParts(ms);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.seconds) - Math.floor(ms / 1000) * 1000;
}

/** Wall-clock time in New York (date + minutes after midnight) -> epoch ms. Handles DST. */
export function etToMs(date: string, minutes: number): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const local = Date.UTC(y, m - 1, d, 0, minutes);
  let ms = local - tzOffset(local);
  ms = local - tzOffset(ms);
  return ms;
}

export const etDate = (ms: number) => etParts(ms).date;

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export const calendarKnown = (date: string) => date >= CALENDAR_FIRST && date <= CALENDAR_LAST;

export function isTradingDay(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd !== 0 && wd !== 6 && !NYSE_HOLIDAYS.has(date);
}

export function nextTradingDay(date: string): string {
  let d = addDays(date, 1);
  for (let i = 0; i < 15 && !isTradingDay(d); i++) d = addDays(d, 1);
  return d;
}

export function addTradingDays(date: string, n: number): string {
  let d = date;
  for (let i = 0; i < n; i++) d = nextTradingDay(d);
  return d;
}

export const regularCloseMin = (date: string) => (NYSE_EARLY_CLOSES.has(date) ? EARLY_CLOSE : REG_CLOSE);
export const postCloseMin = (date: string) => (NYSE_EARLY_CLOSES.has(date) ? EARLY_POST_CLOSE : POST_CLOSE);

export function sessionAt(ms: number, cal: CalendarId): Session {
  if (cal === '24x7') return 'continuous';
  const p = etParts(ms);
  if (!isTradingDay(p.date)) return 'closed';
  const m = p.minutes;
  if (m >= PRE_OPEN && m < PRE_CLOSE) return 'pre';
  if (m >= REG_OPEN && m < regularCloseMin(p.date)) return 'regular';
  if (m >= regularCloseMin(p.date) && m < postCloseMin(p.date)) return 'post';
  return 'closed';
}

/** End (epoch ms) of the session containing ms, or null if closed / continuous. */
export function sessionEndMs(ms: number, cal: CalendarId): number | null {
  const s = sessionAt(ms, cal);
  const date = etDate(ms);
  if (s === 'pre') return etToMs(date, PRE_CLOSE);
  if (s === 'regular') return etToMs(date, regularCloseMin(date));
  if (s === 'post') return etToMs(date, postCloseMin(date));
  return null;
}

/** Close of the regular session in which a DAY order placed at ms is valid (today if before close, else the next trading day). */
export function dayOrderExpiry(ms: number): number {
  const date = etDate(ms);
  if (isTradingDay(date) && ms < etToMs(date, regularCloseMin(date))) return etToMs(date, regularCloseMin(date));
  const next = nextTradingDay(date);
  return etToMs(next, regularCloseMin(next));
}

export function nextRegularOpen(ms: number): number {
  const date = etDate(ms);
  if (isTradingDay(date) && ms < etToMs(date, REG_OPEN)) return etToMs(date, REG_OPEN);
  return etToMs(nextTradingDay(date), REG_OPEN);
}

/** Settlement date: T+N trading days for equities (NYSE trading days approximate settlement business days). */
export function settleDate(tradeMs: number, cal: CalendarId, tPlus: number): string | null {
  if (cal === '24x7' || tPlus === 0) return null;
  const d = etDate(tradeMs);
  const base = isTradingDay(d) && etParts(tradeMs).minutes < postCloseMin(d) ? d : nextTradingDay(d);
  return addTradingDays(base, tPlus);
}

export function sessionLabel(s: Session): string {
  return { pre: 'Pre-market', regular: 'Regular session', post: 'After hours', closed: 'Market closed', continuous: 'Open 24/7' }[s];
}
