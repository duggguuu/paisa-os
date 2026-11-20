/**
 * Statistics. Every figure here is a query over posted postings; nothing is stored as a total.
 * Spending = net debits to expense accounts (refunds reduce it).
 * Earning  = net credits to income accounts.
 * Transfers, card bill payments, investments and money lent are not spending.
 */
import type { Tx } from './db.js';
import { periodContaining, shiftPeriod, daysIn, addDays, todayIST, type Range, type PeriodType } from './money.js';

type P = Exclude<PeriodType, 'custom'>;

/**
 * For a period still in progress, "previous" is cut to the same number of elapsed days,
 * so 14 days of November are compared with the first 14 days of October, not all of it.
 * "history" (the 3 periods used for the usual/average figure) stays whole.
 */
export function resolvePeriod(type: PeriodType, anchor: string, monthStartDay: number, custom?: Range, today = todayIST()) {
  if (type === 'custom') {
    if (!custom) throw new Error('custom period needs from and to');
    return { current: custom, previous: null as Range | null, history: [] as Range[], toDate: false };
  }
  const current = periodContaining(type, anchor, monthStartDay);
  let previous = shiftPeriod(type, current, -1, monthStartDay);
  const toDate = current.from <= today && today < current.to;
  if (toDate) {
    const elapsed = daysIn({ from: current.from, to: addDays(today, 1) });
    const cut = addDays(previous.from, elapsed);
    if (cut < previous.to) previous = { from: previous.from, to: cut };
  }
  const history = [1, 2, 3].map((n) => shiftPeriod(type, current, -n, monthStartDay));
  return { current, previous, history, toDate };
}

export async function summary(tx: Tx, bookId: string, r: Range, today = todayIST()) {
  const [row] = await tx<{ spent: number; earned: number; income_txns: number; money_in: number }[]>`
    select
      coalesce(sum(p.amount) filter (where a.class = 'expense'), 0)::bigint as spent,
      coalesce(-sum(p.amount) filter (where counts_as_income(a)), 0)::bigint as earned,
      count(distinct t.id) filter (where counts_as_income(a))::int as income_txns,
      coalesce(-sum(p.amount) filter (where a.class = 'income' and not counts_as_income(a)), 0)::bigint as money_in
    from txn t join posting p on p.txn_id = t.id join account a on a.id = p.account_id
    where t.book_id = ${bookId} and t.status = 'posted' and t.occurred_on >= ${r.from} and t.occurred_on < ${r.to}`;
  const saved = row.earned - row.spent;
  return {
    spent: row.spent,
    earned: row.earned,
    moneyIn: Number(row.money_in),           // inflows that aren't income (repayments, refunds, gifts…)
    saved: row.income_txns > 0 ? saved : null,
    savingsRate: row.income_txns > 0 && row.earned > 0 ? saved / row.earned : null,
    noIncomeLogged: row.income_txns === 0,
    days: elapsedDays(r, today),
    avgDailySpend: Math.round(row.spent / elapsedDays(r, today)),
  };
}

function elapsedDays(r: Range, today: string) {
  return r.from <= today && today < r.to ? daysIn({ from: r.from, to: addDays(today, 1) }) : daysIn(r);
}

/** Spending grouped by top-level category (or by subcategory under `parentId`). */
async function categoryTotals(tx: Tx, bookId: string, r: Range, parentId?: string) {
  const rows = parentId
    ? await tx<{ id: string; total: number }[]>`
        select c.id, sum(p.amount)::bigint as total
        from txn t join posting p on p.txn_id = t.id join account c on c.id = p.account_id
        where t.book_id = ${bookId} and t.status = 'posted' and c.class = 'expense'
          and (c.parent_id = ${parentId} or c.id = ${parentId})
          and t.occurred_on >= ${r.from} and t.occurred_on < ${r.to}
        group by c.id`
    : await tx<{ id: string; total: number }[]>`
        select coalesce(c.parent_id, c.id) as id, sum(p.amount)::bigint as total
        from txn t join posting p on p.txn_id = t.id join account c on c.id = p.account_id
        where t.book_id = ${bookId} and t.status = 'posted' and c.class = 'expense'
          and t.occurred_on >= ${r.from} and t.occurred_on < ${r.to}
        group by 1`;
  return new Map(rows.map((x) => [x.id, x.total]));
}

