import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, money, periodLabel, addDays, todayIST } from '../lib';
import { TrendChart, PieLabeled, pieSlices } from '../components/Charts';
import { CategoryTable, usePlanner } from '../components/Planner';
import { TxnRow } from '../components/TxnRow';
import { Icon } from '../components/Icons';

type Period = 'week' | 'month' | 'year';
type Tab = 'stats' | 'budget' | 'note';
const P_SHORT: Record<Period, string> = { week: 'W', month: 'M', year: 'Y' };

/** A list row with a coloured % badge, like a classic money-manager breakdown. */
function ShareRow({ color, share, icon, name, amount, onClick }: { color: string; share: number; icon?: string | null; name: string; amount: number; onClick?: () => void }) {
  return (
    <button className="share-row" onClick={onClick} disabled={!onClick}>
      <span className="badge num" style={{ background: color }}>{Math.round(share * 100)}%</span>
      <span className="sname">{icon ? `${icon} ` : ''}{name}</span>
      <span className="num samt">{money(amount)}</span>
    </button>
  );
}

export function Stats() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const period = (params.get('period') as Period) || 'month';
  const anchor = params.get('anchor') || todayIST();
  const tab = (params.get('tab') as Tab) || 'stats';
  const side = params.get('side') === 'income' ? 'income' : 'expense';
  const categoryId = params.get('category');
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v === null ? next.delete(k) : next.set(k, v);
    setParams(next, { replace: true });
  };
  const q = useQuery({
    queryKey: ['stats', period, anchor, categoryId],
    queryFn: () => api<any>(`/api/stats?period=${period}&anchor=${anchor}${categoryId ? `&categoryId=${categoryId}` : ''}`),
    placeholderData: (prev) => prev,
  });
  const planner = usePlanner();
  const s = q.data;
  const today = todayIST();

  const rows = !s ? [] : side === 'income' && !categoryId ? s.incomeCategories : s.categories;
  const slices = pieSlices(rows.map((c: any) => ({ id: c.id, name: c.name, icon: c.icon, amount: c.amount })));
  const merchantSlices = s ? pieSlices(s.merchants.map((m: any) => ({ key: m.name, name: m.name, amount: m.amount }))) : [];

  return (
    <>
      <div className="stats-top">
        <div className="seg">
          {(['stats', 'budget', 'note'] as Tab[]).map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => set({ tab: t === 'stats' ? null : t, category: null })}>{t === 'stats' ? 'Stats' : t === 'budget' ? 'Budget' : 'Note'}</button>)}
        </div>
        <label className="period-pick">
          <select value={period} onChange={(e) => set({ period: e.target.value, anchor: null, category: null })} aria-label="Period">
            <option value="week">Weekly</option><option value="month">Monthly</option><option value="year">Yearly</option>
          </select>
          <span>{P_SHORT[period]}</span><Icon name="chevron" />
        </label>
      </div>

      <div className="month-nav">
        <button aria-label="Previous" onClick={() => s && set({ anchor: addDays(s.range.from, -1) })}><Icon name="back" /></button>
        <b>{s ? periodLabel(period, s.range.from, s.range.to) : '…'}</b>
        <button aria-label="Next" disabled={!s || s.range.to > today} onClick={() => s && set({ anchor: s.range.to })}><Icon name="chevron" /></button>
      </div>

      {tab !== 'budget' && s && (
        <div className="side-tabs">
          <button className={side === 'income' ? 'on' : ''} onClick={() => set({ side: 'income', category: null })}>Income <span className="num">{money(s.summary.earned)}</span></button>
          <button className={side === 'expense' ? 'on' : ''} onClick={() => set({ side: null })}>Exp. <span className="num">{money(s.summary.spent)}</span></button>
        </div>
      )}

      {!s ? <div className="card"><div className="skeleton" /></div> : tab === 'stats' ? (
        <>
          {categoryId && (
            <div className="spread" style={{ margin: '8px 0' }}>
              <button className="btn small" onClick={() => set({ category: null })}>‹ All categories</button>
              <span className="small muted num">{money(s.categories.reduce((t: number, r: any) => t + r.amount, 0))}</span>
            </div>
          )}
          {slices.length === 0 ? <div className="empty">No {side === 'income' ? 'income' : 'spending'} in this period.</div> : (
            <>
              <div className="card pie-card"><PieLabeled slices={slices} onPick={side === 'expense' && !categoryId ? (id) => set({ category: id }) : undefined} /></div>
              <div className="list" style={{ marginTop: 10 }}>
                {slices.map((sl) => (
                  <ShareRow key={sl.key} color={sl.color} share={sl.share} icon={sl.icon} name={sl.name} amount={sl.amount}
                    onClick={sl.rest ? undefined : side === 'expense' && !categoryId ? () => set({ category: sl.key }) : () => navigate(`/activity?from=${s.range.from}&to=${s.range.to}&categoryId=${sl.key}`)} />
                ))}
              </div>
            </>
          )}
          {categoryId && s.transactions.length > 0 && (
            <div className="section">
              <div className="section-title">Transactions</div>
              <div className="list">{s.transactions.map((t: any) => <TxnRow key={t.id} t={{ ...t, merchant: t.title, postings: [{ kind: 'category', name: t.category, icon: null, amount: t.amount }], source: 'manual', status: 'posted' }} />)}</div>
            </div>
          )}
          {!categoryId && side === 'expense' && s.trend.length > 0 && (
            <div className="section">
              <div className="section-title">Trend</div>
              <div className="card"><TrendChart points={s.trend} period={period} onPick={(from) => set({ anchor: from })} /></div>
            </div>
          )}
        </>
      ) : tab === 'note' ? (
        merchantSlices.length === 0 ? <div className="empty">No notes or merchants in this period.</div> : (
          <div className="list" style={{ marginTop: 6 }}>
            {merchantSlices.map((sl) => (
              <ShareRow key={sl.key} color={sl.color} share={sl.share} name={sl.name} amount={sl.amount}
                onClick={sl.rest ? undefined : () => navigate(`/activity?from=${s.range.from}&to=${s.range.to}&q=${encodeURIComponent(sl.key)}`)} />
            ))}
          </div>
        )
      ) : (
        <>
          {period !== 'month' || s.range.to <= today || s.range.from > today
            ? <p className="small muted">Budgets are monthly. Switch to this month to see and edit them.</p>
            : planner.data && <BudgetTab planner={planner.data} />}
        </>
      )}
    </>
  );
}

function BudgetTab({ planner }: { planner: any }) {
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api<any[]>('/api/categories') });
  const byId = new Map(planner.categories.map((c: any) => [c.id, c]));
  const rows = (cats.data ?? []).filter((c) => c.class === 'expense' && !c.parent_id).map((c) => byId.get(c.id) ?? { id: c.id, name: c.name, icon: c.icon, spent: 0, budget: null, used: null, status: null })
    .sort((a: any, b: any) => (b.budget !== null ? 1 : 0) - (a.budget !== null ? 1 : 0) || b.spent - a.spent);
  const b = planner.budgetUsed;
  return (
    <>
      {b.budget > 0 && (
        <div className="totals" style={{ marginTop: 4 }}>
          <div><span>Budget</span><b className="num">{money(b.budget, { whole: true })}</b></div>
          <div><span>Spent</span><b className="num exp">{money(b.spent, { whole: true })}</b></div>
          <div><span>Left</span><b className="num inc">{money(b.budget - b.spent, { whole: true })}</b></div>
        </div>
      )}
      <CategoryTable rows={rows} editable />
      <p className="tiny faint" style={{ margin: '8px 2px' }}>Type a monthly budget and tap away to save; clear it to remove.</p>
    </>
  );
}
