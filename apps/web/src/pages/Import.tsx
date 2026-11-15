import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api, money, shortDate, parseRupees } from '../lib';
import { useUi } from '../App';
import { parseStatement, parseStatementGrid, isStatementHeader, guessBooking, type ParsedStatement, type StatementRow } from '../statement';
import { UPLOAD_ACCEPT, kindOf, pdfRows, pdfTableGrid, excelRows, rowsToGrid, promptPassword, Cancelled } from '../files';
import { SelectBar } from '../components/SelectBar';
import { readCasPdf, type CasResult } from '../cas';

export function Import() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'cas' ? 'cas' : 'statement';
  return (
    <>
      <h1 className="page-title">Import</h1>
      <div className="seg full" style={{ marginBottom: 16 }}>
        <button className={tab === 'statement' ? 'on' : ''} onClick={() => setParams({})}>Bank / card statement</button>
        <button className={tab === 'cas' ? 'on' : ''} onClick={() => setParams({ tab: 'cas' })}>Mutual funds (CAS)</button>
      </div>
      {tab === 'statement' ? <StatementImport /> : <CasImport />}
    </>
  );
}

// ---------------------------------------------------------------------------
interface RowState extends StatementRow {
  i: number; status: 'new' | 'possible' | 'duplicate'; match?: any;
  include: boolean; kind: 'expense' | 'income' | 'transfer'; categoryId: string | null; otherAccountId: string | null;
}

