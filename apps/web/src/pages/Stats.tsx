import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, money, compact, pct, periodLabel, addDays, todayIST, KIND_ICON } from '../lib';
import { TrendChart, SpendCalendar } from '../components/Charts';
import { TxnRow } from '../components/TxnRow';

type Period = 'week' | 'month' | 'year';
type View = 'categories' | 'merchants' | 'accounts' | 'people';
const PERIOD_WORD: Record<Period, string> = { week: 'last week', month: 'last month', year: 'last year' };
const SAME_POINT: Record<Period, string> = { week: 'same day last week', month: 'same point last month', year: 'same point last year' };

function Delta({ cur, base, word, invert = false }: { cur: number; base: number | null; word: string; invert?: boolean }) {
  if (base === null) return null;
  if (cur === 0 && base > 0) return <span>none yet</span>;
  if (base === 0) return cur > 0 ? <span className="delta up">new vs {word}</span> : null;
  const d = (cur - base) / Math.abs(base);
  if (Math.abs(d) < 0.005) return <span>no change vs {word}</span>;
  const up = d > 0;
  const bad = invert ? !up : up;
  return <span className={`delta ${bad ? 'up' : 'down'}`}>{up ? '▲' : '▼'} {pct(Math.abs(d))} vs {word}</span>;
}

