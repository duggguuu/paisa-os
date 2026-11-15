import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib';

type Cat = { id: string; name: string; class: string; parent_id: string | null; icon: string | null; sort: number; recent_uses?: number };

/**
 * Two-step category picker: recent picks, a search across every category and subcategory, then
 * category → its subcategories. A new subcategory can be added in place and is selected straight away.
 */
export function CategoryPicker({ cats, cls, value, onChange }: {
  cats: Cat[]; cls: 'expense' | 'income'; value: string | null; onChange: (id: string) => void;
}) {
  const qc = useQueryClient();
  const mine = useMemo(() => cats.filter((c) => c.class === cls), [cats, cls]);
  const byId = useMemo(() => new Map(mine.map((c) => [c.id, c])), [mine]);
  const parents = useMemo(() => mine.filter((c) => !c.parent_id).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)), [mine]);
  const childrenOf = (id: string) => mine.filter((c) => c.parent_id === id).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  const selected = value ? byId.get(value) : undefined;
  const [openId, setOpenId] = useState<string | null>(selected ? selected.parent_id ?? selected.id : null);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const path = (c: Cat) => (c.parent_id ? `${byId.get(c.parent_id)?.name ?? ''} › ${c.name}` : c.name);
  const icon = (c: Cat) => c.icon ?? (c.parent_id ? byId.get(c.parent_id)?.icon : null) ?? '';
  const recent = [...mine].filter((c) => (c.recent_uses ?? 0) > 0 && (c.parent_id || !mine.some((x) => x.parent_id === c.id)))
    .sort((a, b) => (b.recent_uses ?? 0) - (a.recent_uses ?? 0)).slice(0, 6);
  const needle = q.trim().toLowerCase();
  const results = needle ? mine.filter((c) => c.name.toLowerCase().includes(needle) || (c.parent_id && byId.get(c.parent_id)?.name.toLowerCase().includes(needle))).slice(0, 24) : [];

  async function addSub(parent: Cat) {
    const name = adding.trim();
    if (!name) return;
    setErr(null);
    try {
      const r = await api<{ id: string }>('/api/categories', { method: 'POST', body: { name, class: cls, parentId: parent.id } });
      await qc.invalidateQueries({ queryKey: ['categories'] });
      setAdding('');
      onChange(r.id);
    } catch (e: any) { setErr(e.message); }
  }

  const pick = (c: Cat) => { onChange(c.id); setQ(''); };

  return (
    <div className="cat-picker">
      {selected && (
        <div className="cp-selected"><span className="tiny faint">Selected</span> <b>{icon(selected)} {path(selected)}</b></div>
      )}
      <input className="input" placeholder={`Search ${cls === 'income' ? 'income' : 'expense'} categories (e.g. cook, fuel, tests)`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search categories" />
      {needle ? (
        <div className="chips" style={{ marginTop: 8 }}>
          {results.map((c) => (
            <button type="button" key={c.id} className={`chip ${value === c.id ? 'on' : ''}`} onClick={() => pick(c)}>{icon(c)} {path(c)}</button>
          ))}
          {results.length === 0 && <span className="tiny faint">Nothing matches “{q}”. Open a category below and add it as a subcategory.</span>}
        </div>
      ) : (
        <>
          {recent.length > 0 && (
            <>
              <div className="cp-label">Recent</div>
              <div className="chips">
                {recent.map((c) => <button type="button" key={c.id} className={`chip ${value === c.id ? 'on' : ''}`} onClick={() => pick(c)}>{icon(c)} {c.name}</button>)}
              </div>
            </>
          )}
          <div className="cp-label">Categories</div>
          <div className="chips">
            {parents.map((p) => (
              <button type="button" key={p.id} className={`chip ${openId === p.id ? 'open' : ''} ${selected && (selected.id === p.id || selected.parent_id === p.id) ? 'on' : ''}`}
                onClick={() => setOpenId(openId === p.id ? null : p.id)} aria-expanded={openId === p.id}>{p.icon ?? ''} {p.name}{childrenOf(p.id).length ? ' ›' : ''}</button>
            ))}
          </div>
          {openId && byId.get(openId) && (() => {
            const p = byId.get(openId)!;
            const subs = childrenOf(p.id);
            return (
              <div className="cp-subs">
                <div className="cp-label">{p.icon} {p.name}: subcategories</div>
                <div className="chips">
                  {subs.map((c) => <button type="button" key={c.id} className={`chip ${value === c.id ? 'on' : ''}`} onClick={() => pick(c)}>{c.name}</button>)}
                  <button type="button" className={`chip ${value === p.id ? 'on' : ''}`} onClick={() => pick(p)}>{subs.length ? `Just ${p.name}` : p.name}</button>
                </div>
                <div className="cp-add">
                  <input className="input" placeholder={`New subcategory in ${p.name}`} value={adding} onChange={(e) => setAdding(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSub(p); } }} />
                  <button type="button" className="btn small" disabled={!adding.trim()} onClick={() => addSub(p)}>Add</button>
                </div>
                {err && <p className="error">{err}</p>}
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}
