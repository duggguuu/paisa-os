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
    id: 101, description: 'Dinner at Toit', cost: '1000.0', currency_code: 'INR', date: '2026-01-05T14:00:00Z', payment: false, deleted_at: null,
    category: { name: 'Dining out' },
    users: [{ user_id: ME, user: u(ME, 'Yash'), paid_share: '0.0', owed_share: '500.0', net_balance: '-500.0' },
            { user_id: ROHAN, user: u(ROHAN, 'Rohan'), paid_share: '1000.0', owed_share: '500.0', net_balance: '500.0' }],
    repayments: [{ from: ME, to: ROHAN, amount: '500.0' }],
  },
  { // you paid ₹1,200 groceries for three → Rohan and Aditi owe ₹400 each
    id: 102, description: 'BigBasket order', cost: '1200.0', currency_code: 'INR', date: '2026-02-10T05:00:00Z', payment: false, deleted_at: null,
    category: { name: 'Groceries' },
    users: [{ user_id: ME, user: u(ME, 'Yash'), paid_share: '1200.0', owed_share: '400.0', net_balance: '800.0' },
            { user_id: ROHAN, user: u(ROHAN, 'Rohan'), paid_share: '0.0', owed_share: '400.0', net_balance: '-400.0' },
            { user_id: ADITI, user: u(ADITI, 'Aditi'), paid_share: '0.0', owed_share: '400.0', net_balance: '-400.0' }],
    repayments: [{ from: ROHAN, to: ME, amount: '400.0' }, { from: ADITI, to: ME, amount: '400.0' }],
  },
  { // settle up: Rohan paid you ₹300
    id: 103, description: 'Payment', cost: '300.0', currency_code: 'INR', date: '2026-03-01T05:00:00Z', payment: true, deleted_at: null,
    users: [{ user_id: ROHAN, user: u(ROHAN, 'Rohan'), paid_share: '300.0', owed_share: '0.0', net_balance: '300.0' },
            { user_id: ME, user: u(ME, 'Yash'), paid_share: '0.0', owed_share: '300.0', net_balance: '-300.0' }],
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
    if (s.includes('/get_current_user')) return json({ user: { id: ME, first_name: 'Yash', last_name: 'G' } });
    if (s.includes('/get_expenses')) return json({ expenses: new URL(s).searchParams.get('offset') === '0' ? swExpenses : [] });
  }
  const ok = (data: unknown) => json({ status: 'success', data });
  if (s.endsWith('/session/token')) return ok({ access_token: 'tok', user_id: 'AB1234' });
  if (s.endsWith('/portfolio/holdings')) return ok([]);
  if (s.endsWith('/mf/holdings')) return ok([{ fund: 'Flexi Cap Fund - Direct', tradingsymbol: 'INF879O01027', quantity: 10, average_price: 80, last_price: 90 }]);
  return json({}, 404);
};

