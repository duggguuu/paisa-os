import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, money, compact, parseRupees, dayLabel, todayIST } from '../lib';
import { Sheet, useUi } from '../App';

export interface Goal {
  id: string; name: string; icon: string | null; target: number; targetDate: string | null; accountId: string | null; accountName: string | null;
  saved: number; progress: number; remaining: number; pacePerMonth: number; reachOn: string | null; neededPerMonth: number | null; onTrack: boolean; done: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const longDate = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8))}, ${d.slice(0, 4)}`;

export function GoalBar({ g }: { g: Goal }) {
  const pct = Math.round(g.progress * 100);
  return (
    <>
      <div className="goal-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${g.name} progress`}>
        <span className="fill" style={{ width: `${Math.max(pct, 2)}%` }} />
        <span className="bubble" style={{ left: `${Math.min(Math.max(pct, 6), 94)}%` }}>{pct}%</span>
      </div>
      <div className="goal-ends num"><span>{money(g.saved, { whole: true })}</span><span>{money(g.target, { whole: true })}</span></div>
    </>
  );
}

export function ReachPill({ g }: { g: Goal }) {
  if (g.done) return <div className="reach-pill"><span className="ri">🎉</span>Goal reached. Well done!</div>;
  if (!g.reachOn) return <div className="reach-pill warn"><span className="ri">⏳</span>Nothing added in 3 months. Boost it to get a finish date.</div>;
  const late = g.targetDate && g.reachOn > g.targetDate;
  return (
    <div className={`reach-pill ${late ? 'warn' : ''}`}>
      <span className="ri">{late ? '⚠️' : '🏆'}</span>
      <span>You will reach your goal on <b>{longDate(g.reachOn)}</b>{late && g.neededPerMonth ? `. To finish by ${longDate(g.targetDate!)}, add ${compact(g.neededPerMonth)}/month` : ''}</span>
    </div>
  );
}

export function Goals() {
  const q = useQuery({ queryKey: ['goals'], queryFn: () => api<Goal[]>('/api/goals') });
  const [edit, setEdit] = useState<Partial<Goal> | null>(null);
  const [boost, setBoost] = useState<Goal | null>(null);
  const goals = q.data ?? [];
  const [main, ...others] = [...goals].sort((a, b) => Number(a.done) - Number(b.done) || b.progress - a.progress);

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Goals</h1>
        <button className="btn small" onClick={() => setEdit({})}>+ New goal</button>
      </div>
      {q.data && goals.length === 0 && (
        <div className="card empty-state">
          <div style={{ fontSize: 34 }}>🎯</div>
          <b>Reach your goals faster, with a plan that adapts</b>
          <p className="small muted">Track every goal, see your finish date, and boost your progress with a single tap. Link an FD or savings account, or just set money aside here.</p>
          <button className="btn cyan" onClick={() => setEdit({})}>Create a goal</button>
        </div>
      )}
      {main && (
        <div className="goal-card">
          <div className="g-head" onClick={() => setEdit(main)} role="button">
            <span className="g-ico">{main.icon ?? '🎯'}</span>
            <div className="grow"><div className="g-name">{main.name}</div>
              <div className="g-sub">{main.accountName ? `Tracks ${main.accountName}` : 'Money set aside'}{main.targetDate ? ` · by ${dayLabel(main.targetDate)}` : ''}</div></div>
          </div>
          <GoalBar g={main} />
          <ReachPill g={main} />
          {!main.done && <button className="btn cyan" onClick={() => setBoost(main)}>Boost My Goal</button>}
        </div>
      )}
      {others.length > 0 && (
        <div className="section">
          <div className="section-title">Other goals</div>
          <div className="list">
            {others.map((g) => (
              <div key={g.id} className="goal-mini" role="button" onClick={() => setBoost(g)}>
                <div className="row">
                  <span className="avatar" aria-hidden>{g.icon ?? '🎯'}</span>
                  <div className="grow"><div className="title" style={{ fontWeight: 650 }}>{g.name}</div>
                    <div className="sub tiny faint">{g.done ? 'Reached 🎉' : g.reachOn ? `On pace for ${longDate(g.reachOn)}` : 'No recent progress'}</div></div>
                  <button className="btn small" onClick={(e) => { e.stopPropagation(); setEdit(g); }}>Edit</button>
                </div>
                <GoalBar g={g} />
              </div>
            ))}
          </div>
        </div>
      )}
      {edit && <GoalSheet initial={edit} onClose={() => setEdit(null)} />}
      {boost && <BoostSheet goal={boost} onClose={() => setBoost(null)} />}
    </>
  );
}

const ICONS = ['🎯', '🛟', '💻', '📱', '🏖️', '✈️', '🚗', '🏠', '💍', '🎓', '🎁', '🏍️'];

