/**
 * Owe & owed: people who owe you, people you owe, money you lent, Splitwise's overall total,
 * and loans with EMIs.
 *
 * Balances you type are set exactly, with an adjustment against equity (never spending).
 * Loans are liability accounts whose meta holds lender, rate and EMI; their EMI is a recurring
 * rule, and logging it splits the payment into interest (spending) and principal (repayment).
 */
import { z } from 'zod';
import type { Sql } from './db.js';
import { accountBalances, adjustBalance, LedgerError, audit } from './ledger.js';
import { createRule, firstOnOrAfter } from './recurring.js';
import { setOpeningBalance } from './books.js';
import { addDays, todayIST } from './money.js';

// ---------- loan maths (reducing balance, monthly) ----------
export function loanMath(principal: number, ratePct: number, emi: number, from = todayIST()) {
  const r = ratePct / 100 / 12;
  const interestNow = Math.round(principal * r);
  if (emi <= interestNow) return { monthsLeft: null as number | null, interestNow, payoff: null as string | null, totalPayable: null as number | null, interestLeft: null as number | null, emiTooSmall: true };
  const n = r === 0 ? principal / emi : Math.log(emi / (emi - r * principal)) / Math.log(1 + r);
  const months = Math.ceil(n - 1e-9);
  const totalPayable = Math.round(emi * n);
  const [y, m, d] = from.split('-').map(Number);
  const end = new Date(Date.UTC(y, m - 1 + months, d)).toISOString().slice(0, 10);
  return { monthsLeft: months, interestNow, payoff: end, totalPayable, interestLeft: totalPayable - principal, emiTooSmall: false };
}

/** The principal still owed, when what you know is the total of the remaining EMIs. */
export function principalFromTotal(totalRemaining: number, ratePct: number, emi: number) {
  const r = ratePct / 100 / 12;
  const n = totalRemaining / emi;
  return r === 0 ? totalRemaining : Math.round((emi * (1 - Math.pow(1 + r, -n))) / r);
}

