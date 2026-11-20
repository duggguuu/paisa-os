import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, money, periodLabel, addDays, todayIST } from '../lib';
import { TrendChart, DonutPie, pieSlices } from '../components/Charts';
import { useAppear, useCountUp } from '../motion';
import { CategoryTable, usePlanner } from '../components/Planner';
import { TxnRow } from '../components/TxnRow';
import { Icon } from '../components/Icons';
import { MOOD_GROUPS, moodById, type MoodGroup } from '../moods';

const GROUP_COLOR: Record<MoodGroup, string> = { need: '#4f9d7a', want: '#5b7fd6', moment: '#e0803a' };

type Period = 'week' | 'month' | 'year';
type Tab = 'stats' | 'budget' | 'note';
const P_SHORT: Record<Period, string> = { week: 'W', month: 'M', year: 'Y' };

/** A ranked row: colour dot, name, amount, and a bar that fills to its share. */
function ShareRow({ color, share, icon, name, amount, onClick, active, dim, onHover, i = 0 }: {
  color: string; share: number; icon?: string | null; name: string; amount: number; onClick?: () => void;
  active?: boolean; dim?: boolean; onHover?: (on: boolean) => void; i?: number;
}) {
  const appear = useAppear(share);
  return (
    <button className={`share-row ${active ? 'on' : ''} ${dim ? 'dim' : ''}`} onClick={onClick} disabled={!onClick}
      onMouseEnter={() => onHover?.(true)} onMouseLeave={() => onHover?.(false)} onFocus={() => onHover?.(true)} onBlur={() => onHover?.(false)}
      style={{ ['--i' as any]: i }}>
      <span className="dot" style={{ background: color }} />
      <span className="sname">{icon ? `${icon} ` : ''}{name}</span>
      <span className="spct num">{(share * 100).toFixed(share < 0.1 ? 1 : 0)}%</span>
      <span className="num samt">{money(amount, { whole: true })}</span>
      <span className="sbar"><i style={{ width: appear ? `${Math.max(share * 100, 1)}%` : 0, background: color, transitionDelay: `${120 + i * 50}ms` }} /></span>
    </button>
  );
}

/** Income / Exp. tab total that rolls up when it changes. */
function Rolling({ value }: { value: number }) {
  return <span className="num">{money(Math.round(useCountUp(value)), { whole: true })}</span>;
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
  const [active, setActive] = useState<string | null>(null);
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
          <button className={side === 'income' ? 'on' : ''} onClick={() => set({ side: 'income', category: null })}>Income <Rolling value={s.summary.earned} /></button>
          <button className={side === 'expense' ? 'on' : ''} onClick={() => set({ side: null })}>Exp. <Rolling value={s.summary.spent} /></button>
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
              <div className="card breakdown">
                <DonutPie slices={slices} total={slices.reduce((t, x) => t + x.amount, 0)} label={side === 'income' ? 'Earned' : 'Spent'}
                  active={active} onActive={setActive}
                  onPick={side === 'expense' && !categoryId ? (id) => set({ category: id }) : undefined} />
                <div className="share-list">
                  {slices.map((sl, i) => (
                    <ShareRow key={sl.key} i={i} color={sl.color} share={sl.share} icon={sl.icon} name={sl.name} amount={sl.amount}
                      active={active === sl.key} dim={!!active && active !== sl.key} onHover={(on) => setActive(on ? sl.key : null)}
                      onClick={sl.rest ? undefined : side === 'expense' && !categoryId ? () => set({ category: sl.key }) : () => navigate(`/activity?from=${s.range.from}&to=${s.range.to}&categoryId=${sl.key}`)} />
                  ))}
                </div>
              </div>
            </>
          )}
          {categoryId && s.transactions.length > 0 && (
            <div className="section">
              <div className="section-title">Transactions</div>
              <div className="list">{s.transactions.map((t: any) => <TxnRow key={t.id} t={{ ...t, merchant: t.title, postings: [{ kind: 'category', name: t.category, icon: null, amount: t.amount }], source: 'manual', status: 'posted' }} />)}</div>
            </div>
          )}
          {side === 'expense' && s.moods && <MoodCard moods={s.moods} range={s.range} />}
          {!categoryId && side === 'expense' && s.trend.length > 0 && (
            <div className="section">
              <div className="section-title"><span>Trend</span><span className="tiny faint" style={{ textTransform: 'none', letterSpacing: 0 }}>tap a bar to open that {period}</span></div>
              <div className="card trend-card"><TrendChart points={s.trend} period={period} onPick={(from) => set({ anchor: from })} /></div>
            </div>
          )}
        </>
      ) : tab === 'note' ? (
        merchantSlices.length === 0 ? <div className="empty">No notes or merchants in this period.</div> : (
          <div className="list share-list" style={{ marginTop: 6 }}>
            {merchantSlices.map((sl, i) => (
              <ShareRow key={sl.key} i={i} color={sl.color} share={sl.share} name={sl.name} amount={sl.amount}
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

/** Spending by mindset: Needed it / Chose it / In the moment, then each mood. Tap one to see those spends. */
function MoodCard({ moods, range }: { moods: { mood: string; amount: number; count: number }[]; range: { from: string; to: string } }) {
  const navigate = useNavigate();
  const total = moods.reduce((t, m) => t + Number(m.amount), 0);
  const tagged = moods.filter((m) => m.mood !== 'none' && moodById(m.mood));
  if (!total) return null;
  const go = (mood: string) => navigate(`/activity?from=${range.from}&to=${range.to}&mood=${mood}`);
  if (!tagged.length) return (
    <div className="section">
      <div className="section-title">Spending by mindset</div>
      <p className="small muted" style={{ margin: 0 }}>Tag expenses with a mindset (Essential, Impulse, Splurge…) when you add them, and this shows how much went where.</p>
    </div>
  );
  const byGroup = MOOD_GROUPS.map((g) => ({ ...g, amount: tagged.filter((m) => moodById(m.mood)!.group === g.id).reduce((t, m) => t + Number(m.amount), 0) }));
  const untagged = Number(moods.find((m) => m.mood === 'none')?.amount ?? 0);
  return (
    <div className="section">
      <div className="section-title"><span>Spending by mindset</span><span className="tiny faint" style={{ textTransform: 'none', letterSpacing: 0 }}>tap one to see those spends</span></div>
      <div className="card">
        <div className="mood-share-groups" aria-hidden>
          {byGroup.map((g) => g.amount > 0 && <i key={g.id} style={{ width: `${(g.amount / total) * 100}%`, background: GROUP_COLOR[g.id] }} />)}
        </div>
        <div className="mood-legend">
          {byGroup.map((g) => <span key={g.id}><span className="sw" style={{ background: GROUP_COLOR[g.id] }} />{g.label} <b className="num">{((g.amount / total) * 100).toFixed(0)}%</b></span>)}
          {untagged > 0 && <span><span className="sw" style={{ background: 'var(--surface-3)' }} />Not tagged <b className="num">{((untagged / total) * 100).toFixed(0)}%</b></span>}
        </div>
        <div className="share-list">
          {tagged.map((m, i) => {
            const md = moodById(m.mood)!;
            return <ShareRow key={m.mood} i={i} color={GROUP_COLOR[md.group]} share={Number(m.amount) / total} icon={md.emoji} name={`${md.label} · ${m.count}`} amount={Number(m.amount)} onClick={() => go(m.mood)} />;
          })}
          {untagged > 0 && <ShareRow color="var(--border-strong)" share={untagged / total} name="Not tagged" amount={untagged} onClick={() => go('none')} i={tagged.length} />}
        </div>
      </div>
    </div>
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
