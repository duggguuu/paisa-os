/**
 * Recurring rules: rent, SIPs, subscriptions, EMIs, salary.
 *
 * A rule only stores its next due date. Logging (or skipping) an occurrence advances it.
 * Each logged occurrence carries external_ref `rec:<rule>:<due date>`, which the database
 * keeps unique, so an occurrence can never be logged twice (even by two devices at once).
 */
import { z } from 'zod';
import type { Sql, Tx } from './db.js';
import { createTxn, createRawTxn, LedgerError, audit } from './ledger.js';
import { emiSplit } from './debts.js';
import { addDays, todayIST, type Range } from './money.js';

const id = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const RuleInput = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['expense', 'income', 'transfer']),
  amount: z.number().int().positive().max(1e13),
  accountId: id,
  categoryId: id.optional().nullable(),
  toAccountId: id.optional().nullable(),
  merchant: z.string().trim().max(120).optional().nullable(),
  cadence: z.enum(['weekly', 'monthly', 'yearly']).default('monthly'),
  day: z.number().int().min(1).max(31),
  month: z.number().int().min(1).max(12).optional().nullable(),
  firstDue: date.optional(),          // defaults to the next matching date from today
  endDate: date.optional().nullable(),
  autoPost: z.boolean().default(false),
}).refine((r) => (r.kind === 'transfer' ? !!r.toAccountId : !!r.categoryId), 'transfers need a destination account; others need a category')
  .refine((r) => r.cadence !== 'weekly' || r.day <= 7, 'weekly rules use day 1 (Mon) to 7 (Sun)');
export type RuleInput = z.infer<typeof RuleInput>;

type Cadence = 'weekly' | 'monthly' | 'yearly';
interface RuleShape { cadence: Cadence; day: number; month: number | null }

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(Math.min(d, lastDay(y, m)))}`;

/** The first occurrence on or after `from`. Day 31 means "last day" in shorter months. */
export function firstOnOrAfter(r: RuleShape, from: string): string {
  const [y, m, d] = from.split('-').map(Number);
  if (r.cadence === 'weekly') {
    const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7 + 1; // 1 = Monday
    return addDays(from, (r.day - dow + 7) % 7);
  }
  if (r.cadence === 'monthly') {
    const here = ymd(y, m, r.day);
    return here >= from ? here : ymd(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, r.day);
  }
  const mm = r.month ?? m;
  const here = ymd(y, mm, r.day);
  return here >= from ? here : ymd(y + 1, mm, r.day);
}

/** The occurrence after `due`. */
export function nextAfter(r: RuleShape, due: string): string {
  return firstOnOrAfter(r, addDays(due, 1));
}

export async function listRules(sql: Sql | Tx, bookId: string) {
  return sql<any[]>`
    select r.*, r.next_due::text as next_due, r.end_date::text as end_date,
      a.name as account_name, a.icon as account_icon, a.kind as account_kind,
      c.name as category_name, coalesce(c.icon, pc.icon) as category_icon,
      t.name as to_account_name, t.kind as to_account_kind,
      (select max(x.occurred_on)::text from txn x where x.recurring_id = r.id and x.status = 'posted') as last_logged
    from recurring_rule r
    join account a on a.id = r.account_id
    left join account c on c.id = r.category_id
    left join account pc on pc.id = c.parent_id
    left join account t on t.id = r.to_account_id
    where r.book_id = ${bookId}
    order by r.is_active desc, r.next_due, r.name`;
}

async function checkAccounts(sql: Sql | Tx, bookId: string, r: RuleInput) {
  const ids = [r.accountId, r.categoryId, r.toAccountId].filter(Boolean) as string[];
  const rows = await sql<{ id: string; class: string; kind: string }[]>`select id, class, kind from account where book_id = ${bookId} and id = any(${ids}::uuid[])`;
  const get = (i?: string | null) => rows.find((x) => x.id === i);
  const acc = get(r.accountId);
  if (!acc || !['asset', 'liability'].includes(acc.class)) throw new LedgerError('bad_account', 'pick the account it is paid from / into');
  if (r.kind !== 'transfer') {
    const c = get(r.categoryId);
    if (!c || c.class !== r.kind) throw new LedgerError('bad_category', `pick an ${r.kind} category`);
  } else {
    const t = get(r.toAccountId);
    if (!t || !['asset', 'liability'].includes(t.class) || t.id === acc.id) throw new LedgerError('bad_account', 'pick a different account to move money into');
  }
}

export async function createRule(sql: Sql, bookId: string, input: RuleInput) {
  await checkAccounts(sql, bookId, input);
  const shape = { cadence: input.cadence, day: input.day, month: input.cadence === 'yearly' ? input.month ?? null : null };
  const next = input.firstDue ?? firstOnOrAfter(shape, todayIST());
  return sql.begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into recurring_rule (book_id, name, kind, amount, account_id, category_id, to_account_id, merchant, cadence, day, month, next_due, end_date, auto_post)
      values (${bookId}, ${input.name}, ${input.kind}, ${input.amount}, ${input.accountId}, ${input.kind === 'transfer' ? null : input.categoryId ?? null},
              ${input.kind === 'transfer' ? input.toAccountId ?? null : null}, ${input.merchant ?? null}, ${input.cadence}, ${input.day},
              ${shape.month}, ${next}, ${input.endDate ?? null}, ${input.autoPost})
      returning id`;
    await audit(tx, bookId, 'recurring', row.id, 'create', null, input, 'user');
    return row.id;
  });
}

