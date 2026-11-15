/**
 * Receipt scanning, entirely on the device: the photo is read with Tesseract (OCR running in
 * the browser via WebAssembly) and never uploaded. The OCR engine and English language data
 * (~5 MB) download from a CDN the first time and are cached by the browser.
 */
export interface ReceiptGuess { amount: string | null; date: string | null; merchant: string | null; text: string }

/**
 * Shrink, grey-scale and boost contrast. Dark screenshots (white text on black, like the H&M
 * app) are inverted first: Tesseract reads dark-on-light far more reliably.
 */
async function prepare(file: File): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const dark = sum / (d.length / 4) < 110;
  let lo = 255, hi = 0;
  for (let i = 0; i < d.length; i += 4) {
    let y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (dark) y = 255 - y;
    d[i] = d[i + 1] = d[i + 2] = y;
    if (y < lo) lo = y; if (y > hi) hi = y;
  }
  const span = Math.max(hi - lo, 1);
  for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = ((d[i] - lo) * 255) / span;
  g.putImageData(img, 0, 0);
  return c;
}

/** OCR one or more images with a single worker. Returns each image's text in order. */
export async function ocrImages(files: File[], onProgress?: (p: number, label: string) => void): Promise<string[]> {
  onProgress?.(0.05, 'Loading reader (first time only)…');
  const { createWorker } = await import('tesseract.js');
  let idx = 0;
  // Everything is served by this app (copied from node_modules at build time): no CDN, so a
  // compromised third party can't run code here, and the strict CSP stays intact.
  const worker = await createWorker('eng', 1, {
    workerPath: '/ocr/worker.min.js', corePath: '/ocr', langPath: '/ocr', workerBlobURL: false,
    logger: (m: any) => { if (m.status === 'recognizing text') onProgress?.(0.15 + ((idx + m.progress) / files.length) * 0.8, `Reading ${files.length > 1 ? `screenshot ${idx + 1} of ${files.length}` : 'image'}…`); },
  });
  try {
    const out: string[] = [];
    for (idx = 0; idx < files.length; idx++) out.push((await worker.recognize(await prepare(files[idx]))).data.text);
    onProgress?.(1, 'Done');
    return out;
  } finally { await worker.terminate(); }
}

export async function scanReceipt(file: File, onProgress?: (p: number, label: string) => void): Promise<ReceiptGuess> {
  // Photos are OCR'd on the device; PDF / Excel / CSV / TXT bills are read directly.
  const { filesToTexts } = await import('./files');
  const [text] = await filesToTexts([file], onProgress);
  return { ...parseReceipt(text), text };
}

const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const NUM = /(?:₹|rs\.?|inr)?\s*(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+\.\d{1,2}|\d+)/gi;

export function parseReceipt(text: string, today = new Date().toISOString().slice(0, 10)): Omit<ReceiptGuess, 'text'> {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // Amount: prefer "grand total / net payable / amount due" lines, then "total", then the largest money-looking number.
  const ranked: [RegExp, number][] = [
    [/(grand\s*total|net\s*payable|amount\s*payable|net\s*amount|total\s*amount|amount\s*due|bill\s*amount|to\s*pay|total\s*payable|net\s*total)/i, 3],
    [/\btotal\b/i, 2],
  ];
  let best: { v: number; score: number } | null = null;
  for (const l of lines) {
    if (/(sub\s*-?\s*total|total\s*(qty|items?|quantity|savings?|discount)|tax|gst|cgst|sgst|change|tender|round)/i.test(l)) continue;
    for (const [re, score] of ranked) {
      if (!re.test(l)) continue;
      const nums = [...l.matchAll(NUM)].map((m) => Number(m[1].replace(/,/g, ''))).filter((n) => n > 0 && n < 1e7);
      if (!nums.length) continue;
      const v = nums[nums.length - 1];
      if (!best || score > best.score || (score === best.score && v >= best.v)) best = { v, score };
      break;
    }
  }
  if (!best) {
    const all = lines.flatMap((l) => [...l.matchAll(/(\d{1,3}(?:,\d{2,3})*\.\d{2})\b/g)].map((m) => Number(m[1].replace(/,/g, ''))));
    if (all.length) best = { v: Math.max(...all), score: 0 };
  }
  const amount = best ? (Number.isInteger(best.v) ? String(best.v) : best.v.toFixed(2)) : null;

  // Date (Indian receipts: day first). Ignore future dates.
  let date: string | null = null;
  for (const l of lines) {
    const m = l.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/) ?? null;
    const n = l.match(/\b(\d{1,2})[\s\-]?([a-z]{3})[a-z]*[\s\-,']*(\d{2,4})\b/i);
    let y = 0, mo = 0, d = 0;
    if (m) { d = +m[1]; mo = +m[2]; y = +m[3]; }
    else if (n && MON.includes(n[2].toLowerCase())) { d = +n[1]; mo = MON.indexOf(n[2].toLowerCase()) + 1; y = +n[3]; }
    else continue;
    if (y < 100) y += 2000;
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2015) continue;
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (iso <= today) { date = iso; break; }
  }

  // Merchant: the first real name near the top.
  const merchantLine = lines.slice(0, 6).find((l) =>
    /[a-z]{3,}/i.test(l) && !/(tax\s*invoice|invoice|receipt|bill\s*(no|of)|gstin|gst\s*no|welcome|cash\s*memo|original|duplicate|phone|ph\.|tel|mob|www\.|@|date|time|table|order)/i.test(l)
    && (l.match(/[a-z]/gi) ?? []).length >= l.replace(/\s/g, '').length * 0.6);
  const merchant = merchantLine
    ? merchantLine.replace(/[^a-z0-9&' ]/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 40)
    : null;
  return { amount, date, merchant };
}
