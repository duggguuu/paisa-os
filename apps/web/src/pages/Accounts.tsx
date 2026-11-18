import { tint } from '../components/Icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { SignToggle } from '../components/SignToggle';
import { api, money, compact, parseSignedRupees, cleanSignedAmount, KIND_LABEL, KIND_ICON, todayIST, dayLabel, maskNum, maskText } from '../lib';
import { Sheet, useUi } from '../App';
import { RollingMoney } from '../components/Rolling';
import { DeleteAccountSheet } from '../components/DeleteAccount';

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
  const fdq = useQuery({ queryKey: ['fds'], queryFn: () => api<any>('/api/fds') });
  const allFds: any[] = fdq.data?.banks.flatMap((b: any) => b.items) ?? [];
  /** FDs held with one of your bank accounts: linked to it, or with the same bank name. */
  const fdsOf = (a: any) => a.kind !== 'bank' ? [] : allFds.filter((f) => f.bankAccountId === a.id
    || (!f.bankAccountId && [a.name, a.institution].filter(Boolean).some((n: string) => n.toLowerCase() === String(f.bank).toLowerCase())));
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
                  {items.map((a: any) => {
                    const mine = fdsOf(a);
                    const fdSum = mine.reduce((s: number, f: any) => s + f.principal, 0);
                    return (
                    <button key={a.id} className="item" onClick={() => setEditing({ ...a, fds: mine })}>
                      <div className="avatar" style={tint(a.kind)} aria-hidden>{a.icon ?? KIND_ICON[a.kind]}</div>
                      <div className="grow">
                        <div className="title">{a.name}</div>
                        <div className="sub">{a.valuedAt ? `Market value as of ${dayLabel(a.valuedAt.slice(0, 10))}` : mine.length ? 'Savings' : a.meta?.salary ? 'Salary account' : KIND_LABEL[a.kind]}</div>
                        {mine.length > 0 && <div className="sub">+ {money(fdSum, { whole: true })} in {mine.length} FD{mine.length === 1 ? '' : 's'} · total <b>{money(a.balance + fdSum, { whole: true })}</b></div>}
                      </div>
                      <div className="amt num" style={{ fontWeight: 550, color: a.balance < 0 ? 'var(--up)' : undefined }}>{money(a.balance, { whole: true })}</div>
                    </button>
                    );
                  })}
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

type HSort = 'value' | 'value-asc' | 'gain' | 'gain-pct' | 'loss-pct' | 'invested' | 'name';
const H_SORTS: [HSort, string][] = [['value', 'Value: high to low'], ['value-asc', 'Value: low to high'], ['gain', 'Gain (₹): high to low'], ['gain-pct', 'Gain %: best first'], ['loss-pct', 'Gain %: worst first'], ['invested', 'Invested: high to low'], ['name', 'Name: A to Z']];
const H_PREF = 'paisa.holdingsView';
const gainPct = (h: any) => (h.cost_paise ? (h.value_paise - h.cost_paise) / h.cost_paise : 0);

