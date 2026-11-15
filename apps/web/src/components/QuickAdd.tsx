import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, money, parseRupees, todayIST, addDays, uuid, shortDate, maskText } from '../lib';
import { Sheet, useUi } from '../App';
import { Icon } from './Icons';
import { CategoryPicker } from './CategoryPicker';
import { useNavigate } from 'react-router-dom';
import { parseSpoken, speechSupported, listen, type Draft } from '../voice';

export interface QuickAddPreset {
  kind?: 'expense' | 'income' | 'transfer';
  edit?: any; // full txn from /api/txns/:id
  voice?: boolean; // start listening as soon as the sheet opens
}

type Kind = 'expense' | 'income' | 'transfer';

function lastAccount(): string | null {
  try { return localStorage.getItem('paisa.lastAccount'); } catch { return null; }
}

export function QuickAdd({ preset, onClose }: { preset: QuickAddPreset; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const navigate = useNavigate();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<any[]>('/api/accounts') });
  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api<any[]>('/api/categories') });
  const idemKey = useMemo(() => uuid(), []);
  const edit = preset.edit;

  const initial = useMemo(() => {
    if (!edit) return null;
    const ps = edit.postings as any[];
    const cat = ps.find((p) => p.kind === 'category');
    const money = ps.filter((p) => p.kind !== 'category');
    return {
      kind: edit.kind as Kind,
      amount: String(Math.abs(cat?.amount ?? money.find((p) => p.amount > 0)?.amount ?? 0) / 100),
      categoryId: cat?.account_id ?? null,
      accountId: edit.kind === 'transfer' ? money.find((p) => p.amount < 0)?.account_id : money[0]?.account_id,
      toAccountId: edit.kind === 'transfer' ? money.find((p) => p.amount > 0)?.account_id : null,
    };
  }, [edit]);

  const [kind, setKind] = useState<Kind>(initial?.kind ?? preset.kind ?? 'expense');
  const [amount, setAmount] = useState(initial?.amount ?? '');
  const [merchant, setMerchant] = useState(edit?.merchant ?? '');
  const [categoryId, setCategoryId] = useState<string | null>(initial?.categoryId ?? null);
  const [accountId, setAccountId] = useState<string | null>(initial?.accountId ?? null);
  const [toAccountId, setToAccountId] = useState<string | null>(initial?.toAccountId ?? null);
  const [date, setDate] = useState<string>(edit?.date ?? todayIST());
  const [note, setNote] = useState(edit?.note ?? '');
  const [splitWith, setSplitWith] = useState<string[]>([]);
  const [touched, setTouched] = useState({ category: !!initial, account: !!initial });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);
  const [phrase, setPhrase] = useState('');
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState<string | null>(null);
  const [voiceErr, setVoiceErr] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const canSpeak = useMemo(() => speechSupported(), []);
  const [source, setSource] = useState<'manual' | 'voice' | 'receipt'>('manual');
  const [scan, setScan] = useState<{ p: number; label: string } | null>(null);
  const photoRef = useRef<HTMLInputElement>(null);

  async function onPhoto(file: File) {
    setVoiceErr(null); setHeard(null);
    setScan({ p: 0, label: 'Starting…' });
    try {
      const { scanReceipt } = await import('../receipt');
      const g = await scanReceipt(file, (p, label) => setScan({ p, label }));
      if (!g.amount && !g.merchant) { setVoiceErr("Couldn't read that receipt. Try a flatter, well-lit photo, or type it."); return; }
      setKind('expense');
      if (g.amount) setAmount(g.amount);
      if (g.merchant) { setMerchant(g.merchant); setTouched((t) => ({ ...t, category: false })); }
      if (g.date) setDate(g.date);
      if (g.merchant && categories.data) {
        const { guessCategory } = await import('../voice');
        const c = guessCategory(`${g.merchant} ${g.text.slice(0, 400)}`, categories.data, 'expense');
        if (c) { setCategoryId(c); }
      }
      setSource('receipt');
      setHeard(`receipt: ${[g.merchant, g.amount && maskText(`₹${g.amount}`), g.date].filter(Boolean).join(' · ')}`);
    } catch (e: any) {
      setVoiceErr(`Couldn't scan: ${e.message}`);
    } finally { setScan(null); }
  }

  useEffect(() => { if (!preset.voice) amountRef.current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => stopRef.current?.(), []);

  /** Fill the form from a spoken or typed sentence. Nothing is saved until you tap Save. */
  function applyPhrase(text: string) {
    if (!text.trim() || !accounts.data || !categories.data) return;
    const d: Draft = parseSpoken(text, { accounts: accounts.data, categories: categories.data });
    if (d.kind) setKind(d.kind);
    if (d.amount) setAmount(d.amount);
    setMerchant(d.merchant ?? '');
    setCategoryId(d.categoryId ?? null);
    if (d.accountId) setAccountId(d.accountId);
    setToAccountId(d.toAccountId ?? null);
    setDate(d.date ?? todayIST());
    setSplitWith(d.splitWith ?? []);
    setTouched({ category: !!d.categoryId, account: !!d.accountId });
    setHeard(text.trim());
    setSource('voice');
    setError(null);
  }

  async function toggleMic() {
    if (listening) { stopRef.current?.(); return; }
    setVoiceErr(null); setHeard(null);
    try {
      const l = listen((t) => setPhrase(t));
      stopRef.current = l.stop;
      setListening(true);
      const text = await l.done;
      if (text.trim()) applyPhrase(text); else setVoiceErr("Didn't catch that. Try again, or type it.");
    } catch (e: any) {
      setVoiceErr(e.message);
    } finally {
      setListening(false);
      stopRef.current = null;
    }
  }

  // Opened from a "speak" shortcut: start listening once the account and category lists are loaded.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (preset.voice && canSpeak && !autoStarted.current && accounts.data && categories.data) { autoStarted.current = true; toggleMic(); }
  }, [accounts.data, categories.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // You pay for things from banks, cash, wallets and cards — not from investments or FDs.
  const moneyAccounts = (accounts.data ?? []).filter((a) => ['bank', 'cash', 'wallet', 'credit_card'].includes(a.kind) && !a.is_archived);
  const people = (accounts.data ?? []).filter((a) => a.kind === 'receivable' && !a.is_archived);
  const transferTargets = (accounts.data ?? []).filter((a) => (a.class === 'asset' || a.class === 'liability') && !a.is_archived);

  // Default account: the last one you used, else your salary account, else the first bank.
  useEffect(() => {
    if (accountId || !moneyAccounts.length) return;
    const last = lastAccount();
    const pick = moneyAccounts.find((a) => a.id === last) ?? moneyAccounts.find((a) => a.meta?.salary) ?? moneyAccounts[0];
    setAccountId(pick.id);
  }, [moneyAccounts.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Learn from history: same merchant → same category and account.
  useEffect(() => {
    if (kind === 'transfer' || merchant.trim().length < 2 || edit) return;
    const t = setTimeout(async () => {
      try {
        const s = await api<{ categoryId: string | null; accountId: string | null }>(`/api/suggest?merchant=${encodeURIComponent(merchant.trim())}`);
        if (s.categoryId && !touched.category) setCategoryId(s.categoryId);
        if (s.accountId && !touched.account) setAccountId(s.accountId);
      } catch { /* suggestion is optional */ }
    }, 350);
    return () => clearTimeout(t);
  }, [merchant, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const cats = (categories.data ?? []).filter((c) => c.class === (kind === 'income' ? 'income' : 'expense'));
  const byId = new Map(cats.map((c) => [c.id, c]));
  const label = (c: any) => (c.parent_id ? `${byId.get(c.parent_id)?.name ?? ''} › ${c.name}` : `${c.icon ?? ''} ${c.name ?? ''}`).trim();
  const paise = parseRupees(amount);
  const canSplit = kind === 'expense' && !edit && people.length > 0;

  async function save() {
    setError(null);
    if (!paise || paise <= 0) return setError('Enter an amount');
    if (kind !== 'transfer' && !categoryId) return setError('Pick a category');
    if (!accountId) return setError('Pick an account');
    if (kind === 'transfer' && (!toAccountId || toAccountId === accountId)) return setError('Pick a different account to move money into');
    let body: any;
    const common = { date, merchant: merchant.trim() || null, note: note.trim() || null, idempotencyKey: edit ? undefined : idemKey, source: edit ? undefined : source };
    if (kind === 'transfer') body = { kind, amount: paise, fromAccountId: accountId, toAccountId, ...common };
    else if (splitWith.length) {
      const n = splitWith.length + 1;
      const each = Math.floor(paise / n);
      const mine = paise - each * splitWith.length;
      body = {
        kind: 'split', accountId, ...common,
        lines: [{ amount: mine, categoryId }, ...splitWith.map((pid) => ({ amount: each, receivableId: pid }))],
      };
    } else body = { kind, amount: paise, accountId, categoryId, ...common };

    setSaving(true);
    try {
      const res = await api<{ id: string }>(edit ? `/api/txns/${edit.id}` : '/api/txns', { method: edit ? 'PUT' : 'POST', body });
      try { localStorage.setItem('paisa.lastAccount', accountId); } catch { /* ignore */ }
      await qc.invalidateQueries();
      onClose();
      const what = kind === 'transfer' ? 'transfer' : label(byId.get(categoryId!) ?? {});
      toast(`${edit ? 'Updated' : 'Saved'} ${money(paise)} · ${what}`, edit ? undefined : {
        label: 'Undo',
        run: async () => { await api(`/api/txns/${res.id}`, { method: 'DELETE' }); await qc.invalidateQueries(); toast('Removed'); },
      });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet title={edit ? 'Edit transaction' : 'Add transaction'} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); save(); }}>
        {!edit && (
          <div className="voice">
            <div className={`voice-bar ${listening ? 'live' : ''}`}>
              <input className="input" value={phrase} enterKeyHint="done" aria-label="Describe the transaction"
                placeholder={listening ? 'Listening…' : canSpeak ? 'Say or type it' : 'Type or dictate it'}
                onChange={(e) => setPhrase(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyPhrase(phrase); (e.target as HTMLInputElement).blur(); } }}
                onBlur={() => { if (phrase.trim() && phrase.trim() !== heard) applyPhrase(phrase); }} />
              <div className="voice-btns">
                <button type="button" className="cam" onClick={() => photoRef.current?.click()} aria-label="Scan a receipt" disabled={!!scan}>
                  <Icon name="camera" />
                </button>
                {canSpeak && (
                  <button type="button" className={`mic ${listening ? 'on' : ''}`} onClick={toggleMic} aria-label={listening ? 'Stop listening' : 'Speak'}>
                    <Icon name={listening ? 'stop' : 'mic'} />
                  </button>
                )}
              </div>
              <input ref={photoRef} type="file" accept="image/*,.pdf,.xlsx,.xls,.csv,.txt,application/pdf,text/plain,text/csv" hidden
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onPhoto(f); e.target.value = ''; }} />
            </div>
            {scan && (
              <div className="scan-progress"><span style={{ width: `${Math.round(scan.p * 100)}%` }} /><em>{scan.label}</em></div>
            )}
            {voiceErr ? <div className="tiny error" style={{ margin: '6px 2px 0' }}>{voiceErr}</div>
              : heard ? <div className="tiny muted" style={{ margin: '6px 2px 0' }}>Filled from {heard.startsWith('receipt:') ? heard : `"${heard}"`}. Check it, then Save.</div>
              : <div className="tiny faint" style={{ margin: '6px 2px 0' }}>Say it ("1,200 at DMart from my bank yesterday") or 📷 scan a receipt.</div>}
          </div>
        )}
        {!edit && (
          <button type="button" className="stuff-link" onClick={() => { onClose(); navigate('/stuff?buy=1'); }}>
            🛍️ Bought things (clothes, gadgets…)? Add the order screenshots: it logs the expense and adds them to your Stuff ›
          </button>
        )}
        {!edit || edit.kind !== 'split' ? (
          <div className="seg full" role="tablist" style={{ marginBottom: 12 }}>
            {(['expense', 'income', 'transfer'] as Kind[]).map((k) => (
              <button type="button" key={k} className={kind === k ? 'on' : ''} onClick={() => { setKind(k); setCategoryId(null); setTouched((t) => ({ ...t, category: false })); }}>
                {k === 'expense' ? 'Expense' : k === 'income' ? 'Income' : 'Transfer'}
              </button>
            ))}
          </div>
        ) : null}

        <div className="amount-wrap">
          <span className="cur">₹</span>
          <input ref={amountRef} className="amount-input" inputMode="decimal" placeholder="0" value={amount} aria-label="Amount"
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))} />
        </div>

        {kind !== 'transfer' && (
          <div className="field">
            <input className="input" placeholder={kind === 'income' ? 'From (employer, person…)' : 'Where? (Swiggy, Uber, landlord…)'} value={merchant}
              onChange={(e) => setMerchant(e.target.value)} aria-label="Merchant" />
          </div>
        )}

        {kind !== 'transfer' && (
          <div className="field">
            <label>Category</label>
            <CategoryPicker cats={categories.data ?? []} cls={kind === 'income' ? 'income' : 'expense'} value={categoryId}
              onChange={(id) => { setCategoryId(id); setTouched((t) => ({ ...t, category: true })); }} />
          </div>
        )}

        <div className="field">
          <label>{kind === 'transfer' ? 'From' : kind === 'income' ? 'Into' : 'Paid from'}</label>
          <div className="chips">
            {(kind === 'transfer' ? transferTargets : moneyAccounts).map((a) => (
              <button type="button" key={a.id} className={`chip ${accountId === a.id ? 'on' : ''}`}
                onClick={() => { setAccountId(a.id); setTouched((t) => ({ ...t, account: true })); }}>{a.icon ?? ''} {a.name}</button>
            ))}
          </div>
        </div>

        {kind === 'transfer' && (
          <div className="field">
            <label>To</label>
            <div className="chips">
              {transferTargets.filter((a) => a.id !== accountId).map((a) => (
                <button type="button" key={a.id} className={`chip ${toAccountId === a.id ? 'on' : ''}`} onClick={() => setToAccountId(a.id)}>{a.icon ?? ''} {a.name}</button>
              ))}
            </div>
            <span className="tiny faint">Paying a credit card bill, a SIP, or lending to a friend are transfers: they don't count as spending.</span>
          </div>
        )}

        {canSplit && (
          <div className="field">
            <label>Split equally with</label>
            <div className="chips">
              {people.map((p) => (
                <button type="button" key={p.id} className={`chip ${splitWith.includes(p.id) ? 'on' : ''}`}
                  onClick={() => setSplitWith((s) => (s.includes(p.id) ? s.filter((x) => x !== p.id) : [...s, p.id]))}>{p.icon ?? '🧑'} {p.name}</button>
              ))}
            </div>
            {splitWith.length > 0 && paise ? (
              <span className="tiny muted">Your share {money(paise - Math.floor(paise / (splitWith.length + 1)) * splitWith.length)} counts as spending; {splitWith.length === 1 ? 'they owe' : 'each owes'} {money(Math.floor(paise / (splitWith.length + 1)))}.</span>
            ) : null}
          </div>
        )}

        <div className="field">
          <label>Date</label>
          <div className="chips">
            {[todayIST(), addDays(todayIST(), -1)].map((d, i) => (
              <button type="button" key={d} className={`chip ${date === d ? 'on' : ''}`} onClick={() => setDate(d)}>{i === 0 ? 'Today' : 'Yesterday'}</button>
            ))}
            <input type="date" className="chip" value={date} max={addDays(todayIST(), 365)} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Pick a date" />
          </div>
          {date !== todayIST() && date !== addDays(todayIST(), -1) && <span className="tiny muted">{shortDate(date)}</span>}
        </div>

        <div className="field">
          <input className="input" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
        </div>

        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary block" disabled={saving} type="submit">
          {saving ? 'Saving…' : edit ? 'Save changes' : paise ? `Save ${money(paise)}` : 'Save'}
        </button>
      </form>
    </Sheet>
  );
}
