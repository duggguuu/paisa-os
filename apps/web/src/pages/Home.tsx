import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { api, money, compact, periodLabel, todayIST } from '../lib';
import { Icon, tint } from '../components/Icons';
import { useQueryClient } from '@tanstack/react-query';
import { type Insight } from './Insights';
import { KpiCards, HealthCard, AiCard, CategoryTable, usePlanner, useHealth } from '../components/Planner';
import { GoalBar, ReachPill, BoostSheet, type Goal } from './Goals';
import { dayLabel, shortDate } from '../lib';
import { useUi } from '../App';
import { TxnRow } from '../components/TxnRow';

export function Home() {
  const { openAdd } = useUi();
  const home = useQuery({ queryKey: ['home'], queryFn: () => api<any>('/api/home') });
  const recent = useQuery({ queryKey: ['txns', 'recent'], queryFn: () => api<any[]>('/api/txns?limit=6') });
  const planner = usePlanner();
  const health = useHealth();
  const goals = useQuery({ queryKey: ['goals'], queryFn: () => api<Goal[]>('/api/goals') });
  const [boost, setBoost] = useState<Goal | null>(null);
  const [showWhy, setShowWhy] = useState(false);
  const qc = useQueryClient();
  const { toast } = useUi();
  const ins = useQuery({ queryKey: ['insights'], queryFn: () => api<Insight[]>('/api/insights'), staleTime: 5 * 60_000 });
  async function act(r: any, what: 'log' | 'skip') {
    try {
      await api(`/api/recurring/${r.id}/${what}`, { method: 'POST', body: {} });
      await qc.invalidateQueries();
      toast(what === 'log' ? `Logged ${r.name} · ${money(Number(r.amount))}` : `Skipped ${r.name}`);
    } catch (e: any) { toast(e.message); }
  }
  const h = home.data;

  if (home.isError) return <p className="error">Couldn't load your dashboard: {(home.error as any).message}</p>;
  if (!h) return <div className="card"><div className="skeleton" style={{ width: '40%' }} /><div className="skeleton" style={{ marginTop: 12, height: 40 }} /></div>;

  const sts = h.safeToSpend;
  const noAccountsYet = h.netWorth.accounts.every((a: any) => a.balance === 0) && recent.data?.length === 0;

  // Month progress + a per-day allowance, so the hero number is actionable.
  const today = todayIST();
  const dayMs = 86_400_000;
  const total = Math.max(1, Math.round((Date.parse(h.month.to) - Date.parse(h.month.from)) / dayMs));
  const daysLeft = Math.min(total, Math.max(1, Math.round((Date.parse(h.month.to) - Date.parse(today)) / dayMs)));
  const elapsed = (total - daysLeft + 1) / total;
  const perDay = sts.amount > 0 ? sts.amount / daysLeft : 0;
  const hour = new Date(Date.now() + 330 * 60_000).getUTCHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-kicker">{greeting}</div>
          <h1 className="page-title">{periodLabel('month', h.month.from, h.month.to)}</h1>
        </div>
        <div className="head-actions">
          <Link to="/copilot" className="icon-btn ai" aria-label="AI Copilot" title="AI Copilot"><Icon name="sparkle" /></Link>
          <Link to="/settings" className="icon-btn" aria-label="Settings"><Icon name="settings" /></Link>
        </div>
      </div>

      {noAccountsYet && (
        <div className="banner">
          <span>Start by entering what's in Axis, HDFC and your wallet today.</span>
          <Link to="/accounts" style={{ color: 'var(--accent)', fontWeight: 600 }}>Set balances</Link>
        </div>
      )}

      <div className="hero">
        <div className="spread">
          <span className="hero-label">Safe to spend this month</span>
          <button className="glass" onClick={() => setShowWhy((s) => !s)} aria-expanded={showWhy}>{showWhy ? 'Hide' : 'How?'}</button>
        </div>
        <div className={`hero-num num ${sts.amount < 0 ? 'neg' : ''}`}>{money(sts.amount, { whole: true })}</div>
        <div className="meta">
          <span>{sts.amount > 0 ? <>About <b className="num">{money(perDay, { whole: true })}</b> a day</> : 'Over plan for this month'}</span>
          <span>{daysLeft} {daysLeft === 1 ? 'day' : 'days'} left</span>
        </div>
        <div className="track" aria-hidden><span style={{ width: `${Math.round(elapsed * 100)}%` }} /></div>
        {showWhy && (
          <div className="why">
            <div className="spread"><span className="muted">In bank, cash and wallets</span><span className="num">{money(sts.spendable, { whole: true })}</span></div>
            <div className="spread"><span className="muted">− Credit card dues</span><span className="num">{money(sts.cardDues, { whole: true })}</span></div>
            <div className="spread"><span className="muted">− Bills &amp; SIPs still due</span><span className="num">{money(sts.upcomingBills ?? 0, { whole: true })}</span></div>
            <div className="spread"><span className="muted">− Unspent budgets this month</span><span className="num">{money(sts.reservedForBudgets, { whole: true })}</span></div>
            <p className="tiny faint" style={{ margin: '8px 0 0' }}>{sts.caveats.join(' ')}</p>
          </div>
        )}
      </div>

      {planner.data && <KpiCards p={planner.data} />}

      <nav className="quick-tools" aria-label="Shortcuts">
        <button onClick={() => openAdd({ voice: true })}><Icon name="mic" />Say it</button>
        <Link to="/budgets"><Icon name="pie" />Budgets</Link>
        <Link to="/recurring"><Icon name="repeat" />Bills</Link>
        <Link to="/import"><Icon name="upload" />Import</Link>
      </nav>

      <div className="section"><AiCard insights={ins.data} /></div>

      {(h.dueSoon?.length ?? 0) > 0 && (
        <div className="section">
          <div className="section-title">Bills due <Link to="/recurring">All bills</Link></div>
          <div className="list">
            {h.dueSoon.slice(0, 4).map((r: any) => (
              <div key={r.id} className="item" style={{ cursor: 'default' }}>
                <div className="avatar" style={tint(r.category_icon ?? r.name)} aria-hidden>{r.category_icon ?? (r.kind === 'transfer' ? '⇄' : '•')}</div>
                <div className="grow">
                  <div className="title">{r.name}</div>
                  <div className="sub" style={{ color: r.overdue ? 'var(--up)' : r.today ? 'var(--warn)' : undefined }}>
                    {r.overdue ? `Overdue · ${shortDate(r.next_due)}` : r.today ? 'Due today' : dayLabel(r.next_due)}{r.auto_post ? ' · logs automatically' : ''}
                  </div>
                </div>
                <div className="amt">
                  <div className="num">{money(r.amount, { whole: true })}</div>
                  {(r.overdue || r.today) && !r.auto_post && (
                    <div className="row" style={{ gap: 6, marginTop: 6, justifyContent: 'flex-end' }}>
                      <button className="btn small" onClick={() => act(r, 'skip')}>Skip</button>
                      <button className="btn small accent" onClick={() => act(r, 'log')}>Log</button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {(goals.data?.length ?? 0) > 0 && (() => {
        const g = [...goals.data!].sort((a, b) => Number(a.done) - Number(b.done) || b.progress - a.progress)[0];
        return (
          <div className="section">
            <div className="section-title">Goals <Link to="/goals">View all {goals.data!.length}</Link></div>
            <div className="goal-card">
              <Link to="/goals" className="g-head">
                <span className="g-ico">{g.icon ?? '🎯'}</span>
                <div className="grow"><div className="g-name">{g.name}</div><div className="g-sub">{compact(g.remaining)} to go</div></div>
              </Link>
              <GoalBar g={g} />
              <ReachPill g={g} />
              {!g.done && <button className="btn cyan" onClick={() => setBoost(g)}>Boost My Goal</button>}
            </div>
          </div>
        );
      })()}
      {boost && <BoostSheet goal={boost} onClose={() => setBoost(null)} />}

      {health.data && <div className="section"><HealthCard h={health.data} /></div>}

      {planner.data && planner.data.categories.some((c: any) => c.budget !== null) && (
        <div className="section">
          <div className="section-title">Budget categories <Link to="/budgets">Budget planner</Link></div>
          <CategoryTable rows={planner.data.categories} limit={5} />
        </div>
      )}

      <div className="section">
        <div className="section-title">Recent <Link to="/activity">See all</Link></div>
        <div className="list">
          {recent.data?.length === 0 && (
            <div className="empty">Nothing logged yet. <button className="btn small" style={{ marginLeft: 8 }} onClick={() => openAdd()}>Add your first</button></div>
          )}
          {recent.data?.map((t) => <TxnRow key={t.id} t={t} />)}
        </div>
      </div>

      <div className="section">
        <Link to="/accounts" className="card spread" style={{ display: 'flex' }}>
          <div>
            <div className="hero-label">Net worth</div>
            <div className="stat-num num">{money(h.netWorth.netWorth, { whole: true })}</div>
          </div>
          <div className="small muted" style={{ textAlign: 'right' }}>
            <div>Own <span className="num">{compact(h.netWorth.assets)}</span></div>
            <div>Owe <span className="num">{compact(h.netWorth.liabilities)}</span></div>
          </div>
        </Link>
      </div>
    </>
  );
}
