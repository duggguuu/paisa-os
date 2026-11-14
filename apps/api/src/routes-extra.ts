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