export function Stats() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const period = (params.get('period') as Period) || 'month';
  const anchor = params.get('anchor') || todayIST();
  const view = (params.get('view') as View) || 'categories';
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
  const s = q.data;
  const today = todayIST();
  const isCurrent = s && s.range.from <= today && today < s.range.to;

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Stats</h1>
        <div className="seg" role="tablist" aria-label="Period">
          {(['week', 'month', 'year'] as Period[]).map((p) => (
            <button key={p} className={period === p ? 'on' : ''} onClick={() => set({ period: p, anchor: null, category: null })}>
              {p === 'week' ? 'W' : p === 'month' ? 'M' : 'Y'}
            </button>
          ))}
        </div>
      </div>

      <div className="spread" style={{ marginBottom: 14 }}>
        <button className="btn small" aria-label="Previous period" onClick={() => s && set({ anchor: addDays(s.range.from, -1) })}>‹</button>
        <div style={{ fontWeight: 600, fontSize: 17 }}>{s ? periodLabel(period, s.range.from, s.range.to) : '…'}{isCurrent ? <span className="faint small"> · so far</span> : null}</div>
        <button className="btn small" aria-label="Next period" disabled={!s || s.range.to > today} onClick={() => s && set({ anchor: s.range.to })}>›</button>
      </div>

      {!s ? <div className="card"><div className="skeleton" /></div> : (
        <>
          <div className="card">
            <div className="grid2">
              <button className="tile"
                onClick={() => navigate(`/activity?from=${s.range.from}&to=${s.range.to}&kind=expense`)}>
                <div className="hero-label">Spent</div>
                <div className="stat-num num">{money(s.summary.spent, { whole: true })}</div>
                <div className="tiny"><Delta cur={s.summary.spent} base={s.previousSummary?.spent ?? null} word={s.comparedToDate ? SAME_POINT[period] : PERIOD_WORD[period]} /></div>
              </button>
              <button className="tile"
                onClick={() => navigate(`/activity?from=${s.range.from}&to=${s.range.to}&kind=income`)}>
                <div className="hero-label">Earned</div>
                <div className="stat-num num">{s.summary.noIncomeLogged ? '—' : money(s.summary.earned, { whole: true })}</div>
                <div className="tiny faint">{s.summary.noIncomeLogged ? 'No income logged' : `Saved ${money(s.summary.saved, { whole: true })} · ${pct(s.summary.savingsRate)}`}</div>
              </button>
            </div>
            <div className="divider" />
            <div className="tiny muted">Average {money(s.summary.avgDailySpend, { whole: true })} a day over {s.summary.days} days{s.comparedToDate ? ' so far' : ''}</div>
          </div>

          <div className="section">
            <div className="seg full" role="tablist" aria-label="Breakdown">
              {(['categories', 'merchants', 'accounts', 'people'] as View[]).map((v) => (
                <button key={v} className={view === v ? 'on' : ''} onClick={() => set({ view: v })}>{v[0].toUpperCase() + v.slice(1)}</button>
              ))}
            </div>
          </div>

          <div className="section">
            {view === 'categories' && <CategoryBars s={s} period={period} word={s.comparedToDate ? SAME_POINT[period] : PERIOD_WORD[period]} categoryId={categoryId} onDrill={(id) => set({ category: id })} onBack={() => set({ category: null })} />}
            {view === 'merchants' && <SimpleBars rows={s.merchants.map((m: any) => ({ key: m.name, icon: '🏷️', name: m.name, amount: m.amount, sub: `${m.count} ${m.count === 1 ? 'payment' : 'payments'}` }))}
              total={s.summary.spent} empty="No spending at merchants in this period." onPick={(r) => navigate(`/activity?from=${s.range.from}&to=${s.range.to}&q=${encodeURIComponent(r.key)}`)} />}
            {view === 'accounts' && <SimpleBars rows={s.accounts.map((a: any) => ({ key: a.id, icon: KIND_ICON[a.kind] ?? '•', name: a.name, amount: a.amount, sub: 'paid from this account' }))}
              total={s.summary.spent} empty="No spending in this period." onPick={(r) => navigate(`/activity?from=${s.range.from}&to=${s.range.to}&accountId=${r.key}`)} />}
            {view === 'people' && <People rows={s.people} />}
          </div>

          {categoryId && s.transactions.length > 0 && (
            <div className="section">
              <div className="section-title">Transactions</div>
              <div className="list">
                {s.transactions.map((t: any) => <DrillTxn key={t.id} t={t} />)}
              </div>
            </div>
          )}

          {!categoryId && s.trend.length > 0 && (
            <div className="section">
              <div className="section-title">Spending trend</div>
              <div className="card"><TrendChart points={s.trend} period={period} onPick={(from) => set({ anchor: from })} /></div>
            </div>
          )}

          {!categoryId && period === 'month' && (
            <div className="section">
              <div className="section-title">Day by day</div>
              <div className="card">
                <SpendCalendar from={s.range.from} to={s.range.to} days={s.daily} today={today}
                  onPick={(d) => navigate(`/activity?from=${d}&to=${addDays(d, 1)}`)} />
                <div className="tiny faint" style={{ marginTop: 10 }}>
                  Darker = more spent. Green dot = a day with no spending. {s.daily.length ? '' : 'Nothing spent yet.'}
                </div>
              </div>
            </div>
          )}

          {!categoryId && (
            <div className="section">
              <div className="section-title">Not counted as spending</div>
              <div className="list">
                {s.excluded.length === 0 && <div className="empty">No transfers, card payments or investments this period.</div>}
                {s.excluded.map((e: any) => (
                  <div className="item" key={e.bucket} style={{ cursor: 'default' }}>
                    <div className="grow"><div className="title">{e.bucket}</div><div className="sub">{e.count} {e.count === 1 ? 'transfer' : 'transfers'}</div></div>
                    <div className="amt num">{money(e.amount, { whole: true })}</div>
                  </div>
                ))}
              </div>
              <p className="tiny faint" style={{ margin: '8px 2px' }}>Moving money between your own accounts, paying a card bill, investing and lending don't change what you spent, so they're kept out of the totals above.</p>
            </div>
          )}
        </>
      )}
    </>
  );
}

