import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, money, compact, dayLabel } from '../lib';
import { Sheet, useUi } from '../App';

export type TileId = 'spend' | 'month' | 'networth' | 'budget' | 'bills' | 'fds' | 'goals' | 'top';
export type Size = 's' | 'm' | 'l';
type Tile = { id: TileId; size: Size };

export const TILE_INFO: Record<TileId, { title: string; desc: string; to: string; icon: string }> = {
  spend: { title: 'Safe to spend', desc: 'What you can still spend, per day', to: '/', icon: '🟢' },
  month: { title: 'This month', desc: 'Spent, earned and left over', to: '/activity', icon: '📅' },
  networth: { title: 'Net worth', desc: 'What you own minus what you owe', to: '/accounts', icon: '📈' },
  budget: { title: 'Budget', desc: 'How much of your budgets is used', to: '/budgets', icon: '🎯' },
  bills: { title: 'Bills due', desc: 'Bills and SIPs in the next 7 days', to: '/recurring', icon: '🧾' },
  fds: { title: 'Fixed deposits', desc: 'Worth today and the next maturity', to: '/fds', icon: '🔒' },
  goals: { title: 'Goals', desc: 'Progress on your savings goals', to: '/goals', icon: '🏁' },
  top: { title: 'Top spending', desc: 'Biggest categories this month', to: '/stats', icon: '🔥' },
};
const ORDER = Object.keys(TILE_INFO) as TileId[];
const SIZE_LABEL: Record<Size, string> = { s: 'Small', m: 'Medium', l: 'Large' };

const pct = (x: number) => `${Math.round(Math.max(0, x) * 100)}%`;
const tone = (f: number) => (f >= 1 ? 'bad' : f >= 0.85 ? 'warn' : 'good');

function Bar({ f, t = 'ink' }: { f: number; t?: string }) {
  return <div className="tile-bar" aria-hidden><span className={`t-${t}`} style={{ width: `${Math.max(0, Math.min(1, f)) * 100}%` }} /></div>;
}
function Row({ l, r, t }: { l: ReactNode; r: ReactNode; t?: string }) {
  return <div className="tile-row"><span>{l}</span><b className={`num ${t ? `t-${t}-text` : ''}`}>{r}</b></div>;
}