function Investments({ k }: { k: any }) {
  const qc = useQueryClient();
  const { toast, openAdd } = useUi();
  const [howTo, setHowTo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<{ type: 'all' | 'equity' | 'mf'; perf: 'all' | 'up' | 'down'; sort: HSort }>(() => {
    try { return { type: 'all', perf: 'all', sort: 'value', ...JSON.parse(localStorage.getItem(H_PREF) ?? '{}') }; } catch { return { type: 'all', perf: 'all', sort: 'value' }; }
  });
  const [hq, setHq] = useState('');
  const setV = (p: Partial<typeof view>) => setView((v) => { const n = { ...v, ...p }; try { localStorage.setItem(H_PREF, JSON.stringify(n)); } catch { /* ignore */ } return n; });
  if (!k) return null;
  const holdings: any[] = k.holdings ?? [];
  const value = holdings.reduce((s, h) => s + h.value_paise, 0);
  const cost = holdings.reduce((s, h) => s + h.cost_paise, 0);
  const takenAt = holdings[0]?.taken_at;
  const needle = hq.trim().toLowerCase();
  const shown = holdings
    .filter((h) => view.type === 'all' || (view.type === 'mf' ? h.asset_type === 'mf' : h.asset_type !== 'mf'))
    .filter((h) => view.perf === 'all' || (view.perf === 'up' ? h.value_paise >= h.cost_paise : h.value_paise < h.cost_paise))
    .filter((h) => !needle || String(h.instrument).toLowerCase().includes(needle) || String(h.isin ?? '').toLowerCase().includes(needle))
    .sort((a, b) => {
      switch (view.sort) {
        case 'value-asc': return a.value_paise - b.value_paise;
        case 'gain': return (b.value_paise - b.cost_paise) - (a.value_paise - a.cost_paise);
        case 'gain-pct': return gainPct(b) - gainPct(a);
        case 'loss-pct': return gainPct(a) - gainPct(b);
        case 'invested': return b.cost_paise - a.cost_paise;
        case 'name': return String(a.instrument).localeCompare(String(b.instrument));
        default: return b.value_paise - a.value_paise;
      }
    });
  const filtered = shown.length !== holdings.length;
  const shownValue = shown.reduce((s, h) => s + h.value_paise, 0), shownCost = shown.reduce((s, h) => s + h.cost_paise, 0);
  const nMf = holdings.filter((h) => h.asset_type === 'mf').length;

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
        {(holdings.length > 0 || k.hasFundsRow) && (
          <>
            <div className="divider" />
            <div className="spread small"><span className="muted">Invested in holdings</span><span className="num">{money(cost, { whole: true })}</span></div>
            <div className="spread small"><span className="muted">Holdings value</span><span className="num">{money(value, { whole: true })}</span></div>
            <div className="spread small"><span className="muted">Unused funds in Kite</span><span className="num">{k.hasFundsRow ? money(k.unusedFunds, { whole: true }) : <span className="faint">sync to see</span>}</span></div>
            <div className="spread small" style={{ fontWeight: 600 }}><span>Total in Zerodha</span><span className="num">{money(value + (k.unusedFunds ?? 0), { whole: true })}</span></div>
            <div className="spread small"><span className="muted">Gain on holdings</span><span className={`num ${value - cost >= 0 ? 'pos' : ''}`} style={{ color: value - cost < 0 ? 'var(--up)' : undefined }}>{money(value - cost, { whole: true, sign: true })} ({cost ? ((value - cost) / cost * 100).toFixed(1) : '0'}%)</span></div>
            {k.zerodha && k.zerodha.moneyIn !== 0 && (
              <div className="spread small"><span className="muted">Money you've put in (net of withdrawals)</span><span className="num">{money(k.zerodha.moneyIn, { whole: true })}</span></div>
            )}
          </>
        )}
        {k.linked && k.zerodha && (
          <>
            <div className="divider" />
            <div className="row wrap" style={{ gap: 8 }}>
              <button className="btn small" onClick={() => openAdd({ transfer: { toAccountId: k.zerodha.id, merchant: 'Added funds to Kite' } })}>+ Add funds to Kite</button>
              <button className="btn small" onClick={() => openAdd({ transfer: { toAccountId: k.zerodha.id, merchant: 'Mutual fund purchase', note: 'Paid straight from the bank (Coin)' } })}>Bought a mutual fund</button>
              <button className="btn small" onClick={() => openAdd({ transfer: { fromAccountId: k.zerodha.id, merchant: 'Withdrew from Kite' } })}>Withdraw to bank</button>
              <button className="btn small" onClick={() => setHowTo((x) => !x)}>{howTo ? 'Hide' : 'How these work'}</button>
            </div>
            {howTo && (
              <div className="notif-setup small">
                <p><b>Adding money to Kite</b> is a <b>transfer</b> from your bank to Zerodha, not spending: your bank goes down, and the money now sits in Zerodha. It shows up as <b>Unused funds</b> after the next sync, until you buy something with it.</p>
                <p><b>Buying a mutual fund straight from your bank</b> (Zerodha Coin, or a SIP mandate) is also a <b>transfer</b> from the bank to Zerodha. The fund appears in your holdings after the next sync. For a fund bought outside Zerodha (an AMC site, another app), add an investment account for it under <b>+ Add</b> and transfer into that instead.</p>
                <p><b>Buying stocks with your Kite funds</b> needs nothing: the money is already in Zerodha; it just moves from unused funds into holdings. <b>Withdrawing</b> is a transfer from Zerodha back to your bank.</p>
                <p className="tiny faint">Zerodha's value comes from the sync (holdings + unused funds), so your net worth stays right. "Money you've put in" adds up these transfers, so you can compare it with the total.</p>
              </div>
            )}
          </>
        )}
      </div>
      {holdings.length > 1 && (
        <div className="holdings-tools">
          <input className="input" placeholder="Search holdings" value={hq} onChange={(e) => setHq(e.target.value)} aria-label="Search holdings" />
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {nMf > 0 && nMf < holdings.length && (
              <div className="seg">
                {([['all', 'All'], ['equity', 'Stocks'], ['mf', 'Funds']] as const).map(([v, l]) => <button key={v} className={view.type === v ? 'on' : ''} onClick={() => setV({ type: v })}>{l}</button>)}
              </div>
            )}
            <div className="seg">
              {([['all', 'All'], ['up', 'Gainers'], ['down', 'Losers']] as const).map(([v, l]) => <button key={v} className={view.perf === v ? 'on' : ''} onClick={() => setV({ perf: v })}>{l}</button>)}
            </div>
            <select className="input holdings-sort" value={view.sort} onChange={(e) => setV({ sort: e.target.value as HSort })} aria-label="Sort holdings">
              {H_SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          {filtered && (
            <div className="tiny faint">
              Showing {shown.length} of {holdings.length} · {money(shownValue, { whole: true })} ·{' '}
              <span style={{ color: shownValue < shownCost ? 'var(--up)' : 'var(--down)' }}>{money(shownValue - shownCost, { whole: true, sign: true })}</span>{' '}
              <button className="linkish" onClick={() => { setHq(''); setV({ type: 'all', perf: 'all' }); }}>Clear filters</button>
            </div>
          )}
        </div>
      )}
      {holdings.length > 0 && (
        <div className="list" style={{ marginTop: 10 }}>
          {shown.length === 0 && <div className="empty">No holdings match.</div>}
          {shown.map((h) => (
            <div className="item" key={`${h.instrument}-${h.isin}`} style={{ cursor: 'default' }}>
              <div className="avatar" aria-hidden>{h.asset_type === 'mf' ? '🧺' : '📈'}</div>
              <div className="grow">
                <div className="title">{h.instrument}</div>
                <div className="sub">{h.asset_type === 'mf' ? 'Mutual fund' : 'Stock/ETF'} · {maskNum(Number(h.quantity).toLocaleString('en-IN', { maximumFractionDigits: 3 }))} @ {maskText(`₹${Number(h.last_price).toLocaleString('en-IN')}`)}</div>
              </div>
              <div className="amt">
                <div className="num">{money(h.value_paise, { whole: true })}</div>
                <div className={`tiny num ${h.value_paise >= h.cost_paise ? 'pos' : ''}`} style={{ color: h.value_paise < h.cost_paise ? 'var(--up)' : undefined }}>{money(h.value_paise - h.cost_paise, { whole: true, sign: true })} · {maskNum(`${(gainPct(h) * 100).toFixed(1)}%`)}</div>
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
  const [deleting, setDeleting] = useState(false);
  const synced = !!account?.valuedAt;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const ob = opening.trim() === '' ? undefined : parseSignedRupees(opening);
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
  if (deleting && account) return <DeleteAccountSheet accountId={account.id} onClose={() => setDeleting(false)} onDeleted={onClose} onHide={archive} />;
  return (
    <Sheet title={isNew ? (k === 'receivable' ? 'Add a person' : 'Add account') : account.name} onClose={onClose}>
      <form onSubmit={save}>
        {!isNew && (
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="hero-label">{synced ? 'Market value' : liability ? 'You owe' : k === 'receivable' ? 'They owe you' : 'Balance'}</div>
            <div className="stat-num num">{money(account.balance)}</div>
            {account.fds?.length > 0 && (
              <div className="bank-split">
                <div><span>Savings</span><b className="num">{money(account.balance, { whole: true })}</b></div>
                {account.fds.map((f: any) => (
                  <Link key={f.id} to="/fds" onClick={onClose}><span>🔒 {f.name}{f.maturity ? ` · matures ${dayLabel(f.maturity)}` : ''}</span><b className="num">{money(f.principal, { whole: true })}</b></Link>
                ))}
                <div className="total"><span>Total with {account.name}</span><b className="num">{money(account.balance + account.fds.reduce((s: number, f: any) => s + f.principal, 0), { whole: true })}</b></div>
              </div>
            )}
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
              <div className="input-with-sign">
                <input className="input num" inputMode="decimal" placeholder={isNew ? '0' : 'Leave blank to keep it'} value={opening} onChange={(e) => setOpening(cleanSignedAmount(e.target.value))} />
                <SignToggle value={opening} onChange={setOpening} />
              </div>
              {/^\s*-/.test(opening) && <span className="tiny faint">{liability ? 'Negative: the card or loan owes you (for example, you overpaid).' : k === 'receivable' ? 'Negative: you owe them instead.' : 'Negative: the account is overdrawn.'}</span>}
              {!isNew && <span className="tiny faint">The balance before your first transaction here. Changing it replaces the old opening balance; it never counts as income.</span>}
            </div>
            <div className="field"><label>As of</label>
              <input className="input" type="date" value={openingDate} max={todayIST()} onChange={(e) => setOpeningDate(e.target.value)} /></div>
          </>
        )}
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn primary block" disabled={busy}>{busy ? 'Saving…' : isNew ? 'Add' : 'Save'}</button>
        {!isNew && (
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button type="button" className="btn grow" disabled={busy} onClick={archive}>Hide</button>
            <button type="button" className="btn grow danger" disabled={busy} onClick={() => setDeleting(true)}>Delete account</button>
          </div>
        )}
      </form>
    </Sheet>
  );
}
