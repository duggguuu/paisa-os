/** Money and period helpers. All money is integer paise; all dates are 'YYYY-MM-DD' strings. */

export function toPaise(rupees: number | string): number {
  const s = String(rupees).replace(/[₹,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error(`invalid amount: ${rupees}`);
  const neg = s.startsWith('-');
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const paise = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return neg ? -paise : paise;
}

export type PeriodType = 'week' | 'month' | 'year' | 'custom';
export interface Range { from: string; to: string } // [from, to) — `to` is exclusive

const DAY = 86_400_000;

export function parseDate(d: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`invalid date: ${d}`);
  const [y, m, day] = d.split('-').map(Number);
  const t = Date.UTC(y, m - 1, day);
  if (fmt(t) !== d) throw new Error(`invalid date: ${d}`);
  return t;
}

export function fmt(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

export function addDays(d: string, n: number): string {
  return fmt(parseDate(d) + n * DAY);
}

/** Today in India, regardless of server time zone. */
export function todayIST(now = new Date()): string {
  return fmt(now.getTime() + 330 * 60_000);
}

function monthRange(y: number, m0: number, startDay: number): Range {
  // A "month" runs from startDay of month m0 to startDay of the next month.
  return { from: fmt(Date.UTC(y, m0, startDay)), to: fmt(Date.UTC(y, m0 + 1, startDay)) };
}

/** The period of the given type that contains `anchor`. */
export function periodContaining(type: Exclude<PeriodType, 'custom'>, anchor: string, monthStartDay = 1): Range {
  const t = parseDate(anchor);
  const d = new Date(t);
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  if (type === 'week') {
    const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
    const from = fmt(t - dow * DAY);
    return { from, to: addDays(from, 7) };
  }
  if (type === 'month') {
    return day >= monthStartDay ? monthRange(y, m, monthStartDay) : monthRange(y, m - 1, monthStartDay);
  }
  // Financial year in India runs April–March; calendar year is more common for personal stats,
  // so "year" is the calendar year.
  return { from: fmt(Date.UTC(y, 0, 1)), to: fmt(Date.UTC(y + 1, 0, 1)) };
}

/** Shift a period by n periods (n may be negative). */
export function shiftPeriod(type: Exclude<PeriodType, 'custom'>, r: Range, n: number, monthStartDay = 1): Range {
  if (type === 'week') return { from: addDays(r.from, 7 * n), to: addDays(r.to, 7 * n) };
  const d = new Date(parseDate(r.from));
  if (type === 'month') return monthRange(d.getUTCFullYear(), d.getUTCMonth() + n, monthStartDay);
  const y = d.getUTCFullYear() + n;
  return { from: fmt(Date.UTC(y, 0, 1)), to: fmt(Date.UTC(y + 1, 0, 1)) };
}

export function daysIn(r: Range): number {
  return Math.round((parseDate(r.to) - parseDate(r.from)) / DAY);
}
