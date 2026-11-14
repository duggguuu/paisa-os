import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api, money, dayLabel, parseRupees, shortDate, addDays } from '../lib';
import { TxnRow } from '../components/TxnRow';

const KINDS: [string, string][] = [['', 'All'], ['expense', 'Expenses'], ['income', 'Income'], ['transfer', 'Transfers'], ['split', 'Splits'], ['refund', 'Refunds']];

export function Activity() {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    v ? next.set(k, v) : next.delete(k);
    setParams(next, { replace: true });
  };

  // Search box: "above 5000" / "> 5000" filters by amount; anything else searches text.
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

  const qs = new URLSearchParams();
  for (const k of ['from', 'to', 'kind', 'q', 'accountId', 'categoryId', 'min']) if (params.get(k)) qs.set(k, params.get(k)!);
  if (params.get('deleted')) qs.set('includeVoid', 'true');
  qs.set('limit', '300');
  const q = useQuery({ queryKey: ['txns', qs.toString()], queryFn: () => api<any[]>(`/api/txns?${qs}`) });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<any[]>('/api/accounts') });

  const groups: [string, any[]][] = [];
  for (const t of q.data ?? []) {
    const g = groups[groups.length - 1];
    if (g && g[0] === t.date) g[1].push(t); else groups.push([t.date, [t]]);
  }
  const dayOut = (ts: any[]) => ts.filter((t) => t.status === 'posted').reduce((s, t) =>
    s + (t.postings as any[]).filter((p) => p.class === 'expense').reduce((a, p) => a + p.amount, 0), 0);
  const account = accounts.data?.find((a) => a.id === params.get('accountId'));
  const filters: string[] = [];
  if (params.get('from') && params.get('to')) filters.push(params.get('to') === addDays(params.get('from')!, 1) ? shortDate(params.get('from')!) : `${shortDate(params.get('from')!)} – ${shortDate(addDays(params.get('to')!, -1))}`);
  if (account) filters.push(account.name);
  if (params.get('min')) filters.push(`above ${money(Number(params.get('min')), { whole: true })}`);
  if (params.get('categoryId')) filters.push('one category');

  return (
    <>
      <h1 className="page-title">Activity</h1>
      <input className="input" type="search" placeholder='Search merchant, note, tag — or "above 5000"' value={text} onChange={(e) => setText(e.target.value)} aria-label="Search transactions" />
      <div className="chips" style={{ marginTop: 10 }}>
        {KINDS.map(([k, label]) => (
          <button key={k} className={`chip ${(params.get('kind') ?? '') === k ? 'on' : ''}`} onClick={() => set('kind', k || null)}>{label}</button>
        ))}
        <button className={`chip ${params.get('deleted') ? 'on' : ''}`} onClick={() => set('deleted', params.get('deleted') ? null : '1')}>Show deleted</button>
      </div>
      {filters.length > 0 && (
        <div className="banner" style={{ marginTop: 12 }}>
          <span>Filtered: {filters.join(' · ')}</span>
          <button onClick={() => { setText(''); setParams(new URLSearchParams(), { replace: true }); }}>Clear</button>
        </div>
      )}
      <div style={{ marginTop: 6 }}>
        {q.isLoading && <div className="card"><div className="skeleton" /></div>}
        {q.data?.length === 0 && <div className="empty">No transactions match.</div>}
        {groups.map(([day, ts]) => {
          const out = dayOut(ts);
          return (
            <div key={day}>
              <div className="day-head"><span>{dayLabel(day)}</span>{out !== 0 && <span className="num">{money(out, { whole: true })} spent</span>}</div>
              <div className="list">{ts.map((t) => <TxnRow key={t.id} t={t} />)}</div>
            </div>
          );
        })}
        {(q.data?.length ?? 0) >= 300 && <p className="tiny faint" style={{ textAlign: 'center' }}>Showing the latest 300. Narrow the search to see older ones.</p>}
      </div>
    </>
  );
}
