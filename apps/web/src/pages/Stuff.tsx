import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, money, parseRupees, todayIST, uuid, shortDate } from '../lib';
import { Sheet, useUi } from '../App';
import { tint } from '../components/Icons';
import { parseOrderText, mergeOrders, parseStuffSentence, itemCategory, type OrderItem } from '../orders';
import { parseSpoken } from '../voice';

type List = 'own' | 'want' | 'asked' | 'sold' | 'dropped';
const TABS: [List, string][] = [['own', 'Own'], ['want', 'Want'], ['asked', 'Asked'], ['sold', 'Sold'], ['dropped', 'Dropped']];
const ICON: Record<string, string> = { 'Clothes — tops': '👕', 'Clothes — bottoms': '👖', 'Clothes — outerwear': '🧥', Clothes: '👕', Footwear: '👟', Tech: '💻', Audio: '🎧', Watch: '⌚', Coffee: '☕', 'Bike & riding': '🏍️', Collectibles: '🧱', Fragrance: '🧴', Books: '📚', Furniture: '🪑', 'Home decor': '🕰️' };

export function Stuff() {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [tab, setTab] = useState<List>('own');
  const items = useQuery({ queryKey: ['stuff'], queryFn: () => api<any[]>('/api/stuff') });
  const [buy, setBuy] = useState<{ prefill?: any } | null>(null);
  const [sell, setSell] = useState<any | null | 'pick'>(null);
  const [edit, setEdit] = useState<any | null>(null);
  const [q, setQ] = useState('');
  const [params, setParams] = useSearchParams();
  useEffect(() => { if (params.get('buy')) { setBuy({}); setParams({}, { replace: true }); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const all = items.data ?? [];
  const shown = all.filter((i) => i.list === tab && (!q || `${i.name} ${i.category ?? ''} ${i.notes ?? ''}`.toLowerCase().includes(q.toLowerCase())));
  const groups = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const i of shown) { const k = i.category ?? 'Other'; if (!m.has(k)) m.set(k, []); m.get(k)!.push(i); }
    return [...m.entries()];
  }, [shown]);
  const count = (l: List) => all.filter((i) => i.list === l).length;
  const wantTotal = all.filter((i) => i.list === 'want').reduce((s, i) => s + (i.price ?? 0), 0);

  async function importSheet() {
    const r = await api<any>('/api/stuff/import-sheet', { method: 'POST' });
    await qc.invalidateQueries({ queryKey: ['stuff'] });
    toast(r.added ? `Imported ${r.added} items from your sheet` : 'Already up to date');
  }

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Stuff</h1>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn small" onClick={() => setSell('pick')}>Sold it</button>
          <button className="btn small accent" onClick={() => setBuy({})}>I bought…</button>
        </div>
      </div>

      {items.data && all.length === 0 && (
        <div className="card empty-state">
          <div style={{ fontSize: 32 }}>🧺</div>
          <b>Bring in "Yash's Stuff"</b>
          <p className="small muted">Your Own, Want, Asked-about and Dropped lists from the sheet (as of 14 Nov). After that, purchases and sales update them here.</p>
          <button className="btn accent" onClick={importSheet}>Import my sheet</button>
        </div>
      )}

      {all.length > 0 && (
        <>
          <div className="tabs-line" role="tablist">
            {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l} <span className="faint">{count(k)}</span></button>)}
          </div>
          {tab === 'want' && wantTotal > 0 && <div className="totals" style={{ gridTemplateColumns: '1fr' }}><div><span>Still want — total</span><b className="num">{money(wantTotal, { whole: true })}</b></div></div>}
          <input className="input" type="search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} style={{ margin: '10px 0' }} />
          {groups.length === 0 && <div className="empty">Nothing here.</div>}
          {groups.map(([cat, list]) => (
            <div key={cat} className="section" style={{ marginTop: 10 }}>
              <div className="section-title">{ICON[cat] ?? '•'} {cat} <span className="faint tiny">{list.length}</span></div>
              <div className="list">
                {list.map((i) => (
                  <button key={i.id} className="item" onClick={() => setEdit(i)}>
                    <div className="grow">
                      <div className="title" style={{ whiteSpace: 'normal' }}>{i.name}</div>
                      <div className="sub" style={{ whiteSpace: 'normal' }}>
                        {[i.meta?.verdict, i.meta?.asked_when, i.store, i.notes, i.acquired_on && `bought ${shortDate(i.acquired_on)}`, i.sold_on && `sold ${shortDate(i.sold_on)} for ${money(i.sold_price, { whole: true })}`].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    {i.price != null && <div className="amt num">{money(i.price, { whole: true })}</div>}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <p className="tiny faint" style={{ textAlign: 'center', marginTop: 14 }}>
            <button className="btn small" onClick={importSheet}>Re-import sheet snapshot</button>
          </p>
        </>
      )}

      {buy && <PurchaseSheet onClose={() => setBuy(null)} prefill={buy.prefill} />}
      {sell && <SaleSheet item={sell === 'pick' ? null : sell} own={all.filter((i) => i.list === 'own')} onClose={() => setSell(null)} />}
      {edit && <ItemSheet item={edit} onClose={() => setEdit(null)}
        onBuy={() => { setEdit(null); setBuy({ prefill: { text: `${edit.name}${edit.price ? ` for ${edit.price / 100}` : ''}${edit.store ? ` from ${edit.store}` : ''}` } }); }}
        onSell={() => { setEdit(null); setSell(edit); }} />}
    </>
  );
}

function ItemSheet({ item, onClose, onBuy, onSell }: { item: any; onClose: () => void; onBuy: () => void; onSell: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(item.name);
  const [notes, setNotes] = useState(item.notes ?? '');
  const [list, setList] = useState<List>(item.list);
  async function save() {
    await api(`/api/stuff/${item.id}`, { method: 'PUT', body: { list, name, category: item.category, notes: notes || null, price: item.price, store: item.store, link: item.link, meta: item.meta, acquiredOn: item.acquired_on } });
    await qc.invalidateQueries({ queryKey: ['stuff'] }); onClose();
  }
  return (
    <Sheet title={item.name} onClose={onClose}>
      {item.link && <p className="small"><a href={item.link} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>Open product page ↗</a></p>}
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        {item.list !== 'own' && item.list !== 'sold' && <button className="btn accent" onClick={onBuy}>I bought this</button>}
        {item.list === 'own' && <button className="btn" onClick={onSell}>I sold this</button>}
      </div>
      <div className="field"><label>Name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div className="field"><label>Notes</label><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      <div className="field"><label>List</label>
        <div className="chips">{TABS.map(([k, l]) => <button key={k} className={`chip ${list === k ? 'on' : ''}`} onClick={() => setList(k)}>{l}</button>)}</div>
      </div>
      <button className="btn primary block" onClick={save}>Save</button>
      <button className="btn block danger" style={{ marginTop: 8 }} onClick={async () => { if (confirm(`Delete ${item.name}?`)) { await api(`/api/stuff/${item.id}`, { method: 'DELETE' }); await qc.invalidateQueries({ queryKey: ['stuff'] }); onClose(); } }}>Delete</button>
    </Sheet>
  );
}

interface Draft { name: string; category: string | null; paid: string; brand?: string | null; colour?: string | null; size?: string | null; artNo?: string | null; listPrice?: number | null }

/** Screenshots or a sentence → one expense + items in Own (moving matching Want items). */
export function PurchaseSheet({ onClose, prefill }: { onClose: () => void; prefill?: { text?: string } }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<any[]>('/api/accounts') });
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api<any[]>('/api/categories') });
  const payFrom = (accounts.data ?? []).filter((a) => ['bank', 'cash', 'wallet', 'credit_card'].includes(a.kind) && !a.is_archived);
  const expenseCats = (cats.data ?? []).filter((c) => c.class === 'expense' && !(cats.data ?? []).some((x) => x.parent_id === c.id));
  const [text, setText] = useState(prefill?.text ?? '');
  const [items, setItems] = useState<Draft[]>([]);
  const [store, setStore] = useState('');
  const [total, setTotal] = useState('');
  const [date, setDate] = useState(todayIST());
  const [acc, setAcc] = useState<string | null>(null);
  const [cat, setCat] = useState<string | null>(null);
  const [scan, setScan] = useState<{ p: number; label: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(uuid());
  const accountId = acc ?? payFrom.find((a) => a.meta?.salary)?.id ?? payFrom[0]?.id ?? null;
  const catByName = (n: string) => expenseCats.find((c) => c.name.toLowerCase() === n.toLowerCase())?.id ?? null;
  const defaultCat = (ds: Draft[]) => {
    const c = ds.map((d) => d.category ?? '').join(' ');
    return /Clothes/.test(c) ? catByName('Apparel') : /Footwear/.test(c) ? catByName('Apparel') : /Tech/.test(c) ? catByName('Electronics') : catByName('Shopping') ?? catByName('Household') ?? catByName('Other');
  };
  const categoryId = cat ?? defaultCat(items);

  async function fromScreens(files: File[]) {
    setErr(null); setScan({ p: 0, label: 'Starting…' });
    try {
      const { ocrImages } = await import('../receipt');
      const texts = await ocrImages(files, (p, label) => setScan({ p, label }));
      const o = mergeOrders(texts.map(parseOrderText));
      if (!o.items.length) { setErr("Couldn't find items in those screenshots. Type them instead, e.g. \"bought black jeans for 2,499 from H&M\"."); return; }
      setItems(o.items.map((i: OrderItem) => ({ name: i.name, category: i.category, paid: i.paid != null ? String(i.paid / 100) : '', brand: i.brand, colour: i.colour, size: i.size, artNo: i.artNo, listPrice: i.listPrice })));
      if (o.store) setStore(o.store);
      if (o.total) setTotal(String(o.total / 100));
      if (o.payment && /upi/i.test(o.payment)) { /* UPI comes from a bank: keep the default bank */ }
    } catch (e: any) { setErr(`Couldn't read the screenshots: ${e.message}`); }
    finally { setScan(null); }
  }

  function fromText() {
    const s = parseStuffSentence(text);
    if (!s.items.length) { setErr('Write it like: "bought an Anker charger for 2,499 from Amazon on HDFC card".'); return; }
    setErr(null);
    setItems(s.items.map((i) => ({ name: i.name, category: itemCategory(i.name), paid: i.amount != null ? String(i.amount / 100) : '' })));
    if (s.store) setStore(s.store);
    if (s.total) setTotal(String(s.total / 100));
    const v = parseSpoken(text, { accounts: accounts.data ?? [], categories: cats.data ?? [] });
    if (v.accountId) setAcc(v.accountId);
    if (v.date) setDate(v.date);
  }

  const sumPaid = items.reduce((s, i) => s + (parseRupees(i.paid) ?? 0), 0);
  async function save() {
    setErr(null);
    const t = parseRupees(total) ?? sumPaid;
    if (!t) return setErr('Enter what you paid');
    if (!accountId || !categoryId) return setErr('Pick the account and category');
    if (!items.length) return setErr('Add at least one item');
    setBusy(true);
    try {
      const r = await api<any>('/api/stuff/purchase', { method: 'POST', body: {
        date, accountId, categoryId, store: store || null, total: t, idempotencyKey: key,
        items: items.map((i) => ({ name: i.name.trim(), category: i.category, brand: i.brand, colour: i.colour, size: i.size, artNo: i.artNo, paid: parseRupees(i.paid), listPrice: i.listPrice })),
      } });
      await qc.invalidateQueries();
      const parts = [r.movedFromWant.length && `${r.movedFromWant.length} moved from Want`, r.addedToOwn.length && `${r.addedToOwn.length} new`, r.alreadyOwned.length && `${r.alreadyOwned.length} already owned`].filter(Boolean);
      toast(`Logged ${money(t)} · ${parts.join(', ')}`);
      onClose();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <Sheet title="I bought…" onClose={onClose}>
      {!items.length ? (
        <>
          <label className="dropzone">
            <input type="file" accept="image/*" multiple onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; if (fs.length) fromScreens(fs); }} />
            <b>Add order screenshots</b><span className="tiny faint">One or several (they can overlap). Read on this phone.</span>
          </label>
          {scan && <div className="scan-progress" style={{ marginTop: 10 }}><span style={{ width: `${Math.round(scan.p * 100)}%` }} /><em>{scan.label}</em></div>}
          <div className="tiny faint" style={{ textAlign: 'center', margin: '12px 0' }}>or type it</div>
          <textarea className="input" rows={3} placeholder='e.g. "bought an Anker charger for 2,499 and a cable for 499 from Amazon on HDFC card"' value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn block" style={{ marginTop: 8 }} disabled={!text.trim()} onClick={fromText}>Continue</button>
        </>
      ) : (
        <>
          <div className="list" style={{ marginBottom: 12 }}>
            {items.map((it, k) => (
              <div key={k} className="buy-row">
                <span className="avatar" style={tint(it.category ?? it.name)} aria-hidden>{ICON[it.category ?? ''] ?? '🛍️'}</span>
                <div className="grow">
                  <input className="input" value={it.name} onChange={(e) => setItems((xs) => xs.map((x, j) => (j === k ? { ...x, name: e.target.value } : x)))} aria-label="Item" />
                  <div className="tiny faint">{[it.colour, it.size && `size ${it.size}`, it.listPrice && `list ${money(it.listPrice, { whole: true })}`].filter(Boolean).join(' · ')}</div>
                </div>
                <input className="input num paid" inputMode="decimal" value={it.paid} onChange={(e) => setItems((xs) => xs.map((x, j) => (j === k ? { ...x, paid: e.target.value } : x)))} aria-label="Paid" />
                <button className="icon-plain" aria-label="Remove" onClick={() => setItems((xs) => xs.filter((_, j) => j !== k))}>✕</button>
              </div>
            ))}
          </div>
          <div className="grid2">
            <div className="field"><label>Store</label><input className="input" value={store} onChange={(e) => setStore(e.target.value)} /></div>
            <div className="field"><label>Total paid</label><input className="input num" inputMode="decimal" value={total} placeholder={sumPaid ? String(sumPaid / 100) : ''} onChange={(e) => setTotal(e.target.value)} /></div>
          </div>
          {parseRupees(total) && sumPaid && parseRupees(total) !== sumPaid ? <p className="tiny" style={{ color: 'var(--warn)' }}>Items add up to {money(sumPaid)}; the order says {money(parseRupees(total)!)}. The order total is what gets recorded.</p> : null}
          <div className="field"><label>Paid from</label>
            <div className="chips">{payFrom.map((a) => <button key={a.id} className={`chip ${accountId === a.id ? 'on' : ''}`} onClick={() => setAcc(a.id)}>{a.icon ?? ''} {a.name}</button>)}</div>
          </div>
          <div className="grid2">
            <div className="field"><label>Category</label>
              <select className="input" value={categoryId ?? ''} onChange={(e) => setCat(e.target.value)}>{expenseCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            </div>
            <div className="field"><label>Date</label><input type="date" className="input" value={date} max={todayIST()} onChange={(e) => setDate(e.target.value)} /></div>
          </div>
          <p className="tiny faint">Saves one expense for the order. Each item goes to Own; items on your Want list move across instead of being added twice.</p>
          {err && <p className="error">{err}</p>}
          <button className="btn accent block" disabled={busy} onClick={save}>{busy ? 'Saving…' : `Save ${money(parseRupees(total) ?? sumPaid)}`}</button>
          <button className="btn block" style={{ marginTop: 8 }} onClick={() => setItems([])}>Start over</button>
        </>
      )}
      {err && !items.length && <p className="error">{err}</p>}
    </Sheet>
  );
}

function SaleSheet({ item, own, onClose }: { item: any | null; own: any[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<any[]>('/api/accounts') });
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api<any[]>('/api/categories') });
  const into = (accounts.data ?? []).filter((a) => ['bank', 'cash', 'wallet'].includes(a.kind) && !a.is_archived);
  const otherIncome = (cats.data ?? []).find((c) => c.class === 'income' && c.name === 'Other income')?.id;
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<any | null>(item);
  const [price, setPrice] = useState('');
  const [buyer, setBuyer] = useState('');
  const [acc, setAcc] = useState<string | null>(null);
  const [date, setDate] = useState(todayIST());
  const [err, setErr] = useState<string | null>(null);
  const accountId = acc ?? into.find((a) => a.meta?.salary)?.id ?? into[0]?.id ?? null;
  const matches = text.trim().length > 1 ? own.filter((o) => o.name.toLowerCase().includes(text.trim().toLowerCase().split(' ')[0])).slice(0, 6) : [];

  function readSentence() {
    const s = parseStuffSentence(text);
    if (s.total) setPrice(String(s.total / 100));
    const name = s.items[0]?.name?.toLowerCase();
    if (name) {
      const best = own.map((o) => ({ o, n: name.split(' ').filter((w) => o.name.toLowerCase().includes(w)).length })).sort((a, b) => b.n - a.n)[0];
      if (best?.n) setPicked(best.o);
    }
    const v = parseSpoken(text, { accounts: accounts.data ?? [], categories: cats.data ?? [] });
    if (v.accountId) setAcc(v.accountId);
    if (v.date) setDate(v.date);
  }

  async function save() {
    setErr(null);
    const p = parseRupees(price);
    if (!picked) return setErr('Pick what you sold');
    if (!p) return setErr('Enter the sale price');
    if (!accountId || !otherIncome) return setErr('Pick the account');
    try {
      await api('/api/stuff/sell', { method: 'POST', body: { itemId: picked.id, price: p, accountId, categoryId: otherIncome, date, buyer: buyer || null } });
      await qc.invalidateQueries();
      toast(`Sold ${picked.name} · ${money(p)} in`);
      onClose();
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <Sheet title="Sold something" onClose={onClose}>
      {!picked ? (
        <>
          <input className="input" autoFocus placeholder='e.g. "sold my PS5 for 30k to Rohan into Axis"' value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') readSentence(); }} />
          <div className="list" style={{ marginTop: 8 }}>
            {matches.map((o) => <button key={o.id} className="item" onClick={() => { setPicked(o); readSentence(); }}><div className="grow"><div className="title">{o.name}</div><div className="sub">{o.category}</div></div></button>)}
          </div>
          {text.trim() && <button className="btn block" style={{ marginTop: 8 }} onClick={readSentence}>Continue</button>}
        </>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 12 }}><b>{picked.name}</b><div className="tiny faint">{picked.category}{picked.price ? ` · paid ${money(picked.price, { whole: true })}` : ''}</div></div>
          <div className="amount-wrap"><span className="cur">₹</span><input className="amount-input" inputMode="decimal" placeholder="Sold for" value={price} onChange={(e) => setPrice(e.target.value)} autoFocus /></div>
          <div className="field"><label>Money went into</label>
            <div className="chips">{into.map((a) => <button key={a.id} className={`chip ${accountId === a.id ? 'on' : ''}`} onClick={() => setAcc(a.id)}>{a.icon ?? ''} {a.name}</button>)}</div>
          </div>
          <div className="grid2">
            <div className="field"><label>Buyer (optional)</label><input className="input" value={buyer} onChange={(e) => setBuyer(e.target.value)} /></div>
            <div className="field"><label>Date</label><input type="date" className="input" value={date} max={todayIST()} onChange={(e) => setDate(e.target.value)} /></div>
          </div>
          <p className="tiny faint">Records the money as income and moves the item from Own to Sold.</p>
          {err && <p className="error">{err}</p>}
          <button className="btn accent block" onClick={save}>Record sale</button>
          {!item && <button className="btn block" style={{ marginTop: 8 }} onClick={() => setPicked(null)}>Pick something else</button>}
        </>
      )}
    </Sheet>
  );
}
