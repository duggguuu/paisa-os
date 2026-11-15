import { tint } from '../components/Icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api, money, compact, parseRupees, KIND_LABEL, KIND_ICON, todayIST, dayLabel } from '../lib';
import { Sheet, useUi } from '../App';
import { RollingMoney } from '../components/Rolling';

const GROUPS: [string, string, (a: any) => boolean][] = [
  ['Money you can spend', 'Bank accounts, cash and wallets', (a) => ['bank', 'cash', 'wallet'].includes(a.kind)],
  ['Fixed deposits', '', (a) => a.kind === 'fd'],
  ['Investments', '', (a) => a.kind === 'investment'],
  ['People who owe you', '', (a) => a.kind === 'receivable'],
  ['You owe', 'Credit cards, loans', (a) => a.class === 'liability'],
];

export function Accounts() {
  const { toast } = useUi();
  const [params, setParams] = useSearchParams();
  const nw = useQuery({ queryKey: ['networth'], queryFn: () => api<any>('/api/networth') });
  const kite = useQuery({ queryKey: ['kite'], queryFn: () => api<any>('/api/kite') });
  const [editing, setEditing] = useState<any | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    const k = params.get('kite');
    if (!k) return;
    toast(k === 'synced' ? 'Zerodha holdings synced' : k === 'cancelled' ? 'Zerodha login cancelled' : k === 'login_failed' ? "Zerodha login didn't go through. Try again." : 'Logged in to Zerodha, but the sync failed. Try Sync again.');
    params.delete('kite');
    setParams(params, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const n = nw.data;
  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Accounts</h1>
        <Link to="/debts" className="btn small">Owe &amp; owed</Link>
        <button className="btn small" onClick={() => setAdding('bank')}>+ Add</button>
      </div>
      {!n ? <div className="card"><div className="skeleton" /></div> : (
        <>
          <div className="hero">
            <div className="hero-label">Net worth</div>
            <div className={`hero-num num ${n.netWorth < 0 ? 'neg' : ''}`}><RollingMoney value={n.netWorth} /></div>
            <div className="meta"><span>You own <b className="num">{money(n.assets, { whole: true })}</b></span><span>You owe <b className="num">{money(n.liabilities, { whole: true })}</b></span></div>
            <div className="track" aria-hidden><span style={{ width: `${n.assets > 0 ? Math.max(0, Math.min(100, Math.round((1 - n.liabilities / n.assets) * 100))) : 0}%` }} /></div>
          </div>
          {GROUPS.map(([title, sub, test]) => {
            const items = n.accounts.filter(test);
            if (!items.length && title !== 'People who owe you') return null;
            const total = items.reduce((s: number, a: any) => s + a.balance, 0);
            return (
              <div className="section" key={title}>
                <div className="section-title"><span>{title}{title === 'Fixed deposits' && <Link to="/fds" style={{ color: 'var(--accent)', marginLeft: 8, textTransform: 'none', letterSpacing: 0 }}>by bank →</Link>}</span><span className="num" style={{ textTransform: 'none', letterSpacing: 0 }}>{compact(total)}</span></div>
                <div className="list">
                  {items.map((a: any) => (
                    <button key={a.id} className="item" onClick={() => setEditing(a)}>
                      <div className="avatar" style={tint(a.kind)} aria-hidden>{a.icon ?? KIND_ICON[a.kind]}</div>
                      <div className="grow">
                        <div className="title">{a.name}</div>
                        <div className="sub">{a.valuedAt ? `Market value as of ${dayLabel(a.valuedAt.slice(0, 10))}` : a.meta?.salary ? 'Salary account' : KIND_LABEL[a.kind]}</div>
                      </div>
                      <div className="amt num" style={{ fontWeight: 550, color: a.balance < 0 ? 'var(--up)' : undefined }}>{money(a.balance, { whole: true })}</div>
                    </button>
                  ))}
                  {title === 'People who owe you' && (
                    <button className="item" onClick={() => setAdding('receivable')}>
                      <div className="avatar" aria-hidden>+</div>
                      <div className="grow"><div className="title">Add a person</div><div className="sub">Track who owes you from split bills and loans</div></div>
                    </button>
                  )}
                </div>
                {sub && <p className="tiny faint" style={{ margin: '6px 2px 0' }}>{sub}</p>}
              </div>
            );
          })}
          <Investments k={kite.data} />
        </>
      )}
      {editing && <AccountSheet account={editing} onClose={() => setEditing(null)} />}
      {adding && <AccountSheet kind={adding} onClose={() => setAdding(null)} />}
    </>
  );
}

