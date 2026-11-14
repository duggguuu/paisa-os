import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { api, money, compact, periodLabel, todayIST, dayLabel, shortDate } from '../lib';
import { Icon, tint } from '../components/Icons';
import { useUi } from '../App';
import { TransRow } from './Activity';
import { GoalBar, BoostSheet, longDate, type Goal } from './Goals';
import { ThemeSheet } from '../components/Appearance';
import type { Insight } from './Insights';

export function Home() {
  const { openAdd, toast } = useUi();
  const qc = useQueryClient();
  const home = useQuery({ queryKey: ['home'], queryFn: () => api<any>('/api/home') });
  const recent = useQuery({ queryKey: ['txns', 'recent'], queryFn: () => api<any[]>('/api/txns?limit=6') });
  const goals = useQuery({ queryKey: ['goals'], queryFn: () => api<Goal[]>('/api/goals') });
  const ins = useQuery({ queryKey: ['insights'], queryFn: () => api<Insight[]>('/api/insights'), staleTime: 5 * 60_000 });
  const [showWhy, setShowWhy] = useState(false);
  const [boost, setBoost] = useState<Goal | null>(null);
  const [themes, setThemes] = useState(false);

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
  const today = todayIST();
  const dayMs = 86_400_000;
  const total = Math.max(1, Math.round((Date.parse(h.month.to) - Date.parse(h.month.from)) / dayMs));
  const daysLeft = Math.min(total, Math.max(1, Math.round((Date.parse(h.month.to) - Date.parse(today)) / dayMs)));
  const perDay = sts.amount > 0 ? sts.amount / daysLeft : 0;
  const warn = ins.data?.find((i) => i.tone === 'warn');
  const goal = [...(goals.data ?? [])].filter((g) => !g.done).sort((a, b) => b.progress - a.progress)[0];
  const m = h.monthSummary;

  return (
    <>
      <div className="page-head">
        <div className="row" style={{ gap: 8 }}>
          <img src="/logo-mark.png" alt="" className="logo-img" />
          <h1 className="page-title" style={{ margin: 0 }}>{periodLabel('month', h.month.from, h.month.to)}</h1>
        </div>
        <div className="head-actions">
          <button className="icon-plain" aria-label="Theme" onClick={() => setThemes(true)}><Icon name="palette" /></button>
          <Link to="/copilot" className="icon-plain" aria-label="AI Copilot"><Icon name="sparkle" /></Link>
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
          <span className="hero-label">Safe to spend</span>
          <button className="glass" onClick={() => setShowWhy((s) => !s)} aria-expanded={showWhy}>{showWhy ? 'Hide' : 'How?'}</button>
        </div>
        <div className={`hero-num num ${sts.amount < 0 ? 'neg' : ''}`}>{money(sts.amount, { whole: true })}</div>
        <div className="meta">
          <span>{sts.amount > 0 ? <>About <b className="num">{money(perDay, { whole: true })}</b>/day</> : 'Over plan this month'}</span>
          <span>{daysLeft} days left</span>
        </div>
        {showWhy && (
          <div className="why">
            <div className="spread"><span className="muted">In bank, cash and wallets</span><span className="num">{money(sts.spendable, { whole: true })}</span></div>
            <div className="spread"><span className="muted">− Credit card dues</span><span className="num">{money(sts.cardDues, { whole: true })}</span></div>
            <div className="spread"><span className="muted">− Bills &amp; SIPs still due</span><span className="num">{money(sts.upcomingBills ?? 0, { whole: true })}</span></div>
            <div className="spread"><span className="muted">− Unspent budgets</span><span className="num">{money(sts.reservedForBudgets, { whole: true })}</span></div>
          </div>
        )}
      </div>

      <Link to="/activity" className="totals card-totals">
        <div><span>Income</span><b className="num inc">{compact(m.earned)}</b></div>
        <div><span>Exp.</span><b className="num exp">{compact(m.spent)}</b></div>
        <div><span>Total</span><b className="num">{compact(m.earned - m.spent)}</b></div>
      </Link>

      {warn && (
        <Link to="/insights" className="note-line"><span aria-hidden>{warn.icon}</span><span className="grow">{warn.title}</span><Icon name="chevron" /></Link>
      )}

      {(h.dueSoon?.length ?? 0) > 0 && (
        <div className="section">
          <div className="section-title">Bills due <Link to="/recurring">All</Link></div>
          <div className="list">
            {h.dueSoon.slice(0, 3).map((r: any) => (
              <div key={r.id} className="item" style={{ cursor: 'default' }}>
                <div className="avatar" style={tint(r.category_icon ?? r.name)} aria-hidden>{r.category_icon ?? (r.kind === 'transfer' ? '⇄' : '•')}</div>
                <div className="grow">
                  <div className="title">{r.name}</div>
                  <div className="sub" style={{ color: r.overdue ? 'var(--up)' : r.today ? 'var(--warn)' : undefined }}>{r.overdue ? `Overdue · ${shortDate(r.next_due)}` : r.today ? 'Due today' : dayLabel(r.next_due)}</div>
                </div>
                {(r.overdue || r.today) && !r.auto_post
                  ? <div className="row" style={{ gap: 6 }}><button className="btn small" onClick={() => act(r, 'skip')}>Skip</button><button className="btn small accent" onClick={() => act(r, 'log')}>Log</button></div>
                  : <div className="amt num">{money(r.amount, { whole: true })}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {goal && (
        <div className="section">
          <div className="section-title">Goal <Link to="/goals">All goals</Link></div>
          <div className="list">
            <div className="goal-mini" role="button" onClick={() => setBoost(goal)}>
              <div className="row">
                <span className="avatar" aria-hidden>{goal.icon ?? '🎯'}</span>
                <div className="grow"><div className="title" style={{ fontWeight: 650 }}>{goal.name}</div>
                  <div className="sub tiny faint">{goal.reachOn ? `Reach by ${longDate(goal.reachOn)}` : 'Tap to boost'}</div></div>
                <span className="btn small accent">Boost</span>
              </div>
              <GoalBar g={goal} />
            </div>
          </div>
        </div>
      )}

      <div className="section">
        <div className="section-title">Recent <Link to="/activity">See all</Link></div>
        <div className="list">
          {recent.data?.length === 0 && (
            <div className="empty">Nothing logged yet. <button className="btn small" style={{ marginLeft: 8 }} onClick={() => openAdd()}>Add your first</button></div>
          )}
          {recent.data?.map((t) => <TransRow key={t.id} t={t} />)}
        </div>
      </div>

      {boost && <BoostSheet goal={boost} onClose={() => setBoost(null)} />}
      {themes && <ThemeSheet onClose={() => setThemes(false)} />}
    </>
  );
}
