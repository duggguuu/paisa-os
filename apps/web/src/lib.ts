/** API client, money formatting and small shared helpers. */

export type BookMode = 'real' | 'demo';

function readBook(): BookMode {
  try { return localStorage.getItem('paisa.book') === 'demo' ? 'demo' : 'real'; } catch { return 'real'; }
}
let bookMode: BookMode = readBook();
export const getBook = () => bookMode;
export function setBook(b: BookMode) {
  bookMode = b;
  try { localStorage.setItem('paisa.book', b); } catch { /* storage unavailable */ }
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    credentials: 'same-origin',
    headers: { 'x-book': bookMode, ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.status === 423 && typeof window !== 'undefined') window.dispatchEvent(new Event('paisa:locked'));
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? res.statusText);
  return data as T;
}

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inr0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 0 });

/** ₹1,23,456.78 — paise in, Indian grouping out. Drops ".00" when `whole` is set. */
export function money(paise: number, opts: { whole?: boolean; sign?: boolean } = {}): string {
  const r = paise / 100;
  const s = opts.whole || Number.isInteger(r) ? inr0.format(Math.abs(r)) : inr.format(Math.abs(r));
  const neg = paise < 0 ? '−' : opts.sign && paise > 0 ? '+' : '';
  return neg + s;
}

/** Compact: ₹950, ₹12.4k, ₹1.2L, ₹3.4Cr */
export function compact(paise: number): string {
  const r = Math.abs(paise / 100);
  const neg = paise < 0 ? '−' : '';
  const f = (n: number, u: string) => `${neg}₹${n >= 100 ? Math.round(n) : n.toFixed(1).replace(/\.0$/, '')}${u}`;
  if (r >= 1e7) return f(r / 1e7, 'Cr');
  if (r >= 1e5) return f(r / 1e5, 'L');
  if (r >= 1e3) return f(r / 1e3, 'k');
  return `${neg}₹${Math.round(r)}`;
}

/** Parse a rupee string into paise without floating-point error. */
export function parseRupees(s: string): number | null {
  const t = s.replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  return Number(w) * 100 + Number((f + '00').slice(0, 2));
}

export function todayIST(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}
export function addDays(d: string, n: number): string {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day + n)).toISOString().slice(0, 10);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function dayLabel(d: string): string {
  const t = todayIST();
  if (d === t) return 'Today';
  if (d === addDays(t, -1)) return 'Yesterday';
  const [y, m, day] = d.split('-').map(Number);
  const dow = DAYS[new Date(Date.UTC(y, m - 1, day)).getUTCDay()];
  return `${dow}, ${day} ${MONTHS[m - 1]}${y !== Number(t.slice(0, 4)) ? ` ${y}` : ''}`;
}
export function shortDate(d: string): string {
  const [, m, day] = d.split('-').map(Number);
  return `${day} ${MONTHS[m - 1]}`;
}
export function periodLabel(period: string, from: string, to: string): string {
  const [y, m] = from.split('-').map(Number);
  if (period === 'month') return `${['January','February','March','April','May','June','July','August','September','October','November','December'][m - 1]} ${y}`;
  if (period === 'year') return String(y);
  return `${shortDate(from)} – ${shortDate(addDays(to, -1))}`;
}

export function pct(x: number | null | undefined, digits = 0): string {
  if (x === null || x === undefined || !isFinite(x)) return '—';
  return `${(x * 100).toFixed(digits)}%`;
}

export const KIND_LABEL: Record<string, string> = {
  bank: 'Bank account', cash: 'Cash', wallet: 'Wallet', fd: 'Fixed deposit', investment: 'Investments',
  receivable: 'Person (owes you)', credit_card: 'Credit card', loan: 'Loan', payable: 'You owe a person',
};
export const KIND_ICON: Record<string, string> = {
  bank: '🏦', cash: '💵', wallet: '👛', fd: '🔒', investment: '📈', receivable: '🧑', credit_card: '💳', loan: '🏠', payable: '🤝',
};

export function uuid(): string {
  return crypto.randomUUID();
}
