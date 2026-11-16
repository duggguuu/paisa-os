import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib';
import { Sheet, useUi } from '../App';

type Cat = { id: string; name: string; class: 'expense' | 'income'; parent_id: string | null; icon: string | null; sort: number; is_archived: boolean; not_income: boolean };
type Editing = { mode: 'new-parent' } | { mode: 'new-sub'; parent: Cat } | { mode: 'edit'; cat: Cat };

const ICONS = ['🍲', '🧑‍🍳', '🏠', '🛵', '🚗', '🛍️', '🧾', '🩺', '💈', '🎬', '📚', '✈️', '👪', '🧸', '🐾', '🍻', '🎁', '🎨', '🪔', '💼', '🏦', '🧮', '📈', '📊', '🏘️', '🧑‍💻', '💰', '💳', '📱', '⚡', '💧', '🔥', '🏋️', '💊', '🧪', '🦷', '👓', '🎓', '⛽', '🔧', '🅿️', '🚆', '🍼', '💍', '🎉', '🙏', '🏖️', '🖥️', '🎮', '📦', '•'];

/** Bold the part of a name that matches the search. */
function highlight(name: string, q: string) {
  const i = q.trim() ? name.toLowerCase().indexOf(q.trim().toLowerCase()) : -1;
  if (i < 0) return name;
  return <>{name.slice(0, i)}<mark>{name.slice(i, i + q.trim().length)}</mark>{name.slice(i + q.trim().length)}</>;
}

/** Settings → Categories: every expense and income category with its subcategories. Add, rename, re-icon, hide. */
export function Categories() {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [cls, setCls] = useState<'expense' | 'income'>('expense');
  const [showHidden, setShowHidden] = useState(false);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Editing | null>(null);
  const cats = useQuery({ queryKey: ['categories', 'all'], queryFn: () => api<Cat[]>('/api/categories?all=1') });

  const tree = useMemo(() => {
    const all = (cats.data ?? []).filter((c) => c.class === cls && (showHidden || !c.is_archived));
    // While searching, a match in the other tab switches to it (handled below via otherHits).
    const needle = q.trim().toLowerCase();
    const parents = all.filter((c) => !c.parent_id).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
    return parents.map((p) => {
      const subs = all.filter((c) => c.parent_id === p.id).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
      const hit = !needle || p.name.toLowerCase().includes(needle) || subs.some((s) => s.name.toLowerCase().includes(needle));
      return { p, subs: needle && !p.name.toLowerCase().includes(needle) ? subs.filter((s) => s.name.toLowerCase().includes(needle)) : subs, hit };
    }).filter((x) => x.hit);
  }, [cats.data, cls, showHidden, q]);

  const counts = { parents: tree.length, subs: tree.reduce((s, x) => s + x.subs.length, 0) };
  const other = cls === 'expense' ? 'income' : 'expense';
  const otherHits = q.trim() ? (cats.data ?? []).filter((c) => c.class === other && (showHidden || !c.is_archived) && c.name.toLowerCase().includes(q.trim().toLowerCase())).length : 0;

  async function setHidden(c: Cat, hidden: boolean) {
    try {
      await api(`/api/categories/${c.id}`, { method: 'PATCH', body: { isArchived: hidden } });
      await qc.invalidateQueries({ queryKey: ['categories'] });
      toast(hidden ? `${c.name} hidden` : `${c.name} is back`);
    } catch (e: any) { toast(e.message); }
  }

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Categories</h1>
        <button className="btn small accent" onClick={() => setEditing({ mode: 'new-parent' })}>+ Category</button>
      </div>
      <div className="seg full" style={{ marginBottom: 10 }}>
        <button className={cls === 'expense' ? 'on' : ''} onClick={() => setCls('expense')}>Expenses</button>
        <button className={cls === 'income' ? 'on' : ''} onClick={() => setCls('income')}>Income &amp; money in</button>
      </div>
      <div className="row" style={{ gap: 8, marginBottom: 10 }}>
        <input className="input grow" placeholder="Search categories" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="chip" style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} style={{ marginRight: 6 }} />Show hidden
        </label>
      </div>
      <div className="tiny faint" style={{ margin: '0 2px 8px' }}>{counts.parents} categories · {counts.subs} subcategories · tap ✎ on any subcategory to rename it, move it, or hide it</div>
      {cls === 'income' && <p className="tiny faint" style={{ margin: '0 2px 10px' }}>Categories marked <b>not income</b> are money coming in that isn't earnings (repayments, refunds, gifts). They stay out of your income totals.</p>}

      {!cats.data ? <div className="card"><div className="skeleton" /></div> : (
        <div className="list cat-list">
          {tree.map(({ p, subs }) => (
            <div key={p.id} className={`cat-group ${p.is_archived ? 'hidden' : ''}`}>
              <div className="cat-head">
                <span className="cat-icon" aria-hidden>{p.icon ?? '•'}</span>
                <span className="grow">
                  <span className="title">{p.name}</span>
                  <span className="sub">{subs.length ? `${subs.length} subcategor${subs.length === 1 ? 'y' : 'ies'}` : 'No subcategories yet'}{p.not_income ? ' · not income' : ''}{p.is_archived ? ' · hidden' : ''}</span>
                </span>
                <button className="btn small" onClick={() => setEditing({ mode: 'edit', cat: p })}>Edit</button>
              </div>
              <div className="cat-chips">
                {subs.map((s) => (
                  <button key={s.id} className={`cat-chip ${s.is_archived ? 'hidden' : ''}`} onClick={() => setEditing({ mode: 'edit', cat: s })} title="Rename, move, change icon or hide" aria-label={`Edit ${s.name}`}>
                    {s.icon ? `${s.icon} ` : ''}{highlight(s.name, q)}<span className="cat-chip-edit" aria-hidden>✎</span>
                  </button>
                ))}
                <button className="cat-chip add" onClick={() => setEditing({ mode: 'new-sub', parent: p })}>+ Subcategory</button>
              </div>
            </div>
          ))}
          {tree.length === 0 && otherHits > 0 && <div className="empty">{otherHits} match{otherHits === 1 ? '' : 'es'} in {other === 'income' ? 'Income' : 'Expenses'}. <button className="btn small" style={{ marginLeft: 6 }} onClick={() => setCls(other)}>Show them</button></div>}
          {tree.length === 0 && otherHits === 0 && <div className="empty">No categories match “{q}”. <button className="btn small" style={{ marginLeft: 6 }} onClick={() => setEditing({ mode: 'new-parent' })}>Add “{q}”</button></div>}
        </div>
      )}
      <p className="tiny faint" style={{ margin: '12px 2px' }}>Hiding a category keeps its past transactions and totals; it just stops showing when you add new ones. Salary, Interest and the "Other" categories are used by the app itself, so they can be renamed but not hidden.</p>
      {editing && <CategorySheet editing={editing} cls={cls} parents={(cats.data ?? []).filter((c) => !c.parent_id && c.class === (editing.mode === 'edit' ? editing.cat.class : cls) && !c.is_archived)} onClose={() => setEditing(null)} onHide={setHidden} />}
    </>
  );
}

