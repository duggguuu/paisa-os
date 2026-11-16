import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeSql, migrate, type Sql } from '../src/db.js';
import { createBook } from '../src/books.js';
import { createAccount, updateAccount } from '../src/books.js';
import { TxnInput, createTxn, updateTxn, voidTxn, restoreTxn, accountBalances, bookIntegrity, LedgerError } from '../src/ledger.js';
import * as stats from '../src/stats.js';
import { netWorth, safeToSpend } from '../src/dashboard.js';
import { toPaise, periodContaining, shiftPeriod } from '../src/money.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/paisa_test';
let sql: Sql;
let book: string;
const A: Record<string, string> = {};
let cat: (path: string) => string;
const key = () => crypto.randomUUID();
const bal = async (id: string) => (await accountBalances(sql, book)).find((a) => a.id === id)!.balance;

before(async () => {
  sql = makeSql(url);
  await sql.unsafe('drop schema public cascade; create schema public;');
  await migrate(sql);
  const [u] = await sql<{ id: string }[]>`insert into app_user (email, password_hash) values ('t@example.com', 'x') returning id`;
  book = await sql.begin((tx) => createBook(tx, u.id, 'Test', false));
  A.axis = await createAccount(sql, book, { name: 'SBI', kind: 'bank', openingBalance: 50_000_00, openingDate: '2026-01-01' });
  A.hdfc = await createAccount(sql, book, { name: 'ICICI Bank', kind: 'bank', openingBalance: 10_000_00, openingDate: '2026-01-01' });
  A.card = await createAccount(sql, book, { name: 'Card', kind: 'credit_card', openingBalance: 0 });
  A.zerodha = await createAccount(sql, book, { name: 'Zerodha', kind: 'investment', openingBalance: 0 });
  A.rohan = await createAccount(sql, book, { name: 'Rohan', kind: 'receivable', openingBalance: 0 });
  const cats = await sql<{ id: string; name: string; parent: string | null }[]>`
    select a.id, a.name, p.name as parent from account a left join account p on p.id = a.parent_id where a.book_id = ${book} and a.kind = 'category'`;
  cat = (path) => {
    const [p, c] = path.split('/');
    return cats.find((x) => (c ? x.parent === p && x.name === c : x.name === p && !x.parent))!.id;
  };
});

after(async () => { await sql.end(); });

test('money parsing is exact in paise', () => {
  assert.equal(toPaise('₹1,15,510.92'), 11551092);
  assert.equal(toPaise(0.1 + 0.2 > 0.3 ? '0.30' : '0.30'), 30);
  assert.equal(toPaise('450'), 45000);
  assert.throws(() => toPaise('4.505'));
});

test('periods: months start on the 1st, weeks on Monday', () => {
  assert.deepEqual(periodContaining('month', '2026-02-14'), { from: '2026-02-01', to: '2026-03-01' });
  assert.deepEqual(periodContaining('week', '2026-11-14'), { from: '2026-11-09', to: '2026-11-16' });
  assert.deepEqual(shiftPeriod('month', { from: '2026-01-01', to: '2026-02-01' }, -1), { from: '2025-12-01', to: '2026-01-01' });
  assert.deepEqual(periodContaining('month', '2026-11-03', 5), { from: '2026-10-05', to: '2026-11-05' });
});

test('database rejects unbalanced postings', async () => {
  await assert.rejects(
    sql.begin(async (tx) => {
      const [t] = await tx<{ id: string }[]>`insert into txn (book_id, kind, occurred_on) values (${book}, 'expense', '2026-02-01') returning id`;
      await tx`insert into posting (txn_id, account_id, amount) values (${t.id}, ${cat('Food/Groceries')}, 1000), (${t.id}, ${A.axis}, -999)`;
    }),
    /unbalanced/,
  );
});

test('database rejects single-posting transactions', async () => {
  await assert.rejects(
    sql.begin(async (tx) => {
      const [t] = await tx<{ id: string }[]>`insert into txn (book_id, kind, occurred_on) values (${book}, 'expense', '2026-02-01') returning id`;
      await tx`insert into posting (txn_id, account_id, amount) values (${t.id}, ${A.axis}, 1000)`;
    }),
    /at least two postings/,
  );
});

