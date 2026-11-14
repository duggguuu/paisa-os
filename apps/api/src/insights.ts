/**
 * Insights: plain-language observations computed from your own ledger.
 * Rule-based and local (no AI service, nothing leaves the server). Each insight explains
 * the numbers behind it, and some carry an action (e.g. "track as a recurring bill").
 */
import type { Sql } from './db.js';
import { summary, byCategory, resolvePeriod, trend } from './stats.js';
import { addDays, daysIn, todayIST, periodContaining } from './money.js';
import { netWorth } from './dashboard.js';

export interface Insight {
  id: string;
  tone: 'good' | 'warn' | 'info';
  icon: string;
  title: string;
  body: string;
  action?: { label: string; to?: string; recurring?: Record<string, unknown> };
}

const r = (p: number) => `₹${Math.round(Math.abs(p) / 100).toLocaleString('en-IN')}`;
const pctTxt = (x: number) => `${Math.round(x * 100)}%`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (d: string) => `${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;

export async function insights(sql: Sql, bookId: string, monthStartDay: number, today = todayIST()): Promise<Insight[]> {
  const out: Insight[] = [];
  const ranges = resolvePeriod('month', today, monthStartDay);
  const month = ranges.current;
  const totalDays = daysIn(month);
  const elapsed = daysIn({ from: month.from, to: addDays(today, 1) });
  const [sum, prevSum, cats, tr] = await Promise.all([
    summary(sql, bookId, month, today),
    ranges.previous ? summary(sql, bookId, ranges.previous, today) : null,
    byCategory(sql, bookId, 'month', ranges),
    trend(sql, bookId, 'month', month, monthStartDay, 4),
  ]);
  const past = tr.slice(0, -1).filter((t) => t.total > 0);
  const usual = past.length ? past.reduce((s, t) => s + t.total, 0) / past.length : 0;

  // 1. Pace for the month
  if (elapsed >= 5 && usual > 0 && sum.spent > 0) {
    const projected = Math.round((sum.spent / elapsed) * totalDays);
    if (projected > usual * 1.15) {
      out.push({ id: 'pace-high', tone: 'warn', icon: '📈', title: `On pace to spend ${r(projected)} this month`,
        body: `That's ${r(projected - usual)} more than your usual ${r(usual)} (average of the last ${past.length} months), based on ${r(sum.spent)} in ${elapsed} days.`,
        action: { label: 'See categories', to: '/stats' } });
    } else if (projected < usual * 0.9) {
      out.push({ id: 'pace-low', tone: 'good', icon: '🌱', title: `Spending is ${pctTxt(1 - projected / usual)} below usual`,
        body: `At this pace you'll spend about ${r(projected)} this month, against your usual ${r(usual)}.` });
    }
  }

  // 2. Categories running hot vs the same point last month
  for (const c of cats) {
    if (c.previous === null || c.previous <= 0) continue;
    const diff = c.amount - c.previous;
    if (c.amount > c.previous * 1.5 && diff >= 1500_00) {
      out.push({ id: `cat-${c.id}`, tone: 'warn', icon: c.icon ?? '•', title: `${c.name} is up ${r(diff)}`,
        body: `${r(c.amount)} so far vs ${r(c.previous)} by this point last month${c.avg3 ? ` (usual month: ${r(c.avg3)})` : ''}.`,
        action: { label: 'See where', to: `/stats?category=${c.id}` } });
    }
  }

  // 3. Budget pace
  for (const c of cats) {
    if (c.budget === null) continue;
    if (c.amount > c.budget) {
      out.push({ id: `budget-over-${c.id}`, tone: 'warn', icon: '🚨', title: `${c.name} is ${r(c.amount - c.budget)} over budget`,
        body: `${r(c.amount)} spent against a budget of ${r(c.budget)}.`, action: { label: 'Details', to: `/stats?category=${c.id}` } });
    } else if (elapsed >= 3 && c.amount > 0) {
      const perDay = c.amount / elapsed;
      const projected = perDay * totalDays;
      if (projected > c.budget * 1.05) {
        const crossOn = addDays(month.from, Math.floor(c.budget / perDay));
        out.push({ id: `budget-pace-${c.id}`, tone: 'warn', icon: c.icon ?? '•', title: `${c.name} budget runs out around ${dayLabel(crossOn)}`,
          body: (() => {
            const daysLeft = Math.max(totalDays - elapsed, 1), left = c.budget - c.amount, perDayLeft = left / daysLeft;
            return perDayLeft < 50_00
              ? `${r(c.amount)} of ${r(c.budget)} used. Only ${r(left)} left for the remaining ${daysLeft} days.`
              : `${r(c.amount)} of ${r(c.budget)} used with ${daysLeft} days to go. Keeping to ${r(perDayLeft)}/day stays within budget.`;
          })() });
      }
    }
  }

  // 4. Subscriptions that aren't tracked as recurring yet
  const subs = await sql<{ merchant: string; months: number; amounts: number[]; days: number[]; category_id: string; account_id: string }[]>`
    with e as (
      select lower(t.merchant) as m, max(t.merchant) as merchant, date_trunc('month', t.occurred_on) as mon,
             sum(p.amount)::bigint as amt, min(extract(day from t.occurred_on))::int as day,
             (array_agg(p.account_id order by t.occurred_on desc))[1] as category_id,
             (array_agg((select p2.account_id from posting p2 join account a2 on a2.id = p2.account_id
                          where p2.txn_id = t.id and a2.class in ('asset','liability') and p2.amount < 0 limit 1) order by t.occurred_on desc))[1] as account_id
      from txn t join posting p on p.txn_id = t.id join account c on c.id = p.account_id
      where t.book_id = ${bookId} and t.status = 'posted' and c.class = 'expense' and t.merchant is not null
        and t.recurring_id is null and t.occurred_on >= ${addDays(month.from, -125)}
      group by 1, 3
    )
    select max(merchant) as merchant, count(*)::int as months, array_agg(amt order by mon) as amounts, array_agg(day order by mon) as days,
           (array_agg(category_id order by mon desc))[1] as category_id, (array_agg(account_id order by mon desc))[1] as account_id
    from e group by m having count(*) >= 3`;
  const rules = await sql<{ k: string; category_id: string | null; amount: number }[]>`
    select lower(coalesce(merchant, name)) as k, category_id, amount from recurring_rule where book_id = ${bookId} and is_active`;
  const tracked = new Set(rules.map((x) => x.k));
  // Also "tracked" if a rule has the same category and a similar amount (e.g. rule "Rent" vs merchant "Landlord").
  const coveredByRule = (categoryId: string, amount: number) =>
    rules.some((r) => r.category_id === categoryId && Math.abs(Number(r.amount) - amount) <= Number(r.amount) * 0.15);
  const regular = new Set(subs.map((x) => x.merchant.toLowerCase()));
  for (const s of subs) {
    const amts = s.amounts.map(Number).sort((a, b) => a - b);
    const median = amts[Math.floor(amts.length / 2)];
    const steady = amts.every((a) => Math.abs(a - median) <= median * 0.15);
    if (!steady || tracked.has(s.merchant.toLowerCase()) || coveredByRule(s.category_id, median) || median < 50_00) continue;
    const day = s.days.sort((a, b) => a - b)[Math.floor(s.days.length / 2)];
    out.push({ id: `sub-${s.merchant.toLowerCase()}`, tone: 'info', icon: '🔁', title: `${s.merchant} looks like a monthly bill`,
      body: `About ${r(median)} on or near the ${day}${['th', 'st', 'nd', 'rd'][day % 10 > 3 || Math.floor(day / 10) === 1 ? 0 : day % 10]} in ${s.months} of the last few months. Track it so safe-to-spend sets it aside.`,
      action: { label: 'Track as recurring', recurring: { name: s.merchant, merchant: s.merchant, kind: 'expense', amount: median, day, categoryId: s.category_id, accountId: s.account_id, cadence: 'monthly' } } });
  }

  // 5. Savings rate
  if (sum.savingsRate !== null && prevSum?.savingsRate !== null && prevSum) {
    if (sum.savingsRate >= 0.3) {
      out.push({ id: 'savings-good', tone: 'good', icon: '💪', title: `You've kept ${pctTxt(sum.savingsRate)} of what you earned`,
        body: `${r(sum.earned)} in, ${r(sum.spent)} spent so far this month.` });
    } else if (sum.savingsRate < 0.1 && elapsed > 10) {
      out.push({ id: 'savings-low', tone: 'warn', icon: '⚠️', title: `Savings rate is ${pctTxt(Math.max(sum.savingsRate, 0))} this month`,
        body: `${r(sum.spent)} spent of ${r(sum.earned)} earned. Last month at this point: ${pctTxt(Math.max(prevSum.savingsRate ?? 0, 0))}.` });
    }
  }

  // 6. An unusually large single expense
  const [big] = await sql<{ id: string; title: string; amount: number; median: number }[]>`
    with x as (
      select t.id, coalesce(t.merchant, t.description, 'A purchase') as title, sum(p.amount)::bigint as amount, t.occurred_on
      from txn t join posting p on p.txn_id = t.id join account c on c.id = p.account_id
      where t.book_id = ${bookId} and t.status = 'posted' and c.class = 'expense' and t.occurred_on >= ${addDays(month.from, -90)}
      group by t.id)
    select id, title, amount, (select percentile_cont(0.5) within group (order by amount) from x)::bigint as median
    from x where occurred_on >= ${month.from} order by amount desc limit 1`;
  if (big && !regular.has(big.title.toLowerCase()) && big.median > 0 && big.amount >= big.median * 8 && big.amount >= 2000_00 && sum.spent > 0) {
    out.push({ id: `big-${big.id}`, tone: 'info', icon: '🧾', title: `${big.title} was ${pctTxt(big.amount / sum.spent)} of this month's spending`,
      body: `${r(big.amount)} in one go. Your typical transaction is around ${r(big.median)}.` });
  }

  // 7. People who owe you, quiet for a while
  const owed = await sql<{ name: string; balance: number; last: string }[]>`
    select a.name, sum(p.amount)::bigint as balance, max(t.occurred_on)::text as last
    from account a join posting p on p.account_id = a.id join txn t on t.id = p.txn_id and t.status = 'posted'
    where a.book_id = ${bookId} and a.kind = 'receivable' and not a.is_archived
    group by a.id, a.name having sum(p.amount) >= 500_00 and max(t.occurred_on) < ${addDays(today, -30)}
    order by balance desc limit 3`;
  for (const o of owed) {
    out.push({ id: `owed-${o.name}`, tone: 'info', icon: '🤝', title: `${o.name} owes you ${r(o.balance)}`,
      body: `Nothing has moved since ${dayLabel(o.last)}. A gentle reminder might help.`, action: { label: 'People', to: '/stats?view=people' } });
  }

  // 8. Idle cash
  if (usual > 0) {
    const nw = await netWorth(sql, bookId);
    const cash = nw.accounts.filter((a) => a.kind === 'bank').reduce((s, a) => s + a.balance, 0);
    if (cash > usual * 6 && cash > 1_00_000_00) {
      out.push({ id: 'idle-cash', tone: 'info', icon: '🏦', title: `${r(cash)} is sitting in savings accounts`,
        body: `That's about ${Math.floor(cash / usual)} months of your spending. Beyond an emergency fund (typically 3–6 months), the rest could earn more in an FD, a liquid fund or your SIPs.` });
    }
  }

  // 9. Weekends
  const [wk] = await sql<{ weekend: number; weekday: number }[]>`
    select coalesce(sum(p.amount) filter (where extract(isodow from t.occurred_on) >= 6), 0)::bigint as weekend,
           coalesce(sum(p.amount) filter (where extract(isodow from t.occurred_on) < 6), 0)::bigint as weekday
    from txn t join posting p on p.txn_id = t.id join account c on c.id = p.account_id
    where t.book_id = ${bookId} and t.status = 'posted' and c.class = 'expense' and t.kind <> 'opening'
      and t.occurred_on > ${addDays(today, -56)} and t.occurred_on <= ${today}`;
  if (wk && wk.weekday > 0) {
    const perWeekendDay = wk.weekend / 16, perWeekday = wk.weekday / 40;
    if (perWeekendDay > perWeekday * 2 && wk.weekend > 3000_00) {
      out.push({ id: 'weekends', tone: 'info', icon: '🎉', title: `Weekends cost ${(perWeekendDay / perWeekday).toFixed(1)}× a weekday`,
        body: `Over the last 8 weeks: about ${r(perWeekendDay)} per weekend day vs ${r(perWeekday)} on weekdays.` });
    }
  }

  // 10. "Other" doing too much work
  const other = cats.find((c) => c.name === 'Other');
  if (other && sum.spent > 0 && other.amount / sum.spent > 0.15 && other.amount > 2000_00) {
    out.push({ id: 'other', tone: 'info', icon: '🏷️', title: `${pctTxt(other.amount / sum.spent)} of spending is in "Other"`,
      body: 'Recategorising those makes the breakdown and budgets more useful.', action: { label: 'Review', to: `/stats?category=${other.id}` } });
  }

  const order = { warn: 0, info: 1, good: 2 };
  return out.sort((a, b) => order[a.tone] - order[b.tone]);
}

export { periodContaining };