function Investments({ k }: { k: any }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [busy, setBusy] = useState(false);
  if (!k) return null;
  const holdings: any[] = k.holdings ?? [];
  const value = holdings.reduce((s, h) => s + h.value_paise, 0);
  const cost = holdings.reduce((s, h) => s + h.cost_paise, 0);
  const takenAt = holdings[0]?.taken_at;

  async function sync() {
    setBusy(true);
    try {
      if (!k.tokenFresh) {
        const { url } = await api<{ url: string }>('/api/kite/login-url');
        window.location.href = url; // Kite sends you back to /api/kite/callback, which syncs
        return;
      }
      const r = await api<any>('/api/kite/sync', { method: 'POST' });
      await qc.invalidateQueries();
      toast(`Synced ${r.equityCount} stocks and ${r.mfCount} funds${r.mfError ? ' (funds unavailable: use CAS import later)' : ''}`);
    } catch (e: any) {
      toast(e.message);
    } finally { setBusy(false); }
  }

  return (
    <div className="section">
      <div className="section-title"><span>Holdings</span>{holdings.length > 0 && <span className="num" style={{ textTransform: 'none', letterSpacing: 0 }}>{compact(value)}</span>}</div>
      <div className="card">
        {!k.linked ? (
          <div className="small">
            <div style={{ fontWeight: 550, marginBottom: 4 }}>Connect Zerodha</div>
            <div className="muted">Pull your stocks and mutual funds from Kite (read-only). Set it up once in <Link to="/settings" style={{ color: 'var(--accent)' }}>Settings</Link>.</div>
          </div>
        ) : (
          <div className="spread">
            <div className="small">
              <div style={{ fontWeight: 550 }}>Zerodha {k.kiteUserId ? `· ${k.kiteUserId}` : ''}</div>
              <div className="muted">{takenAt ? `Last synced ${new Date(takenAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}` : 'Not synced yet'}</div>
            </div>
            <button className="btn small accent" disabled={busy} onClick={sync}>{busy ? 'Syncing…' : k.tokenFresh ? 'Sync now' : 'Log in & sync'}</button>
          </div>
        )}
        {holdings.length > 0 && (
          <>
            <div className="divider" />
            <div className="spread small"><span className="muted">Invested</span><span className="num">{money(cost, { whole: true })}</span></div>
            <div className="spread small"><span className="muted">Current value</span><span className="num">{money(value, { whole: true })}</span></div>
            <div className="spread small"><span className="muted">Gain</span><span className={`num ${value - cost >= 0 ? 'pos' : ''}`} style={{ color: value - cost < 0 ? 'var(--up)' : undefined }}>{money(value - cost, { whole: true, sign: true })} ({cost ? ((value - cost) / cost * 100).toFixed(1) : '0'}%)</span></div>
          </>
        )}
      </div>
      {holdings.length > 0 && (
        <div className="list" style={{ marginTop: 10 }}>
          {holdings.map((h) => (
            <div className="item" key={`${h.instrument}-${h.isin}`} style={{ cursor: 'default' }}>
              <div className="avatar" aria-hidden>{h.asset_type === 'mf' ? '🧺' : '📈'}</div>
              <div className="grow">
                <div className="title">{h.instrument}</div>
                <div className="sub">{h.asset_type === 'mf' ? 'Mutual fund' : 'Stock/ETF'} · {Number(h.quantity).toLocaleString('en-IN', { maximumFractionDigits: 3 })} @ ₹{Number(h.last_price).toLocaleString('en-IN')}</div>
              </div>
              <div className="amt">
                <div className="num">{money(h.value_paise, { whole: true })}</div>
                <div className={`tiny num ${h.value_paise >= h.cost_paise ? 'pos' : ''}`} style={{ color: h.value_paise < h.cost_paise ? 'var(--up)' : undefined }}>{money(h.value_paise - h.cost_paise, { whole: true, sign: true })}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {holdings.length > 0 && <p className="tiny faint" style={{ margin: '6px 2px 0' }}>Prices are from the last sync, not live. Zerodha requires a login once a day before syncing.</p>}
    </div>
  );
}

function AccountSheet({ account, kind, onClose }: { account?: any; kind?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const isNew = !account;
  const [name, setName] = useState(account?.name ?? '');
  const [k, setK] = useState(account?.kind ?? kind ?? 'bank');
  const [institution, setInstitution] = useState(account?.institution ?? '');
  const [opening, setOpening] = useState('');
  const [openingDate, setOpeningDate] = useState(todayIST());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const synced = !!account?.valuedAt;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const ob = opening.trim() === '' ? undefined : parseRupees(opening);
    if (opening.trim() !== '' && ob === null) return setErr('Enter the balance as a number, like 45210.50');
    setBusy(true);
    try {
      if (isNew) {
        await api('/api/accounts', { method: 'POST', body: { name: name.trim(), kind: k, institution: institution.trim() || null, icon: KIND_ICON[k], openingBalance: ob ?? 0, openingDate } });
      } else {
        await api(`/api/accounts/${account.id}`, { method: 'PATCH', body: { name: name.trim(), institution: institution.trim() || null, ...(ob !== undefined ? { openingBalance: ob, openingDate } : {}) } });
      }
      await qc.invalidateQueries();
      toast(isNew ? `Added ${name}` : 'Saved');
      onClose();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  async function archive() {
    setBusy(true);
    try {
      await api(`/api/accounts/${account.id}`, { method: 'PATCH', body: { isArchived: true } });
      await qc.invalidateQueries();
      toast(`${account.name} hidden. Its history stays.`);
      onClose();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  const liability = ['credit_card', 'loan', 'payable'].includes(k);
  return (
    <Sheet title={isNew ? (k === 'receivable' ? 'Add a person' : 'Add account') : account.name} onClose={onClose}>
      <form onSubmit={save}>
        {!isNew && (
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="hero-label">{synced ? 'Market value' : liability ? 'You owe' : k === 'receivable' ? 'They owe you' : 'Balance'}</div>
            <div className="stat-num num">{money(account.balance)}</div>
            <Link to={`/activity?accountId=${account.id}`} className="small" style={{ color: 'var(--accent)' }} onClick={onClose}>See transactions →</Link>
          </div>
        )}
        {isNew && (
          <div className="field"><label>Type</label>
            <select className="input" value={k} onChange={(e) => setK(e.target.value)}>
              {Object.entries(KIND_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        )}
        <div className="field"><label>{k === 'receivable' ? 'Name' : 'Account name'}</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} placeholder={k === 'receivable' ? 'Rohan' : 'SBI'} /></div>
        {k !== 'receivable' && k !== 'cash' && (
          <div className="field"><label>Bank or provider (optional)</label>
            <input className="input" value={institution} onChange={(e) => setInstitution(e.target.value)} maxLength={60} /></div>
        )}
        {!synced && (
          <>
            <div className="field">
              <label>{isNew ? (liability ? 'Amount you owe today' : k === 'receivable' ? 'Amount they owe you today' : 'Balance today') : 'Opening balance'}</label>
              <input className="input num" inputMode="decimal" placeholder={isNew ? '0' : 'Leave blank to keep it'} value={opening} onChange={(e) => setOpening(e.target.value)} />
              {!isNew && <span className="tiny faint">The balance before your first transaction here. Changing it replaces the old opening balance; it never counts as income.</span>}
            </div>
            <div className="field"><label>As of</label>
              <input className="input" type="date" value={openingDate} max={todayIST()} onChange={(e) => setOpeningDate(e.target.value)} /></div>
          </>
        )}
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn primary block" disabled={busy}>{busy ? 'Saving…' : isNew ? 'Add' : 'Save'}</button>
        {!isNew && <button type="button" className="btn block danger" style={{ marginTop: 8 }} disabled={busy} onClick={archive}>Hide this account</button>}
      </form>
    </Sheet>
  );
}
