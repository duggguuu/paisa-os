/**
 * Splitting an expense: how much stays your spending and how much each person owes you.
 *
 * Modes: 'equal' (everyone the same), 'percent' (shares of 100%) or 'amount' (rupees).
 * Any share left blank takes an equal part of what's left, so you can type just your own share
 * ("I'm 40%") and the rest is divided among the others, or fix one person and leave the rest blank.
 * Rounding paise always lands on your share, so the parts add up to the total exactly.
 */
export type SplitMode = 'equal' | 'percent' | 'amount';
export type SplitResult = { mine: number; others: { id: string; amount: number; pct: number }[]; minePct: number; error: string | null };

const num = (s: string | undefined) => {
  if (s == null || s.trim() === '') return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};

export function computeSplit(total: number, mode: SplitMode, ids: string[], mineInput: string, inputs: Record<string, string>): SplitResult {
  const empty = (error: string | null): SplitResult => ({ mine: total, others: ids.map((id) => ({ id, amount: 0, pct: 0 })), minePct: 100, error });
  if (!total || total <= 0 || !ids.length) return empty(null);
  const n = ids.length + 1;

  let units: number[]; // in percent (0–100) or in paise
  if (mode === 'equal') {
    const each = Math.floor(total / n);
    units = [total - each * ids.length, ...ids.map(() => each)];
  } else {
    const whole = mode === 'percent' ? 100 : total;
    const raw = [num(mineInput), ...ids.map((id) => num(inputs[id]))].map((v) => (v === null ? null : mode === 'amount' && !Number.isNaN(v) ? Math.round(v * 100) : v));
    if (raw.some((v) => Number.isNaN(v))) return empty('Shares must be numbers');
    const fixed = raw.reduce<number>((s, v) => s + (v ?? 0), 0);
    const blanks = raw.filter((v) => v === null).length;
    const left = whole - fixed;
    const show = (v: number) => (mode === 'percent' ? `${+v.toFixed(2)}%` : `₹${(v / 100).toLocaleString('en-IN')}`);
    if (left < -1e-9) return empty(`Shares add up to ${show(fixed)}, more than ${mode === 'percent' ? '100%' : 'the total'}`);
    if (!blanks && Math.abs(left) > (mode === 'percent' ? 0.001 : 0)) return empty(`Shares add up to ${show(fixed)}; they need to make ${mode === 'percent' ? '100%' : show(whole)}. Leave one blank to fill the rest.`);
    const share = blanks ? left / blanks : 0;
    units = raw.map((v) => (v === null ? share : v)) as number[];
  }

  // Convert to paise; others rounded, you take the remainder.
  const toPaise = (u: number) => (mode === 'percent' ? Math.round((total * u) / 100) : Math.round(u));
  const others = ids.map((id, i) => ({ id, amount: toPaise(units[i + 1]) }));
  const mine = total - others.reduce((s, o) => s + o.amount, 0);
  if (mine < 0) return empty('Shares add up to more than the total');
  const pct = (p: number) => (p / total) * 100;
  return { mine, minePct: pct(mine), others: others.map((o) => ({ ...o, pct: pct(o.amount) })), error: null };
}
