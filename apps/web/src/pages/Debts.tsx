import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, money, compact, parseRupees, todayIST, dayLabel } from '../lib';
import { Sheet, useUi } from '../App';
import { tint } from '../components/Icons';

type Seg = 'owed' | 'iowe' | 'lent' | 'loans';
const SEGS: [Seg, string][] = [['owed', 'Owed to me'], ['iowe', 'I owe'], ['lent', 'Lent'], ['loans', 'Loans']];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthYear = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

/** Reducing-balance loan maths (mirrors the server). */
function loanMath(principal: number, rate: number, emi: number) {
  const r = rate / 100 / 12;
  const interest = principal * r;
  if (emi <= interest) return null;
  const n = r === 0 ? principal / emi : Math.log(emi / (emi - r * principal)) / Math.log(1 + r);
  const months = Math.ceil(n - 1e-9);
  const [y, m, d] = todayIST().split('-').map(Number);
  return { months, interest: Math.round(interest), payoff: new Date(Date.UTC(y, m - 1 + months, d)).toISOString().slice(0, 10), interestLeft: Math.round(emi * n - principal) };
}
const principalFromTotal = (total: number, rate: number, emi: number) => { const r = rate / 100 / 12; const n = total / emi; return r === 0 ? total : Math.round((emi * (1 - Math.pow(1 + r, -n))) / r); };

