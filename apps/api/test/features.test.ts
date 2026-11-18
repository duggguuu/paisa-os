import fs from 'node:fs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { makeSql, migrate, type Sql } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { firstOnOrAfter, nextAfter } from '../src/recurring.js';
import { todayIST, addDays } from '../src/money.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/paisa_test';
let sql: Sql;
let app: FastifyInstance;
let cookie = '';
const today = todayIST();

// ---------- fake external APIs ----------
const ME = 1, ROHAN = 2, ADITI = 3;
const u = (id: number, first: string) => ({ id, first_name: first, last_name: null });
const swExpenses = [
  { // before the start date: Rohan paid ₹1,000 dinner, split 50/50 → you owe Rohan ₹500
    id: 101, description: 'Dinner at Barbeque Nation', cost: '1000.0', currency_code: 'INR', date: '2026-01-05T14:00:00Z', payment: false, deleted_at: null,
    category: { name: 'Dining out' },
    users: [{ user_id: ME, user: u(ME, 'Sam'), paid_share: '0.0', owed_share: '500.0', net_balance: '-500.0' },
            { user_id: ROHAN, user: u(ROHAN, 'Rohan'), paid_share: '1000.0', owed_share: '500.0', net_balance: '500.0' }],
    repayments: [{ from: ME, to: ROHAN, amount: '500.0' }],
  },
  { // you paid ₹1,200 groceries for three → Rohan and Aditi owe ₹400 each
    id: 102, description: 'BigBasket order', cost: '1200.0', currency_code: 'INR', date: '2026-02-10T05:00:00Z', payment: false, deleted_at: null,
    category: { name: 'Groceries' },
    users: [{ user_id: ME, user: u(ME, 'Sam'), paid_share: '1200.0', owed_share: '400.0', net_balance: '800.0' },
            { user_id: ROHAN, user: u(ROHAN, 'Rohan'), paid_share: '0.0', owed_share: '400.0', net_balance: '-400.0' },
            { user_id: ADITI, user: u(ADITI, 'Aditi'), paid_share: '0.0', owed_share: '400.0', net_balance: '-400.0' }],
    repayments: [{ from: ROHAN, to: ME, amount: '400.0' }, { from: ADITI, to: ME, amount: '400.0' }],
  },
  { // settle up: Rohan paid you ₹300
    id: 103, description: 'Payment', cost: '300.0', currency_code: 'INR', date: '2026-03-01T05:00:00Z', payment: true, deleted_at: null,
    users: [{ user_id: ROHAN, user: u(ROHAN, 'Rohan'), paid_share: '300.0', owed_share: '0.0', net_balance: '300.0' },
            { user_id: ME, user: u(ME, 'Sam'), paid_share: '0.0', owed_share: '300.0', net_balance: '-300.0' }],
    repayments: [{ from: ME, to: ROHAN, amount: '300.0' }],
  },
  { id: 104, description: 'Deleted thing', cost: '50', currency_code: 'INR', date: '2026-03-02T05:00:00Z', payment: false, deleted_at: '2026-03-03T00:00:00Z',
    users: [{ user_id: ME, paid_share: '50', owed_share: '50', net_balance: '0' }], repayments: [] },
  { id: 105, description: 'Trip in USD', cost: '20', currency_code: 'USD', date: '2026-03-04T05:00:00Z', payment: false, deleted_at: null,
    users: [{ user_id: ME, paid_share: '20', owed_share: '10', net_balance: '10' }, { user_id: ROHAN, paid_share: '0', owed_share: '10', net_balance: '-10' }],
    repayments: [{ from: ROHAN, to: ME, amount: '10' }] },
];
const fakeFetch: typeof fetch = async (input: any) => {
  const s = String(input);
  const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status });
  if (s.includes('splitwise.com')) {
    if (s.includes('/get_current_user')) return json({ user: { id: ME, first_name: 'Sam', last_name: 'G' } });
    if (s.includes('/get_expenses')) return json({ expenses: new URL(s).searchParams.get('offset') === '0' ? swExpenses : [] });
  }
  const ok = (data: unknown) => json({ status: 'success', data });
  if (s.endsWith('/session/token')) return ok({ access_token: 'tok', user_id: 'AB1234' });
  if (s.endsWith('/portfolio/holdings')) return ok([]);
  if (s.endsWith('/mf/holdings')) return ok([{ fund: 'Flexi Cap Fund - Direct', tradingsymbol: 'INF879O01027', quantity: 10, average_price: 80, last_price: 90 }]);
  return json({}, 404);
};

let unlockKey = '';   // the per-tab app-lock key, like sessionStorage in the browser
const req = async (method: string, path: string, body?: unknown, tab = unlockKey) => {
  const res = await app.inject({ method: method as any, url: path, payload: body as any, headers: { cookie, 'x-unlock': tab } });
  // Keep cookies by name, like a browser (the Face ID challenge cookie sits beside the session cookie).
  const set = res.headers['set-cookie'];
  for (const c of set ? (Array.isArray(set) ? set : [set]) : []) {
    const [pair] = String(c).split(';');
    const name = pair.split('=')[0];
    const jar = new Map(cookie ? cookie.split('; ').map((x) => [x.split('=')[0], x] as [string, string]) : []);
    if (/=;|=$|Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(String(c))) jar.delete(name); else jar.set(name, pair);
    cookie = [...jar.values()].join('; ');
  }
  const parsed = res.body ? JSON.parse(res.body) : null;
  if (res.statusCode < 300 && typeof parsed?.unlockKey === 'string') unlockKey = parsed.unlockKey;
  return { status: res.statusCode, body: parsed };
};

// Fake Web Push: records what would have been sent.
const pushed: { endpoint: string; payload: any }[] = [];
const fakePush = async (sub: any, body: string) => { pushed.push({ endpoint: sub.endpoint, payload: JSON.parse(body) }); return { statusCode: 201 }; };

let A: Record<string, any> = {};
let C: Record<string, string> = {};
const bal = async (name: string) => (await req('GET', '/api/accounts')).body.find((a: any) => a.name === name)?.balance;

before(async () => {
  sql = makeSql(url);
  await sql.unsafe('drop schema public cascade; create schema public;');
  await migrate(sql);
  app = await buildApp({ sql, appSecret: 'y'.repeat(40), publicUrl: 'http://localhost:8080', fetch: fakeFetch, pushSend: fakePush });
  await req('POST', '/api/auth/setup', { email: 'f@example.com', password: 'correct horse battery', banks: ['SBI', 'ICICI Bank'] });
  for (const a of (await req('GET', '/api/accounts')).body) A[a.name] = a;
  for (const c of (await req('GET', '/api/categories')).body) C[c.name] = c.id;
  await req('PATCH', `/api/accounts/${A['SBI'].id}`, { openingBalance: 100_000_00, openingDate: '2025-12-01' });
});
after(async () => { await app.close(); await sql.end(); });

test('recurring: due-date maths (month ends, weeks, years)', () => {
  assert.equal(firstOnOrAfter({ cadence: 'monthly', day: 31, month: null }, '2026-02-10'), '2026-02-28');
  assert.equal(nextAfter({ cadence: 'monthly', day: 31, month: null }, '2026-02-28'), '2026-03-31');
  assert.equal(firstOnOrAfter({ cadence: 'monthly', day: 5, month: null }, '2026-11-14'), '2026-12-05');
  assert.equal(firstOnOrAfter({ cadence: 'weekly', day: 1, month: null }, '2026-11-14'), '2026-11-16'); // Sat → Mon
  assert.equal(firstOnOrAfter({ cadence: 'yearly', day: 15, month: 4, }, '2026-11-14'), '2027-04-15');
  assert.equal(nextAfter({ cadence: 'yearly', day: 29, month: 2 }, '2028-02-29'), '2029-02-28');
});

