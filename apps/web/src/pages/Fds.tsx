import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, money, compact, parseRupees, todayIST, dayLabel } from '../lib';
import { Sheet, useUi } from '../App';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const BANKS = ['SBI', 'HDFC Bank', 'ICICI Bank', 'Axis Bank', 'Kotak', 'Bajaj Finance', 'IDFC First', 'Bank of Baroda', 'PNB', 'Yes Bank'];

function left(d: number | null) {
  if (d === null) return '';
  if (d <= 0) return 'Matured';
  if (d < 60) return `${d} days left`;
  const m = Math.round(d / 30.4);
  return m < 24 ? `${m} months left` : `${(d / 365).toFixed(1)} years left`;
}

export function Fds() {
  const q = useQuery({ queryKey: ['fds'], queryFn: () => api<any>('/api/fds') });
  const [adding, setAdding] = useState<string | null>(null);
  const [maturing, setMaturing] = useState<any | null>(null);
  const d = q.data;
  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Fixed deposits</h1>
        <button className="btn small accent" onClick={() => setAdding('')}>+ Add FD</button>
      </div>
      {!d ? <div className="card"><div className="skeleton" /></div> : (
        <>
          <div className="totals card-totals" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: 0 }}>
            <div><span>Invested</span><b className="num">{compact(d.totals.principal)}</b></div>
            <div><span>Worth today</span><b className="num inc">{compact(d.totals.valueNow)}</b></div>
            <div><span>At maturity</span><b className="num">{compact(d.totals.atMaturity)}</b></div>
          </div>
          {d.nextMaturity && <p className="small muted" style={{ margin: '10px 2px' }}>Next to mature: <b>{d.nextMaturity.name}</b> on {shortDate(d.nextMaturity.maturity)} ({money(d.nextMaturity.atMaturity, { whole: true })}).</p>}
          {d.banks.length === 0 && <div className="empty">No FDs yet. Add one per deposit; they're grouped by bank.</div>}
          {d.banks.map((b: any) => (
            <div className="section" key={b.bank}>
              <div className="section-title">
                <span>{b.bank}</span>
                <span className="num" style={{ textTransform: 'none', letterSpacing: 0 }}>{compact(b.principal)} → {compact(b.atMaturity)}</span>
              </div>
              <div className="list">
                {b.items.map((f: any) => (
                  <div key={f.id} className="item" style={{ alignItems: 'flex-start' }}>
                    <div className="avatar" aria-hidden>🔒</div>
                    <div className="grow">
                      <div className="title">{f.name}{f.rate != null && <span className="faint"> · {f.rate}%</span>}</div>
                      <div className="sub">
                        {f.maturity ? <>Matures {shortDate(f.maturity)} · {left(f.daysLeft)}</> : 'No maturity date'}
                        {f.interest != null && <> · +{money(f.interest, { whole: true })} interest</>}
                      </div>
                      {f.note && <div className="sub">{f.note}</div>}
                      {f.matured && <button className="btn small accent" style={{ marginTop: 6 }} onClick={() => setMaturing(f)}>Mark matured</button>}
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className="amt num">{money(f.valueNow, { whole: true })}</div>
                      <div className="tiny faint num">of {money(f.principal, { whole: true })}</div>
                    </div>
                  </div>
                ))}
                <button className="item" onClick={() => setAdding(b.bank)}><div className="grow small" style={{ color: 'var(--accent)' }}>+ Another {b.bank} FD</div></button>
              </div>
            </div>
          ))}
          <p className="tiny faint" style={{ margin: '12px 2px' }}>"Worth today" adds the interest earned so far (compounded quarterly unless you chose otherwise). Your net worth counts the principal until an FD matures; marking it matured moves principal + interest into your bank, with the interest as income.</p>
        </>
      )}
      {adding !== null && <FdSheet bank={adding} onClose={() => setAdding(null)} />}
      {maturing && <MatureSheet fd={maturing} onClose={() => setMaturing(null)} />}
    </>
  );
}

function useBankAccounts() {
  const a = useQuery({ queryKey: ['accounts'], queryFn: () => api<any[]>('/api/accounts') });
  return (a.data ?? []).filter((x) => ['bank', 'cash', 'wallet'].includes(x.kind) && !x.is_archived);
}