const req = async (method: string, path: string, body?: unknown) => {
  const res = await app.inject({ method: method as any, url: path, payload: body as any, headers: { cookie } });
  const set = res.headers['set-cookie'];
  if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(';')[0];
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

let A: Record<string, any> = {};
let C: Record<string, string> = {};
const bal = async (name: string) => (await req('GET', '/api/accounts')).body.find((a: any) => a.name === name)?.balance;

before(async () => {
  sql = makeSql(url);
  await sql.unsafe('drop schema public cascade; create schema public;');
  await migrate(sql);
  app = await buildApp({ sql, appSecret: 'y'.repeat(40), publicUrl: 'http://localhost:8080', fetch: fakeFetch });
  await req('POST', '/api/auth/setup', { email: 'f@example.com', password: 'correct horse battery' });
  for (const a of (await req('GET', '/api/accounts')).body) A[a.name] = a;
  for (const c of (await req('GET', '/api/categories')).body) C[c.name] = c.id;
  await req('PATCH', `/api/accounts/${A['Axis Bank'].id}`, { openingBalance: 100_000_00, openingDate: '2025-12-01' });
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
    name: 'Rent', kind: 'expense', amount: 25_000_00, accountId: A['Axis Bank'].id, categoryId: C['Rent'],
    cadence: 'monthly', day: Number(today.slice(8)), firstDue: today,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let home = (await req('GET', '/api/home')).body;
  assert.equal(home.safeToSpend.upcomingBills, 25_000_00);
  assert.equal(home.safeToSpend.amount, before.amount - 25_000_00);
  assert.equal(home.dueSoon[0].name, 'Rent');

  const logged = await req('POST', `/api/recurring/${r.body.id}/log`, {});
  assert.equal(logged.status, 200);
  assert.equal(await bal('Axis Bank'), 75_000_00);
  home = (await req('GET', '/api/home')).body;
  assert.equal(home.safeToSpend.upcomingBills, 0, 'next rent is next month');
  // Re-logging the same occurrence (e.g. two devices) must not double-book.
  await sql`update recurring_rule set next_due = ${today} where id = ${r.body.id}`;
  await req('POST', `/api/recurring/${r.body.id}/log`, {});
  assert.equal(await bal('Axis Bank'), 75_000_00);
});

test('recurring: auto-post rules log themselves when due, and transfers (SIPs) are set aside', async () => {
  const inv = await req('POST', '/api/accounts', { name: 'Groww', kind: 'investment' });
  await req('POST', '/api/recurring', {
    name: 'Netflix', kind: 'expense', amount: 649_00, accountId: A['HDFC Bank'].id, categoryId: C['Subscriptions'],
    cadence: 'monthly', day: 1, firstDue: addDays(today, -1), autoPost: true,
  });
  await req('PATCH', `/api/accounts/${A['HDFC Bank'].id}`, { openingBalance: 10_000_00, openingDate: '2025-12-01' });
  await req('GET', '/api/home'); // triggers auto-post
  assert.equal(await bal('HDFC Bank'), 10_000_00 - 649_00);
  const monthEnd = (await req('GET', '/api/home')).body.month.to;
  const sipDue = addDays(today, 1) < monthEnd ? addDays(today, 1) : today;
  const sip = await req('POST', '/api/recurring', {
    name: 'SIP', kind: 'transfer', amount: 5_000_00, accountId: A['Axis Bank'].id, toAccountId: inv.body.id, cadence: 'monthly',
    day: Number(sipDue.slice(8)), firstDue: sipDue,
  });
  assert.equal(sip.status, 200);
  const home = (await req('GET', '/api/home')).body;
  assert.equal(home.safeToSpend.upcomingBills, 5_000_00);
});

test('statement import: dedupes against itself and hand-entered entries, then reconciles', async () => {
  const manual = await req('POST', '/api/txns', { kind: 'expense', amount: 450_00, accountId: A['HDFC Bank'].id, categoryId: C['Delivery'], date: today, merchant: 'Swiggy' });
  assert.equal(manual.status, 201);
  const rows = [
    { date: today, amount: -450_00, description: 'UPI-SWIGGY-swiggy@icici-412345678901', merchant: 'Swiggy', ref: '412345678901', balance: 8_451_00 },
    { date: today, amount: -1_200_00, description: 'UPI-DMART-dmart@ybl-412345678902', merchant: 'Dmart', ref: '412345678902', balance: 7_251_00 },
  ];
  const pv = await req('POST', '/api/import/preview', { accountId: A['HDFC Bank'].id, rows });
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.equal(pv.body.rows[0].status, 'possible', 'matches the hand-entered Swiggy');
  assert.equal(pv.body.rows[1].status, 'new');
  const commit = { accountId: A['HDFC Bank'].id, fileName: 'hdfc.csv', closing: { balance: 7_251_00, date: today },
    rows: [{ ...rows[1], kind: 'expense', categoryId: C['Groceries'] }] };
  let c = await req('POST', '/api/import/commit', commit);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.imported, 1);
  assert.equal(c.body.reconciliation.ledger, 10_000_00 - 649_00 - 450_00 - 1_200_00);
  assert.equal(c.body.reconciliation.difference, 7_251_00 - c.body.reconciliation.ledger);
  c = await req('POST', '/api/import/commit', commit);
  assert.equal(c.body.imported, 0);
  assert.equal(c.body.skipped, 1, 'same file twice adds nothing');
  const pv2 = await req('POST', '/api/import/preview', { accountId: A['HDFC Bank'].id, rows });
  assert.equal(pv2.body.rows[1].status, 'duplicate');
  // Fix the difference with a reconciliation adjustment.
  const adj = await req('POST', `/api/accounts/${A['HDFC Bank'].id}/reconcile`, { date: today, balance: 7_251_00 });
  assert.equal(adj.body.adjusted, c.body.reconciliation.difference);
  assert.equal(await bal('HDFC Bank'), 7_251_00);
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
  let r = await req('POST', '/api/splitwise/link', { apiKey: 'sw_test_key_123', defaultAccountId: A['Axis Bank'].id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const axisBefore = await bal('Axis Bank');
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
  assert.equal(await bal('Axis Bank'), axisBefore - 1_200_00 + 300_00);

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
    await req('POST', '/api/txns', { kind: 'expense', amount: 119_00, accountId: A['Axis Bank'].id, categoryId: C['Subscriptions'], date: d, merchant: 'Spotify' });
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
  const K = 'Kabir M', M = 'Meera P', ME_ = 'Yash G';
  const group = { name: 'Flat.csv', rows: [
    { date: '2026-01-05', description: 'Dinner at Toit', category: 'Dining out', cost: 1000_00, currency: 'INR', nets: { [ME_]: -500_00, [K]: 500_00, [M]: 0 } },
    { date: '2026-02-10', description: 'BigBasket order', category: 'Groceries', cost: 1200_00, currency: 'INR', nets: { [ME_]: 800_00, [K]: -400_00, [M]: -400_00 } },
    { date: '2026-03-01', description: 'Kabir M. paid Yash G.', category: 'Payment', cost: 300_00, currency: 'INR', nets: { [ME_]: -300_00, [K]: 300_00, [M]: 0 } },
  ] };
  const friend = { name: 'Kabir.csv', rows: [
    { date: '2026-01-05', description: 'Dinner at Toit', category: 'Dining out', cost: 1000_00, currency: 'INR', nets: { [ME_]: -500_00, [K]: 500_00 } }, // repeat of the group row
    { date: '2026-02-20', description: 'Movie', category: 'Movies', cost: 600_00, currency: 'INR', nets: { [ME_]: 300_00, [K]: -300_00 } },
  ] };
  const base = { me: ME_, since: '2026-02-01', defaultAccountId: A['HDFC Bank'].id, files: [friend, group] };
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

  const hdfcBefore = await bal('HDFC Bank');
  let r = await req('POST', '/api/splitwise/csv/import', base);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.imported, 3);
  assert.equal(await bal(K), -100_00, 'you owe Kabir ₹100, as in Splitwise');
  assert.equal(await bal(M), 400_00, 'Meera owes you ₹400');
  assert.equal(await bal('HDFC Bank'), hdfcBefore - 1200_00 + 300_00 - 600_00);
  r = await req('POST', '/api/splitwise/csv/import', base);
  assert.equal(r.body.imported, 0, 're-uploading the same exports adds nothing');
  assert.equal(r.body.alreadyImported, 3);
  assert.equal((await req('GET', '/api/integrity')).body.ok, true);
});

test('goals: earmarked and account-linked goals, boost, projected finish date', async () => {
  // Earmark goal with a starting amount.
  let r = await req('POST', '/api/goals', { name: 'MacBook', icon: '💻', target: 1_00_000_00, startingAmount: 40_000_00, targetDate: addDays(today, 180) });
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
  const axisBefore = await bal('Axis Bank');
  r = await req('POST', `/api/goals/${ef}/boost`, { amount: 10_000_00 });
  assert.equal(r.status, 422, 'linked goals need a source account');
  r = await req('POST', `/api/goals/${ef}/boost`, { amount: 10_000_00, fromAccountId: A['Axis Bank'].id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await bal('Axis Bank'), axisBefore - 10_000_00);
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
