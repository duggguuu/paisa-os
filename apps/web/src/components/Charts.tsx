import { useState } from 'react';
import { useAppear, useCountUp, useSize } from '../motion';
import { compact, money, pct, periodLabel } from '../lib';

/** Spending over the last N periods as bars. Current period solid; dashed line = average of the 3 before it.
 *  Drawn at the card's real width (no stretched viewBox), bars grow in, and hovering/tapping shows the amount. */
export function TrendChart({ points, period, onPick }: { points: { from: string; to: string; total: number }[]; period: string; onPick?: (from: string) => void }) {
  const [ref, { width }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const appear = useAppear(points.map((p) => p.from + p.total).join());
  if (!points.length) return null;
  const W = Math.max(width, 260), H = W < 480 ? 190 : 230;
  const padL = 44, padR = 10, padT = 22, padB = 28;
  const last = points.length - 1;
  const prev3 = points.slice(Math.max(0, last - 3), last);
  const avg = prev3.length ? prev3.reduce((s, p) => s + p.total, 0) / prev3.length : null;
  const top = niceMax(Math.max(...points.map((p) => p.total), avg ?? 0, 1));
  const plotH = H - padT - padB;
  const slot = (W - padL - padR) / points.length;
  const bw = Math.max(6, Math.min(34, slot * 0.58));
  const cx = (i: number) => padL + slot * i + slot / 2;
  const y = (v: number) => padT + (1 - v / top) * plotH;
  const label = (from: string) => {
    const [yy, m] = from.split('-').map(Number);
    if (period === 'month') return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1].slice(0, W < 480 ? 1 : 3);
    if (period === 'year') return String(yy);
    return `${Number(from.slice(8))}/${m}`;
  };
  const ticks = [0, top / 2, top];
  const h = hover ?? last;
  const showTip = hover !== null;
  const tipX = Math.min(Math.max(cx(h), 70), W - 70);
  return (
    <div ref={ref} className="trend" onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={W} height={H} role="img" aria-label={`Spending over the last ${points.length} periods`}>
          <defs>
            <linearGradient id="bar-cur" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" />
              <stop offset="100%" stopColor="color-mix(in srgb, var(--accent) 70%, var(--surface))" />
            </linearGradient>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth="1" />
              <text x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--ink-3)">{t ? compact(t) : '0'}</text>
            </g>
          ))}
          {points.map((p, i) => {
            const bh = Math.max(p.total > 0 ? 3 : 0, (p.total / top) * plotH);
            const on = i === h;
            return (
              <g key={p.from} className="tbar" style={{ cursor: onPick ? 'pointer' : 'default' }}
                onMouseEnter={() => setHover(i)} onClick={() => { setHover(i); onPick?.(p.from); }}>
                <rect x={padL + slot * i} y={padT} width={slot} height={plotH} fill="transparent" />
                <rect className={`tb ${i === last ? 'cur' : on ? 'hov' : ''}`} x={cx(i) - bw / 2} y={y(0) - bh} width={bw} height={bh} rx={Math.min(7, bw / 2)}
                  fill={i === last ? 'url(#bar-cur)' : 'var(--accent)'}
                  style={{ transform: appear ? 'scaleY(1)' : 'scaleY(0)', transitionDelay: `${i * 45}ms` }} />
                <text x={cx(i)} y={H - 9} textAnchor="middle" fontSize="11.5" fill={on || i === last ? 'var(--ink)' : 'var(--ink-3)'} fontWeight={i === last ? 650 : 450}>{label(p.from)}</text>
              </g>
            );
          })}
          {avg !== null && avg > 0 && (
            <g className={`avg ${appear ? 'on' : ''}`} pointerEvents="none">
              <line x1={padL} x2={W - padR} y1={y(avg)} y2={y(avg)} stroke="var(--ink-2)" strokeDasharray="5 5" strokeWidth="1.2" />
              <rect x={padL + 4} y={y(avg) - 19} width={W < 480 ? 92 : 116} height={16} rx={8} fill="var(--surface-2)" />
              <text x={padL + 12} y={y(avg) - 7.5} fontSize="10.5" fontWeight="600" fill="var(--ink-2)">{W < 480 ? 'Avg' : '3-month avg'} {compact(avg)}</text>
            </g>
          )}
        </svg>
      )}
      {width > 0 && !showTip && points[last].total > 0 && (
        <div className={`trend-val ${appear ? 'on' : ''}`} style={{ left: cx(last), top: y(points[last].total) - 24 }}>{compact(points[last].total)}</div>
      )}
      {width > 0 && showTip && (
        <div className="trend-tip" style={{ left: tipX, top: Math.max(0, y(points[h].total) - 46) }} key={h}>
          <span>{periodLabel(period, points[h].from, points[h].to)}</span>
          <b className="num">{money(points[h].total, { whole: true })}</b>
        </div>
      )}
    </div>
  );
}

