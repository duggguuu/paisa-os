/**
 * CAS (Consolidated Account Statement) reader for mutual funds, entirely in the browser.
 * The PDF is password-protected (usually your PAN in capitals, or the password you chose when
 * requesting it); it's unlocked here with pdf.js and only the extracted holdings are sent.
 * Supports the detailed CAS from CAMS / KFintech / MF Central.
 */
export interface CasHolding { isin: string; name: string; folio: string | null; units: number; nav: number; value: number; cost: number | null }
export interface CasResult { statementDate: string | null; holdings: CasHolding[]; investor: string | null }

export async function readCasPdf(file: File, password: string): Promise<CasResult> {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), password }).promise;
  } catch (e: any) {
    if (e?.name === 'PasswordException') throw new Error(password ? 'That password didn’t open the PDF. CAS passwords are usually your PAN in capitals, or the one you set when requesting it.' : 'This PDF needs its password.');
    throw new Error('Couldn’t read this PDF. Is it a CAS from CAMS, KFintech or MF Central?');
  }
  const lines: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const rows = new Map<number, { x: number; s: string }[]>();
    for (const it of content.items as any[]) {
      if (!it.str?.trim()) continue;
      const y = Math.round(it.transform[5] / 2) * 2;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y)!.push({ x: it.transform[4], s: it.str });
    }
    [...rows.entries()].sort((a, b) => b[0] - a[0]).forEach(([, items]) => lines.push(items.sort((a, b) => a.x - b.x).map((i) => i.s).join(' ').replace(/\s+/g, ' ').trim()));
  }
  return parseCasText(lines.join('\n'));
}

const num = (s: string | undefined) => (s ? Number(s.replace(/,/g, '')) : NaN);
const MON: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
const isoDate = (d: string) => { const m = d.match(/(\d{2})-([A-Za-z]{3})-(\d{4})/); return m ? `${m[3]}-${MON[m[2].toLowerCase()]}-${m[1]}` : null; };

export function parseCasText(text: string): CasResult {
  const t = text.replace(/ /g, ' ');
  const period = t.match(/(\d{2}-[A-Za-z]{3}-\d{4})\s*(?:to|-)\s*(\d{2}-[A-Za-z]{3}-\d{4})/i);
  let statementDate = period ? isoDate(period[2]) : null;
  const investor = (t.match(/Email Id:.*\n\s*([A-Z][A-Za-z .]+)\n/) ?? [])[1]?.trim() ?? null;

  // Detailed CAS: "<code>-<Scheme name> - ISIN: INF… (Advisor…)" … "Closing Unit Balance: 1,234.567 NAV on 31-Oct-2026: INR 56.78
  //                Total Cost Value: 60,000.00 Market Value on 31-Oct-2026: INR 70,123.45"
  const heads = [...t.matchAll(/(?:^|\n)\s*(?:[A-Z0-9]{2,8}\s*-\s*)?([^\n]*?)\s*-?\s*ISIN\s*:\s*(IN[A-Z0-9]{10})/g)];
  const byIsin = new Map<string, CasHolding>();
  heads.forEach((h, i) => {
    const start = h.index! + h[0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index! : t.length;
    const block = t.slice(start, end);
    const units = num(block.match(/Closing\s*Unit\s*Balance\s*:?\s*([\d,]+\.?\d*)/i)?.[1]);
    if (!isFinite(units)) return;
    const navM = block.match(/NAV\s*on\s*(\d{2}-[A-Za-z]{3}-\d{4})\s*:?\s*(?:INR|Rs\.?|₹)?\s*([\d,]+\.?\d*)/i);
    const valM = block.match(/(?:Market|Valuation)\s*Value\s*on\s*(\d{2}-[A-Za-z]{3}-\d{4})\s*:?\s*(?:INR|Rs\.?|₹)?\s*([\d,]+\.?\d*)/i);
    const cost = num(block.match(/Total\s*Cost\s*Value\s*:?\s*([\d,]+\.?\d*)/i)?.[1]);
    const nav = num(navM?.[2]);
    const value = isFinite(num(valM?.[2])) ? num(valM?.[2]) : units * (isFinite(nav) ? nav : 0);
    if (!statementDate && valM) statementDate = isoDate(valM[1]);
    const folio = [...t.slice(Math.max(0, h.index! - 400), h.index!).matchAll(/Folio\s*No\s*:?\s*([\w\/ ]+?)(?:\s{2,}|\s+PAN|\s+KYC|\n|$)/gi)].pop()?.[1].trim() ?? null;
    const name = h[1].replace(/^[A-Z0-9]{2,8}\s*-\s*/, '').replace(/\s*\(.*$/, '').replace(/\s*-\s*$/, '').trim() || h[2];
    const prev = byIsin.get(h[2]);
    if (prev) {
      prev.units += units; prev.value += value; prev.cost = (prev.cost ?? 0) + (isFinite(cost) ? cost : 0);
    } else {
      byIsin.set(h[2], { isin: h[2], name: name.slice(0, 200), folio, units, nav: isFinite(nav) ? nav : 0, value, cost: isFinite(cost) ? cost : null });
    }
  });

  // Summary CAS fallback: one line per scheme with an ISIN followed by units, NAV and value.
  if (!byIsin.size) {
    for (const l of t.split('\n')) {
      const m = l.match(/(IN[A-Z0-9]{10})\s+(.+?)\s+([\d,]+\.\d+)\s+([\d,]+\.\d+)\s+([\d,]+\.\d{2})\s*$/);
      if (!m) continue;
      byIsin.set(m[1], { isin: m[1], name: m[2].trim().slice(0, 200), folio: null, units: num(m[3]), nav: num(m[4]), value: num(m[5]), cost: null });
    }
  }
  const holdings = [...byIsin.values()].filter((h) => h.units > 0.0005).map((h) => ({ ...h, value: Math.round(h.value * 100) / 100 }));
  return { statementDate, holdings, investor };
}
