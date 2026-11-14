import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { api, money, compact, pct, periodLabel, todayIST } from '../lib';
import { Icon, tint } from '../components/Icons';
import { useUi } from '../App';
import { TxnRow } from '../components/TxnRow';

export function Home() {
  const { openAdd } = useUi();
  const home = useQuery({ queryKey: ['home'], queryFn: () => api<any>('/api/home') });
  const recent = useQuery({ queryKey: ['txns', 'recent'], queryFn: () => api<any[]>('/api/txns?limit=6') });
  const stats = useQuery({ queryKey: ['stats', 'month', 'now'], queryFn: () => api<any>('/api/stats?period=month') });
  const [showWhy, setShowWhy] = useState(false);
  const h = home.data;

  if (home.isError) return <p className="error">Couldn't load your dashboard: {(home.error as any).message}</p>;
  if (!h) return <div className="card"><div className="skeleton" style={{ width: '40%' }} /><div className="skeleton" style={{ marginTop: 12, height: 40 }} /></div>;

  const sts = h.safeToSpend;
  const budgets = (stats.data?.categories ?? []).filter((c: any) => c.budget !== null);
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
        <Link to="/settings" className="icon-btn" aria-label="Settings"><Icon name="settings" /></Link>
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
            <div className="spread"><span className="muted">− Unspent budgets this month</span><span className="num">{money(sts.reservedForBudgets, { whole: true })}</span></div>
            <p className="tiny faint" style={{ margin: '8px 0 0' }}>{sts.caveats.join(' ')}</p>
          </div>
        )}
      </div>

      <div className="grid2" style={{ marginTop: 14 }}>
        <Link to="/stats" className="card kpi">
          <div className="kpi-head"><span className="dot out"><Icon name="out" /></span><span className="hero-label">Spent</span></div>
          <div className="stat-num num">{money(h.monthSummary.spent, { whole: true })}</div>
          <div className="tiny faint">{money(h.monthSummary.avgDailySpend, { whole: true })}/day</div>
        </Link>
        <Link to="/stats" className="card kpi" style={{ marginTop: 0 }}>
          <div className="kpi-head"><span className="dot in"><Icon name="in" /></span><span className="hero-label">Earned</span></div>
          <div className="stat-num num">{h.monthSummary.noIncomeLogged ? '—' : money(h.monthSummary.earned, { whole: true })}</div>
          <div className="tiny faint">{h.monthSummary.noIncomeLogged ? 'No income logged yet' : `Saving ${pct(h.monthSummary.savingsRate)}`}</div>
        </Link>
      </div>

      {budgets.length > 0 && (
        <div className="section">
          <div className="section-title">Budgets <Link to="/stats">Details</Link></div>
          <div className="list">
            {budgets.map((b: any) => {
              const used = b.amount / b.budget;
              const state = used > 1 ? 'over' : used > 0.85 ? 'near' : '';
              const left = b.budget - b.amount;
              return (
                <div key={b.id} className="item budget-item">
                  <div className="spread">
                    <span className="label"><span className="avatar" style={tint(b.icon ?? b.name)} aria-hidden>{b.icon}</span>{b.name}</span>
                    <span className="small num">{compact(b.amount)} <span className="faint">/ {compact(b.budget)}</span></span>
                  </div>
                  <div className="bar-row" style={{ padding: 0, cursor: 'default' }}>
                    <span className="meter" style={{ gridColumn: '1 / 4', margin: 0 }}><span className={`fill ${state}`} style={{ width: `${Math.min(used, 1) * 100}%` }} /></span>
                  </div>
                  <div className="left num">{left >= 0 ? `${compact(left)} left` : `${compact(-left)} over budget`}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {h.topCategories.length > 0 && (
        <div className="section">
          <div className="section-title">Where it went</div>
          <div className="list">
            {h.topCategories.map((c: any) => (
              <Link key={c.id} to={`/stats?category=${c.id}`} className="item">
                <div className="avatar" style={tint(c.icon ?? c.name)} aria-hidden>{c.icon ?? '•'}</div>
                <div className="grow"><div className="title">{c.name}</div></div>
                <div className="amt num">{money(c.amount, { whole: true })}</div>
              </Link>
            ))}
          </div>
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