export function GoalSheet({ initial, onClose }: { initial: Partial<Goal>; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<any[]>('/api/accounts') });
  const linkable = (accounts.data ?? []).filter((a) => ['bank', 'fd', 'investment', 'wallet'].includes(a.kind) && !a.is_archived);
  const saved = !!initial.id;
  const [name, setName] = useState(initial.name ?? '');
  const [icon, setIcon] = useState(initial.icon ?? '🎯');
  const [target, setTarget] = useState(initial.target ? String(initial.target / 100) : '');
  const [date, setDate] = useState(initial.targetDate ?? '');
  const [accountId, setAccountId] = useState<string | null>(initial.accountId ?? null);
  const [start, setStart] = useState('');
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null);
    const t = parseRupees(target);
    if (!name.trim()) return setErr('Name the goal');
    if (!t) return setErr('Enter the target amount');
    const body = { name: name.trim(), icon, target: t, targetDate: date || null, accountId, startingAmount: !saved && !accountId ? parseRupees(start) ?? 0 : undefined };
    try {
      await api(saved ? `/api/goals/${initial.id}` : '/api/goals', { method: saved ? 'PUT' : 'POST', body });
      await qc.invalidateQueries();
      toast(saved ? 'Goal saved' : `Goal created: ${name.trim()}`);
      onClose();
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <Sheet title={saved ? 'Edit goal' : 'New goal'} onClose={onClose}>
      <div className="chips" style={{ marginBottom: 12 }}>{ICONS.map((i) => <button key={i} type="button" className={`chip ${icon === i ? 'on' : ''}`} onClick={() => setIcon(i)}>{i}</button>)}</div>
      <div className="field"><input className="input" placeholder="What are you saving for?" value={name} onChange={(e) => setName(e.target.value)} aria-label="Goal name" /></div>
      <div className="amount-wrap"><span className="cur">₹</span>
        <input className="amount-input" inputMode="decimal" placeholder="Target" value={target} onChange={(e) => setTarget(e.target.value.replace(/[^\d.,]/g, ''))} aria-label="Target amount" /></div>
      <div className="field"><label>By when? (optional)</label><input type="date" className="input" min={todayIST()} value={date} onChange={(e) => setDate(e.target.value)} /></div>
      <div className="field"><label>Where is the money?</label>
        <div className="chips">
          <button type="button" className={`chip ${!accountId ? 'on' : ''}`} onClick={() => setAccountId(null)}>Just set aside here</button>
          {linkable.map((a) => <button type="button" key={a.id} className={`chip ${accountId === a.id ? 'on' : ''}`} onClick={() => setAccountId(a.id)}>{a.icon ?? ''} {a.name}</button>)}
        </div>
        <span className="tiny faint">{accountId ? "Progress follows this account's balance. Best for a dedicated FD or savings account." : 'You add to it with Boost. Nothing moves in your accounts.'}</span>
      </div>
      {!saved && !accountId && (
        <div className="field"><label>Already saved (optional)</label><input className="input num" inputMode="decimal" placeholder="₹0" value={start} onChange={(e) => setStart(e.target.value)} /></div>
      )}
      {err && <p className="error">{err}</p>}
      <button className="btn cyan block" onClick={save}>{saved ? 'Save goal' : 'Create goal'}</button>
      {saved && <button className="btn block danger" style={{ marginTop: 8 }} onClick={async () => { if (confirm(`Remove ${initial.name}?`)) { await api(`/api/goals/${initial.id}`, { method: 'DELETE' }); await qc.invalidateQueries(); onClose(); } }}>Remove goal</button>}
    </Sheet>
  );
}

export function BoostSheet({ goal, onClose }: { goal: Goal; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<any[]>('/api/accounts') });
  const sources = (accounts.data ?? []).filter((a) => ['bank', 'cash', 'wallet'].includes(a.kind) && !a.is_archived && a.id !== goal.accountId);
  const suggested = goal.neededPerMonth ?? (goal.remaining > 0 ? Math.min(goal.remaining, 5000_00) : 1000_00);
  const [amount, setAmount] = useState(String(Math.round(suggested / 100)));
  const [from, setFrom] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fromId = from ?? sources.find((a) => a.meta?.salary)?.id ?? sources[0]?.id ?? null;
  const chips = [1000_00, 5000_00, 10000_00, goal.neededPerMonth].filter((x): x is number => !!x && x <= Math.max(goal.remaining, 1000_00));

  async function go() {
    setErr(null);
    const p = parseRupees(amount);
    if (!p) return setErr('Enter an amount');
    try {
      await api(`/api/goals/${goal.id}/boost`, { method: 'POST', body: { amount: p, fromAccountId: goal.accountId ? fromId : null } });
      await qc.invalidateQueries();
      toast(`Boosted ${goal.name} by ${money(p, { whole: true })}`);
      onClose();
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <Sheet title={`Boost ${goal.name}`} onClose={onClose}>
      <GoalBar g={goal} />
      <div style={{ height: 14 }} />
      <div className="amount-wrap"><span className="cur">₹</span>
        <input className="amount-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))} aria-label="Amount" autoFocus /></div>
      <div className="amount-chips">{[...new Set(chips)].map((c) => <button key={c} className="chip" onClick={() => setAmount(String(Math.round(c / 100)))}>{compact(c)}{c === goal.neededPerMonth ? ' · on-time pace' : ''}</button>)}</div>
      {goal.accountId ? (
        <div className="field"><label>Move it from</label>
          <div className="chips">{sources.map((a) => <button key={a.id} className={`chip ${fromId === a.id ? 'on' : ''}`} onClick={() => setFrom(a.id)}>{a.icon ?? ''} {a.name}</button>)}</div>
          <span className="tiny faint">Recorded as a transfer into {goal.accountName}. It's saving, not spending.</span>
        </div>
      ) : <p className="tiny faint">This sets the money aside for the goal. Your account balances don't change.</p>}
      {err && <p className="error">{err}</p>}
      <button className="btn cyan block" onClick={go}>Boost My Goal</button>
    </Sheet>
  );
}
