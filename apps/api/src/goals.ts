/**
 * Savings goals: progress, projected finish date, and "boost".
 *
 * saved     = linked account's balance, or the sum of the goal's own contributions
 * pace      = what was added over the last 90 days, per month
 * reachOn   = today + (target − saved) / pace, when pace > 0
 * neededPerMonth = what it takes to finish by target_date (if one is set)
 */
import { z } from 'zod';
import type { Sql } from './db.js';
import { accountBalances, createTxn, LedgerError, audit } from './ledger.js';
import { addDays, todayIST } from './money.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const GoalInput = z.object({
  name: z.string().trim().min(1).max(60),
  icon: z.string().max(8).optional().nullable(),
  target: z.number().int().positive().max(1e13),
  targetDate: date.optional().nullable(),
  accountId: z.string().uuid().optional().nullable(),
  startingAmount: z.number().int().min(0).max(1e13).optional(), // already saved, for unlinked goals
});
export const BoostInput = z.object({
  amount: z.number().int().refine((n) => n !== 0).refine((n) => Math.abs(n) <= 1e13),
  date: date.optional(),
  note: z.string().trim().max(200).optional().nullable(),
  fromAccountId: z.string().uuid().optional().nullable(), // linked goals: also move the money for real
});

const monthsBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / (30.44 * 86_400_000);

export async function listGoals(sql: Sql, bookId: string, today = todayIST()) {
  const goals = await sql<any[]>`
    select g.*, g.target_date::text as target_date, a.name as account_name, a.kind as account_kind
    from goal g left join account a on a.id = g.account_id
    where g.book_id = ${bookId} and not g.archived order by g.sort, g.created_at`;
  if (!goals.length) return [];
  const since = addDays(today, -90);
  const [now, then, contrib] = await Promise.all([
    accountBalances(sql, bookId),
    accountBalances(sql, bookId, since),
    sql<{ goal_id: string; total: number; recent: number; first: string }[]>`
      select goal_id, sum(amount)::bigint as total,
             coalesce(sum(amount) filter (where occurred_on > ${since}), 0)::bigint as recent,
             min(occurred_on)::text as first
      from goal_contribution where book_id = ${bookId} group by goal_id`,
  ]);
  const bal = (rows: any[], id: string) => rows.find((r) => r.id === id)?.balance ?? 0;
  return goals.map((g) => {
    const c = contrib.find((x) => x.goal_id === g.id);
    const linked = !!g.account_id;
    const saved = Math.max(0, linked ? bal(now, g.account_id) : Number(c?.total ?? 0));
    // Pace: change over the last 90 days (or since the goal started, if newer).
    const started = (g.created_at instanceof Date ? g.created_at.toISOString() : String(g.created_at)).slice(0, 10);
    const windowStart = started > since ? started : since;
    const span = Math.max(monthsBetween(windowStart, today), 1);
    const added = linked ? bal(now, g.account_id) - bal(then, g.account_id) : Number(c?.recent ?? 0);
    const pace = Math.max(0, Math.round(added / span));
    const remaining = Math.max(0, Number(g.target) - saved);
    const reachOn = remaining === 0 ? today : pace > 0 ? addDays(today, Math.ceil((remaining / pace) * 30.44)) : null;
    const monthsLeft = g.target_date ? monthsBetween(today, g.target_date) : null;
    const neededPerMonth = g.target_date && remaining > 0 ? Math.round(remaining / Math.max(monthsLeft!, 1)) : null;
    const onTrack = remaining === 0 ? true : g.target_date ? !!reachOn && reachOn <= g.target_date : pace > 0;
    return {
      id: g.id, name: g.name, icon: g.icon, target: Number(g.target), targetDate: g.target_date, accountId: g.account_id,
      accountName: g.account_name, saved, progress: Math.min(saved / Number(g.target), 1), remaining,
      pacePerMonth: pace, reachOn, neededPerMonth, onTrack, done: remaining === 0,
    };
  });
}

