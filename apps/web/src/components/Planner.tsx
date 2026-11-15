import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, money, compact, pct, parseRupees, maskText } from '../lib';
import { Icon, tint } from './Icons';
import { MiniBars, Gauge } from './Charts';
import type { Insight } from '../pages/Insights';

export const usePlanner = () => useQuery({ queryKey: ['planner'], queryFn: () => api<any>('/api/planner') });
export const useHealth = () => useQuery({ queryKey: ['health'], queryFn: () => api<any>('/api/health-score') });

function Delta({ d, goodWhenUp }: { d: number | null | undefined; goodWhenUp: boolean }) {
  if (d === null || d === undefined || !isFinite(d)) return <span>—</span>;
  const up = d >= 0;
  const good = up === goodWhenUp;
  return <span className={`delta ${good ? 'down' : 'up'}`}>{up ? '↑' : '↓'} {pct(Math.abs(d), 1)}</span>;
}

/** Total income · Planned · Remaining · Budget used, each with a 6-month sparkline. */
export function KpiCards({ p }: { p: any }) {
  const used = p.budgetUsed.value;
  const cards = [
    { key: 'income', label: 'Total income', icon: 'wallet', color: 'var(--k-blue)', raw: p.income.value, foot: 'vs last month', series: p.income.series, delta: <Delta d={p.income.delta} goodWhenUp />, to: '/activity?kind=income' },
    { key: 'planned', label: 'Planned expenses', icon: 'pie', color: 'var(--k-violet)', raw: p.planned.value, foot: 'This month', series: p.spent.series, delta: <span>{p.planned.budgets ? `${compact(p.planned.budgets)} budgets` : 'No budgets'}</span>, to: '/budgets' },
    { key: 'remaining', label: 'Remaining', icon: 'target', color: 'var(--k-orange)', raw: p.remaining.value, foot: 'vs last month', series: p.income.series.map((v: number, i: number) => v - (p.spent.series[i] ?? 0)), delta: <Delta d={p.remaining.delta} goodWhenUp />, to: '/stats' },
    { key: 'used', label: 'Budget used', icon: 'gauge', color: 'var(--k-red)', raw: null, pctText: used === null ? '—' : `${Math.round(used * 100)}%`, foot: used === null ? 'Set budgets' : 'Month gone', series: p.spent.series, delta: <span>{used === null ? '' : `${Math.round(p.budgetUsed.monthElapsed * 100)}%`}</span>, to: '/budgets' },
  ];
  return (
    <div className="kpi-grid">
      {cards.map((c) => (
        <Link key={c.key} to={c.to} className="kpi-card">
          <div className="k-head"><span className="k-ico" style={{ background: c.color }}><Icon name={c.icon} /></span>{c.label}</div>
          <div className="k-body">
            {c.raw === null ? <span className="k-val num">{(c as any).pctText}</span> : (
              <span className="k-val num" title={money(c.raw, { whole: true })}>
                <span className="k-full">{money(c.raw, { whole: true })}</span><span className="k-short">{compact(c.raw)}</span>
              </span>
            )}
            <MiniBars values={c.series} color={c.color} />
          </div>
          <div className="k-foot"><span>{c.foot}</span>{c.delta}</div>
        </Link>
      ))}
    </div>
  );
}

export function HealthCard({ h, expanded = false }: { h: any; expanded?: boolean }) {
  const [open, setOpen] = useState(expanded);
  const color = (s: number) => (s >= 75 ? 'var(--green)' : s >= 50 ? 'var(--amber)' : 'var(--up)');
  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 8 }}>
        <b>Financial health</b>
        <button className="btn small" onClick={() => setOpen((o) => !o)}>{open ? 'Less' : 'Details'}</button>
      </div>
      <div className="health">
        <Gauge score={h.score} label={h.label} />
        <div>
          <div className="h-label" style={{ color: color(h.score) }}>{h.label}</div>
          <div className="h-tip">{h.focus ? maskText(h.focus.tip) : 'Everything looks healthy. Keep it up.'}</div>
        </div>
      </div>
      {open && (
        <div className="health-parts">
          {h.parts.map((x: any) => (
            <div className="hp" key={x.key}>
              <span>{x.label}</span><b className="num">{x.score}</b>
              <span className="meter"><i style={{ width: `${x.score}%`, background: color(x.score) }} /></span>
              <span className="d">{maskText(x.detail)}{x.tip ? `. ${maskText(x.tip)}` : ''}</span>
            </div>
          ))}
          <p className="tiny faint" style={{ margin: 0 }}>Weighted: savings rate and emergency fund 25 each, budgets and card dues 15 each, spending trend and goals 10 each.</p>
        </div>
      )}
    </div>
  );
}