function body(id: TileId, size: Size, d: any): ReactNode {
  const big = size === 's' ? 'tile-big s' : 'tile-big';
  switch (id) {
    case 'spend': {
      const s = d.safeToSpend, m = d.month;
      return <>
        <div className={`${big} num ${s.amount < 0 ? 't-bad-text' : ''}`}>{size === 's' ? compact(s.amount) : money(s.amount, { whole: true })}</div>
        <div className="tile-sub">{s.amount > 0 ? <>about {money(s.perDay, { whole: true })}/day</> : 'Over plan this month'}</div>
        {size !== 's' && <><Bar f={1 - m.daysLeft / m.daysTotal} /><div className="tile-sub">{m.daysLeft} days left</div></>}
        {size === 'l' && <div className="tile-more"><Row l="Spent" r={money(d.thisMonth.spent, { whole: true })} /><Row l="Earned" r={money(d.thisMonth.earned, { whole: true })} t="good" /></div>}
      </>;
    }
    case 'month': {
      const t = d.thisMonth;
      return <>
        <div className={`${big} num`}>{size === 's' ? compact(t.spent) : money(t.spent, { whole: true })}</div>
        <div className="tile-sub">spent</div>
        {size !== 's' && <><Row l="Earned" r={money(t.earned, { whole: true })} t="good" /><Row l="Left over" r={money(t.earned - t.spent, { whole: true })} t={t.earned - t.spent < 0 ? 'bad' : undefined} /></>}
        {size === 'l' && d.topSpending.length > 0 && <div className="tile-more">{d.topSpending.map((c: any) => <Row key={c.name} l={`${c.icon ?? ''} ${c.name}`} r={compact(c.amount)} />)}</div>}
      </>;
    }
    case 'networth': {
      const n = d.netWorth;
      return <>
        <div className={`${big} num ${n.total < 0 ? 't-bad-text' : ''}`}>{size === 's' ? compact(n.total) : money(n.total, { whole: true })}</div>
        {size === 's' ? <div className="tile-sub">owe {compact(n.liabilities)}</div> : <>
          <Row l="You own" r={money(n.assets, { whole: true })} /><Row l="You owe" r={money(n.liabilities, { whole: true })} />
          <Bar f={n.assets > 0 ? 1 - n.liabilities / n.assets : 0} t="good" />
        </>}
        {size === 'l' && d.fds.count > 0 && <div className="tile-more"><Row l={`In ${d.fds.count} FD${d.fds.count === 1 ? '' : 's'}`} r={money(d.fds.valueNow, { whole: true })} /></div>}
      </>;
    }
    case 'budget': {
      const b = d.budget;
      if (!b.limit) return <div className="tile-sub">No budgets yet. Tap to add one.</div>;
      const f = b.spent / b.limit;
      return <>
        <div className={`${big} num t-${tone(f)}-text`}>{pct(f)} <span className="tile-unit">used</span></div>
        <div className="tile-sub">{compact(b.spent)} of {compact(b.limit)}</div>
        <Bar f={f} t={tone(f)} />
        {size !== 's' && <div className="tile-more">{b.top.slice(0, size === 'l' ? 4 : 2).map((c: any) => {
          const cf = c.spent / Math.max(c.limit, 1);
          return <div key={c.name}><Row l={`${c.icon ?? ''} ${c.name}`} r={pct(cf)} t={tone(cf)} />{size === 'l' && <Bar f={cf} t={tone(cf)} />}</div>;
        })}</div>}
      </>;
    }
    case 'bills': {
      if (!d.bills.length) return <><div className={`${big}`}>All clear</div><div className="tile-sub">Nothing due this week</div></>;
      const n = size === 's' ? 2 : size === 'm' ? 3 : 5;
      return <div className="tile-list">{d.bills.slice(0, n).map((b: any, i: number) => (
        <div key={i} className="tile-row">
          <span><span className="tile-name">{b.name}</span><span className={`tile-sub ${b.overdue ? 't-bad-text' : b.today ? 't-warn-text' : ''}`}>{b.overdue ? 'Overdue' : b.today ? 'Today' : dayLabel(b.due)}</span></span>
          <b className="num">{compact(b.amount)}</b>
        </div>))}</div>;
    }
    case 'fds': {
      const f = d.fds;
      if (!f.count) return <div className="tile-sub">No FDs yet. Tap to add one.</div>;
      return <>
        <div className={`${big} num`}>{size === 's' ? compact(f.valueNow) : money(f.valueNow, { whole: true })}</div>
        <div className="tile-sub">worth today · {f.count} FD{f.count === 1 ? '' : 's'}</div>
        {size !== 's' && <Row l="At maturity" r={money(f.atMaturity, { whole: true })} t="good" />}
        {f.next && <div className="tile-sub">Next: {size === 's' ? dayLabel(f.next.maturity) : <>{f.next.name} on {dayLabel(f.next.maturity)}</>}</div>}
      </>;
    }
    case 'goals': {
      if (!d.goals.length) return <div className="tile-sub">No goals yet. Tap to add one.</div>;
      const n = size === 's' ? 1 : size === 'm' ? 2 : 4;
      return <div className="tile-list">{d.goals.slice(0, n).map((g: any) => (
        <div key={g.name}><Row l={`${g.icon ?? '🎯'} ${g.name}`} r={pct(g.progress)} t="good" />
          {size !== 's' && <div className="tile-sub">{compact(g.saved)} of {compact(g.target)}</div>}<Bar f={g.progress} t="good" /></div>))}</div>;
    }
    case 'top': {
      if (!d.topSpending.length) return <div className="tile-sub">No spending yet this month.</div>;
      const max = Math.max(...d.topSpending.map((c: any) => c.amount), 1);
      return <div className="tile-list">{d.topSpending.slice(0, size === 's' ? 2 : 3).map((c: any) => (
        <div key={c.name}><Row l={`${c.icon ?? ''} ${c.name}`} r={compact(c.amount)} />{size !== 's' && <Bar f={c.amount / max} />}</div>))}</div>;
    }
  }
}

