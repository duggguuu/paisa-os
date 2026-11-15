import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, money, compact, parseRupees, todayIST, addDays, dayLabel } from '../lib';
import { Sheet, useUi } from '../App';
import { CategoryPicker } from '../components/CategoryPicker';
import { hourLabel } from '../components/Notifications';

type Reminder = { daysBefore: number; hour: number };
type MandateType = 'subscription' | 'upi_autopay' | 'enach' | 'card_autopay' | 'standing_instruction' | 'other';
const TYPES: [MandateType, string, string][] = [
  ['subscription', 'Subscription', '🔁'],
  ['upi_autopay', 'UPI AutoPay', '📲'],
  ['enach', 'e-NACH / NACH mandate', '🏦'],
  ['card_autopay', 'Card auto-pay', '💳'],
  ['standing_instruction', 'Bank standing instruction', '📄'],
  ['other', 'Other auto-debit', '•'],
];
const typeOf = (t: string) => TYPES.find((x) => x[0] === t) ?? TYPES[5];
const FREQS: [string, string, 'weekly' | 'monthly' | 'yearly', number][] = [
  ['weekly', 'Every week', 'weekly', 1], ['fortnightly', 'Every 2 weeks', 'weekly', 2], ['monthly', 'Every month', 'monthly', 1],
  ['quarterly', 'Every 3 months', 'monthly', 3], ['half', 'Every 6 months', 'monthly', 6], ['yearly', 'Every year', 'yearly', 1],
];
const freqKey = (cadence: string, every: number) => FREQS.find((f) => f[2] === cadence && f[3] === (every || 1))?.[0] ?? 'monthly';
const DAYS_BEFORE: [number, string][] = [[0, 'On the day'], [1, '1 day before'], [2, '2 days before'], [3, '3 days before'], [5, '5 days before'], [7, '1 week before'], [14, '2 weeks before']];
const perMonth = (r: any) => {
  const n = Number(r.amount), e = r.every || 1;
  return r.cadence === 'weekly' ? (n * 52) / 12 / e : r.cadence === 'yearly' ? n / 12 / e : n / e;
};
const daysUntil = (d: string) => Math.round((Date.parse(d) - Date.parse(todayIST())) / 86_400_000);
const whenText = (d: string) => { const n = daysUntil(d); return n < 0 ? `${-n} day${n === -1 ? '' : 's'} overdue` : n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`; };

export function Mandates() {
  const q = useQuery({ queryKey: ['recurring'], queryFn: () => api<any>('/api/recurring') });
  const [editing, setEditing] = useState<any | null>(null);
  const rules: any[] = (q.data?.rules ?? []).filter((r: any) => r.mandate);
  const active = rules.filter((r) => r.is_active).sort((a, b) => a.next_due.localeCompare(b.next_due));
  const paused = rules.filter((r) => !r.is_active);
  const soon = active.filter((r) => daysUntil(r.next_due) <= 7);
  const monthly = active.reduce((s, r) => s + perMonth(r), 0);

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Mandates &amp; subscriptions</h1>
        <button className="btn small accent" onClick={() => setEditing({})}>+ Add</button>
      </div>
      {!q.data ? <div className="card"><div className="skeleton" /></div> : (
        <>
          <div className="totals" style={{ marginTop: 0 }}>
            <div><span>Per month</span><b className="num exp">{money(Math.round(monthly), { whole: true })}</b></div>
            <div><span>Per year</span><b className="num">{compact(Math.round(monthly * 12))}</b></div>
            <div><span>Active</span><b className="num">{active.length}</b></div>
          </div>
          {rules.length === 0 && (
            <div className="card empty-state" style={{ marginTop: 12 }}>
              <div style={{ fontSize: 30 }}>🔁</div>
              <b>Track every auto-debit in one place</b>
              <p className="small muted">Netflix, Spotify, gym, insurance premiums, SIPs, EMIs on UPI AutoPay or e-NACH… Add each one with its renewal date and when you want a reminder, so nothing renews without you knowing.</p>
              <button className="btn accent" onClick={() => setEditing({})}>Add your first one</button>
            </div>
          )}
          {soon.length > 0 && <Group title="Renewing in the next 7 days" rows={soon} onOpen={setEditing} />}
          {active.length > soon.length && <Group title="Active" rows={active.filter((r) => !soon.includes(r))} onOpen={setEditing} />}
          {paused.length > 0 && <Group title="Paused or cancelled" rows={paused} onOpen={setEditing} />}
          <p className="tiny faint" style={{ margin: '12px 2px' }}>
            Reminders arrive as notifications once they're on in <Link to="/settings" style={{ color: 'var(--accent)' }}>Settings → Notifications</Link>. These also appear in <Link to="/recurring" style={{ color: 'var(--accent)' }}>Bills &amp; recurring</Link>, and count towards Safe to spend.
          </p>
        </>
      )}
      {editing && <MandateSheet rule={editing.id ? editing : null} onClose={() => setEditing(null)} />}
    </>
  );
}

function Group({ title, rows, onOpen }: { title: string; rows: any[]; onOpen: (r: any) => void }) {
  return (
    <div className="section">
      <div className="section-title">{title}</div>
      <div className="list">
        {rows.map((r) => {
          const t = typeOf(r.mandate.type);
          const n = daysUntil(r.next_due);
          return (
            <button key={r.id} className="item" onClick={() => onOpen(r)}>
              <div className="avatar" aria-hidden>{t[2]}</div>
              <div className="grow">
                <div className="title">{r.name}{r.reminders?.length ? <span className="faint" title="Reminders set"> 🔔</span> : null}</div>
                <div className="sub">{t[1]} · {r.account_name} · {FREQS.find((f) => f[0] === freqKey(r.cadence, r.every))?.[1].toLowerCase()}</div>
                <div className={`sub ${r.is_active && n <= 1 ? 'exp' : ''}`}>{r.is_active ? `${r.mandate.type === 'subscription' ? 'Renews' : 'Debits'} ${dayLabel(r.next_due)} · ${whenText(r.next_due)}` : 'Paused'}</div>
              </div>
              <div className="amt num">{money(Number(r.amount), { whole: true })}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MandateSheet({ rule, onClose }: { rule: any | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<any[]>('/api/accounts') });
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api<any[]>('/api/categories') });
  const payFrom = (accounts.data ?? []).filter((a) => ['bank', 'credit_card', 'wallet', 'cash'].includes(a.kind) && !a.is_archived);
  const defaultCat = useMemo(() => (cats.data ?? []).find((c) => c.class === 'expense' && c.name === 'Subscriptions')?.id ?? null, [cats.data]);
  const m = rule?.mandate ?? {};
  const [type, setType] = useState<MandateType>(m.type ?? 'subscription');
  const [name, setName] = useState(rule?.name ?? '');
  const [amount, setAmount] = useState(rule ? String(Number(rule.amount) / 100) : '');
  const [maxAmount, setMaxAmount] = useState(m.maxAmount ? String(m.maxAmount / 100) : '');
  const [freq, setFreq] = useState(rule ? freqKey(rule.cadence, rule.every) : 'monthly');
  const [nextDue, setNextDue] = useState(rule?.next_due ?? addDays(todayIST(), 1));
  const [accountId, setAccountId] = useState<string | null>(rule?.account_id ?? null);
  const [categoryId, setCategoryId] = useState<string | null>(rule?.category_id ?? null);
  const [autoPost, setAutoPost] = useState<boolean>(rule?.auto_post ?? true);
  const [reminders, setReminders] = useState<Reminder[]>(rule?.reminders ?? [{ daysBefore: 1, hour: 9 }]);
  const [umrn, setUmrn] = useState(m.umrn ?? '');
  const [notes, setNotes] = useState(m.notes ?? '');
  const [endDate, setEndDate] = useState(rule?.end_date ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const acc = accountId ?? payFrom.find((a) => a.kind === 'credit_card' && type === 'card_autopay')?.id ?? payFrom[0]?.id ?? null;
  const cat = categoryId ?? defaultCat;
  const isMandate = type !== 'subscription';

  function body(extra: object = {}) {
    const f = FREQS.find((x) => x[0] === freq)!;
    const [y, mo, d] = nextDue.split('-').map(Number);
    const dow = ((new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7) + 1;
    return {
      name: name.trim(), kind: 'expense', amount: parseRupees(amount), accountId: acc, categoryId: cat, merchant: name.trim(),
      cadence: f[2], every: f[3], day: f[2] === 'weekly' ? dow : d, month: f[2] === 'yearly' ? mo : null,
      firstDue: nextDue, endDate: endDate || null, autoPost,
      mandate: { type, provider: name.trim() || null, umrn: umrn.trim() || null, maxAmount: maxAmount ? parseRupees(maxAmount) : null, notes: notes.trim() || null },
      reminders, ...extra,
    };
  }
  async function save() {
    setErr(null);
    if (!name.trim()) return setErr('What is it called?');
    if (!parseRupees(amount)) return setErr('Enter the amount');
    if (!acc) return setErr('Pick the account or card it is charged to');
    if (!cat) return setErr('Pick a category');
    setBusy(true);
    try {
      if (rule) await api(`/api/recurring/${rule.id}`, { method: 'PUT', body: body({ isActive: rule.is_active }) });
      else await api('/api/recurring', { method: 'POST', body: body() });
      await qc.invalidateQueries();
      toast(rule ? 'Saved' : `Added ${name.trim()}`);
      onClose();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  async function act(kind: 'log' | 'pause' | 'resume' | 'delete') {
    if (!rule) return;
    setErr(null);
    try {
      if (kind === 'log') await api(`/api/recurring/${rule.id}/log`, { method: 'POST', body: {} });
      else if (kind === 'delete') { if (!confirm(`Remove ${rule.name}? Past payments stay in your history.`)) return; await api(`/api/recurring/${rule.id}`, { method: 'DELETE' }); }
      else await api(`/api/recurring/${rule.id}`, { method: 'PUT', body: body({ isActive: kind === 'resume', firstDue: undefined }) });
      await qc.invalidateQueries();
      toast(kind === 'log' ? 'Logged as paid; next renewal moved on' : kind === 'delete' ? 'Removed' : kind === 'pause' ? 'Paused: no reminders until you resume' : 'Resumed');
      onClose();
    } catch (e: any) { setErr(e.message); }
  }
  const setRem = (i: number, patch: Partial<Reminder>) => setReminders((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Sheet title={rule ? rule.name : 'Add a mandate or subscription'} onClose={onClose}>
      <div className="field"><label>Type</label>
        <div className="chips">{TYPES.map(([k, label, icon]) => <button type="button" key={k} className={`chip ${type === k ? 'on' : ''}`} onClick={() => setType(k)}>{icon} {label}</button>)}</div>
      </div>
      <div className="field"><label>Name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={isMandate ? 'e.g. SIP – Index fund, Health insurance' : 'e.g. Netflix, Spotify, Gym'} /></div>
      <div className="grid2">
        <div className="field"><label>Amount (₹)</label><input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div className="field"><label>How often</label>
          <select className="input" value={freq} onChange={(e) => setFreq(e.target.value)}>{FREQS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </div>
      </div>
      <div className="grid2">
        <div className="field"><label>{isMandate ? 'Next debit date' : 'Next renewal date'}</label><input className="input" type="date" value={nextDue} onChange={(e) => setNextDue(e.target.value)} /></div>
        <div className="field"><label>Ends on (optional)</label><input className="input" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></div>
      </div>
      <div className="field"><label>Charged to</label>
        <div className="chips">{payFrom.map((a) => <button type="button" key={a.id} className={`chip ${acc === a.id ? 'on' : ''}`} onClick={() => setAccountId(a.id)}>{a.icon ?? ''} {a.name}</button>)}</div>
      </div>

      <div className="field"><label>Remind me</label>
        <div className="rem-list">
          {reminders.map((r, i) => (
            <div key={i} className="rem-row">
              <select className="input" value={r.daysBefore} onChange={(e) => setRem(i, { daysBefore: Number(e.target.value) })} aria-label="When">
                {DAYS_BEFORE.map(([d, l]) => <option key={d} value={d}>{l}</option>)}
              </select>
              <span className="tiny faint">at</span>
              <select className="input" value={r.hour} onChange={(e) => setRem(i, { hour: Number(e.target.value) })} aria-label="Time">
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
              </select>
              <button type="button" className="icon-btn small" aria-label="Remove reminder" onClick={() => setReminders((rs) => rs.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          {reminders.length < 6 && <button type="button" className="btn small" onClick={() => setReminders((rs) => [...rs, { daysBefore: rs.length ? 0 : 1, hour: rs.length ? 9 : 9 }])}>+ Reminder</button>}
          {reminders.length === 0 && <span className="tiny faint">No reminders for this one.</span>}
        </div>
      </div>

      <div className="field"><label>Category</label>
        <CategoryPicker cats={cats.data ?? []} cls="expense" value={cat} onChange={setCategoryId} />
      </div>
      {isMandate && (
        <div className="grid2">
          <div className="field"><label>Maximum debit (₹, optional)</label><input className="input num" inputMode="decimal" value={maxAmount} onChange={(e) => setMaxAmount(e.target.value)} placeholder="Mandate limit" /></div>
          <div className="field"><label>UMRN / reference (optional)</label><input className="input" value={umrn} onChange={(e) => setUmrn(e.target.value)} /></div>
        </div>
      )}
      <div className="field"><input className="input" placeholder="Notes (plan, how to cancel, login email…)" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      <label className="toggle"><input type="checkbox" checked={autoPost} onChange={(e) => setAutoPost(e.target.checked)} />
        <span><b>Add it as an expense on the renewal date</b><span className="tiny faint">Turn off to confirm it yourself each time.</span></span></label>
      {err && <p className="error">{err}</p>}
      <button className="btn accent block" disabled={busy} onClick={save}>{busy ? 'Saving…' : rule ? 'Save' : 'Add'}</button>
      {rule && (
        <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          {rule.is_active && <button className="btn grow" onClick={() => act('log')}>Mark paid now</button>}
          <button className="btn grow" onClick={() => act(rule.is_active ? 'pause' : 'resume')}>{rule.is_active ? 'Pause' : 'Resume'}</button>
          <button className="btn danger grow" onClick={() => act('delete')}>Remove</button>
        </div>
      )}
    </Sheet>
  );
}
