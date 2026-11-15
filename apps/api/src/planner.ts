/**
 * Budget Planner numbers (income / planned / remaining / budget used, with 6-month series)
 * and the Financial Health score.
 */
import type { Sql } from './db.js';
import { summary, byCategory, resolvePeriod, trend } from './stats.js';
import { addDays, daysIn, todayIST, shiftPeriod } from './money.js';
import { netWorth } from './dashboard.js';
import { listRules, upcoming } from './recurring.js';
import { listGoals } from './goals.js';

async function incomeSeries(sql: Sql, bookId: string, ranges: { from: string; to: string }[]) {
  const rows = await sql<{ idx: number; total: number }[]>`
    select r.idx::int as idx, coalesce(-sum(p.amount), 0)::bigint as total
    from unnest(${ranges.map((x) => x.from)}::date[], ${ranges.map((x) => x.to)}::date[]) with ordinality as r(f, t, idx)
    left join txn x on x.book_id = ${bookId} and x.status = 'posted' and x.occurred_on >= r.f and x.occurred_on < r.t
    left join posting p on p.txn_id = x.id and p.account_id in (select id from account ia where ia.book_id = ${bookId} and counts_as_income(ia))
    group by r.idx order by r.idx`;
  return ranges.map((_, i) => Number(rows[i]?.total ?? 0));
}

export async function planner(sql: Sql, bookId: string, monthStartDay: number, today = todayIST()) {
  const ranges = resolvePeriod('month', today, monthStartDay);
  const month = ranges.current;
  const months = Array.from({ length: 6 }, (_, i) => shiftPeriod('month', month, i - 5, monthStartDay));
  const [sum, prev, cats, spentTrend, incomeTrend, rules, bills] = await Promise.all([
    summary(sql, bookId, month, today),
    ranges.previous ? summary(sql, bookId, ranges.previous, today) : null,
    byCategory(sql, bookId, 'month', ranges),
    trend(sql, bookId, 'month', month, monthStartDay, 6),
    incomeSeries(sql, bookId, months),
    listRules(sql, bookId),
    upcoming(sql, bookId, month, today),
  ]);
  const budgeted = cats.filter((c) => c.budget !== null);
  const budgetTotal = budgeted.reduce((s, c) => s + (c.budget ?? 0), 0);
  const spentInBudgets = budgeted.reduce((s, c) => s + Math.max(c.amount, 0), 0);
  // Planned = monthly budgets + fixed monthly outgoings (recurring bills/SIPs) that aren't inside a budgeted category.
  const budgetIds = new Set(budgeted.map((c) => c.id));
  const fixed = rules.filter((r) => r.is_active && r.kind !== 'income' && r.cadence === 'monthly' && !budgetIds.has(r.category_id))
    .reduce((s, r) => s + Number(r.amount), 0);
  const planned = budgetTotal + fixed;
  const income = sum.earned;
  const remaining = income - sum.spent;
  const totalDays = daysIn(month);
  const elapsed = daysIn({ from: month.from, to: addDays(today, 1) });
  const pct = (cur: number, base: number | null | undefined) => (base ? (cur - base) / Math.abs(base) : null);

  const categories = cats.map((c) => {
    const used = c.budget ? c.amount / c.budget : null;
    const projected = elapsed > 0 ? (c.amount / elapsed) * totalDays : c.amount;
    const status = c.budget === null ? null : c.amount > c.budget ? 'over' : projected > c.budget * 1.05 ? 'behind' : 'on_track';
    return { id: c.id, name: c.name, icon: c.icon, spent: c.amount, budget: c.budget, used, status, previous: c.previous, usual: c.avg3 };
  });

  return {
    month,
    income: { value: income, delta: pct(income, prev?.earned), series: incomeTrend },
    planned: { value: planned, budgets: budgetTotal, fixed, upcomingBills: bills.total },
    spent: { value: sum.spent, delta: pct(sum.spent, prev?.spent), series: spentTrend.map((t) => t.total) },
    remaining: { value: remaining, delta: prev ? pct(remaining, prev.earned - prev.spent) : null },
    budgetUsed: { value: budgetTotal ? spentInBudgets / budgetTotal : null, spent: spentInBudgets, budget: budgetTotal, monthElapsed: elapsed / totalDays },
    categories,
  };
}

// ---------------------------------------------------------------------------
export interface HealthPart { key: string; label: string; score: number; weight: number; detail: string; tip: string | null }

const clamp = (x: number) => Math.max(0, Math.min(100, Math.round(x)));

/**
 * Financial Health, 0–100. Six parts, each scored 0–100 and weighted:
 *   savings rate (25) · emergency fund (25) · budgets (15) · card debt (15) · spending trend (10) · goals (10)
 * Uses the last three full months where it needs a "typical month", so one odd week doesn't swing it.
 */
