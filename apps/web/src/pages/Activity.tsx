import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import { api, money, parseRupees, shortDate, addDays, todayIST, periodLabel, maskNum } from '../lib';
import { Icon } from '../components/Icons';
import { useUi } from '../App';
import { SwipeTxn } from '../components/Swipe';

type Tab = 'daily' | 'calendar' | 'monthly' | 'summary' | 'description';
const TABS: [Tab, string][] = [['daily', 'Daily'], ['calendar', 'Calendar'], ['monthly', 'Monthly'], ['summary', 'Summary'], ['description', 'Description']];
const KINDS: [string, string][] = [['', 'All'], ['expense', 'Expenses'], ['income', 'Income'], ['transfer', 'Transfers'], ['split', 'Splits'], ['refund', 'Refunds']];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const n2 = (p: number) => money(p).replace('₹', '₹ ');

/** Income and expense of one transaction, from its postings. */
function flows(t: any) {
  const ps: any[] = t.postings ?? [];
  const income = -ps.filter((p) => p.class === 'income').reduce((s, p) => s + p.amount, 0);
  const expense = ps.filter((p) => p.class === 'expense').reduce((s, p) => s + p.amount, 0);
  return { income, expense };
}

/** One transaction, laid out as: category | note + account | amount. */
export function TransRow({ t }: { t: any }) {
  const { openTxn } = useUi();
  const ps: any[] = t.postings ?? [];
  const cat = ps.find((p) => p.kind === 'category');
  const out = ps.find((p) => p.kind !== 'category' && p.amount < 0 && p.class !== 'equity');
  const into = ps.find((p) => p.kind !== 'category' && p.amount > 0 && p.class !== 'equity');
  // Direction from the money account, so a negative expense (money back) shows as money in.
  const kind = t.kind === 'transfer' ? 'trf' : (t.kind === 'expense' || t.kind === 'income') && (into || out) ? (into && !out ? 'inc' : 'exp') : t.kind === 'income' || t.kind === 'refund' ? 'inc' : 'exp';
  const top = cat ? (cat.parent ?? cat.name) : t.kind === 'transfer' ? 'Transfer' : t.kind;
  const sub = cat?.parent ? cat.name : null;
  const icon = cat?.icon ?? (t.kind === 'transfer' ? '⇄' : '•');
  const note = t.merchant ?? t.description ?? '';
  const acct = t.kind === 'transfer' ? `${out?.name ?? '?'} → ${into?.name ?? '?'}` : (kind === 'inc' ? into : out)?.name ?? '';
  return (
    <SwipeTxn t={t}>
      <button className={`trow ${t.status === 'void' ? 'void' : ''}`} onClick={() => openTxn(t.id)}>
        <span className="tc"><span className="ticon" aria-hidden>{icon}</span><span className="tcat"><span>{top}</span>{sub && <small>{sub}</small>}</span></span>
        <span className="tm">{note ? <><span className="tt">{note}</span><small>{acct}</small></> : <span className="tacct">{acct}</span>}</span>
        <span className={`ta num ${kind}`}>{n2(t.amount)}</span>
      </button>
    </SwipeTxn>
  );
}

