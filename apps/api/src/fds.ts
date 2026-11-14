/**
 * Fixed deposits, grouped by bank.
 *
 * An FD is an asset account of kind 'fd'. Its ledger balance is the principal; meta holds the bank,
 * rate, start and maturity dates and how interest compounds. The value today and at maturity are
 * computed (Indian banks compound quarterly by default). Marking an FD matured moves the money to a
 * bank account in one transaction: principal back from the FD, and the interest as income.
 */
import { z } from 'zod';
import type { Sql } from './db.js';
import { accountBalances, createRawTxn, createTxn, LedgerError, audit } from './ledger.js';
import { setOpeningBalance } from './books.js';
import { addDays, todayIST } from './money.js';

const DAY = 86_400_000;
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const PER_YEAR = { monthly: 12, quarterly: 4, yearly: 1, simple: 0 } as const;
type Comp = keyof typeof PER_YEAR;

/** Value of `principal` after `d` days at `rate`% a year. */
export function fdValue(principal: number, rate: number, d: number, comp: Comp = 'quarterly') {
  const t = Math.max(0, d) / 365;
  const k = PER_YEAR[comp];
  if (k === 0) return Math.round(principal * (1 + (rate / 100) * t));
  return Math.round(principal * Math.pow(1 + rate / 100 / k, k * t));
}

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const FdInput = z.object({
  bank: z.string().trim().min(1).max(60),
  name: z.string().trim().max(60).optional().nullable(),
  principal: z.number().int().positive().max(1e13),
  rate: z.number().min(0).max(30),
  start: ymd,
  maturity: ymd,
  compounding: z.enum(['quarterly', 'monthly', 'yearly', 'simple']).default('quarterly'),
  /** Pay for it from this account now (a transfer). Without it, it's added as money you already had. */
  fromAccountId: z.string().uuid().optional().nullable(),
  note: z.string().trim().max(200).optional().nullable(),
});

export async function createFd(sql: Sql, bookId: string, input: z.infer<typeof FdInput>) {
  if (input.maturity <= input.start) throw new LedgerError('bad_dates', 'Maturity must be after the start date', 400);
  const existing = await sql<{ name: string }[]>`select name from account where book_id = ${bookId} and kind = 'fd'`;
  let name = (input.name || `${input.bank} FD`).slice(0, 56);
  for (let i = 2; existing.some((e) => e.name.toLowerCase() === name.toLowerCase()); i++) name = `${(input.name || `${input.bank} FD`).slice(0, 52)} ${i}`;
  const meta = { bank: input.bank, rate: input.rate, start: input.start, maturity: input.maturity, compounding: input.compounding, principal: input.principal, note: input.note ?? null };
  const id = await sql.begin(async (tx) => {
    const [acc] = await tx<{ id: string }[]>`
      insert into account (book_id, class, kind, name, institution, icon, meta)
      values (${bookId}, 'asset', 'fd', ${name}, ${input.bank}, '🔒', ${tx.json(meta)}) returning id`;
    if (!input.fromAccountId) await setOpeningBalance(tx, bookId, acc.id, input.principal, addDays(input.start, -1));
    await audit(tx, bookId, 'account', acc.id, 'create_fd', null, input, 'user');
    return acc.id;
  });
  if (input.fromAccountId) {
    await createTxn(sql, bookId, { kind: 'transfer', amount: input.principal, fromAccountId: input.fromAccountId, toAccountId: id, date: input.start > todayIST() ? todayIST() : input.start, merchant: `${input.bank} FD` });
  }
  return { id, name };
}

export async function listFds(sql: Sql, bookId: string, today = todayIST()) {
  const all = await accountBalances(sql, bookId);
  const fds = all.filter((a) => a.kind === 'fd' && !a.is_archived).map((a) => {
    const m = a.meta ?? {};
    const balance = Number(a.balance);
    const has = m.rate != null && m.start && m.maturity;
    const comp: Comp = m.compounding ?? 'quarterly';
    const valueNow = has ? fdValue(balance, m.rate, days(m.start, today < m.maturity ? today : m.maturity), comp) : balance;
    const atMaturity = has ? fdValue(balance, m.rate, days(m.start, m.maturity), comp) : null;
    return {
      id: a.id, name: a.name, bank: m.bank ?? a.institution ?? 'Other', principal: balance, rate: m.rate ?? null,
      start: m.start ?? null, maturity: m.maturity ?? null, compounding: comp, note: m.note ?? null,
      valueNow, atMaturity, interest: atMaturity !== null ? atMaturity - balance : null,
      daysLeft: m.maturity ? days(today, m.maturity) : null, matured: m.maturity ? m.maturity <= today : false,
    };
  }).sort((x, y) => (x.maturity ?? '9999').localeCompare(y.maturity ?? '9999'));
  const banks = new Map<string, typeof fds>();
  for (const f of fds) banks.set(f.bank, [...(banks.get(f.bank) ?? []), f]);
  const sum = (xs: typeof fds, k: 'principal' | 'valueNow' | 'atMaturity') => xs.reduce((s, x) => s + (x[k] ?? x.principal), 0);
  return {
    banks: [...banks.entries()].map(([bank, items]) => ({ bank, items, principal: sum(items, 'principal'), valueNow: sum(items, 'valueNow'), atMaturity: sum(items, 'atMaturity') }))
      .sort((a, b) => b.principal - a.principal),
    totals: { count: fds.length, principal: sum(fds, 'principal'), valueNow: sum(fds, 'valueNow'), atMaturity: sum(fds, 'atMaturity') },
    nextMaturity: fds.find((f) => !f.matured && f.maturity) ?? null,
  };
}

export const MatureInput = z.object({
  toAccountId: z.string().uuid(),
  amount: z.number().int().positive().max(1e13).optional(),  // what the bank actually credited; default = computed
  date: ymd.optional(),
});

/** Close an FD: principal + interest land in a bank account; the interest is income; the FD is archived. */
export async function matureFd(sql: Sql, bookId: string, fdId: string, input: z.infer<typeof MatureInput>) {
  const { banks } = await listFds(sql, bookId);
  const fd = banks.flatMap((b) => b.items).find((f) => f.id === fdId);
  if (!fd) throw new LedgerError('not_found', 'FD not found', 404);
  const credited = input.amount ?? fd.atMaturity ?? fd.principal;
  const interest = credited - fd.principal;
  const [cat] = await sql<{ id: string }[]>`
    select id from account where book_id = ${bookId} and kind = 'category' and class = 'income' and lower(name) = 'interest' limit 1`;
  if (interest !== 0 && !cat) throw new LedgerError('no_category', 'Add an income category called Interest first', 400);
  const date = input.date ?? (fd.maturity && fd.maturity < todayIST() ? fd.maturity : todayIST());
  const txnId = await sql.begin(async (tx) => {
    const id = await createRawTxn(tx, bookId, {
      kind: interest ? 'income' : 'transfer', date, merchant: `${fd.bank} FD matured`, source: 'system', externalRef: `fd:${fdId}`,
      note: interest ? `Principal ₹${Math.round(fd.principal / 100).toLocaleString('en-IN')} + interest ₹${Math.round(interest / 100).toLocaleString('en-IN')}` : null,
      postings: [
        { accountId: input.toAccountId, amount: credited },
        { accountId: fdId, amount: -fd.principal },
        ...(interest ? [{ accountId: cat!.id, amount: -interest }] : []),
      ],
    }, 'user');
    await tx`update account set is_archived = true where id = ${fdId} and book_id = ${bookId}`;
    return id;
  });
  return { txnId, credited, interest };
}
