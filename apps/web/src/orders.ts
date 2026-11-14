/**
 * Turning screenshots and sentences into purchases, sales and Splitwise balances.
 * Works on OCR text (Tesseract, on the phone), so it tolerates junk at line starts and
 * merges several overlapping screenshots of one order.
 */

export interface OrderItem {
  name: string; brand: string | null; listPrice: number | null; paid: number | null;
  artNo: string | null; quantity: number; colour: string | null; size: string | null; category: string | null;
}
export interface Order { store: string | null; items: OrderItem[]; total: number | null; subtotal: number | null; discount: number | null; payment: string | null }

const rs = (s: string) => Math.round(parseFloat(s.replace(/,/g, '')) * 100);
const MONEY = /(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/i;
const STORES = ['H&M', 'Zara', 'Uniqlo', 'Myntra', 'Amazon', 'Flipkart', 'Ajio', 'Nykaa', 'Decathlon', 'Snitch', 'Rare Rabbit', 'Westside', 'Max', 'Pantaloons', 'Bewakoof', 'Souled Store', 'Andamen', '5feet11', 'YUR', 'Croma', 'Reliance Digital', 'Apple'];

/** Category guess for an item name, matching the Stuff sheet's categories. */
export function itemCategory(name: string): string | null {
  const t = name.toLowerCase();
  if (/\b(jacket|bomber|coat|parka|puffer|shell)\b/.test(t)) return 'Clothes — outerwear';
  if (/\b(jeans|pants|trousers|chinos|cargo|shorts|joggers|track ?pants)\b/.test(t)) return 'Clothes — bottoms';
  if (/\b(shirt|overshirt|tee|t-shirt|top|henley|polo|sweater|sweatshirt|hoodie|turtleneck|cardigan|kurta|blazer)\b/.test(t)) return 'Clothes — tops';
  if (/\b(shoe|shoes|sneaker|sneakers|derby|loafer|boots?|sandals?|slides|trainers)\b/.test(t)) return 'Footwear';
  if (/\b(watch|casio|timex|seiko)\b/.test(t)) return 'Watch';
  if (/\b(headphones?|earbuds|iems?|speaker|airdopes|airpods|sennheiser|sony wh)\b/.test(t)) return 'Audio';
  if (/\b(iphone|ipad|macbook|laptop|monitor|charger|cable|keyboard|mouse|ssd|phone|playstation|ps5)\b/.test(t)) return 'Tech';
  if (/\b(coffee|grinder|kettle|dripper|moka|espresso|french press|aeropress)\b/.test(t)) return 'Coffee';
  if (/\b(perfume|fragrance|edp|edt|cologne|attar)\b/.test(t)) return 'Fragrance';
  if (/\b(lego)\b/.test(t)) return 'Collectibles';
  if (/\b(book|novel)\b/.test(t)) return 'Books';
  if (/\b(helmet|riding|gloves)\b/.test(t)) return 'Bike & riding';
  return null;
}

/** "ki 4 COTTON POPLIN SHIRT" → "COTTON POPLIN SHIRT": keep the trailing run of real capitalised words. */
function cleanName(line: string) {
  const m = line.match(/([A-Z][A-Z0-9&'\-\/.]*(?:\s+[A-Z0-9][A-Z0-9&'\-\/.]*)*)\s*$/);
  if (!m) return '';
  const toks = m[1].split(/\s+/);
  while (toks.length > 1 && toks[0].length <= 2 && !/^\d/.test(toks[0])) toks.shift();
  return toks.join(' ');
}
const title = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\bH&m\b/i, 'H&M');