export function Debts() {
  const [params, setParams] = useSearchParams();
  const seg = (params.get('seg') as Seg) || (params.get('add') === 'loan' ? 'loans' : 'owed');
  const d = useQuery({ queryKey: ['debts'], queryFn: () => api<any>('/api/debts') });
  const [adding, setAdding] = useState<Seg | null>(params.get('add') === 'loan' ? 'loans' : null);
  const [editLoan, setEditLoan] = useState<any | null>(null);
  const t = d.data?.totals;

  const list = !d.data ? [] : seg === 'loans' ? d.data.loans : d.data[seg];
  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Owe &amp; owed</h1>
        <button className="btn small accent" onClick={() => setAdding(seg)}>+ Add</button>
      </div>
      {t && (
        <div className="totals card-totals" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginTop: 0 }}>
          <div><span>Owed to me</span><b className="num inc">{compact(t.owed)}</b></div>
          <div><span>I owe</span><b className="num exp">{compact(t.iowe)}</b></div>
          <div><span>Lent</span><b className="num">{compact(t.lent)}</b></div>
          <div><span>Loans</span><b className="num exp">{compact(t.loans)}</b></div>
        </div>
      )}
      <div className="tabs-line" role="tablist" style={{ marginTop: 10 }}>
        {SEGS.map(([k, l]) => <button key={k} role="tab" aria-selected={seg === k} className={seg === k ? 'on' : ''} onClick={() => setParams({ seg: k }, { replace: true })}>{l}</button>)}
      </div>

      {!d.data ? <div className="card"><div className="skeleton" /></div> : seg === 'loans' ? (
        <>
          {t.emi > 0 && <p className="small muted" style={{ margin: '10px 2px' }}>EMIs: <b className="num">{money(t.emi, { whole: true })}</b> a month, set aside in safe-to-spend until each is paid.</p>}
          {list.length === 0 && <div className="empty">No loans yet.</div>}
          {list.map((l: any) => (
            <div key={l.id} className="card" style={{ marginTop: 10 }}>
              <div className="spread"><b>{l.name}</b><b className="num exp">{money(l.outstanding, { whole: true })}</b></div>
              <div className="spread">
                <span className="tiny faint">principal outstanding{l.rate != null ? ` · ${l.rate}% a year` : ''}{l.type === 'interest_only' ? ' · interest only' : ''}</span>
                <button className="btn small" onClick={() => setEditLoan(l)}>Edit</button>
              </div>
              {l.type === 'interest_only' && l.emi && (
                <div className="loan-grid">
                  <div><span>Monthly interest</span><b className="num">{money(l.emi, { whole: true })}</b></div>
                  <div><span>Interest a year</span><b className="num">{money(l.emi * 12, { whole: true })}</b></div>
                  <div><span>Principal</span><b className="num">{money(l.outstanding, { whole: true })}</b></div>
                  <div><span>Principal due</span><b>{l.endDate ? monthYear(l.endDate) : 'Not set'}</b></div>
                </div>
              )}
              {l.type === 'interest_only' && <p className="tiny faint" style={{ margin: '6px 0 0' }}>Your payments only cover interest, so the {money(l.outstanding, { whole: true })} stays owed until you repay it. Logging a payment counts it all as spending. To part-pay, add a transfer from your bank to this loan.</p>}
              {l.type !== 'interest_only' && l.emi && (
                <div className="loan-grid">
                  <div><span>EMI</span><b className="num">{money(l.emi, { whole: true })}</b></div>
                  <div><span>Interest in next EMI</span><b className="num">{money(l.interestNow ?? 0, { whole: true })}</b></div>
                  <div><span>EMIs left</span><b className="num">{l.monthsLeft ?? '—'}</b></div>
                  <div><span>Paid off</span><b>{l.payoff ? monthYear(l.payoff) : '—'}</b></div>
                </div>
              )}
              {l.type !== 'interest_only' && l.interestLeft != null && <p className="tiny faint" style={{ margin: '6px 0 0' }}>About {money(l.interestLeft, { whole: true })} of interest left to pay. Each EMI logged from Bills splits into interest (spending) and principal.</p>}
              {l.nextEmi && <p className="small" style={{ margin: '8px 0 0' }}>Next {l.type === 'interest_only' ? 'payment' : 'EMI'} {dayLabel(l.nextEmi)} · <Link to="/recurring" style={{ color: 'var(--accent)' }}>Bills</Link></p>}
            </div>
          ))}
        </>
      ) : (
        <>
          {seg === 'owed' && (
            <p className="small muted" style={{ margin: '10px 2px' }}>
              Type what someone owes you now, or your Splitwise total. Or <Link to="/splitwise" style={{ color: 'var(--accent)' }}>read Splitwise screenshots</Link>.
            </p>
          )}
          <div className="list" style={{ marginTop: 8 }}>
            {list.length === 0 && <div className="empty">{seg === 'owed' ? 'Nobody owes you anything right now.' : seg === 'iowe' ? "You don't owe anyone." : 'No money lent out.'}</div>}
            {list.map((p: any) => (
              <button key={p.id} className="item" onClick={() => setAdding(seg)}>
                <div className="avatar" style={tint(p.name)} aria-hidden>{p.icon ?? '🧑'}</div>
                <div className="grow"><div className="title">{p.name}</div>{p.note && <div className="sub">{p.note}</div>}</div>
                <div className={`amt num ${p.balance > 0 ? 'inc' : 'exp'}`}>{money(Math.abs(p.balance), { whole: true })}</div>
              </button>
            ))}
          </div>
        </>
      )}

      {adding && adding !== 'loans' && <DebtSheet seg={adding} onClose={() => setAdding(null)} />}
      {adding === 'loans' && <LoanSheet params={params} onClose={() => { setAdding(null); if (params.get('add')) setParams({ seg: 'loans' }, { replace: true }); }} />}
      {editLoan && <LoanSheet params={new URLSearchParams()} loan={editLoan} onClose={() => setEditLoan(null)} />}
    </>
  );
}

