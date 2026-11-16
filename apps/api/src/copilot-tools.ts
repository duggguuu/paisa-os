/**
 * Tools the Claude copilot can call. Every tool READS the book; none writes. To add something,
 * Claude calls `draft_transaction`, which only returns a draft: the app shows it as a card the
 * owner reviews and saves in the normal Add sheet. Amounts go to the model in whole rupees;
 * account numbers, secrets and raw ids beyond what a draft needs are never included.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { Sql } from './db.js';
import { accountBalances } from './ledger.js';
import { latestHoldings } from './kite.js';
import { listFds } from './fds.js';
import { listDebts } from './debts.js';
import { listRules } from './recurring.js';
import { getSalary } from './salary.js';
import { listGoals } from './goals.js';
import { todayIST, addDays } from './money.js';

const rs = (p: number | string | null | undefined) => (p == null ? null : Math.round(Number(p) / 100));
const DATE = { type: ['string', 'null'], description: 'YYYY-MM-DD, or null' } as const;

export interface Draft {
  kind: 'expense' | 'income';
  amount: number; // paise, signed (negative = money back / income reversed)
  categoryId: string; categoryName: string;
  accountId: string; accountName: string;
  date: string; merchant: string | null; note: string | null;
}

/** Tool definitions (strict: inputs always match the schema). Kept in a fixed order for prompt caching. */
export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'find_transactions',
    description: 'Search individual transactions. Matches the text against merchant, description, note, category and parent-category names. Use for "when did I last pay X", "show my Swiggy orders", "biggest purchases in March". Returns up to `limit` rows (newest first, or largest first) plus the count and total of ALL matches.',
    strict: true,
    input_schema: {
      type: 'object', additionalProperties: false,
      required: ['text', 'from', 'to', 'kind', 'min_rupees', 'max_rupees', 'sort', 'limit'],
      properties: {
        text: { type: ['string', 'null'], description: 'Words to match, or null for all' },
        from: { ...DATE, description: 'First day included (YYYY-MM-DD) or null' },
        to: { ...DATE, description: 'Last day included (YYYY-MM-DD) or null' },
        kind: { type: ['string', 'null'], enum: ['expense', 'income', 'transfer', null] },
        min_rupees: { type: ['number', 'null'] },
        max_rupees: { type: ['number', 'null'] },
        sort: { type: 'string', enum: ['newest', 'largest'] },
        limit: { type: 'integer', description: '1-50' },
      },
    },
  },
  {
    name: 'spending_breakdown',
    description: 'Totals for any date range, grouped by category, subcategory, merchant, paying account or month. Use for comparisons between any two periods (call it twice), trends over months, and "how much did I spend on X". kind=income gives earnings by income category (only real income; repayments/refunds are excluded).',
    strict: true,
    input_schema: {
      type: 'object', additionalProperties: false,
      required: ['from', 'to', 'group_by', 'kind', 'category'],
      properties: {
        from: { type: 'string', description: 'First day included, YYYY-MM-DD' },
        to: { type: 'string', description: 'Last day included, YYYY-MM-DD' },
        group_by: { type: 'string', enum: ['category', 'subcategory', 'merchant', 'account', 'month'] },
        kind: { type: 'string', enum: ['expense', 'income'] },
        category: { type: ['string', 'null'], description: 'Limit to one category (name, includes its subcategories), or null' },
      },
    },
  },
  {
    name: 'accounts',
    description: 'Current balance of every bank, cash, wallet, credit card, investment, FD, loan and person account (people: positive = they owe me).',
    strict: true,
    input_schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  },
  {
    name: 'investments',
    description: 'Stock/ETF/mutual-fund holdings from the last Zerodha sync (quantity, average price, last price, value, gain) and fixed deposits (principal, rate, value today, value at maturity, maturity date).',
    strict: true,
    input_schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  },
  {
    name: 'debts_and_loans',
    description: 'Loans (outstanding, rate, EMI, next EMI, payoff), money people owe me, money I owe, and money I lent.',
    strict: true,
    input_schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  },
  {
    name: 'bills_and_subscriptions',
    description: 'Every recurring rule: bills, SIPs, EMIs, salary, subscriptions and auto-debit mandates (UPI AutoPay, e-NACH, card auto-pay) with amount, frequency, next due date and whether it is active.',
    strict: true,
    input_schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  },
  {
    name: 'salary_and_tax',
    description: 'Salary structure (monthly earnings, deductions, employer contributions, take-home), payslips saved this financial year with TDS, and salary actually received this FY.',
    strict: true,
    input_schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  },
  {
    name: 'goals',
    description: 'Savings goals with saved amount, target, target date, pace and projected finish.',
    strict: true,
    input_schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  },
  {
    name: 'draft_transaction',
    description: 'Prepare an expense or income entry for the owner to review. It is NOT saved: the app shows it as a card with a "Review & add" button. Use when the owner asks you to add/log/record something. Category and account are matched by name; if a name is ambiguous, ask instead of guessing. A negative amount means money back (expense) or income reversed.',
    strict: true,
    input_schema: {
      type: 'object', additionalProperties: false,
      required: ['kind', 'amount_rupees', 'category', 'account', 'date', 'merchant', 'note'],
      properties: {
        kind: { type: 'string', enum: ['expense', 'income'] },
        amount_rupees: { type: 'number' },
        category: { type: 'string', description: 'Category or subcategory name, e.g. "Groceries" or "Food › Groceries"' },
        account: { type: ['string', 'null'], description: 'Paying/receiving account name, or null for the usual bank account' },
        date: { ...DATE, description: 'YYYY-MM-DD, or null for today' },
        merchant: { type: ['string', 'null'] },
        note: { type: ['string', 'null'] },
      },
    },
  },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Run one tool. Returns JSON-serialisable data; drafts are pushed to `drafts`. */
