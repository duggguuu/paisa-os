/** FD helpers: tenure ↔ maturity date, the maturity estimate, and matching a bank to today's rate table. */

export type BankRate = { bank: string; highest: number; y1: number; y3: number; y5: number; y2?: number };
export type Comp = 'quarterly' | 'monthly' | 'yearly' | 'simple' | 'yearly_payout';
export type Scheme = { id: string; institution: string; name: string; short: string; rate: number; months: number; compounding: Comp; note: string };
export type RateTable = { asOf: string; source: string; sourceUrl: string; live: boolean; banks: BankRate[]; schemes?: Scheme[]; schemesAsOf?: string; schemesSource?: string; schemesUrl?: string };
export type Tenure = { y: number; m: number; d: number };

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const utc = (s: string) => { const [y, m, d] = s.split('-').map(Number); return { y, m, d }; };

/** Add whole months, clamping to the month's last day (31 Jan + 1 month = 28/29 Feb), as banks do. */
export function addMonthsIso(start: string, months: number): string {
  const { y, m, d } = utc(start);
  const last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return iso(Date.UTC(y, m - 1 + months, Math.min(d, last)));
}

export function maturityFrom(start: string, t: Tenure): string {
  const base = addMonthsIso(start, t.y * 12 + t.m);
  return iso(Date.parse(base) + t.d * 86_400_000);
}

export function tenureBetween(start: string, maturity: string): Tenure {
  let months = 0;
  while (addMonthsIso(start, months + 1) <= maturity) months++;
  const d = Math.round((Date.parse(maturity) - Date.parse(addMonthsIso(start, months))) / 86_400_000);
  return { y: Math.floor(months / 12), m: months % 12, d };
}

export function tenureLabel(t: Tenure): string {
  const parts = [t.y ? `${t.y} yr` : '', t.m ? `${t.m} mo` : '', t.d ? `${t.d} day${t.d === 1 ? '' : 's'}` : ''].filter(Boolean);
  return parts.join(' ') || '0 days';
}

/** Same maths as the server (fds.ts): compound k times a year, or simple interest. Paise in, paise out. */
export function maturityValue(principal: number, rate: number, days: number, comp: Comp): number {
  const t = Math.max(0, days) / 365;
  const k = { monthly: 12, quarterly: 4, yearly: 1, simple: 0, yearly_payout: -1 }[comp] ?? 4;
  if (k === -1) return Math.round(principal * (1 + (Math.pow(1 + rate / 400, 4) - 1) * t)); // paid out yearly, not reinvested
  return Math.round(k ? principal * Math.pow(1 + rate / 100 / k, k * t) : principal * (1 + (rate / 100) * t));
}

/** The yearly rate that turns principal into `final` over `days` (what the money actually earns). */
export function effectiveYield(principal: number, final: number, days: number): number | null {
  if (principal <= 0 || final <= 0 || days <= 0) return null;
  return (Math.pow(final / principal, 365 / days) - 1) * 100;
}

const ALIAS: Record<string, string> = {
  sbi: 'state bank of india', 'state bank': 'state bank of india', hdfc: 'hdfc bank', icici: 'icici bank', axis: 'axis bank',
  kotak: 'kotak mahindra bank', idfc: 'idfc first bank', 'idfc first': 'idfc first bank', yes: 'yes bank', indusind: 'indusind bank',
  pnb: 'punjab national bank', bob: 'bank of baroda', boi: 'bank of india', au: 'au small finance bank', 'au bank': 'au small finance bank',
  union: 'union bank of india', canara: 'canara bank', federal: 'federal bank', rbl: 'rbl bank', idbi: 'idbi bank',
  'post office': 'post office', 'india post': 'post office', po: 'post office', postbank: 'post office', 'post bank': 'post office', 'post office savings': 'post office', equitas: 'equitas small finance bank',
  ujjivan: 'ujjivan small finance bank', suryoday: 'suryoday small finance bank', bandhan: 'bandhan bank', dcb: 'dcb bank',
  'standard chartered': 'standard chartered bank', sc: 'standard chartered bank', hsbc: 'hsbc bank',
};

export function findBank(table: RateTable | undefined, name: string): BankRate | null {
  if (!table || !name.trim()) return null;
  const q = name.trim().toLowerCase().replace(/\s+/g, ' ');
  const target = ALIAS[q] ?? ALIAS[q.replace(/ bank$/, '')] ?? q;
  return table.banks.find((b) => b.bank.toLowerCase() === target)
    ?? table.banks.find((b) => b.bank.toLowerCase().startsWith(target))
    ?? (target.length >= 4 ? table.banks.find((b) => b.bank.toLowerCase().includes(target)) : undefined)
    ?? null;
}

/** The published rate closest to a tenure, and which column it came from. */
export function rateFor(b: BankRate, months: number): { rate: number; label: string } {
  if (months < 18) return { rate: b.y1, label: '1-year' };
  if (months < 30) return b.y2 ? { rate: b.y2, label: '2-year' } : { rate: +((b.y1 + b.y3) / 2).toFixed(2), label: '2-year (between 1 and 3)' };
  if (months < 48) return { rate: b.y3, label: '3-year' };
  return { rate: b.y5, label: '5-year' };
}

export type RateOption = { id: string; label: string; rate: number; months: number | null; compounding?: Comp; note?: string; scheme: string; short?: string };

/** The products to pick from for one institution: Post Office schemes, or a bank's published tenures. */
export function rateOptions(table: RateTable | undefined, b: BankRate | null): RateOption[] {
  if (!table || !b) return [];
  if (b.bank === 'Post Office' && table.schemes?.length) {
    return table.schemes.map((s) => ({ id: s.id, label: `${s.name} · ${s.rate}%`, rate: s.rate, months: s.months, compounding: s.compounding, note: s.note, scheme: `Post Office ${s.name}`, short: s.short }));
  }
  const o: RateOption[] = [
    { id: 'y1', label: `1-year FD · ${b.y1}%`, rate: b.y1, months: 12, scheme: `${b.bank} 1-year FD` },
    { id: 'y2', label: `2-year FD · ${rateFor(b, 24).rate}%${b.y2 ? '' : ' (approx.)'}`, rate: rateFor(b, 24).rate, months: 24, scheme: `${b.bank} 2-year FD` },
    { id: 'y3', label: `3-year FD · ${b.y3}%`, rate: b.y3, months: 36, scheme: `${b.bank} 3-year FD` },
    { id: 'y5', label: `5-year FD · ${b.y5}%`, rate: b.y5, months: 60, scheme: `${b.bank} 5-year FD` },
  ];
  if (b.highest > Math.max(b.y1, b.y3, b.y5)) o.push({ id: 'best', label: `Best special tenure · ${b.highest}%`, rate: b.highest, months: null, scheme: `${b.bank} special tenure FD` });
  return o;
}
