/**
 * Voice / natural-language entry.
 *
 * Turns a sentence like "spent 450 on Swiggy from ICICI card yesterday" into a draft
 * transaction. Parsing is local and deterministic (no AI service): the result only
 * pre-fills the Add sheet, and nothing is saved until you tap Save.
 */
import { addDays, todayIST } from './lib';

export interface Draft {
  kind?: 'expense' | 'income' | 'transfer';
  amount?: string;          // rupees, as typed into the amount field
  merchant?: string;
  categoryId?: string;
  accountId?: string;
  toAccountId?: string;
  date?: string;            // YYYY-MM-DD
  splitWith?: string[];
}

interface Acc { id: string; name: string; kind: string; class?: string; is_archived?: boolean }
interface Cat { id: string; name: string; class: string; parent_id: string | null }

// ---------- numbers ----------
const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, k: 1000, lakh: 100000, lakhs: 100000, lac: 100000, crore: 10000000 };

/** "two thousand five hundred" → "2500". Leaves everything else untouched. */
function wordsToDigits(s: string): string {
  return s.replace(/\b((?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|lakhs?|lac|crore|and|\s|-)+)\b/g, (m) => {
    const words = m.trim().split(/[\s-]+/).filter((w) => w && w !== 'and');
    if (!words.some((w) => w in UNITS)) return m;
    let total = 0, cur = 0;
    for (const w of words) {
      if (w in UNITS) cur += UNITS[w];
      else if (w === 'hundred') cur = (cur || 1) * 100;
      else if (w in SCALES) { total += (cur || 1) * SCALES[w]; cur = 0; }
    }
    return ` ${total + cur} `;
  });
}