export async function byCategory(tx: Tx, bookId: string, type: PeriodType, ranges: ReturnType<typeof resolvePeriod>, parentId?: string) {
  const cur = await categoryTotals(tx, bookId, ranges.current, parentId);
  const prev = ranges.previous ? await categoryTotals(tx, bookId, ranges.previous, parentId) : new Map();
  const hist = await Promise.all(ranges.history.map((h) => categoryTotals(tx, bookId, h, parentId)));
  const ids = [...new Set([...cur.keys(), ...prev.keys()])];
  if (ids.length === 0) return [];
  const meta = await tx<{ id: string; name: string; icon: string | null; parent_id: string | null; has_children: boolean }[]>`
    select a.id, a.name, coalesce(a.icon, (select p.icon from account p where p.id = a.parent_id)) as icon, a.parent_id,
           exists (select 1 from account c where c.parent_id = a.id) as has_children
    from account a where a.id = any(${ids}::uuid[])`;
  const budgets = type === 'custom' ? [] : await tx<{ category_id: string; amount: number }[]>`
    select category_id, amount from budget
    where book_id = ${bookId} and period = ${type === 'week' ? 'weekly' : type === 'month' ? 'monthly' : 'annual'}
      and category_id = any(${ids}::uuid[])`;
  const budgetMap = new Map(budgets.map((b) => [b.category_id, b.amount]));
  const total = [...cur.values()].reduce((s, v) => s + Math.max(v, 0), 0);
  return meta
    .map((m) => {
      const amount = cur.get(m.id) ?? 0;
      const previous = ranges.previous ? prev.get(m.id) ?? 0 : null;
      const avg3 = hist.length ? Math.round(hist.reduce((s, h) => s + (h.get(m.id) ?? 0), 0) / hist.length) : null;
      return {
        id: m.id,
        name: parentId && m.id === parentId ? `${m.name} (general)` : m.name,
        icon: m.icon,
        hasChildren: !parentId && m.has_children,
        amount,
        share: total > 0 ? Math.max(amount, 0) / total : 0,
        previous,
        avg3,
        budget: budgetMap.get(m.id) ?? null,
      };
    })
    .filter((r) => r.amount !== 0 || (r.previous ?? 0) !== 0)
    .sort((a, b) => b.amount - a.amount);
}

export async function byMerchant(tx: Tx, bookId: string, r: Range, categoryId?: string) {
  return tx<{ name: string; amount: number; count: number }[]>`
    select coalesce(nullif(t.merchant, ''), nullif(t.description, ''), 'Unnamed') as name,
           sum(p.amount)::bigint as amount, count(distinct t.id)::int as count
    from txn t join posting p on p.txn_id = t.id join account c on c.id = p.account_id
    where t.book_id = ${bookId} and t.status = 'posted' and c.class = 'expense'
      and t.occurred_on >= ${r.from} and t.occurred_on < ${r.to}
      ${categoryId ? tx`and (c.id = ${categoryId} or c.parent_id = ${categoryId})` : tx``}
    group by 1 having sum(p.amount) <> 0 order by amount desc limit 50`;
}

/** Spending by the mindset it was tagged with ('none' = not tagged). */
export async function byMood(tx: Tx, bookId: string, r: Range, categoryId?: string) {
  return tx<{ mood: string; amount: number; count: number }[]>`
    select coalesce(t.mood, 'none') as mood, sum(p.amount)::bigint as amount, count(distinct t.id)::int as count
    from txn t join posting p on p.txn_id = t.id join account c on c.id = p.account_id
    where t.book_id = ${bookId} and t.status = 'posted' and c.class = 'expense'
      and t.occurred_on >= ${r.from} and t.occurred_on < ${r.to}
      ${categoryId ? tx`and (c.id = ${categoryId} or c.parent_id = ${categoryId})` : tx``}
    group by 1 having sum(p.amount) > 0 order by amount desc`;
}

/** Spending attributed to the account that paid for it. */
export async function byAccount(tx: Tx, bookId: string, r: Range) {
  return tx<{ id: string; name: string; kind: string; amount: number }[]>`
    with e as (
      select t.id, sum(p.amount)::bigint as amt
      from txn t join posting p on p.txn_id = t.id join account c on c.id = p.account_id
      where t.book_id = ${bookId} and t.status = 'posted' and c.class = 'expense'
        and t.occurred_on >= ${r.from} and t.occurred_on < ${r.to}
      group by t.id
    ), f as (
      select distinct on (p.txn_id) p.txn_id, p.account_id
      from posting p join account a on a.id = p.account_id
      where p.txn_id in (select id from e) and a.class in ('asset', 'liability') and a.kind <> 'receivable'
      order by p.txn_id, abs(p.amount) desc
    )
    select a.id, a.name, a.kind, sum(e.amt)::bigint as amount
    from e join f on f.txn_id = e.id join account a on a.id = f.account_id
    group by a.id, a.name, a.kind having sum(e.amt) <> 0 order by amount desc`;
}

