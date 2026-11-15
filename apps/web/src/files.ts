/**
 * One reader for every upload in the app: PDF, Excel (.xlsx/.xls), CSV, TSV and TXT.
 * Everything is read in the browser; files never leave the device.
 *
 *  - readGrid(file): rows of cells. PDF rows are rebuilt from text positions (cells carry their x),
 *    Excel uses SheetJS (bundled with the app, loaded on demand), CSV/TXT are split on their delimiter.
 *  - gridToText(grid): the same as tab-separated text, for parsers that take text.
 *  - PDFs with a password: pass `askPassword`, which is called (and retried) until it opens or you cancel.
 */
export interface Cell { text: string; x: number; w: number }
export type Row = { y: number; cells: Cell[] };

export const UPLOAD_ACCEPT = '.pdf,.xlsx,.xls,.csv,.tsv,.txt,application/pdf,text/csv,text/plain,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const kindOf = (f: File) => {
  const n = f.name.toLowerCase();
  if (n.endsWith('.pdf') || f.type === 'application/pdf') return 'pdf';
  if (/\.(xlsx|xlsm|xls)$/.test(n) || /spreadsheet|ms-excel/.test(f.type)) return 'excel';
  if (f.type.startsWith('image/') || /\.(png|jpe?g|heic|webp)$/.test(n)) return 'image';
  return 'text';
};

export class Cancelled extends Error { constructor() { super('Cancelled'); } }

// ---------------------------------------------------------------------------
/** PDF → positioned rows (all pages, top to bottom). */
export async function pdfRows(file: File, askPassword?: (retry: boolean) => Promise<string | null>): Promise<Row[]> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  const data = new Uint8Array(await file.arrayBuffer());
  let password: string | undefined, doc: any, retry = false;
  for (;;) {
    try { doc = await pdfjs.getDocument({ data: data.slice(), password, isEvalSupported: false }).promise; break; }
    catch (e: any) {
      if (e?.name !== 'PasswordException' || !askPassword) throw e?.name === 'PasswordException' ? new Error('This PDF needs its password.') : e;
      const p = await askPassword(retry);
      if (p === null) throw new Cancelled();
      password = p; retry = true;
    }
  }
  const rows: Row[] = [];
  let offset = 0;
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = (tc.items as any[]).filter((i) => i.str && i.str.trim())
      .map((i) => ({ text: i.str.trim(), x: i.transform[4], w: i.width, y: offset + vp.height - i.transform[5] }))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    for (const it of items) {
      const row = rows.length && Math.abs(rows[rows.length - 1].y - it.y) <= 3 ? rows[rows.length - 1] : null;
      if (row) row.cells.push({ text: it.text, x: it.x, w: it.w });
      else rows.push({ y: it.y, cells: [{ text: it.text, x: it.x, w: it.w }] });
    }
    offset += vp.height;
  }
  for (const r of rows) {
    r.cells.sort((a, b) => a.x - b.x);
    // Glue fragments that touch (pdf.js sometimes splits one word or number into pieces).
    const merged: Cell[] = [];
    for (const c of r.cells) {
      const prev = merged[merged.length - 1];
      if (prev && c.x - (prev.x + prev.w) < 1.5) { prev.text += c.text; prev.w = c.x + c.w - prev.x; }
      else merged.push({ ...c });
    }
    r.cells = merged;
  }
  return rows;
}

/** Excel → rows (first sheet with data; all sheets if `allSheets`). Cells get x = column index × 100. */
export async function excelRows(file: File, allSheets = false): Promise<Row[]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array', cellDates: true });
  const rows: Row[] = [];
  for (const name of wb.SheetNames) {
    const grid: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '', dateNF: 'dd/mm/yyyy' });
    if (!grid.some((r) => r.some((c) => String(c).trim()))) continue;
    for (const r of grid) {
      // Keep empty cells so columns stay aligned (an empty debit cell must not shift credit left).
      const cells = r.map((c, i) => ({ text: String(c ?? '').trim(), x: i * 100, w: 90 }));
      if (cells.some((c) => c.text)) rows.push({ y: rows.length, cells });
    }
    if (!allSheets) break;
  }
  return rows;
}