export function Activity() {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const [showSearch, setShowSearch] = useState(!!params.get('q'));
  const [showFilter, setShowFilter] = useState(false);
  const tab = (params.get('tab') as Tab) || 'daily';
  const anchor = params.get('m') || todayIST();
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
    setParams(next, { replace: true });
  };

  // Search box: "above 5000" filters by amount; anything else searches text.
  useEffect(() => {
    const t = setTimeout(() => {
      const m = text.trim().match(/^(?:above|over|>)\s*₹?\s*([\d,]+(?:\.\d+)?)$/i);
      const next = new URLSearchParams(params);
      if (m) { next.set('min', String(parseRupees(m[1]))); next.delete('q'); }
      else { text.trim() ? next.set('q', text.trim()) : next.delete('q'); next.delete('min'); }
      if (next.toString() !== params.toString()) setParams(next, { replace: true });
    }, 300);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  const month = useQuery({ queryKey: ['trans-month', anchor], queryFn: () => api<any>(`/api/trans/month?anchor=${anchor}`) });
  const range = month.data?.range;
  // Explicit filters (from other screens) override the month.
  const filtered = ['from', 'q', 'accountId', 'categoryId', 'min', 'kind', 'deleted'].some((k) => params.get(k));
  const qs = new URLSearchParams();
  if (params.get('from')) { qs.set('from', params.get('from')!); if (params.get('to')) qs.set('to', params.get('to')!); }
  else if (range && !params.get('q')) { qs.set('from', range.from); qs.set('to', range.to); }
  for (const k of ['kind', 'q', 'accountId', 'categoryId', 'min']) if (params.get(k)) qs.set(k, params.get(k)!);
  if (params.get('deleted')) qs.set('includeVoid', 'true');
  qs.set('limit', '500');
  const txns = useQuery({ queryKey: ['txns', qs.toString()], queryFn: () => api<any[]>(`/api/txns?${qs}`), enabled: !!range || filtered });

  const shift = (n: number) => { if (!range) return; set({ m: n < 0 ? addDays(range.from, -1) : range.to, from: null, to: null }); };
  const totals = useMemo(() => {
    if (!filtered && month.data) return { income: month.data.income, expense: month.data.expense };
    return (txns.data ?? []).filter((t) => t.status === 'posted').reduce((a, t) => { const f = flows(t); return { income: a.income + f.income, expense: a.expense + f.expense }; }, { income: 0, expense: 0 });
  }, [filtered, month.data, txns.data]);

  const filters: string[] = [];
  if (params.get('from') && params.get('to')) filters.push(params.get('to') === addDays(params.get('from')!, 1) ? shortDate(params.get('from')!) : `${shortDate(params.get('from')!)} – ${shortDate(addDays(params.get('to')!, -1))}`);
  if (params.get('accountId')) filters.push('one account');
  if (params.get('categoryId')) filters.push('one category');
  if (params.get('min')) filters.push(`above ${money(Number(params.get('min')), { whole: true })}`);
  if (params.get('kind')) filters.push(KINDS.find(([k]) => k === params.get('kind'))?.[1] ?? '');

  return (
    <>
      <div className="trans-head">
        <button className="icon-plain" aria-label="Search" onClick={() => setShowSearch((s) => !s)}><Icon name="search" /></button>
        <h1 className="page-title" style={{ margin: 0 }}>Trans.</h1>
        <button className={`icon-plain ${showFilter || params.get('kind') ? 'on' : ''}`} aria-label="Filter" onClick={() => setShowFilter((s) => !s)}><Icon name="activity" /></button>
      </div>
      {showSearch && <input className="input" type="search" autoFocus placeholder='Search merchant, note, tag, or "above 5000"' value={text} onChange={(e) => setText(e.target.value)} aria-label="Search transactions" style={{ marginBottom: 8 }} />}
      {showFilter && (
        <div className="chips" style={{ marginBottom: 8 }}>
          {KINDS.map(([k, label]) => <button key={k} className={`chip ${(params.get('kind') ?? '') === k ? 'on' : ''}`} onClick={() => set({ kind: k || null })}>{label}</button>)}
          <button className={`chip ${params.get('deleted') ? 'on' : ''}`} onClick={() => set({ deleted: params.get('deleted') ? null : '1' })}>Show deleted</button>
        </div>
      )}

      {!params.get('from') && (
        <div className="month-nav">
          <button aria-label="Previous month" onClick={() => shift(-1)}><Icon name="back" /></button>
          <b>{range ? periodLabel('month', range.from, range.to) : '…'}</b>
          <button aria-label="Next month" onClick={() => shift(1)} disabled={!range || range.to > todayIST()}><Icon name="chevron" /></button>
        </div>
      )}
      {filters.length > 0 && (
        <div className="banner" style={{ marginTop: 4 }}>
          <span>Filtered: {filters.join(' · ')}</span>
          <button onClick={() => { setText(''); setParams(new URLSearchParams(), { replace: true }); }}>Clear</button>
        </div>
      )}

      <div className="tabs-line" role="tablist">
        {TABS.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => set({ tab: k === 'daily' ? null : k })}>{label}</button>)}
      </div>

      <div className="totals">
        <div><span>Income</span><b className="num inc">{money(totals.income)}</b></div>
        <div><span>Exp.</span><b className="num exp">{money(totals.expense)}</b></div>
        <div><span>Total</span><b className="num">{money(totals.income - totals.expense, { sign: true })}</b></div>
      </div>

      {tab === 'daily' && <Daily txns={txns.data} loading={txns.isLoading} />}
      {tab === 'calendar' && month.data && <Calendar data={month.data} onPick={(d) => set({ from: d, to: addDays(d, 1), tab: null })} />}
      {tab === 'monthly' && <Monthly year={Number((range?.from ?? todayIST()).slice(0, 4))} onPick={(m) => set({ m, tab: null })} />}
      {tab === 'summary' && range && <Summary range={range} totals={totals} />}
      {tab === 'description' && <Descriptions txns={txns.data ?? []} onPick={(q) => { setText(q); setShowSearch(true); set({ tab: null }); }} />}
    </>
  );
}

