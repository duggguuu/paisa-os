/**
 * Salary: the structure from your payslip (earnings, deductions, employer contributions), the monthly
 * credit as a recurring income rule (default: the last day of every month), payslips per month for
 * TDS so far, and the money-in review (anything that isn't salary can be marked "not income").
 *
 * The tax maths itself runs in the browser (web/src/tax.ts) so the simulator's sliders are instant.
 */
import { z } from 'zod';
import type { Sql } from './db.js';
import { LedgerError, audit } from './ledger.js';
import { createRule, updateRule, firstOnOrAfter } from './recurring.js';
import { todayIST } from './money.js';

const paise = z.number().int().min(0).max(1e12);
const Line = z.object({ name: z.string().trim().min(1).max(60), monthly: paise, kind: z.string().max(20).optional() });

export const SalaryInput = z.object({
  employer: z.string().trim().max(80).optional().nullable(),
  accountId: z.string().uuid(),
  payDay: z.number().int().min(1).max(31).default(31),        // 31 = last day of the month
  earnings: z.array(Line).max(30),
  deductions: z.array(Line).max(30),
  employerContrib: z.array(Line).max(15).default([]),
  annualBonus: paise.default(0),
  autoPost: z.boolean().default(true),
});

const sum = (xs: { monthly: number }[]) => xs.reduce((s, x) => s + x.monthly, 0);

/** Financial year (Apr–Mar) containing `d`, e.g. 2026-11-15 → 2026-04-01 … 2027-04-01. */
export function fyOf(d: string) {
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return { label: `${start}-${String((start + 1) % 100).padStart(2, '0')}`, from: `${start}-04-01`, to: `${start + 1}-04-01` };
}

async function salaryCategory(sql: Sql, bookId: string) {
  const [c] = await sql<{ id: string }[]>`select id from account where book_id = ${bookId} and kind = 'category' and class = 'income' and parent_id is null and lower(name) = 'salary' limit 1`;
  if (!c) throw new LedgerError('no_category', 'Add an income category called Salary first', 400);
  return c.id;
}

export async function getSalary(sql: Sql, bookId: string, today = todayIST()) {
  const fy = fyOf(today);
  const [p] = await sql<any[]>`select * from salary_profile where book_id = ${bookId}`;
  const slips = await sql<any[]>`
    select id, month::text as month, earnings, deductions, employer_contrib, gross::bigint as gross, net::bigint as net, tds::bigint as tds, note
    from salary_slip where book_id = ${bookId} and month >= ${fy.from} and month < ${fy.to} order by month`;
  const rule = p?.rule_id ? (await sql<any[]>`select id, amount, next_due::text as next_due, auto_post, is_active from recurring_rule where id = ${p.rule_id}`)[0] : null;
  // Salary actually received this FY (from the ledger).
  const [rec] = await sql<{ total: number; n: number }[]>`
    select coalesce(-sum(p.amount), 0)::bigint as total, count(distinct t.id)::int as n
    from txn t join posting p on p.txn_id = t.id join account a on a.id = p.account_id
    where t.book_id = ${bookId} and t.status = 'posted' and a.kind = 'category' and a.class = 'income'
      and (lower(a.name) = 'salary' or a.parent_id in (select id from account where book_id = ${bookId} and lower(name) = 'salary' and kind = 'category'))
      and t.occurred_on >= ${fy.from} and t.occurred_on < ${fy.to}`;
  return {
    fy,
    profile: p ? {
      employer: p.employer, accountId: p.account_id, payDay: p.pay_day, earnings: p.earnings, deductions: p.deductions,
      employerContrib: p.employer_contrib, annualBonus: Number(p.annual_bonus),
      gross: sum(p.earnings), net: sum(p.earnings) - sum(p.deductions),
    } : null,
    rule: rule ? { id: rule.id, amount: Number(rule.amount), nextDue: rule.next_due, autoPost: rule.auto_post, active: rule.is_active } : null,
    slips: slips.map((s) => ({ ...s, gross: Number(s.gross), net: Number(s.net), tds: Number(s.tds), employerContrib: s.employer_contrib })),
    receivedThisFy: { total: Number(rec.total), count: rec.n },
  };
}

