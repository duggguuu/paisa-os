/**
 * Bank / card statement parsing, in the browser.
 *
 * Handles CSV/TXT exports from Axis, HDFC and most Indian banks: finds the header row under
 * the preamble, works out which columns are date / narration / debit / credit / balance,
 * reads Indian date formats, and pulls a readable merchant + UPI reference out of narrations.
 * Nothing is uploaded except the parsed rows you choose to import.
 */
import { guessCategory } from './voice';

export interface StatementRow {
  date: string;            // YYYY-MM-DD
  description: string;
  amount: number;          // paise; + money into the account, − money out
  balance: number | null;  // paise, as printed on the statement
  ref: string | null;
  merchant: string | null;
}

export interface ParsedStatement {
  rows: StatementRow[];
  closing: { balance: number; date: string } | null;
  columns: Record<string, string>;
  bank: string | null;
}

// ---------- CSV ----------
export function parseDelimited(text: string): string[][] {
  const clean = text.replace(/^﻿/, '');
  const firstLines = clean.split(/\r?\n/).slice(0, 40).join('\n');
  const delim = [',', '\t', ';', '|'].map((d) => [d, firstLines.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (q) {
      if (ch === '"' && clean[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(cell.trim()); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

// ---------- values ----------
const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function parseDate(s: string): string | null {
  const t = s.trim().toLowerCase().replace(/\s+\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?$/, '');
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})[\/\-. ](\d{1,2})[\/\-. ](\d{2,4})$/);
  if (m) return iso(year(+m[3]), +m[2], +m[1]); // Indian banks: day first
  m = t.match(/^(\d{1,2})[\/\-. ]([a-z]{3})[a-z]*[\/\-., ]+(\d{2,4})$/);
  if (m && MON.includes(m[2])) return iso(year(+m[3]), MON.indexOf(m[2]) + 1, +m[1]);
  m = t.match(/^([a-z]{3})[a-z]*[\/\-. ](\d{1,2}),?[\/\-. ](\d{2,4})$/);
  if (m && MON.includes(m[1])) return iso(year(+m[3]), MON.indexOf(m[1]) + 1, +m[2]);
  return null;
}
const year = (y: number) => (y < 100 ? 2000 + y : y);
function iso(y: number, m: number, d: number) {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** "1,23,456.78", "1234.5 Cr", "(500.00)", "-" → paise (sign from Cr/Dr/brackets/minus), or null. */
export function parseAmount(s: string): number | null {
  const t = s.trim();
  if (!t || /^[-–—]$/.test(t)) return null;
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t) || /\bdr\.?$/i.test(t);
  const num = t.replace(/[^\d.]/g, '');
  if (!num || !/\d/.test(num)) return null;
  const v = Math.round(parseFloat(num) * 100);
  if (!isFinite(v)) return null;
  return neg ? -v : v;
}

// ---------- columns ----------
const H = {
  date: /^(txn|tran|transaction|value)?\s*(posting\s*)?date$|^date$/i,
  valueDate: /value\s*dat/i,
  desc: /narration|particulars|description|remarks|details|transaction\s*details/i,
  debit: /debit|withdrawal|\bdr\b|paid\s*out|amount\s*out/i,
  credit: /credit|deposit|\bcr\b|paid\s*in|amount\s*in/i,
  amount: /^amount|amount\s*\(?(inr|rs)/i,
  type: /^(dr\s*\/\s*cr|cr\s*\/\s*dr|type|debit\s*\/\s*credit)$/i,
  balance: /balance|^bal\.?$/i,
  ref: /ref|chq|cheque|utr/i,
};

function findHeader(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const r = rows[i].map((c) => c.toLowerCase());
    const hasDate = r.some((c) => H.date.test(c) || c === 'date');
    const hasMoney = r.some((c) => H.debit.test(c) || H.credit.test(c) || H.amount.test(c));
    const hasDesc = r.some((c) => H.desc.test(c));
    if (hasDate && hasMoney && hasDesc) return i;
  }
  return -1;
}

function mapColumns(header: string[]) {
  const idx = (re: RegExp, not?: RegExp) => header.findIndex((h) => re.test(h) && !(not && not.test(h)));
  const date = idx(H.date, H.valueDate) >= 0 ? idx(H.date, H.valueDate) : idx(/date/i);
  return {
    date, desc: idx(H.desc), debit: idx(H.debit, /credit/i), credit: idx(H.credit, /debit/i),
    amount: idx(H.amount), type: idx(H.type), balance: idx(H.balance), ref: idx(H.ref, H.desc),
  };
}

// ---------- narration → merchant, reference ----------
const NOISE = /^(upi|p2m|p2a|imps|neft|rtgs|ach|nach|ecs|pos|mmt|inft|bil|onl|bbps|txn|payment|paytm|ybl|okaxis|oksbi|okhdfcbank|okicici|ibl|axl|icici|hdfc|sbi|axis|utib|hdfc0|dr|cr|ref|na|null|to|from|by|transfer|trf|ft|int|ecom|vps|mb|ib|ib\s*funds)$/i;
const STRIP = /\b(pvt|private|ltd|limited|llp|india|technologies|technology|services|solutions|retail|payments?|online|com|co|in)\b\.?/gi;

export function extractRef(narration: string, refCell?: string | null): string | null {
  const upi = narration.match(/(?<!\d)(\d{12})(?!\d)/);
  if (upi) return upi[1];
  const cell = (refCell ?? '').replace(/^0+/, '').trim();
  if (cell && /\d{5,}/.test(cell)) return cell.slice(0, 40);
  const utr = narration.match(/\b([A-Z]{4}[A-Z0-9]{8,18})\b/);
  return utr && /\d{6}/.test(utr[1]) ? utr[1] : null;
}

export function extractMerchant(narration: string): string | null {
  const n = narration.replace(/\s+/g, ' ').trim();
  if (/\b(atm|atw|nwd|cash wdl|cash withdrawal)\b/i.test(n)) return 'ATM withdrawal';
  let parts: string[];
  if (/^upi\//i.test(n)) parts = n.split('/').slice(1);                // Axis: UPI/P2M/412…/SWIGGY/…
  else if (/^upi-/i.test(n)) parts = n.split('-').slice(1);            // HDFC: UPI-SWIGGY-swiggy@…
  else if (/^(neft|imps|rtgs)/i.test(n)) parts = n.split(/[-\/:]/).slice(1);
  else if (/^pos\b/i.test(n)) parts = [n.replace(/^pos\s*[\dx*]*\s*/i, '')];
  else if (/^(ach|nach|ecs)/i.test(n)) parts = n.split(/[-\/:]/).slice(1);
  else parts = n.split(/[-\/:|]/);
  const pick = parts
    .map((p) => p.trim())
    .find((p) => /[a-z]{3,}/i.test(p) && !NOISE.test(p) && !/@/.test(p) && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(p) && !/^\d+$/.test(p) && (p.match(/\d/g) ?? []).length < 6 && !/^(p2m|p2a)$/i.test(p));
  if (!pick) return null;
  const name = pick.replace(STRIP, ' ').replace(/[^a-z0-9&' ]/gi, ' ').replace(/\s+/g, ' ').trim();
  if (name.length < 2) return null;
  return name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 40);
}

// ---------- main ----------
export function parseStatement(text: string): ParsedStatement {
  const grid = parseDelimited(text);
  const h = findHeader(grid);
  if (h < 0) return { rows: [], closing: null, columns: {}, bank: null };
  const header = grid[h];
  const c = mapColumns(header);
  const bank = /\bsol\b/i.test(header.join(' ')) || /particulars/i.test(header.join(' ')) && /\bdr\b/i.test(header.join(' ')) ? 'Axis'
    : /narration/i.test(header.join(' ')) && /withdrawal amt/i.test(header.join(' ')) ? 'HDFC' : null;
  const rows: StatementRow[] = [];
  for (const r of grid.slice(h + 1)) {
    if (/^\*+$/.test((r[0] ?? '').trim())) continue; // HDFC separator lines
    const date = parseDate(r[c.date] ?? '');
    if (!date) continue;
    const description = (r[c.desc] ?? '').trim();
    let amount: number | null = null;
    if (c.debit >= 0 || c.credit >= 0) {
      const dr = c.debit >= 0 ? parseAmount(r[c.debit] ?? '') : null;
      const cr = c.credit >= 0 ? parseAmount(r[c.credit] ?? '') : null;
      amount = (cr ? Math.abs(cr) : 0) - (dr ? Math.abs(dr) : 0);
    } else if (c.amount >= 0) {
      const v = parseAmount(r[c.amount] ?? '');
      const t = c.type >= 0 ? (r[c.type] ?? '').toLowerCase() : '';
      amount = v === null ? null : /dr|debit|d$/.test(t) ? -Math.abs(v) : /cr|credit|c$/.test(t) ? Math.abs(v) : v;
    }
    if (!amount) continue;
    const balance = c.balance >= 0 ? parseAmount(r[c.balance] ?? '') : null;
    rows.push({ date, description, amount, balance, ref: extractRef(description, c.ref >= 0 ? r[c.ref] : null), merchant: extractMerchant(description) });
  }
  // Closing balance: the balance on the last row of the latest date (statements may be newest-first).
  const withBal = rows.filter((r) => r.balance !== null);
  let closing: ParsedStatement['closing'] = null;
  if (withBal.length) {
    const ascending = withBal[0].date <= withBal[withBal.length - 1].date;
    const last = ascending ? withBal[withBal.length - 1] : withBal[0];
    closing = { balance: last.balance!, date: last.date };
  }
  const columns: Record<string, string> = {};
  for (const [k, i] of Object.entries(c)) if (i >= 0) columns[k] = header[i];
  return { rows, closing, columns, bank };
}

// ---------- booking guesses ----------
interface Acc { id: string; name: string; kind: string; is_archived?: boolean }
interface Cat { id: string; name: string; class: string; parent_id: string | null }
export interface Guess { kind: 'expense' | 'income' | 'transfer'; categoryId: string | null; otherAccountId: string | null }

export function guessBooking(row: StatementRow, ctx: { accounts: Acc[]; categories: Cat[]; accountId: string; historyCategoryId?: string | null }): Guess {
  const t = `${row.description} ${row.merchant ?? ''}`.toLowerCase();
  const own = ctx.accounts.filter((a) => !a.is_archived && a.id !== ctx.accountId);
  const byKind = (k: string) => own.find((a) => a.kind === k)?.id ?? null;
  const cat = (cls: 'expense' | 'income', name: string) => ctx.categories.find((c) => c.class === cls && c.name.toLowerCase() === name.toLowerCase())?.id ?? null;
  const out = row.amount < 0;
  const thisAcc = ctx.accounts.find((a) => a.id === ctx.accountId);

  if (out && /\b(atm|atw|nwd|cash wdl|cash withdrawal)\b/.test(t) && byKind('cash')) return { kind: 'transfer', categoryId: null, otherAccountId: byKind('cash') };
  if (thisAcc?.kind !== 'credit_card' && out && /(credit card|cc ?pay|card ?payment|cred club|cred\b|billdesk.*card|autopay.*card|card bill)/.test(t) && byKind('credit_card'))
    return { kind: 'transfer', categoryId: null, otherAccountId: byKind('credit_card') };
  if (thisAcc?.kind === 'credit_card' && !out && /(payment|thank you|received|neft|imps|upi|autopay)/.test(t) && !/(refund|reversal|cashback)/.test(t))
    return { kind: 'transfer', categoryId: null, otherAccountId: byKind('bank') };
  if (out && /(zerodha|groww|kuvera|indmoney|coin\b|bse ltd|nse clearing|iccl|mutual fund|\bmf\b|\bsip\b|nach.*(bse|cams|kfin))/.test(t) && byKind('investment'))
    return { kind: 'transfer', categoryId: null, otherAccountId: byKind('investment') };
  if (!out && /(salary|\bsal\b|payroll)/.test(t)) return { kind: 'income', categoryId: cat('income', 'Salary'), otherAccountId: null };
  if (!out && /(int\.?\s?pd|interest|int\.? cr|sbint|int cred)/.test(t)) return { kind: 'income', categoryId: cat('income', 'Interest'), otherAccountId: null };
  if (!out && /(refund|reversal|rev\b|cashback)/.test(t)) return { kind: 'income', categoryId: cat('income', 'Refunds & cashback'), otherAccountId: null };
  if (!out && /dividend|\bdiv\b/.test(t)) return { kind: 'income', categoryId: cat('income', 'Dividends'), otherAccountId: null };
  if (out) {
    const id = ctx.historyCategoryId ?? guessCategory(t, ctx.categories, 'expense') ?? (/(charges|chrg|fee|gst on|sms alert|annual fee)/.test(t) ? cat('expense', 'Bank charges') : null) ?? cat('expense', 'Other');
    return { kind: 'expense', categoryId: id, otherAccountId: null };
  }
  return { kind: 'income', categoryId: ctx.historyCategoryId ?? cat('income', 'Other income'), otherAccountId: null };
}
