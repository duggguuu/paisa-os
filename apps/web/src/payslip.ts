/**
 * Read a payslip (PDF, Excel, CSV or TXT, already turned into positioned rows by files.ts).
 *
 * Handles the common layouts:
 *  - two columns side by side: Earnings on the left, Deductions on the right (split at the x of "Deductions");
 *  - one column: an Earnings block followed by a Deductions block.
 * Names that wrap onto a second line are joined. The month, net pay and employer are picked up from
 * the text, deduction kinds (PF, professional tax, TDS, NPS) are recognised by name, and totals are
 * checked against the payslip's own "Total" lines.
 */
import type { Row } from './files';

export interface SlipLine { name: string; monthly: number; kind?: string }
export interface ParsedSlip {
  month: string | null;          // YYYY-MM
  employer: string | null;
  earnings: SlipLine[];
  deductions: SlipLine[];
  gross: number;                 // paise
  totalDeductions: number;
  net: number | null;            // as printed on the slip
  warnings: string[];
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const NUM = /^[-(]?(?:₹|rs\.?|inr)?\s*\d[\d,]*(?:\.\d{1,2})?\)?$/i;
const HEADER_WORD = /^(particulars|rates?\s*\/?\s*month|rate|amount|amount\s*\(.*\)|earnings?|deductions?|description|components?|head|ytd|arrears?\s*amount|current\s*month|actual|full\s*month)$/i;
const TOTAL = /^(total|gross)\b/i;

const toPaise = (s: string) => {
  const neg = /^-|^\(/.test(s.trim());
  const v = Math.round(Number(s.replace(/[^\d.]/g, '')) * 100);
  return neg ? -v : v;
};

export function deductionKind(name: string) {
  const n = name.toLowerCase();
  if (/income\s*tax|\btds\b|tax deducted/.test(n)) return 'tds';
  if (/profession(al)?\s*tax|\bp\.?\s?tax\b|\bpt\b/.test(n)) return 'pt';
  if (/\bnps\b|national pension/.test(n)) return 'nps';
  if (/provident|\bpf\b|\bepf\b|\bvpf\b/.test(n)) return 'pf';
  return 'other';
}

export function parsePayslip(rows: Row[]): ParsedSlip {
  const text = rows.map((r) => r.cells.map((c) => c.text).join(' ')).join('\n');
  const warnings: string[] = [];

  // Month: "Payslip for the month of October 2026", "Pay slip - Oct 2026", "October-2026"…
  let month: string | null = null;
  const mm = text.match(/(?:month\s+of|for\s+the\s+month|pay\s*slip|salary\s+slip)[^\n]*?\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s,'\-/]*(\d{4})/i)
    ?? text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s,'\-/]+(\d{4})\b/i);
  if (mm) month = `${mm[2]}-${String(MONTHS.indexOf(mm[1].toLowerCase().slice(0, 3)) + 1).padStart(2, '0')}`;

  // Employer: the "Company" field, else the first line that looks like a company name.
  let employer: string | null = null;
  for (const r of rows) {
    const i = r.cells.findIndex((c) => /^(company|company name|employer|organi[sz]ation)$/i.test(c.text));
    if (i >= 0 && r.cells[i + 1]) { employer = r.cells[i + 1].text; break; }
  }
  if (!employer) employer = rows.flatMap((r) => r.cells).find((c) => /\b(pvt|private|ltd|limited|llp|inc|corp)\b/i.test(c.text))?.text ?? null;
  if (employer) employer = employer.replace(/\s+/g, ' ').trim().replace(/\b\w+/g, (w) => (w.length > 3 && w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w));

  // Net pay as printed.
  const nm = text.match(/net\s*(?:salary|pay(?:able)?|amount|take\s*home)?\s*(?:payable)?\s*(?:\(.*?\))?\s*[:=]?\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d{1,2})?)/i);
  const net = nm ? toPaise(nm[1]) : null;

  // Where the earnings block starts, and whether deductions sit beside it.
  const start = rows.findIndex((r) => r.cells.some((c) => /^earnings?\b/i.test(c.text) && !/total/i.test(c.text)));
  const earnings: SlipLine[] = [], deductions: SlipLine[] = [];
  let gross = 0, totalDed = 0;
  if (start < 0) {
    warnings.push("Couldn't find an Earnings section.");
    return { month, employer, earnings, deductions, gross, totalDeductions: totalDed, net, warnings };
  }
  let splitX: number | null = null;
  for (const r of rows.slice(start, start + 3)) {
    const d = r.cells.find((c) => /^deductions?\b/i.test(c.text));
    if (d) { splitX = d.x - 1; break; }
  }

  type Side = { list: SlipLine[]; lastY: number; pending: string | null };
  const L: Side = { list: earnings, lastY: -1e9, pending: null }, R: Side = { list: deductions, lastY: -1e9, pending: null };
  let vertical: Side = L;   // one-column layout: which block we're in
  let doneL = false, doneR = false;

  const take = (side: Side, cells: Row['cells'], y: number) => {
    const names = cells.filter((c) => !NUM.test(c.text) && !HEADER_WORD.test(c.text)).map((c) => c.text);
    const nums = cells.filter((c) => NUM.test(c.text));
    const name = names.join(' ').replace(/\s+/g, ' ').trim();
    if (!name && !nums.length) return 'empty';
    if (name && TOTAL.test(name)) return { total: nums.length ? toPaise(nums[nums.length - 1].text) : null };
    if (name && nums.length) {
      side.list.push({ name: side.pending ? `${side.pending} ${name}` : name, monthly: toPaise(nums[nums.length - 1].text) });
      side.pending = null; side.lastY = y;
    } else if (name) {
      const prev = side.list[side.list.length - 1];
      if (prev && y - side.lastY <= 12) prev.name = `${prev.name} ${name}`;   // wrapped name ("Internet Charges / Reimbursement")
      else side.pending = side.pending ? `${side.pending} ${name}` : name;
    } else if (side.pending) {
      side.list.push({ name: side.pending, monthly: toPaise(nums[nums.length - 1].text) });
      side.pending = null; side.lastY = y;
    }
    return 'ok';
  };

  for (const r of rows.slice(start + 1)) {
    const all = r.cells.map((c) => c.text).join(' ');
    if (/^net\b|net\s*(salary|pay)/i.test(all) && !/total/i.test(all)) break;
    if (/in words/i.test(all)) break;
    if (splitX !== null) {
      const left = r.cells.filter((c) => c.x < splitX!), right = r.cells.filter((c) => c.x >= splitX!);
      if (!doneL && left.length) { const t = take(L, left, r.y); if (typeof t === 'object') { gross = t.total ?? gross; doneL = true; } }
      if (!doneR && right.length) { const t = take(R, right, r.y); if (typeof t === 'object') { totalDed = t.total ?? totalDed; doneR = true; } }
      if (doneL && doneR) break;
    } else {
      if (r.cells.some((c) => /^deductions?\b/i.test(c.text))) { vertical = R; continue; }
      const t = take(vertical, r.cells, r.y);
      if (typeof t === 'object') {
        if (vertical === L) { gross = t.total ?? gross; vertical = R; }
        else { totalDed = t.total ?? totalDed; break; }
      }
    }
  }

  for (const d of deductions) d.kind = deductionKind(d.name);
  const sumE = earnings.reduce((s, x) => s + x.monthly, 0), sumD = deductions.reduce((s, x) => s + x.monthly, 0);
  if (!gross) gross = sumE;
  if (!totalDed) totalDed = sumD;
  if (Math.abs(sumE - gross) > 100) warnings.push(`Earnings add up to ₹${(sumE / 100).toLocaleString('en-IN')}, but the slip says ₹${(gross / 100).toLocaleString('en-IN')}.`);
  if (Math.abs(sumD - totalDed) > 100) warnings.push(`Deductions add up to ₹${(sumD / 100).toLocaleString('en-IN')}, but the slip says ₹${(totalDed / 100).toLocaleString('en-IN')}.`);
  if (net !== null && Math.abs(sumE - sumD - net) > 100) warnings.push(`Earnings minus deductions is ₹${((sumE - sumD) / 100).toLocaleString('en-IN')}; the slip's net pay is ₹${(net / 100).toLocaleString('en-IN')}.`);
  if (!month) warnings.push("Couldn't tell which month this is for.");
  if (!earnings.length) warnings.push('No earnings lines found.');
  return { month, employer, earnings, deductions, gross: sumE, totalDeductions: sumD, net, warnings };
}