function DebtSheet({ seg, onClose }: { seg: Seg; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [kind, setKind] = useState<'person' | 'splitwise'>('person');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [dir, setDir] = useState<'owed' | 'iowe'>(seg === 'iowe' ? 'iowe' : 'owed');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setErr(null);
    const p = parseRupees(amount || '0');
    if (p === null) return setErr('Enter an amount (0 means settled)');
    const segment = kind === 'splitwise' ? 'splitwise' : seg === 'lent' ? 'lent' : dir === 'owed' ? 'owed' : 'iowe';
    if (segment !== 'splitwise' && !name.trim()) return setErr('Who is it?');
    try {
      await api('/api/debts', { method: 'POST', body: { segment, name: name.trim() || undefined, amount: p, direction: dir, note: note.trim() || null } });
      await qc.invalidateQueries();
      toast(p === 0 ? 'Marked settled' : 'Balance updated');
      onClose();
    } catch (e: any) { setErr(e.message); }
  }
  return (
    <Sheet title={seg === 'lent' ? 'Money I lent' : 'Set a balance'} onClose={onClose}>
      {seg !== 'lent' && (
        <div className="seg full" style={{ marginBottom: 12 }}>
          <button className={kind === 'person' ? 'on' : ''} onClick={() => setKind('person')}>A person</button>
          <button className={kind === 'splitwise' ? 'on' : ''} onClick={() => setKind('splitwise')}>Splitwise overall</button>
        </div>
      )}
      {kind === 'person' && <div className="field"><label>Who</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" autoFocus /></div>}
      {seg !== 'lent' && (
        <div className="seg full" style={{ marginBottom: 12 }}>
          <button className={dir === 'owed' ? 'on' : ''} onClick={() => setDir('owed')}>{kind === 'splitwise' ? 'I am owed' : 'Owes me'}</button>
          <button className={dir === 'iowe' ? 'on' : ''} onClick={() => setDir('iowe')}>I owe</button>
        </div>
      )}
      <div className="amount-wrap"><span className="cur">₹</span><input className="amount-input" inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount" /></div>
      {seg === 'lent' && <div className="field"><input className="input" placeholder="Note (what for, when it's due back)" value={note} onChange={(e) => setNote(e.target.value)} /></div>}
      <p className="tiny faint">This sets the balance to exactly this amount, now (0 = settled). It's an adjustment, so it never counts as spending or income.</p>
      {err && <p className="error">{err}</p>}
      <button className="btn accent block" onClick={save}>Save</button>
    </Sheet>
  );
}

function LoanSheet({ params, loan, onClose }: { params: URLSearchParams; loan?: any; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<any[]>('/api/accounts') });
  const payFrom = (accounts.data ?? []).filter((a) => ['bank', 'cash', 'wallet'].includes(a.kind) && !a.is_archived);
  const rupees = (p: number | null | undefined) => (p ? String(Math.round(p / 100)) : '');
  const [type, setType] = useState<'emi' | 'interest_only'>((params.get('type') as any) ?? loan?.type ?? 'emi');
  const [lender, setLender] = useState(params.get('lender') ?? loan?.lender ?? '');
  const [amount, setAmount] = useState(params.get('amount') ?? rupees(loan?.outstanding));
  const [rate, setRate] = useState(params.get('rate') ?? (loan?.rate != null ? String(loan.rate) : ''));
  const [emi, setEmi] = useState(params.get('emi') ?? rupees(loan?.emi));
  const [mode, setMode] = useState<'total' | 'principal' | null>(loan ? 'principal' : null);
  const [emiDay, setEmiDay] = useState<number | null>(loan?.emiDay ?? null);
  const [endDate, setEndDate] = useState<string>(loan?.endDate ?? '');
  const [acc, setAcc] = useState<string | null>(loan?.fromAccountId ?? null);
  const [err, setErr] = useState<string | null>(null);
  const fromId = acc ?? payFrom.find((a) => a.meta?.salary)?.id ?? payFrom[0]?.id ?? null;

  const A = parseRupees(amount), R = Number(rate), E = parseRupees(emi);
  const views = useMemo(() => {
    if (!A || !E || !(R >= 0) || !rate) return null;
    const asPrincipal = loanMath(A, R, E);
    const p2 = principalFromTotal(A, R, E);
    return { asPrincipal, total: { principal: p2, math: loanMath(p2, R, E), emis: A / E } };
  }, [A, R, E, rate]);
  const chosenMode = type === 'interest_only' ? 'principal' : mode ?? (views && !views.asPrincipal ? 'total' : null);

  async function save() {
    setErr(null);
    if (!lender.trim() || !A || !E || !rate) return setErr('Fill in lender, amount, rate and the monthly payment');
    if (!chosenMode) return setErr('Say what the amount is: principal or total of remaining EMIs');
    if (!emiDay) return setErr('Pick the day the payment is debited');
    if (!fromId) return setErr('Pick the account it is paid from');
    try {
      const body = { lender: lender.trim(), type, mode: chosenMode, amount: A, rate: R, emi: E, emiDay, fromAccountId: fromId, endDate: type === 'interest_only' && endDate ? endDate : null };
      const r = await api<any>(loan ? `/api/loans/${loan.id}` : '/api/loans', { method: loan ? 'PUT' : 'POST', body });
      await qc.invalidateQueries();
      toast(`${loan ? 'Updated' : 'Added'} ${lender.trim()} loan · ${money(r.principal, { whole: true })} outstanding`);
      onClose();
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <Sheet title={loan ? `Edit ${loan.name}` : 'Add a loan'} onClose={onClose}>
      <div className="field"><label>What do the monthly payments do?</label>
        <div className="seg full">
          <button className={type === 'emi' ? 'on' : ''} onClick={() => setType('emi')}>Repay the loan (EMI)</button>
          <button className={type === 'interest_only' ? 'on' : ''} onClick={() => setType('interest_only')}>Interest only</button>
        </div>
      </div>
      <div className="field"><label>Lender</label><input className="input" value={lender} onChange={(e) => setLender(e.target.value)} placeholder="e.g. Bajaj Finance" /></div>
      <div className="grid2">
        <div className="field"><label>{type === 'interest_only' ? 'Principal owed (₹)' : 'Amount (₹)'}</label><input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div className="field"><label>Interest (% a year)</label><input className="input num" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} /></div>
      </div>
      <div className="field"><label>{type === 'interest_only' ? 'Interest paid each month (₹)' : 'EMI (₹ a month)'}</label><input className="input num" inputMode="decimal" value={emi} onChange={(e) => setEmi(e.target.value)} /></div>

      {type === 'interest_only' && A && E ? (
        <div className="field">
          <p className="small" style={{ margin: 0 }}>{money(E * 12, { whole: true })} a year in interest. The {money(A, { whole: true })} stays owed until you repay it.</p>
          {rate && <p className="tiny faint" style={{ margin: '4px 0 0' }}>At {R}% a year, interest on {money(A, { whole: true })} is about {money(Math.round((A * R) / 1200), { whole: true })} a month. It varies a little with the number of days in the month, and you can change the amount each time you log it.</p>}
          <label style={{ marginTop: 10 }}>Principal due by (optional)</label>
          <input className="input" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
      ) : null}
      {type === 'emi' && views && !loan && (
        <div className="field">
          <label>That amount is…</label>
          <button className={`loan-opt ${chosenMode === 'total' ? 'on' : ''}`} onClick={() => setMode('total')}>
            <b>The total of my remaining EMIs</b>
            <span>About {Math.round(views.total.emis)} EMIs left → principal still owed ≈ <b>{money(views.total.principal, { whole: true })}</b>{views.total.math ? `, paid off ${monthYear(views.total.math.payoff)}` : ''}.</span>
          </button>
          <button className={`loan-opt ${chosenMode === 'principal' ? 'on' : ''}`} onClick={() => setMode('principal')} disabled={!views.asPrincipal}>
            <b>The principal still owed</b>
            {views.asPrincipal
              ? <span>{views.asPrincipal.months} EMIs left, paid off {monthYear(views.asPrincipal.payoff)}, ≈ {money(views.asPrincipal.interestLeft, { whole: true })} interest to go.</span>
              : <span className="exp">Can't be: at {R}% the interest alone would be {money(Math.round((A! * R) / 1200), { whole: true })} a month, more than the EMI.</span>}
          </button>
          <span className="tiny faint">Your loan statement or the Bajaj app shows "principal outstanding". Pick whichever matches.</span>
        </div>
      )}

      <div className="field"><label>{type === 'interest_only' ? 'Interest is debited on' : 'EMI is debited on'}</label>
        <select className="input" value={emiDay ?? ''} onChange={(e) => setEmiDay(Number(e.target.value) || null)}>
          <option value="">Day of month…</option>
          {Array.from({ length: 28 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
        </select>
      </div>
      <div className="field"><label>Paid from</label>
        <div className="chips">{payFrom.map((a) => <button key={a.id} className={`chip ${fromId === a.id ? 'on' : ''}`} onClick={() => setAcc(a.id)}>{a.icon ?? ''} {a.name}</button>)}</div>
      </div>
      <p className="tiny faint">{loan ? 'Saving sets the principal to this amount as of today and updates the monthly bill.' : type === 'interest_only'
        ? 'Adds the loan to Accounts (it lowers your net worth by the principal) and the monthly interest to Bills. Each logged payment counts as spending.'
        : 'Adds the loan to Accounts (it lowers your net worth by the principal) and the EMI to Bills. When you log an EMI, the interest part counts as spending and the rest pays the loan down.'}</p>
      {err && <p className="error">{err}</p>}
      <button className="btn accent block" onClick={save}>{loan ? 'Save' : 'Add loan'}</button>
    </Sheet>
  );
}
