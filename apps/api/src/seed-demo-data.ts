/**
 * Sample data for the DEMO book only. It goes through the same ledger functions as real
 * entries, so it also exercises the rules. The real book is never touched.
 */
import crypto from 'node:crypto';
import type { Sql } from './db.js';
import { createTxn, type TxnInput } from './ledger.js';
import { createAccount } from './books.js';
import { addDays, fmt, parseDate, todayIST } from './money.js';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function seedDemo(sql: Sql, bookId: string, opts: { reset?: boolean; today?: string } = {}) {
  const [book] = await sql<{ is_demo: boolean }[]>`select is_demo from book where id = ${bookId}`;
  if (!book?.is_demo) throw new Error('seedDemo only runs on the demo book');
  if (opts.reset) {
    await sql.begin(async (tx) => {
      await tx`delete from holding_snapshot where book_id = ${bookId}`;
      await tx`delete from budget where book_id = ${bookId}`;
      await tx`delete from txn where book_id = ${bookId}`;
      await tx`delete from account where book_id = ${bookId} and kind not in ('category', 'equity')`;
    });
  }
  const today = opts.today ?? todayIST();
  const start = (() => {
    const d = new Date(parseDate(today));
    return fmt(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 5, 1));
  })();

  const acc: Record<string, string> = {};
  const mk = async (key: string, name: string, kind: any, opening: number, extra: any = {}) => {
    acc[key] = await createAccount(sql, bookId, { name, kind, openingBalance: opening * 100, openingDate: addDays(start, -1), ...extra });
  };
  await mk('axis', 'Axis Bank', 'bank', 85_000, { institution: 'Axis Bank', icon: '🏦', meta: { salary: true } });
  await mk('hdfc', 'HDFC Bank', 'bank', 42_000, { institution: 'HDFC Bank', icon: '🏦' });
  await mk('cash', 'Cash', 'cash', 3_500, { icon: '💵' });
  await mk('paytm', 'Paytm Wallet', 'wallet', 1_200, { icon: '👛' });
  await mk('card', 'HDFC Millennia Card', 'credit_card', 0, { institution: 'HDFC Bank', icon: '💳', meta: { cycle_day: 18, due_day: 7 } });
  await mk('zerodha', 'Zerodha (demo)', 'investment', 2_40_000, { institution: 'Zerodha', icon: '📈' });
  await mk('rohan', 'Rohan', 'receivable', 0, { icon: '🧑' });
  await mk('aditi', 'Aditi', 'receivable', 0, { icon: '👩' });

  const cats = await sql<{ id: string; name: string; parent: string | null }[]>`
    select a.id, a.name, p.name as parent from account a left join account p on p.id = a.parent_id
    where a.book_id = ${bookId} and a.kind = 'category'`;
  const C = (path: string) => {
    const [p, c] = path.split('/');
    const hit = cats.find((x) => (c ? x.parent === p && x.name === c : x.name === p && !x.parent));
    if (!hit) throw new Error(`demo category missing: ${path}`);
    return hit.id;
  };

  const r = rng(20261114);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const between = (lo: number, hi: number) => Math.round((lo + r() * (hi - lo)) / 10) * 10;
  const entries: TxnInput[] = [];
  const add = (t: Omit<TxnInput, 'idempotencyKey'> & Record<string, any>) => {
    if (t.date <= today) entries.push({ ...(t as any), idempotencyKey: crypto.randomUUID() });
  };
  const exp = (date: string, rupees: number, cat: string, account: string, merchant: string, note?: string) =>
    add({ kind: 'expense', date, amount: rupees * 100, categoryId: C(cat), accountId: acc[account], merchant, note });

  for (let d = start; d <= today; d = addDays(d, 1)) {
    const day = Number(d.slice(8));
    const dow = new Date(parseDate(d)).getUTCDay();
    if (day === 1) add({ kind: 'income', date: d, amount: 1_20_000 * 100, categoryId: C('Salary'), accountId: acc.axis, merchant: 'Acme Labs', description: 'Salary' });
    if (day === 2) add({ kind: 'transfer', date: d, amount: 3_000 * 100, fromAccountId: acc.axis, toAccountId: acc.cash, description: 'ATM withdrawal' });
    if (day === 2 || day === 16) add({ kind: 'transfer', date: d, amount: 1_500 * 100, fromAccountId: acc.axis, toAccountId: acc.paytm, description: 'Wallet top-up' });
    if (day === 3) exp(d, 22_000, 'Housing/Rent', 'axis', 'Landlord', 'Monthly rent');
    if (day === 5) exp(d, between(1_100, 1_900), 'Housing/Electricity', 'hdfc', 'BESCOM');
    if (day === 6) exp(d, 799, 'Housing/Internet', 'card', 'ACT Fibernet');
    if (day === 8) exp(d, 649, 'Bills & subscriptions/Subscriptions', 'card', 'Netflix');
    if (day === 12) exp(d, 119, 'Bills & subscriptions/Subscriptions', 'card', 'Spotify');
    if (day === 15) exp(d, 399, 'Bills & subscriptions/Mobile', 'axis', 'Jio');
    if (day === 7) add({ kind: 'transfer', date: d, amount: 0, fromAccountId: acc.axis, toAccountId: acc.card, description: 'Card bill payment' } as any);
    if (day === 10) add({ kind: 'transfer', date: d, amount: 10_000 * 100, fromAccountId: acc.axis, toAccountId: acc.zerodha, description: 'SIP' });
    if (day === 20) add({ kind: 'transfer', date: d, amount: 15_000 * 100, fromAccountId: acc.axis, toAccountId: acc.hdfc, description: 'Move to HDFC' });
    if (day === 25) exp(d, 5_000, 'Family/Parents', 'axis', 'Mom', 'Sent home');
    if (dow === 0 || dow === 3) exp(d, between(600, 2_400), 'Food/Groceries', pick(['hdfc', 'card', 'axis']), pick(['BigBasket', 'Zepto', 'Blinkit', 'Nature\'s Basket']));
    if (r() < 0.45) exp(d, between(180, 950), 'Food/Delivery', pick(['card', 'axis', 'paytm']), pick(['Swiggy', 'Zomato']));
    if (r() < 0.22) exp(d, between(350, 2_200), 'Food/Dining out', pick(['card', 'hdfc']), pick(['Toit', 'Truffles', 'Meghana Foods', 'Third Wave Coffee', 'Blue Tokai']));
    if (r() < 0.5) exp(d, between(60, 420), 'Transport/Cab & auto', pick(['paytm', 'axis', 'cash']), pick(['Uber', 'Ola', 'Rapido', 'Namma Yatri']));
    if (day % 9 === 4) exp(d, between(400, 900), 'Transport/Fuel', 'card', pick(['Indian Oil', 'HP Petrol']));
    if (r() < 0.12) exp(d, between(80, 300), 'Food/Snacks & coffee', 'cash', pick(['Chai point', 'Bakery', 'Juice stall']));
    if (r() < 0.05) exp(d, between(1_200, 6_500), 'Shopping/Apparel', 'card', pick(['Myntra', 'Uniqlo', 'H&M', 'Snitch']));
    if (r() < 0.04) exp(d, between(500, 4_000), 'Shopping/Household', pick(['card', 'hdfc']), pick(['Amazon', 'IKEA', 'Flipkart']));
    if (r() < 0.06) exp(d, between(300, 1_400), 'Entertainment/Movies & events', 'card', pick(['BookMyShow', 'PVR']));
    if (r() < 0.04) exp(d, between(250, 1_200), 'Health/Medicines', 'axis', pick(['Apollo Pharmacy', 'Tata 1mg']));
    if (r() < 0.03) exp(d, between(400, 900), 'Personal care', 'cash', 'Salon');
  }

  // Shared dinner: you paid ₹3,600 at Toit; Rohan and Aditi owe ₹1,200 each.
  const splitDay = addDays(today, -12);
  add({
    kind: 'split', date: splitDay, accountId: acc.card, merchant: 'Toit', note: 'Birthday dinner, split 3 ways',
    lines: [
      { amount: 1_200 * 100, categoryId: C('Food/Dining out') },
      { amount: 1_200 * 100, receivableId: acc.rohan, memo: 'Rohan’s share' },
      { amount: 1_200 * 100, receivableId: acc.aditi, memo: 'Aditi’s share' },
    ],
  });
  add({ kind: 'transfer', date: addDays(splitDay, 2), amount: 1_200 * 100, fromAccountId: acc.rohan, toAccountId: acc.axis, description: 'Rohan settled up' });

  // Card bills: pay the outstanding balance as of each payment date (computed below).
  const ordered = entries.sort((a, b) => a.date.localeCompare(b.date));
  let refunded = false;
  for (const e of ordered) {
    if (e.kind === 'transfer' && e.toAccountId === acc.card) {
      const [{ due }] = await sql<{ due: number }[]>`
        select coalesce(-sum(p.amount), 0)::bigint as due from posting p join txn t on t.id = p.txn_id
        where p.account_id = ${acc.card} and t.status = 'posted' and t.occurred_on < ${e.date}`;
      if (due <= 0) continue;
      e.amount = due;
    }
    const res = await createTxn(sql, bookId, e, 'demo-seed');
    // A refund on one Amazon order to show refunds reducing Shopping.
    if (e.kind === 'expense' && e.merchant === 'Amazon' && !refunded) {
      refunded = true;
      await createTxn(sql, bookId, { kind: 'refund', date: addDays(e.date, 3) <= today ? addDays(e.date, 3) : e.date, amount: e.amount, refundOf: res.id, merchant: 'Amazon', note: 'Returned', idempotencyKey: crypto.randomUUID() }, 'demo-seed');
    }
  }

  // Demo holdings so the investments view has something to show. Clearly labelled demo prices.
  const takenAt = `${today}T10:00:00Z`;
  for (const [name, type, qty, avg, last] of [
    ['Nifty 50 index ETF (demo)', 'equity', 400, 245.5, 268.2],
    ['Large-cap stock (demo)', 'equity', 30, 1_420, 1_515.4],
    ['Flexi cap fund (demo)', 'mf', 1_250.42, 72.1, 84.6],
    ['ELSS tax saver fund (demo)', 'mf', 610.88, 95.3, 101.75],
  ] as const) {
    await sql`insert into holding_snapshot (book_id, account_id, taken_at, source, instrument, asset_type, quantity, avg_price, last_price, value_paise)
              values (${bookId}, ${acc.zerodha}, ${takenAt}, 'demo', ${name}, ${type}, ${qty}, ${avg}, ${last}, ${Math.round(qty * last * 100)})`;
  }

  for (const [cat, amt] of [['Food', 14_000], ['Entertainment', 3_000], ['Shopping', 8_000], ['Transport', 6_000]] as const) {
    await sql`insert into budget (book_id, category_id, period, amount) values (${bookId}, ${C(cat)}, 'monthly', ${amt * 100})
              on conflict do nothing`;
  }
  return { count: entries.length };
}