function CategorySheet({ editing, cls, parents, onClose, onHide }: { editing: Editing; cls: 'expense' | 'income'; parents: Cat[]; onClose: () => void; onHide: (c: Cat, hidden: boolean) => Promise<void> }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const cat = editing.mode === 'edit' ? editing.cat : null;
  const [name, setName] = useState(cat?.name ?? '');
  const [icon, setIcon] = useState<string | null>(cat?.icon ?? (editing.mode === 'new-parent' ? '•' : null));
  const [notIncome, setNotIncome] = useState(false);
  const [parentId, setParentId] = useState<string | null>(cat?.parent_id ?? null);
  const [err, setErr] = useState<string | null>(null);
  const isParent = editing.mode === 'new-parent' || (cat && !cat.parent_id);
  const title = editing.mode === 'new-parent' ? `New ${cls === 'income' ? 'income' : 'expense'} category` : editing.mode === 'new-sub' ? `New subcategory in ${editing.parent.name}` : `Edit ${cat!.parent_id ? 'subcategory' : 'category'}`;

  async function save() {
    setErr(null);
    if (!name.trim()) return setErr('Give it a name');
    try {
      if (editing.mode === 'edit') await api(`/api/categories/${cat!.id}`, { method: 'PATCH', body: { name: name.trim(), icon, ...(cat!.parent_id && parentId && parentId !== cat!.parent_id ? { parentId } : {}) } });
      else await api('/api/categories', { method: 'POST', body: {
        name: name.trim(), class: editing.mode === 'new-sub' ? editing.parent.class : cls,
        parentId: editing.mode === 'new-sub' ? editing.parent.id : null, icon, notIncome: editing.mode === 'new-parent' && cls === 'income' ? notIncome : undefined,
      } });
      await qc.invalidateQueries({ queryKey: ['categories'] });
      toast(editing.mode === 'edit' ? 'Saved' : `Added ${name.trim()}`);
      onClose();
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <Sheet title={title} onClose={onClose}>
      <div className="field"><label>Name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus
          placeholder={editing.mode === 'new-sub' ? 'e.g. Cook' : cls === 'income' ? 'e.g. Freelance' : 'e.g. Household help'}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); }} /></div>
      {cat?.parent_id && (
        <div className="field"><label>Belongs to</label>
          <select className="input" value={parentId ?? ''} onChange={(e) => setParentId(e.target.value)}>
            {parents.map((p) => <option key={p.id} value={p.id}>{p.icon ? `${p.icon} ` : ''}{p.name}</option>)}
          </select>
          <span className="tiny faint">Past transactions move with it, so totals stay right.</span>
        </div>
      )}
      <div className="field"><label>Icon {isParent ? '' : '(optional)'}</label>
        <div className="icon-grid">
          {!isParent && <button type="button" className={`ic none ${icon === null ? 'on' : ''}`} onClick={() => setIcon(null)}>none</button>}
          {ICONS.map((i) => <button type="button" key={i} className={`ic ${icon === i ? 'on' : ''}`} onClick={() => setIcon(i)}>{i}</button>)}
        </div>
      </div>
      {editing.mode === 'new-parent' && cls === 'income' && (
        <label className="toggle"><input type="checkbox" checked={notIncome} onChange={(e) => setNotIncome(e.target.checked)} />
          <span><b>Not income</b><span className="tiny faint">Money coming in that isn't earnings, like repayments or deposits back. Kept out of income totals.</span></span></label>
      )}
      {err && <p className="error">{err}</p>}
      <button className="btn accent block" onClick={save}>{editing.mode === 'edit' ? 'Save' : 'Add'}</button>
      {cat && (
        <button className="btn block" style={{ marginTop: 8 }} onClick={async () => { await onHide(cat, !cat.is_archived); onClose(); }}>
          {cat.is_archived ? 'Show it again' : `Hide ${cat.parent_id ? 'this subcategory' : 'this category and its subcategories'}`}
        </button>
      )}
    </Sheet>
  );
}