test('audit log is append-only', async () => {
  await assert.rejects(sql`update audit_log set action = 'x'`, /append-only/);
  await assert.rejects(sql`delete from audit_log`, /append-only/);
});

test('expense reduces the bank and counts as spending', async () => {
  const before = await bal(A.axis);
  await createTxn(sql, book, { kind: 'expense', date: '2026-02-03', amount: 450_00, accountId: A.axis, categoryId: cat('Food/Dining out'), merchant: 'Barbeque Nation', idempotencyKey: key() });
  assert.equal(await bal(A.axis), before - 450_00);
  const s = await stats.summary(sql, book, { from: '2026-02-01', to: '2026-03-01' });
  assert.equal(s.spent, 450_00);
});

test('idempotency key: retrying the same entry posts once', async () => {
  const k = key();
  const input = { kind: 'expense' as const, date: '2026-02-04', amount: 120_00, accountId: A.axis, categoryId: cat('Transport/Cab & auto'), merchant: 'Uber', idempotencyKey: k };
  const a = await createTxn(sql, book, input);
  const b = await createTxn(sql, book, input);
  assert.equal(a.id, b.id);
  assert.equal(b.duplicate, true);
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int n from txn where idempotency_key = ${k}`;
  assert.equal(n, 1);
});

test('duplicate UPI reference is refused', async () => {
  const base = { kind: 'expense' as const, date: '2026-02-05', amount: 99_00, accountId: A.hdfc, categoryId: cat('Food/Delivery'), externalRef: 'UPI-612345678901' };
  await createTxn(sql, book, { ...base, idempotencyKey: key() });
  await assert.rejects(createTxn(sql, book, { ...base, idempotencyKey: key() }), (e: any) => e instanceof LedgerError && e.code === 'duplicate_ref');
});

test('transfers between own accounts are not income or spending', async () => {
  const r = { from: '2026-03-01', to: '2026-04-01' };
  await createTxn(sql, book, { kind: 'transfer', date: '2026-03-02', amount: 5_000_00, fromAccountId: A.axis, toAccountId: A.hdfc, idempotencyKey: key() });
  const s = await stats.summary(sql, book, r);
  assert.equal(s.spent, 0);
  assert.equal(s.earned, 0);
  const ex = await stats.excluded(sql, book, r);
  assert.deepEqual(ex.map((x) => [x.bucket, x.amount]), [['Transfers between accounts', 5_000_00]]);
});

test('card purchase is spending once; paying the card bill is not spending again', async () => {
  const r = { from: '2026-04-01', to: '2026-05-01' };
  await createTxn(sql, book, { kind: 'expense', date: '2026-04-02', amount: 2_500_00, accountId: A.card, categoryId: cat('Transport/Fuel'), merchant: 'Indian Oil', idempotencyKey: key() });
  assert.equal(await bal(A.card), 2_500_00, 'card shows ₹2,500 owed');
  await createTxn(sql, book, { kind: 'transfer', date: '2026-04-10', amount: 2_500_00, fromAccountId: A.axis, toAccountId: A.card, idempotencyKey: key() });
  assert.equal(await bal(A.card), 0);
  const s = await stats.summary(sql, book, r);
  assert.equal(s.spent, 2_500_00);
  const ex = await stats.excluded(sql, book, r);
  assert.deepEqual(ex.map((x) => x.bucket), ['Card bill payments']);
});

test('split bill: only your share is spending, friends owe the rest', async () => {
  const r = { from: '2026-05-01', to: '2026-06-01' };
  const t = await createTxn(sql, book, {
    kind: 'split', date: '2026-05-04', accountId: A.card, merchant: 'Barbeque Nation', idempotencyKey: key(),
    lines: [{ amount: 1_200_00, categoryId: cat('Food/Dining out') }, { amount: 1_200_00, receivableId: A.rohan }],
  });
  const s = await stats.summary(sql, book, r);
  assert.equal(s.spent, 1_200_00);
  assert.equal(await bal(A.rohan), 1_200_00);
  await createTxn(sql, book, { kind: 'transfer', date: '2026-05-06', amount: 1_200_00, fromAccountId: A.rohan, toAccountId: A.axis, idempotencyKey: key() });
  assert.equal(await bal(A.rohan), 0);
  const people = await stats.byPerson(sql, book, r);
  assert.deepEqual(people.map((p) => [p.name, p.lent, p.received, p.outstanding]), [['Rohan', 1_200_00, 1_200_00, 0]]);
  assert.ok(t.id);
});

test('refund reduces the original category and is capped at the original amount', async () => {
  const r = { from: '2026-06-01', to: '2026-07-01' };
  const orig = await createTxn(sql, book, { kind: 'expense', date: '2026-06-02', amount: 3_000_00, accountId: A.card, categoryId: cat('Shopping/Apparel'), merchant: 'Myntra', idempotencyKey: key() });
  await createTxn(sql, book, { kind: 'refund', date: '2026-06-05', amount: 1_000_00, refundOf: orig.id, idempotencyKey: key() });
  const s = await stats.summary(sql, book, r);
  assert.equal(s.spent, 2_000_00);
  await assert.rejects(
    createTxn(sql, book, { kind: 'refund', date: '2026-06-06', amount: 2_000_01, refundOf: orig.id, idempotencyKey: key() }),
    (e: any) => e.code === 'over_refund',
  );
  await assert.rejects(voidTxn(sql, book, orig.id), (e: any) => e.code === 'has_refunds');
});

test('income counts as earned; savings rate only when income exists', async () => {
  const empty = await stats.summary(sql, book, { from: '2026-02-01', to: '2026-03-01' });
  assert.equal(empty.noIncomeLogged, true);
  assert.equal(empty.savingsRate, null);
  const r = { from: '2026-07-01', to: '2026-08-01' };
  await createTxn(sql, book, { kind: 'income', date: '2026-07-01', amount: 1_00_000_00, accountId: A.axis, categoryId: cat('Salary'), idempotencyKey: key() });
  await createTxn(sql, book, { kind: 'expense', date: '2026-07-03', amount: 25_000_00, accountId: A.axis, categoryId: cat('Housing/Rent'), idempotencyKey: key() });
  const s = await stats.summary(sql, book, r);
  assert.equal(s.earned, 1_00_000_00);
  assert.equal(s.spent, 25_000_00);
  assert.equal(s.saved, 75_000_00);
  assert.equal(s.savingsRate, 0.75);
});

test('void removes a transaction from balances and stats; restore brings it back', async () => {
  const before = await bal(A.hdfc);
  const t = await createTxn(sql, book, { kind: 'expense', date: '2026-07-09', amount: 700_00, accountId: A.hdfc, categoryId: cat('Health/Medicines'), idempotencyKey: key() });
  assert.equal(await bal(A.hdfc), before - 700_00);
  await voidTxn(sql, book, t.id);
  assert.equal(await bal(A.hdfc), before);
  await restoreTxn(sql, book, t.id);
  assert.equal(await bal(A.hdfc), before - 700_00);
  const hist = await sql<{ action: string }[]>`select action from audit_log where entity_id = ${t.id} order by id`;
  assert.deepEqual(hist.map((h) => h.action), ['create', 'void', 'restore']);
});

test('editing a transaction rewrites its postings and keeps history', async () => {
  const t = await createTxn(sql, book, { kind: 'expense', date: '2026-07-11', amount: 300_00, accountId: A.axis, categoryId: cat('Food/Delivery'), merchant: 'Swiggy', idempotencyKey: key() });
  await updateTxn(sql, book, t.id, { kind: 'expense', date: '2026-07-11', amount: 350_00, accountId: A.hdfc, categoryId: cat('Food/Delivery'), merchant: 'Swiggy' });
  const p = await sql<{ account_id: string; amount: number }[]>`select account_id, amount from posting where txn_id = ${t.id} order by amount`;
  assert.deepEqual(p.map((x) => [x.account_id, x.amount]), [[A.hdfc, -350_00], [cat('Food/Delivery'), 350_00]]);
  const [h] = await sql<{ before: any }[]>`select before from audit_log where entity_id = ${t.id} and action = 'update'`;
  assert.equal(h.before.postings.length, 2);
});

test('wrong-way entries are rejected', async () => {
  await assert.rejects(createTxn(sql, book, { kind: 'expense', date: '2026-07-12', amount: 1_00, accountId: A.axis, categoryId: cat('Salary') }), (e: any) => e.code === 'bad_category');
  await assert.rejects(createTxn(sql, book, { kind: 'expense', date: '2026-07-12', amount: 1_00, accountId: A.rohan, categoryId: cat('Food') }), (e: any) => e.code === 'bad_account');
  await assert.rejects(createTxn(sql, book, { kind: 'transfer', date: '2026-07-12', amount: 1_00, fromAccountId: A.axis, toAccountId: A.axis }), (e: any) => e.code === 'same_account');
});

test('accounts from another book are refused', async () => {
  const [u] = await sql<{ id: string }[]>`insert into app_user (email, password_hash) values ('other@example.com', 'x') returning id`;
  const other = await sql.begin((tx) => createBook(tx, u.id, 'Other', false));
  await assert.rejects(
    createTxn(sql, other, { kind: 'expense', date: '2026-07-12', amount: 1_00, accountId: A.axis, categoryId: cat('Food') }),
    (e: any) => e.code === 'account_not_found',
  );
});

test('opening balance edits replace, not add', async () => {
  const id = await createAccount(sql, book, { name: 'Paytm', kind: 'wallet', openingBalance: 500_00, openingDate: '2026-01-01' });
  await updateAccount(sql, book, id, { openingBalance: 800_00 });
  assert.equal(await bal(id), 800_00);
  const s = await stats.summary(sql, book, { from: '2026-01-01', to: '2026-02-01' });
  assert.equal(s.earned, 0, 'opening balances are not income');
});

test('category stats: comparisons against last period and 3-period average', async () => {
  for (const [d, amt] of [['2026-08-05', 1_000_00], ['2026-09-05', 2_000_00], ['2026-10-05', 3_000_00], ['2026-11-05', 4_000_00]] as const) {
    await createTxn(sql, book, { kind: 'expense', date: d, amount: amt, accountId: A.hdfc, categoryId: cat('Entertainment/Games'), idempotencyKey: key() });
  }
  const ranges = stats.resolvePeriod('month', '2026-11-14', 1);
  const rows = await stats.byCategory(sql, book, 'month', ranges);
  const ent = rows.find((r) => r.name === 'Entertainment')!;
  assert.equal(ent.amount, 4_000_00);
  assert.equal(ent.previous, 3_000_00);
  assert.equal(ent.avg3, 2_000_00);
  const t = await stats.trend(sql, book, 'month', ranges.current, 1, 4);
  assert.deepEqual(t.map((x) => x.from), ['2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01']);
});

test('net worth: assets minus liabilities, investments at market value when synced', async () => {
  await createTxn(sql, book, { kind: 'transfer', date: '2026-08-10', amount: 10_000_00, fromAccountId: A.axis, toAccountId: A.zerodha, idempotencyKey: key() });
  let nw = await netWorth(sql, book);
  assert.equal(nw.accounts.find((a) => a.id === A.zerodha)!.balance, 10_000_00);
  await sql`insert into holding_snapshot (book_id, account_id, source, instrument, asset_type, quantity, avg_price, last_price, value_paise)
            values (${book}, ${A.zerodha}, 'kite', 'NIFTYBEES', 'equity', 40, 250, 275, 11_000_00)`;
  nw = await netWorth(sql, book);
  assert.equal(nw.accounts.find((a) => a.id === A.zerodha)!.balance, 11_000_00);
  assert.equal(nw.netWorth, nw.assets - nw.liabilities);
});

test('safe to spend subtracts card dues and unspent budgets', async () => {
  await sql`insert into budget (book_id, category_id, period, amount) values (${book}, ${cat('Food')}, 'monthly', 5_000_00)`;
  const s = await safeToSpend(sql, book, 1, '2026-11-14');
  assert.equal(s.amount, s.spendable - s.cardDues - s.reservedForBudgets);
  assert.equal(s.reservedForBudgets, 5_000_00); // nothing spent on Food in Nov 2026
});

test('integrity: the whole book sums to zero and balances recompute', async () => {
  const r = await bookIntegrity(sql, book);
  assert.equal(r.ok, true);
  const nw = await netWorth(sql, book);
  const [{ raw }] = await sql<{ raw: number }[]>`
    select coalesce(sum(p.amount), 0)::bigint as raw from posting p join txn t on t.id = p.txn_id
    where p.account_id = ${A.axis} and t.status = 'posted'`;
  assert.equal(nw.accounts.find((a) => a.id === A.axis)!.ledgerBalance, raw);
});

test('in-progress period compares against the same number of days last period', () => {
  const r = stats.resolvePeriod('month', '2026-11-14', 1, undefined, '2026-11-14');
  assert.equal(r.toDate, true);
  assert.deepEqual(r.previous, { from: '2026-10-01', to: '2026-10-15' });
  assert.deepEqual(r.history[0], { from: '2026-10-01', to: '2026-11-01' }, 'the usual figure uses whole months');
  const past = stats.resolvePeriod('month', '2026-10-10', 1, undefined, '2026-11-14');
  assert.equal(past.toDate, false);
  assert.deepEqual(past.previous, { from: '2026-09-01', to: '2026-10-01' });
  const mar = stats.resolvePeriod('month', '2026-03-31', 1, undefined, '2026-03-31');
  assert.deepEqual(mar.previous, { from: '2026-02-01', to: '2026-03-01' }, 'capped at the end of a shorter month');
});

test('migrations: re-running is a no-op, and an edited applied migration stops startup', async () => {
  assert.deepEqual(await migrate(sql), []);
  const [row] = await sql<{ checksum: string }[]>`select checksum from schema_migrations where name = '001_init.sql'`;
  assert.match(row.checksum, /^[0-9a-f]{64}$/);
  await sql`update schema_migrations set checksum = 'tampered' where name = '001_init.sql'`;
  try {
    await assert.rejects(() => migrate(sql), /was edited after it was applied/);
  } finally {
    await sql`update schema_migrations set checksum = ${row.checksum} where name = '001_init.sql'`;
  }
});

test('negative amounts: money back on an expense, income taken back, overdrawn and overpaid openings', async () => {
  const bank = await createAccount(sql, book, { name: 'Overdraft', kind: 'bank', openingBalance: -2_000_00, openingDate: '2026-01-01' });
  const card = await createAccount(sql, book, { name: 'Overpaid card', kind: 'credit_card', openingBalance: -300_00, openingDate: '2026-01-01' });
  assert.equal(await bal(bank), -2_000_00, 'a bank can open overdrawn');
  assert.equal(await bal(card), -300_00, 'a card can open in credit');
  await createTxn(sql, book, { kind: 'expense', date: '2026-03-02', amount: -250_00, accountId: bank, categoryId: cat('Food/Groceries'), idempotencyKey: key() });
  assert.equal(await bal(bank), -1_750_00, 'a negative expense puts money back');
  await createTxn(sql, book, { kind: 'income', date: '2026-03-02', amount: -100_00, accountId: bank, categoryId: cat('Salary'), idempotencyKey: key() });
  assert.equal(await bal(bank), -1_850_00, 'a negative income takes money out');
  const base = { date: '2026-03-02', accountId: bank, categoryId: cat('Food/Groceries') };
  assert.equal(TxnInput.safeParse({ kind: 'expense', amount: -250_00, ...base }).success, true);
  assert.equal(TxnInput.safeParse({ kind: 'expense', amount: 0, ...base }).success, false, 'zero is not an amount');
  assert.equal(TxnInput.safeParse({ kind: 'transfer', date: '2026-03-02', amount: -1_00, fromAccountId: bank, toAccountId: card }).success, false, 'transfers stay positive');
  await updateAccount(sql, book, bank, { openingBalance: -500_00 });
  assert.equal(await bal(bank), -500_00 + 250_00 - 100_00, 'editing to another negative opening works');
  const integrity = await bookIntegrity(sql, book);
  assert.equal(Number(integrity.total), 0);
});
