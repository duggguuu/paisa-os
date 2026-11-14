/** Parse Splitwise "Export as spreadsheet" files: Date, Description, Category, Cost, Currency, <person columns…>. */
import { parseDelimited, parseDate, parseAmount } from './statement';

export interface SwCsvFile {
  name: string;
  people: string[];
  rows: { date: string; description: string; category: string | null; cost: number; currency: string | null; nets: Record<string, number> }[];
}

export function parseSplitwiseCsv(text: string, name: string): SwCsvFile {
  const grid = parseDelimited(text);
  const h = grid.findIndex((r) => r.some((c) => /^date$/i.test(c)) && r.some((c) => /^description$/i.test(c)) && r.some((c) => /^cost$/i.test(c)));
  if (h < 0) throw new Error(`${name} doesn't look like a Splitwise export (needs Date, Description, Cost columns).`);
  const header = grid[h].map((c) => c.trim());
  const col = (re: RegExp) => header.findIndex((c) => re.test(c));
  const iDate = col(/^date$/i), iDesc = col(/^description$/i), iCat = col(/^category$/i), iCost = col(/^cost$/i), iCur = col(/^currency$/i);
  const firstPerson = Math.max(iDate, iDesc, iCat, iCost, iCur) + 1;
  const people = header.slice(firstPerson).filter(Boolean);
  if (!people.length) throw new Error(`${name} has no person columns.`);
  const rows: SwCsvFile['rows'] = [];
  for (const r of grid.slice(h + 1)) {
    const date = parseDate(r[iDate] ?? '');
    if (!date) continue; // blank lines and the "Total balance" row
    const cost = parseAmount(r[iCost] ?? '');
    if (cost === null) continue;
    const nets: Record<string, number> = {};
    people.forEach((p, k) => { nets[p] = parseAmount(r[firstPerson + k] ?? '') ?? 0; });
    rows.push({ date, description: (r[iDesc] ?? '').trim(), category: iCat >= 0 ? (r[iCat] ?? '').trim() || null : null, cost: Math.abs(cost), currency: iCur >= 0 ? (r[iCur] ?? '').trim() || null : null, nets });
  }
  return { name, people, rows };
}

/** The person who appears in every export is almost certainly you. */
export function guessMe(files: SwCsvFile[]): string | null {
  if (!files.length) return null;
  const common = files.map((f) => new Set(f.people.map((p) => p.toLowerCase())))
    .reduce((a, b) => new Set([...a].filter((x) => b.has(x))));
  if (common.size !== 1) return null;
  const k = [...common][0];
  return files[0].people.find((p) => p.toLowerCase() === k) ?? null;
}