function extractAmount(s: string): { amount?: string; rest: string } {
  const re = /(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(k|thousand|lakhs?|lac|crore)?\b\s*(?:rupees?|rs\.?|bucks)?/i;
  const m = s.match(re);
  if (!m) return { rest: s };
  let n = Number(m[1].replace(/,/g, ''));
  const unit = m[2]?.toLowerCase();
  if (unit) n *= SCALES[unit] ?? 1;
  if (!isFinite(n) || n <= 0) return { rest: s };
  const amount = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return { amount, rest: s.replace(m[0], ' ') };
}

// ---------- dates ----------
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function extractDate(s: string, today = todayIST()): { date?: string; rest: string } {
  const take = (re: RegExp, date: string) => ({ date, rest: s.replace(re, ' ') });
  if (/\bday before yesterday\b/.test(s)) return take(/\bday before yesterday\b/, addDays(today, -2));
  if (/\byesterday\b/.test(s)) return take(/\byesterday\b/, addDays(today, -1));
  if (/\btoday\b/.test(s)) return take(/\btoday\b/, today);
  const ago = s.match(/\b(\d+)\s+days?\s+ago\b/);
  if (ago) return take(/\b\d+\s+days?\s+ago\b/, addDays(today, -Number(ago[1])));
  const wd = s.match(new RegExp(`\\b(?:on\\s+|last\\s+)?(${WEEKDAYS.join('|')})\\b`));
  if (wd) {
    const [y, m, d] = today.split('-').map(Number);
    const todayDow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    let back = (todayDow - WEEKDAYS.indexOf(wd[1]) + 7) % 7;
    if (back === 0) back = 7; // "monday" said on a Monday means last week's
    return take(new RegExp(wd[0].replace(/\s+/g, '\\s+')), addDays(today, -back));
  }
  // "12th", "on the 12th", "12 november", "november 12"
  const mon = `(${MONTHS.join('|')}|${MONTHS.map((x) => x.slice(0, 3)).join('|')})`;
  const dm = s.match(new RegExp(`\\b(?:on\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(?:of\\s+)?${mon})?\\b(?!\\s*(?:k|thousand|rupees|rs))`))
    ?? s.match(new RegExp(`\\b(?:on\\s+)?${mon}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`));
  if (dm && /(st|nd|rd|th)\b|\b(on|the)\s|[a-z]{3}/i.test(dm[0])) {
    const day = Number(/^\d/.test(dm[1]) ? dm[1] : dm[2]);
    const monName = /^\d/.test(dm[1]) ? dm[2] : dm[1];
    if (day >= 1 && day <= 31) {
      const [y, m] = today.split('-').map(Number);
      let month = monName ? MONTHS.findIndex((x) => x.startsWith(monName.slice(0, 3))) + 1 : m;
      let year = y;
      let iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (iso > today) { // a date in the future most likely means last month / last year
        if (monName) year -= 1; else { month -= 1; if (month === 0) { month = 12; year -= 1; } }
        iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
      return take(new RegExp(dm[0].replace(/\s+/g, '\\s+')), iso);
    }
  }
  return { rest: s };
}

// ---------- accounts, categories, people ----------
const GENERIC = new Set(['bank', 'account', 'card', 'credit', 'debit', 'wallet', 'savings', 'salary', 'the', 'my', 'of', 'a']);
const norm = (s: string) => s.toLowerCase().replace(/(\d),(?=\d)/g, '$1').replace(/[^a-z0-9₹. ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Every account mentioned, in the order spoken. "ICICI card" prefers the card over ICICI Bank. */
function findAccounts(s: string, accounts: Acc[]): { ids: string[]; rest: string } {
  const hits: { id: string; at: number; len: number; score: number }[] = [];
  for (const a of accounts) {
    const name = norm(a.name);
    const distinct = name.split(' ').filter((w) => !GENERIC.has(w) && w.length > 1);
    let at = s.indexOf(name), len = name.length, score = 3;
    if (at < 0 && distinct.length) {
      const w = distinct.find((d) => new RegExp(`\\b${d}\\b`).test(s));
      if (w) { at = s.search(new RegExp(`\\b${w}\\b`)); len = w.length; score = 1; }
    }
    if (at < 0 && a.kind === 'cash' && /\bcash\b/.test(s)) { at = s.indexOf('cash'); len = 4; score = 2; }
    if (at < 0) continue;
    // Disambiguate same-bank accounts by what follows the name.
    const after = s.slice(at + len, at + len + 14);
    if (a.kind === 'credit_card' && /^\s*(credit\s+)?card/.test(after)) { score += 2; len += after.match(/^\s*(credit\s+)?card/)![0].length; }
    if (a.kind === 'bank' && /^\s*(bank|account|debit|upi)/.test(after)) { score += 2; len += after.match(/^\s*(bank|account|debit\s+card|debit|upi)/)![0].length; }
    if (a.kind === 'bank' && /^\s*(credit\s+)?card/.test(after)) score -= 1;
    hits.push({ id: a.id, at, len, score });
  }
  // One account per position: keep the best-scoring hit where several overlap.
  hits.sort((x, y) => x.at - y.at || y.score - x.score);
  const chosen: typeof hits = [];
  for (const h of hits) {
    const clash = chosen.find((c) => h.at < c.at + c.len && c.at < h.at + h.len);
    if (!clash) chosen.push(h);
    else if (h.score > clash.score) chosen.splice(chosen.indexOf(clash), 1, h);
  }
  let rest = s;
  for (const h of [...chosen].sort((x, y) => y.at - x.at)) rest = rest.slice(0, h.at) + ' ' + rest.slice(h.at + h.len);
  return { ids: chosen.sort((x, y) => x.at - y.at).map((h) => h.id), rest };
}

/** Everyday words → words that appear in category names. */
const CATEGORY_HINTS: [RegExp, string[]][] = [
  // Coffee has its own category ("parent/child" needles match a subcategory under that parent).
  [/\b(coffee|espresso|aeropress|moka|v60|dripper|french press)\b.*\b(grinder|machine|kettle|scale|dripper|equipment|gear)\b|\b(grinder|espresso machine|aeropress|moka pot|v60|dripper|french press)\b/, ['coffee/equipment']],
  [/\b(coffee beans?|beans|ground coffee|roast(ers?|ery)?)\b/, ['coffee/beans']],
  [/\b(coffee|cappuccino|latte|espresso|americano|cold brew|mocha|starbucks|third wave|blue tokai|subko|barista|ccd|costa)\b/, ['coffee/orders']],
  [/\b(swiggy|zomato|delivery|ordered|takeout)\b/, ['delivery', 'dining', 'food']],
  [/\b(lunch|dinner|breakfast|restaurant|cafe|dining|biryani|pizza|burger)\b/, ['dining', 'eating out', 'restaurant', 'food']],
  [/\b(tea|chai|snacks?)\b/, ['snack', 'dining', 'food']],
  [/\b(groceries|grocery|vegetables|sabzi|milk|blinkit|zepto|bigbasket|instamart|dmart|kirana)\b/, ['grocer', 'food']],
  [/\b(uber|ola|rapido|cab|taxi|auto|rickshaw)\b/, ['cab', 'auto', 'transport']],
  [/\b(metro|bus|train|irctc|local)\b/, ['public', 'metro', 'transport']],
  [/\b(petrol|diesel|fuel|cng)\b/, ['fuel', 'petrol', 'transport']],
  [/\b(flight|indigo|hotel|trip|travel|airbnb)\b/, ['travel', 'flight', 'trip']],
  [/\b(movie|movies|bookmyshow|concert|netflix|spotify|prime|hotstar)\b/, ['movie', 'event', 'subscription', 'entertainment']],
  [/\b(rent|landlord|maintenance)\b/, ['rent', 'housing']],
  [/\b(electricity|power|water|gas|wifi|internet|broadband|recharge|jio|airtel|bill)\b/, ['bill', 'utilit', 'recharge', 'internet']],
  [/\b(medicine|pharmacy|doctor|hospital|clinic|apollo|medplus|1mg|pharmeasy)\b/, ['medic', 'pharma', 'doctor', 'health']],
  [/\b(gym|cult|fitness)\b/, ['gym', 'fitness', 'health']],
  [/\b(amazon|flipkart|myntra|ajio|clothes|shoes|shirt|apparel|shopping)\b/, ['apparel', 'cloth', 'shopping']],
  [/\b(haircut|salon|barber|spa|grooming)\b/, ['personal', 'groom', 'salon']],
  [/\b(gift|present)\b/, ['gift']],
  [/\b(salary|payroll)\b/, ['salary']],
  [/\b(interest)\b/, ['interest']],
  [/\b(dividend)\b/, ['dividend']],
  [/\b(refund|cashback)\b/, ['refund', 'cashback']],
  [/\b(bonus)\b/, ['bonus', 'salary']],
  [/\b(freelance|client|invoice)\b/, ['freelance', 'business', 'other income']],
];

function findCategory(s: string, cats: Cat[], kind: 'expense' | 'income'): string | undefined {
  const pool = cats.filter((c) => c.class === kind && !cats.some((x) => x.parent_id === c.id)); // leaf categories
  // 1. A category named outright ("groceries", "dining out").
  const direct = [...pool].sort((a, b) => b.name.length - a.name.length)
    .find((c) => new RegExp(`\\b${norm(c.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(s));
  if (direct) return direct.id;
  // 2. A hint word that maps onto a category name.
  for (const [re, needles] of CATEGORY_HINTS) {
    if (!re.test(s)) continue;
    for (const n of needles) {
      const [parent, child] = n.includes('/') ? n.split('/') : [null, n];
      const c = pool.find((c) => norm(c.name).includes(child)
        && (!parent || norm(cats.find((x) => x.id === c.parent_id)?.name ?? '').includes(parent)));
      if (c) return c.id;
    }
  }
  return undefined;
}

function findPeople(s: string, people: Acc[]): { ids: string[]; rest: string } {
  const m = s.match(/\b(?:split|shared|share)\s+(?:it\s+)?(?:equally\s+)?with\s+(.+)$/);
  if (!m) return { ids: [], rest: s };
  const ids = people.filter((p) => norm(p.name).split(' ').some((w) => w.length > 1 && new RegExp(`\\b${w}\\b`).test(m[1]))).map((p) => p.id);
  return { ids, rest: s.replace(m[0], ' ') };
}

// ---------- main ----------
const FILLER = /\b(i|i've|ive|have|has|just|spent|spend|paid|pay|paying|bought|buy|got|get|received|receive|earned|credited|debited|for|on|at|in|to|from|via|using|with|by|through|my|the|a|an|of|rupees?|rs|inr|bucks|and|it|was|this|that|some|add|expense|income|transaction|transfer|transferred|moved?|sent|send|today|please)\b/g;

export function parseSpoken(input: string, ctx: { accounts: Acc[]; categories: Cat[]; today?: string }): Draft {
  const draft: Draft = {};
  let s = ' ' + wordsToDigits(norm(input)) + ' ';

  // Kind
  if (/\b(transfer(red)?|move[d]?|moving)\b/.test(s) || /\b(paid|pay)\b.*\b(card bill|credit card bill)\b/.test(s)) draft.kind = 'transfer';
  else if (/\b(got|received|receive|earned|credited|salary|income|refund|cashback|dividend|interest|bonus)\b/.test(s) && !/\b(spent|paid|bought)\b/.test(s)) draft.kind = 'income';
  else draft.kind = 'expense';

  const a = extractAmount(s); draft.amount = a.amount; s = a.rest;
  const d = extractDate(s, ctx.today); draft.date = d.date; s = d.rest;

  const live = ctx.accounts.filter((x) => !x.is_archived);
  const people = live.filter((x) => x.kind === 'receivable');
  if (draft.kind === 'expense') {
    const p = findPeople(s, people); if (p.ids.length) draft.splitWith = p.ids; s = p.rest;
  }
  const pool = draft.kind === 'transfer'
    ? live.filter((x) => x.class === 'asset' || x.class === 'liability')
    : live.filter((x) => ['bank', 'cash', 'wallet', 'credit_card'].includes(x.kind));
  const f = findAccounts(s, pool); s = f.rest;
  if (draft.kind === 'transfer') {
    // "from X to Y" in either order of mention; default: first = from, second = to.
    [draft.accountId, draft.toAccountId] = f.ids;
  } else if (f.ids[0]) draft.accountId = f.ids[0];

  if (draft.kind !== 'transfer') draft.categoryId = findCategory(s, ctx.categories, draft.kind);

  // "at Third Wave" names the merchant outright; otherwise whatever is left is the description.
  const at = s.match(/\bat\s+([a-z0-9& ]+?)(?=\s+(?:on|from|using|via|with|for|in|by|through)\b|\s*$)/);
  const merchant = (at && at[1].replace(FILLER, ' ').trim() ? at[1] : s).replace(FILLER, ' ').replace(/[^a-z0-9& ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (draft.kind !== 'transfer' && merchant) draft.merchant = merchant.replace(/\b\w/g, (c) => c.toUpperCase());
  return draft;
}

// ---------- speech recognition (browser) ----------
export function speechSupported(): boolean {
  return typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
}

/** Listen once. Calls onText with interim and final text; resolves with the final transcript. */
export function listen(onText: (t: string) => void): { done: Promise<string>; stop: () => void } {
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  const rec = new SR();
  rec.lang = 'en-IN';
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let finalText = '';
  const done = new Promise<string>((resolve, reject) => {
    rec.onresult = (e: any) => {
      let text = '';
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      finalText = text;
      onText(text);
    };
    rec.onerror = (e: any) => reject(new Error(e.error === 'not-allowed' || e.error === 'service-not-allowed'
      ? 'Microphone or speech access is blocked. Allow it in your browser settings, or tap the text box and use the 🎤 on your keyboard.'
      : e.error === 'no-speech' ? "Didn't catch that. Try again." : `Voice isn't available here (${e.error}). Tap the text box and use the 🎤 on your keyboard instead.`));
    rec.onend = () => resolve(finalText);
  });
  rec.start();
  return { done, stop: () => { try { rec.stop(); } catch { /* already stopped */ } } };
}

/** Best-guess category for free text (a bank narration, a receipt), or undefined. */
export function guessCategory(text: string, categories: Cat[], kind: 'expense' | 'income'): string | undefined {
  return findCategory(' ' + norm(text) + ' ', categories, kind);
}