export async function updateRule(sql: Sql, bookId: string, ruleId: string, input: RuleInput & { isActive?: boolean }) {
  await checkAccounts(sql, bookId, input);
  await sql.begin(async (tx) => {
    const [before] = await tx<any[]>`select * from recurring_rule where id = ${ruleId} and book_id = ${bookId}`;
    if (!before) throw new LedgerError('not_found', 'rule not found', 404);
    const shape = { cadence: input.cadence, day: input.day, month: input.cadence === 'yearly' ? input.month ?? null : null };
    // Keep the current cycle unless the schedule itself changed.
    const scheduleChanged = before.cadence !== shape.cadence || before.day !== shape.day || (before.month ?? null) !== shape.month;
    const next = input.firstDue ?? (scheduleChanged ? firstOnOrAfter(shape, todayIST()) : before.next_due);
    await tx`
      update recurring_rule set name = ${input.name}, kind = ${input.kind}, amount = ${input.amount}, account_id = ${input.accountId},
        category_id = ${input.kind === 'transfer' ? null : input.categoryId ?? null}, to_account_id = ${input.kind === 'transfer' ? input.toAccountId ?? null : null},
        merchant = ${input.merchant ?? null}, cadence = ${input.cadence}, day = ${input.day}, month = ${shape.month}, next_due = ${next},
        end_date = ${input.endDate ?? null}, auto_post = ${input.autoPost}, is_active = ${input.isActive ?? before.is_active}
      where id = ${ruleId}`;
    await audit(tx, bookId, 'recurring', ruleId, 'update', before, input, 'user');
  });
}

