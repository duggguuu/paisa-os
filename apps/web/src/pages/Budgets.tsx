import { useQuery } from '@tanstack/react-query';
import { api, money, periodLabel } from '../lib';
import { OverviewBars } from '../components/Charts';
import { KpiCards, HealthCard, AiCard, QuickInsights, CategoryTable, usePlanner, useHealth } from '../components/Planner';
import type { Insight } from './Insights';

export function Budgets() {
  const p = usePlanner();
  const h = useHealth();
  const ins = useQuery({ queryKey: ['insights'], queryFn: () => api<Insight[]>('/api/insights') });
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api<any[]>('/api/categories') });
  if (!p.data) return <><h1 className="page-title">Budget Planner</h1><div className="card"><div className="skeleton" /></div></>;

  // Every top-level expense category, with this month's numbers where there are any.
  const byId = new Map(p.data.categories.map((c: any) => [c.id, c]));
  const rows = (cats.data ?? []).filter((c) => c.class === 'expense' && !c.parent_id).map((c) => byId.get(c.id) ?? {
    id: c.id, name: c.name, icon: c.icon, spent: 0, budget: null, used: null, status: null,
  }).sort((a: any, b: any) => (b.budget !== null ? 1 : 0) - (a.budget !== null ? 1 : 0) || b.spent - a.spent);
  const b = p.data.budgetUsed;

  return (
    <>
      <div className="page-kicker">Plan smarter. Spend better.</div>
      <h1 className="page-title">Budget Planner</h1>
      <div className="small muted" style={{ marginTop: -10 }}>{periodLabel('month', p.data.month.from, p.data.month.to)}</div>

      <KpiCards p={p.data} />

      <div className="section">
        <div className="section-title">Budget overview</div>
        <div className="card">
          {b.budget ? <OverviewBars spent={b.spent} budget={b.budget} /> : <p className="small muted" style={{ margin: 0 }}>Set budgets below to see spent vs budgeted.</p>}
          {b.budget > 0 && <p className="tiny faint" style={{ marginBottom: 0 }}>Budgeted categories only. {Math.round(b.monthElapsed * 100)}% of the month has gone; {Math.round((b.spent / b.budget) * 100)}% of the budget is used.</p>}
          {p.data.planned.fixed > 0 && <p className="tiny faint" style={{ marginBottom: 0 }}>Planned also includes {money(p.data.planned.fixed, { whole: true })} of fixed monthly bills and SIPs.</p>}
        </div>
      </div>

      <div className="section"><AiCard insights={ins.data} /></div>

      {(ins.data?.length ?? 0) > 0 && (
        <div className="section">
          <div className="section-title">Quick insights</div>
          <QuickInsights insights={ins.data!} />
        </div>
      )}

      <div className="section">
        <div className="section-title">Budget categories</div>
        <CategoryTable rows={rows} editable />
        <p className="tiny faint" style={{ margin: '8px 2px' }}>Type a monthly budget and tap away to save; clear it to remove. "Behind" means you're on pace to go over by month end.</p>
      </div>

      {h.data && <div className="section"><HealthCard h={h.data} expanded /></div>}
    </>
  );
}
