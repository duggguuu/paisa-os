import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, money, compact, pct, periodLabel, addDays, todayIST, KIND_ICON } from '../lib';
import { TrendChart, SpendCalendar, Donut, toSlices, OTHER_COLOR, type Slice } from '../components/Charts';
import { tint } from '../components/Icons';
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

function DeltaPill({ cur, base, word }: { cur: number; base: number | null; word: string }) {
  if (base === null || base === 0) return null;
  const d = (cur - base) / Math.abs(base);
  if (Math.abs(d) < 0.005) return <div className="pill">Same as {word}</div>;
  const up = d > 0;
  return <div className={`pill ${up ? 'bad' : 'good'}`}>{up ? '▲' : '▼'} {pct(Math.abs(d))} {up ? 'more' : 'less'} than {word}</div>;
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
          <div className="hero stats-hero">
            <button className="tile" onClick={() => navigate(`/activity?from=${s.range.from}&to=${s.range.to}&kind=expense`)}>
              <div className="hero-label">Spent{isCurrent ? ' so far' : ''}</div>
              <div className="hero-num num">{money(s.summary.spent, { whole: true })}</div>
            </button>
            <DeltaPill cur={s.summary.spent} base={s.previousSummary?.spent ?? null} word={s.comparedToDate ? SAME_POINT[period] : PERIOD_WORD[period]} />
            <div className="hero-stats">
              <button className="tile" onClick={() => navigate(`/activity?from=${s.range.from}&to=${s.range.to}&kind=income`)}>
                <span>Earned</span><b className="num">{s.summary.noIncomeLogged ? '—' : compact(s.summary.earned)}</b>
              </button>
              <div><span>Saved</span><b className="num">{s.summary.noIncomeLogged ? '—' : `${compact(s.summary.saved)} · ${pct(s.summary.savingsRate)}`}</b></div>
              <div><span>Per day</span><b className="num">{compact(s.summary.avgDailySpend)}</b></div>
            </div>
          </div>

          <div className="section">
            <div className="seg full" role="tablist" aria-label="Breakdown">
              {(['categories', 'merchants', 'accounts', 'people'] as View[]).map((v) => (
                <button key={v} className={view === v ? 'on' : ''} onClick={() => set({ view: v })}>{v[0].toUpperCase() + v.slice(1)}</button>
              ))}
            </div>
          </div>

          {view !== 'people' && (() => {
            const rows: Slice[] = view === 'categories' ? s.categories.map((c: any) => ({ key: c.id, name: c.name, icon: c.icon, amount: c.amount }))
              : view === 'merchants' ? s.merchants.map((m: any) => ({ key: m.name, name: m.name, amount: m.amount }))
              : s.accounts.map((a: any) => ({ key: a.id, name: a.name, icon: KIND_ICON[a.kind], amount: a.amount }));
            const total = rows.reduce((t, r) => t + Math.max(r.amount, 0), 0);
            if (!total) return null;
            const pick = (key: string) => view === 'categories' ? set({ category: key })
              : navigate(`/activity?from=${s.range.from}&to=${s.range.to}&${view === 'merchants' ? `q=${encodeURIComponent(key)}` : `accountId=${key}`}`);
            return (
              <div className="section">
                <div className="card"><Donut rows={rows} total={total} label={categoryId ? 'In this category' : 'Spent'} onPick={pick} /></div>
              </div>
            );
          })()}

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
  const { colorOf } = toSlices(rows.map((r) => ({ key: r.id, name: r.name, amount: r.amount })));
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
              <span className="icon avatar sm" style={tint(r.icon ?? r.name)} aria-hidden>{r.icon ?? '•'}</span>
              <span className="name"><span>{r.name}</span><span className="tiny faint">{pct(r.share)}</span></span>
              <span className="value num">{money(r.amount, { whole: true })}</span>
              <span className="meter">
                <span className={`fill ${over ? 'over' : ''}`} style={{ width: `${(Math.max(r.amount, 0) / scale) * 100}%`, ...(over ? {} : { background: colorOf.get(r.id) ?? OTHER_COLOR }) }} />
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
      {!categoryId && <p className="tiny faint" style={{ margin: '8px 2px' }}>"Usual" is your average over the 3 previous {period}s. The tick on a bar marks its budget.</p>}
    </>
  );
}

function SimpleBars({ rows, total, empty, onPick }: { rows: { key: string; icon: string; name: string; amount: number; sub: string }[]; total: number; empty: string; onPick: (r: any) => void }) {
  if (!rows.length) return <div className="list"><div className="empty">{empty}</div></div>;
  const max = Math.max(...rows.map((r) => r.amount), 1);
  const { colorOf } = toSlices(rows);
  return (
    <div className="list bars">
      {rows.map((r) => (
        <button key={r.key} className="bar-row" onClick={() => onPick(r)}>
          <span className="icon avatar sm" style={tint(r.icon + r.name)} aria-hidden>{r.icon}</span>
          <span className="name"><span>{r.name}</span><span className="tiny faint">{total > 0 ? pct(r.amount / total) : ''}</span></span>
          <span className="value num">{money(r.amount, { whole: true })}</span>
          <span className="meter"><span className="fill" style={{ width: `${(Math.max(r.amount, 0) / max) * 100}%`, background: colorOf.get(r.key) ?? OTHER_COLOR }} /></span>
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
          <div className="avatar" style={tint(p.name)} aria-hidden>🧑</div>
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