/** A round axis top: 1, 2, 2.5, 5 × 10^n just above the max. */
function niceMax(v: number) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** Calendar of the month, each day shaded by spend. A green dot marks no-spend days in the past. */
export function SpendCalendar({ from, to, days, today, onPick }: { from: string; to: string; days: { day: string; amount: number }[]; today: string; onPick?: (d: string) => void }) {
  const map = new Map(days.map((d) => [d.day, d.amount]));
  const max = Math.max(...days.map((d) => d.amount), 1);
  const [y, m, d0] = from.split('-').map(Number);
  const start = Date.UTC(y, m - 1, d0);
  const n = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
  const lead = (new Date(start).getUTCDay() + 6) % 7;
  const cells = Array.from({ length: n }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
  return (
    <div className="cal" role="grid" aria-label="Spending by day">
      {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <div key={i} className="dow">{d}</div>)}
      {Array.from({ length: lead }, (_, i) => <div key={`b${i}`} />)}
      {cells.map((d) => {
        const amt = map.get(d) ?? 0;
        const future = d > today;
        const strength = amt > 0 ? 0.15 + 0.85 * Math.sqrt(amt / max) : 0;
        return (
          <button key={d} className={`d ${amt === 0 && !future ? 'zero' : ''} ${d === today ? 'today' : ''}`}
            style={amt > 0 ? { background: `color-mix(in srgb, var(--bar) ${Math.round(strength * 100)}%, var(--surface-2))`, color: strength > 0.55 ? '#fff' : 'var(--ink)' } : future ? { opacity: 0.4 } : undefined}
            title={`${d}: ${money(amt, { whole: true })}`} onClick={() => onPick?.(d)} disabled={future}>
            {Number(d.slice(8))}
          </button>
        );
      })}
    </div>
  );
}

/** Slice colours, largest first. The last one is reserved for "Other". */
export const SLICE_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)'];
export const OTHER_COLOR = 'var(--s-other)';

export interface Slice { key: string; name: string; icon?: string | null; amount: number }

/** Top slices get a colour each; the rest are folded into "Other". */
export function toSlices<T extends Slice>(rows: T[]): { slices: (Slice & { color: string; share: number; rest?: boolean })[]; colorOf: Map<string, string> } {
  const pos = rows.filter((r) => r.amount > 0).sort((a, b) => b.amount - a.amount);
  const total = pos.reduce((s, r) => s + r.amount, 0) || 1;
  const top = pos.length > SLICE_COLORS.length + 1 ? pos.slice(0, SLICE_COLORS.length) : pos.slice(0, SLICE_COLORS.length + 1);
  const rest = pos.slice(top.length);
  const colorOf = new Map<string, string>();
  type Out = Slice & { color: string; share: number; rest?: boolean };
  const slices: Out[] = top.map((r, i) => {
    const color = SLICE_COLORS[i] ?? OTHER_COLOR;
    colorOf.set(r.key, color);
    return { key: r.key, name: r.name, icon: r.icon, amount: r.amount, color, share: r.amount / total };
  });
  if (rest.length) {
    const amt = rest.reduce((s, r) => s + r.amount, 0);
    rest.forEach((r) => colorOf.set(r.key, OTHER_COLOR));
    slices.push({ key: '__other', name: `Other (${rest.length})`, icon: null, amount: amt, color: OTHER_COLOR, share: amt / total, rest: true });
  }
  return { slices, colorOf };
}

