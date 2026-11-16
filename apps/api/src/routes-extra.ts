/** Routes for recurring rules, imports, CAS, Splitwise and insights. All require a session. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Sql } from './db.js';
import type { Cipher } from './crypto.js';
import { adjustBalance } from './ledger.js';
import * as recurring from './recurring.js';
import * as importer from './importer.js';
import * as cas from './cas.js';
import * as splitwise from './splitwise.js';
import { insights } from './insights.js';
import * as goals from './goals.js';
import { planner, healthScore } from './planner.js';
import * as copilot from './copilot.js';
import * as stuff from './stuff.js';
import * as debts from './debts.js';
import * as fds from './fds.js';
import * as fdRates from './fd-rates.js';
import * as salary from './salary.js';
import { todayIST } from './money.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function registerExtras(api: FastifyInstance, ctx: { sql: Sql; cipher: Cipher; fetch?: typeof fetch }) {
  const { sql, cipher } = ctx;
  const B = (req: FastifyRequest) => req.book!.id;
  const P = (req: FastifyRequest) => (req.params as any).id as string;

  // Recurring
  api.get('/api/recurring', async (req) => {
    await recurring.postAutoDue(sql, B(req));
    const [rules, sts] = await Promise.all([
      recurring.listRules(sql, B(req)),
      recurring.upcoming(sql, B(req), (await import('./money.js')).periodContaining('month', todayIST(), req.book!.month_start_day)),
    ]);
    return { rules, upcoming: sts };
  });
  api.post('/api/recurring', async (req) => ({ id: await recurring.createRule(sql, B(req), recurring.RuleInput.parse(req.body)) }));
  api.put('/api/recurring/:id', async (req) => {
    const body = req.body as any;
    await recurring.updateRule(sql, B(req), P(req), { ...recurring.RuleInput.parse(body), isActive: typeof body?.isActive === 'boolean' ? body.isActive : undefined });
    return { ok: true };
  });
  api.delete('/api/recurring/:id', async (req) => { await recurring.deleteRule(sql, B(req), P(req)); return { ok: true }; });
  api.post('/api/recurring/:id/log', async (req) => {
    const b = z.object({ amount: z.number().int().positive().optional(), date: date.optional() }).parse(req.body ?? {});
    return recurring.logDue(sql, B(req), P(req), b);
  });
  api.post('/api/recurring/:id/skip', async (req) => { await recurring.skipDue(sql, B(req), P(req)); return { ok: true }; });

  // Statement import
  api.post('/api/import/preview', async (req) => importer.preview(sql, B(req), importer.PreviewInput.parse(req.body)));
  api.post('/api/import/commit', async (req) => importer.commit(sql, B(req), importer.CommitInput.parse(req.body)));
  api.get('/api/import/batches', async (req) => importer.batches(sql, B(req)));
  api.post('/api/import/batches/:id/undo', async (req) => importer.undoBatch(sql, B(req), P(req)));
  api.post('/api/accounts/:id/reconcile', async (req) => {
    const b = z.object({ date, balance: z.number().int() }).parse(req.body);
    return { adjusted: await adjustBalance(sql, B(req), P(req), b.date, b.balance) };
  });

  // CAS
  api.post('/api/cas/import', async (req) => cas.importCas(sql, B(req), cas.CasInput.parse(req.body)));

  // Splitwise
  api.get('/api/splitwise', async (req) => ({ link: await splitwise.status(sql, B(req)) }));
  api.post('/api/splitwise/link', async (req) => splitwise.link(sql, cipher, B(req), splitwise.LinkInput.parse(req.body), ctx.fetch));
  api.put('/api/splitwise/account', async (req) => {
    const b = z.object({ accountId: z.string().uuid() }).parse(req.body);
    await splitwise.setDefaultAccount(sql, B(req), b.accountId);
    return { ok: true };
  });
  api.delete('/api/splitwise', async (req) => { await splitwise.unlink(sql, B(req)); return { ok: true }; });
  api.get('/api/splitwise/preview', async (req) => {
    const q = z.object({ since: date.optional() }).parse(req.query);
    return splitwise.plan(sql, cipher, B(req), q.since ?? null, ctx.fetch);
  });
  api.post('/api/splitwise/import', async (req) => {
    const b = z.object({ since: date.optional().nullable(), skip: z.array(z.number().int()).max(5000).optional() }).parse(req.body);
    return splitwise.importPlan(sql, cipher, B(req), { since: b.since ?? null, skip: b.skip }, ctx.fetch);
  });

  api.post('/api/splitwise/csv/preview', async (req) => splitwise.planCsv(sql, B(req), splitwise.CsvInput.parse(req.body)));
  api.post('/api/splitwise/csv/import', async (req) => splitwise.importCsv(sql, B(req), splitwise.CsvInput.parse(req.body)));

  // Insights
  api.get('/api/insights', async (req) => insights(sql, B(req), req.book!.month_start_day));

  // Goals
  api.get('/api/goals', async (req) => goals.listGoals(sql, B(req)));
  api.post('/api/goals', async (req) => ({ id: await goals.createGoal(sql, B(req), goals.GoalInput.parse(req.body)) }));
  api.put('/api/goals/:id', async (req) => { await goals.updateGoal(sql, B(req), P(req), goals.GoalInput.parse(req.body)); return { ok: true }; });
  api.delete('/api/goals/:id', async (req) => { await goals.archiveGoal(sql, B(req), P(req)); return { ok: true }; });
  api.post('/api/goals/:id/boost', async (req) => goals.boost(sql, B(req), P(req), goals.BoostInput.parse(req.body)));
  api.get('/api/goals/:id/contributions', async (req) => goals.contributions(sql, B(req), P(req)));

  // Trans. screen: per-day and per-month income/expense
  api.get('/api/trans/month', async (req) => {
    const q = z.object({ anchor: date.optional() }).parse(req.query);
    const { periodContaining } = await import('./money.js');
    const range = periodContaining('month', q.anchor ?? todayIST(), req.book!.month_start_day);
    const days = await sql<{ day: string; income: number; expense: number }[]>`
      select t.occurred_on::text as day,
        coalesce(-sum(p.amount) filter (where counts_as_income(a)), 0)::bigint as income,
        coalesce(sum(p.amount) filter (where a.class = 'expense'), 0)::bigint as expense
      from txn t join posting p on p.txn_id = t.id join account a on a.id = p.account_id
      where t.book_id = ${B(req)} and t.status = 'posted' and t.kind <> 'opening'
        and t.occurred_on >= ${range.from} and t.occurred_on < ${range.to}
      group by 1 order by 1`;
    const income = days.reduce((s, d) => s + Number(d.income), 0), expense = days.reduce((s, d) => s + Number(d.expense), 0);
    return { range, income, expense, total: income - expense, days };
  });
  api.get('/api/trans/year', async (req) => {
    const q = z.object({ year: z.coerce.number().int().min(2000).max(2100) }).parse(req.query);
    const { periodContaining, shiftPeriod } = await import('./money.js');
    const msd = req.book!.month_start_day;
    const first = periodContaining('month', `${q.year}-01-${String(msd).padStart(2, '0')}`, msd);
    const months = Array.from({ length: 12 }, (_, i) => shiftPeriod('month', first, i, msd));
    const rows = await sql<{ idx: number; income: number; expense: number }[]>`
      select r.idx::int as idx,
        coalesce(-sum(p.amount) filter (where counts_as_income(a)), 0)::bigint as income,
        coalesce(sum(p.amount) filter (where a.class = 'expense'), 0)::bigint as expense
      from unnest(${months.map((m) => m.from)}::date[], ${months.map((m) => m.to)}::date[]) with ordinality as r(f, t, idx)
      left join txn x on x.book_id = ${B(req)} and x.status = 'posted' and x.kind <> 'opening' and x.occurred_on >= r.f and x.occurred_on < r.t
      left join posting p on p.txn_id = x.id
      left join account a on a.id = p.account_id
      group by r.idx order by r.idx`;
    return months.map((m, i) => ({ ...m, income: Number(rows[i]?.income ?? 0), expense: Number(rows[i]?.expense ?? 0) }));
  });

  // Stuff (own / want / asked / dropped / sold)
  api.get('/api/stuff', async (req) => stuff.list(sql, B(req), (req.query as any)?.list));
  api.post('/api/stuff', async (req) => ({ id: await stuff.create(sql, B(req), stuff.ItemInput.parse(req.body)) }));
  api.put('/api/stuff/:id', async (req) => { await stuff.update(sql, B(req), P(req), stuff.ItemInput.parse(req.body)); return { ok: true }; });
  api.delete('/api/stuff/:id', async (req) => { await stuff.remove(sql, B(req), P(req)); return { ok: true }; });
  api.post('/api/stuff/import', async (req) => {
    const b = z.object({ items: z.array(stuff.ItemInput).max(2000) }).parse(req.body);
    return stuff.importItems(sql, B(req), b.items);
  });
  api.get('/api/stuff/snapshot', async () => ({ available: stuff.hasSnapshot() }));
  api.post('/api/stuff/import-sheet', async (req) => stuff.importItems(sql, B(req), stuff.sheetSnapshot().map((i) => stuff.ItemInput.parse(i))));
  api.post('/api/stuff/purchase', async (req) => stuff.purchase(sql, B(req), stuff.PurchaseInput.parse(req.body)));
  api.post('/api/stuff/sell', async (req) => stuff.sell(sql, B(req), stuff.SaleInput.parse(req.body)));
  api.get('/api/stuff/export', async (req) => stuff.exportAll(sql, B(req)));

  // People balances from a Splitwise screenshot: set each person's balance to match.
  api.post('/api/people/balances', async (req) => {
    const b = z.object({
      date: date.optional(),
      balances: z.array(z.object({ name: z.string().trim().min(1).max(60), amount: z.number().int().min(-1e12).max(1e12) })).min(1).max(200),
    }).parse(req.body);
    const day = b.date ?? todayIST();
    const people = await sql<{ id: string; name: string }[]>`select id, name from account where book_id = ${B(req)} and kind = 'receivable' and not is_archived`;
    const out: { name: string; accountName: string; created: boolean; adjusted: number; balance: number }[] = [];
    for (const p of b.balances) {
      const n = p.name.toLowerCase(), first = n.split(' ')[0];
      let acc = people.find((x) => x.name.toLowerCase() === n)
        ?? people.find((x) => x.name.toLowerCase().split(' ')[0] === first && (x.name.split(' ').length === 1 || n.split(' ').length === 1));
      let created = false;
      if (!acc) {
        const [row] = await sql<{ id: string }[]>`
          insert into account (book_id, class, kind, name, icon, meta) values (${B(req)}, 'asset', 'receivable', ${p.name.slice(0, 60)}, '🧑', ${sql.json({ source: 'splitwise-screenshot' })})
          returning id`;
        acc = { id: row.id, name: p.name };
        people.push(acc);
        created = true;
      }
      const adjusted = await adjustBalance(sql, B(req), acc.id, day, p.amount, 'splitwise');
      out.push({ name: p.name, accountName: acc.name, created, adjusted, balance: p.amount });
    }
    return { date: day, people: out };
  });

  // Owe & owed: people, Splitwise total, lent, loans
  api.get('/api/debts', async (req) => debts.listDebts(sql, B(req)));
  api.post('/api/debts', async (req) => debts.setDebt(sql, B(req), debts.DebtInput.parse(req.body)));
  api.post('/api/loans', async (req) => debts.createLoan(sql, B(req), debts.LoanInput.parse(req.body)));
  api.put('/api/loans/:id', async (req) => debts.updateLoan(sql, B(req), (req.params as any).id, debts.LoanInput.parse(req.body)));
  // Salary, payslips, and money-in review
  api.get('/api/salary', async (req) => salary.getSalary(sql, B(req)));
  api.put('/api/salary', async (req) => salary.saveSalary(sql, B(req), salary.SalaryInput.parse(req.body)));
  api.put('/api/salary/slips/:month', async (req) => salary.saveSlip(sql, B(req), (req.params as any).month, salary.SlipInput.parse(req.body)));
  api.delete('/api/salary/slips/:month', async (req) => { await salary.deleteSlip(sql, B(req), (req.params as any).month); return { ok: true }; });
  api.get('/api/money-in', async (req) => salary.moneyIn(sql, B(req)));
  api.post('/api/money-in/reclassify', async (req) => salary.reclassify(sql, B(req), salary.ReclassInput.parse(req.body)));
  // Fixed deposits, grouped by bank
  api.get('/api/fds', async (req) => fds.listFds(sql, B(req)));
  api.post('/api/fds', async (req) => fds.createFd(sql, B(req), fds.FdInput.parse(req.body)));
  api.get('/api/fds/rates', async () => fdRates.getRates(ctx.fetch ?? fetch));
  api.patch('/api/fds/:id', async (req) => fds.updateFd(sql, B(req), P(req), fds.FdPatch.parse(req.body)));
  api.post('/api/fds/:id/mature', async (req) => fds.matureFd(sql, B(req), (req.params as any).id, fds.MatureInput.parse(req.body)));

  // Budget planner + financial health
  api.get('/api/planner', async (req) => planner(sql, B(req), req.book!.month_start_day));
  api.get('/api/health-score', async (req) => healthScore(sql, B(req), req.book!.month_start_day));

  // Copilot
  api.get('/api/copilot', async () => ({ engine: copilot.copilotMode() }));
  api.post('/api/copilot', async (req) => {
    const b = z.object({
      question: z.string().trim().min(1).max(1000),
      history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) })).max(20).optional(),
    }).parse(req.body);
    return copilot.answer(sql, B(req), req.book!.month_start_day, b.question, b.history ?? []);
  });
}