/** The widget tiles on Home: chosen, sized and ordered by the user (saved to the account, so phone and laptop match). */
export function HomeTiles() {
  const cfg = useQuery({ queryKey: ['widgets'], queryFn: () => api<any>('/api/widgets') });
  const data = useQuery({ queryKey: ['widgets-data'], queryFn: () => api<any>('/api/widgets/data') });
  const [editing, setEditing] = useState(false);
  const tiles: Tile[] = cfg.data?.tiles ?? [];
  const d = data.data;
  return (
    <div className="section">
      <div className="section-title">Widgets <button className="link-btn" style={{ textDecoration: 'none', fontWeight: 600 }} onClick={() => setEditing(true)}>{tiles.length ? 'Edit' : 'Add'}</button></div>
      {tiles.length === 0 ? (
        <button className="card tile-empty" onClick={() => setEditing(true)}>Add widgets: budget, net worth, FDs, bills, goals and more, in the sizes you like.</button>
      ) : (
        <div className="tiles">
          {tiles.map((t, i) => (
            <Link key={`${t.id}-${i}`} to={TILE_INFO[t.id].to} className={`tile tile-${t.size}`}>
              <div className="tile-head"><span>{TILE_INFO[t.id].title}</span></div>
              {d ? body(t.id, t.size, d) : <div className="skeleton" />}
            </Link>
          ))}
        </div>
      )}
      {editing && <TilesEditor initial={tiles} onClose={() => setEditing(false)} />}
    </div>
  );
}

function TilesEditor({ initial, onClose }: { initial: Tile[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const [tiles, setTiles] = useState<Tile[]>(initial);
  const [busy, setBusy] = useState(false);
  const move = (i: number, by: number) => setTiles((t) => { const n = [...t]; const j = i + by; if (j < 0 || j >= n.length) return n; [n[i], n[j]] = [n[j], n[i]]; return n; });
  async function save() {
    setBusy(true);
    try {
      await api('/api/widgets/tiles', { method: 'PUT', body: { tiles } });
      await qc.invalidateQueries({ queryKey: ['widgets'] });
      toast('Widgets saved');
      onClose();
    } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  }
  const unused = ORDER.filter((id) => !tiles.some((t) => t.id === id));
  return (
    <Sheet title="Home widgets" onClose={onClose}>
      <p className="small muted" style={{ marginTop: 0 }}>Small widgets sit two to a row; medium and large take the full width, and large shows more detail.</p>
      {tiles.length > 0 && (
        <div className="list" style={{ marginBottom: 14 }}>
          {tiles.map((t, i) => (
            <div key={`${t.id}-${i}`} className="item tile-edit">
              <div className="grow">
                <div className="title">{TILE_INFO[t.id].icon} {TILE_INFO[t.id].title}</div>
                <div className="seg" style={{ marginTop: 6 }}>
                  {(['s', 'm', 'l'] as Size[]).map((s) => <button key={s} className={t.size === s ? 'on' : ''} onClick={() => setTiles((x) => x.map((y, k) => (k === i ? { ...y, size: s } : y)))}>{SIZE_LABEL[s]}</button>)}
                </div>
              </div>
              <div className="row" style={{ gap: 4 }}>
                <button className="btn small" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button className="btn small" aria-label="Move down" disabled={i === tiles.length - 1} onClick={() => move(i, 1)}>↓</button>
                <button className="btn small" aria-label="Remove" onClick={() => setTiles((x) => x.filter((_, k) => k !== i))}>✕</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {unused.length > 0 && <>
        <div className="section-title" style={{ marginTop: 0 }}>Add a widget</div>
        <div className="list" style={{ marginBottom: 14 }}>
          {unused.map((id) => (
            <button key={id} className="item" onClick={() => setTiles((x) => [...x, { id, size: id === 'networth' || id === 'fds' || id === 'spend' ? 's' : 'm' }])}>
              <div className="avatar" aria-hidden>{TILE_INFO[id].icon}</div>
              <div className="grow"><div className="title">{TILE_INFO[id].title}</div><div className="sub">{TILE_INFO[id].desc}</div></div>
              <span className="btn small">Add</span>
            </button>
          ))}
        </div>
      </>}
      <p className="tiny faint">Want them on your iPhone home screen too? Settings → Widgets.</p>
      <button className="btn accent block" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
    </Sheet>
  );
}
