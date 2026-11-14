/**
 * Receipt scanning, entirely on the device: the photo is read with Tesseract (OCR running in
 * the browser via WebAssembly) and never uploaded. The OCR engine and English language data
 * (~5 MB) download from a CDN the first time and are cached by the browser.
 */
export interface ReceiptGuess { amount: string | null; date: string | null; merchant: string | null; text: string }

/** Shrink and grey-scale the photo: faster OCR, usually better accuracy. */
async function prepare(file: File): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  const g = c.getContext('2d')!;
  g.filter = 'grayscale(1) contrast(1.35)';
  g.drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}

export async function scanReceipt(file: File, onProgress?: (p: number, label: string) => void): Promise<ReceiptGuess> {
  onProgress?.(0.05, 'Preparing photo…');
  const img = await prepare(file);
  onProgress?.(0.15, 'Loading reader (first time only)…');
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng', 1, {
    logger: (m: any) => { if (m.status === 'recognizing text') onProgress?.(0.3 + m.progress * 0.65, 'Reading receipt…'); },
  });
  try {
    const { data } = await worker.recognize(img);
    onProgress?.(1, 'Done');
    return { ...parseReceipt(data.text), text: data.text };
  } finally {
    await worker.terminate();
  }
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