function FdSheet({ bank: initial, onClose }: { bank: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const banksAcc = useBankAccounts();
  const [bank, setBank] = useState(initial);
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState('');
  const [start, setStart] = useState(todayIST());
  const [maturity, setMaturity] = useState('');
  const [compounding, setCompounding] = useState<'quarterly' | 'monthly' | 'yearly' | 'simple'>('quarterly');
  const [paid, setPaid] = useState<'had' | 'now'>('had');
  const [from, setFrom] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const fromId = from ?? banksAcc[0]?.id ?? null;

  const P = parseRupees(amount), R = Number(rate);
  let preview: string | null = null;
  if (P && rate && maturity > start) {
    const t = (Date.parse(maturity) - Date.parse(start)) / 86_400_000 / 365;
    const k = { monthly: 12, quarterly: 4, yearly: 1, simple: 0 }[compounding];
    const v = k ? P * Math.pow(1 + R / 100 / k, k * t) : P * (1 + (R / 100) * t);
    preview = `${money(Math.round(v), { whole: true })} at maturity (+${money(Math.round(v - P), { whole: true })})`;
  }

  async function save() {
    setErr(null);
    if (!bank.trim()) return setErr('Which bank?');
    if (!P) return setErr('Enter the amount deposited');
    if (!rate) return setErr('Enter the interest rate');
    if (!maturity || maturity <= start) return setErr('Maturity date must be after the start date');
    try {
      const r = await api<any>('/api/fds', { method: 'POST', body: { bank: bank.trim(), principal: P, rate: R, start, maturity, compounding, fromAccountId: paid === 'now' ? fromId : null, note: note.trim() || null } });
      await qc.invalidateQueries();
      toast(`Added ${r.name}`);
      onClose();
    } catch (e: any) { setErr(e.message); }
  }

  const addMonths = (m: number) => { const [y, mo, d] = start.split('-').map(Number); setMaturity(new Date(Date.UTC(y, mo - 1 + m, d)).toISOString().slice(0, 10)); };
  return (
    <Sheet title="Add a fixed deposit" onClose={onClose}>
      <div className="field"><label>Bank</label>
        <input className="input" value={bank} onChange={(e) => setBank(e.target.value)} placeholder="e.g. SBI" list="fd-banks" />
        <datalist id="fd-banks">{BANKS.map((b) => <option key={b} value={b} />)}</datalist>
      </div>
      <div className="grid2">
        <div className="field"><label>Amount (₹)</label><input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div className="field"><label>Interest (% a year)</label><input className="input num" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} /></div>
      </div>
      <div className="grid2">
        <div className="field"><label>Started</label><input className="input" type="date" value={start} onChange={(e) => setStart(e.target.value)} /></div>
        <div className="field"><label>Matures</label><input className="input" type="date" value={maturity} onChange={(e) => setMaturity(e.target.value)} /></div>
      </div>
      <div className="chips" style={{ marginBottom: 12 }}>
        {[[6, '6 mo'], [12, '1 yr'], [24, '2 yr'], [36, '3 yr'], [60, '5 yr']].map(([m, l]) => <button key={l} className="chip" onClick={() => addMonths(m as number)}>{l}</button>)}
      </div>
      <div className="field"><label>Interest compounds</label>
        <div className="seg full">
          {(['quarterly', 'monthly', 'yearly', 'simple'] as const).map((c) => <button key={c} className={compounding === c ? 'on' : ''} onClick={() => setCompounding(c)}>{c === 'simple' ? 'Simple' : c[0].toUpperCase() + c.slice(1)}</button>)}
        </div>
      </div>
      <div className="field"><label>Money came from</label>
        <div className="seg full">
          <button className={paid === 'had' ? 'on' : ''} onClick={() => setPaid('had')}>Already had this FD</button>
          <button className={paid === 'now' ? 'on' : ''} onClick={() => setPaid('now')}>Paid from my bank now</button>
        </div>
      </div>
      {paid === 'now' && <div className="chips" style={{ marginBottom: 12 }}>{banksAcc.map((a) => <button key={a.id} className={`chip ${fromId === a.id ? 'on' : ''}`} onClick={() => setFrom(a.id)}>{a.icon ?? ''} {a.name}</button>)}</div>}
      <div className="field"><input className="input" placeholder="Note (FD number, nominee, auto-renew…)" value={note} onChange={(e) => setNote(e.target.value)} /></div>
      {preview && <p className="small" style={{ margin: '0 2px 10px' }}>{preview}</p>}
      {err && <p className="error">{err}</p>}
      <button className="btn accent block" onClick={save}>Add FD</button>
    </Sheet>
  );
}

function MatureSheet({ fd, onClose }: { fd: any; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const banksAcc = useBankAccounts();
  const [to, setTo] = useState<string | null>(null);
  const [amount, setAmount] = useState(fd.atMaturity ? String(Math.round(fd.atMaturity / 100)) : '');
  const [err, setErr] = useState<string | null>(null);
  const toId = to ?? banksAcc.find((a) => (a.institution ?? a.name).toLowerCase().includes(fd.bank.toLowerCase().split(' ')[0]))?.id ?? banksAcc[0]?.id ?? null;
  async function save() {
    setErr(null);
    const p = parseRupees(amount);
    if (!p) return setErr('Enter what the bank credited');
    if (!toId) return setErr('Pick the account it went into');
    try {
      const r = await api<any>(`/api/fds/${fd.id}/mature`, { method: 'POST', body: { toAccountId: toId, amount: p } });
      await qc.invalidateQueries();
      toast(`${fd.name} closed · ${money(r.interest, { whole: true })} interest earned`);
      onClose();
    } catch (e: any) { setErr(e.message); }
  }
  return (
    <Sheet title={`${fd.name} matured`} onClose={onClose}>
      <p className="small muted">Matured {fd.maturity ? dayLabel(fd.maturity) : ''}. Principal {money(fd.principal, { whole: true })}.</p>
      <div className="field"><label>Amount credited (₹)</label><input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
      <div className="field"><label>Into</label>
        <div className="chips">{banksAcc.map((a) => <button key={a.id} className={`chip ${toId === a.id ? 'on' : ''}`} onClick={() => setTo(a.id)}>{a.icon ?? ''} {a.name}</button>)}</div>
      </div>
      <p className="tiny faint">If TDS was cut, enter what actually landed. The interest part counts as income; the FD is then closed.</p>
      {err && <p className="error">{err}</p>}
      <button className="btn accent block" onClick={save}>Close FD</button>
    </Sheet>
  );
}