export function parseOrderText(text: string): Order {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const items: OrderItem[] = [];
  let cur: (OrderItem & { mode: 'name' | 'details' | 'done' }) | null = null;
  let total: number | null = null, subtotal: number | null = null, discount: number | null = null, payment: string | null = null, store: string | null = null;
  const push = () => { if (cur && cur.name) items.push({ ...cur }); cur = null; };
  const brandOf = (l: string) => STORES.find((s) => new RegExp(`(^|\\W)${s.replace(/[&]/g, '\\&')}(\\W|$)`, 'i').test(l) && l.replace(/[^A-Za-z&]/g, '').length <= s.replace(/[^A-Za-z&]/g, '').length + 4);

  for (const l of lines) {
    if (/\bTOTAL\b\s*:?\s*(?:rs|₹|inr)/i.test(l) && !/Total\b/.test(l)) { const m = l.match(MONEY); if (m) total = rs(m[1]); continue; }
    if (/^(grand total|order total|amount paid|total paid|you paid|net amount)/i.test(l)) { const m = l.match(MONEY); if (m) total = rs(m[1]); continue; }
    if (/^Total\s*:/i.test(l) || /^(sub\s*-?total|item total|bag total|mrp total)/i.test(l)) { const m = l.match(MONEY); if (m) subtotal = rs(m[1]); continue; }
    if (/discount|savings|coupon/i.test(l)) { const m = l.match(MONEY); if (m) discount = rs(m[1]); continue; }
    const pay = l.match(/\b(UPI|Credit Card|Debit Card|Net ?Banking|Cash on Delivery|COD|Wallet|Amazon Pay|GPay|PhonePe|Paytm)\b/i);
    if (pay && l.length < 40 && !MONEY.test(l)) { payment = pay[1]; continue; }

    const brand = brandOf(l);
    if (brand) { push(); store = store ?? brand; cur = { name: '', brand, listPrice: null, paid: null, artNo: null, quantity: 1, colour: null, size: null, category: null, mode: 'name' }; continue; }
    if (!cur) continue;
    const c = cur as OrderItem & { mode: 'name' | 'details' | 'done' };

    const art = l.match(/Art\.?\s?no\.?\s*:?\s*(\d{8,14})/i); if (art) { c.artNo = art[1]; c.mode = 'details'; continue; }
    const qty = l.match(/\b(?:Quantity|Qty)\.?\s*:?\s*(\d{1,2})\b/i); if (qty) { c.quantity = Number(qty[1]); continue; }
    const col = l.match(/\bColou?r\s*:?\s*(.+)$/i); if (col) { c.colour = col[1].trim(); continue; }
    const size = l.match(/\bSize\s*:?\s*(\S.*)$/i); if (size) { c.size = size[1].trim(); continue; }
    const lineTotal = l.match(/\bTotal\s*(?:rs\.?|₹|inr)\s*([\d,]+(?:\.\d{1,2})?)/i);
    if (lineTotal) { c.paid = rs(lineTotal[1]); c.mode = 'done'; continue; }
    const price = l.match(MONEY);
    if (price && c.listPrice === null && c.mode !== 'done') { c.listPrice = rs(price[1]); c.mode = 'details'; continue; }
    if (c.mode === 'name') { const n = cleanName(l); if (n.length >= 3) c.name = c.name ? `${c.name} ${n}` : n; }
  }
  push();
  const ready = items.map((i) => ({ ...i, name: title(i.name), category: itemCategory(i.name) }));
  return { store, items: ready, total, subtotal, discount, payment };
}

/** Merge several screenshots of one order: same item (article no. or name+price) counted once. */
export function mergeOrders(orders: Order[]): Order {
  const items: OrderItem[] = [];
  for (const o of orders) for (const it of o.items) {
    const same = items.find((x) => (it.artNo && x.artNo === it.artNo) || (!it.artNo && x.name === it.name && x.listPrice === it.listPrice));
    if (!same) items.push({ ...it });
    else for (const k of Object.keys(it) as (keyof OrderItem)[]) if ((same as any)[k] == null && it[k] != null) (same as any)[k] = it[k];
  }
  const pick = <K extends keyof Order>(k: K) => orders.map((o) => o[k]).find((v) => v != null) ?? null;
  const merged: Order = { store: pick('store') as any, items, total: pick('total') as any, subtotal: pick('subtotal') as any, discount: pick('discount') as any, payment: pick('payment') as any };
  return fillPaid(merged);
}

/** Lines without a printed line-total get the rest of the order total (split by list price). */
export function fillPaid(o: Order): Order {
  const missing = o.items.filter((i) => i.paid == null);
  if (!missing.length) return o;
  const known = o.items.reduce((s, i) => s + (i.paid ?? 0), 0);
  if (o.total != null && o.total > known) {
    const rest = o.total - known;
    const weight = missing.reduce((s, i) => s + (i.listPrice ?? 1), 0);
    let left = rest;
    missing.forEach((i, k) => { const share = k === missing.length - 1 ? left : Math.round((rest * (i.listPrice ?? 1)) / weight); i.paid = share; left -= share; });
  } else {
    for (const i of missing) i.paid = i.listPrice;
  }
  return o;
}

// ---------- sentences: "bought …" / "sold …" ----------
export interface StuffSentence { kind: 'buy' | 'sell'; items: { name: string; amount: number | null }[]; total: number | null; store: string | null }

