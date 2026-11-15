import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, money, compact, parseRupees, todayIST, dayLabel } from '../lib';
import { Sheet, useUi } from '../App';
import { newRegimeTax, NEW_REGIME } from '../tax';
import { useAppear, useCountUp } from '../motion';
import { UPLOAD_ACCEPT, readRows, promptPassword, Cancelled } from '../files';
import { parsePayslip, type ParsedSlip } from '../payslip';
import { SelectBar } from '../components/SelectBar';

type Line = { name: string; monthly: number; kind?: string };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const sum = (xs: Line[]) => xs.reduce((s, x) => s + x.monthly, 0);
const r = (paise: number) => paise / 100;                       // paise → rupees for the tax engine
const p = (rupees: number) => Math.round(rupees * 100);          // rupees → paise for display

const DEFAULT_EARN: Line[] = [{ name: 'Basic', monthly: 0 }, { name: 'HRA', monthly: 0 }, { name: 'Special allowance', monthly: 0 }];
const DEFAULT_DED: Line[] = [{ name: 'Employee PF', monthly: 0, kind: 'pf' }, { name: 'Professional tax', monthly: 0, kind: 'pt' }, { name: 'Income tax (TDS)', monthly: 0, kind: 'tds' }];
const DEFAULT_EMP: Line[] = [{ name: 'Employer PF', monthly: 0, kind: 'pf' }];
const isBasic = (n: string) => /\b(basic|da|dearness)\b/i.test(n);

export function Salary() {
  const q = useQuery({ queryKey: ['salary'], queryFn: () => api<any>('/api/salary') });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<any[]>('/api/accounts') });
  const [editing, setEditing] = useState(false);
  const [slipMonth, setSlipMonth] = useState<string | null>(null);
  const [uploads, setUploads] = useState<File[] | null>(null);
  const d = q.data;
  const prof = d?.profile;
  const acc = accounts.data?.find((a) => a.id === prof?.accountId);

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Salary</h1>
        {prof && <button className="btn small" onClick={() => setEditing(true)}>Edit</button>}
      </div>
      {!d ? <div className="card"><div className="skeleton" /></div> : !prof ? (
        <div className="card">
          <b>Add your salary</b>
          <p className="small muted">Upload your payslips (PDF, Excel, CSV or TXT; several at once is fine) and Paisa reads the earnings and deductions, or type them in. It then logs the credit on the last day of every month and runs your New Regime tax.</p>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <SlipDrop onFiles={setUploads} label="Upload payslips" />
            <button className="btn" onClick={() => setEditing(true)}>Type it in</button>
          </div>
        </div>
      ) : (
        <>
          <SalaryHero prof={prof} rule={d.rule} account={acc} received={d.receivedThisFy} fy={d.fy} />
          <TaxSimulator prof={prof} slips={d.slips} fy={d.fy} />
          <Payslips fy={d.fy} slips={d.slips} onOpen={setSlipMonth} onUpload={setUploads} />
        </>
      )}
      <MoneyIn />
      {editing && <SalaryEditor prof={prof} accounts={accounts.data ?? []} onClose={() => setEditing(false)} />}
      {uploads && d && <SlipImport files={uploads} prof={prof} accounts={accounts.data ?? []} onClose={() => setUploads(null)} />}
      {slipMonth && prof && <SlipEditor month={slipMonth} prof={prof} slip={d.slips.find((s: any) => s.month.startsWith(slipMonth))} onClose={() => setSlipMonth(null)} />}
    </>
  );
}

