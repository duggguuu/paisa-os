import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, money, parseRupees, todayIST, addDays, uuid, shortDate } from '../lib';
import { Sheet, useUi } from '../App';

export interface QuickAddPreset {
  kind?: 'expense' | 'income' | 'transfer';
  edit?: any; // full txn from /api/txns/:id
}

type Kind = 'expense' | 'income' | 'transfer';

function lastAccount(): string | null {
  try { return localStorage.getItem('paisa.lastAccount'); } catch { return null; }
}

export function QuickAdd({ preset, onClose }: { preset: QuickAddPreset; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
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
  const [showAllCats, setShowAllCats] = useState(false);
  const [touched, setTouched] = useState({ category: !!initial, account: !!initial });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);

  useEffect(() => { amountRef.current?.focus(); }, []);

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
  const label = (c: any) => (c.parent_id ? `${byId.get(c.parent_id)?.icon ?? ''} ${c.name}` : `${c.icon ?? ''} ${c.name}`).trim();
  const quick = [...cats]
    .filter((c) => c.parent_id || !cats.some((x) => x.parent_id === c.id))
    .sort((a, b) => b.recent_uses - a.recent_uses || a.sort - b.sort)
    .slice(0, 8);
  if (categoryId && !quick.some((c) => c.id === categoryId) && byId.get(categoryId)) quick.unshift(byId.get(categoryId));

  const paise = parseRupees(amount);
  const canSplit = kind === 'expense' && !edit && people.length > 0;

  async function save() {
    setError(null);
    if (!paise || paise <= 0) return setError('Enter an amount');
    if (kind !== 'transfer' && !categoryId) return setError('Pick a category');
    if (!accountId) return setError('Pick an account');
    if (kind === 'transfer' && (!toAccountId || toAccountId === accountId)) return setError('Pick a different account to move money into');
    let body: any;
    const common = { date, merchant: merchant.trim() || null, note: note.trim() || null, idempotencyKey: edit ? undefined : idemKey, source: 'manual' };
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
            <div className="chips">
              {(showAllCats ? cats.filter((c) => c.parent_id || !cats.some((x) => x.parent_id === c.id)) : quick).map((c) => (
                <button type="button" key={c.id} className={`chip ${categoryId === c.id ? 'on' : ''}`}
                  onClick={() => { setCategoryId(c.id); setTouched((t) => ({ ...t, category: true })); }}>{label(c)}</button>
              ))}
              <button type="button" className="chip" onClick={() => setShowAllCats((s) => !s)}>{showAllCats ? 'Fewer' : 'All categories…'}</button>
            </div>
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
