import type { Tx } from './db.js';
import { accountBalances } from './ledger.js';
import { periodContaining, todayIST } from './money.js';
import { summary } from './stats.js';

export async function netWorth(tx: Tx, bookId: string) {
  const balances = await accountBalances(tx, bookId);
  const snaps = await tx<{ account_id: string; value: number; taken_at: string }[]>`
    with latest as (select account_id, max(taken_at) as taken_at from holding_snapshot where book_id = ${bookId} group by account_id)
    select h.account_id, sum(h.value_paise)::bigint as value, l.taken_at::text
    from holding_snapshot h join latest l on l.account_id = h.account_id and l.taken_at = h.taken_at
    group by h.account_id, l.taken_at`;
  const snapMap = new Map(snaps.map((s) => [s.account_id, s]));
  const accounts = balances
    .filter((a) => (a.class === 'asset' || a.class === 'liability') && !a.is_archived)
    .map((a) => {
      const snap = snapMap.get(a.id);
      return {
        id: a.id, name: a.name, class: a.class, kind: a.kind, icon: a.icon, institution: a.institution, meta: a.meta,
        balance: snap ? snap.value : a.balance,
        ledgerBalance: a.balance,
        valuedAt: snap ? snap.taken_at : null, // market value as of the last sync
      };
    });
  const assets = accounts.filter((a) => a.class === 'asset').reduce((s, a) => s + a.balance, 0);
  const liabilities = accounts.filter((a) => a.class === 'liability').reduce((s, a) => s + a.balance, 0);
  return { assets, liabilities, netWorth: assets - liabilities, accounts };
}

/**
 * Money you can spend this month without touching what's already committed.
 * spendable (bank + cash + wallets) − credit card dues − unspent monthly budgets.
 * Recurring bills will be subtracted once recurring rules exist; `caveats` says so.
 */
export async function safeToSpend(tx: Tx, bookId: string, monthStartDay: number, today = todayIST()) {
  const { accounts } = await netWorth(tx, bookId);
  const spendable = accounts.filter((a) => ['bank', 'cash', 'wallet'].includes(a.kind)).reduce((s, a) => s + a.balance, 0);
  const cardDues = accounts.filter((a) => a.kind === 'credit_card').reduce((s, a) => s + Math.max(a.balance, 0), 0);
  const month = periodContaining('month', today, monthStartDay);
  const budgets = await tx<{ category_id: string; name: string; amount: number; spent: number }[]>`
    select b.category_id, c.name, b.amount,
      coalesce((select sum(p.amount) from posting p join txn t on t.id = p.txn_id join account a on a.id = p.account_id
                where t.book_id = ${bookId} and t.status = 'posted' and t.occurred_on >= ${month.from} and t.occurred_on < ${month.to}
                  and (a.id = b.category_id or a.parent_id = b.category_id)), 0)::bigint as spent
    from budget b join account c on c.id = b.category_id
    where b.book_id = ${bookId} and b.period = 'monthly'`;
  const reserved = budgets.reduce((s, b) => s + Math.max(b.amount - b.spent, 0), 0);
  return {
    amount: spendable - cardDues - reserved,
    spendable, cardDues, reservedForBudgets: reserved,
    month,
    caveats: ['Upcoming bills, EMIs and SIPs are not subtracted yet: recurring rules arrive in the next build.'],
  };
}

export async function home(tx: Tx, bookId: string, monthStartDay: number, today = todayIST()) {
  const month = periodContaining('month', today, monthStartDay);
  const [nw, sts, monthSummary, recent, top] = await Promise.all([
    netWorth(tx, bookId),
    safeToSpend(tx, bookId, monthStartDay, today),
    summary(tx, bookId, month),
    tx<any[]>`
      select t.id, t.occurred_on::text as date, t.kind, coalesce(t.merchant, t.description) as title,
        (select string_agg(a.name, ', ') from posting p join account a on a.id = p.account_id
          where p.txn_id = t.id and a.kind = 'category') as category,
        (select sum(abs(p.amount)) / 2 from posting p where p.txn_id = t.id)::bigint as amount
      from txn t where t.book_id = ${bookId} and t.status = 'posted' and t.kind <> 'opening'
      order by t.occurred_on desc, t.created_at desc limit 6`,
    tx<any[]>`
      select coalesce(c.parent_id, c.id) as id, max(coalesce(pc.name, c.name)) as name, max(coalesce(pc.icon, c.icon)) as icon,
             sum(p.amount)::bigint as amount
      from txn t join posting p on p.txn_id = t.id join account c on c.id = p.account_id left join account pc on pc.id = c.parent_id
      where t.book_id = ${bookId} and t.status = 'posted' and c.class = 'expense' and t.occurred_on >= ${month.from} and t.occurred_on < ${month.to}
      group by 1 order by amount desc limit 3`,
  ]);
  return { month, netWorth: nw, safeToSpend: sts, monthSummary, recent, topCategories: top };
}
