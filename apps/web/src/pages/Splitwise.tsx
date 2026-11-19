import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, money, shortDate, todayIST, addDays } from '../lib';
import { useUi } from '../App';
import { tint } from '../components/Icons';
import { parseSplitwiseCsv, parseSplitwiseGrid, isSplitwiseHeader, guessMe, type SwCsvFile } from '../splitwise-csv';
import { UPLOAD_ACCEPT, kindOf, pdfRows, pdfTableGrid, excelRows, rowsToGrid, promptPassword, Cancelled } from '../files';
import { SelectBar } from '../components/SelectBar';
import { parseSplitwiseBalances, type Balance } from '../orders';

const RANGES: [string, () => string | null][] = [
  ['This month', () => todayIST().slice(0, 8) + '01'],
  ['3 months', () => addDays(todayIST(), -92)],
  ['This year', () => todayIST().slice(0, 5) + '01-01'],
  ['Everything', () => null],
];
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };

export function Splitwise() {
  const st = useQuery({ queryKey: ['splitwise'], queryFn: () => api<any>('/api/splitwise') });
  if (!st.data) return <><h1 className="page-title">Splitwise</h1><div className="card"><div className="skeleton" /></div></>;
  return (
    <>
      <h1 className="page-title">Splitwise</h1>
      <p className="small muted" style={{ margin: '0 2px 10px' }}>Just know the total? <Link to="/debts?seg=owed" style={{ color: 'var(--accent)' }}>Type your overall Splitwise balance</Link>.</p>
      <ScreenshotBalances />
      <details className="card" style={{ marginTop: 14 }}>
        <summary className="small">Also bring in individual expenses (spreadsheet export or API)</summary>
        <div style={{ marginTop: 12 }}>{st.data.link ? <ApiSync link={st.data.link} /> : <SpreadsheetImport />}</div>
      </details>
    </>
  );
}