export async function runTool(sql: Sql, bookId: string, name: string, input: any, drafts: Draft[]): Promise<unknown> {
  const today = todayIST();
  switch (name) {
    case 'find_transactions': {
      const limit = Math.max(1, Math.min(50, Math.round(input.limit ?? 20)));
      const like = input.text ? `%${String(input.text).trim()}%` : null;
      const rows = await sql<any[]>`
        with t as (
          select t.id, t.kind, t.occurred_on::text as date, t.merchant, t.description, t.note,
                 (select sum(abs(p.amount)) / 2 from posting p where p.txn_id = t.id)::bigint as amount,
                 (select string_agg(coalesce(pc.name || ' › ', '') || c.name, ', ') from posting p join account c on c.id = p.account_id left join account pc on pc.id = c.parent_id
                   where p.txn_id = t.id and c.kind = 'category') as category,
                 (select string_agg(a.name, ' → ' order by p.amount) from posting p join account a on a.id = p.account_id where p.txn_id = t.id and a.kind <> 'category' and a.kind <> 'equity') as accounts,
                 (select sum(p.amount) from posting p join account c on c.id = p.account_id where p.txn_id = t.id and c.class = 'expense')::bigint as spend
          from txn t
          where t.book_id = ${bookId} and t.status = 'posted' and t.kind not in ('opening', 'adjustment')
            ${input.from ? sql`and t.occurred_on >= ${input.from}` : sql``}
            ${input.to ? sql`and t.occurred_on <= ${input.to}` : sql``}
            ${input.kind ? sql`and t.kind = ${input.kind}` : sql``}
        )
        select * from t
        where true
          ${like ? sql`and (t.merchant ilike ${like} or t.description ilike ${like} or t.note ilike ${like} or t.category ilike ${like})` : sql``}
          ${input.min_rupees != null ? sql`and t.amount >= ${Math.round(input.min_rupees * 100)}` : sql``}
          ${input.max_rupees != null ? sql`and t.amount <= ${Math.round(input.max_rupees * 100)}` : sql``}
        order by ${input.sort === 'largest' ? sql`t.amount desc` : sql`t.date desc`}`;
      return {
        matches: rows.length,
        total_rupees: rs(rows.reduce((s, r) => s + Number(r.amount), 0)),
        spending_rupees: rs(rows.reduce((s, r) => s + Number(r.spend ?? 0), 0)),
        rows: rows.slice(0, limit).map((r) => ({ date: r.date, kind: r.kind, rupees: rs(r.amount), spent_rupees: r.spend == null ? null : rs(r.spend), merchant: r.merchant ?? r.description, category: r.category, accounts: r.accounts, note: r.note })),
      };
    }
    case 'spending_breakdown': {
      const from = input.from, toEx = addDays(input.to, 1);
      const cls = input.kind === 'income' ? 'income' : 'expense';
      const sign = cls === 'income' ? -1 : 1;
      const cat = input.category ? `%${String(input.category).trim()}%` : null;
      const key = {
        category: sql`coalesce(pc.name, c.name)`,
        subcategory: sql`coalesce(pc.name || ' › ', '') || c.name`,
        merchant: sql`coalesce(nullif(t.merchant, ''), nullif(t.description, ''), 'Unnamed')`,
        account: sql`(select string_agg(a.name, ', ') from posting q join account a on a.id = q.account_id where q.txn_id = t.id and a.kind <> 'category' and a.kind <> 'equity')`,
        month: sql`to_char(t.occurred_on, 'YYYY-MM')`,
      }[input.group_by as 'category'] ?? sql`c.name`;
      const rows = await sql<{ name: string; amount: number; count: number }[]>`
        select ${key} as name, sum(p.amount)::bigint * ${sign} as amount, count(distinct t.id)::int as count
        from txn t join posting p on p.txn_id = t.id join account c on c.id = p.account_id left join account pc on pc.id = c.parent_id
        where t.book_id = ${bookId} and t.status = 'posted' and c.class = ${cls}
          and t.occurred_on >= ${from} and t.occurred_on < ${toEx}
          ${cls === 'income' ? sql`and counts_as_income(c.id)` : sql``}
          ${cat ? sql`and (c.name ilike ${cat} or pc.name ilike ${cat})` : sql``}
        group by 1 having sum(p.amount) <> 0
        order by ${input.group_by === 'month' ? sql`1` : sql`2 desc`} limit 60`;
      return { from, to: input.to, kind: cls, total_rupees: rs(rows.reduce((s, r) => s + Number(r.amount), 0)), groups: rows.map((r) => ({ name: r.name, rupees: rs(r.amount), transactions: r.count })) };
    }
    case 'accounts': {
      const all = await accountBalances(sql, bookId);
      return all.filter((a) => a.class !== 'expense' && a.class !== 'income' && a.kind !== 'equity' && !a.is_archived)
        .map((a) => ({ name: a.name, type: a.kind, institution: a.institution, balance_rupees: rs(a.balance) }));
    }
    case 'investments': {
      const [h, fds] = await Promise.all([latestHoldings(sql, bookId), listFds(sql, bookId, today)]);
      return {
        holdings_synced_at: h[0]?.taken_at ?? null,
        holdings: h.map((x) => ({ name: x.instrument, type: x.asset_type, quantity: x.quantity, avg_price: x.avg_price, last_price: x.last_price, value_rupees: rs(x.value_paise), invested_rupees: rs(x.cost_paise), gain_rupees: rs(Number(x.value_paise) - Number(x.cost_paise)), gain_pct: Number(x.cost_paise) ? Math.round(((Number(x.value_paise) - Number(x.cost_paise)) / Number(x.cost_paise)) * 1000) / 10 : null })),
        fixed_deposits: fds.banks.flatMap((b) => b.items).map((f) => ({ name: f.name, bank: f.bank, principal_rupees: rs(f.principal), rate_pct: f.rate, start: f.start, maturity: f.maturity, value_today_rupees: rs(f.valueNow), at_maturity_rupees: rs(f.atMaturity), matured: f.matured })),
        fd_totals_rupees: { principal: rs(fds.totals.principal), value_today: rs(fds.totals.valueNow), at_maturity: rs(fds.totals.atMaturity) },
      };
    }
    case 'debts_and_loans': {
      const d = await listDebts(sql, bookId);
      const p = (xs: any[]) => xs.map((x) => ({ name: x.name, rupees: rs(x.balance), note: x.note }));
      return {
        loans: d.loans.map((l: any) => ({ name: l.name, lender: l.lender, type: l.type === 'interest_only' ? 'interest-only' : 'EMI', outstanding_rupees: rs(l.outstanding), rate_pct: l.rate, emi_rupees: rs(l.emi), next_emi: l.nextEmi, end_date: l.endDate, months_left: l.monthsLeft ?? null, payoff: l.payoff ?? null, interest_left_rupees: rs(l.interestLeft ?? null) })),
        owed_to_me: p(d.owed), i_owe: p(d.iowe), i_lent: p(d.lent),
        totals_rupees: { owed_to_me: rs(d.totals.owed), i_owe: rs(d.totals.iowe), lent: rs(d.totals.lent), loans: rs(d.totals.loans), monthly_emi: rs(d.totals.emi) },
      };
    }
    case 'bills_and_subscriptions': {
      const rules = await listRules(sql, bookId);
      return rules.map((r) => ({
        name: r.name, kind: r.kind, rupees: rs(r.amount), frequency: r.every > 1 ? `every ${r.every} × ${r.cadence}` : r.cadence,
        next_due: r.next_due, active: r.is_active, auto_logged: r.auto_post, account: r.account_name, category: r.category_name, to_account: r.to_account_name,
        mandate: r.mandate ? { type: r.mandate.type, provider: r.mandate.provider ?? null, max_rupees: rs(r.mandate.maxAmount ?? null) } : null,
        last_logged: r.last_logged,
      }));
    }
    case 'salary_and_tax': {
      const s: any = await getSalary(sql, bookId, today);
      const lines = (xs: any[] | undefined) => (xs ?? []).map((l: any) => ({ name: l.name, monthly_rupees: rs(l.monthly) }));
      const p = s.profile;
      return {
        financial_year: s.fy,
        structure: p ? { employer: p.employer, earnings: lines(p.earnings), deductions: lines(p.deductions), employer_contributions: lines(p.employerContrib), gross_monthly_rupees: rs(p.gross), take_home_monthly_rupees: rs(p.net), pay_day: p.payDay, yearly_bonus_rupees: rs(p.annualBonus) } : null,
        payslips: s.slips.map((x: any) => ({ month: x.month, gross_rupees: rs(x.gross), net_rupees: rs(x.net), tds_rupees: rs(x.tds) })),
        received_this_fy_rupees: rs(s.receivedThisFy.total),
      };
    }
    case 'goals': {
      const g = await listGoals(sql, bookId, today);
      return g.map((x) => ({ name: x.name, saved_rupees: rs(x.saved), target_rupees: rs(x.target), target_date: x.targetDate, pace_per_month_rupees: rs(x.pacePerMonth), projected_finish: x.reachOn, needed_per_month_rupees: rs(x.neededPerMonth), done: x.done }));
    }
    case 'draft_transaction': {
      const all = await accountBalances(sql, bookId);
      const cls = input.kind === 'income' ? 'income' : 'expense';
      const cats = all.filter((a) => a.class === cls && !a.is_archived);
      const parentName = (c: any) => cats.find((p) => p.id === c.parent_id)?.name ?? null;
      const want = norm(String(input.category).split('›').pop()!);
      const wantParent = String(input.category).includes('›') ? norm(String(input.category).split('›')[0]) : null;
      const matches = cats.filter((c) => norm(c.name) === want && (!wantParent || norm(parentName(c) ?? '') === wantParent));
      const loose = matches.length ? matches : cats.filter((c) => norm(c.name).includes(want) || want.includes(norm(c.name)));
      if (loose.length !== 1) return { error: loose.length ? 'ambiguous_category' : 'no_such_category', candidates: (loose.length ? loose : cats.filter((c) => !c.parent_id)).slice(0, 25).map((c) => (parentName(c) ? `${parentName(c)} › ${c.name}` : c.name)) };
      const cat = loose[0];
      const moneyAccs = all.filter((a) => ['bank', 'cash', 'wallet', 'credit_card'].includes(a.kind) && !a.is_archived);
      let acc = input.account ? moneyAccs.filter((a) => norm(a.name).includes(norm(input.account)) || norm(input.account).includes(norm(a.name))) : moneyAccs.filter((a) => a.kind === 'bank');
      if (!input.account && acc.length > 1) acc = [acc.sort((a, b) => Number(b.balance) - Number(a.balance))[0]];
      if (acc.length !== 1) return { error: acc.length ? 'ambiguous_account' : 'no_such_account', candidates: moneyAccs.map((a) => a.name) };
      const amount = Math.round(Number(input.amount_rupees) * 100);
      if (!amount) return { error: 'amount_is_zero' };
      const d: Draft = { kind: cls, amount, categoryId: cat.id, categoryName: parentName(cat) ? `${parentName(cat)} › ${cat.name}` : cat.name, accountId: acc[0].id, accountName: acc[0].name, date: input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : today, merchant: input.merchant ?? null, note: input.note ?? null };
      drafts.push(d);
      return { drafted: true, shown_to_owner_as_card: { ...d, categoryId: undefined, accountId: undefined, amount: undefined, rupees: rs(amount) }, saved: false };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}