function CategoryBars({ s, period, word, categoryId, onDrill, onBack }: { s: any; period: Period; word: string; categoryId: string | null; onDrill: (id: string) => void; onBack: () => void }) {
  const rows: any[] = s.categories;
  const drilled = categoryId ? rows : null;
  if (!rows.length) return <div className="list"><div className="empty">No spending in this period.</div></div>;
  const scale = Math.max(...rows.map((r) => Math.max(r.amount, r.budget ?? 0)), 1);
  return (
    <>
      {drilled && (
        <div className="spread" style={{ marginBottom: 8 }}>
          <button className="btn small" onClick={onBack}>‹ All categories</button>
          <span className="small muted num">{money(rows.reduce((t, r) => t + r.amount, 0), { whole: true })}</span>
        </div>
      )}
      <div className="list bars">
        {rows.map((r) => {
          const over = r.budget !== null && r.amount > r.budget;
          return (
            <button key={r.id} className="bar-row" onClick={() => onDrill(r.id)}
              aria-label={`${r.name}: ${money(r.amount, { whole: true })}`}>
              <span className="icon" aria-hidden>{r.icon ?? '•'}</span>
              <span className="name"><span>{r.name}</span><span className="tiny faint">{pct(r.share)}</span></span>
              <span className="value num">{money(r.amount, { whole: true })}</span>
              <span className="meter">
                <span className={`fill ${over ? 'over' : ''}`} style={{ width: `${(Math.max(r.amount, 0) / scale) * 100}%` }} />
                {r.budget !== null && <span className="budget" style={{ left: `${(r.budget / scale) * 100}%` }} title={`Budget ${money(r.budget, { whole: true })}`} />}
              </span>
              <span className="meta">
                <Delta cur={r.amount} base={r.previous} word={word} />
                {r.avg3 !== null && r.avg3 > 0 && <span>usual {compact(r.avg3)}</span>}
                {r.budget !== null && <span className={over ? 'delta up' : ''}>{over ? `${compact(r.amount - r.budget)} over budget` : `${compact(r.budget - r.amount)} left of ${compact(r.budget)}`}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {!categoryId && <p className="tiny faint" style={{ margin: '8px 2px' }}>"Usual" is your average over the 3 previous {period}s. The black tick on a bar is its budget.</p>}
    </>
  );
}

function SimpleBars({ rows, total, empty, onPick }: { rows: { key: string; icon: string; name: string; amount: number; sub: string }[]; total: number; empty: string; onPick: (r: any) => void }) {
  if (!rows.length) return <div className="list"><div className="empty">{empty}</div></div>;
  const max = Math.max(...rows.map((r) => r.amount), 1);
  return (
    <div className="list bars">
      {rows.map((r) => (
        <button key={r.key} className="bar-row" onClick={() => onPick(r)}>
          <span className="icon" aria-hidden>{r.icon}</span>
          <span className="name"><span>{r.name}</span><span className="tiny faint">{total > 0 ? pct(r.amount / total) : ''}</span></span>
          <span className="value num">{money(r.amount, { whole: true })}</span>
          <span className="meter"><span className="fill" style={{ width: `${(Math.max(r.amount, 0) / max) * 100}%` }} /></span>
          <span className="meta"><span>{r.sub}</span></span>
        </button>
      ))}
    </div>
  );
}

function People({ rows }: { rows: any[] }) {
  if (!rows.length) return <div className="list"><div className="empty">No money lent or received from people in this period. Add people under Accounts to track who owes you.</div></div>;
  return (
    <div className="list">
      {rows.map((p) => (
        <div className="item" key={p.id} style={{ cursor: 'default' }}>
          <div className="avatar" aria-hidden>🧑</div>
          <div className="grow">
            <div className="title">{p.name}</div>
            <div className="sub">Lent {money(p.lent, { whole: true })} · got back {money(p.received, { whole: true })}</div>
          </div>
          <div className="amt">
            <div className="num" style={{ fontWeight: 600 }}>{money(p.outstanding, { whole: true })}</div>
            <div className="tiny faint">{p.outstanding > 0 ? 'owes you' : p.outstanding < 0 ? 'you owe' : 'settled'}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function DrillTxn({ t }: { t: any }) {
  // Stats returns a compact row; reuse TxnRow's look with the fields it needs.
  return <TxnRow t={{ ...t, merchant: t.title, postings: [{ kind: 'category', name: t.category, icon: null, amount: t.amount }], source: 'manual', status: 'posted' }} />;
}
