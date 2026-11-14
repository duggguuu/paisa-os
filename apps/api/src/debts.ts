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
import { createRule, updateRule, firstOnOrAfter } from './recurring.js';
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
  /** 'emi': each payment covers interest and repays some principal. 'interest_only': payments are interest; principal stays until repaid. */
  type: z.enum(['emi', 'interest_only']).default('emi'),
  mode: z.enum(['principal', 'total']).default('principal'), // what `amount` is (EMI loans only)
  amount: z.number().int().positive().max(1e13),
  rate: z.number().min(0).max(60),               // % per year
  emi: z.number().int().positive().max(1e12),    // the monthly payment (interest-only: the monthly interest)
  emiDay: z.number().int().min(1).max(31),
  fromAccountId: z.string().uuid(),               // where the payment comes from
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(), // interest-only: when the principal is due
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
type Loan = z.infer<typeof LoanInput>;

function principalOf(input: Loan) {
  if (input.type === 'interest_only' || input.mode === 'principal') return input.amount;
  return principalFromTotal(input.amount, input.rate, input.emi);
}
function checkLoan(input: Loan, principal: number) {
  if (input.type === 'interest_only') return;
  const math = loanMath(principal, input.rate, input.emi);
  if (math.emiTooSmall) {
    throw new LedgerError('emi_too_small', `At ${input.rate}% a year, ₹${Math.round(principal / 100).toLocaleString('en-IN')} costs ₹${Math.round(math.interestNow / 100).toLocaleString('en-IN')} a month in interest, more than the payment. If the payment is interest only, choose "Interest only"; if the amount is the total of your remaining EMIs, choose that.`, 422);
  }
}
const loanMeta = (input: Loan) => ({ lender: input.lender, type: input.type, rate: input.rate, emi: input.emi, emi_day: input.emiDay, end_date: input.endDate ?? null, entered: { mode: input.mode, amount: input.amount } });

export async function createLoan(sql: Sql, bookId: string, input: Loan) {
  const principal = principalOf(input);
  checkLoan(input, principal);
  const asOf = input.asOf ?? todayIST();
  const name = (input.name || `${input.lender} loan`).slice(0, 60);
  const accountId = await sql.begin(async (tx) => {
    const [clash] = await tx<{ id: string }[]>`select id from account where book_id = ${bookId} and class = 'liability' and lower(name) = lower(${name})`;
    if (clash) throw new LedgerError('duplicate_name', `You already have an account called ${name}. Edit it on the Loans tab instead.`, 409);
    const [acc] = await tx<{ id: string }[]>`
      insert into account (book_id, class, kind, name, institution, icon, meta)
      values (${bookId}, 'liability', 'loan', ${name}, ${input.lender}, '🏦', ${tx.json(loanMeta(input))})
      returning id`;
    await setOpeningBalance(tx, bookId, acc.id, principal, addDays(asOf, -1));
    await audit(tx, bookId, 'account', acc.id, 'create_loan', null, { ...input, principal }, 'user');
    return acc.id;
  });
  const label = input.type === 'interest_only' ? 'interest' : 'EMI';
  const ruleId = await createRule(sql, bookId, {
    name: `${input.lender} ${label}`, kind: 'transfer', amount: input.emi, accountId: input.fromAccountId, toAccountId: accountId,
    merchant: `${input.lender} ${label}`, cadence: 'monthly', day: input.emiDay, endDate: input.endDate ?? null,
    firstDue: firstOnOrAfter({ cadence: 'monthly', day: input.emiDay, month: null }, asOf), autoPost: false,
  });
  return { accountId, ruleId, principal, ...loanInfo(principal, loanMeta(input)) };
}

/**
 * Fix a loan's details (type, principal, rate, payment, day). The principal is set as of today
 * with an adjustment, so earlier payments stay as they were; the monthly rule follows.
 */