/** Money lent to and received from people (receivable accounts). */
export async function byPerson(tx: Tx, bookId: string, r: Range) {
  return tx<{ id: string; name: string; lent: number; received: number; outstanding: number }[]>`
    select a.id, a.name,
      coalesce(sum(p.amount) filter (where p.amount > 0 and t.occurred_on >= ${r.from} and t.occurred_on < ${r.to}), 0)::bigint as lent,
      coalesce(-sum(p.amount) filter (where p.amount < 0 and t.occurred_on >= ${r.from} and t.occurred_on < ${r.to}), 0)::bigint as received,
      coalesce(sum(p.amount) filter (where t.occurred_on < ${r.to}), 0)::bigint as outstanding
    from account a
    join posting p on p.account_id = a.id
    join txn t on t.id = p.txn_id and t.status = 'posted'
    where a.book_id = ${bookId} and a.kind = 'receivable'
    group by a.id, a.name
    having count(*) filter (where t.occurred_on >= ${r.from} and t.occurred_on < ${r.to}) > 0
        or coalesce(sum(p.amount) filter (where t.occurred_on < ${r.to}), 0) <> 0
    order by outstanding desc`;
}

/** Total spend for the last `n` periods ending with the current one. */
export async function trend(tx: Tx, bookId: string, type: P, current: Range, monthStartDay: number, n = 12) {
  const ranges = Array.from({ length: n }, (_, i) => shiftPeriod(type, current, i - (n - 1), monthStartDay));
  const rows = await tx<{ idx: number; total: number }[]>`
    select r.idx::int as idx, coalesce(sum(p.amount), 0)::bigint as total
    from unnest(${ranges.map((x) => x.from)}::date[], ${ranges.map((x) => x.to)}::date[]) with ordinality as r(f, t, idx)
    left join txn x on x.book_id = ${bookId} and x.status = 'posted' and x.occurred_on >= r.f and x.occurred_on < r.t
    left join posting p on p.txn_id = x.id and p.account_id in (select id from account where book_id = ${bookId} and class = 'expense')
    group by r.idx order by r.idx`;
  return ranges.map((r, i) => ({ ...r, total: rows[i]?.total ?? 0 }));
}

export async function daily(tx: Tx, bookId: string, r: Range) {
  return tx<{ day: string; amount: number }[]>`
    select t.occurred_on::text as day, sum(p.amount)::bigint as amount
    from txn t join posting p on p.txn_id = t.id join account c on c.id = p.account_id
    where t.book_id = ${bookId} and t.status = 'posted' and c.class = 'expense'
      and t.occurred_on >= ${r.from} and t.occurred_on < ${r.to}
    group by 1 order by 1`;
}

/** Money that moved but is not spending, so the user can see nothing was hidden. */
export async function excluded(tx: Tx, bookId: string, r: Range) {
  const rows = await tx<{ bucket: string; amount: number; count: number }[]>`
    select case
             when dest.kind = 'credit_card' then 'Card bill payments'
             when dest.kind = 'loan' then 'Loan repayments'
             when dest.kind in ('investment', 'fd') then 'Investments'
             when dest.kind = 'receivable' then 'Lent to people'
             else 'Transfers between accounts'
           end as bucket,
           sum(p.amount)::bigint as amount, count(distinct t.id)::int as count
    from txn t join posting p on p.txn_id = t.id join account dest on dest.id = p.account_id
    where t.book_id = ${bookId} and t.status = 'posted' and t.occurred_on >= ${r.from} and t.occurred_on < ${r.to}
      and p.amount > 0 and dest.class in ('asset', 'liability')
      and (t.kind = 'transfer' or (t.kind = 'split' and dest.kind = 'receivable'))
    group by 1 order by amount desc`;
  return rows;
}

export async function transactionsFor(tx: Tx, bookId: string, r: Range, categoryId: string) {
  return tx<any[]>`
    select t.id, t.occurred_on::text as date, t.kind, coalesce(t.merchant, t.description) as title, t.note,
           sum(p.amount)::bigint as amount, string_agg(distinct c.name, ', ') as category
    from txn t join posting p on p.txn_id = t.id join account c on c.id = p.account_id
    where t.book_id = ${bookId} and t.status = 'posted' and c.class = 'expense'
      and (c.id = ${categoryId} or c.parent_id = ${categoryId})
      and t.occurred_on >= ${r.from} and t.occurred_on < ${r.to}
    group by t.id order by t.occurred_on desc, t.created_at desc limit 200`;
}

/** Income by top-level income category (for the Income side of the Stats pie). */
export async function byIncomeCategory(tx: Tx, bookId: string, r: Range) {
  const rows = await tx<{ id: string; name: string; icon: string | null; amount: number }[]>`
    select coalesce(c.parent_id, c.id) as id, max(coalesce(pc.name, c.name)) as name, max(coalesce(pc.icon, c.icon)) as icon,
           (-sum(p.amount))::bigint as amount
    from txn t join posting p on p.txn_id = t.id join account c on c.id = p.account_id left join account pc on pc.id = c.parent_id
    where t.book_id = ${bookId} and t.status = 'posted' and counts_as_income(c)
      and t.occurred_on >= ${r.from} and t.occurred_on < ${r.to}
    group by 1 having sum(p.amount) <> 0 order by amount desc`;
  return rows.map((x) => ({ ...x, amount: Number(x.amount) }));
}