const AMOUNT = /(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(k|lakh|lakhs|l)?\b/i;
function amountOf(s: string) {
  // Prefer the price after "for/at/@" ("PlayStation 5 for 30k" is 30k, not 5); else the last number.
  const priced = s.match(/\b(?:for|at|@)\s*((?:₹|rs\.?|inr)?\s*\d[\d,]*(?:\.\d{1,2})?\s*(?:k|lakh|lakhs|l)?)\b/i);
  const all = [...s.matchAll(new RegExp(AMOUNT.source, 'gi'))];
  const m = priced ? priced[1].match(AMOUNT) : all[all.length - 1];
  if (!m) return null;
  const mult = !m[2] ? 1 : /^k$/i.test(m[2]) ? 1e3 : 1e5;
  return Math.round(parseFloat(m[1].replace(/,/g, '')) * mult * 100);
}

/** "bought an Anker charger for 2,499 and a cable for 499 from Amazon on HDFC card" / "sold my PS5 for 30k". */
export function parseStuffSentence(text: string): StuffSentence {
  const t = text.trim();
  const kind: 'buy' | 'sell' = /\b(sold|sell|selling)\b/i.test(t) ? 'sell' : 'buy';
  const storeM = t.match(/\b(?:from|at|on)\s+(H&M|[A-Z][\w&']+(?:\s+[A-Z][\w&']+)?)(?=\s|$|,)/);
  const store = storeM && !/\b(card|bank|upi|cash|wallet|axis|hdfc|icici|sbi|paytm)\b/i.test(storeM[1]) ? storeM[1] : null;
  const body = t.replace(/^(i\s+)?(just\s+)?(bought|purchased|got|ordered|sold|sell)\s+/i, '')
    .replace(/\b(?:from|via|using|on|with|into|to)\s+(?:my\s+)?(axis|hdfc|icici|sbi|kotak|paytm|cash|upi|wallet|\w+\s+card|card|bank)\b.*$/i, '')
    .replace(/\b(yesterday|today|last\s+\w+)\b/gi, '');
  const parts = body.split(/\s*(?:,(?!\d)|\band\b|\+)\s*/i).map((p) => p.trim()).filter(Boolean);
  const items = parts.map((p) => {
    const amount = amountOf(p);
    const hasFor = /\b(for|at|@)\s*(?:₹|rs\.?|inr)?\s*\d/i.test(p);
    const name = (hasFor ? p.replace(/\s*\b(for|at|@)\b\s*(?:₹|rs\.?|inr)?\s*\d[\d,]*(?:\.\d+)?\s*(k|lakh|lakhs|l)?\b.*$/i, '') : p.replace(/(?:₹|rs\.?|inr)?\s*\d[\d,]*(?:\.\d+)?\s*(k|lakh)?\s*$/i, ''))
      .replace(/\b(from|at)\s+\S+.*$/i, '').replace(/^(a|an|the|my|old|new|pair of)\s+/i, '').replace(/\s+/g, ' ').trim();
    return { name: name ? name[0].toUpperCase() + name.slice(1) : '', amount };
  }).filter((i) => i.name.length > 1);
  const priced = items.filter((i) => i.amount != null);
  const total = priced.length ? priced.reduce((s, i) => s + i.amount!, 0) : amountOf(t);
  return { kind, items, total, store };
}

// ---------- Splitwise friends-list screenshots ----------
export interface Balance { name: string; amount: number } // + they owe you, − you owe them
const UI = /^(friends|groups|activity|account|add friends?|search|overall|you are owed|you owe \S*\s*overall|settle up|balances?|show \d+|hide|non-group|total balance)\b/i;

export function parseSplitwiseBalances(text: string): Balance[] {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out: Balance[] = [];
  const seen = new Set<string>();
  let pendingName: string | null = null;
  const money = (s: string) => { const m = s.match(/(\d[\d,]*(?:\.\d{1,2})?)/); return m ? Math.round(parseFloat(m[1].replace(/,/g, '')) * 100) : null; };
  const nameLike = (s: string) => /^[A-Za-z][A-Za-z .'-]{1,40}$/.test(s) && s.split(' ').length <= 4 && !UI.test(s);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (UI.test(l) || /^overall/i.test(l)) { pendingName = null; continue; }
    const m = l.match(/^(.*?)\s*\b(owes you|you owe|settled up|no expenses)\b\s*(.*)$/i);
    if (m) {
      let name = m[1].replace(/[^A-Za-z .'-]/g, '').trim();
      if (!nameLike(name)) name = pendingName ?? '';
      // "you owe Rohan ₹500" puts the name after the phrase.
      if (!name && /you owe/i.test(m[2])) name = m[3].replace(/[^A-Za-z .'-]/g, ' ').trim().split(/\s{2,}|\s(?=\d)/)[0].trim();
      let amt = money(m[3]);
      if (amt == null && /owes you|you owe/i.test(m[2])) for (let k = i + 1; k <= i + 2 && k < lines.length; k++) { const v = money(lines[k]); if (v != null) { amt = v; break; } }
      const signed = /settled|no expenses/i.test(m[2]) ? 0 : /owes you/i.test(m[2]) ? (amt ?? 0) : -(amt ?? 0);
      if (name && nameLike(name) && !seen.has(name.toLowerCase())) { seen.add(name.toLowerCase()); out.push({ name, amount: signed }); }
      pendingName = null;
      continue;
    }
    if (nameLike(l)) pendingName = l;
  }
  return out;
}
