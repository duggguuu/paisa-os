/**
 * Current FD interest rates by bank, for suggesting a rate when adding an FD and for comparing banks.
 *
 * Rates come from Paisabazaar's public comparison page (regular depositors; highest slab, 1-, 3- and
 * 5-year tenures). The server fetches it at most twice a day and keeps the result in memory; if the
 * fetch fails or the page layout changes, the bundled copy below is used. Nothing about the user is
 * sent: it's a plain GET of a public page.
 */

export type BankRate = { bank: string; highest: number; y1: number; y3: number; y5: number; y2?: number };
export type RateTable = { asOf: string; source: string; sourceUrl: string; live: boolean; banks: BankRate[] };

export const SOURCE_URL = 'https://www.paisabazaar.com/fixed-deposit/';

/** Bundled fallback: Paisabazaar, rates as of 11 November 2026. */
export const BUNDLED: RateTable = {
  asOf: '2026-11-11', source: 'Paisabazaar', sourceUrl: SOURCE_URL, live: false,
  banks: [
    ['State Bank of India', 6.45, 6.25, 6.30, 6.05], ['HDFC Bank', 6.60, 6.25, 6.55, 6.60], ['ICICI Bank', 6.60, 6.25, 6.55, 6.60],
    ['Axis Bank', 6.60, 6.25, 6.60, 6.60], ['Kotak Mahindra Bank', 6.80, 6.45, 6.40, 6.25], ['IDFC FIRST Bank', 7.25, 6.50, 7.10, 6.75],
    ['Yes Bank', 7.25, 6.65, 7.00, 6.75], ['IndusInd Bank', 7.25, 6.75, 7.25, 6.65], ['Federal Bank', 6.80, 6.25, 6.50, 6.40],
    ['RBL Bank', 7.00, 6.90, 7.00, 6.70], ['Bandhan Bank', 7.45, 7.00, 7.25, 5.85], ['DCB Bank', 7.75, 6.90, 7.00, 7.50],
    ['IDBI Bank', 6.55, 6.20, 6.35, 6.25], ['Bank of Baroda', 6.75, 6.25, 6.25, 6.30], ['Punjab National Bank', 6.80, 6.25, 6.30, 6.35],
    ['Canara Bank', 6.75, 6.40, 6.25, 6.25], ['Union Bank of India', 6.55, 6.20, 6.10, 6.00], ['Bank of India', 6.85, 6.60, 6.70, 6.00],
    ['Indian Bank', 6.80, 6.10, 6.05, 6.00], ['Central Bank of India', 7.00, 6.10, 6.00, 6.00], ['Indian Overseas Bank', 6.60, 6.50, 6.10, 6.10],
    ['Bank of Maharashtra', 6.65, 6.40, 5.25, 5.00], ['UCO Bank', 6.60, 6.10, 6.00, 6.00], ['Punjab & Sind Bank', 6.90, 5.85, 5.85, 5.95],
    ['AU Small Finance Bank', 7.40, 6.35, 7.40, 6.75], ['Equitas Small Finance Bank', 8.00, 7.10, 7.10, 7.00],
    ['Ujjivan Small Finance Bank', 8.10, 7.25, 7.25, 7.20], ['Suryoday Small Finance Bank', 8.25, 7.25, 7.25, 8.25],
    ['Jana Small Finance Bank', 8.00, 7.00, 8.00, 7.77], ['Utkarsh Small Finance Bank', 8.10, 6.00, 7.50, 7.00],
    ['Unity Small Finance Bank', 7.50, 7.50, 6.75, 6.75], ['SBM Bank', 7.65, 7.50, 7.10, 7.00],
    ['Standard Chartered Bank', 6.60, 6.60, 6.50, 6.25], ['HSBC Bank', 6.40, 4.00, 5.35, 5.50], ['DBS Bank', 6.50, 6.25, 6.50, 6.25],
    ['Karur Vysya Bank', 6.70, 6.25, 6.40, 6.25], ['South Indian Bank', 6.80, 6.25, 6.20, 5.70], ['City Union Bank', 7.30, 6.65, 7.30, 6.55],
  ].map(([bank, highest, y1, y3, y5]): BankRate => ({ bank: bank as string, highest: highest as number, y1: y1 as number, y3: y3 as number, y5: y5 as number }))
    .concat([{ bank: 'Post Office', highest: 7.5, y1: 6.9, y2: 7.0, y3: 7.1, y5: 7.5 }]),
};

const MONTHS: Record<string, string> = { january: '01', february: '02', march: '03', april: '04', may: '05', june: '06', july: '07', august: '08', september: '09', october: '10', november: '11', december: '12' };

/** Pull the bank tables out of the comparison page. Returns null if it doesn't look right. */
export function parseRates(html: string): RateTable | null {
  const clean = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const seen = new Map<string, BankRate>();
  for (const row of html.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = (row.match(/<td[\s\S]*?<\/td>/gi) ?? []).map(clean);
    if (cells.length < 5) continue;
    const nums = cells.slice(1, 5).map((c) => (/^\d{1,2}(\.\d{1,2})?$/.test(c) ? Number(c) : NaN));
    if (nums.some((n) => !Number.isFinite(n) || n <= 0 || n > 15)) continue;
    const bank = cells[0].replace(/^Induslnd/, 'IndusInd').replace(/\s+Limited$/i, '');
    if (!bank || bank.length > 60 || seen.has(bank.toLowerCase())) continue;
    const [highest, y1, y3, y5] = nums;
    seen.set(bank.toLowerCase(), { bank, highest, y1, y3, y5 });
  }
  if (seen.size < 15) return null; // layout changed: don't trust a partial read
  const m = html.match(/rates as of\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);
  const asOf = m && MONTHS[m[2].toLowerCase()] ? `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}` : new Date().toISOString().slice(0, 10);
  const po = BUNDLED.banks.find((b) => b.bank === 'Post Office')!;
  return { asOf, source: 'Paisabazaar', sourceUrl: SOURCE_URL, live: true, banks: [...seen.values(), po] };
}

let cache: { at: number; table: RateTable } | null = null;
const TTL = 12 * 3600_000;

export async function getRates(fetchImpl: typeof fetch = fetch): Promise<RateTable> {
  if (cache && Date.now() - cache.at < TTL) return cache.table;
  let table: RateTable = BUNDLED;
  try {
    const res = await fetchImpl(SOURCE_URL, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; PaisaOS/1.0)', accept: 'text/html' }, signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const parsed = parseRates(await res.text());
      if (parsed && parsed.asOf >= BUNDLED.asOf) table = parsed;
    }
  } catch { /* offline or blocked: use the bundled copy */ }
  // A failed fetch is retried after an hour rather than twelve.
  cache = { at: table.live ? Date.now() : Date.now() - TTL + 3600_000, table };
  return table;
}

export function _resetRateCache() { cache = null; }