export const LoanInput = z.object({
  lender: z.string().trim().min(1).max(60),
  name: z.string().trim().max(60).optional().nullable(),
  mode: z.enum(['principal', 'total']),         // what `amount` is
  amount: z.number().int().positive().max(1e13),
  rate: z.number().min(0).max(60),               // % per year
  emi: z.number().int().positive().max(1e12),
  emiDay: z.number().int().min(1).max(31),
  fromAccountId: z.string().uuid(),               // where the EMI is paid from
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function createLoan(sql: Sql, bookId: string, input: z.infer<typeof LoanInput>) {
  const principal = input.mode === 'principal' ? input.amount : principalFromTotal(input.amount, input.rate, input.emi);
  const math = loanMath(principal, input.rate, input.emi);
  if (math.emiTooSmall) {
    throw new LedgerError('emi_too_small', `At ${input.rate}% a year, ₹${Math.round(principal / 100).toLocaleString('en-IN')} costs ₹${Math.round(math.interestNow / 100).toLocaleString('en-IN')} a month in interest, more than the EMI. That amount is probably the total of your remaining EMIs: choose that option instead.`, 422);
  }
  const asOf = input.asOf ?? todayIST();
  const name = (input.name || `${input.lender} loan`).slice(0, 60);
  const accountId = await sql.begin(async (tx) => {
    const [clash] = await tx<{ id: string }[]>`select id from account where book_id = ${bookId} and class = 'liability' and lower(name) = lower(${name})`;
    if (clash) throw new LedgerError('duplicate_name', `You already have an account called ${name}`, 409);
    const [acc] = await tx<{ id: string }[]>`
      insert into account (book_id, class, kind, name, institution, icon, meta)
      values (${bookId}, 'liability', 'loan', ${name}, ${input.lender}, '🏦',
              ${tx.json({ lender: input.lender, rate: input.rate, emi: input.emi, emi_day: input.emiDay, entered: { mode: input.mode, amount: input.amount } })})
      returning id`;
    await setOpeningBalance(tx, bookId, acc.id, principal, addDays(asOf, -1));
    await audit(tx, bookId, 'account', acc.id, 'create_loan', null, { ...input, principal }, 'user');
    return acc.id;
  });
  const ruleId = await createRule(sql, bookId, {
    name: `${input.lender} EMI`, kind: 'transfer', amount: input.emi, accountId: input.fromAccountId, toAccountId: accountId,
    merchant: `${input.lender} EMI`, cadence: 'monthly', day: input.emiDay,
    firstDue: firstOnOrAfter({ cadence: 'monthly', day: input.emiDay, month: null }, asOf), autoPost: false,
  });
  return { accountId, ruleId, principal, ...math };
}

// ---------- owed / I owe / lent / Splitwise ----------
export const DebtInput = z.object({
  segment: z.enum(['owed', 'iowe', 'lent', 'splitwise']),
  name: z.string().trim().min(1).max(60).optional(),
  amount: z.number().int().min(0).max(1e12),     // as a positive number; direction comes from the segment
  direction: z.enum(['owed', 'iowe']).optional(),  // Splitwise overall: are you owed, or do you owe?
  note: z.string().trim().max(200).optional().nullable(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function setDebt(sql: Sql, bookId: string, input: z.infer<typeof DebtInput>) {
  const name = input.segment === 'splitwise' ? 'Splitwise (overall)' : input.name;
  if (!name) throw new LedgerError('bad_input', 'Who is it?', 400);
  const signed = input.segment === 'iowe' || (input.segment === 'splitwise' && input.direction === 'iowe') ? -input.amount : input.amount;
  const people = await sql<{ id: string; name: string; meta: any }[]>`select id, name, meta from account where book_id = ${bookId} and kind = 'receivable' and not is_archived`;
  const n = name.toLowerCase();
  let acc = people.find((p) => p.name.toLowerCase() === n) ?? people.find((p) => p.name.toLowerCase().split(' ')[0] === n.split(' ')[0] && (p.name.split(' ').length === 1 || n.split(' ').length === 1));
  const segMeta = input.segment === 'lent' ? 'lent' : input.segment === 'splitwise' ? 'splitwise' : 'person';
  if (!acc) {
    const [row] = await sql<{ id: string }[]>`
      insert into account (book_id, class, kind, name, icon, meta)
      values (${bookId}, 'asset', 'receivable', ${name}, ${input.segment === 'splitwise' ? '👥' : input.segment === 'lent' ? '🤝' : '🧑'}, ${sql.json({ segment: segMeta, note: input.note ?? null })})
      returning id`;
    acc = { id: row.id, name, meta: {} };
  } else if (input.segment === 'lent' || input.note) {
    await sql`update account set meta = meta || ${sql.json({ ...(input.segment === 'lent' ? { segment: 'lent' } : {}), ...(input.note ? { note: input.note } : {}) })} where id = ${acc.id}`;
  }
  const adjusted = await adjustBalance(sql, bookId, acc.id, input.date ?? todayIST(), signed, 'user');
  return { accountId: acc.id, name: acc.name, balance: signed, adjusted };
}

export async function listDebts(sql: Sql, bookId: string) {
  const all = await accountBalances(sql, bookId);
  const rules = await sql<any[]>`select id, to_account_id, next_due::text as next_due, amount from recurring_rule where book_id = ${bookId} and is_active and kind = 'transfer'`;
  const people = all.filter((a) => a.kind === 'receivable' && !a.is_archived);
  const seg = (a: any) => a.meta?.segment;
  const row = (a: any) => ({ id: a.id, name: a.name, balance: Number(a.balance), note: a.meta?.note ?? null, segment: seg(a) ?? 'person', icon: a.icon });
  const loans = all.filter((a) => a.kind === 'loan' && !a.is_archived).map((a) => {
    const outstanding = Number(a.balance);
    const m = a.meta ?? {};
    const rule = rules.find((r) => r.to_account_id === a.id);
    return { id: a.id, name: a.name, lender: m.lender ?? a.institution, outstanding, rate: m.rate ?? null, emi: m.emi ?? null, emiDay: m.emi_day ?? null,
      nextEmi: rule?.next_due ?? null, ruleId: rule?.id ?? null, ...(m.rate != null && m.emi ? loanMath(outstanding, m.rate, m.emi) : {}) };
  });
  const payables = all.filter((a) => a.kind === 'payable' && !a.is_archived).map((a) => ({ ...row(a), balance: -Number(a.balance) }));
  const owed = people.filter((a) => seg(a) !== 'lent' && a.balance > 0).map(row);
  const iowe = [...people.filter((a) => seg(a) !== 'lent' && a.balance < 0).map(row), ...payables.filter((p) => p.balance < 0)];
  const lent = people.filter((a) => seg(a) === 'lent' && a.balance !== 0).map(row);
  const sum = (xs: { balance: number }[]) => xs.reduce((s, x) => s + x.balance, 0);
  return {
    owed, iowe, lent, loans,
    totals: { owed: sum(owed), iowe: -sum(iowe), lent: sum(lent), loans: loans.reduce((s, l) => s + l.outstanding, 0), emi: loans.reduce((s, l) => s + (l.emi ?? 0), 0) },
  };
}

/** For a loan with a rate: split one EMI into interest (spending) and principal (repayment). */
export async function emiSplit(sql: Sql, bookId: string, loanAccountId: string, emi: number, onDate: string) {
  const [acc] = await sql<{ kind: string; meta: any }[]>`select kind, meta from account where id = ${loanAccountId} and book_id = ${bookId}`;
  if (!acc || acc.kind !== 'loan' || acc.meta?.rate == null) return null;
  const bal = (await accountBalances(sql, bookId, addDays(onDate, -1))).find((a) => a.id === loanAccountId);
  const outstanding = Math.max(0, Number(bal?.balance ?? 0));
  const interest = Math.min(emi, Math.round((outstanding * Number(acc.meta.rate)) / 100 / 12));
  const [cat] = await sql<{ id: string }[]>`
    select id from account where book_id = ${bookId} and kind = 'category' and class = 'expense' and lower(name) = 'interest paid' limit 1`;
  if (!cat) return null;
  return { interest, principal: emi - interest, interestCategoryId: cat.id };
}