function Daily({ txns, loading }: { txns: any[] | undefined; loading: boolean }) {
  if (loading) return <div className="card"><div className="skeleton" /></div>;
  if (!txns?.length) return <div className="empty">No transactions here.</div>;
  const groups: [string, any[]][] = [];
  for (const t of txns) { const g = groups[groups.length - 1]; if (g && g[0] === t.date) g[1].push(t); else groups.push([t.date, [t]]); }
  return (
    <div className="list daily">
      {groups.map(([day, ts]) => {
        const f = ts.filter((t) => t.status === 'posted').reduce((a, t) => { const x = flows(t); return { i: a.i + x.income, e: a.e + x.expense }; }, { i: 0, e: 0 });
        const [y, m, d] = day.split('-').map(Number);
        const dow = DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
        return (
          <div key={day} className="dgroup">
            <div className="dhead">
              <span className="dnum">{d}</span><span className={`dpill ${dow === 'Sun' ? 'sun' : dow === 'Sat' ? 'sat' : ''}`}>{dow}</span>
              <span className="dmon faint">{MON[m - 1]}{y !== Number(todayIST().slice(0, 4)) ? ` ${y}` : ''}</span>
              <span className="grow" />
              <span className="num inc">{n2(f.i)}</span><span className="num exp">{n2(f.e)}</span>
            </div>
            {ts.map((t) => <TransRow key={t.id} t={t} />)}
          </div>
        );
      })}
      {txns.length >= 500 && <p className="tiny faint" style={{ textAlign: 'center' }}>Showing the latest 500.</p>}
    </div>
  );
}

function Calendar({ data, onPick }: { data: any; onPick: (d: string) => void }) {
  const byDay = new Map<string, any>(data.days.map((d: any) => [d.day, d]));
  const start = data.range.from;
  const [y, m, d0] = start.split('-').map(Number);
  const lead = new Date(Date.UTC(y, m - 1, d0)).getUTCDay(); // Sunday first, like a wall calendar
  const n = Math.round((Date.parse(data.range.to) - Date.parse(start)) / 86_400_000);
  const cells = Array.from({ length: Math.ceil((lead + n) / 7) * 7 }, (_, i) => (i < lead || i >= lead + n ? null : addDays(start, i - lead)));
  const today = todayIST();
  return (
    <div className="tcal">
      {DOW.map((w) => <div key={w} className={`tdow ${w === 'Sun' ? 'sun' : w === 'Sat' ? 'sat' : ''}`}>{w}</div>)}
      {cells.map((day, i) => {
        if (!day) return <div key={i} className="tcell off" />;
        const v = byDay.get(day);
        const dow = i % 7;
        return (
          <button key={day} className={`tcell ${day === today ? 'today' : ''}`} onClick={() => onPick(day)} disabled={day > today}>
            <span className={`tday ${dow === 0 ? 'sun' : dow === 6 ? 'sat' : ''}`}>{Number(day.slice(8))}</span>
            {v && Number(v.income) > 0 && <span className="tamt inc num">{maskNum(Math.round(v.income / 100).toLocaleString('en-IN'))}</span>}
            {v && Number(v.expense) > 0 && <span className="tamt exp num">{maskNum(Math.round(v.expense / 100).toLocaleString('en-IN'))}</span>}
          </button>
        );
      })}
    </div>
  );
}