/** CSV / TSV / TXT → rows. Picks the delimiter that splits lines most consistently; plain text splits on 2+ spaces. */
export function textRows(text: string): Row[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const score = (d: string) => lines.filter((l) => l.includes(d)).length;
  const delim = ['\t', ',', ';', '|'].map((d) => [d, score(d)] as const).sort((a, b) => b[1] - a[1])[0];
  const useDelim = delim[1] >= Math.max(2, lines.filter((l) => l.trim()).length * 0.4) ? delim[0] : null;
  const rows: Row[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = useDelim ? splitDelimited(line, useDelim) : line.trim().split(/\s{2,}/);
    const cells = parts.map((t, i) => ({ text: t.trim(), x: i * 100, w: 90 }));
    rows.push({ y: rows.length, cells: useDelim ? cells : cells.filter((c) => c.text) });
  }
  return rows;
}

function splitDelimited(line: string, d: string): string[] {
  const out: string[] = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === d && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Any supported file → rows. */
export async function readRows(file: File, opts: { askPassword?: (retry: boolean) => Promise<string | null>; allSheets?: boolean } = {}): Promise<Row[]> {
  const k = kindOf(file);
  if (k === 'pdf') return pdfRows(file, opts.askPassword);
  if (k === 'excel') return excelRows(file, opts.allSheets);
  if (k === 'image') throw new Error(`${file.name} is an image. Use a PDF, Excel, CSV or TXT file here.`);
  return textRows(await file.text());
}

/** Rows → tab-separated text (for parsers that work on text). Cells far apart in a PDF row stay separate columns. */
export function rowsToText(rows: Row[]) {
  return rows.map((r) => r.cells.map((c) => c.text).join('\t')).join('\n');
}

/** Rows → a grid of strings (CSV-like). */
export const rowsToGrid = (rows: Row[]) => rows.map((r) => r.cells.map((c) => c.text));

/**
 * A PDF table → a grid aligned to its header row: each value goes to the header column nearest to
 * it, so empty cells (a missing debit or credit) don't shift the columns. Lines without a value in
 * the first column (wrapped descriptions) are joined onto the row above.
 */
export function pdfTableGrid(rows: Row[], isHeader: (cells: string[]) => boolean): string[][] {
  const hi = rows.findIndex((r) => isHeader(r.cells.map((c) => c.text)));
  if (hi < 0) return rowsToGrid(rows);
  const head = rows[hi].cells;
  const centers = head.map((c) => c.x + c.w / 2);
  const grid: string[][] = [head.map((c) => c.text)];
  let last: string[] | null = null;
  for (const r of rows.slice(hi + 1)) {
    if (isHeader(r.cells.map((c) => c.text))) continue;            // repeated header on later pages
    const out = head.map(() => '');
    for (const c of r.cells) {
      const mid = c.x + c.w / 2;
      let best = 0;
      for (let i = 1; i < centers.length; i++) if (Math.abs(centers[i] - mid) < Math.abs(centers[best] - mid)) best = i;
      // Left-aligned text columns: prefer the column whose start the cell sits after.
      const starts = head.map((h) => h.x);
      const leftCol = starts.reduce((acc, sx, i) => (c.x >= sx - 4 ? i : acc), 0);
      const col = /^[-+]?[\d,]+(\.\d+)?(\s*(cr|dr))?$/i.test(c.text) ? best : leftCol;
      out[col] = out[col] ? `${out[col]} ${c.text}` : c.text;
    }
    if (!out[0] && last && out.some(Boolean)) {
      out.forEach((v, i) => { if (v && !/^[-+]?[\d,]+(\.\d+)?$/.test(v)) last![i] = `${last![i]} ${v}`.trim(); });
      continue;
    }
    grid.push(out);
    last = out;
  }
  return grid;
}

/** A modal-free password prompt (the browser's), used for locked bank-statement PDFs. */
export const promptPassword = async (retry: boolean) =>
  window.prompt(retry ? 'That password didn’t work. Try again (often your customer ID, date of birth or PAN, as the bank told you):' : 'This PDF is password-protected. Enter its password (it stays on this device):');

/** Any mix of files → plain text each: images are read with on-device OCR, everything else with readRows. */
export async function filesToTexts(files: File[], onProgress?: (p: number, label: string) => void): Promise<string[]> {
  const images = files.filter((f) => kindOf(f) === 'image');
  const out = new Map<File, string>();
  if (images.length) {
    const { ocrImages } = await import('./receipt');
    (await ocrImages(images, onProgress)).forEach((t, i) => out.set(images[i], t));
  }
  for (const f of files) if (!out.has(f)) out.set(f, rowsToText(await readRows(f, { askPassword: promptPassword, allSheets: true })).replace(/\t/g, '  '));
  return files.map((f) => out.get(f) ?? '');
}