test('recurring: bills due this month come out of safe-to-spend; logging is once-only', async () => {
  const before = (await req('GET', '/api/home')).body.safeToSpend;
  const r = await req('POST', '/api/recurring', {
    name: 'Rent', kind: 'expense', amount: 25_000_00, accountId: A['SBI'].id, categoryId: C['Rent'],
    cadence: 'monthly', day: Number(today.slice(8)), firstDue: today,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let home = (await req('GET', '/api/home')).body;
  assert.equal(home.safeToSpend.upcomingBills, 25_000_00);
  assert.equal(home.safeToSpend.amount, before.amount - 25_000_00);
  assert.equal(home.dueSoon[0].name, 'Rent');

  const logged = await req('POST', `/api/recurring/${r.body.id}/log`, {});
  assert.equal(logged.status, 200);
  assert.equal(await bal('SBI'), 75_000_00);
  home = (await req('GET', '/api/home')).body;
  assert.equal(home.safeToSpend.upcomingBills, 0, 'next rent is next month');
  // Re-logging the same occurrence (e.g. two devices) must not double-book.
  await sql`update recurring_rule set next_due = ${today} where id = ${r.body.id}`;
  await req('POST', `/api/recurring/${r.body.id}/log`, {});
  assert.equal(await bal('SBI'), 75_000_00);
});

test('recurring: auto-post rules log themselves when due, and transfers (SIPs) are set aside', async () => {
  const inv = await req('POST', '/api/accounts', { name: 'Groww', kind: 'investment' });
  await req('POST', '/api/recurring', {
    name: 'Netflix', kind: 'expense', amount: 649_00, accountId: A['ICICI Bank'].id, categoryId: C['Subscriptions'],
    cadence: 'monthly', day: 1, firstDue: addDays(today, -1), autoPost: true,
  });
  await req('PATCH', `/api/accounts/${A['ICICI Bank'].id}`, { openingBalance: 10_000_00, openingDate: '2025-12-01' });
  await req('GET', '/api/home'); // triggers auto-post
  assert.equal(await bal('ICICI Bank'), 10_000_00 - 649_00);
  const monthEnd = (await req('GET', '/api/home')).body.month.to;
  const sipDue = addDays(today, 1) < monthEnd ? addDays(today, 1) : today;
  const sip = await req('POST', '/api/recurring', {
    name: 'SIP', kind: 'transfer', amount: 5_000_00, accountId: A['SBI'].id, toAccountId: inv.body.id, cadence: 'monthly',
    day: Number(sipDue.slice(8)), firstDue: sipDue,
  });
  assert.equal(sip.status, 200);
  const home = (await req('GET', '/api/home')).body;
  assert.equal(home.safeToSpend.upcomingBills, 5_000_00);
});

test('statement import: dedupes against itself and hand-entered entries, then reconciles', async () => {
  const manual = await req('POST', '/api/txns', { kind: 'expense', amount: 450_00, accountId: A['ICICI Bank'].id, categoryId: C['Delivery'], date: today, merchant: 'Swiggy' });
  assert.equal(manual.status, 201);
  const rows = [
    { date: today, amount: -450_00, description: 'UPI-SWIGGY-swiggy@icici-412345678901', merchant: 'Swiggy', ref: '412345678901', balance: 8_451_00 },
    { date: today, amount: -1_200_00, description: 'UPI-DMART-dmart@ybl-412345678902', merchant: 'Dmart', ref: '412345678902', balance: 7_251_00 },
  ];
  const pv = await req('POST', '/api/import/preview', { accountId: A['ICICI Bank'].id, rows });
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.equal(pv.body.rows[0].status, 'possible', 'matches the hand-entered Swiggy');
  assert.equal(pv.body.rows[1].status, 'new');
  const commit = { accountId: A['ICICI Bank'].id, fileName: 'hdfc.csv', closing: { balance: 7_251_00, date: today },
    rows: [{ ...rows[1], kind: 'expense', categoryId: C['Groceries'] }] };
  let c = await req('POST', '/api/import/commit', commit);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.imported, 1);
  assert.equal(c.body.reconciliation.ledger, 10_000_00 - 649_00 - 450_00 - 1_200_00);
  assert.equal(c.body.reconciliation.difference, 7_251_00 - c.body.reconciliation.ledger);
  c = await req('POST', '/api/import/commit', commit);
  assert.equal(c.body.imported, 0);
  assert.equal(c.body.skipped, 1, 'same file twice adds nothing');
  const pv2 = await req('POST', '/api/import/preview', { accountId: A['ICICI Bank'].id, rows });
  assert.equal(pv2.body.rows[1].status, 'duplicate');
  // Fix the difference with a reconciliation adjustment.
  const adj = await req('POST', `/api/accounts/${A['ICICI Bank'].id}/reconcile`, { date: today, balance: 7_251_00 });
  assert.equal(adj.body.adjusted, c.body.reconciliation.difference);
  assert.equal(await bal('ICICI Bank'), 7_251_00);
  // Undo the import: its transactions are voided.
  const batches = (await req('GET', '/api/import/batches')).body;
  const undo = await req('POST', `/api/import/batches/${batches.find((b: any) => b.rows_imported === 1).id}/undo`);
  assert.equal(undo.body.voided, 1);
});

test('CAS import adds funds once, skipping ones Zerodha already reports', async () => {
  await req('PUT', '/api/kite/credentials', { apiKey: 'kitekey123', apiSecret: 'kitesecret456' });
  await req('GET', '/api/kite/callback?request_token=reqtok&status=success');
  const r = await req('POST', '/api/cas/import', { statementDate: today, fileName: 'cas.pdf', holdings: [
    { isin: 'INF879O01027', name: 'Parag Parikh Flexi Cap - Direct', units: 10, nav: 90, value: 900 },
    { isin: 'INF846K01DP8', name: 'Axis Bluechip - Direct', units: 100, nav: 60.5, value: 6050, cost: 5000 },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.imported, 1);
  assert.deepEqual(r.body.skippedAlreadyInZerodha, ['Parag Parikh Flexi Cap - Direct']);
  const nw = (await req('GET', '/api/networth')).body;
  assert.equal(nw.accounts.find((a: any) => a.name === 'Mutual funds').balance, 6_050_00);
});

test('Splitwise: link, preview, import with matching balances, and re-sync adds nothing', async () => {
  let r = await req('POST', '/api/splitwise/link', { apiKey: 'sw_test_key_123', defaultAccountId: A['SBI'].id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const axisBefore = await bal('SBI');
  r = await req('GET', '/api/splitwise/preview?since=2026-02-01');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.expenses.length, 2, 'dinner is before the start date; deleted and USD are left out');
  assert.equal(r.body.skippedCurrency, 1);
  const rohan = r.body.friends.find((f: any) => f.name === 'Rohan');
  assert.equal(rohan.allTime, -400_00, 'you owe Rohan 500 − 400 + 300 = ₹400... net −₹400');

  r = await req('POST', '/api/splitwise/import', { since: '2026-02-01' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.imported, 2);
  assert.equal(r.body.peopleCreated, 2);
  assert.equal(await bal('Rohan'), -400_00, 'matches Splitwise: you owe Rohan ₹400');
  assert.equal(await bal('Aditi'), 400_00, 'Aditi owes you ₹400');
  assert.equal(await bal('SBI'), axisBefore - 1_200_00 + 300_00);

  r = await req('POST', '/api/splitwise/import', { since: '2026-02-01' });
  assert.equal(r.body.imported, 0);
  assert.equal(r.body.alreadyImported, 2);
  assert.equal(await bal('Rohan'), -400_00);
  const integ = await req('GET', '/api/integrity');
  assert.equal(integ.body.ok, true);
});

test('insights: spots a steady monthly charge and offers to track it', async () => {
  // Spotify on the 5th of each of the last three months.
  const [y, m] = today.split('-').map(Number);
  for (const back of [1, 2, 3]) {
    const d = new Date(Date.UTC(y, m - 1 - back, 5)).toISOString().slice(0, 10);
    await req('POST', '/api/txns', { kind: 'expense', amount: 119_00, accountId: A['SBI'].id, categoryId: C['Subscriptions'], date: d, merchant: 'Spotify' });
  }
  const r = await req('GET', '/api/insights');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const sub = r.body.find((i: any) => i.id === 'sub-spotify');
  assert.ok(sub, `expected a Spotify insight in ${JSON.stringify(r.body.map((i: any) => i.id))}`);
  assert.equal(sub.action.recurring.amount, 119_00);
  const add = await req('POST', '/api/recurring', { ...sub.action.recurring });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  const again = await req('GET', '/api/insights');
  assert.ok(!again.body.some((i: any) => i.id === 'sub-spotify'), 'tracked subscriptions are no longer suggested');
});

test('Splitwise spreadsheet import (free accounts): balances, overlap between exports, sign detection', async () => {
  const K = 'Kabir M', M = 'Meera P', ME_ = 'Sam R';
  const group = { name: 'Flat.csv', rows: [
    { date: '2026-01-05', description: 'Dinner at Barbeque Nation', category: 'Dining out', cost: 1000_00, currency: 'INR', nets: { [ME_]: -500_00, [K]: 500_00, [M]: 0 } },
    { date: '2026-02-10', description: 'BigBasket order', category: 'Groceries', cost: 1200_00, currency: 'INR', nets: { [ME_]: 800_00, [K]: -400_00, [M]: -400_00 } },
    { date: '2026-03-01', description: 'Kabir M. paid Sam R.', category: 'Payment', cost: 300_00, currency: 'INR', nets: { [ME_]: -300_00, [K]: 300_00, [M]: 0 } },
  ] };
  const friend = { name: 'Kabir.csv', rows: [
    { date: '2026-01-05', description: 'Dinner at Barbeque Nation', category: 'Dining out', cost: 1000_00, currency: 'INR', nets: { [ME_]: -500_00, [K]: 500_00 } }, // repeat of the group row
    { date: '2026-02-20', description: 'Movie', category: 'Movies', cost: 600_00, currency: 'INR', nets: { [ME_]: 300_00, [K]: -300_00 } },
  ] };
  const base = { me: ME_, since: '2026-02-01', defaultAccountId: A['ICICI Bank'].id, files: [friend, group] };
  // Same data in the opposite sign convention must give the same answer.
  const negate = (f: any) => ({ ...f, rows: f.rows.map((r: any) => ({ ...r, nets: Object.fromEntries(Object.entries(r.nets).map(([k, v]) => [k, -(v as number)])) })) });
  const pvNeg = await req('POST', '/api/splitwise/csv/preview', { ...base, files: [negate(friend), negate(group)] });
  assert.equal(pvNeg.status, 200, JSON.stringify(pvNeg.body));
  assert.equal(pvNeg.body.sign, -1);

  const pv = await req('POST', '/api/splitwise/csv/preview', base);
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.equal(pv.body.sign, 1);
  assert.equal(pv.body.duplicatesAcrossFiles, 1, 'the dinner appears in both exports once');
  assert.equal(pv.body.expenses.length, 3, 'groceries, payment, movie (dinner is before the start date)');
  const kabir = pv.body.friends.find((f: any) => f.name === K);
  assert.equal(kabir.allTime, -500_00 + 400_00 - 300_00 + 300_00);
  assert.deepEqual(pvNeg.body.friends.map((f: any) => [f.name, f.allTime]), pv.body.friends.map((f: any) => [f.name, f.allTime]));
  const groceries = pv.body.expenses.find((e: any) => e.description === 'BigBasket order');
  assert.equal(groceries.yourShare, 400_00);
  assert.equal(groceries.bank, -1200_00);

  const hdfcBefore = await bal('ICICI Bank');
  let r = await req('POST', '/api/splitwise/csv/import', base);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.imported, 3);
  assert.equal(await bal(K), -100_00, 'you owe Kabir ₹100, as in Splitwise');
  assert.equal(await bal(M), 400_00, 'Meera owes you ₹400');
  assert.equal(await bal('ICICI Bank'), hdfcBefore - 1200_00 + 300_00 - 600_00);
  r = await req('POST', '/api/splitwise/csv/import', base);
  assert.equal(r.body.imported, 0, 're-uploading the same exports adds nothing');
  assert.equal(r.body.alreadyImported, 3);
  assert.equal((await req('GET', '/api/integrity')).body.ok, true);
});

test('goals: earmarked and account-linked goals, boost, projected finish date', async () => {
  // Earmark goal with a starting amount.
  let r = await req('POST', '/api/goals', { name: 'Laptop', icon: '💻', target: 1_00_000_00, startingAmount: 40_000_00, targetDate: addDays(today, 180) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const mac = r.body.id;
  r = await req('POST', `/api/goals/${mac}/boost`, { amount: 20_000_00 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let list = (await req('GET', '/api/goals')).body;
  let g = list.find((x: any) => x.id === mac);
  assert.equal(g.saved, 60_000_00);
  assert.equal(g.remaining, 40_000_00);
  assert.ok(g.pacePerMonth > 0 && g.reachOn, 'recent contributions give a pace and a finish date');
  assert.ok(g.neededPerMonth > 0);

  // Account-linked goal: boosting moves real money with a transfer (not spending).
  const fd = await req('POST', '/api/accounts', { name: 'Goal FD', kind: 'fd' });
  r = await req('POST', '/api/goals', { name: 'Emergency fund', target: 50_000_00, accountId: fd.body.id });
  const ef = r.body.id;
  const axisBefore = await bal('SBI');
  r = await req('POST', `/api/goals/${ef}/boost`, { amount: 10_000_00 });
  assert.equal(r.status, 422, 'linked goals need a source account');
  r = await req('POST', `/api/goals/${ef}/boost`, { amount: 10_000_00, fromAccountId: A['SBI'].id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await bal('SBI'), axisBefore - 10_000_00);
  g = (await req('GET', '/api/goals')).body.find((x: any) => x.id === ef);
  assert.equal(g.saved, 10_000_00);
  const spentBefore = (await req('GET', '/api/home')).body.monthSummary.spent;
  assert.equal(spentBefore, (await req('GET', '/api/home')).body.monthSummary.spent, 'goal transfers are not spending');

  await req('DELETE', `/api/goals/${mac}`);
  list = (await req('GET', '/api/goals')).body;
  assert.ok(!list.some((x: any) => x.id === mac), 'archived goals leave the list');
});

test('planner and financial health score', async () => {
  await req('PUT', '/api/budgets', { categoryId: C['Food'], period: 'monthly', amount: 5_000_00 });
  const p = (await req('GET', '/api/planner')).body;
  assert.equal(p.income.series.length, 6);
  assert.equal(p.spent.series.length, 6);
  assert.ok(p.planned.value >= 5_000_00);
  const food = p.categories.find((c: any) => c.name === 'Food');
  assert.ok(food && ['on_track', 'behind', 'over'].includes(food.status));
  const h = (await req('GET', '/api/health-score')).body;
  assert.ok(h.score >= 0 && h.score <= 100);
  assert.equal(h.parts.length, 6);
  assert.equal(h.parts.reduce((s: number, x: any) => s + x.weight, 0), 100);
});

test('copilot (local engine) answers from the data', async () => {
  const info = (await req('GET', '/api/copilot')).body;
  assert.equal(info.engine, process.env.ANTHROPIC_API_KEY ? 'claude' : 'local');
  if (info.engine !== 'local') return;
  const ask = async (q: string) => (await req('POST', '/api/copilot', { question: q })).body.answer as string;
  assert.match(await ask('Can I afford a ₹500 dinner?'), /Yes/);
  assert.match(await ask('Can I afford a 50 lakh flat?'), /Not from this month/);
  assert.match(await ask('When will I reach my goal?'), /Emergency fund/);
  assert.match(await ask('Why did my spending increase?'), /last month/);
  assert.match(await ask('How can I save more each month?'), /income|Trimming|budget/);
  assert.match(await ask("what's my financial health score?"), /\/100/);
  assert.match(await ask('how much did I spend on groceries'), /Groceries|couldn't find/);
});

test('Trans. month and year totals match the ledger', async () => {
  const m = (await req('GET', `/api/trans/month?anchor=${today}`)).body;
  const home = (await req('GET', '/api/home')).body;
  assert.equal(m.expense, home.monthSummary.spent);
  assert.equal(m.income, home.monthSummary.earned);
  assert.equal(m.total, m.income - m.expense);
  const y = (await req('GET', `/api/trans/year?year=${today.slice(0, 4)}`)).body;
  assert.equal(y.length, 12);
  assert.equal(y.find((r: any) => r.from === m.range.from).expense, m.expense);
  const s = (await req('GET', '/api/stats?period=month')).body;
  assert.ok(Array.isArray(s.incomeCategories));
});

test('app lock: locks after idle and on every new open; Face ID or password unlocks', async () => {
  // The lock works without a passkey now (the password unlocks it).
  let r = await req('PUT', '/api/security', { lockEnabled: true, lockMinutes: 5 });
  assert.equal(r.status, 200);
  const [u] = await sql<{ id: string }[]>`select id from app_user limit 1`;
  await sql`insert into webauthn_credential (id, user_id, public_key) values ('test-cred', ${u.id}, '\\x00')`;
  assert.equal((await req('GET', '/api/auth/status')).body.passkeyLogin, true);
  // This tab logged in, so it holds a key: unlocked.
  assert.ok(unlockKey, 'login handed this tab an unlock key');
  assert.equal((await req('GET', '/api/accounts')).status, 200);
  // A new tab / fresh app start has no key: locked, though the session cookie is valid.
  assert.equal((await req('GET', '/api/accounts', undefined, '')).status, 423, 'new open is locked');
  assert.equal((await req('GET', '/api/accounts', undefined, 'x'.repeat(43))).status, 423, 'a made-up key is locked');
  assert.equal((await req('GET', '/api/auth/status', undefined, '')).body.user.locked, true);
  // Idle lock.
  await req('POST', '/api/auth/lock');
  assert.equal((await req('GET', '/api/accounts')).status, 423, 'locked sessions get 423');
  r = await req('POST', '/api/auth/unlock/options', {});
  assert.equal(r.status, 200);
  assert.ok(r.body.challenge && r.body.allowCredentials.some((c: any) => c.id === 'test-cred'));
  r = await req('POST', '/api/auth/unlock/verify', { response: { id: 'test-cred', rawId: 'test-cred', type: 'public-key', response: {} } });
  assert.ok(r.status >= 400, 'a bogus assertion is rejected');
  assert.equal((await req('GET', '/api/accounts')).status, 423);
  // Password unlock.
  r = await req('POST', '/api/auth/unlock/password', { password: 'not the password' });
  assert.equal(r.status, 401);
  r = await req('POST', '/api/auth/unlock/password', { password: 'correct horse battery' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await req('GET', '/api/accounts')).status, 200, 'unlocked with the password');
  // Removing passkeys no longer turns the lock off; "every open" can be switched off.
  await req('DELETE', '/api/passkeys/test-cred');
  assert.equal((await req('GET', '/api/auth/status')).body.user.lockEnabled, true);
  await req('PUT', '/api/security', { lockEnabled: true, lockOnOpen: false });
  assert.equal((await req('GET', '/api/accounts', undefined, '')).status, 200, 'without lock-on-open a new tab only checks idle');
  await req('PUT', '/api/security', { lockEnabled: false });
  await sql`update session set unlocked_until = now() - interval '1 minute'`;
  assert.equal((await req('GET', '/api/accounts', undefined, '')).status, 200, 'no lock when it is off');
});

// <personal> Uses the owner's own data; removed from exports.
// Clean exports of the app (for another owner) leave the personal sheet snapshot out.
const HAS_SNAPSHOT = fs.existsSync(new URL('../data/stuff-sheet.json', import.meta.url));
test('stuff: sheet import, purchase moves Want→Own by product code, sell moves Own→Sold', { skip: !HAS_SNAPSHOT && 'no sheet snapshot in this copy' }, async () => {
  let r = await req('POST', '/api/stuff/import-sheet');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.added, 114);
  r = await req('POST', '/api/stuff/import-sheet');
  assert.equal(r.body.added, 0, 'importing twice adds nothing');
  const want0 = (await req('GET', '/api/stuff?list=want')).body.length;
  // The H&M order from the screenshots: 6 lines, ₹11,675.20 paid.
  const lines = [
    ['Regular Fit Cotton Henley Top', '1365507002013', 'Dark brown', 'L', 159920],
    ['Relaxed Fit Printed Cotton Poplin Shirt', '1363609001013', 'Dark blue/Street Archives', 'L', 183920],
    ['Loose Straight Jeans', '1357868008021', 'Beige', '30/32', 239920],
    ['Regular Fit Waffled Henley Top', '1357940002013', 'Dark dusty red', 'L', 183920],
    ['Overshirt', '1351283001013', 'Dark green', 'L', 239920],
    ['Regular Fit Shirt', '1309692005013', 'Green/White striped', 'L', 159920],
  ];
  const spentBefore = (await req('GET', '/api/home')).body.monthSummary.spent;
  r = await req('POST', '/api/stuff/purchase', {
    accountId: A['SBI'].id, categoryId: C['Apparel'], store: 'H&M', total: 1167520,
    items: lines.map(([name, artNo, colour, size, paid]) => ({ name, artNo, colour, size, paid, brand: 'H&M', category: 'Clothes' })),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.movedFromWant.length, 6, `all six were on the Want list: ${JSON.stringify(r.body)}`);
  assert.equal((await req('GET', '/api/home')).body.monthSummary.spent, spentBefore + 1167520);
  assert.equal((await req('GET', '/api/stuff?list=want')).body.length, want0 - 6);
  const own = (await req('GET', '/api/stuff?list=own')).body;
  const jeans = own.find((i: any) => i.name === 'Loose straight jeans, beige');
  assert.equal(jeans.price, 239920);
  assert.equal(jeans.meta.size, '30/32');
  // Logging the same order again doesn't duplicate anything in Own.
  const ownCount = (await req('GET', '/api/stuff?list=own')).body.length;
  r = await req('POST', '/api/stuff/purchase', {
    accountId: A['SBI'].id, categoryId: C['Apparel'], store: 'H&M', total: 1167520,
    items: lines.map(([name, artNo, colour, size, paid]) => ({ name, artNo, colour, size, paid, brand: 'H&M' })),
  });
  assert.equal(r.body.alreadyOwned.length, 6);
  assert.equal((await req('GET', '/api/stuff?list=own')).body.length, ownCount);
  // A brand-new item (not on Want) is added to Own.
  r = await req('POST', '/api/stuff/purchase', { accountId: A['SBI'].id, categoryId: C['Electronics'], total: 249900, items: [{ name: 'Anker 65W charger', category: 'Tech' }] });
  assert.deepEqual(r.body.addedToOwn, ['Anker 65W charger']);
  // Sell the PS5.
  const ps5 = own.find((i: any) => i.name === 'PlayStation 5');
  r = await req('POST', '/api/stuff/sell', { itemId: ps5.id, price: 3000000, accountId: A['SBI'].id, categoryId: C['Other income'], buyer: 'OLX buyer' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!(await req('GET', '/api/stuff?list=own')).body.some((i: any) => i.id === ps5.id), 'sold items leave Own');
  assert.equal((await req('GET', '/api/stuff?list=sold')).body[0].sold_price, 3000000);
});
// </personal>

test('people balances from a Splitwise screenshot set each balance exactly', async () => {
  let r = await req('POST', '/api/people/balances', { balances: [{ name: 'Rohan', amount: -400_00 }, { name: 'Priya Shah', amount: 1250_00 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await bal('Priya Shah'), 1250_00);
  assert.equal(r.body.people.find((p: any) => p.name === 'Priya Shah').created, true);
  r = await req('POST', '/api/people/balances', { balances: [{ name: 'Priya Shah', amount: 0 }] });
  assert.equal(await bal('Priya Shah'), 0, 'settled up');
  assert.equal((await req('GET', '/api/integrity')).body.ok, true);
});

test('loans: principal vs total, EMI split into interest + principal', async () => {
  const { loanMath, principalFromTotal } = await import('../src/debts.js');
  // ₹20,00,000 at 12% with a ₹19,000 EMI can't be the principal: monthly interest (₹20,000) would exceed the EMI.
  assert.equal(loanMath(20_00_000_00, 12, 19_000_00).emiTooSmall, true);
  let r = await req('POST', '/api/loans', { lender: 'Lender A', name: 'Home Loan', mode: 'principal', amount: 20_00_000_00, rate: 12, emi: 19_000_00, emiDay: 5, fromAccountId: A['SBI'].id });
  assert.equal(r.status, 422);
  assert.match(r.body.message, /total of your remaining EMIs/);
  // As the total of remaining EMIs: ~105.3 EMIs, principal ≈ ₹12.3 lakh.
  const p = principalFromTotal(20_00_000_00, 12, 19_000_00);
  assert.ok(p > 12_20_000_00 && p < 12_45_000_00, `principal ${p}`);
  r = await req('POST', '/api/loans', { lender: 'Lender A', name: 'Home Loan', mode: 'total', amount: 20_00_000_00, rate: 12, emi: 19_000_00, emiDay: 5, fromAccountId: A['SBI'].id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.principal, p);
  assert.equal(r.body.monthsLeft, 106);
  const loanBal = await bal('Home Loan');
  assert.equal(loanBal, p, 'outstanding = principal');
  const d = (await req('GET', '/api/debts')).body;
  const loan = d.loans.find((l: any) => l.name === 'Home Loan');
  assert.equal(loan.emi, 19_000_00);
  assert.ok(loan.nextEmi, 'EMI is a recurring bill');
  // Log one EMI: interest = outstanding × 12%/12 is spending; the rest reduces the loan.
  const spentBefore = (await req('GET', `/api/trans/month?anchor=${loan.nextEmi}`)).body.expense;
  const axisBefore = await bal('SBI');
  await sql`update recurring_rule set next_due = ${today} where id = ${loan.ruleId}`;
  r = await req('POST', `/api/recurring/${loan.ruleId}/log`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const interest = Math.round(p * 0.12 / 12);
  assert.equal(await bal('SBI'), axisBefore - 19_000_00);
  assert.equal(await bal('Home Loan'), p - (19_000_00 - interest));
  const spentAfter = (await req('GET', `/api/trans/month?anchor=${today}`)).body.expense;
  assert.ok(spentAfter >= interest, 'interest counts as spending');
  void spentBefore;
  assert.equal((await req('GET', '/api/integrity')).body.ok, true);
});

test('owe & owed: type balances directly, Splitwise overall, lent', async () => {
  let r = await req('POST', '/api/debts', { segment: 'splitwise', amount: 2350_00, direction: 'owed' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await req('POST', '/api/debts', { segment: 'iowe', name: 'Neha', amount: 800_00 });
  r = await req('POST', '/api/debts', { segment: 'lent', name: 'Arjun', amount: 15000_00, note: 'Bike repair, back by Dec' });
  const d = (await req('GET', '/api/debts')).body;
  assert.ok(d.owed.some((x: any) => x.name === 'Splitwise (overall)' && x.balance === 2350_00));
  assert.ok(d.iowe.some((x: any) => x.name === 'Neha' && x.balance === -800_00));
  assert.ok(d.lent.some((x: any) => x.name === 'Arjun' && x.balance === 15000_00 && x.note));
  assert.ok(!d.owed.some((x: any) => x.name === 'Arjun'), 'lent is its own segment');
  // Updating to a new total replaces, not adds.
  await req('POST', '/api/debts', { segment: 'splitwise', amount: 500_00, direction: 'iowe' });
  assert.equal(await bal('Splitwise (overall)'), -500_00);
  assert.equal((await req('GET', '/api/integrity')).body.ok, true);
});

test('FDs: grouped by bank, maturity value, maturing pays principal + interest income', async () => {
  const { fdValue } = await import('../src/fds.js');
  // ₹1,00,000 at 7% for a year, quarterly: 1,07,185.90
  assert.equal(fdValue(1_00_000_00, 7, 365), 1_07_185_90);
  const start = '2026-01-01', maturity = '2027-01-01';
  let r = await req('POST', '/api/fds', { bank: 'SBI', principal: 1_00_000_00, rate: 7, start, maturity });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await req('POST', '/api/fds', { bank: 'SBI', principal: 50_000_00, rate: 6.5, start, maturity: '2026-06-01' });
  assert.equal(r.body.name, 'SBI FD 2', 'second FD at the same bank gets a new name');
  const axisBefore = await bal('SBI');
  r = await req('POST', '/api/fds', { bank: 'ICICI Bank', principal: 20_000_00, rate: 7.25, start: today, maturity: '2028-01-01', fromAccountId: A['SBI'].id });
  assert.equal(await bal('SBI'), axisBefore - 20_000_00, 'paid from Axis');
  let f = (await req('GET', '/api/fds')).body;
  const sbi = f.banks.find((b: any) => b.bank === 'SBI');
  assert.equal(sbi.items.length, 2);
  assert.equal(sbi.principal, 1_50_000_00);
  assert.ok(f.banks.some((b: any) => b.bank === 'ICICI Bank'));
  // Mature the June one into Axis: interest is income.
  const june = sbi.items.find((x: any) => x.maturity === '2026-06-01');
  assert.equal(june.matured, true);
  const before = await bal('SBI');
  r = await req('POST', `/api/fds/${june.id}/mature`, { toAccountId: A['SBI'].id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await bal('SBI'), before + june.atMaturity);
  assert.ok(r.body.interest > 0);
  f = (await req('GET', '/api/fds')).body;
  assert.equal(f.banks.find((b: any) => b.bank === 'SBI').items.length, 1, 'matured FD is closed');
  assert.equal((await req('GET', '/api/integrity')).body.ok, true);
});

test('FDs: funded-from bank, bank\'s maturity amount, editing, and the rate table', async () => {
  // Already-had FD, labelled with where the money came from and the bank's own maturity figure.
  let r = await req('POST', '/api/fds', { bank: 'HDFC Bank', principal: 2_00_000_00, rate: 6.6, start: '2026-02-01', maturity: '2027-05-01', fundedFrom: 'Kotak savings', expectedMaturity: 2_16_400_00 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const hid = r.body.id;
  let f = (await req('GET', '/api/fds')).body.banks.flatMap((b: any) => b.items).find((x: any) => x.id === hid);
  assert.equal(f.fundedFrom, 'Kotak savings');
  assert.equal(f.atMaturity, 2_16_400_00, 'bank figure wins over the estimate');
  assert.ok(f.estimate > 2_00_000_00 && f.estimate !== f.atMaturity);
  assert.equal(f.interest, 16_400_00);
  assert.ok(f.valueNow >= f.principal && f.valueNow <= f.atMaturity);
  // Paid by transfer: the source account's name is recorded automatically.
  r = await req('POST', '/api/fds', { bank: 'Axis Bank', principal: 10_000_00, rate: 6.25, start: today, maturity: '2027-12-01', fromAccountId: A['SBI'].id });
  const tid = r.body.id;
  f = (await req('GET', '/api/fds')).body.banks.flatMap((b: any) => b.items).find((x: any) => x.id === tid);
  assert.equal(f.fundedFrom, 'SBI');
  assert.equal(f.fundedFromAccountId, A['SBI'].id);
  // Edit: rename, new rate/tenure, clear the bank figure, change the amount (allowed: opening balance).
  r = await req('PATCH', `/api/fds/${hid}`, { name: 'HDFC 15-month', rate: 6.75, maturity: '2027-08-01', expectedMaturity: null, principal: 2_50_000_00, fundedFrom: 'ICICI salary' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  f = (await req('GET', '/api/fds')).body.banks.flatMap((b: any) => b.items).find((x: any) => x.id === hid);
  assert.equal(f.name, 'HDFC 15-month');
  assert.equal(f.principal, 2_50_000_00);
  assert.equal(f.rate, 6.75);
  assert.equal(f.maturity, '2027-08-01');
  assert.equal(f.expectedMaturity, null);
  assert.equal(f.atMaturity, f.estimate);
  assert.equal(f.fundedFrom, 'ICICI salary');
  // A transfer-funded FD's amount can't be changed here (the transfer is the record) but other fields can.
  r = await req('PATCH', `/api/fds/${tid}`, { principal: 12_000_00 });
  assert.equal(r.status, 400);
  r = await req('PATCH', `/api/fds/${tid}`, { principal: 10_000_00, note: 'auto-renew off' });
  assert.equal(r.status, 200, 'same amount is fine');
  r = await req('PATCH', `/api/fds/${tid}`, { maturity: '2020-01-01' });
  assert.equal(r.status, 400, 'maturity before start');
  // Rates: the test server can't reach the site, so the bundled table is served.
  const rates = (await req('GET', '/api/fds/rates')).body;
  assert.equal(rates.live, false);
  assert.ok(rates.banks.length > 30);
  assert.ok(rates.banks.some((b: any) => b.bank === 'HDFC Bank' && b.y1 > 0));
  assert.equal((await req('GET', '/api/integrity')).body.ok, true);
});

test('FDs: Post Office schemes, own-bank link, deducting from the bank later', async () => {
  const { fdValue } = await import('../src/fds.js');
  // 5-yr Post Office TD, interest paid out yearly: 1 lakh at 7.5% → 5 × 7,713.59 = 38,567.93 interest.
  assert.equal(fdValue(1_00_000_00, 7.5, 5 * 365, 'yearly_payout'), 1_38_567_93);
  const rates = (await req('GET', '/api/fds/rates')).body;
  assert.ok(rates.schemes.some((x: any) => x.id === 'po-td-5' && x.rate === 7.5 && x.compounding === 'yearly_payout'));
  assert.ok(rates.schemes.some((x: any) => x.id === 'po-nsc' && x.rate === 7.7));
  // A savings account named like the user's own, and a TD held with it, added as "already had".
  let r = await req('POST', '/api/accounts', { name: 'PostBank', kind: 'bank', institution: 'India Post', openingBalance: 3_00_000_00, openingDate: '2026-01-01' });
  const pb = r.body.id;
  r = await req('POST', '/api/fds', { bank: 'PostBank', bankAccountId: pb, principal: 1_00_000_00, rate: 7.5, start: '2026-03-01', maturity: '2031-03-01', compounding: 'yearly_payout', scheme: 'Post Office Time Deposit (5 yr)', name: 'PostBank TD 5 yr' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const td = r.body.id;
  assert.equal(r.body.name, 'PostBank TD 5 yr');
  assert.equal(await bal('PostBank'), 3_00_000_00, 'label-only: savings unchanged');
  let f = (await req('GET', '/api/fds')).body.banks.flatMap((b: any) => b.items).find((x: any) => x.id === td);
  assert.equal(f.bankAccountId, pb);
  assert.equal(f.scheme, 'Post Office Time Deposit (5 yr)');
  assert.equal(f.atMaturity, fdValue(1_00_000_00, 7.5, 1826, 'yearly_payout'), '1826 days: 2028 is a leap year');
  // Now take the money out of PostBank: opening balance becomes a transfer on the start date.
  r = await req('PATCH', `/api/fds/${td}`, { fundFromAccountId: pb });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await bal('PostBank'), 2_00_000_00, 'deducted from savings');
  f = (await req('GET', '/api/fds')).body.banks.flatMap((b: any) => b.items).find((x: any) => x.id === td);
  assert.equal(f.principal, 1_00_000_00, 'FD keeps its amount');
  assert.equal(f.fundedFromAccountId, pb);
  r = await req('PATCH', `/api/fds/${td}`, { fundFromAccountId: pb });
  assert.equal(r.status, 400, 'can\'t be deducted twice');
  // Recording the transfer when adding: deducted straight away.
  r = await req('POST', '/api/fds', { bank: 'PostBank', bankAccountId: pb, principal: 50_000_00, rate: 7.7, start: today, maturity: '2031-11-01', compounding: 'yearly', fromAccountId: pb });
  assert.equal(await bal('PostBank'), 1_50_000_00);
  assert.equal((await req('GET', '/api/integrity')).body.ok, true);
});

test('deleting an account needs the PIN (or the password without one) and removes its transactions', async () => {
  let r = await req('POST', '/api/accounts', { name: 'Old Wallet', kind: 'wallet', openingBalance: 2_000_00, openingDate: '2026-01-01' });
  const w = r.body.id;
  await req('POST', '/api/txns', { kind: 'transfer', amount: 500_00, fromAccountId: A['SBI'].id, toAccountId: w, date: today });
  const sbiBefore = await bal('SBI');
  let p = (await req('GET', `/api/accounts/${w}/delete`)).body;
  assert.equal(p.transactions, 1);
  assert.equal(p.hasOpening, true);
  assert.ok(p.otherAccounts.some((o: any) => o.name === 'SBI'));
  assert.equal(p.confirmWith, 'password', 'no PIN set yet');
  r = await req('POST', `/api/accounts/${w}/delete`, {});
  assert.equal(r.status, 400);
  r = await req('POST', `/api/accounts/${w}/delete`, { password: 'nope' });
  assert.equal(r.status, 401);
  // With a PIN, the PIN is what's asked.
  r = await req('PUT', '/api/security/pin', { pin: '4071', password: 'correct horse battery' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  p = (await req('GET', `/api/accounts/${w}/delete`)).body;
  assert.equal(p.confirmWith, 'pin');
  r = await req('POST', `/api/accounts/${w}/delete`, { pin: '9999' });
  assert.equal(r.status, 401);
  assert.match(r.body.message, /tries left/);
  r = await req('POST', `/api/accounts/${w}/delete`, { pin: '4071' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await bal('Old Wallet'), undefined, 'gone');
  assert.equal(await bal('SBI'), sbiBefore + 500_00, 'the transfer went with it');
  r = await req('GET', `/api/accounts/${w}/delete`);
  assert.equal(r.status, 404);
  const cat = (await req('GET', '/api/categories')).body[0];
  r = await req('GET', `/api/accounts/${cat.id}/delete`);
  assert.equal(r.status, 400, 'categories aren\'t deleted here');
  await req('DELETE', '/api/security/pin');
  assert.equal((await req('GET', '/api/integrity')).body.ok, true);
});

test('widgets: Home tiles saved per user; view-only link for iPhone widgets', async () => {
  let w = (await req('GET', '/api/widgets')).body;
  assert.ok(w.tiles.length > 0, 'default tiles');
  assert.equal(w.link.enabled, false);
  let r = await req('PUT', '/api/widgets/tiles', { tiles: [{ id: 'bills', size: 'l' }, { id: 'networth', size: 's' }] });
  assert.equal(r.status, 200);
  assert.deepEqual((await req('GET', '/api/widgets')).body.tiles, [{ id: 'bills', size: 'l' }, { id: 'networth', size: 's' }]);
  r = await req('PUT', '/api/widgets/tiles', { tiles: [{ id: 'nope', size: 's' }] });
  assert.equal(r.status, 400);
  const d = (await req('GET', '/api/widgets/data')).body;
  for (const k of ['safeToSpend', 'thisMonth', 'netWorth', 'budget', 'bills', 'fds', 'goals', 'topSpending', 'month']) assert.ok(k in d, k);
  // Link: needs the password (no PIN set here); the token reads the summary without a session.
  r = await req('POST', '/api/widgets/link', { password: 'wrong' });
  assert.equal(r.status, 401);
  r = await req('POST', '/api/widgets/link', { password: 'correct horse battery' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const token = r.body.token;
  assert.ok(r.body.dataUrl.includes(token));
  const pub = await app.inject({ method: 'GET', url: `/api/widget/data?t=${token}` });
  assert.equal(pub.statusCode, 200, pub.body);
  const pd = JSON.parse(pub.body);
  assert.equal(pd.netWorth.total, d.netWorth.total);
  assert.equal(pd.hideAmounts, false);
  assert.equal(pub.headers['cache-control'], 'no-store');
  assert.equal((await app.inject({ method: 'GET', url: '/api/widget/data?t=' + 'x'.repeat(43) })).statusCode, 401);
  await req('PUT', '/api/widgets/hide', { hide: true });
  assert.equal(JSON.parse((await app.inject({ method: 'GET', url: `/api/widget/data?t=${token}` })).body).hideAmounts, true);
  assert.ok((await req('GET', '/api/widgets')).body.link.lastUsedAt);
  // A new link turns the old one off; turning off stops it.
  const t2 = (await req('POST', '/api/widgets/link', { password: 'correct horse battery' })).body.token;
  assert.equal((await app.inject({ method: 'GET', url: `/api/widget/data?t=${token}` })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: `/api/widget/data?t=${t2}` })).statusCode, 200);
  await req('DELETE', '/api/widgets/link');
  assert.equal((await app.inject({ method: 'GET', url: `/api/widget/data?t=${t2}` })).statusCode, 401);
  assert.equal((await req('GET', '/api/widgets')).body.link.hideAmounts, true, 'setting kept');
});

test('coffee: its own category; migration 011 moves coffee out of Food and other categories', async () => {
  let cats = (await req('GET', '/api/categories')).body;
  const under = (parent: string) => cats.filter((c: any) => cats.find((p: any) => p.id === c.parent_id)?.name === parent).map((c: any) => c.name);
  const top = (name: string) => cats.find((c: any) => c.name === name && !c.parent_id);
  assert.ok(top('Coffee'), 'Coffee category');
  assert.ok(['Beans', 'Equipment', 'Orders'].every((n) => under('Coffee').includes(n)));
  assert.ok(under('Food').includes('Snacks') && !under('Food').some((n: string) => /coffee/i.test(n)), 'no coffee under Food');
  // Simulate an older book: coffee under Food, a café-named category, entries at coffee places.
  const food = top('Food');
  const id = async (name: string, parentId: string | null) => (await req('POST', '/api/categories', { name, class: 'expense', ...(parentId ? { parentId } : {}) })).body.id;
  const snack = cats.find((c: any) => c.name === 'Snacks' && c.parent_id === food.id).id;
  await sql`update account set name = 'Snacks & coffee' where id = ${snack}`;
  const cafeTop = await id('Cafés', null);
  const cafeSub = await id('Weekend brunch', cafeTop);
  const dining = cats.find((c: any) => c.name === 'Dining out' && c.parent_id === food.id).id;
  const sh = top('Shopping');
  const online = cats.find((c: any) => c.name === 'Online orders' && c.parent_id === sh.id).id;
  const add = async (categoryId: string, merchant: string) => (await req('POST', '/api/txns', { kind: 'expense', amount: 300_00, accountId: A['SBI'].id, categoryId, date: today, merchant })).body.id;
  const t1 = await add(dining, 'Third Wave Coffee');
  const t2 = await add(dining, 'Meghana Foods');
  const t3 = await add(online, 'Blue Tokai');
  const t4 = await add(cafeSub, 'Brunch place');
  const t5 = await add(snack, 'Chai point');
  const t6 = await add(online, 'Amazon coffee grinder');
  const m011 = fs.readFileSync(new URL('../../../db/migrations/011_coffee_and_kite_funds.sql', import.meta.url), 'utf8');
  await sql.unsafe(m011);
  await sql.unsafe(m011);  // twice: nothing duplicated or broken
  cats = (await req('GET', '/api/categories')).body;
  const catOf = async (t: string) => {
    const x = (await req('GET', `/api/txns/${t}`)).body;
    const c = x.postings.find((p: any) => p.kind === 'category');
    const cat = cats.find((k: any) => k.id === c.account_id);
    return `${cats.find((k: any) => k.id === cat.parent_id)?.name}/${cat.name}`;
  };
  assert.equal(await catOf(t1), 'Coffee/Orders');
  assert.equal(await catOf(t2), 'Food/Dining out', 'not a coffee place');
  assert.equal(await catOf(t3), 'Coffee/Beans');
  assert.equal(await catOf(t4), 'Coffee/Orders', 'café-named category folded in');
  assert.equal(await catOf(t5), 'Food/Snacks');
  assert.equal(await catOf(t6), 'Coffee/Equipment');
  assert.ok(!cats.some((c: any) => /caf[eé]/i.test(c.name)), 'café categories removed');
  assert.equal(cats.filter((c: any) => c.name === 'Coffee' && !c.parent_id).length, 1);
  assert.equal(under('Coffee').filter((n: string) => n === 'Orders').length, 1);
  assert.equal((await req('GET', '/api/integrity')).body.ok, true);
});

test('FD rate page parser reads bank rows and the as-of date', async () => {
  const { parseRates } = await import('../src/fd-rates.js');
  const row = (n: string, a: string, b: string, c: string, d: string) => `<tr><td><a href="x">${n}</a></td><td>${a}</td><td>${b}</td><td>${c}</td><td>${d}</td></tr>`;
  const banks = Array.from({ length: 16 }, (_, i) => row(`Bank ${i}`, '7.00', '6.50', '6.75', '6.60')).join('');
  const html = `<table>${row('HDFC Bank', '6.60', '6.25', '6.55', '6.60')}${row('Induslnd Bank', '7.25', '6.75', '7.25', '6.65')}${banks}
    <tr><td>Tax saver</td><td>6.40%</td><td>6.90%</td></tr></table><i>Fixed deposit rates as of 3 December 2026</i>`;
  const t = parseRates(html)!;
  assert.equal(t.asOf, '2026-12-03');
  assert.ok(t.live);
  assert.deepEqual(t.banks.find((b) => b.bank === 'HDFC Bank'), { bank: 'HDFC Bank', highest: 6.6, y1: 6.25, y3: 6.55, y5: 6.6 });
  assert.ok(t.banks.some((b) => b.bank === 'IndusInd Bank'), 'typo on the page is fixed');
  assert.ok(t.banks.some((b) => b.bank === 'Post Office'));
  assert.equal(parseRates('<table>' + row('Only', '1', '1', '1', '1') + '</table>'), null, 'too few rows: not trusted');
});

test('interest-only loan: payment is all interest, principal stays; a loan can be corrected', async () => {
  let r = await req('POST', '/api/loans', { lender: 'Lender B', name: 'Personal Loan', type: 'interest_only', amount: 20_00_000_00, rate: 12, emi: 19_000_00, emiDay: 5, fromAccountId: A['SBI'].id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.principal, 20_00_000_00, 'no "EMI too small" for interest-only');
  let loan = (await req('GET', '/api/debts')).body.loans.find((l: any) => l.name === 'Personal Loan');
  assert.equal(loan.type, 'interest_only');
  assert.equal(loan.interestNow, 19_000_00);
  assert.equal(loan.monthsLeft, null);
  // Log one payment: whole amount is spending, principal unchanged.
  const axis = await bal('SBI');
  await sql`update recurring_rule set next_due = ${today} where id = ${loan.ruleId}`;
  r = await req('POST', `/api/recurring/${loan.ruleId}/log`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await bal('Personal Loan'), 20_00_000_00, 'principal unchanged');
  assert.equal(await bal('SBI'), axis - 19_000_00);
  const [t] = await sql<{ kind: string }[]>`select kind from txn where recurring_id = ${loan.ruleId}`;
  assert.equal(t.kind, 'expense');
  // Correct it: say it is really an EMI loan with a different principal; the rule follows.
  r = await req('PUT', `/api/loans/${loan.id}`, { lender: 'Lender B', name: 'Personal Loan', type: 'emi', mode: 'principal', amount: 10_00_000_00, rate: 12, emi: 25_000_00, emiDay: 7, fromAccountId: A['SBI'].id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await bal('Personal Loan'), 10_00_000_00);
  loan = (await req('GET', '/api/debts')).body.loans.find((l: any) => l.name === 'Personal Loan');
  assert.equal(loan.type, 'emi');
  assert.equal(loan.emi, 25_000_00);
  assert.ok(loan.monthsLeft > 0);
  const [rule] = await sql<{ amount: string; day: number; name: string }[]>`select amount, day, name from recurring_rule where id = ${loan.ruleId}`;
  assert.equal(Number(rule.amount), 25_000_00);
  assert.equal(rule.day, 7);
  assert.equal((await req('GET', '/api/integrity')).body.ok, true);
});

test('unlock PIN for laptops: set with password, unlock a new tab, 5 wrong tries fall back to password', async () => {
  await req('PUT', '/api/security', { lockEnabled: true, lockOnOpen: true, lockMinutes: 5 });
  let r = await req('PUT', '/api/security/pin', { pin: '1234', password: 'correct horse battery' });
  assert.equal(r.status, 400, 'straight runs are refused');
  r = await req('PUT', '/api/security/pin', { pin: '4071', password: 'wrong' });
  assert.equal(r.status, 401, 'setting a PIN needs the password');
  r = await req('PUT', '/api/security/pin', { pin: '4071', password: 'correct horse battery' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // A new tab (no key) is locked; the PIN unlocks it.
  unlockKey = '';
  assert.equal((await req('GET', '/api/accounts')).status, 423);
  const st = (await req('GET', '/api/auth/status')).body;
  assert.deepEqual(st.user.pin, { length: 4, blocked: false });
  r = await req('POST', '/api/auth/unlock/pin', { pin: '9999' });
  assert.equal(r.status, 401);
  assert.match(r.body.message, /4 tries left/);
  r = await req('POST', '/api/auth/unlock/pin', { pin: '4071' });
  assert.equal(r.status, 200);
  assert.equal((await req('GET', '/api/accounts')).status, 200, 'unlocked with the PIN');
  // Five wrong in a row: PIN blocked, even the right one, until the password unlocks.
  unlockKey = '';
  for (let i = 0; i < 5; i++) await req('POST', '/api/auth/unlock/pin', { pin: '0000' });
  r = await req('POST', '/api/auth/unlock/pin', { pin: '4071' });
  assert.equal(r.status, 429);
  assert.equal((await req('GET', '/api/auth/status')).body.user.pin.blocked, true);
  r = await req('POST', '/api/auth/unlock/password', { password: 'correct horse battery' });
  assert.equal(r.status, 200);
  unlockKey = '';
  assert.equal((await req('POST', '/api/auth/unlock/pin', { pin: '4071' })).status, 200, 'password unlock resets the PIN counter');
  // A PIN never logs in by itself.
  const saved = cookie; cookie = '';
  assert.equal((await req('POST', '/api/auth/unlock/pin', { pin: '4071' })).status, 401);
  cookie = saved;
  await req('DELETE', '/api/security/pin');
  assert.equal((await req('GET', '/api/auth/status')).body.user.pin, null);
  await req('PUT', '/api/security', { lockEnabled: false });
});

test('Kite callback works as a plain page load while the app lock is on (no tab key)', async () => {
  await req('PUT', '/api/security', { lockEnabled: true, lockOnOpen: true });
  let res = await app.inject({ method: 'GET', url: '/api/kite/callback?status=cancelled', headers: { cookie } });
  assert.equal(res.statusCode, 302, 'redirects instead of a 423 JSON page');
  assert.equal(res.headers.location, '/accounts?kite=cancelled');
  res = await app.inject({ method: 'GET', url: '/api/kite/callback?status=success&request_token=reqtok', headers: { cookie } });
  assert.equal(res.statusCode, 302);
  assert.match(String(res.headers.location), /^\/accounts\?kite=/);
  res = await app.inject({ method: 'GET', url: '/api/kite/callback?status=success&request_token=reqtok' });
  assert.equal(res.headers.location, '/?kite=login_needed', 'no session: back to the app, not an error');
  // Data routes are still locked for that tab.
  assert.equal((await app.inject({ method: 'GET', url: '/api/accounts', headers: { cookie } })).statusCode, 423);
  await req('PUT', '/api/security', { lockEnabled: false });
});

test('salary: structure → monthly credit on the last day; payslips; only salary counts as income', async () => {
  const L = (name: string, rupees: number, kind?: string) => ({ name, monthly: rupees * 100, ...(kind ? { kind } : {}) });
  let r = await req('PUT', '/api/salary', {
    employer: 'Acme', accountId: A['SBI'].id, payDay: 31,
    earnings: [L('Basic', 30000), L('HRA', 15000), L('Special allowance', 23000)],
    deductions: [L('Employee PF', 3600, 'pf'), L('Professional tax', 200, 'pt'), L('Income tax (TDS)', 1500, 'tds')],
    employerContrib: [L('Employer PF', 3600, 'pf')], annualBonus: 0, autoPost: false,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.net, (68000 - 5300) * 100);
  let s = (await req('GET', '/api/salary')).body;
  assert.equal(s.profile.gross, 68000_00);
  assert.equal(s.rule.amount, 62700_00);
  const due = s.rule.nextDue;
  const [y, m] = due.split('-').map(Number);
  assert.equal(Number(due.slice(8)), new Date(Date.UTC(y, m, 0)).getUTCDate(), 'due on the last day of the month');
  // Saving again updates the same rule.
  r = await req('PUT', '/api/salary', { ...{ employer: 'Acme', accountId: A['SBI'].id, payDay: 31, earnings: [L('Basic', 30000), L('HRA', 15000), L('Special allowance', 25000)], deductions: [L('Income tax (TDS)', 1500, 'tds')], employerContrib: [], autoPost: false } });
  assert.equal((await req('GET', '/api/salary')).body.rule.id, s.rule.id);
  // Payslip with TDS.
  r = await req('PUT', `/api/salary/slips/${today.slice(0, 7)}`, { earnings: [L('Basic', 30000), L('HRA', 15000)], deductions: [L('Income tax (TDS)', 1000, 'tds'), L('Employee PF', 3600, 'pf')] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  s = (await req('GET', '/api/salary')).body;
  assert.equal(s.slips.length, 1);
  assert.equal(s.slips[0].tds, 1000_00);
  assert.equal(s.slips[0].net, (45000 - 4600) * 100);

  // Money in: a friend repaying is logged under "Other income" first, then marked not income.
  const cats = (await req('GET', '/api/categories')).body;
  const otherIncome = cats.find((c: any) => c.class === 'income' && c.name === 'Other income');
  const repay = cats.find((c: any) => c.class === 'income' && c.name === 'Repayments');
  assert.ok(repay && repay.not_income, 'Repayments is a money-in category');
  assert.equal(cats.find((c: any) => c.name === 'Refunds & cashback').not_income, true);
  assert.equal(otherIncome.not_income, false);
  const before = (await req('GET', `/api/trans/month?anchor=${today}`)).body.income;
  const axis = await bal('SBI');
  r = await req('POST', '/api/txns', { kind: 'income', amount: 5000_00, accountId: A['SBI'].id, categoryId: otherIncome.id, date: today, merchant: 'Rahul UPI' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const txnId = r.body.id;
  assert.equal((await req('GET', `/api/trans/month?anchor=${today}`)).body.income, before + 5000_00);
  const list = (await req('GET', '/api/money-in')).body;
  assert.ok(list.some((x: any) => x.id === txnId && x.counted));
  r = await req('POST', '/api/money-in/reclassify', { txnIds: [txnId], categoryId: repay.id });
  assert.equal(r.body.moved, 1);
  assert.equal((await req('GET', `/api/trans/month?anchor=${today}`)).body.income, before, 'no longer income');
  assert.equal(await bal('SBI'), axis + 5000_00, 'the money is still in the bank');
  const st = (await req('GET', `/api/stats?period=month&anchor=${today}`)).body;
  assert.ok(st.summary.moneyIn >= 5000_00, 'shown as money in');
  assert.equal((await req('GET', '/api/integrity')).body.ok, true);
});

test('categories: rich defaults; migration 009 fills gaps in older books; add, rename, hide', async () => {
  let cats = (await req('GET', '/api/categories')).body;
  const find = (name: string, parent?: string) => cats.find((c: any) => c.name === name && (parent === undefined || cats.find((p: any) => p.id === c.parent_id)?.name === parent));
  assert.ok(find('Cook', 'Household help'), 'Household help › Cook');
  assert.ok(find('Ration & staples', 'Food'));
  assert.ok(find('Medical tests & scans', 'Health'));
  assert.ok(find('Fines & challans', 'Vehicle'));
  assert.ok(find('Freelance', 'Business & freelance'));
  assert.equal(find('Sold something', 'Money in (not income)').not_income, true);
  assert.equal(find('Rental income').not_income, false);

  // An "older" book: remove one whole group and one subcategory, then re-run the migration.
  const fuelId = find('Fuel', 'Transport').id;
  const hh = find('Household help');
  await sql`delete from account where parent_id = ${hh.id}`;
  await sql`delete from account where id = ${hh.id}`;
  await sql`delete from account where id = ${find('Pest control', 'Housing').id}`;
  const m009 = fs.readFileSync(new URL('../../../db/migrations/009_more_categories.sql', import.meta.url), 'utf8');
  await sql.unsafe(m009);
  await sql.unsafe(m009);                             // twice: nothing duplicated
  cats = (await req('GET', '/api/categories')).body;
  assert.ok(find('Cook', 'Household help') && find('Pest control', 'Housing'), 'gaps filled');
  assert.equal(find('Fuel', 'Transport').id, fuelId, 'existing categories untouched');
  assert.equal(cats.filter((c: any) => c.name === 'Cook').length, 1);

  // Add a category and a subcategory, rename, hide.
  let r = await req('POST', '/api/categories', { name: 'Side hustle', class: 'income', icon: '💰' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const side = r.body.id;
  r = await req('POST', '/api/categories', { name: 'Etsy shop', class: 'income', parentId: side });
  assert.equal(r.status, 200);
  r = await req('POST', '/api/categories', { name: 'Etsy shop', class: 'income', parentId: side });
  assert.equal(r.status, 409, 'no duplicates under one parent');
  r = await req('POST', '/api/categories', { name: 'Security deposit', class: 'income', parentId: find('Money in (not income)').id });
  cats = (await req('GET', '/api/categories')).body;
  assert.equal(find('Security deposit').not_income, true, 'subcategories inherit not-income');
  assert.equal(find('Etsy shop').not_income, false);
  r = await req('POST', '/api/categories', { name: 'Loan from friend', class: 'income', notIncome: true });
  cats = (await req('GET', '/api/categories')).body;
  assert.equal(find('Loan from friend').not_income, true);
  r = await req('PATCH', `/api/categories/${side}`, { name: 'Side business', icon: '🧑‍💻' });
  assert.equal(r.status, 200);
  r = await req('PATCH', `/api/categories/${side}`, { isArchived: true });
  cats = (await req('GET', '/api/categories')).body;
  assert.ok(!find('Side business') && !find('Etsy shop'), 'hiding a category hides its subcategories');
  const all = (await req('GET', '/api/categories?all=1')).body;
  assert.ok(all.some((c: any) => c.name === 'Etsy shop' && c.is_archived));
  r = await req('PATCH', `/api/categories/${find('Salary').id}`, { isArchived: true });
  assert.equal(r.status, 400, 'Salary cannot be hidden');
});

test('recurring: every N cycles (quarterly, half-yearly, fortnightly)', () => {
  assert.equal(nextAfter({ cadence: 'monthly', day: 15, month: null, every: 3 }, '2026-11-15'), '2027-02-15');
  assert.equal(nextAfter({ cadence: 'monthly', day: 31, month: null, every: 3 }, '2026-11-30'), '2027-02-28', 'month-end clamps');
  assert.equal(nextAfter({ cadence: 'monthly', day: 1, month: null, every: 6 }, '2026-08-01'), '2027-02-01');
  assert.equal(nextAfter({ cadence: 'weekly', day: 1, month: null, every: 2 }, '2026-11-16'), '2026-11-30');
  assert.equal(nextAfter({ cadence: 'yearly', day: 10, month: 3, every: 1 }, '2026-03-10'), '2027-03-10');
});

test('mandates & subscriptions: saved on recurring rules with reminders; quarterly logging advances 3 months', async () => {
  let r = await req('POST', '/api/recurring', {
    name: 'Streaming plan', kind: 'expense', amount: 649_00, accountId: A['ICICI Bank'].id, categoryId: C['OTT streaming'],
    cadence: 'monthly', day: 20, every: 3, firstDue: '2026-11-20', autoPost: false,
    mandate: { type: 'upi_autopay', provider: 'StreamCo', umrn: 'UMRN123', maxAmount: 1_000_00 },
    reminders: [{ daysBefore: 1, hour: 9 }, { daysBefore: 0, hour: 21 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.id;
  let rule = (await req('GET', '/api/recurring')).body.rules.find((x: any) => x.id === id);
  assert.equal(rule.every, 3);
  assert.equal(rule.mandate.type, 'upi_autopay');
  assert.equal(rule.mandate.maxAmount, 1_000_00);
  assert.deepEqual(rule.reminders, [{ daysBefore: 1, hour: 9 }, { daysBefore: 0, hour: 21 }]);
  await sql`update recurring_rule set next_due = ${today} where id = ${id}`;
  r = await req('POST', `/api/recurring/${id}/log`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  rule = (await req('GET', '/api/recurring')).body.rules.find((x: any) => x.id === id);
  assert.equal(rule.next_due, nextAfter({ cadence: 'monthly', day: 20, month: null, every: 3 }, today));
  // An internal update (e.g. from another feature) that doesn't mention reminders keeps them.
  r = await req('PUT', `/api/recurring/${id}`, { name: 'Streaming plan', kind: 'expense', amount: 699_00, accountId: A['ICICI Bank'].id, categoryId: C['OTT streaming'], cadence: 'monthly', day: 20, every: 3,
    mandate: rule.mandate, reminders: rule.reminders });
  assert.equal(r.status, 200);
  assert.equal((await req('GET', '/api/recurring')).body.rules.find((x: any) => x.id === id).reminders.length, 2);
});

test('notifications: daily nudges and renewal reminders, each sent once, no amounts by default; cron key required', async () => {
  const { tick, cronKey } = await import('../src/notify.js');
  // No device yet: nothing is sent.
  pushed.length = 0;
  const at = (istDate: string, istHour: number, min = 10) => new Date(Date.parse(`${istDate}T${String(istHour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00+05:30`));
  await tick(sql, 'https://paisa.example', at('2026-12-01', 9), fakePush as any);
  assert.equal(pushed.length, 0);
  // A device subscribes.
  let r = await req('POST', '/api/notifications/subscribe', { subscription: { endpoint: 'https://push.example/abc', keys: { p256dh: 'BPk', auth: 'aa' } }, device: 'iPhone' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const n = (await req('GET', '/api/notifications')).body;
  assert.ok(n.publicKey && n.cronKey && n.devices.length === 1);
  assert.deepEqual(n.prefs.daily.hours, [9, 14, 21]);
  // A subscription due on 2026-12-02 with a reminder the day before at 9.
  r = await req('POST', '/api/recurring', { name: 'Music app', kind: 'expense', amount: 119_00, accountId: A['SBI'].id, categoryId: C['Music streaming'],
    cadence: 'monthly', day: 2, firstDue: '2026-12-02', mandate: { type: 'subscription' }, reminders: [{ daysBefore: 1, hour: 9 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // 9:10 IST on 1 Dec: the morning nudge and the renewal reminder.
  await tick(sql, 'https://paisa.example', at('2026-12-01', 9), fakePush as any);
  const titles = pushed.map((p) => p.payload.title);
  assert.ok(titles.some((t) => /Good morning/.test(t)), titles.join(' | '));
  const renewal = pushed.find((p) => /Music app renews tomorrow/.test(p.payload.title));
  assert.ok(renewal, titles.join(' | '));
  assert.ok(!/₹|119/.test(JSON.stringify(renewal!.payload)), 'no amounts unless turned on');
  assert.equal(renewal!.payload.url, '/mandates');
  // Ticking again (or late, within 3 hours) sends nothing twice.
  const count = pushed.length;
  await tick(sql, 'https://paisa.example', at('2026-12-01', 9, 40), fakePush as any);
  await tick(sql, 'https://paisa.example', at('2026-12-01', 11, 5), fakePush as any);
  assert.equal(pushed.length, count);
  // 2 pm: the afternoon nudge only. Turn amounts on and check the 9 pm nudge is the night one.
  await tick(sql, 'https://paisa.example', at('2026-12-01', 14), fakePush as any);
  assert.ok(/Quick check-in/.test(pushed[pushed.length - 1].payload.title));
  await req('PUT', '/api/notifications/prefs', { daily: { enabled: true, hours: [21] }, amounts: true });
  await tick(sql, 'https://paisa.example', at('2026-12-01', 21), fakePush as any);
  assert.ok(/Before you call it a day/.test(pushed[pushed.length - 1].payload.title));
  // Daily nudges off: nothing at 9 next day.
  await req('PUT', '/api/notifications/prefs', { daily: { enabled: false, hours: [9] }, amounts: false });
  const before = pushed.length;
  await tick(sql, 'https://paisa.example', at('2026-12-02', 9), fakePush as any);
  assert.equal(pushed.length, before);

  // The cron route needs the key.
  let res = await app.inject({ method: 'POST', url: '/api/cron/tick' });
  assert.equal(res.statusCode, 401);
  res = await app.inject({ method: 'POST', url: '/api/cron/tick', headers: { 'x-cron-key': cronKey('y'.repeat(40)) } });
  assert.equal(res.statusCode, 200, res.body);
  // Removing the device.
  await req('DELETE', `/api/notifications/devices/${n.devices[0].id}`);
  assert.equal((await req('GET', '/api/notifications')).body.devices.length, 0);
});

test('transactions search also matches category and subcategory names', async () => {
  const cook = (await req('GET', '/api/categories')).body.find((c: any) => c.name === 'Cook');
  const r = await req('POST', '/api/txns', { kind: 'expense', amount: 3000_00, accountId: A['SBI'].id, categoryId: cook.id, date: today, merchant: 'Monthly pay' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  for (const q of ['cook', 'Household help']) {
    const list = (await req('GET', `/api/txns?q=${encodeURIComponent(q)}`)).body;
    const items = Array.isArray(list) ? list : list.items ?? list.txns ?? list.rows;
    assert.ok(items.some((t: any) => t.id === r.body.id), `search "${q}" finds it`);
  }
});

test('backup: passphrase, nightly cron file, check, restore replaces data exactly, wrong passphrase refused', async () => {
  const { cronKey: ck } = await import('../src/notify.js');
  const key = ck('y'.repeat(40));
  // Nobody has a passphrase yet: the nightly job skips quietly.
  let res = await app.inject({ method: 'POST', url: '/api/cron/backup', headers: { 'x-cron-key': key } });
  assert.equal(res.statusCode, 204);
  assert.equal((await app.inject({ method: 'POST', url: '/api/cron/backup' })).statusCode, 401);
  let r = await req('PUT', '/api/backup/passphrase', { passphrase: 'short', password: 'correct horse battery' });
  assert.equal(r.status, 400);
  r = await req('PUT', '/api/backup/passphrase', { passphrase: 'a long backup sentence', password: 'wrong' });
  assert.equal(r.status, 401);
  r = await req('PUT', '/api/backup/passphrase', { passphrase: 'a long backup sentence', hint: 'the sentence', password: 'correct horse battery' });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const before = (await req('GET', '/api/accounts')).body.filter((a: any) => a.class === 'asset').map((a: any) => [a.name, a.balance]);
  const nTxns = async () => (await sql<{ n: number }[]>`select count(*)::int as n from txn t join book b on b.id = t.book_id where not b.is_demo`)[0].n;
  const txnsBefore = await nTxns();
  res = await app.inject({ method: 'POST', url: '/api/cron/backup', headers: { 'x-cron-key': key } });
  assert.equal(res.statusCode, 200, res.body);
  const file = JSON.parse(res.body);
  assert.equal(file.format, 'paisa-backup');
  assert.ok(!res.body.includes('Groceries') && !res.body.includes('ICICI Bank'), 'the file is encrypted');
  assert.ok((await req('GET', '/api/backup')).body.lastBackupAt);

  // Something happens after the backup...
  const groceries = (await req('GET', '/api/categories')).body.find((c: any) => c.name === 'Groceries');
  r = await req('POST', '/api/txns', { kind: 'expense', amount: 999_00, accountId: A['SBI'].id, categoryId: groceries.id, date: todayIST(), merchant: 'After backup' });
  assert.equal(r.status, 201);
  assert.equal(await nTxns(), txnsBefore + 1);

  r = await req('POST', '/api/backup/check', { file, passphrase: 'not it at all' });
  assert.equal(r.status, 422);
  r = await req('POST', '/api/backup/check', { file, passphrase: 'a long backup sentence' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.transactions, txnsBefore);
  r = await req('POST', '/api/backup/restore', { file, passphrase: 'a long backup sentence', password: 'nope' });
  assert.equal(r.status, 401);
  r = await req('POST', '/api/backup/restore', { file, passphrase: 'a long backup sentence', password: 'correct horse battery' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.safetyCopy, true);

  assert.equal(await nTxns(), txnsBefore, 'the post-backup entry is gone');
  const after = (await req('GET', '/api/accounts')).body.filter((a: any) => a.class === 'asset').map((a: any) => [a.name, a.balance]);
  assert.deepEqual(after, before, 'balances match the backup exactly');
  assert.equal((await req('GET', '/api/integrity')).body.ok, true);
  assert.equal((await req('GET', '/api/backup/before-restore')).status, 200, 'safety copy kept');
});

test('copilot tools: search, breakdown, drafts never save', async () => {
  const { runTool } = await import('../src/copilot-tools.js');
  const [book] = await sql<{ id: string }[]>`select b.id from book b where not b.is_demo limit 1`;
  const drafts: any[] = [];
  const nTxns = async () => (await sql<{ n: number }[]>`select count(*)::int as n from txn where book_id = ${book.id}`)[0].n;
  const n0 = await nTxns();
  const found: any = await runTool(sql, book.id, 'find_transactions', { text: 'Cook', from: null, to: null, kind: null, min_rupees: null, max_rupees: null, sort: 'largest', limit: 5 }, drafts);
  assert.ok(found.matches >= 1 && found.rows[0].category.includes('Cook'));
  const br: any = await runTool(sql, book.id, 'spending_breakdown', { from: addDays(todayIST(), -400), to: todayIST(), group_by: 'category', kind: 'expense', category: null }, drafts);
  assert.ok(br.total_rupees > 0 && br.groups.length > 0);
  for (const t of ['accounts', 'investments', 'debts_and_loans', 'bills_and_subscriptions', 'salary_and_tax', 'goals']) {
    const out = await runTool(sql, book.id, t, {}, drafts);
    assert.ok(out && !(out as any).error, `${t} works`);
  }
  const bad: any = await runTool(sql, book.id, 'draft_transaction', { kind: 'expense', amount_rupees: 450, category: 'Zzz unknown', account: null, date: null, merchant: null, note: null }, drafts);
  assert.equal(bad.error, 'no_such_category');
  const ok: any = await runTool(sql, book.id, 'draft_transaction', { kind: 'expense', amount_rupees: 450, category: 'Groceries', account: 'SBI', date: '2026-11-10', merchant: 'BigBasket', note: null }, drafts);
  assert.equal(ok.drafted, true, JSON.stringify(ok));
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].amount, 45000);
  assert.equal(drafts[0].accountName, 'SBI');
  assert.equal(await nTxns(), n0, 'a draft is never saved');
});

test('subcategories can be renamed and moved; a move follows the new parent income status', async () => {
  const all = (await req('GET', '/api/categories?all=1')).body as any[];
  const food = all.find((c) => c.name === 'Food' && !c.parent_id && c.class === 'expense');
  const home = all.find((c) => !c.parent_id && c.class === 'expense' && c.id !== food.id);
  let r = await req('POST', '/api/categories', { name: 'Tiffin', class: 'expense', parentId: food.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.id;
  r = await req('PATCH', `/api/categories/${id}`, { name: 'Tiffin service' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await req('PATCH', `/api/categories/${id}`, { parentId: home.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let moved = ((await req('GET', '/api/categories?all=1')).body as any[]).find((c) => c.id === id);
  assert.equal(moved.name, 'Tiffin service');
  assert.equal(moved.parent_id, home.id);
  // Can't move a top-level category, under a subcategory, or across expense/income.
  assert.equal((await req('PATCH', `/api/categories/${food.id}`, { parentId: home.id })).status, 400);
  assert.equal((await req('PATCH', `/api/categories/${id}`, { parentId: all.find((c) => c.parent_id && c.class === 'expense').id })).status, 400);
  const incomeParent = all.find((c) => !c.parent_id && c.class === 'income');
  assert.equal((await req('PATCH', `/api/categories/${id}`, { parentId: incomeParent.id })).status, 400);
  // Income: moving into "Money in (not income)" stops it counting as income, and back again.
  const salaryParent = all.find((c) => !c.parent_id && c.class === 'income' && !c.not_income);
  const notIncome = all.find((c) => !c.parent_id && c.class === 'income' && c.not_income);
  r = await req('POST', '/api/categories', { name: 'Side gig', class: 'income', parentId: salaryParent.id });
  const gig = r.body.id;
  const counts = async () => (await sql<{ c: boolean }[]>`select counts_as_income(a) as c from account a where id = ${gig}`)[0].c;
  assert.equal(await counts(), true);
  await req('PATCH', `/api/categories/${gig}`, { parentId: notIncome.id });
  assert.equal(await counts(), false);
  await req('PATCH', `/api/categories/${gig}`, { parentId: salaryParent.id });
  assert.equal(await counts(), true);
});