export async function updateLoan(sql: Sql, bookId: string, loanId: string, input: Loan) {
  const [acc] = await sql<{ id: string; meta: any }[]>`select id, meta from account where id = ${loanId} and book_id = ${bookId} and kind = 'loan'`;
  if (!acc) throw new LedgerError('not_found', 'Loan not found', 404);
  const principal = principalOf(input);
  checkLoan(input, principal);
  await sql`update account set meta = meta || ${sql.json(loanMeta(input))}, institution = ${input.lender} where id = ${loanId}`;
  await adjustBalance(sql, bookId, loanId, todayIST(), principal, 'user');
  const label = input.type === 'interest_only' ? 'interest' : 'EMI';
  const [rule] = await sql<{ id: string }[]>`select id from recurring_rule where book_id = ${bookId} and to_account_id = ${loanId} and is_active limit 1`;
  const ruleInput = {
    name: `${input.lender} ${label}`, kind: 'transfer' as const, amount: input.emi, accountId: input.fromAccountId, toAccountId: loanId,
    merchant: `${input.lender} ${label}`, cadence: 'monthly' as const, day: input.emiDay, endDate: input.endDate ?? null, autoPost: false,
  };
  if (rule) await updateRule(sql, bookId, rule.id, ruleInput);
  else await createRule(sql, bookId, { ...ruleInput, firstDue: firstOnOrAfter({ cadence: 'monthly', day: input.emiDay, month: null }, todayIST()) });
  return { accountId: loanId, principal };
}

/** Numbers for a loan card. */
function loanInfo(outstanding: number, m: any) {
  if (m.type === 'interest_only') {
    return { monthsLeft: null, interestNow: m.emi ?? null, payoff: m.end_date ?? null, totalPayable: null, interestLeft: null, emiTooSmall: false,
      interestYear: m.emi ? m.emi * 12 : null, computedInterest: m.rate != null ? Math.round((outstanding * m.rate) / 1200) : null };
  }
  return m.rate != null && m.emi ? loanMath(outstanding, m.rate, m.emi) : {};
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
  const rules = await sql<any[]>`select id, account_id, to_account_id, next_due::text as next_due, amount from recurring_rule where book_id = ${bookId} and is_active and kind = 'transfer'`;
  const people = all.filter((a) => a.kind === 'receivable' && !a.is_archived);
  const seg = (a: any) => a.meta?.segment;
  const row = (a: any) => ({ id: a.id, name: a.name, balance: Number(a.balance), note: a.meta?.note ?? null, segment: seg(a) ?? 'person', icon: a.icon });
  const loans = all.filter((a) => a.kind === 'loan' && !a.is_archived).map((a) => {
    const outstanding = Number(a.balance);
    const m = a.meta ?? {};
    const rule = rules.find((r) => r.to_account_id === a.id);
    return { id: a.id, name: a.name, lender: m.lender ?? a.institution, outstanding, type: m.type ?? 'emi', rate: m.rate ?? null, emi: m.emi ?? null, emiDay: m.emi_day ?? null,
      endDate: m.end_date ?? null, fromAccountId: rule?.account_id ?? null, nextEmi: rule?.next_due ?? null, ruleId: rule?.id ?? null, ...loanInfo(outstanding, m) };
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
  if (!acc || acc.kind !== 'loan' || (acc.meta?.rate == null && acc.meta?.type !== 'interest_only')) return null;
  const bal = (await accountBalances(sql, bookId, addDays(onDate, -1))).find((a) => a.id === loanAccountId);
  const outstanding = Math.max(0, Number(bal?.balance ?? 0));
  // Interest-only: the whole payment is interest. EMI: interest on what's still owed, the rest is principal.
  const interest = acc.meta.type === 'interest_only' ? emi : Math.min(emi, Math.round((outstanding * Number(acc.meta.rate)) / 100 / 12));
  const [cat] = await sql<{ id: string }[]>`
    select id from account where book_id = ${bookId} and kind = 'category' and class = 'expense' and lower(name) = 'interest paid' limit 1`;
  if (!cat) return null;
  return { interest, principal: emi - interest, interestCategoryId: cat.id };
}