/** Donut of where the money went, with the total in the middle and a tappable legend. */
export function Donut({ rows, total, label, onPick }: { rows: Slice[]; total: number; label: string; onPick?: (key: string) => void }) {
  const { slices } = toSlices(rows);
  const appear = useAppear(slices.map((x) => x.key + x.amount).join());
  if (!slices.length) return null;
  const R = 70, SW = 22, C = 2 * Math.PI * R, GAP = slices.length > 1 ? 2.5 : 0;
  let offset = 0;
  return (
    <div className="donut">
      <div className="donut-chart">
        <svg viewBox="0 0 180 180" role="img" aria-label={`${label}: ${slices.map((s) => `${s.name} ${pct(s.share)}`).join(', ')}`}>
          <circle cx="90" cy="90" r={R} fill="none" stroke="var(--bar-track)" strokeWidth={SW} />
          {slices.map((s) => {
            const len = Math.max(s.share * C - GAP, 0.001);
            const el = (
              <circle key={s.key} className="dn-slice" cx="90" cy="90" r={R} fill="none" stroke={s.color} strokeWidth={SW}
                strokeDasharray={appear ? `${len} ${C - len}` : `0 ${C}`} strokeDashoffset={-offset} transform="rotate(-90 90 90)"
                style={{ cursor: onPick && !s.rest ? 'pointer' : 'default' }} onClick={() => !s.rest && onPick?.(s.key)}>
                <title>{s.name}: {money(s.amount, { whole: true })} ({pct(s.share)})</title>
              </circle>
            );
            offset += s.share * C;
            return el;
          })}
        </svg>
        <div className="donut-center">
          <span className="tiny faint">{label}</span>
          <b className="num">{compact(total)}</b>
        </div>
      </div>
      <ul className="donut-legend">
        {slices.map((s) => (
          <li key={s.key}>
            <button type="button" disabled={!onPick || s.rest} onClick={() => onPick?.(s.key)}>
              <span className="sw" style={{ background: s.color }} />
              <span className="nm">{s.icon ? `${s.icon} ` : ''}{s.name}</span>
              <span className="pc num">{pct(s.share)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Tiny bar sparkline for KPI cards. The last bar (this period) is solid. */
export function MiniBars({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(...values.map((v) => Math.abs(v)), 1);
  return (
    <span className="minibars" style={{ color }} aria-hidden>
      {values.map((v, i) => <span key={i} style={{ height: `${Math.max(10, (Math.abs(v) / max) * 100)}%` }} />)}
    </span>
  );
}

/** Semicircle gauge, 0–100, segmented, with a marker at the score. */
export function Gauge({ score, label }: { score: number; label: string }) {
  const R = 62, cx = 75, cy = 72, segs = 5, gap = 3;
  const pt = (t: number, r = R) => {
    const a = Math.PI * (1 - t);
    return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
  };
  const arc = (t0: number, t1: number) => {
    const [x0, y0] = pt(t0), [x1, y1] = pt(t1);
    return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${R} ${R} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  };
  const colors = ['#ef4f4f', '#f2752c', '#f1a200', '#3fbf86', '#1fb37a'];
  const t = Math.max(0, Math.min(1, score / 100));
  const [mx, my] = pt(t);
  const gapT = gap / (Math.PI * R);
  return (
    <div className="gauge" role="img" aria-label={`Financial health ${score} out of 100, ${label}`}>
      <svg viewBox="0 0 150 80">
        {Array.from({ length: segs }, (_, i) => (
          <path key={i} pathLength={1} d={arc(i / segs + (i ? gapT : 0), (i + 1) / segs - (i < segs - 1 ? gapT : 0))} fill="none"
            stroke={colors[i]} strokeOpacity={(i + 1) / segs <= t + 0.001 || i / segs < t ? 1 : 0.22} strokeWidth="13" strokeLinecap="round" />
        ))}
        <circle cx={mx} cy={my} r="9" fill="var(--surface)" stroke="var(--ink)" strokeWidth="3" />
      </svg>
      <div className="g-num"><b className="num">{score}</b><span>Your score</span></div>
    </div>
  );
}

/** Spent / Budgeted / Remaining as three tall bars (Budget Overview). */
export function OverviewBars({ spent, budget }: { spent: number; budget: number }) {
  const remaining = Math.max(budget - spent, 0);
  const max = Math.max(spent, budget, 1);
  const over = spent > budget;
  const bars: [string, number, string][] = [
    ['Spent', spent, over ? 'var(--up)' : 'var(--accent)'],
    ['Budgeted', budget, 'var(--indigo)'],
    [over ? 'Over by' : 'Remaining', over ? spent - budget : remaining, over ? 'var(--up)' : 'var(--accent-2)'],
  ];
  return (
    <div className="overview">
      {bars.map(([label, v, color]) => (
        <div key={label} className="ob">
          <span className="ol">{label}</span>
          <span className="ov num">{compact(v)}</span>
          <span className="obar" style={{ height: `${Math.max(6, (v / max) * 70)}%`, background: color }} />
        </div>
      ))}
    </div>
  );
}

export const PIE_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)', 'var(--s9)', 'var(--s10)'];

/** Slices for the labelled pie: top 9 by size, the rest folded into "Other", each with a colour. */
export function pieSlices<T extends { amount: number; name: string; icon?: string | null; id?: string; key?: string }>(rows: T[]) {
  const pos = rows.filter((r) => r.amount > 0).sort((a, b) => b.amount - a.amount);
  const total = pos.reduce((s, r) => s + r.amount, 0) || 1;
  const top = pos.length > 10 ? pos.slice(0, 9) : pos;
  const rest = pos.slice(top.length);
  const out = top.map((r, i) => ({ key: String(r.id ?? r.key ?? r.name), name: r.name, icon: r.icon ?? null, amount: r.amount, share: r.amount / total, color: PIE_COLORS[i % PIE_COLORS.length], rest: false }));
  if (rest.length) {
    const amt = rest.reduce((s, r) => s + r.amount, 0);
    out.push({ key: '__other', name: `Other (${rest.length})`, icon: null, amount: amt, share: amt / total, color: 'var(--s-other)', rest: true });
  }
  return out;
}

/** Donut for Stats: slices sweep in, hovering or tapping a slice (or its row) lifts it and shows it in the middle. */
export function DonutPie({ slices, total, label, active, onActive, onPick }: {
  slices: ReturnType<typeof pieSlices>; total: number; label: string;
  active: string | null; onActive: (k: string | null) => void; onPick?: (key: string) => void;
}) {
  const appear = useAppear(slices.map((x) => x.key + x.amount).join());
  const cur = slices.find((x) => x.key === active) ?? null;
  const shown = useCountUp(cur ? cur.amount : total);
  if (!slices.length) return null;
  const S = 240, c = S / 2, R = 92, SW = 30, C = 2 * Math.PI * R, GAP = slices.length > 1 ? 3 : 0;
  let offset = 0;
  return (
    <div className="donut-pie" onMouseLeave={() => onActive(null)}>
      <svg viewBox={`0 0 ${S} ${S}`} role="img" aria-label={`${label}: ${slices.map((x) => `${x.name} ${pct(x.share)}`).join(', ')}`}>
        <circle cx={c} cy={c} r={R} fill="none" stroke="var(--bar-track)" strokeWidth={SW} />
        {slices.map((x, i) => {
          const len = Math.max(x.share * C - GAP, 0.5);
          const el = (
            <circle key={x.key} className={`dp-slice ${active === x.key ? 'on' : active ? 'dim' : ''}`} cx={c} cy={c} r={R} fill="none"
              stroke={x.color} strokeWidth={SW}
              strokeDasharray={appear ? `${len} ${C}` : `0 ${C}`}
              strokeDashoffset={-offset} transform={`rotate(-90 ${c} ${c})`}
              style={{ transitionDelay: `${i * 70}ms`, cursor: onPick && !x.rest ? 'pointer' : 'default' }}
              onMouseEnter={() => onActive(x.key)} onClick={() => (active === x.key && onPick && !x.rest ? onPick(x.key) : onActive(x.key))}>
              <title>{x.name}: {money(x.amount, { whole: true })} ({pct(x.share)})</title>
            </circle>
          );
          offset += x.share * C;
          return el;
        })}
      </svg>
      <div className="dp-center" key={cur?.key ?? 'all'}>
        <span className="dp-label">{cur ? <>{cur.icon ? `${cur.icon} ` : ''}{cur.name}</> : label}</span>
        <b className="num">{money(Math.round(shown), { whole: true })}</b>
        <span className="dp-pct">{cur ? `${(cur.share * 100).toFixed(1)}% of total` : `${slices.length} ${slices.length === 1 ? 'category' : 'categories'}`}</span>
      </div>
    </div>
  );
}