function Monthly({ year, onPick }: { year: number; onPick: (anchor: string) => void }) {
  const q = useQuery({ queryKey: ['trans-year', year], queryFn: () => api<any[]>(`/api/trans/year?year=${year}`) });
  if (!q.data) return <div className="card"><div className="skeleton" /></div>;
  const rows = q.data.filter((r) => r.from <= todayIST()).reverse();
  return (
    <div className="list">
      {rows.map((r) => (
        <button key={r.from} className="mrow" onClick={() => onPick(r.from)}>
          <span className="mname">{periodLabel('month', r.from, r.to)}</span>
          <span className="num inc">{money(r.income, { whole: true })}</span>
          <span className="num exp">{money(r.expense, { whole: true })}</span>
          <span className="num mtot">{money(r.income - r.expense, { whole: true, sign: true })}</span>
        </button>
      ))}
    </div>
  );
}

function Summary({ range, totals }: { range: { from: string; to: string }; totals: { income: number; expense: number } }) {
  const s = useQuery({ queryKey: ['stats', 'month', range.from], queryFn: () => api<any>(`/api/stats?period=month&anchor=${range.from}`) });
  if (!s.data) return <div className="card"><div className="skeleton" /></div>;
  const budgets = s.data.categories.filter((c: any) => c.budget !== null);
  return (
    <>
      <div className="section-title" style={{ marginTop: 12 }}>Accounts</div>
      <div className="list">
        {s.data.accounts.length === 0 && <div className="empty">No spending this month.</div>}
        {s.data.accounts.map((a: any) => (
          <div key={a.id} className="srow"><span>{a.name}</span><span className="num exp">{money(a.amount, { whole: true })}</span></div>
        ))}
        <div className="srow"><b>Saved</b><b className="num">{money(totals.income - totals.expense, { whole: true, sign: true })}</b></div>
      </div>
      {budgets.length > 0 && (
        <>
          <div className="section-title" style={{ marginTop: 14 }}>Budget</div>
          <div className="list">
            {budgets.map((b: any) => (
              <div key={b.id} className="srow">
                <span>{b.icon} {b.name}</span>
                <span className={`num ${b.amount > b.budget ? 'exp' : ''}`}>{money(b.amount, { whole: true })} <span className="faint">/ {money(b.budget, { whole: true })}</span></span>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="section-title" style={{ marginTop: 14 }}>Not counted as spending</div>
      <div className="list">
        {s.data.excluded.length === 0 && <div className="empty">No transfers this month.</div>}
        {s.data.excluded.map((e: any) => <div key={e.bucket} className="srow"><span>{e.bucket}</span><span className="num">{money(e.amount, { whole: true })}</span></div>)}
      </div>
    </>
  );
}

function Descriptions({ txns, onPick }: { txns: any[]; onPick: (q: string) => void }) {
  const groups = new Map<string, { name: string; n: number; exp: number; inc: number }>();
  for (const t of txns) {
    if (t.status !== 'posted' || t.kind === 'transfer') continue;
    const name = (t.merchant ?? t.description ?? 'No description').trim();
    const k = name.toLowerCase();
    const g = groups.get(k) ?? { name, n: 0, exp: 0, inc: 0 };
    const f = flows(t);
    g.n++; g.exp += f.expense; g.inc += f.income;
    groups.set(k, g);
  }
  const rows = [...groups.values()].sort((a, b) => b.exp + b.inc - (a.exp + a.inc));
  if (!rows.length) return <div className="empty">Nothing this month.</div>;
  return (
    <div className="list">
      {rows.map((r) => (
        <button key={r.name} className="srow" onClick={() => onPick(r.name)}>
          <span>{r.name} <span className="faint tiny">×{r.n}</span></span>
          <span className={`num ${r.inc > r.exp ? 'inc' : 'exp'}`}>{money(r.inc > r.exp ? r.inc : r.exp, { whole: true })}</span>
        </button>
      ))}
    </div>
  );
}