// ---------------------------------------------------------------------------
// Free accounts: upload "Export as spreadsheet" files.
function SpreadsheetImport() {
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<any[]>('/api/accounts') });
  const payFrom = (accounts.data ?? []).filter((a) => ['bank', 'cash', 'wallet', 'credit_card'].includes(a.kind) && !a.is_archived);
  const [files, setFiles] = useState<SwCsvFile[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [acc, setAcc] = useState<string | null>(store.get('paisa.swAccount'));
  const [range, setRange] = useState(3);
  const [flip, setFlip] = useState(false);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any | null>(null);
  const accountId = acc ?? payFrom.find((a) => a.meta?.salary)?.id ?? payFrom[0]?.id ?? null;
  const people = [...new Set(files.flatMap((f) => f.people))];
  const since = RANGES[range][1]();

  async function addFiles(list: File[]) {
    setErr(null); setResult(null);
    const parsed: SwCsvFile[] = [];
    for (const f of list) {
      try {
        const k = kindOf(f);
        parsed.push(k === 'pdf' ? parseSplitwiseGrid(pdfTableGrid(await pdfRows(f, promptPassword), isSplitwiseHeader), f.name)
          : k === 'excel' ? parseSplitwiseGrid(rowsToGrid(await excelRows(f)), f.name)
          : parseSplitwiseCsv(await f.text(), f.name));
      } catch (e: any) { if (!(e instanceof Cancelled)) setErr(e.message); }
    }
    const all = [...files.filter((x) => !parsed.some((p) => p.name === x.name)), ...parsed];
    setFiles(all);
    const remembered = store.get('paisa.swMe');
    const pick = guessMe(all) ?? (remembered && all.every((f) => f.people.includes(remembered)) ? remembered : null);
    if (pick) setMe(pick);
  }

  const body = () => ({ me, since, defaultAccountId: accountId, flip, skip: [...skip],
    files: files.map((f) => ({ name: f.name, rows: f.rows })) });

  useEffect(() => {
    if (!files.length || !me || !accountId) { setPlan(null); return; }
    let live = true;
    setBusy(true); setErr(null);
    api<any>('/api/splitwise/csv/preview', { method: 'POST', body: body() })
      .then((p) => { if (live) setPlan(p); })
      .catch((e) => { if (live) setErr(e.message); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [files, me, accountId, range, flip]); // eslint-disable-line react-hooks/exhaustive-deps

  async function doImport() {
    setBusy(true); setErr(null);
    try {
      const r = await api<any>('/api/splitwise/csv/import', { method: 'POST', body: body() });
      setResult(r);
      if (me) store.set('paisa.swMe', me);
      if (accountId) store.set('paisa.swAccount', accountId);
      await qc.invalidateQueries();
      setPlan(await api<any>('/api/splitwise/csv/preview', { method: 'POST', body: body() }));
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <>
      <div className="card">
        <p className="small" style={{ marginTop: 0 }}>Works with a free Splitwise account. Your share of each bill counts as spending, and each friend becomes a person in Accounts with the same balance as in Splitwise. Paisa never changes anything in Splitwise.</p>
        <ol className="small muted" style={{ paddingLeft: 18 }}>
          <li>On a computer, open <b>splitwise.com</b> and sign in.</li>
          <li>Open a <b>group</b> (or a <b>friend</b>), click the <b>⚙ gear</b> in the right-hand column, then <b>Export as spreadsheet</b>.</li>
          <li>Repeat for each group, and for each friend you have non-group expenses with.</li>
          <li>Upload all the files here together.</li>
        </ol>
        <label className="dropzone">
          <input type="file" accept={UPLOAD_ACCEPT} multiple onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; if (fs.length) addFiles(fs); }} />
          <b>{files.length ? `${files.length} file${files.length > 1 ? 's' : ''}: ${files.map((f) => f.name).join(', ')}` : 'Choose Splitwise exports'}</b>
          <span className="tiny faint">{files.length ? 'Tap to add more' : 'CSV, Excel, PDF or TXT, read on this device'}</span>
        </label>
        {files.length > 0 && <button className="btn small" style={{ marginTop: 8 }} onClick={() => { setFiles([]); setPlan(null); setResult(null); }}>Clear files</button>}

        {people.length > 0 && (
          <>
            <div className="field" style={{ marginTop: 14 }}><label>Which one is you?</label>
              <div className="chips">{people.map((p) => <button key={p} className={`chip ${me === p ? 'on' : ''}`} onClick={() => setMe(p)}>{p}</button>)}</div>
            </div>
            <div className="field"><label>When you pay or get paid back, it's usually through</label>
              <div className="chips">{payFrom.map((a) => <button key={a.id} className={`chip ${accountId === a.id ? 'on' : ''}`} onClick={() => setAcc(a.id)}>{a.icon ?? ''} {a.name}</button>)}</div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}><label>Import expenses from</label>
              <div className="seg full">{RANGES.map(([l], i) => <button key={l} className={range === i ? 'on' : ''} onClick={() => setRange(i)}>{l}</button>)}</div>
              <span className="tiny faint">Older expenses aren't listed one by one but still count toward each person's balance.</span>
            </div>
          </>
        )}
        {err && <p className="error">{err}</p>}
      </div>

      {busy && !plan && <div className="card" style={{ marginTop: 12 }}><div className="skeleton" /></div>}
      {plan && (
        <>
          <div className={`banner ${plan.signEvidence ? '' : 'warn'}`} style={{ marginTop: 14 }}>
            <span>
              {plan.signEvidence
                ? <>Direction checked against {plan.signEvidence} settle-up{plan.signEvidence > 1 ? 's' : ''}. Make sure one balance below matches Splitwise.</>
                : <>No settle-ups to confirm the direction. <b>Check a balance below against Splitwise</b>; if it's the wrong way round, flip it.</>}
            </span>
            <button onClick={() => setFlip((f) => !f)}>{flip ? 'Undo flip' : 'Flip'}</button>
          </div>
          <PlanView p={plan} skip={skip} setSkip={setSkip} />
          <div className="card" style={{ marginTop: 12 }}>
            <PlanFooter p={plan} skip={skip} />
            <button className="btn accent block" disabled={busy || !plan.expenses.some((e: any) => e.status === 'new' && !skip.has(String(e.id))) && plan.friends.every((f: any) => f.accountId)} onClick={doImport}>
              {busy ? 'Working…' : `Import ${plan.expenses.filter((e: any) => e.status === 'new' && !skip.has(String(e.id))).length} from Splitwise`}
            </button>
            <p className="tiny faint" style={{ marginBottom: 0 }}>To update later, export the same groups again and upload them. Only new expenses are added.</p>
          </div>
        </>
      )}
      {result && <ResultCard r={result} />}

      <details className="card" style={{ marginTop: 14 }}>
        <summary className="small">Have Splitwise Pro? Sync automatically with an API key</summary>
        <ApiLinkForm />
      </details>
    </>
  );
}

// ---------------------------------------------------------------------------
// Pro accounts: API key link.
function ApiLinkForm() {
  const qc = useQueryClient();
  const { toast } = useUi();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<any[]>('/api/accounts') });
  const payFrom = (accounts.data ?? []).filter((a) => ['bank', 'cash', 'wallet', 'credit_card'].includes(a.kind) && !a.is_archived);
  const [apiKey, setApiKey] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function doLink(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    const accountId = payFrom.find((a) => a.meta?.salary)?.id ?? payFrom[0]?.id;
    if (!accountId) return setErr('Add a bank account first');
    setBusy(true);
    try {
      const r = await api<any>('/api/splitwise/link', { method: 'POST', body: { apiKey: apiKey.trim(), defaultAccountId: accountId } });
      setApiKey(''); toast(`Connected as ${r.userName}`);
      await qc.invalidateQueries({ queryKey: ['splitwise'] });
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={doLink} style={{ marginTop: 12 }}>
      <p className="tiny muted">At secure.splitwise.com/apps, register an application (needs Pro), then create an API key under <b>API keys</b>.</p>
      <div className="field"><label>API key</label><input className="input num" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" required /></div>
      {err && <p className="error">{err}</p>}
      <button className="btn block" disabled={busy}>{busy ? 'Checking…' : 'Connect'}</button>
    </form>
  );
}

function ApiSync({ link }: { link: any }) {
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<any[]>('/api/accounts') });
  const payFrom = (accounts.data ?? []).filter((a) => ['bank', 'cash', 'wallet', 'credit_card'].includes(a.kind) && !a.is_archived);
  const [range, setRange] = useState(1);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any | null>(null);
  const since = RANGES[range][1]();
  const preview = useQuery({ queryKey: ['splitwise-preview', since], queryFn: () => api<any>(`/api/splitwise/preview${since ? `?since=${since}` : ''}`), staleTime: 60_000 });
  const p = preview.data;

  async function doImport() {
    setBusy(true); setErr(null);
    try {
      setResult(await api<any>('/api/splitwise/import', { method: 'POST', body: { since, skip: [...skip].map(Number) } }));
      await qc.invalidateQueries();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <>
      <div className="card">
        <div className="spread"><span className="small">Connected as <b>{link.sw_user_name}</b>{link.last_synced_at ? ` · synced ${new Date(link.last_synced_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : ''}</span>
          <button className="btn small" onClick={async () => { if (confirm('Disconnect Splitwise? Imported entries stay.')) { await api('/api/splitwise', { method: 'DELETE' }); await qc.invalidateQueries({ queryKey: ['splitwise'] }); } }}>Disconnect</button></div>
        <div className="field" style={{ marginTop: 12 }}><label>Payments and settle-ups go through</label>
          <div className="chips">{payFrom.map((a) => (
            <button key={a.id} className={`chip ${link.default_account_id === a.id ? 'on' : ''}`}
              onClick={async () => { await api('/api/splitwise/account', { method: 'PUT', body: { accountId: a.id } }); await qc.invalidateQueries({ queryKey: ['splitwise'] }); }}>{a.icon ?? ''} {a.name}</button>
          ))}</div>
        </div>
        <div className="field" style={{ marginBottom: 0 }}><label>Import expenses from</label>
          <div className="seg full">{RANGES.map(([l], i) => <button key={l} className={range === i ? 'on' : ''} onClick={() => { setRange(i); setSkip(new Set()); setResult(null); }}>{l}</button>)}</div>
        </div>
      </div>
      {preview.isLoading && <div className="card" style={{ marginTop: 12 }}><div className="skeleton" /></div>}
      {preview.isError && <p className="error">{(preview.error as any).message}</p>}
      {p && (
        <>
          <PlanView p={p} skip={skip} setSkip={setSkip} />
          <div className="card" style={{ marginTop: 12 }}>
            <PlanFooter p={p} skip={skip} />
            {err && <p className="error">{err}</p>}
            <button className="btn accent block" disabled={busy} onClick={doImport}>{busy ? 'Importing…' : 'Import from Splitwise'}</button>
          </div>
        </>
      )}
      {result && <ResultCard r={result} />}
    </>
  );
}

// ---------------------------------------------------------------------------
function PlanView({ p, skip, setSkip }: { p: any; skip: Set<string>; setSkip: (f: (s: Set<string>) => Set<string>) => void }) {
  const newOnes = p.expenses.filter((e: any) => e.status === 'new');
  return (
    <>
      <div className="section">
        <div className="section-title">Balances</div>
        <div className="list">
          {p.friends.length === 0 && <div className="empty">No balances or shared expenses found.</div>}
          {p.friends.map((f: any) => {
            const pending = newOnes.filter((e: any) => !skip.has(String(e.id))).flatMap((e: any) => e.people).filter((x: any) => String(x.swId) === String(f.swId)).reduce((s: number, x: any) => s + x.amount, 0);
            const after = f.accountId ? (f.appBalance ?? 0) + pending : f.allTime;
            const mismatch = f.accountId && after !== f.allTime;
            return (
              <div key={String(f.swId)} className="item" style={{ cursor: 'default' }}>
                <div className="avatar" style={tint(f.name)} aria-hidden>🧑</div>
                <div className="grow">
                  <div className="title">{f.name}</div>
                  <div className="sub">{f.accountId ? `Linked to ${f.accountName} in Paisa` : 'Will be added as a person'}</div>
                  {mismatch && <div className="sub" style={{ color: 'var(--warn)', whiteSpace: 'normal' }}>Paisa will show {money(after, { whole: true })}, not {money(f.allTime, { whole: true })}: there are older or hand-entered entries with {f.name.split(' ')[0]}. Check for doubles.</div>}
                </div>
                <div className="amt">
                  <div className="num" style={{ color: f.allTime < 0 ? 'var(--up)' : f.allTime > 0 ? 'var(--down)' : undefined }}>{money(Math.abs(f.allTime), { whole: true })}</div>
                  <div className="tiny faint">{f.allTime > 0 ? 'owes you' : f.allTime < 0 ? 'you owe' : 'settled'}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="section">
        <div className="section-title"><span>{newOnes.length} new · {p.expenses.length - newOnes.length} already in</span></div>
        <SelectBar total={newOnes.length} selected={newOnes.filter((e: any) => !skip.has(String(e.id))).length}
          onAll={() => setSkip(() => new Set())} onNone={() => setSkip(() => new Set(newOnes.map((e: any) => String(e.id))))} />
        <div className="list">
          {p.expenses.length === 0 && <div className="empty">Nothing in this period.</div>}
          {p.expenses.slice(0, 300).map((e: any) => (
            <div key={String(e.id)} className={`imp-row ${e.status !== 'new' || skip.has(String(e.id)) ? 'off' : ''}`}>
              <label className="imp-check"><input type="checkbox" disabled={e.status !== 'new'} checked={e.status === 'new' && !skip.has(String(e.id))}
                onChange={(x) => setSkip((s) => { const n = new Set(s); x.target.checked ? n.delete(String(e.id)) : n.add(String(e.id)); return n; })} /></label>
              <div className="grow">
                <div className="spread"><span className="title">{e.description}</span><span className="num amt">{e.yourShare ? money(e.yourShare) : money(Math.abs(e.bank))}</span></div>
                <div className="sub">
                  {shortDate(e.date)} · {e.yourShare === 0
                    ? (e.bank > 0 ? `${e.people[0]?.name ?? 'Someone'} paid you` : `You paid ${e.people.map((x: any) => x.name).join(', ') || 'someone'}`)
                    : `Your share · ${e.categoryName ?? ''}${e.youPaid ? ` · you paid ${money(e.youPaid, { whole: true })}` : ''}`}
                </div>
                {e.people.length > 0 && e.yourShare > 0 && (
                  <div className="sub">{e.people.map((x: any) => `${x.name} ${x.amount > 0 ? 'owes you' : '← you owe'} ${money(Math.abs(x.amount), { whole: true })}`).join(' · ')}</div>
                )}
                {e.status === 'imported' && <div className="pill-s">Already imported</div>}
              </div>
            </div>
          ))}
          {p.expenses.length > 300 && <div className="empty">…and {p.expenses.length - 300} more</div>}
        </div>
      </div>
    </>
  );
}

function PlanFooter({ p, skip }: { p: any; skip: Set<string> }) {
  const toImport = p.expenses.filter((e: any) => e.status === 'new' && !skip.has(String(e.id)));
  const share = toImport.reduce((s: number, e: any) => s + e.yourShare, 0);
  const left = [p.skippedCurrency && `${p.skippedCurrency} non-INR`, p.skippedInconsistent && `${p.skippedInconsistent} that didn't add up`, p.duplicatesAcrossFiles && `${p.duplicatesAcrossFiles} repeated across files`].filter(Boolean);
  return (
    <div className="small muted" style={{ marginBottom: 10 }}>
      {toImport.length} to import · your share {money(share, { whole: true })}
      {left.length > 0 && <div className="tiny faint">Left out: {left.join(', ')}.</div>}
    </div>
  );
}

function ResultCard({ r }: { r: any }) {
  return (
    <div className="section"><div className="card">
      <b>Imported {r.imported}{r.alreadyImported ? ` (${r.alreadyImported} were already in)` : ''}.</b>{r.matched ? <> {r.matched} matched entries you'd already added by hand, so they weren't added again.</> : null}
      <p className="small muted" style={{ marginBottom: 0 }}>
        {r.peopleCreated ? `${r.peopleCreated} people added to Accounts. ` : ''}{r.skipped ? `${r.skipped} skipped. ` : ''}
        {r.errors?.length ? `${r.errors.length} couldn't be imported: ${r.errors.slice(0, 2).join('; ')}` : ''}
      </p>
    </div></div>
  );
}

/** Read balances from screenshots of Splitwise's Friends list and set each person to match. */
function ScreenshotBalances() {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [rows, setRows] = useState<(Balance & { keep: boolean })[] | null>(null);
  const [scan, setScan] = useState<{ p: number; label: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<any | null>(null);
  async function read(files: File[]) {
    setErr(null); setDone(null); setScan({ p: 0, label: 'Starting…' });
    try {
      const { filesToTexts } = await import('../files');
      const texts = await filesToTexts(files, (p, label) => setScan({ p, label }));
      const seen = new Map<string, Balance>();
      for (const t of texts) for (const b of parseSplitwiseBalances(t)) if (!seen.has(b.name.toLowerCase())) seen.set(b.name.toLowerCase(), b);
      if (!seen.size) { setErr("Couldn't find balances. Use the Friends tab, where each row says \"owes you\" or \"you owe\"."); return; }
      setRows([...seen.values()].map((b) => ({ ...b, keep: true })));
    } catch (e: any) { setErr(e.message); } finally { setScan(null); }
  }
  async function apply() {
    const balances = (rows ?? []).filter((r) => r.keep).map(({ name, amount }) => ({ name, amount }));
    try {
      const r = await api<any>('/api/people/balances', { method: 'POST', body: { balances } });
      setDone(r); setRows(null);
      await qc.invalidateQueries();
      toast(`Updated ${r.people.length} people`);
    } catch (e: any) { setErr(e.message); }
  }
  return (
    <div className="card">
      <b>From screenshots</b>
      <p className="small muted" style={{ marginTop: 4 }}>In the Splitwise app, open <b>Friends</b> and screenshot the list (scroll and take more if needed). Paisa reads who owes whom and sets each person's balance in Accounts to match.</p>
      {!rows && (
        <label className="dropzone">
          <input type="file" accept="image/*,.pdf,.xlsx,.xls,.csv,.txt,application/pdf,text/plain,text/csv" multiple onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; if (fs.length) read(fs); }} />
          <b>Add Splitwise screenshots</b><span className="tiny faint">Screenshots, or a PDF / Excel / CSV / TXT of the list. Read on this phone</span>
        </label>
      )}
      {scan && <div className="scan-progress" style={{ marginTop: 10 }}><span style={{ width: `${Math.round(scan.p * 100)}%` }} /><em>{scan.label}</em></div>}
      {rows && (
        <>
          <SelectBar total={rows.length} selected={rows.filter((r) => r.keep).length} label="included"
            onAll={() => setRows((xs) => xs!.map((x) => ({ ...x, keep: true })))} onNone={() => setRows((xs) => xs!.map((x) => ({ ...x, keep: false })))} />
          <div className="list" style={{ margin: '10px 0' }}>
            {rows.map((r, k) => (
              <div key={k} className="buy-row">
                <input type="checkbox" checked={r.keep} onChange={(e) => setRows((xs) => xs!.map((x, j) => (j === k ? { ...x, keep: e.target.checked } : x)))} aria-label={`Include ${r.name}`} />
                <input className="input" value={r.name} onChange={(e) => setRows((xs) => xs!.map((x, j) => (j === k ? { ...x, name: e.target.value } : x)))} />
                <select className="input" value={r.amount > 0 ? 'owes' : r.amount < 0 ? 'owe' : 'settled'} onChange={(e) => setRows((xs) => xs!.map((x, j) => (j === k ? { ...x, amount: e.target.value === 'settled' ? 0 : (e.target.value === 'owes' ? 1 : -1) * Math.abs(x.amount) } : x)))}>
                  <option value="owes">owes you</option><option value="owe">you owe</option><option value="settled">settled</option>
                </select>
                <input className="input num paid" inputMode="decimal" value={Math.abs(r.amount) / 100} onChange={(e) => setRows((xs) => xs!.map((x, j) => (j === k ? { ...x, amount: Math.sign(x.amount || 1) * Math.round(Number(e.target.value || 0) * 100) } : x)))} />
              </div>
            ))}
          </div>
          <button className="btn accent block" onClick={apply}>Update {rows.filter((r) => r.keep).length} balances</button>
          <button className="btn block" style={{ marginTop: 8 }} onClick={() => setRows(null)}>Start over</button>
        </>
      )}
      {done && <p className="small" style={{ marginBottom: 0 }}>✓ {done.people.map((p: any) => `${p.accountName}${p.created ? ' (new)' : ''}: ${p.balance > 0 ? 'owes you' : p.balance < 0 ? 'you owe' : 'settled'} ${money(Math.abs(p.balance), { whole: true })}`).join(' · ')}</p>}
      {err && <p className="error">{err}</p>}
      <p className="tiny faint" style={{ marginBottom: 0 }}>Balances are set with an adjustment, so they never count as spending.</p>
    </div>
  );
}