export async function saveSalary(sql: Sql, bookId: string, input: z.infer<typeof SalaryInput>) {
  const net = sum(input.earnings) - sum(input.deductions);
  if (net <= 0) throw new LedgerError('bad_salary', 'Deductions are more than earnings. Check the amounts.', 400);
  const [acc] = await sql<{ id: string }[]>`select id from account where id = ${input.accountId} and book_id = ${bookId} and kind in ('bank', 'wallet', 'cash')`;
  if (!acc) throw new LedgerError('bad_account', 'Pick the bank account your salary lands in', 400);
  const categoryId = await salaryCategory(sql, bookId);
  const [existing] = await sql<{ rule_id: string | null }[]>`select rule_id from salary_profile where book_id = ${bookId}`;
  const rule = {
    name: input.employer ? `Salary · ${input.employer}` : 'Salary', kind: 'income' as const, amount: net, accountId: input.accountId, categoryId,
    merchant: input.employer || 'Salary', cadence: 'monthly' as const, day: input.payDay, autoPost: input.autoPost,
  };
  let ruleId = existing?.rule_id ?? null;
  const [live] = ruleId ? await sql<{ id: string }[]>`select id from recurring_rule where id = ${ruleId} and is_active` : [];
  if (live) await updateRule(sql, bookId, ruleId!, rule);
  else ruleId = await createRule(sql, bookId, { ...rule, firstDue: firstOnOrAfter({ cadence: 'monthly', day: input.payDay, month: null }, todayIST()) });
  await sql`
    insert into salary_profile (book_id, employer, account_id, rule_id, pay_day, earnings, deductions, employer_contrib, annual_bonus, updated_at)
    values (${bookId}, ${input.employer ?? null}, ${input.accountId}, ${ruleId}, ${input.payDay}, ${sql.json(input.earnings)}, ${sql.json(input.deductions)},
            ${sql.json(input.employerContrib)}, ${input.annualBonus}, now())
    on conflict (book_id) do update set employer = excluded.employer, account_id = excluded.account_id, rule_id = excluded.rule_id,
      pay_day = excluded.pay_day, earnings = excluded.earnings, deductions = excluded.deductions, employer_contrib = excluded.employer_contrib,
      annual_bonus = excluded.annual_bonus, updated_at = now()`;
  await audit(sql, bookId, 'salary', bookId, 'save', null, { ...input, net }, 'user');
  return { net, ruleId };
}

export const SlipInput = z.object({
  earnings: z.array(Line).max(30),
  deductions: z.array(Line).max(30),
  employerContrib: z.array(Line).max(15).default([]),
  note: z.string().trim().max(200).optional().nullable(),
});

export async function saveSlip(sql: Sql, bookId: string, month: string, input: z.infer<typeof SlipInput>) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new LedgerError('bad_month', 'month must look like 2026-11', 400);
  const gross = sum(input.earnings), ded = sum(input.deductions);
  const tds = input.deductions.filter((d) => d.kind === 'tds').reduce((s, d) => s + d.monthly, 0);
  await sql`
    insert into salary_slip (book_id, month, earnings, deductions, employer_contrib, gross, net, tds, note)
    values (${bookId}, ${`${month}-01`}, ${sql.json(input.earnings)}, ${sql.json(input.deductions)}, ${sql.json(input.employerContrib)}, ${gross}, ${gross - ded}, ${tds}, ${input.note ?? null})
    on conflict (book_id, month) do update set earnings = excluded.earnings, deductions = excluded.deductions, employer_contrib = excluded.employer_contrib,
      gross = excluded.gross, net = excluded.net, tds = excluded.tds, note = excluded.note`;
  return { month, gross, net: gross - ded, tds };
}

export async function deleteSlip(sql: Sql, bookId: string, month: string) {
  await sql`delete from salary_slip where book_id = ${bookId} and month = ${`${month}-01`}`;
}

/** Money that came in this FY under income categories other than Salary (to review: income or not?). */
export async function moneyIn(sql: Sql, bookId: string, today = todayIST()) {
  const fy = fyOf(today);
  const rows = await sql<any[]>`
    select t.id, t.occurred_on::text as date, coalesce(t.merchant, t.description) as title, (-p.amount)::bigint as amount,
           a.id as category_id, coalesce(pa.name || ' › ', '') || a.name as category, counts_as_income(a) as counted
    from txn t join posting p on p.txn_id = t.id join account a on a.id = p.account_id left join account pa on pa.id = a.parent_id
    where t.book_id = ${bookId} and t.status = 'posted' and a.kind = 'category' and a.class = 'income' and p.amount < 0
      and lower(a.name) <> 'salary' and coalesce(lower(pa.name), '') <> 'salary'
      and t.occurred_on >= ${fy.from} and t.occurred_on < ${fy.to}
    order by t.occurred_on desc limit 300`;
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

export const ReclassInput = z.object({ txnIds: z.array(z.string().uuid()).min(1).max(300), categoryId: z.string().uuid() });

/** Move the income side of these transactions to another income category (e.g. "Repayments"). Amounts and accounts don't change. */
export async function reclassify(sql: Sql, bookId: string, input: z.infer<typeof ReclassInput>) {
  const [cat] = await sql<{ id: string }[]>`select id from account where id = ${input.categoryId} and book_id = ${bookId} and kind = 'category' and class = 'income'`;
  if (!cat) throw new LedgerError('bad_category', 'Pick an income or money-in category', 400);
  return sql.begin(async (tx) => {
    const moved = await tx<{ txn_id: string }[]>`
      update posting set account_id = ${cat.id}
      where txn_id in (select id from txn where book_id = ${bookId} and id = any(${input.txnIds}::uuid[]))
        and account_id in (select id from account where book_id = ${bookId} and kind = 'category' and class = 'income')
      returning txn_id`;
    for (const id of new Set(moved.map((m) => m.txn_id))) await audit(tx, bookId, 'txn', id, 'reclassify', null, { categoryId: cat.id }, 'user');
    return { moved: new Set(moved.map((m) => m.txn_id)).size };
  });
}