/** Delete a rule. Rules that already logged transactions are deactivated instead, so history keeps its link. */
export async function deleteRule(sql: Sql, bookId: string, ruleId: string) {
  await sql.begin(async (tx) => {
    const [before] = await tx<any[]>`select * from recurring_rule where id = ${ruleId} and book_id = ${bookId}`;
    if (!before) return;
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from txn where recurring_id = ${ruleId}`;
    if (n > 0) await tx`update recurring_rule set is_active = false where id = ${ruleId}`;
    else await tx`delete from recurring_rule where id = ${ruleId}`;
    await audit(tx, bookId, 'recurring', ruleId, n > 0 ? 'deactivate' : 'delete', before, null, 'user');
  });
}

async function advance(tx: Tx, rule: any) {
  const next = nextAfter({ cadence: rule.cadence, day: rule.day, month: rule.month }, rule.next_due);
  const ended = rule.end_date && next > rule.end_date;
  await tx`update recurring_rule set next_due = ${next}, is_active = ${ended ? false : rule.is_active} where id = ${rule.id}`;
}

/** Log the current due occurrence (optionally with a different amount or date) and move to the next one. */
export async function logDue(sql: Sql, bookId: string, ruleId: string, opts: { amount?: number; date?: string } = {}, actor = 'user') {
  const [rule] = await sql<any[]>`select *, next_due::text as next_due, end_date::text as end_date from recurring_rule where id = ${ruleId} and book_id = ${bookId}`;
  if (!rule) throw new LedgerError('not_found', 'rule not found', 404);
  const due = rule.next_due as string;
  const amount = opts.amount ?? Number(rule.amount);
  const common = { date: opts.date ?? due, merchant: rule.merchant ?? rule.name, source: 'recurring' as const, externalRef: `rec:${rule.id}:${due}` };
  const input = rule.kind === 'transfer'
    ? { kind: 'transfer' as const, amount, fromAccountId: rule.account_id, toAccountId: rule.to_account_id, ...common }
    : { kind: rule.kind as 'expense' | 'income', amount, accountId: rule.account_id, categoryId: rule.category_id, ...common };
  let txnId: string;
  try {
    // A loan EMI: interest is spending (Interest paid), the rest pays the loan down.
    const split = rule.kind === 'transfer' ? await emiSplit(sql, bookId, rule.to_account_id, amount, common.date) : null;
    if (split) {
      txnId = await sql.begin((tx) => createRawTxn(tx, bookId, {
        kind: 'transfer', date: common.date, merchant: common.merchant, source: 'recurring', externalRef: common.externalRef, recurringId: rule.id,
        note: `EMI: ₹${Math.round(split.principal / 100).toLocaleString('en-IN')} principal + ₹${Math.round(split.interest / 100).toLocaleString('en-IN')} interest`,
        postings: [
          { accountId: rule.account_id, amount: -amount },
          { accountId: rule.to_account_id, amount: split.principal, memo: 'Principal' },
          { accountId: split.interestCategoryId, amount: split.interest, memo: 'Interest' },
        ],
      }, actor));
    } else {
      txnId = (await createTxn(sql, bookId, input, actor, { recurringId: rule.id })).id;
    }
  } catch (e: any) {
    if (e?.code === '23505') e = { code: 'duplicate_ref' };
    if (e?.code !== 'duplicate_ref') throw e;
    // Already logged (another device, or auto-post raced us): just move on.
    const [t] = await sql<{ id: string }[]>`select id from txn where book_id = ${bookId} and external_ref = ${common.externalRef} and status = 'posted'`;
    txnId = t.id;
  }
  await sql.begin((tx) => advance(tx, rule));
  return { txnId, loggedFor: due };
}

export async function skipDue(sql: Sql, bookId: string, ruleId: string) {
  await sql.begin(async (tx) => {
    const [rule] = await tx<any[]>`select *, next_due::text as next_due, end_date::text as end_date from recurring_rule where id = ${ruleId} and book_id = ${bookId}`;
    if (!rule) throw new LedgerError('not_found', 'rule not found', 404);
    await advance(tx, rule);
    await audit(tx, bookId, 'recurring', ruleId, 'skip', { next_due: rule.next_due }, null, 'user');
  });
}

/** Log every auto-post rule that has come due. Safe to call often (it's idempotent). */
export async function postAutoDue(sql: Sql, bookId: string, today = todayIST()) {
  const rules = await sql<any[]>`
    select id from recurring_rule where book_id = ${bookId} and is_active and auto_post and next_due <= ${today}`;
  let posted = 0;
  for (const r of rules) {
    for (let i = 0; i < 24; i++) { // catch up at most two years of missed cycles
      const [cur] = await sql<any[]>`select next_due::text as next_due, is_active from recurring_rule where id = ${r.id}`;
      if (!cur.is_active || cur.next_due > today) break;
      await logDue(sql, bookId, r.id, {}, 'auto');
      posted++;
    }
  }
  return posted;
}

/**
 * Money still committed this period: unlogged occurrences of active rules due before the
 * period ends (overdue ones included), that will take money out of what you can spend.
 * Income isn't counted (it's not guaranteed); card-bill transfers aren't (card dues already are).
 */
export async function upcoming(sql: Sql | Tx, bookId: string, period: Range, today = todayIST()) {
  const rules = await listRules(sql, bookId);
  const items: { ruleId: string; name: string; date: string; amount: number; kind: string; overdue: boolean; icon: string | null }[] = [];
  for (const r of rules) {
    if (!r.is_active || r.kind === 'income') continue;
    if (r.kind === 'transfer' && (!['bank', 'cash', 'wallet'].includes(r.account_kind) || ['bank', 'cash', 'wallet', 'credit_card'].includes(r.to_account_kind))) continue;
    let due: string = r.next_due;
    for (let i = 0; i < 60 && due < period.to; i++) {
      if (r.end_date && due > r.end_date) break;
      items.push({ ruleId: r.id, name: r.name, date: due, amount: Number(r.amount), kind: r.kind, overdue: due < today, icon: r.category_icon ?? r.account_icon });
      due = nextAfter({ cadence: r.cadence, day: r.day, month: r.month }, due);
    }
  }
  items.sort((a, b) => a.date.localeCompare(b.date));
  return { items, total: items.reduce((s, i) => s + i.amount, 0) };
}

/** Rules that need attention on Home: due today or overdue (not auto-posted), plus the next few days. */
export async function dueSoon(sql: Sql | Tx, bookId: string, today = todayIST(), days = 7) {
  const rows = await listRules(sql, bookId);
  return rows
    .filter((r) => r.is_active && r.next_due <= addDays(today, days))
    .map((r) => ({ ...r, amount: Number(r.amount), overdue: r.next_due < today, today: r.next_due === today }));
}
