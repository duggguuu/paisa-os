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

/**
 * The app lock's per-tab key. It lives in sessionStorage, so it's gone when the tab closes or the
 * iPhone app is quit: the next open has to unlock again. The server hands out a new one on unlock.
 */
const UNLOCK = 'paisa.unlock';
export function unlockKey(): string {
  try { return sessionStorage.getItem(UNLOCK) ?? ''; } catch { return ''; }
}
export function forgetUnlockKey() {
  try { sessionStorage.removeItem(UNLOCK); } catch { /* private mode */ }
}
export const authHeaders = (): Record<string, string> => ({ 'x-book': bookMode, 'x-unlock': unlockKey() });

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    credentials: 'same-origin',
    headers: { ...authHeaders(), ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.ok && typeof data?.unlockKey === 'string') { try { sessionStorage.setItem(UNLOCK, data.unlockKey); } catch { /* private mode */ } }
  if (res.status === 423 && typeof window !== 'undefined') window.dispatchEvent(new Event('paisa:locked'));
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? res.statusText);
  return data as T;
}

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inr0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 0 });

/** ₹1,23,456.78 — paise in, Indian grouping out. Drops ".00" when `whole` is set. */
// ---------- privacy mode: hide every amount ----------
/**
 * When on, money() and compact() return a fixed mask (same length for every amount, so not even
 * the size leaks) and maskText() hides amounts inside free text (insights, copilot answers).
 * Remembered per device. Toggling dispatches 'paisa:privacy'; the app shell re-renders on it.
 */
const PRIV_KEY = 'paisa.privacy';
let privacy = (() => { try { return localStorage.getItem(PRIV_KEY) === '1'; } catch { return false; } })();
export const MASK = '₹ •••••';
export const isPrivate = () => privacy;
export function setPrivate(on: boolean) {
  privacy = on;
  try { localStorage.setItem(PRIV_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
  if (typeof document !== 'undefined') document.documentElement.toggleAttribute('data-privacy', on);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('paisa:privacy'));
}
if (typeof document !== 'undefined') document.documentElement.toggleAttribute('data-privacy', privacy);
/** Hide amounts inside text: ₹1,234.50 · ₹12.4k · Rs 500 · INR 2,000 · 1.2 lakh · 3 crore. */
export function maskText(s: string): string {
  if (!privacy || !s) return s;
  return s
    .replace(/[−-]?(?:₹|\brs\.?|\binr)\s?[\d,]+(?:\.\d+)?\s?(?:k|l|lakhs?|cr|crores?)?\b/gi, MASK)
    .replace(/\b\d[\d,.]*\s?(?:lakhs?|crores?)\b/gi, MASK);
}
/** A bare number that would give amounts away (units held, daily totals). */
export const maskNum = (s: string | number) => (privacy ? '•••••' : String(s));

export function money(paise: number, opts: { whole?: boolean; sign?: boolean } = {}): string {
  if (privacy) return MASK;
  const r = paise / 100;
  const s = opts.whole || Number.isInteger(r) ? inr0.format(Math.abs(r)) : inr.format(Math.abs(r));
  const neg = paise < 0 ? '−' : opts.sign && paise > 0 ? '+' : '';
  return neg + s;
}

/** Compact: ₹950, ₹12.4k, ₹1.2L, ₹3.4Cr */
export function compact(paise: number): string {
  if (privacy) return MASK;
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