/** The headline insight in a dark feature card, with a way into the Copilot. */
export function AiCard({ insights }: { insights: Insight[] | undefined }) {
  const navigate = useNavigate();
  const warn = insights?.find((i) => i.tone === 'warn');
  const good = insights?.find((i) => i.tone === 'good');
  const head = warn ? { title: 'Heads up', body: `${warn.title}. ${warn.body}` } : good ? { title: "You're on track", body: `${good.title}. ${good.body}` } : { title: "You're on track", body: 'Nothing unusual this month. Ask me anything about your money.' };
  return (
    <div className="ai-card">
      <div className="ai-top"><span><Icon name="sparkle" /> AI insights</span><span>This month</span></div>
      <h3>{head.title}</h3>
      <p>{maskText(head.body)}</p>
      <div className="ai-actions">
        <button className="btn small" onClick={() => navigate('/copilot')}>Ask Copilot</button>
        <button className="btn small ghost" onClick={() => navigate('/insights')}>View full analysis →</button>
      </div>
    </div>
  );
}

export function QuickInsights({ insights, max = 6 }: { insights: Insight[]; max?: number }) {
  const navigate = useNavigate();
  if (!insights.length) return null;
  return (
    <div className="quick-grid">
      {insights.slice(0, max).map((i) => (
        <button key={i.id} className={`qi ${i.tone}`} onClick={() => navigate(i.action?.to ?? '/insights')}>
          <span className="qi-ico" aria-hidden>{i.icon}</span><span>{maskText(i.title)}</span>
        </button>
      ))}
    </div>
  );
}

const STATUS: Record<string, string> = { on_track: 'On track', behind: 'Behind', over: 'Over' };

/** Budget categories with tick meters and status. `editable` shows budget inputs. */
export function CategoryTable({ rows, editable = false, limit }: { rows: any[]; editable?: boolean; limit?: number }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const list = (editable ? rows : rows.filter((r) => r.budget !== null)).slice(0, limit ?? 999);
  async function saveBudget(id: string) {
    const v = draft[id];
    if (v === undefined) return;
    const p = parseRupees(v);
    if (p) await api('/api/budgets', { method: 'PUT', body: { categoryId: id, period: 'monthly', amount: p } });
    else if (v.trim() === '') {
      const all = await api<any[]>('/api/budgets');
      const b = all.find((x) => x.category_id === id && x.period === 'monthly');
      if (b) await api(`/api/budgets/${b.id}`, { method: 'DELETE' });
    }
    setDraft((d) => { const n = { ...d }; delete n[id]; return n; });
    await qc.invalidateQueries();
  }
  if (!list.length) return <div className="list"><div className="empty">No budgets yet. <Link to="/budgets" style={{ color: 'var(--accent)', fontWeight: 650 }}>Set some in the Budget Planner</Link>.</div></div>;
  const color = (s: string | null) => (s === 'over' ? 'var(--up)' : s === 'behind' ? 'var(--amber)' : 'var(--accent)');
  return (
    <div className="list">
      {list.map((r) => {
        const used = r.used ?? 0;
        const lit = Math.round(Math.min(used, 1) * 12);
        return (
          <div key={r.id} className={`cat-row ${editable ? 'edit' : ''}`}>
            <span className="ci" style={tint(r.icon ?? r.name)} aria-hidden>{r.icon ?? '•'}</span>
            <span className="cn"><span>{r.name}</span>{r.status ? <span className={`status ${r.status}`}>{STATUS[r.status]}</span> : <span className="status none">No budget</span>}</span>
            {editable ? (
              <span className="cv">
                {money(r.spent, { whole: true })} of{' '}
                <input className="input num budget-input" inputMode="decimal" placeholder="Budget"
                  value={draft[r.id] ?? (r.budget ? String(r.budget / 100) : '')}
                  onChange={(e) => setDraft((d) => ({ ...d, [r.id]: e.target.value.replace(/[^\d.,]/g, '') }))}
                  onBlur={() => saveBudget(r.id)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  aria-label={`Monthly budget for ${r.name}`} />
              </span>
            ) : (
              <span className="cv num">{compact(r.spent)} / {compact(r.budget)}</span>
            )}
            {r.budget !== null && (
              <span className="ticks" aria-hidden>
                {Array.from({ length: 12 }, (_, i) => <i key={i} style={i < lit ? { background: color(r.status) } : undefined} />)}
                <b className="num">{Math.round(used * 100)}%</b>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