function SalaryHero({ prof, rule, account, received, fy }: { prof: any; rule: any; account: any; received: any; fy: any }) {
  const net = useCountUp(prof.net, 900);
  return (
    <div className="hero salary-hero">
      <div className="spread"><span className="hero-label">Take-home every month</span><span className="glass">{prof.employer || 'Salary'}</span></div>
      <div className="hero-num num">{money(Math.round(net), { whole: true })}</div>
      <div className="meta">
        <span>Gross <b className="num">{money(prof.gross, { whole: true })}</b></span>
        <span>{prof.payDay >= 28 ? 'Last day of the month' : `On the ${prof.payDay}th`}{account ? ` · ${account.name}` : ''}</span>
      </div>
      <div className="meta" style={{ marginTop: 6 }}>
        <span>{rule?.nextDue ? <>Next credit <b>{dayLabel(rule.nextDue)}</b>{rule.autoPost ? ' · logs itself' : ' · you confirm it'}</> : 'No monthly entry yet'}</span>
        <span>FY {fy.label}: <b className="num">{compact(received.total)}</b> received</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function TaxSimulator({ prof, slips, fy }: { prof: any; slips: any[]; fy: any }) {
  const basicMonthly = prof.earnings.filter((e: Line) => isBasic(e.name)).reduce((s: number, e: Line) => s + e.monthly, 0);
  const npsMonthly = prof.employerContrib.filter((e: Line) => e.kind === 'nps' || /nps/i.test(e.name)).reduce((s: number, e: Line) => s + e.monthly, 0);
  const [hike, setHike] = useState(0);
  const [bonus, setBonus] = useState(String(Math.round(prof.annualBonus / 100) || ''));
  const [npsPct, setNpsPct] = useState(basicMonthly ? Math.round((npsMonthly / basicMonthly) * 100) : 0);
  const [other, setOther] = useState('');

  // Employer NPS is taxed as part of salary and then deducted (80CCD(2), up to 14% of basic).
  // The slider models moving pay into NPS within the same CTC: cash pay drops by the extra NPS,
  // so salary (cash + employer NPS) stays the same while the deduction grows.
  const calc = (h: number, nPct: number) => {
    const f = 1 + h / 100;
    const basic = r(basicMonthly) * 12 * f;
    const actualNps = r(npsMonthly) * 12 * f;
    const employerNps = basic * (nPct / 100);
    const salary = r(prof.gross) * 12 * f + (Number(bonus) || 0) + actualNps;
    return { ...newRegimeTax({ salary, basicDa: basic, employerNps, otherIncome: Number(other) || 0 }), salary, employerNpsYear: employerNps, extraNps: employerNps - actualNps };
  };
  const t = calc(hike, npsPct);
  const withMaxNps = npsPct < 14 && basicMonthly ? calc(hike, 14) : null;
  const total = useCountUp(t.total, 800);
  const appear = useAppear(t.total);

  // TDS check: what slips show as deducted so far vs what the year needs.
  const tdsSoFar = slips.reduce((s, x) => s + x.tds, 0);
  const today = todayIST();
  const monthsDone = Math.min(12, Math.max(0, (Number(today.slice(0, 4)) - Number(fy.from.slice(0, 4))) * 12 + Number(today.slice(5, 7)) - 4));
  const monthsLeft = 12 - monthsDone;
  const yearTds = p(t.total);
  const remainingPerMonth = monthsLeft > 0 ? Math.max(0, (yearTds - tdsSoFar) / monthsLeft) : 0;
  const maxBand = Math.max(...t.bands.map((b) => b.tax), 1);

  return (
    <div className="section">
      <div className="section-title"><span>Tax simulator</span><span className="tiny faint" style={{ textTransform: 'none', letterSpacing: 0 }}>{NEW_REGIME.label}</span></div>
      <div className="card tax-card">
        <div className="tax-top">
          <div>
            <div className="tiny faint">Income tax for the year</div>
            <div className="tax-big num">{money(p(Math.round(total)), { whole: true })}</div>
            <div className="small muted">≈ {money(p(t.total / 12), { whole: true })} a month · {(t.effectiveRate * 100).toFixed(1)}% of income · top slab {Math.round(t.marginalRate * 100)}%</div>
          </div>
        </div>

        <div className="tax-flow">
          <Row label="Salary for the year" value={t.salary} />
          {Number(other) > 0 && <Row label="Other income" value={Number(other)} />}
          <Row label="Standard deduction" value={-t.standardDeduction} />
          {t.employerNps > 0 && <Row label="Employer NPS (80CCD(2))" value={-t.employerNps} />}
          <Row label="Taxable income" value={t.taxable} strong />
        </div>

        <div className="slabs">
          {t.bands.map((b, i) => (
            <div key={i} className="slab">
              <span className="sl-range">{compact(p(b.from))}–{b.to === Infinity ? '…' : compact(p(b.to))}</span>
              <span className="sl-rate">{Math.round(b.rate * 100)}%</span>
              <span className="sl-bar"><i style={{ width: appear ? `${(b.tax / maxBand) * 100}%` : 0, transitionDelay: `${i * 70}ms` }} /></span>
              <span className="sl-tax num">{money(p(b.tax), { whole: true })}</span>
            </div>
          ))}
        </div>
        <div className="tax-flow">
          <Row label="Tax on slabs" value={t.slabTax} />
          {t.rebate > 0 && <Row label={t.taxable <= NEW_REGIME.rebateLimit ? '87A rebate (income ≤ ₹12L)' : 'Marginal relief above ₹12L'} value={-t.rebate} />}
          {t.surcharge > 0 && <Row label="Surcharge" value={t.surcharge} />}
          <Row label="Health & education cess 4%" value={t.cess} />
          <Row label="Total tax" value={t.total} strong />
        </div>

        <div className="whatif">
          <div className="tiny faint" style={{ marginBottom: 6 }}>What if…</div>
          <label className="wi"><span>Hike <b>{hike}%</b></span><input type="range" min={0} max={50} step={1} value={hike} onChange={(e) => setHike(Number(e.target.value))} /></label>
          {basicMonthly > 0 && <label className="wi"><span>Employer NPS <b>{npsPct}%</b> of basic</span><input type="range" min={0} max={14} step={1} value={npsPct} onChange={(e) => setNpsPct(Number(e.target.value))} /></label>}
          <div className="grid2">
            <div className="field"><label>Bonus this year (₹)</label><input className="input num" inputMode="decimal" value={bonus} onChange={(e) => setBonus(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0" /></div>
            <div className="field"><label>Other taxable income (₹)</label><input className="input num" inputMode="decimal" value={other} onChange={(e) => setOther(e.target.value.replace(/[^\d.]/g, ''))} placeholder="FD/savings interest" /></div>
          </div>
        </div>

        {withMaxNps && withMaxNps.total < t.total && (
          <p className="tax-tip">💡 Moving 14% of basic ({money(p(r(basicMonthly) * 0.14), { whole: true })}/month) into employer NPS within the same CTC would cut tax by <b>{money(p(t.total - withMaxNps.total), { whole: true })}</b> a year. Take-home drops by the amount moved, but it goes to your retirement account. It's the only big deduction left in the New Regime; ask HR whether they offer it.</p>
        )}

        <div className="tds-check">
          <div><span>TDS on your payslips so far</span><b className="num">{money(tdsSoFar, { whole: true })}</b></div>
          <div><span>Needed for the year</span><b className="num">{money(yearTds, { whole: true })}</b></div>
          <div><span>{monthsLeft > 0 ? `Per month for the ${monthsLeft} left` : 'Balance'}</span><b className="num">{monthsLeft > 0 ? money(Math.round(remainingPerMonth), { whole: true }) : money(yearTds - tdsSoFar, { whole: true })}</b></div>
        </div>
        <p className="tiny faint" style={{ margin: '8px 0 0' }}>
          {slips.length === 0 ? 'Add your payslips below to compare with what your employer is deducting.'
            : tdsSoFar > yearTds ? `Your employer has deducted ${money(tdsSoFar - yearTds, { whole: true })} more than the year needs; you'd get it back as a refund after filing.`
            : 'An estimate from the New Regime rules; your Form 16 is the final word. Capital gains and other special-rate income aren\'t included.'}
        </p>
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return <div className={`tf-row ${strong ? 'strong' : ''}`}><span>{label}</span><b className="num">{value < 0 ? '− ' : ''}{money(p(Math.abs(value)), { whole: true })}</b></div>;
}

// ---------------------------------------------------------------------------
/** A button that opens the file picker for payslips. */
function SlipDrop({ onFiles, label, small }: { onFiles: (f: File[]) => void; label: string; small?: boolean }) {
  return (
    <label className={`btn ${small ? 'small' : 'accent'}`} style={{ cursor: 'pointer' }}>
      <input type="file" accept={UPLOAD_ACCEPT} multiple hidden onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; if (fs.length) onFiles(fs); }} />
      {label}
    </label>
  );
}

function Payslips({ fy, slips, onOpen, onUpload }: { fy: any; slips: any[]; onOpen: (m: string) => void; onUpload: (f: File[]) => void }) {
  const start = Number(fy.from.slice(0, 4));
  const today = todayIST().slice(0, 7);
  const months = Array.from({ length: 12 }, (_, i) => { const m = ((3 + i) % 12) + 1; const y = m >= 4 ? start : start + 1; return `${y}-${String(m).padStart(2, '0')}`; })
    .filter((m) => m <= today);
  return (
    <div className="section">
      <div className="section-title">
        <span>Payslips · FY {fy.label}</span>
        <SlipDrop onFiles={onUpload} label="Upload payslips" small />
      </div>
      <p className="tiny faint" style={{ margin: '-4px 2px 8px' }}>PDF, Excel, CSV or TXT, several at once. Or tap a month to type it in.</p>
      <div className="list">
        {months.reverse().map((m) => {
          const s = slips.find((x) => x.month.startsWith(m));
          return (
            <button key={m} className="item" onClick={() => onOpen(m)}>
              <div className="grow"><div className="title">{MONTHS[Number(m.slice(5)) - 1]} {m.slice(0, 4)}</div>
                <div className="sub">{s ? `Gross ${money(s.gross, { whole: true })} · TDS ${money(s.tds, { whole: true })}` : 'Not added'}</div></div>
              <div className={`amt num ${s ? 'inc' : 'faint'}`}>{s ? money(s.net, { whole: true }) : '+ Add'}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function LinesEditor({ title, lines, setLines, kinds }: { title: string; lines: Line[]; setLines: (l: Line[]) => void; kinds?: [string, string][] }) {
  return (
    <div className="field">
      <label>{title}</label>
      <div className="lines">
        {lines.map((l, i) => (
          <div key={i} className="line">
            <input className="input" value={l.name} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Name" />
            {kinds && (
              <select className="input" value={l.kind ?? 'other'} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))} aria-label="Type">
                {kinds.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
            )}
            <input className="input num" inputMode="decimal" value={l.monthly ? String(l.monthly / 100) : ''} placeholder="₹ / month"
              onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, monthly: parseRupees(e.target.value || '0') ?? 0 } : x)))} />
            <button type="button" className="icon-btn small" aria-label="Remove line" onClick={() => setLines(lines.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <button type="button" className="btn small" onClick={() => setLines([...lines, { name: '', monthly: 0, kind: kinds?.[0]?.[0] }])}>+ Line</button>
      </div>
    </div>
  );
}
const DED_KINDS: [string, string][] = [['tds', 'Income tax (TDS)'], ['pf', 'PF'], ['pt', 'Professional tax'], ['nps', 'NPS (yours)'], ['other', 'Other']];
const EMP_KINDS: [string, string][] = [['pf', 'PF'], ['nps', 'NPS'], ['gratuity', 'Gratuity'], ['other', 'Other']];

function SalaryEditor({ prof, accounts, onClose }: { prof: any; accounts: any[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const banks = accounts.filter((a) => ['bank', 'wallet', 'cash'].includes(a.kind) && !a.is_archived);
  const [employer, setEmployer] = useState(prof?.employer ?? '');
  const [accountId, setAccountId] = useState(prof?.accountId ?? banks.find((a) => a.meta?.salary)?.id ?? banks[0]?.id ?? '');
  const [payDay, setPayDay] = useState<number>(prof?.payDay ?? 31);
  const [earn, setEarn] = useState<Line[]>(prof?.earnings ?? DEFAULT_EARN);
  const [ded, setDed] = useState<Line[]>(prof?.deductions ?? DEFAULT_DED);
  const [emp, setEmp] = useState<Line[]>(prof?.employerContrib ?? DEFAULT_EMP);
  const [bonus, setBonus] = useState(prof?.annualBonus ? String(prof.annualBonus / 100) : '');
  const [autoPost, setAutoPost] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const net = sum(earn) - sum(ded);
  async function save() {
    setErr(null);
    const clean = (xs: Line[]) => xs.filter((x) => x.name.trim() && x.monthly > 0).map((x) => ({ ...x, name: x.name.trim() }));
    try {
      await api('/api/salary', { method: 'PUT', body: { employer: employer.trim() || null, accountId, payDay, earnings: clean(earn), deductions: clean(ded), employerContrib: clean(emp), annualBonus: parseRupees(bonus || '0') ?? 0, autoPost } });
      await qc.invalidateQueries();
      toast('Salary saved');
      onClose();
    } catch (e: any) { setErr(e.message); }
  }
  return (
    <Sheet title="Your salary" onClose={onClose}>
      <p className="tiny faint" style={{ marginTop: -6 }}>Monthly amounts, as on your payslip.</p>
      <div className="grid2">
        <div className="field"><label>Employer</label><input className="input" value={employer} onChange={(e) => setEmployer(e.target.value)} placeholder="Company name" /></div>
        <div className="field"><label>Lands in</label>
          <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>{banks.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
      </div>
      <LinesEditor title="Earnings" lines={earn} setLines={setEarn} />
      <LinesEditor title="Deductions" lines={ded} setLines={setDed} kinds={DED_KINDS} />
      <LinesEditor title="Employer adds (not in your hand)" lines={emp} setLines={setEmp} kinds={EMP_KINDS} />
      <div className="grid2">
        <div className="field"><label>Yearly bonus (₹, optional)</label><input className="input num" inputMode="decimal" value={bonus} onChange={(e) => setBonus(e.target.value)} /></div>
        <div className="field"><label>Paid on</label>
          <select className="input" value={payDay} onChange={(e) => setPayDay(Number(e.target.value))}>
            <option value={31}>Last day of the month</option>
            {Array.from({ length: 28 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
          </select></div>
      </div>
      <label className="toggle"><input type="checkbox" checked={autoPost} onChange={(e) => setAutoPost(e.target.checked)} />
        <span><b>Log it automatically</b><span className="tiny faint">On pay day, add the take-home as income. Turn off to confirm the amount each month.</span></span></label>
      <div className="totals" style={{ margin: '10px 0' }}>
        <div><span>Gross</span><b className="num">{money(sum(earn), { whole: true })}</b></div>
        <div><span>Deductions</span><b className="num exp">{money(sum(ded), { whole: true })}</b></div>
        <div><span>Take-home</span><b className="num inc">{money(net, { whole: true })}</b></div>
      </div>
      {err && <p className="error">{err}</p>}
      <button className="btn accent block" onClick={save} disabled={net <= 0 || !accountId}>Save salary</button>
    </Sheet>
  );
}

function SlipEditor({ month, prof, slip, onClose }: { month: string; prof: any; slip?: any; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [earn, setEarn] = useState<Line[]>(slip?.earnings ?? prof.earnings);
  const [ded, setDed] = useState<Line[]>(slip?.deductions ?? prof.deductions);
  const [emp, setEmp] = useState<Line[]>(slip?.employerContrib ?? prof.employerContrib);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setErr(null);
    const clean = (xs: Line[]) => xs.filter((x) => x.name.trim() && x.monthly > 0);
    try {
      await api(`/api/salary/slips/${month}`, { method: 'PUT', body: { earnings: clean(earn), deductions: clean(ded), employerContrib: clean(emp) } });
      await qc.invalidateQueries({ queryKey: ['salary'] });
      toast('Payslip saved');
      onClose();
    } catch (e: any) { setErr(e.message); }
  }
  return (
    <Sheet title={`Payslip · ${MONTHS[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`} onClose={onClose}>
      <p className="tiny faint" style={{ marginTop: -6 }}>Filled from your usual salary. Change anything that was different this month (arrears, bonus, TDS).</p>
      <LinesEditor title="Earnings" lines={earn} setLines={setEarn} />
      <LinesEditor title="Deductions" lines={ded} setLines={setDed} kinds={DED_KINDS} />
      <LinesEditor title="Employer adds" lines={emp} setLines={setEmp} kinds={EMP_KINDS} />
      <div className="totals" style={{ margin: '10px 0' }}>
        <div><span>Gross</span><b className="num">{money(sum(earn), { whole: true })}</b></div>
        <div><span>TDS</span><b className="num exp">{money(ded.filter((d) => d.kind === 'tds').reduce((s, d) => s + d.monthly, 0), { whole: true })}</b></div>
        <div><span>Net</span><b className="num inc">{money(sum(earn) - sum(ded), { whole: true })}</b></div>
      </div>
      {err && <p className="error">{err}</p>}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn accent grow" onClick={save}>Save payslip</button>
        {slip && <button className="btn danger" onClick={async () => { await api(`/api/salary/slips/${month}`, { method: 'DELETE' }); await qc.invalidateQueries({ queryKey: ['salary'] }); onClose(); }}>Delete</button>}
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
/** Everything that came in this FY that isn't salary: decide what's income and what's just money in. */
function MoneyIn() {
  const qc = useQueryClient();
  const { toast } = useUi();
  const rows = useQuery({ queryKey: ['money-in'], queryFn: () => api<any[]>('/api/money-in') });
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api<any[]>('/api/categories') });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState('');
  const sal = useQuery({ queryKey: ['salary'], queryFn: () => api<any>('/api/salary') });
  const moneyCats = useMemo(() => (cats.data ?? []).filter((c) => c.class === 'income' && c.not_income && c.parent_id), [cats.data]);
  const salaryCat = (cats.data ?? []).find((c) => c.class === 'income' && !c.parent_id && c.name === 'Salary');
  // Credits from your employer are salary, not "other money".
  const empWord = (sal.data?.profile?.employer ?? '').toLowerCase().replace(/\b(pvt|private|ltd|limited|llp|inc|the)\b\.?/g, ' ').split(/\s+/).find((w: string) => w.length >= 4);
  const counted = (rows.data ?? []).filter((x) => x.counted);
  const notCounted = (rows.data ?? []).filter((x) => !x.counted);
  if (!rows.data || rows.data.length === 0) return null;
  const looksSalary = counted.filter((x) => empWord && (x.title ?? '').toLowerCase().includes(empWord));
  const tgt = target || moneyCats.find((c) => c.name === 'Repayments')?.id || moneyCats[0]?.id;
  async function move(categoryId = tgt, ids = [...picked]) {
    if (!categoryId || ids.length === 0) return;
    const r = await api<any>('/api/money-in/reclassify', { method: 'POST', body: { txnIds: ids, categoryId } });
    setPicked(new Set());
    await qc.invalidateQueries();
    toast(categoryId === salaryCat?.id ? `${r.moved} marked as salary` : `${r.moved} moved out of income`);
  }
  return (
    <div className="section">
      <div className="section-title"><span>Other money in this year</span><span className="tiny faint" style={{ textTransform: 'none', letterSpacing: 0 }}>only salary counts as income</span></div>
      {counted.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '12px 14px 4px' }}>
            <b className="small">Counted as income now ({compact(counted.reduce((s, x) => s + x.amount, 0))})</b>
            <p className="tiny faint" style={{ margin: '2px 0 0' }}>Tick your salary credits and tap <b>Salary</b>; tick repayments, transfers from family, refunds and so on and move them out of income.</p>
            {looksSalary.length > 0 && salaryCat && (
              <div className="tax-tip" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span className="grow">{looksSalary.length} credits from <b>{sal.data.profile.employer}</b> look like your salary.</span>
                <button className="btn small" onClick={() => setPicked(new Set(looksSalary.map((x) => x.id)))}>Select them</button>
                <button className="btn small accent" onClick={() => move(salaryCat.id, looksSalary.map((x) => x.id))}>Mark as salary</button>
              </div>
            )}
            <SelectBar total={counted.length} selected={counted.filter((x) => picked.has(x.id)).length}
              onAll={() => setPicked(new Set(counted.map((x) => x.id)))} onNone={() => setPicked(new Set())} />
          </div>
          <div className="list" style={{ border: 0, boxShadow: 'none' }}>
            {counted.map((x) => (
              <label key={x.id} className="item" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={picked.has(x.id)} onChange={(e) => { const n = new Set(picked); e.target.checked ? n.add(x.id) : n.delete(x.id); setPicked(n); }} />
                <div className="grow"><div className="title">{x.title || 'Money in'}</div><div className="sub">{dayLabel(x.date)} · {x.category}</div></div>
                <div className="amt num inc">{money(x.amount, { whole: true })}</div>
              </label>
            ))}
          </div>
          <div className="row" style={{ gap: 8, padding: 12, borderTop: '1px solid var(--border)' }}>
            {salaryCat && <button className="btn" disabled={picked.size === 0} onClick={() => move(salaryCat.id)}>Salary ({picked.size})</button>}
            <select className="input" value={tgt ?? ''} onChange={(e) => setTarget(e.target.value)} aria-label="Move to">
              {moneyCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button className="btn accent" disabled={picked.size === 0} onClick={() => move()}>Not income ({picked.size})</button>
          </div>
        </div>
      )}
      {notCounted.length > 0 && (
        <p className="small muted" style={{ margin: '10px 2px' }}>Already outside income: <b className="num">{money(notCounted.reduce((s, x) => s + x.amount, 0), { whole: true })}</b> across {notCounted.length} entries (repayments, refunds, gifts…). They still show in your balances, just not as earnings.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
type Found = { file: string; slip: ParsedSlip | null; error?: string; keep: boolean; month: string };

/** Read payslip files, show what was found, save the ticked ones (and optionally set the monthly salary from the latest). */
function SlipImport({ files, prof, accounts, onClose }: { files: File[]; prof: any; accounts: any[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [found, setFound] = useState<Found[] | null>(null);
  const [setProfile, setSetProfile] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const out: Found[] = [];
      for (const f of files) {
        try {
          const slip = parsePayslip(await readRows(f, { askPassword: promptPassword }));
          out.push({ file: f.name, slip, keep: !!slip.month && slip.earnings.length > 0, month: slip.month ?? '' });
        } catch (e: any) {
          if (!(e instanceof Cancelled)) out.push({ file: f.name, slip: null, error: e.message ?? 'Could not read it', keep: false, month: '' });
        }
      }
      out.sort((a, b) => b.month.localeCompare(a.month));
      setFound(out);
    })();
  }, [files]); // eslint-disable-line react-hooks/exhaustive-deps

  const kept = (found ?? []).filter((f) => f.keep && f.slip && /^\d{4}-\d{2}$/.test(f.month));
  const latest = kept[0];
  const banks = accounts.filter((a) => ['bank', 'wallet'].includes(a.kind) && !a.is_archived);

  async function save() {
    setBusy(true); setErr(null);
    try {
      for (const f of kept) {
        await api(`/api/salary/slips/${f.month}`, { method: 'PUT', body: { earnings: f.slip!.earnings, deductions: f.slip!.deductions, employerContrib: [] } });
      }
      if (setProfile && latest) {
        // The monthly structure: the latest slip without one-off lines (arrears).
        const regular = (xs: Line[]) => xs.filter((x) => !/arrear/i.test(x.name));
        await api('/api/salary', { method: 'PUT', body: {
          employer: latest.slip!.employer ?? prof?.employer ?? null,
          accountId: prof?.accountId ?? banks.find((a) => a.meta?.salary)?.id ?? banks[0]?.id,
          payDay: prof?.payDay ?? 31,
          earnings: regular(latest.slip!.earnings), deductions: regular(latest.slip!.deductions),
          employerContrib: prof?.employerContrib ?? [], annualBonus: prof?.annualBonus ?? 0, autoPost: true,
        } });
      }
      await qc.invalidateQueries();
      toast(`${kept.length} payslip${kept.length === 1 ? '' : 's'} saved${setProfile && latest ? ' · salary updated' : ''}`);
      onClose();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <Sheet title="Payslips" onClose={onClose}>
      {!found ? <p className="small muted">Reading {files.length} file{files.length === 1 ? '' : 's'} on this device…</p> : (
        <>
          <SelectBar total={found.filter((f) => f.slip).length} selected={kept.length}
            onAll={() => setFound((xs) => xs!.map((x) => ({ ...x, keep: !!x.slip })))} onNone={() => setFound((xs) => xs!.map((x) => ({ ...x, keep: false })))} />
          <div className="list" style={{ marginBottom: 10 }}>
            {found.map((f, i) => (
              <div key={i} className={`imp-row ${f.keep ? '' : 'off'}`}>
                <label className="imp-check"><input type="checkbox" checked={f.keep} disabled={!f.slip} onChange={(e) => setFound((xs) => xs!.map((x, j) => (j === i ? { ...x, keep: e.target.checked } : x)))} /></label>
                <div className="grow">
                  {f.slip ? (
                    <>
                      <div className="spread">
                        <input className="input" type="month" value={f.month} style={{ maxWidth: 170, minHeight: 32, padding: '4px 8px' }}
                          onChange={(e) => setFound((xs) => xs!.map((x, j) => (j === i ? { ...x, month: e.target.value } : x)))} aria-label="Month" />
                        <b className="num inc">{money(f.slip.gross - f.slip.totalDeductions, { whole: true })}</b>
                      </div>
                      <div className="sub">Gross {money(f.slip.gross, { whole: true })} · {f.slip.earnings.map((e) => e.name).join(', ')}</div>
                      <div className="sub">Deductions {money(f.slip.totalDeductions, { whole: true })} · {f.slip.deductions.map((d) => `${d.name} ${money(d.monthly, { whole: true })}`).join(', ') || 'none'}</div>
                      {f.slip.warnings.map((w, k) => <div key={k} className="pill-s warn">{w}</div>)}
                    </>
                  ) : <><div className="title">{f.file}</div><div className="pill-s warn">{f.error}</div></>}
                </div>
              </div>
            ))}
          </div>
          {latest && (
            <label className="toggle"><input type="checkbox" checked={setProfile} onChange={(e) => setSetProfile(e.target.checked)} />
              <span><b>Set my monthly salary from {MONTHS[Number(latest.month.slice(5)) - 1]} {latest.month.slice(0, 4)}</b>
                <span className="tiny faint">Earnings and deductions from the latest slip (one-off arrears left out){latest.slip!.employer ? `, employer ${latest.slip!.employer}` : ''}. Updates the monthly credit and the tax simulator.</span></span></label>
          )}
          {err && <p className="error">{err}</p>}
          <button className="btn accent block" disabled={busy || kept.length === 0} onClick={save}>{busy ? 'Saving…' : `Save ${kept.length} payslip${kept.length === 1 ? '' : 's'}`}</button>
        </>
      )}
    </Sheet>
  );
}