async function checkAccount(sql: Sql, bookId: string, id: string | null | undefined) {
  if (!id) return;
  const [a] = await sql<{ class: string }[]>`select class from account where id = ${id} and book_id = ${bookId}`;
  if (!a || a.class !== 'asset') throw new LedgerError('bad_account', 'link a savings, FD or investment account');
}

export async function createGoal(sql: Sql, bookId: string, input: z.infer<typeof GoalInput>) {
  await checkAccount(sql, bookId, input.accountId);
  return sql.begin(async (tx) => {
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from goal where book_id = ${bookId}`;
    const [g] = await tx<{ id: string }[]>`
      insert into goal (book_id, name, icon, target, target_date, account_id, sort)
      values (${bookId}, ${input.name}, ${input.icon ?? null}, ${input.target}, ${input.targetDate ?? null}, ${input.accountId ?? null}, ${n})
      returning id`;
    if (!input.accountId && input.startingAmount) {
      await tx`insert into goal_contribution (goal_id, book_id, occurred_on, amount, note)
               values (${g.id}, ${bookId}, ${todayIST()}, ${input.startingAmount}, 'Already saved')`;
    }
    await audit(tx, bookId, 'goal', g.id, 'create', null, input, 'user');
    return g.id;
  });
}

export async function updateGoal(sql: Sql, bookId: string, goalId: string, input: z.infer<typeof GoalInput>) {
  await checkAccount(sql, bookId, input.accountId);
  await sql.begin(async (tx) => {
    const [before] = await tx<any[]>`select * from goal where id = ${goalId} and book_id = ${bookId}`;
    if (!before) throw new LedgerError('not_found', 'goal not found', 404);
    await tx`update goal set name = ${input.name}, icon = ${input.icon ?? null}, target = ${input.target},
               target_date = ${input.targetDate ?? null}, account_id = ${input.accountId ?? null} where id = ${goalId}`;
    await audit(tx, bookId, 'goal', goalId, 'update', before, input, 'user');
  });
}

/** Archive rather than delete, so the history stays in the audit trail. */
export async function archiveGoal(sql: Sql, bookId: string, goalId: string) {
  await sql.begin(async (tx) => {
    await tx`update goal set archived = true where id = ${goalId} and book_id = ${bookId}`;
    await audit(tx, bookId, 'goal', goalId, 'archive', null, null, 'user');
  });
}

export async function boost(sql: Sql, bookId: string, goalId: string, input: z.infer<typeof BoostInput>) {
  const [g] = await sql<any[]>`select * from goal where id = ${goalId} and book_id = ${bookId} and not archived`;
  if (!g) throw new LedgerError('not_found', 'goal not found', 404);
  const day = input.date ?? todayIST();
  let txnId: string | null = null;
  // Linked goal + a source account: move the money for real (a transfer, not spending).
  if (g.account_id && input.fromAccountId) {
    if (input.amount < 0) throw new LedgerError('bad_amount', 'to take money out, record a transfer from the account instead');
    if (input.fromAccountId === g.account_id) throw new LedgerError('bad_account', 'pick a different account to move money from');
    txnId = (await createTxn(sql, bookId, {
      kind: 'transfer', amount: input.amount, fromAccountId: input.fromAccountId, toAccountId: g.account_id,
      date: day, merchant: `Goal: ${g.name}`, note: input.note ?? null,
    })).id;
  } else if (g.account_id) {
    throw new LedgerError('needs_source', `this goal tracks ${'its linked account'}: pick the account the money comes from`);
  }
  await sql.begin(async (tx) => {
    await tx`insert into goal_contribution (goal_id, book_id, occurred_on, amount, note, txn_id)
             values (${goalId}, ${bookId}, ${day}, ${input.amount}, ${input.note ?? null}, ${txnId})`;
    await audit(tx, bookId, 'goal', goalId, 'boost', null, { ...input, txnId }, 'user');
  });
  return { ok: true, txnId };
}

export async function contributions(sql: Sql, bookId: string, goalId: string) {
  return sql<any[]>`select id, occurred_on::text as date, amount, note, txn_id from goal_contribution
                    where goal_id = ${goalId} and book_id = ${bookId} order by occurred_on desc, created_at desc limit 50`;
}
