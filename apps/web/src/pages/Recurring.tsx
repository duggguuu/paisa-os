import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, money, parseRupees, shortDate, todayIST, dayLabel } from '../lib';
import { Sheet, useUi } from '../App';
import { tint } from '../components/Icons';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ord = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][n % 10 > 3 || Math.floor(n / 10) % 10 === 1 ? 0 : n % 10]}`;

export function schedule(r: any) {
  if (r.cadence === 'weekly') return `Every ${WEEKDAYS[r.day - 1]}`;
  if (r.cadence === 'yearly') return `Every ${ord(r.day)} ${MONTHS[(r.month ?? 1) - 1]}`;
  return r.day >= 31 ? 'Monthly, last day' : `Monthly on the ${ord(r.day)}`;
}

export function Recurring() {
  const qc = useQueryClient();
  const { toast } = useUi();
  const q = useQuery({ queryKey: ['recurring'], queryFn: () => api<any>('/api/recurring') });
  const [edit, setEdit] = useState<any | null>(null);
  const rules: any[] = q.data?.rules ?? [];
  const today = todayIST();
  const active = rules.filter((r) => r.is_active);
  const due = active.filter((r) => r.next_due <= today && !r.auto_post);
  const later = active.filter((r) => !due.includes(r));
  const paused = rules.filter((r) => !r.is_active);

  async function act(r: any, what: 'log' | 'skip') {
    try {
      await api(`/api/recurring/${r.id}/${what}`, { method: 'POST', body: {} });
      await qc.invalidateQueries();
      toast(what === 'log' ? `Logged ${r.name} · ${money(Number(r.amount))}` : `Skipped ${r.name} for ${shortDate(r.next_due)}`);
    } catch (e: any) { toast(e.message); }
  }

  const row = (r: any) => (
    <div key={r.id} className="item rule" onClick={() => setEdit(r)} role="button" tabIndex={0}>
      <div className="avatar" style={tint(r.category_icon ?? r.account_icon ?? r.name)} aria-hidden>{r.category_icon ?? (r.kind === 'transfer' ? '⇄' : r.account_icon) ?? '•'}</div>
      <div className="grow">
        <div className="title">{r.name}</div>
        <div className="sub">{schedule(r)} · {r.kind === 'transfer' ? `${r.account_name} → ${r.to_account_name}` : `${r.category_name} · ${r.account_name}`}{r.auto_post ? ' · auto' : ''}</div>
        {r.is_active && (
          <div className="sub" style={{ color: r.next_due < today ? 'var(--up)' : r.next_due === today ? 'var(--warn)' : undefined }}>
            {r.next_due < today ? `Overdue since ${dayLabel(r.next_due)}` : r.next_due === today ? 'Due today' : `Next: ${dayLabel(r.next_due)}`}
          </div>
        )}
      </div>
      <div className="amt">
        <div className={`num ${r.kind === 'income' ? 'pos' : ''}`}>{r.kind === 'income' ? '+' : ''}{money(Number(r.amount), { whole: true })}</div>
        {r.is_active && r.next_due <= today && !r.auto_post && (
          <div className="row" style={{ gap: 6, marginTop: 6, justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
            <button className="btn small" onClick={() => act(r, 'skip')}>Skip</button>
            <button className="btn small accent" onClick={() => act(r, 'log')}>Log</button>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Bills &amp; recurring</h1>
        <button className="btn small" onClick={() => setEdit({})}>+ Add</button>
      </div>

      {q.data && (
        <div className="hero">
          <div className="hero-label">Still to pay this month</div>
          <div className="hero-num num">{money(q.data.upcoming.total, { whole: true })}</div>
          <div className="meta"><span>{q.data.upcoming.items.length} {q.data.upcoming.items.length === 1 ? 'payment' : 'payments'} set aside in safe-to-spend</span></div>
        </div>
      )}

      {q.data && rules.length === 0 && (
        <div className="card empty-state">
          <div style={{ fontSize: 34 }}>🔁</div>
          <b>Add your regular payments</b>
          <p className="small muted">Rent, SIPs, EMIs, subscriptions and salary. Paisa reminds you when each is due, logs it in one tap (or automatically), and sets the money aside in safe-to-spend.</p>
          <button className="btn accent" onClick={() => setEdit({})}>Add the first one</button>
        </div>
      )}

      {due.length > 0 && <div className="section"><div className="section-title">Due now</div><div className="list">{due.map(row)}</div></div>}
      {later.length > 0 && <div className="section"><div className="section-title">Coming up</div><div className="list">{later.map(row)}</div></div>}
      {paused.length > 0 && <div className="section"><div className="section-title">Paused or ended</div><div className="list">{paused.map(row)}</div></div>}

      {edit && <RuleSheet initial={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

/** Add or edit a recurring rule. `initial` may be a saved rule, or a suggestion from Insights. */
export function RuleSheet({ initial, onClose }: { initial: any; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<any[]>('/api/accounts') });
  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api<any[]>('/api/categories') });
  const saved = !!initial.id;
  const [name, setName] = useState<string>(initial.name ?? '');
  const [kind, setKind] = useState<'expense' | 'income' | 'transfer'>(initial.kind ?? 'expense');
  const [amount, setAmount] = useState(initial.amount ? String(Number(initial.amount) / 100) : '');
  const [accountId, setAccountId] = useState<string | null>(initial.account_id ?? initial.accountId ?? null);
  const [categoryId, setCategoryId] = useState<string | null>(initial.category_id ?? initial.categoryId ?? null);
  const [toAccountId, setToAccountId] = useState<string | null>(initial.to_account_id ?? initial.toAccountId ?? null);
  const [cadence, setCadence] = useState<'weekly' | 'monthly' | 'yearly'>(initial.cadence ?? 'monthly');
  const [day, setDay] = useState<number>(initial.day ?? Number(todayIST().slice(8)));
  const [month, setMonth] = useState<number>(initial.month ?? Number(todayIST().slice(5, 7)));
  const [firstDue, setFirstDue] = useState<string>(saved ? initial.next_due : '');
  const [autoPost, setAutoPost] = useState<boolean>(initial.auto_post ?? initial.autoPost ?? false);
  const [active, setActive] = useState<boolean>(initial.is_active ?? true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const money_ = (accounts.data ?? []).filter((a) => ['bank', 'cash', 'wallet', 'credit_card'].includes(a.kind) && !a.is_archived);
  const targets = (accounts.data ?? []).filter((a) => (a.class === 'asset' || a.class === 'liability') && !a.is_archived && a.id !== accountId);
  const cats = (categories.data ?? []).filter((c) => c.class === (kind === 'income' ? 'income' : 'expense'));
  const byId = new Map(cats.map((c) => [c.id, c]));
  const leaf = cats.filter((c) => !cats.some((x) => x.parent_id === c.id));

  async function save() {
    setErr(null);
    const paise = parseRupees(amount);
    if (!name.trim()) return setErr('Give it a name');
    if (!paise) return setErr('Enter the amount');
    if (!accountId) return setErr('Pick the account');
    if (kind === 'transfer' ? !toAccountId : !categoryId) return setErr(kind === 'transfer' ? 'Pick where the money goes' : 'Pick a category');
    const body = {
      name: name.trim(), kind, amount: paise, accountId, categoryId: kind === 'transfer' ? null : categoryId, toAccountId: kind === 'transfer' ? toAccountId : null,
      merchant: initial.merchant ?? name.trim(), cadence, day: cadence === 'weekly' ? Math.min(day, 7) : day, month: cadence === 'yearly' ? month : null,
      firstDue: firstDue || undefined, autoPost, isActive: active,
    };
    setBusy(true);
    try {
      await api(saved ? `/api/recurring/${initial.id}` : '/api/recurring', { method: saved ? 'PUT' : 'POST', body });
      await qc.invalidateQueries();
      toast(saved ? 'Saved' : `Tracking ${name.trim()}`);
      onClose();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  async function remove() {
    if (!confirm(`Remove ${initial.name}? Past transactions stay.`)) return;
    await api(`/api/recurring/${initial.id}`, { method: 'DELETE' });
    await qc.invalidateQueries();
    onClose();
  }

  return (
    <Sheet title={saved ? 'Edit recurring' : 'New recurring'} onClose={onClose}>
      <div className="seg full" style={{ marginBottom: 12 }}>
        {(['expense', 'income', 'transfer'] as const).map((k) => (
          <button type="button" key={k} className={kind === k ? 'on' : ''} onClick={() => { setKind(k); setCategoryId(null); }}>
            {k === 'expense' ? 'Bill / expense' : k === 'income' ? 'Income' : 'SIP / transfer'}
          </button>
        ))}
      </div>
      <div className="amount-wrap"><span className="cur">₹</span>
        <input className="amount-input" inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))} aria-label="Amount" /></div>
      <div className="field"><input className="input" placeholder={kind === 'transfer' ? 'Name (e.g. Nifty 50 SIP)' : kind === 'income' ? 'Name (e.g. Salary)' : 'Name (e.g. Rent, Netflix)'} value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" /></div>

      {kind !== 'transfer' && (
        <div className="field"><label>Category</label>
          <select className="input" value={categoryId ?? ''} onChange={(e) => setCategoryId(e.target.value || null)}>
            <option value="">Choose…</option>
            {leaf.map((c) => <option key={c.id} value={c.id}>{c.parent_id ? `${byId.get(c.parent_id)?.name} › ` : ''}{c.name}</option>)}
          </select>
        </div>
      )}
      <div className="field"><label>{kind === 'income' ? 'Paid into' : kind === 'transfer' ? 'From' : 'Paid from'}</label>
        <div className="chips">{money_.map((a) => <button type="button" key={a.id} className={`chip ${accountId === a.id ? 'on' : ''}`} onClick={() => setAccountId(a.id)}>{a.icon ?? ''} {a.name}</button>)}</div>
      </div>
      {kind === 'transfer' && (
        <div className="field"><label>To</label>
          <div className="chips">{targets.map((a) => <button type="button" key={a.id} className={`chip ${toAccountId === a.id ? 'on' : ''}`} onClick={() => setToAccountId(a.id)}>{a.icon ?? ''} {a.name}</button>)}</div>
        </div>
      )}

      <div className="field"><label>Repeats</label>
        <div className="seg full">{(['weekly', 'monthly', 'yearly'] as const).map((c) => <button type="button" key={c} className={cadence === c ? 'on' : ''} onClick={() => setCadence(c)}>{c[0].toUpperCase() + c.slice(1)}</button>)}</div>
      </div>
      {cadence === 'weekly' ? (
        <div className="field"><label>On</label>
          <div className="chips">{WEEKDAYS.map((w, i) => <button type="button" key={w} className={`chip ${day === i + 1 ? 'on' : ''}`} onClick={() => setDay(i + 1)}>{w}</button>)}</div>
        </div>
      ) : (
        <div className="grid2">
          <div className="field"><label>Day of month</label>
            <select className="input" value={day} onChange={(e) => setDay(Number(e.target.value))}>
              {Array.from({ length: 31 }, (_, i) => <option key={i} value={i + 1}>{i === 30 ? '31 / last day' : i + 1}</option>)}
            </select>
          </div>
          {cadence === 'yearly' && (
            <div className="field"><label>Month</label>
              <select className="input" value={month} onChange={(e) => setMonth(Number(e.target.value))}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select>
            </div>
          )}
        </div>
      )}
      <div className="field"><label>{saved ? 'Next due' : 'First due (optional)'}</label>
        <input type="date" className="input" value={firstDue} onChange={(e) => setFirstDue(e.target.value)} />
      </div>

      <label className="toggle">
        <input type="checkbox" checked={autoPost} onChange={(e) => setAutoPost(e.target.checked)} />
        <span><b>Log automatically</b><span className="tiny faint">On the due date, without asking. Best for fixed SIPs and subscriptions.</span></span>
      </label>
      {saved && (
        <label className="toggle">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span><b>Active</b><span className="tiny faint">Pause it to stop reminders and setting money aside.</span></span>
        </label>
      )}
      {err && <p className="error">{err}</p>}
      <button className="btn primary block" disabled={busy} onClick={save}>{busy ? 'Saving…' : saved ? 'Save changes' : 'Start tracking'}</button>
      {saved && <button className="btn block danger" style={{ marginTop: 8 }} onClick={remove}>Remove</button>}
    </Sheet>
  );
}
