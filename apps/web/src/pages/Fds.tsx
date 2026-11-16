import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, money, compact, parseRupees, todayIST, dayLabel } from '../lib';
import { Sheet, useUi } from '../App';
import { DeleteAccountSheet } from '../components/DeleteAccount';
import {
  type Comp, type RateTable, type Tenure, effectiveYield, findBank, rateOptions, maturityFrom, maturityValue, rateFor, tenureBetween, tenureLabel,
} from '../fd-math';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const BANKS = ['SBI', 'HDFC Bank', 'ICICI Bank', 'Axis Bank', 'Kotak Mahindra Bank', 'IDFC FIRST Bank', 'Bank of Baroda', 'Punjab National Bank', 'Yes Bank', 'IndusInd Bank', 'AU Small Finance Bank', 'Post Office'];
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const rupees = (p: number) => (p % 100 ? (p / 100).toFixed(2) : String(p / 100));

function left(d: number | null) {
  if (d === null) return '';
  if (d <= 0) return 'Matured';
  if (d < 60) return `${d} days left`;
  const m = Math.round(d / 30.4);
  return m < 24 ? `${m} months left` : `${(d / 365).toFixed(1)} years left`;
}

function useRates() {
  return useQuery({ queryKey: ['fd-rates'], queryFn: () => api<RateTable>('/api/fds/rates'), staleTime: 6 * 3600_000 });
}

export function Fds() {
  const q = useQuery({ queryKey: ['fds'], queryFn: () => api<any>('/api/fds') });
  const [sheet, setSheet] = useState<null | { bank?: string; fd?: any; rate?: number; months?: number; scheme?: string }>(null);
  const [maturing, setMaturing] = useState<any | null>(null);
  const [comparing, setComparing] = useState(false);
  const d = q.data;
  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Fixed deposits</h1>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn small" onClick={() => setComparing(true)}>Compare rates</button>
          <button className="btn small accent" onClick={() => setSheet({})}>+ Add FD</button>
        </div>
      </div>
      {!d ? <div className="card"><div className="skeleton" /></div> : (
        <>
          <div className="totals card-totals" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: 0 }}>
            <div><span>Invested</span><b className="num">{compact(d.totals.principal)}</b></div>
            <div><span>Worth today</span><b className="num inc">{compact(d.totals.valueNow)}</b></div>
            <div><span>At maturity</span><b className="num">{compact(d.totals.atMaturity)}</b></div>
          </div>
          {d.totals.atMaturity > d.totals.principal && <p className="small muted" style={{ margin: '10px 2px 0' }}>Expected return on all FDs: <b className="inc">+{money(d.totals.atMaturity - d.totals.principal, { whole: true })}</b>.</p>}
          {d.nextMaturity && <p className="small muted" style={{ margin: '6px 2px 10px' }}>Next to mature: <b>{d.nextMaturity.name}</b> on {shortDate(d.nextMaturity.maturity)} ({money(d.nextMaturity.atMaturity, { whole: true })}).</p>}
          {d.banks.length === 0 && <div className="empty">No FDs yet. Add one per deposit; they're grouped by bank.</div>}
          {d.banks.map((b: any) => (
            <div className="section" key={b.bank}>
              <div className="section-title">
                <span>{b.bank}</span>
                <span className="num" style={{ textTransform: 'none', letterSpacing: 0 }}>{compact(b.principal)} → {compact(b.atMaturity)}</span>
              </div>
              <div className="list">
                {b.items.map((f: any) => (
                  <div key={f.id} className="item fd-item" role="button" tabIndex={0} style={{ alignItems: 'flex-start' }}
                    onClick={() => setSheet({ fd: f })} onKeyDown={(e) => { if (e.key === 'Enter') setSheet({ fd: f }); }}>
                    <div className="avatar" aria-hidden>🔒</div>
                    <div className="grow">
                      <div className="title">{f.name}{f.rate != null && <span className="faint"> · {f.rate}%</span>}</div>
                      <div className="sub">
                        {f.maturity ? <>Matures {shortDate(f.maturity)} · {left(f.daysLeft)}</> : 'No maturity date'}
                      </div>
                      {f.interest != null && (
                        <div className="sub">
                          {f.scheme ? <>{f.scheme.replace(/^Post Office /, '')} · </> : f.start && f.maturity && <>{tenureLabel(tenureBetween(f.start, f.maturity))} · </>}
                          <b className="inc">+{money(f.interest, { whole: true })}</b>{f.expectedMaturity ? ' (bank’s figure)' : ' expected'}
                        </div>
                      )}
                      {f.fundedFrom && <div className="sub">From {f.fundedFrom}</div>}
                      {f.note && <div className="sub">{f.note}</div>}
                      {f.matured && <button className="btn small accent" style={{ marginTop: 6 }} onClick={(e) => { e.stopPropagation(); setMaturing(f); }}>Mark matured</button>}
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className="amt num">{money(f.valueNow, { whole: true })}</div>
                      <div className="tiny faint num">of {money(f.principal, { whole: true })}</div>
                    </div>
                  </div>
                ))}
                <button className="item" onClick={() => setSheet({ bank: b.bank })}><div className="grow small" style={{ color: 'var(--accent)' }}>+ Another {b.bank} FD</div></button>
              </div>
            </div>
          ))}
          <p className="tiny faint" style={{ margin: '12px 2px' }}>Tap an FD to edit it. "Worth today" adds the interest earned so far (compounded quarterly unless you chose otherwise, or following the bank's maturity amount if you entered it). Your net worth counts the principal until an FD matures; marking it matured moves principal + interest into your bank, with the interest as income.</p>
        </>
      )}
      {sheet && <FdSheet key={sheet.fd?.id ?? 'new'} init={sheet} onClose={() => setSheet(null)} />}
      {maturing && <MatureSheet fd={maturing} onClose={() => setMaturing(null)} />}
      {comparing && <CompareSheet onClose={() => setComparing(false)} onPick={(bank, rate, months, scheme) => { setComparing(false); setSheet({ bank, rate, months, scheme }); }} />}
    </>
  );
}