export async function healthScore(sql: Sql, bookId: string, monthStartDay: number, today = todayIST()) {
  const ranges = resolvePeriod('month', today, monthStartDay);
  const month = ranges.current;
  const last3 = [1, 2, 3].map((n) => shiftPeriod('month', month, -n, monthStartDay));
  const [hist, cur, nw, cats, goals] = await Promise.all([
    Promise.all(last3.map((r) => summary(sql, bookId, r, today))),
    summary(sql, bookId, month, today),
    netWorth(sql, bookId),
    byCategory(sql, bookId, 'month', ranges),
    listGoals(sql, bookId, today),
  ]);
  const withData = hist.filter((h) => h.spent > 0 || h.earned > 0);
  const avgSpend = withData.length ? withData.reduce((s, h) => s + h.spent, 0) / withData.length : cur.spent;
  const avgIncome = withData.length ? withData.reduce((s, h) => s + h.earned, 0) / withData.length : cur.earned;
  const r = (p: number) => `₹${Math.round(p / 100).toLocaleString('en-IN')}`;
  const parts: HealthPart[] = [];

  // 1. Savings rate
  const rate = avgIncome > 0 ? (avgIncome - avgSpend) / avgIncome : null;
  parts.push({
    key: 'savings', label: 'Savings rate', weight: 25,
    score: rate === null ? 50 : clamp(rate <= 0 ? 0 : 20 + (rate / 0.3) * 80),
    detail: rate === null ? 'No income logged yet' : `You keep ${Math.round(rate * 100)}% of what you earn`,
    tip: rate === null ? 'Log your salary so this can be measured.' : rate < 0.2 ? `Saving 20% means spending about ${r(avgIncome * 0.8)} a month.` : null,
  });

  // 2. Emergency fund
  const liquid = nw.accounts.filter((a) => ['bank', 'cash', 'wallet'].includes(a.kind)).reduce((s, a) => s + a.balance, 0);
  const months = avgSpend > 0 ? liquid / avgSpend : null;
  parts.push({
    key: 'buffer', label: 'Emergency fund', weight: 25,
    score: months === null ? 50 : clamp((months / 6) * 100),
    detail: months === null ? 'Not enough spending history yet' : `${months.toFixed(1)} months of spending in bank and cash`,
    tip: months !== null && months < 3 ? `Aim for 3–6 months: about ${r(avgSpend * 3)}–${r(avgSpend * 6)}.` : null,
  });

  // 3. Budgets
  const totalDays = daysIn(month), elapsed = daysIn({ from: month.from, to: addDays(today, 1) });
  const budgeted = cats.filter((c) => c.budget !== null);
  const ok = budgeted.filter((c) => (c.amount / Math.max(elapsed, 1)) * totalDays <= (c.budget ?? 0) * 1.05).length;
  parts.push({
    key: 'budgets', label: 'Budgets', weight: 15,
    score: budgeted.length ? clamp((ok / budgeted.length) * 100) : 50,
    detail: budgeted.length ? `${ok} of ${budgeted.length} budgets on track` : 'No budgets set',
    tip: budgeted.length ? (ok < budgeted.length ? 'Check the categories marked Behind in the Budget Planner.' : null) : 'Set a few budgets for your biggest categories.',
  });

  // 4. Debt: card dues against a month's income, and loan EMIs as a share of income (≤30% is the usual ceiling)
  const dues = nw.accounts.filter((a) => a.kind === 'credit_card').reduce((s, a) => s + Math.max(a.balance, 0), 0);
  const loans = nw.accounts.filter((a) => a.kind === 'loan' && a.balance > 0);
  const emi = loans.reduce((s, a: any) => s + Number(a.meta?.emi ?? 0), 0);
  const cardRatio = avgIncome > 0 ? dues / avgIncome : dues > 0 ? 1 : 0;
  const emiRatio = avgIncome > 0 ? emi / avgIncome : emi > 0 ? 1 : 0;
  const cardScore = clamp(100 - (cardRatio / 0.5) * 100);
  const emiScore = clamp(emiRatio <= 0.2 ? 100 : 100 - ((emiRatio - 0.2) / 0.3) * 100);
  parts.push({
    key: 'debt', label: 'Debt & EMIs', weight: 15,
    score: Math.min(cardScore, emiScore),
    detail: [dues ? `${r(dues)} on cards` : 'No card dues', emi ? `EMIs ${r(emi)}/month (${Math.round(emiRatio * 100)}% of income)` : null].filter(Boolean).join(' · '),
    tip: emiRatio > 0.3 ? 'EMIs above 30% of income squeeze savings; prepaying the costliest loan helps most.' : cardRatio > 0.3 ? 'Pay card bills in full to avoid 36–42% yearly interest.' : null,
  });

  // 5. Spending trend
  const projected = elapsed > 0 ? (cur.spent / elapsed) * totalDays : cur.spent;
  const over = avgSpend > 0 ? projected / avgSpend - 1 : 0;
  parts.push({
    key: 'trend', label: 'Spending trend', weight: 10,
    score: avgSpend > 0 ? clamp(100 - (Math.max(over, 0) / 0.3) * 100) : 50,
    detail: avgSpend > 0 ? (over > 0.02 ? `On pace for ${Math.round(over * 100)}% above your usual month` : 'At or below your usual month') : 'Not enough history yet',
    tip: over > 0.15 ? 'Stats shows which categories are running hot.' : null,
  });

  // 6. Goals
  const active = goals.filter((g) => !g.done);
  parts.push({
    key: 'goals', label: 'Goals', weight: 10,
    score: goals.length ? clamp(((goals.length - active.length + active.filter((g) => g.onTrack).length) / goals.length) * 100) : 50,
    detail: goals.length ? `${goals.filter((g) => g.onTrack).length} of ${goals.length} goals on track` : 'No savings goals yet',
    tip: goals.length ? null : 'Add a goal, such as an emergency fund or a trip.',
  });

  const score = Math.round(parts.reduce((s, p) => s + p.score * p.weight, 0) / parts.reduce((s, p) => s + p.weight, 0));
  const label = score >= 80 ? 'Excellent' : score >= 65 ? 'Good' : score >= 45 ? 'Fair' : 'Needs attention';
  const weakest = [...parts].filter((p) => p.tip).sort((a, b) => a.score - b.score)[0];
  return { score, label, parts, focus: weakest ? { label: weakest.label, tip: weakest.tip } : null };
}
