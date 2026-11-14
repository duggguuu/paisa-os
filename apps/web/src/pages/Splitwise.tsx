import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, money, shortDate, todayIST, addDays } from '../lib';
import { useUi } from '../App';
import { tint } from '../components/Icons';

const RANGES: [string, () => string | null][] = [
  ['This month', () => todayIST().slice(0, 8) + '01'],
  ['3 months', () => addDays(todayIST(), -92)],
  ['This year', () => todayIST().slice(0, 5) + '01-01'],
  ['Everything', () => null],
];

export function Splitwise() {
  const qc = useQueryClient();
  const { toast } = useUi();
  const st = useQuery({ queryKey: ['splitwise'], queryFn: () => api<any>('/api/splitwise') });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<any[]>('/api/accounts') });
  const payFrom = (accounts.data ?? []).filter((a) => ['bank', 'cash', 'wallet', 'credit_card'].includes(a.kind) && !a.is_archived);
  const [apiKey, setApiKey] = useState('');
  const [acc, setAcc] = useState<string | null>(null);
  const [range, setRange] = useState(1);
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any | null>(null);
  const link = st.data?.link;
  const since = RANGES[range][1]();
  const preview = useQuery({
    queryKey: ['splitwise-preview', since], enabled: !!link,
    queryFn: () => api<any>(`/api/splitwise/preview${since ? `?since=${since}` : ''}`),
    staleTime: 60_000,
  });

  async function doLink(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    const accountId = acc ?? payFrom.find((a) => a.meta?.salary)?.id ?? payFrom[0]?.id;
    if (!accountId) return setErr('Add a bank account first');
    setBusy(true);
    try {
      const r = await api<any>('/api/splitwise/link', { method: 'POST', body: { apiKey: apiKey.trim(), defaultAccountId: accountId } });
      setApiKey(''); toast(`Connected as ${r.userName}`);
      await qc.invalidateQueries({ queryKey: ['splitwise'] });
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  async function doImport() {
    setBusy(true); setErr(null);
    try {
      const r = await api<any>('/api/splitwise/import', { method: 'POST', body: { since, skip: [...skip] } });
      setResult(r);
      await qc.invalidateQueries();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  if (!st.data) return <><h1 className="page-title">Splitwise</h1><div className="card"><div className="skeleton" /></div></>;

  if (!link) return (
    <>
      <h1 className="page-title">Splitwise</h1>
      <div className="card">
        <p className="small" style={{ marginTop: 0 }}>Bring in your Splitwise expenses and balances. Your share of each bill counts as spending, and every friend becomes a person in Accounts with the same balance as in Splitwise. Paisa only reads; it never changes anything in Splitwise.</p>
        <ol className="small muted" style={{ paddingLeft: 18 }}>
          <li>On a computer, open <b>secure.splitwise.com/apps</b> and sign in.</li>
          <li>Click <b>Register your application</b>. Any name and URL work (e.g. "Paisa", your app link).</li>
          <li>On the app page, under <b>API keys</b>, click <b>Create API key</b> and copy it.</li>
        </ol>
        <form onSubmit={doLink}>
          <div className="field"><label>API key</label><input className="input num" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" required /></div>
          <div className="field"><label>When you pay or get paid back, it's usually from</label>
            <div className="chips">{payFrom.map((a) => <button type="button" key={a.id} className={`chip ${(acc ?? payFrom.find((x) => x.meta?.salary)?.id ?? payFrom[0]?.id) === a.id ? 'on' : ''}`} onClick={() => setAcc(a.id)}>{a.icon ?? ''} {a.name}</button>)}</div>
          </div>
          {err && <p className="error">{err}</p>}
          <button className="btn accent block" disabled={busy}>{busy ? 'Checking…' : 'Connect Splitwise'}</button>
        </form>
        <p className="tiny faint" style={{ marginBottom: 0 }}>The key is encrypted before it's stored, like your Zerodha secret.</p>
      </div>
    </>
  );

  const p = preview.data;
  const newOnes = (p?.expenses ?? []).filter((e: any) => e.status === 'new');
  const toImport = newOnes.filter((e: any) => !skip.has(e.id));
  const share = toImport.reduce((s: number, e: any) => s + e.yourShare, 0);

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Splitwise</h1>
        <button className="btn small" onClick={async () => { if (confirm('Disconnect Splitwise? Imported entries stay.')) { await api('/api/splitwise', { method: 'DELETE' }); await qc.invalidateQueries({ queryKey: ['splitwise'] }); } }}>Disconnect</button>
      </div>
      <div className="card">
        <div className="small">Connected as <b>{link.sw_user_name}</b>{link.last_synced_at ? ` · last synced ${new Date(link.last_synced_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}</div>
        <div className="field" style={{ marginTop: 12 }}><label>Payments and settle-ups go through</label>
          <div className="chips">{payFrom.map((a) => (
            <button key={a.id} className={`chip ${link.default_account_id === a.id ? 'on' : ''}`}
              onClick={async () => { await api('/api/splitwise/account', { method: 'PUT', body: { accountId: a.id } }); await qc.invalidateQueries({ queryKey: ['splitwise'] }); }}>{a.icon ?? ''} {a.name}</button>
          ))}</div>
        </div>
        <div className="field" style={{ marginBottom: 0 }}><label>Import expenses from</label>
          <div className="seg full">{RANGES.map(([l], i) => <button key={l} className={range === i ? 'on' : ''} onClick={() => { setRange(i); setSkip(new Set()); setResult(null); }}>{l}</button>)}</div>
          <span className="tiny faint">Anything older isn't listed one by one, but it still counts toward each person's balance.</span>
        </div>
      </div>

      {preview.isLoading && <div className="card" style={{ marginTop: 12 }}><div className="skeleton" /><p className="tiny faint">Reading Splitwise…</p></div>}
      {preview.isError && <p className="error">{(preview.error as any).message}</p>}

      {p && (
        <>
          <div className="section">
            <div className="section-title">Balances</div>
            <div className="list">
              {p.friends.length === 0 && <div className="empty">No balances or shared expenses yet.</div>}
              {p.friends.map((f: any) => {
                const after = f.accountId ? (f.appBalance ?? 0) + newOnes.filter((e: any) => !skip.has(e.id)).flatMap((e: any) => e.people).filter((x: any) => x.swId === f.swId).reduce((s: number, x: any) => s + x.amount, 0) : f.allTime;
                const mismatch = f.accountId && after !== f.allTime;
                return (
                  <div key={f.swId} className="item" style={{ cursor: 'default' }}>
                    <div className="avatar" style={tint(f.name)} aria-hidden>🧑</div>
                    <div className="grow">
                      <div className="title">{f.name}</div>
                      <div className="sub">{f.accountId ? `Linked to ${f.accountName} in Paisa` : 'Will be added as a person'}</div>
                      {mismatch && <div className="sub" style={{ color: 'var(--warn)' }}>Paisa will show {money(after, { whole: true })}, not {money(f.allTime, { whole: true })}: there are older or hand-entered entries with {f.name.split(' ')[0]}. Check for doubles.</div>}
                    </div>
                    <div className="amt">
                      <div className={`num ${f.allTime > 0 ? 'pos' : ''}`} style={{ color: f.allTime < 0 ? 'var(--up)' : undefined }}>{money(Math.abs(f.allTime), { whole: true })}</div>
                      <div className="tiny faint">{f.allTime > 0 ? 'owes you' : f.allTime < 0 ? 'you owe' : 'settled'}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="section">
            <div className="section-title"><span>{newOnes.length} new · {(p.expenses.length - newOnes.length)} already in</span>{(p.skippedCurrency > 0 || p.skippedInconsistent > 0) && <span className="tiny faint">{[p.skippedCurrency && `${p.skippedCurrency} non-INR`, p.skippedInconsistent && `${p.skippedInconsistent} that didn't add up`].filter(Boolean).join(', ')} left out</span>}</div>
            <div className="list">
              {p.expenses.length === 0 && <div className="empty">Nothing in this period.</div>}
              {p.expenses.map((e: any) => (
                <div key={e.id} className={`imp-row ${e.status !== 'new' || skip.has(e.id) ? 'off' : ''}`}>
                  <label className="imp-check"><input type="checkbox" disabled={e.status !== 'new'} checked={e.status === 'new' && !skip.has(e.id)}
                    onChange={(x) => setSkip((s) => { const n = new Set(s); x.target.checked ? n.delete(e.id) : n.add(e.id); return n; })} /></label>
                  <div className="grow">
                    <div className="spread"><span className="title">{e.description}</span><span className="num amt">{e.kind === 'transfer' ? money(Math.abs(e.bank)) : money(e.yourShare)}</span></div>
                    <div className="sub">
                      {shortDate(e.date)} · {e.kind === 'transfer' && e.yourShare === 0
                        ? (e.bank > 0 ? `${e.people[0]?.name ?? 'Someone'} paid you` : e.bank < 0 && e.people.length ? `You paid ${e.people.map((x: any) => x.name).join(', ')}` : 'Settle up')
                        : `Your share · ${e.categoryName ?? ''}${e.youPaid ? ` · you paid ${money(e.youPaid, { whole: true })}` : ''}`}
                    </div>
                    {e.people.length > 0 && e.kind !== 'transfer' && (
                      <div className="sub">{e.people.map((x: any) => `${x.name} ${x.amount > 0 ? 'owes you' : '← you owe'} ${money(Math.abs(x.amount), { whole: true })}`).join(' · ')}</div>
                    )}
                    {e.status === 'imported' && <div className="pill-s">Already imported</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{ marginTop: 12 }}>
            <div className="small muted" style={{ marginBottom: 10 }}>{toImport.length} to import · your share {money(share, { whole: true })}</div>
            {err && <p className="error">{err}</p>}
            <button className="btn accent block" disabled={busy || (toImport.length === 0 && p.friends.every((f: any) => f.accountId))} onClick={doImport}>
              {busy ? 'Importing…' : toImport.length ? `Import ${toImport.length} from Splitwise` : 'Sync balances'}
            </button>
            <p className="tiny faint" style={{ marginBottom: 0 }}>Safe to run again any time: only new expenses are added.</p>
          </div>
        </>
      )}

      {result && (
        <div className="section"><div className="card">
          <b>Imported {result.imported}{result.alreadyImported ? ` (${result.alreadyImported} were already in)` : ''}.</b>
          <p className="small muted" style={{ marginBottom: 0 }}>
            {result.peopleCreated ? `${result.peopleCreated} people added to Accounts. ` : ''}{result.skipped ? `${result.skipped} skipped. ` : ''}
            {result.errors.length ? `${result.errors.length} couldn't be imported: ${result.errors.slice(0, 2).join('; ')}` : ''}
          </p>
        </div></div>
      )}
    </>
  );
}
