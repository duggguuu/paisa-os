import { compact, money, pct, periodLabel } from '../lib';

/** Spending over the last N periods. Current period highlighted; dashed line = average of the 3 before it. */
export function TrendChart({ points, period, onPick }: { points: { from: string; to: string; total: number }[]; period: string; onPick?: (from: string) => void }) {
  if (!points.length) return null;
  const W = 360, H = 170, padL = 8, padR = 8, padT = 16, padB = 28;
  const max = Math.max(...points.map((p) => p.total), 1);
  const x = (i: number) => padL + (i * (W - padL - padR)) / Math.max(points.length - 1, 1);
  const y = (v: number) => padT + (1 - v / max) * (H - padT - padB);
  const last = points.length - 1;
  const prev3 = points.slice(Math.max(0, last - 3), last);
  const avg = prev3.length ? prev3.reduce((s, p) => s + p.total, 0) / prev3.length : null;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.total).toFixed(1)}`).join(' ');
  const area = `${d} L${x(last)} ${H - padB} L${x(0)} ${H - padB} Z`;
  const label = (from: string) => {
    const [yy, m] = from.split('-').map(Number);
    if (period === 'month') return ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'][m - 1];
    if (period === 'year') return String(yy).slice(2);
    return `${Number(from.slice(8))}`;
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Spending over the last ${points.length} periods`}>
      <defs>
        <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--bar)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--bar)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#trend-fill)" />
      <path d={d} fill="none" stroke="var(--bar)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {avg !== null && (
        <g>
          <line x1={padL} x2={W - padR} y1={y(avg)} y2={y(avg)} stroke="var(--ink-3)" strokeDasharray="4 4" strokeWidth="1" />
          <text x={W - padR} y={y(avg) - 5} textAnchor="end" fontSize="11" fill="var(--ink-3)">3-period avg {compact(avg)}</text>
        </g>
      )}
      {points.map((p, i) => (
        <g key={p.from} onClick={() => onPick?.(p.from)} style={{ cursor: onPick ? 'pointer' : 'default' }}>
          <title>{periodLabel(period, p.from, p.to)}: {money(p.total, { whole: true })}</title>
          <rect x={x(i) - 14} y={padT} width={28} height={H - padT - padB} fill="transparent" />
          <circle cx={x(i)} cy={y(p.total)} r={i === last ? 5 : 3} fill={i === last ? 'var(--bar)' : 'var(--surface)'} stroke="var(--bar)" strokeWidth="2" />
          <text x={x(i)} y={H - 8} textAnchor="middle" fontSize="11" fill={i === last ? 'var(--ink)' : 'var(--ink-3)'} fontWeight={i === last ? 600 : 400}>{label(p.from)}</text>
        </g>
      ))}
      <text x={x(last)} y={y(points[last].total) - 10} textAnchor="end" fontSize="12" fontWeight="600" fill="var(--ink)">{compact(points[last].total)}</text>
    </svg>
  );
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
              <circle key={s.key} cx="90" cy="90" r={R} fill="none" stroke={s.color} strokeWidth={SW}
                strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset} transform="rotate(-90 90 90)"
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