function StatementImport() {
  const qc = useQueryClient();
  const { toast } = useUi();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<any[]>('/api/accounts') });
  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api<any[]>('/api/categories') });
  const batches = useQuery({ queryKey: ['import-batches'], queryFn: () => api<any[]>('/api/import/batches') });
  const salary = useQuery({ queryKey: ['salary'], queryFn: () => api<any>('/api/salary') });
  const [accountId, setAccountId] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParsedStatement | null>(null);
  const [rows, setRows] = useState<RowState[] | null>(null);
  const [closing, setClosing] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any | null>(null);
  const [filter, setFilter] = useState<'all' | 'new' | 'check'>('all');

  const own = (accounts.data ?? []).filter((a) => ['bank', 'credit_card', 'wallet', 'cash'].includes(a.kind) && !a.is_archived);
  const transferTargets = (accounts.data ?? []).filter((a) => (a.class === 'asset' || a.class === 'liability') && !a.is_archived && a.id !== accountId);
  const cats = categories.data ?? [];
  const byId = new Map(cats.map((c: any) => [c.id, c]));
  const leaf = (cls: string) => cats.filter((c: any) => c.class === cls && !cats.some((x: any) => x.parent_id === c.id));
  const label = (c: any) => `${c.parent_id ? `${byId.get(c.parent_id)?.name} › ` : ''}${c.name}`;

  async function read(f: File, acc: string) {
    setErr(null); setResult(null); setRows(null);
    let p: ParsedStatement;
    try {
      const k = kindOf(f);
      if (k === 'image') return setErr('That is an image. Upload the statement as PDF, Excel, CSV or TXT.');
      p = k === 'pdf' ? parseStatementGrid(pdfTableGrid(await pdfRows(f, promptPassword), isStatementHeader))
        : k === 'excel' ? parseStatementGrid(rowsToGrid(await excelRows(f, true)))
        : parseStatement(await f.text());
    } catch (e: any) { if (!(e instanceof Cancelled)) setErr(e.message ?? 'Could not read that file.'); return; }
    setParsed(p);
    if (!p.rows.length) return setErr("Couldn't find transactions in this file. It needs a header row with Date, Narration/Particulars and Debit/Credit (or Withdrawal/Deposit) columns.");
    setClosing(p.closing ? String(p.closing.balance / 100) : '');
    setBusy(true);
    try {
      const pv = await api<any>('/api/import/preview', { method: 'POST', body: { accountId: acc, rows: p.rows } });
      setRows(p.rows.map((r, i) => {
        const v = pv.rows[i];
        const g = guessBooking(r, { accounts: accounts.data ?? [], categories: cats, accountId: acc, historyCategoryId: v.suggestedCategoryId, employer: salary.data?.profile?.employer });
        return { ...r, i, status: v.status, match: v.match, include: v.status === 'new', ...g };
      }));
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  const set = (i: number, patch: Partial<RowState>) => setRows((rs) => rs!.map((r) => (r.i === i ? { ...r, ...patch } : r)));
  const chosen = rows?.filter((r) => r.include) ?? [];
  const totals = useMemo(() => ({
    out: chosen.filter((r) => r.amount < 0).reduce((s, r) => s - r.amount, 0),
    in: chosen.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0),
  }), [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  async function commit() {
    if (!rows || !accountId) return;
    const bad = chosen.find((r) => (r.kind === 'transfer' ? !r.otherAccountId : !r.categoryId));
    if (bad) return setErr(`Row "${bad.merchant ?? bad.description.slice(0, 30)}" needs a ${bad.kind === 'transfer' ? 'destination account' : 'category'}.`);
    setBusy(true); setErr(null);
    try {
      const closingPaise = parseRupees(closing.replace(/^-/, ''));
      const r = await api<any>('/api/import/commit', { method: 'POST', body: {
        accountId, fileName: file?.name, totalRows: rows.length,
        closing: closingPaise !== null && parsed?.closing ? { balance: closing.trim().startsWith('-') ? -closingPaise : closingPaise, date: parsed.closing.date } : null,
        rows: chosen.map((x) => ({ date: x.date, amount: x.amount, description: x.description, merchant: x.merchant, ref: x.ref, balance: x.balance,
          kind: x.kind, categoryId: x.kind === 'transfer' ? null : x.categoryId, otherAccountId: x.kind === 'transfer' ? x.otherAccountId : null })),
      } });
      setResult(r); setRows(null);
      await qc.invalidateQueries();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  async function fixBalance() {
    if (!result?.reconciliation || !accountId) return;
    const r = await api<any>(`/api/accounts/${accountId}/reconcile`, { method: 'POST', body: { date: result.reconciliation.date, balance: result.reconciliation.statement } });
    await qc.invalidateQueries();
    setResult({ ...result, reconciliation: { ...result.reconciliation, ledger: result.reconciliation.statement, difference: 0, adjusted: r.adjusted } });
    toast('Balance now matches the statement');
  }

  const visible = (rows ?? []).filter((r) => filter === 'all' || (filter === 'new' ? r.status === 'new' : r.status !== 'new'));

  return (
    <>
      <div className="card">
        <div className="field"><label>Which account is this statement for?</label>
          <div className="chips">{own.map((a) => (
            <button key={a.id} className={`chip ${accountId === a.id ? 'on' : ''}`} onClick={() => { setAccountId(a.id); if (file) read(file, a.id); }}>{a.icon ?? ''} {a.name}</button>
          ))}</div>
        </div>
        <label className={`dropzone ${!accountId ? 'disabled' : ''}`}>
          <input type="file" accept={UPLOAD_ACCEPT} disabled={!accountId}
            onChange={(e) => { const f = e.target.files?.[0]; if (f && accountId) { setFile(f); read(f, accountId); } e.target.value = ''; }} />
          <b>{file ? file.name : 'Choose statement file'}</b>
          <span className="tiny faint">{accountId ? 'PDF, Excel, CSV or TXT, from net banking. Read on this device; locked PDFs ask for their password.' : 'Pick the account first'}</span>
        </label>
        <details className="tiny muted" style={{ marginTop: 10 }}>
          <summary>How to download it</summary>
          <p>In net banking or your bank's app: Accounts → Statement → pick the dates → download as <b>CSV, Excel, TXT</b> or <b>PDF</b>. CSV or Excel reads most reliably.<br />
            <b>Credit cards:</b> most only give PDFs; if yours offers CSV/Excel, save it as CSV and import it against the card.</p>
        </details>
        {err && <p className="error">{err}</p>}
        {busy && <p className="small muted">Working…</p>}
      </div>

      {rows && (
        <div className="section">
          <div className="spread" style={{ marginBottom: 10 }}>
            <div className="section-title" style={{ margin: 0 }}>{rows.length} rows{parsed?.bank ? ` · ${parsed.bank} format` : ''}</div>
            <div className="seg">
              {(['all', 'new', 'check'] as const).map((f) => <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{f === 'all' ? 'All' : f === 'new' ? 'New' : 'Already in'}</button>)}
            </div>
          </div>
          <SelectBar total={visible.filter((r) => r.status !== 'duplicate').length} selected={visible.filter((r) => r.include).length}
            onAll={() => setRows((rs) => rs!.map((r) => (visible.includes(r) && r.status !== 'duplicate' ? { ...r, include: true } : r)))}
            onNone={() => setRows((rs) => rs!.map((r) => (visible.includes(r) ? { ...r, include: false } : r)))} />
          <div className="list import-list">
            {visible.map((r) => (
              <div key={r.i} className={`imp-row ${r.include ? '' : 'off'}`}>
                <label className="imp-check"><input type="checkbox" checked={r.include} disabled={r.status === 'duplicate'} onChange={(e) => set(r.i, { include: e.target.checked })} /></label>
                <div className="grow">
                  <div className="spread">
                    <span className="title">{r.merchant ?? r.description.slice(0, 40)}</span>
                    <span className={`num amt ${r.amount > 0 ? 'pos' : ''}`}>{r.amount > 0 ? '+' : '−'}{money(Math.abs(r.amount))}</span>
                  </div>
                  <div className="sub">{shortDate(r.date)} · {r.description}</div>
                  {r.status === 'duplicate' && <div className="pill-s">Already imported</div>}
                  {r.status === 'possible' && <div className="pill-s warn">Looks like “{r.match?.title ?? 'an entry'}” you added on {shortDate(r.match.date)}. Left unticked so it isn't counted twice.</div>}
                  {r.status !== 'duplicate' && r.include && (
                    <div className="imp-controls">
                      <select className="input" value={r.kind} onChange={(e) => set(r.i, { kind: e.target.value as any, categoryId: null, otherAccountId: null })}>
                        {r.amount < 0 ? <option value="expense">Spending</option> : <option value="income">Income</option>}
                        <option value="transfer">{r.amount < 0 ? 'Transfer out' : 'Transfer in'}</option>
                      </select>
                      {r.kind === 'transfer' ? (
                        <select className="input" value={r.otherAccountId ?? ''} onChange={(e) => set(r.i, { otherAccountId: e.target.value || null })}>
                          <option value="">{r.amount < 0 ? 'To…' : 'From…'}</option>
                          {transferTargets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                        </select>
                      ) : (
                        <select className="input" value={r.categoryId ?? ''} onChange={(e) => set(r.i, { categoryId: e.target.value || null })}>
                          <option value="">Category…</option>
                          {leaf(r.kind).map((c: any) => <option key={c.id} value={c.id}>{label(c)}</option>)}
                        </select>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="card" style={{ marginTop: 12 }}>
            <div className="field" style={{ marginBottom: 8 }}>
              <label>Closing balance on the statement{parsed?.closing ? ` (${shortDate(parsed.closing.date)})` : ''}</label>
              <input className="input num" inputMode="decimal" value={closing} onChange={(e) => setClosing(e.target.value)} placeholder="Optional, used to check everything adds up" />
            </div>
            <div className="small muted" style={{ marginBottom: 10 }}>{chosen.length} selected · {money(totals.out, { whole: true })} out · {money(totals.in, { whole: true })} in</div>
            <button className="btn accent block" disabled={busy || chosen.length === 0} onClick={commit}>{busy ? 'Importing…' : `Import ${chosen.length} transactions`}</button>
          </div>
        </div>
      )}

      {result && (
        <div className="section">
          <div className="card">
            <b>Imported {result.imported}{result.skipped ? `, skipped ${result.skipped} already there` : ''}.</b>
            {result.errors?.length > 0 && <p className="error small">{result.errors.length} rows failed: {result.errors.slice(0, 3).map((e: any) => e.message).join('; ')}</p>}
            {result.reconciliation && (
              result.reconciliation.difference === 0 ? (
                <p className="small" style={{ color: 'var(--down)', marginBottom: 0 }}>✓ Reconciled: Paisa's balance on {shortDate(result.reconciliation.date)} matches the statement ({money(result.reconciliation.statement)}).</p>
              ) : (
                <>
                  <p className="small" style={{ marginBottom: 8 }}>
                    On {shortDate(result.reconciliation.date)} the statement says <b>{money(result.reconciliation.statement)}</b>; Paisa says <b>{money(result.reconciliation.ledger)}</b>.
                    Difference: <b style={{ color: 'var(--up)' }}>{money(result.reconciliation.difference, { sign: true })}</b>.
                  </p>
                  <p className="tiny faint">Usually this means the opening balance was off, or some older transactions aren't in Paisa. You can add them, or set the balance to match with one adjustment entry.</p>
                  <button className="btn small" onClick={fixBalance}>Set balance to match statement</button>
                </>
              )
            )}
          </div>
        </div>
      )}

      {(batches.data?.length ?? 0) > 0 && (
        <div className="section">
          <div className="section-title">Recent imports</div>
          <div className="list">
            {batches.data!.map((b) => (
              <div key={b.id} className="item" style={{ cursor: 'default' }}>
                <div className="grow">
                  <div className="title">{b.file_name ?? b.source}</div>
                  <div className="sub">{b.source === 'cas' ? 'Mutual funds' : b.account_name} · {b.rows_imported} of {b.rows_total} · {new Date(b.imported_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</div>
                </div>
                {b.source === 'statement' && b.rows_imported > 0 && (
                  <button className="btn small" onClick={async () => {
                    if (!confirm('Undo this import? Its transactions are removed (they stay restorable in history).')) return;
                    const r = await api<any>(`/api/import/batches/${b.id}/undo`, { method: 'POST' });
                    await qc.invalidateQueries(); toast(`Removed ${r.voided} transactions`);
                  }}>Undo</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
function CasImport() {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [parsed, setParsed] = useState<CasResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any | null>(null);

  async function read() {
    if (!file) return;
    setErr(null); setParsed(null); setResult(null); setBusy(true);
    try {
      const r = await readCasPdf(file, password.trim());
      if (!r.holdings.length) setErr("Opened the PDF but found no fund holdings. This works with the detailed CAS from CAMS, KFintech or MF Central.");
      setParsed(r);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  async function save() {
    if (!parsed) return;
    setBusy(true);
    try {
      const r = await api<any>('/api/cas/import', { method: 'POST', body: {
        statementDate: parsed.statementDate ?? new Date().toISOString().slice(0, 10), fileName: file?.name,
        holdings: parsed.holdings.map((h) => ({ isin: h.isin, name: h.name, folio: h.folio, units: h.units, nav: h.nav, value: h.value, cost: h.cost })),
      } });
      setResult(r); setParsed(null);
      await qc.invalidateQueries();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  const total = parsed?.holdings.reduce((s, h) => s + h.value, 0) ?? 0;
  return (
    <>
      <div className="card">
        <p className="small muted" style={{ marginTop: 0 }}>A CAS lists every mutual fund under your PAN: Groww, Kuvera, direct with the AMC and more. Funds Zerodha already reports are skipped, so nothing counts twice.</p>
        <label className="dropzone">
          <input type="file" accept="application/pdf,.pdf" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setParsed(null); setResult(null); e.target.value = ''; }} />
          <b>{file ? file.name : 'Choose CAS PDF'}</b><span className="tiny faint">Unlocked and read on this device. The password isn't sent anywhere.</span>
        </label>
        <div className="field" style={{ marginTop: 12 }}><label>PDF password</label>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Usually your PAN in capitals" autoComplete="off" /></div>
        <button className="btn primary block" disabled={!file || busy} onClick={read}>{busy ? 'Reading…' : 'Read statement'}</button>
        {err && <p className="error">{err}</p>}
        <details className="tiny muted" style={{ marginTop: 10 }}>
          <summary>How to get a CAS</summary>
          <p>Go to <b>camsonline.com</b> → Investors → Statements → <b>CAS – CAMS+KFintech</b>. Choose <b>Detailed</b>, a period up to today, and set a password. It arrives by email in a few minutes. MF Central (mfcentral.com) also works.</p>
        </details>
      </div>

      {parsed && parsed.holdings.length > 0 && (
        <div className="section">
          <div className="section-title">{parsed.holdings.length} funds · {money(Math.round(total * 100), { whole: true })}{parsed.statementDate ? ` · as of ${shortDate(parsed.statementDate)}` : ''}</div>
          <div className="list">
            {parsed.holdings.map((h) => (
              <div key={h.isin} className="item" style={{ cursor: 'default' }}>
                <div className="avatar" aria-hidden>🧺</div>
                <div className="grow"><div className="title">{h.name}</div><div className="sub num">{h.units.toLocaleString('en-IN', { maximumFractionDigits: 3 })} units @ ₹{h.nav.toLocaleString('en-IN')}{h.cost ? ` · invested ${money(Math.round(h.cost * 100), { whole: true })}` : ''}</div></div>
                <div className="amt num">{money(Math.round(h.value * 100), { whole: true })}</div>
              </div>
            ))}
          </div>
          <button className="btn accent block" style={{ marginTop: 12 }} disabled={busy} onClick={save}>Add to net worth</button>
        </div>
      )}
      {result && (
        <div className="section"><div className="card">
          <b>Added {result.imported} funds worth {money(result.value, { whole: true })}.</b>
          {result.skippedAlreadyInZerodha?.length > 0 && <p className="small muted" style={{ marginBottom: 0 }}>Skipped (already synced from Zerodha): {result.skippedAlreadyInZerodha.join(', ')}.</p>}
          <p className="tiny faint" style={{ marginBottom: 0 }}>They show under Accounts → Mutual funds. Import a fresh CAS any time to update values.</p>
        </div></div>
      )}
    </>
  );
}