function useBankAccounts() {
  const a = useQuery({ queryKey: ['accounts'], queryFn: () => api<any[]>('/api/accounts') });
  return (a.data ?? []).filter((x) => ['bank', 'cash', 'wallet'].includes(x.kind) && !x.is_archived);
}

function FdSheet({ init, onClose }: { init: { bank?: string; fd?: any; rate?: number; months?: number; scheme?: string }; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const banksAcc = useBankAccounts();
  const rates = useRates().data;
  const fd = init.fd;
  const editing = !!fd;
  const start0 = fd?.start ?? todayIST();
  const tenure0: Tenure = fd?.start && fd?.maturity ? tenureBetween(fd.start, fd.maturity) : { y: init.months ? Math.floor(init.months / 12) : 1, m: init.months ? init.months % 12 : 0, d: 0 };

  const [bank, setBank] = useState<string>(fd?.bank ?? init.bank ?? '');
  const [name, setName] = useState<string>(fd?.name ?? '');
  const [amount, setAmount] = useState(fd ? rupees(fd.principal) : '');
  const [rate, setRate] = useState(fd?.rate != null ? String(fd.rate) : init.rate != null ? String(init.rate) : '');
  const [start, setStart] = useState(start0);
  const [ten, setTen] = useState<Tenure>(tenure0);
  const [maturity, setMaturity] = useState(fd?.maturity ?? maturityFrom(start0, tenure0));
  const [compounding, setCompounding] = useState<Comp>(fd?.compounding ?? rates?.schemes?.find((x) => `Post Office ${x.name}` === init.scheme)?.compounding ?? 'quarterly');
  // Where the money came from: one of your accounts (a real transfer: it's taken out of that account),
  // or '__ext' for money from outside Paisa (just a label).
  const transferFunded = !!fd?.fundedFromAccountId;
  const [src, setSrc] = useState<string | null>(fd ? (fd.fundedFromAccountId ?? (fd.fundedFrom ? '__label' : null)) : null);
  const [fundedFrom, setFundedFrom] = useState<string>(fd?.fundedFrom ?? '');
  const [expected, setExpected] = useState(fd?.expectedMaturity ? rupees(fd.expectedMaturity) : '');
  const [note, setNote] = useState(fd?.note ?? '');
  const [scheme, setScheme] = useState<string>(fd?.scheme ?? init.scheme ?? '');     // e.g. "Post Office Time Deposit (5 yr)"
  const [rateInst, setRateInst] = useState<string | null>(null);      // "use the rates of…" when the bank name doesn't match
  const [otherBank, setOtherBank] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deletingFd, setDeletingFd] = useState(false);
  const ownBank = banksAcc.find((a) => a.kind === 'bank' && a.name === bank) ?? null;
  const srcId = src ?? (editing ? null : ownBank?.id ?? banksAcc.find((a) => a.kind === 'bank')?.id ?? null);
  const srcAcc = banksAcc.find((a) => a.id === srcId) ?? null;

  const setTenure = (t: Tenure) => { setTen(t); setMaturity(maturityFrom(start, t)); };
  const setStartDate = (s: string) => { setStart(s); if (s) setMaturity(maturityFrom(s, ten)); };
  const setMaturityDate = (m: string) => { setMaturity(m); if (m > start) setTen(tenureBetween(start, m)); };

  const P = parseRupees(amount) ?? 0, R = Number(rate);
  const term = maturity > start ? days(start, maturity) : 0;
  const months = ten.y * 12 + ten.m + (ten.d >= 15 ? 1 : 0);
  const estimate = P && rate && term ? maturityValue(P, R, term, compounding) : null;
  const bankFigure = parseRupees(expected);
  const final = bankFigure ?? estimate;
  const yieldPct = final && P ? effectiveYield(P, final, term) : null;

  const instOf = (n: string) => banksAcc.find((a) => a.name === n)?.institution as string | undefined;
  const match = useMemo(() => (rateInst ? findBank(rates, rateInst) : findBank(rates, bank) ?? findBank(rates, instOf(bank) ?? '')), [rates, bank, rateInst, banksAcc]);
  const options = useMemo(() => rateOptions(rates, match), [rates, match]);
  const picked = options.find((o) => o.scheme === scheme && String(o.rate) === rate);
  const suggestion = match && term && !picked ? rateFor(match, months) : null;
  function pickOption(id: string) {
    const o = options.find((x) => x.id === id);
    if (!o) { setScheme(''); return; }  // custom
    setScheme(o.scheme); setRate(String(o.rate));
    if (o.months) setTenure({ y: Math.floor(o.months / 12), m: o.months % 12, d: 0 });
    setCompounding(o.compounding ?? 'quarterly');
  }

  async function save() {
    setErr(null);
    if (!bank.trim()) return setErr('Which bank is the FD in?');
    if (!P) return setErr('Enter the amount deposited');
    if (!rate) return setErr('Enter the interest rate');
    if (!maturity || maturity <= start) return setErr('The FD needs a duration (or a maturity date after the start date)');
    setBusy(true);
    const ext = srcId === '__ext' || srcId === '__label';
    if (!editing && !srcId) return (setBusy(false), setErr('Where did the money come from?'));
    const funded = ext ? fundedFrom.trim() || null : undefined;
    try {
      if (editing) {
        await api(`/api/fds/${fd.id}`, { method: 'PATCH', body: {
          bank: bank.trim(), name: name.trim() || undefined, principal: P, rate: R, start, maturity, compounding,
          expectedMaturity: bankFigure ?? null, scheme: scheme || null, note: note.trim() || null, bankAccountId: ownBank?.id ?? null,
          ...(funded !== undefined ? { fundedFrom: funded } : {}),
          ...(!transferFunded && srcAcc ? { fundFromAccountId: srcAcc.id } : {}),
        } });
        toast(!transferFunded && srcAcc ? `FD updated · ${money(P, { whole: true })} taken out of ${srcAcc.name}` : 'FD updated');
      } else {
        const r = await api<any>('/api/fds', { method: 'POST', body: {
          bank: bank.trim(), principal: P, rate: R, start, maturity, compounding,
          fromAccountId: srcAcc?.id ?? null, fundedFrom: srcAcc ? null : funded ?? null, bankAccountId: ownBank?.id ?? null,
          expectedMaturity: bankFigure ?? null, scheme: scheme || null, note: note.trim() || null,
          name: picked?.short ? `${bank.trim()} ${picked.short}` : undefined,
        } });
        toast(`Added ${r.name}`);
      }
      await qc.invalidateQueries();
      onClose();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  const num = (v: number) => (v ? String(v) : '');
  if (deletingFd && fd) return <DeleteAccountSheet accountId={fd.id} onClose={() => setDeletingFd(false)} onDeleted={onClose} />;
  return (
    <Sheet title={editing ? `Edit ${fd.name}` : 'Add a fixed deposit'} onClose={onClose}>
      <div className="field"><label>FD is with</label>
        {(() => {
          const mine = banksAcc.filter((a) => a.kind === 'bank').map((a) => a.name as string);
          const pub = [...(rates?.banks.map((b) => b.bank) ?? [])].filter((b) => b !== 'Post Office').sort();
          const known = bank === '' || mine.includes(bank) || pub.includes(bank) || bank === 'Post Office';
          const v = otherBank ? '__other' : bank === '' ? '' : known ? bank : `__cur`;
          return (
            <select className="input" value={v} onChange={(e) => {
              const x = e.target.value;
              if (x === '__other') { setOtherBank(true); setBank(''); } else if (x !== '__cur') { setOtherBank(false); setBank(x); }
              setRateInst(null);
            }}>
              <option value="" disabled>Choose the bank or Post Office…</option>
              {!known && <option value="__cur">{bank}</option>}
              {mine.length > 0 && <optgroup label="Your accounts">{mine.map((n) => <option key={n} value={n}>{n}</option>)}</optgroup>}
              <optgroup label="Post Office"><option value="Post Office">Post Office</option></optgroup>
              <optgroup label="Banks">{pub.map((n) => <option key={n} value={n}>{n}</option>)}</optgroup>
              <option value="__other">Other (type a name)…</option>
            </select>
          );
        })()}
        {otherBank && <input className="input" style={{ marginTop: 8 }} autoFocus value={bank} onChange={(e) => setBank(e.target.value)} placeholder="Bank name" list="fd-banks" />}
        <datalist id="fd-banks">{[...new Set([...BANKS, ...(rates?.banks.map((b) => b.bank) ?? [])])].map((b) => <option key={b} value={b} />)}</datalist>
      </div>

      {bank.trim() && rates && (
        <div className="field"><label>Scheme and interest rate</label>
          {match ? (
            <>
              <select className="input" value={picked?.id ?? (scheme ? '__saved' : '__custom')} onChange={(e) => { if (e.target.value !== '__saved') pickOption(e.target.value); }}>
                {scheme && !picked && <option value="__saved">{scheme} · {rate || '?'}%</option>}
                <optgroup label={match.bank === 'Post Office' ? 'Post Office schemes' : `${match.bank} FDs`}>
                  {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </optgroup>
                <option value="__custom">Custom rate (type it below)</option>
              </select>
              {picked?.note && <p className="tiny faint" style={{ margin: '6px 2px 0' }}>{picked.note}</p>}
              {match.bank !== bank && <p className="tiny faint" style={{ margin: '6px 2px 0' }}>Using {match.bank} rates for {bank}. <button className="link-btn" onClick={() => setRateInst('')}>Change</button></p>}
            </>
          ) : (
            <select className="input" value="" onChange={(e) => setRateInst(e.target.value)}>
              <option value="" disabled>{bank} isn't in the rate list. Use the rates of…</option>
              <option value="Post Office">Post Office</option>
              {[...(rates.banks.map((b) => b.bank))].filter((b) => b !== 'Post Office').sort().map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          )}
        </div>
      )}
      {editing && <div className="field"><label>Name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>}

      <div className="grid2">
        <div className="field"><label>Amount (₹)</label><input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div className="field"><label>Started</label><input className="input" type="date" value={start} onChange={(e) => setStartDate(e.target.value)} /></div>
      </div>

      <div className="field"><label>Duration</label>
        <div className="fd-tenure">
          <label><input className="input num" inputMode="numeric" value={num(ten.y)} placeholder="0" onChange={(e) => setTenure({ ...ten, y: Math.min(20, Number(e.target.value.replace(/\D/g, '')) || 0) })} /><span>years</span></label>
          <label><input className="input num" inputMode="numeric" value={num(ten.m)} placeholder="0" onChange={(e) => setTenure({ ...ten, m: Math.min(11, Number(e.target.value.replace(/\D/g, '')) || 0) })} /><span>months</span></label>
          <label><input className="input num" inputMode="numeric" value={num(ten.d)} placeholder="0" onChange={(e) => setTenure({ ...ten, d: Math.min(365, Number(e.target.value.replace(/\D/g, '')) || 0) })} /><span>days</span></label>
        </div>
        <div className="chips" style={{ marginTop: 8 }}>
          {([[0, 6, '6 mo'], [1, 0, '1 yr'], [1, 3, '15 mo'], [2, 0, '2 yr'], [3, 0, '3 yr'], [5, 0, '5 yr']] as const).map(([y, m, l]) => (
            <button key={l} className={`chip ${ten.y === y && ten.m === m && ten.d === 0 ? 'on' : ''}`} onClick={() => setTenure({ y, m, d: 0 })}>{l}</button>
          ))}
        </div>
      </div>
      <div className="field"><label>Matures on</label><input className="input" type="date" value={maturity} min={start} onChange={(e) => setMaturityDate(e.target.value)} /></div>

      <div className="field"><label>Interest (% a year)</label>
        <input className="input num" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
        {suggestion && match && (
          <div className="fd-suggest">
            <span>{match.bank}'s {suggestion.label} rate today: <b>{suggestion.rate}%</b>{match.highest > suggestion.rate && <> · best slab {match.highest}%</>}</span>
            {String(suggestion.rate) !== rate && <button className="btn small" onClick={() => setRate(String(suggestion.rate))}>Use {suggestion.rate}%</button>}
          </div>
        )}
        {rates && match?.bank === 'Post Office' && <p className="tiny faint" style={{ margin: '6px 2px 0' }}>Post Office rates from <a href={rates.schemesUrl} target="_blank" rel="noreferrer">{rates.schemesSource}</a> for Oct–Dec 2026; they're reset every quarter, and your deposit keeps the rate it started with.</p>}
        {rates && match && match.bank !== 'Post Office' && <p className="tiny faint" style={{ margin: '6px 2px 0' }}>Bank rates for regular depositors from <a href={rates.sourceUrl} target="_blank" rel="noreferrer">{rates.source}</a>, {dayLabel(rates.asOf)}. Seniors usually get 0.5% more. Your receipt is the final word.</p>}
      </div>

      <div className="field"><label>Interest compounds</label>
        <select className="input" value={compounding} onChange={(e) => setCompounding(e.target.value as Comp)}>
          <option value="quarterly">Quarterly, added to the FD (most bank FDs)</option>
          <option value="monthly">Monthly, added to the FD</option>
          <option value="yearly">Yearly, added (NSC, KVP)</option>
          <option value="yearly_payout">Worked out quarterly, paid out yearly (Post Office TD)</option>
          <option value="simple">Paid out as it's earned (MIS, SCSS, payout FDs)</option>
        </select>
      </div>

      <div className="field"><label>Money came from</label>
        {transferFunded ? (
          <p className="small" style={{ margin: 0 }}>Taken out of <b>{fd.fundedFrom}</b> when the FD started (a transfer in its history). To change it, edit that transfer in Activity.</p>
        ) : (
          <>
            <div className="chips">
              {banksAcc.map((a) => <button key={a.id} className={`chip ${srcId === a.id ? 'on' : ''}`} onClick={() => setSrc(a.id)}>{a.icon ?? ''} {a.name}</button>)}
              <button className={`chip ${srcId === '__ext' || srcId === '__label' ? 'on' : ''}`} onClick={() => setSrc('__ext')}>Not from my accounts</button>
            </div>
            {srcAcc && (
              <div className="fd-suggest" style={{ display: 'block' }}>
                <b>{money(P || 0, { whole: true })}</b> will be taken out of <b>{srcAcc.name}</b>
                {P > 0 && <> · balance {money(srcAcc.balance, { whole: true })} → <b>{money(srcAcc.balance - P, { whole: true })}</b></>}
                <div className="tiny faint" style={{ marginTop: 4 }}>Recorded as a transfer on {shortDate(start > todayIST() ? todayIST() : start)}. If you already set {srcAcc.name}'s balance after the money left, choose "Not from my accounts" so it isn't taken out twice.</div>
              </div>
            )}
            {(srcId === '__ext' || srcId === '__label') && (
              <>
                <input className="input" style={{ marginTop: 8 }} placeholder="Where from? e.g. old savings, maturity of another FD" value={fundedFrom} onChange={(e) => setFundedFrom(e.target.value)} list="fd-banks" />
                <p className="tiny faint" style={{ margin: '6px 2px 0' }}>{srcId === '__label' ? 'Right now this is only a label, so no account balance changed. Pick an account above to take the money out of it.' : 'Just a label: no account balance changes.'}</p>
              </>
            )}
          </>
        )}
      </div>

      <div className="fd-return">
        <div className="fd-return-head">Expected return</div>
        {final && P ? (
          <>
            <div className="fd-return-row"><span>At maturity{maturity ? ` (${shortDate(maturity)})` : ''}</span><b className="num">{money(final, { whole: true })}</b></div>
            <div className="fd-return-row"><span>Interest over {tenureLabel(ten)}</span><b className="num inc">+{money(final - P, { whole: true })}</b></div>
            {yieldPct != null && <div className="fd-return-row faint"><span>Effective yearly yield</span><span className="num">{yieldPct.toFixed(2)}%</span></div>}
            {bankFigure && estimate && Math.abs(bankFigure - estimate) > 100 * 100 && <p className="tiny faint" style={{ margin: '4px 0 0' }}>The formula gives {money(estimate, { whole: true })}; using your bank's figure.</p>}
          </>
        ) : <p className="tiny faint" style={{ margin: 0 }}>Enter the amount, rate and duration to see what you'll get.</p>}
        <div className="field" style={{ margin: '10px 0 0' }}>
          <label>Bank's maturity amount (optional)</label>
          <input className="input num" inputMode="decimal" placeholder={estimate ? `From your receipt, e.g. ${Math.round(estimate / 100)}` : 'From your FD receipt'} value={expected} onChange={(e) => setExpected(e.target.value)} />
        </div>
      </div>

      <div className="field"><input className="input" placeholder="Note (FD number, nominee, auto-renew…)" value={note} onChange={(e) => setNote(e.target.value)} /></div>
      {err && <p className="error">{err}</p>}
      <button className="btn accent block" disabled={busy} onClick={save}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Add FD'}</button>
      {editing && <button className="btn danger block" style={{ marginTop: 8 }} disabled={busy} onClick={() => setDeletingFd(true)}>Delete this FD</button>}
    </Sheet>
  );
}

/** Today's published rates across banks for one tenure, with what a sample amount would grow to. */
function CompareSheet({ onClose, onPick }: { onClose: () => void; onPick: (bank: string, rate: number, months: number, scheme?: string) => void }) {
  const q = useRates();
  const [months, setMonths] = useState(12);
  const [amount, setAmount] = useState('100000');
  const P = parseRupees(amount) ?? 0;
  const t = q.data;
  const rows = (t?.banks ?? []).map((b) => ({ b, ...rateFor(b, months) })).sort((a, z) => z.rate - a.rate || a.b.bank.localeCompare(z.b.bank));
  const termDays = days(todayIST(), maturityFrom(todayIST(), { y: Math.floor(months / 12), m: months % 12, d: 0 }));
  return (
    <Sheet title="Compare FD rates" onClose={onClose}>
      <div className="seg full" style={{ marginBottom: 12 }}>
        {[[12, '1 year'], [24, '2 years'], [36, '3 years'], [60, '5 years']].map(([m, l]) => <button key={m} className={months === m ? 'on' : ''} onClick={() => setMonths(m as number)}>{l}</button>)}
      </div>
      <div className="field"><label>If I deposit (₹)</label><input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
      {!t ? <div className="skeleton" /> : (
        <>
          <p className="tiny faint" style={{ margin: '0 2px 10px' }}>
            {t.source} · rates as of {dayLabel(t.asOf)}{t.live ? '' : ' (saved copy; the live page couldn’t be read)'} · regular depositors, compounded quarterly. Tap a bank to add an FD with it.
          </p>
          <div className="list">
            {rows.map(({ b, rate, label }) => {
              const v = P ? maturityValue(P, rate, termDays, 'quarterly') : 0;
              return (
                <button key={b.bank} className="item" onClick={() => onPick(b.bank, rate, months)}>
                  <div className="grow">
                    <div className="title">{b.bank}</div>
                    <div className="sub">{label} rate{b.highest > rate ? ` · best slab ${b.highest}%` : ''}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="amt num">{rate.toFixed(2)}%</div>
                    {P > 0 && <div className="tiny faint num">{money(v, { whole: true })} (+{money(v - P, { whole: true })})</div>}
                  </div>
                </button>
              );
            })}
          </div>
          {(t.schemes?.length ?? 0) > 0 && (
            <div className="section">
              <div className="section-title"><span>Post Office schemes</span><span style={{ textTransform: 'none', letterSpacing: 0 }}>Oct–Dec 2026</span></div>
              <div className="list">
                {t.schemes!.map((sc) => {
                  const d = days(todayIST(), maturityFrom(todayIST(), { y: Math.floor(sc.months / 12), m: sc.months % 12, d: 0 }));
                  const v = P ? maturityValue(P, sc.rate, d, sc.compounding) : 0;
                  return (
                    <button key={sc.id} className="item" onClick={() => onPick('Post Office', sc.rate, sc.months, `Post Office ${sc.name}`)}>
                      <div className="grow"><div className="title">{sc.name}</div><div className="sub">{tenureLabel({ y: Math.floor(sc.months / 12), m: sc.months % 12, d: 0 })} · {sc.note}</div></div>
                      <div style={{ textAlign: 'right' }}>
                        <div className="amt num">{sc.rate.toFixed(2)}%</div>
                        {P > 0 && <div className="tiny faint num">+{money(v - P, { whole: true })}</div>}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <p className="tiny faint" style={{ margin: '10px 2px 0' }}>Check the bank's own site before booking: rates change and special tenures can pay more. Deposits up to ₹5 lakh per bank are insured by DICGC.</p>
        </>
      )}
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
  const toId = to ?? banksAcc.find((a) => a.name === fd.bank)?.id ?? (fd.fundedFromAccountId && banksAcc.some((a) => a.id === fd.fundedFromAccountId) ? fd.fundedFromAccountId : null)
    ?? banksAcc.find((a) => (a.institution ?? a.name).toLowerCase().includes(fd.bank.toLowerCase().split(' ')[0]))?.id ?? banksAcc[0]?.id ?? null;
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
