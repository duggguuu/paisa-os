import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { makeSql, migrate, type Sql } from '../src/db.js';
import { buildApp } from '../src/app.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/paisa_test';
let sql: Sql;
let app: FastifyInstance;
let cookie = '';
const calls: string[] = [];

// Fake Kite API: records which endpoints were called and returns canned data.
const fakeKite: typeof fetch = async (input: any, init?: any) => {
  const u = String(input);
  calls.push(`${init?.method ?? 'GET'} ${new URL(u).pathname}`);
  const ok = (data: unknown) => new Response(JSON.stringify({ status: 'success', data }), { status: 200 });
  if (u.endsWith('/session/token')) return ok({ access_token: 'tok_123', user_id: 'AB1234' });
  if (u.endsWith('/portfolio/holdings')) return ok([{ tradingsymbol: 'NIFTYBEES', isin: 'INF204KB14I2', quantity: 100, t1_quantity: 0, average_price: 250, last_price: 270.5 }]);
  if (u.endsWith('/mf/holdings')) return ok([{ fund: 'Flexi Cap Fund - Direct', tradingsymbol: 'INF879O01027', quantity: 10.5, average_price: 80, last_price: 89.2332 }]);
  return new Response('{}', { status: 404 });
};

const req = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await app.inject({ method: method as any, url: path, payload: body as any, headers: { cookie, ...headers } });
  const set = res.headers['set-cookie'];
  if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(';')[0];
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
};

before(async () => {
  sql = makeSql(url);
  await sql.unsafe('drop schema public cascade; create schema public;');
  await migrate(sql);
  app = await buildApp({ sql, appSecret: 'x'.repeat(40), publicUrl: 'http://localhost:8080', fetch: fakeKite });
});
after(async () => { await app.close(); await sql.end(); });

test('API requires a session', async () => {
  const r = await req('GET', '/api/accounts');
  assert.equal(r.status, 401);
});

test('setup creates the owner, a real book with your accounts, and a seeded demo book', async () => {
  let r = await req('GET', '/api/auth/status');
  assert.equal(r.body.setupNeeded, true);
  r = await req('POST', '/api/auth/setup', { email: 'owner@example.com', password: 'correct horse battery', banks: ['SBI', 'ICICI Bank'] });
  assert.equal(r.status, 200);
  r = await req('GET', '/api/accounts');
  assert.deepEqual(r.body.filter((a: any) => a.class === 'asset').map((a: any) => a.name), ['SBI', 'ICICI Bank', 'Cash']);
  assert.ok(r.body.every((a: any) => a.balance === 0), 'real accounts start at zero');
  r = await req('GET', '/api/home');
  assert.equal(r.body.monthSummary.spent, 0, 'real book has no demo transactions');
  const demo = await req('GET', '/api/home', undefined, { 'x-book': 'demo' });
  assert.ok(demo.body.netWorth.accounts.length >= 6);
  const integ = await req('GET', '/api/integrity', undefined, { 'x-book': 'demo' });
  assert.equal(integ.body.ok, true);
});

test('setup cannot run twice', async () => {
  const r = await req('POST', '/api/auth/setup', { email: 'intruder@example.com', password: 'another password' });
  assert.equal(r.status, 409);
});

test('quick-add flow: create expense, see it in stats, void it', async () => {
  const accounts = (await req('GET', '/api/accounts')).body;
  const axis = accounts.find((a: any) => a.name === 'SBI');
  await req('PATCH', `/api/accounts/${axis.id}`, { openingBalance: 50_000_00, openingDate: '2026-11-01' });
  const cats = (await req('GET', '/api/categories')).body;
  const dining = cats.find((c: any) => c.name === 'Dining out');
  const key = crypto.randomUUID();
  const body = { kind: 'expense', date: '2026-11-14', amount: 450_00, accountId: axis.id, categoryId: dining.id, merchant: 'Barbeque Nation', idempotencyKey: key };
  const created = await req('POST', '/api/txns', body);
  assert.equal(created.status, 201);
  const again = await req('POST', '/api/txns', body);
  assert.equal(again.status, 200);
  assert.equal(again.body.id, created.body.id);
  const s = await req('GET', '/api/stats?period=month&anchor=2026-11-14');
  assert.equal(s.body.summary.spent, 450_00);
  assert.equal(s.body.categories[0].name, 'Food');
  assert.equal(s.body.summary.noIncomeLogged, true);
  const sug = await req('GET', '/api/suggest?merchant=barbeque%20nation');
  assert.equal(sug.body.categoryId, dining.id);
  assert.equal(sug.body.accountId, axis.id);
  await req('DELETE', `/api/txns/${created.body.id}`);
  const s2 = await req('GET', '/api/stats?period=month&anchor=2026-11-14');
  assert.equal(s2.body.summary.spent, 0);
});

test('bad input gets a readable 400, not a crash', async () => {
  const r = await req('POST', '/api/txns', { kind: 'expense', amount: 0 });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /amount/);
});

test('stats drill-down by category returns subcategories and transactions', async () => {
  const s = await req('GET', '/api/stats?period=month', undefined, { 'x-book': 'demo' });
  assert.ok(s.body.categories.length > 3);
  const food = s.body.categories.find((c: any) => c.name === 'Food');
  assert.ok(food.hasChildren);
  const d = await req('GET', `/api/stats?period=month&categoryId=${food.id}`, undefined, { 'x-book': 'demo' });
  assert.ok(d.body.categories.every((c: any) => c.name !== 'Food' || c.name.includes('general')));
  assert.ok(d.body.transactions.length > 0);
  assert.equal(s.body.trend.length, 12);
});

test('Kite: link, login callback, sync holdings into snapshots (read-only endpoints only)', async () => {
  let r = await req('PUT', '/api/kite/credentials', { apiKey: 'kitekey123', apiSecret: 'kitesecret456' });
  assert.equal(r.status, 200);
  r = await req('GET', '/api/kite/login-url');
  assert.match(r.body.url, /kite\.zerodha\.com\/connect\/login\?v=3&api_key=kitekey123/);
  r = await req('GET', '/api/kite/callback?status=success&request_token=reqtok');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/accounts?kite=synced');
  const k = (await req('GET', '/api/kite')).body;
  assert.equal(k.tokenFresh, true);
  assert.equal(k.holdings.length, 2);
  const nifty = k.holdings.find((h: any) => h.instrument === 'NIFTYBEES');
  assert.equal(nifty.value_paise, 27_050_00);
  assert.deepEqual(calls, ['POST /session/token', 'GET /portfolio/holdings', 'GET /mf/holdings']);
  const [secret] = await sql<{ api_secret_enc: string; access_token_enc: string }[]>`select api_secret_enc, access_token_enc from kite_link`;
  assert.ok(!secret.api_secret_enc.includes('kitesecret456') && !secret.access_token_enc.includes('tok_123'), 'secrets are encrypted at rest');
  const nw = (await req('GET', '/api/networth')).body;
  const zerodha = nw.accounts.find((a: any) => a.name === 'Zerodha');
  assert.equal(zerodha.balance, 27_050_00 + Math.round(10.5 * 89.2332 * 100));
});

test('logout ends the session', async () => {
  await req('POST', '/api/auth/logout');
  cookie = '';
  const r = await req('GET', '/api/accounts');
  assert.equal(r.status, 401);
});
