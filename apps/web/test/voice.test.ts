import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSpoken } from '../src/voice.ts';

// Fixture ids are the names themselves, so expectations read naturally.
const ctx = { ...JSON.parse(fs.readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8')), today: '2026-11-14' };
const cases: [string, Record<string, unknown>][] = [
  ['spent 450 on Swiggy from HDFC card yesterday', { kind: 'expense', amount: '450', merchant: 'Swiggy', categoryId: 'Delivery', accountId: 'HDFC Millennia Card', date: '2026-11-13' }],
  ['Paid ₹1,200 for groceries at DMart using Axis bank', { amount: '1200', merchant: 'Dmart', categoryId: 'Groceries', accountId: 'Axis Bank' }],
  ['uber 320', { amount: '320', merchant: 'Uber', categoryId: 'Cab & auto' }],
  ['two thousand five hundred rent from HDFC bank', { amount: '2500', categoryId: 'Rent', accountId: 'HDFC Bank' }],
  ['coffee at third wave 280 cash', { amount: '280', merchant: 'Third Wave', categoryId: 'Snacks & coffee', accountId: 'Cash' }],
  ['got salary 1.2 lakh in Axis', { kind: 'income', amount: '120000', categoryId: 'Salary', accountId: 'Axis Bank' }],
  ['transfer 5000 from Axis bank to Paytm wallet', { kind: 'transfer', amount: '5000', accountId: 'Axis Bank', toAccountId: 'Paytm Wallet' }],
  ['dinner 1800 on HDFC card split with Aditi and Rohan', { categoryId: 'Dining out', accountId: 'HDFC Millennia Card', splitWith: ['Aditi', 'Rohan'] }],
  ['petrol 2k on 12th', { amount: '2000', categoryId: 'Fuel', date: '2026-11-12' }],
  ['movie tickets 600 last friday paytm', { categoryId: 'Movies & events', accountId: 'Paytm Wallet', date: '2026-11-13' }],
  ['paid credit card bill 26000 from axis to hdfc millennia card', { kind: 'transfer', amount: '26000', accountId: 'Axis Bank', toAccountId: 'HDFC Millennia Card' }],
  ['medicines 340 at apollo 3 days ago', { merchant: 'Apollo', categoryId: 'Medicines', date: '2026-11-11' }],
];
for (const [phrase, want] of cases) {
  test(`voice: "${phrase}"`, () => {
    const got = parseSpoken(phrase, ctx) as Record<string, unknown>;
    for (const [k, v] of Object.entries(want)) assert.deepEqual(got[k], v, `${k} for "${phrase}"`);
  });
}
