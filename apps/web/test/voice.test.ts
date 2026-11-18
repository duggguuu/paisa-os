import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSpoken } from '../src/voice.ts';

// Fixture ids are the names themselves, so expectations read naturally.
const ctx = { ...JSON.parse(fs.readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8')), today: '2026-11-14' };
const cases: [string, Record<string, unknown>][] = [
  ['spent 450 on Swiggy from ICICI card yesterday', { kind: 'expense', amount: '450', merchant: 'Swiggy', categoryId: 'Delivery', accountId: 'ICICI Credit Card', date: '2026-11-13' }],
  ['Paid ₹1,200 for groceries at DMart using SBI', { amount: '1200', merchant: 'Dmart', categoryId: 'Groceries', accountId: 'SBI' }],
  ['uber 320', { amount: '320', merchant: 'Uber', categoryId: 'Cab & auto' }],
  ['two thousand five hundred rent from ICICI bank', { amount: '2500', categoryId: 'Rent', accountId: 'ICICI Bank' }],
  ['coffee at third wave 280 cash', { amount: '280', merchant: 'Third Wave', categoryId: 'Orders', accountId: 'Cash' }],
  ['bought coffee beans 650 from SBI', { amount: '650', categoryId: 'Beans', accountId: 'SBI' }],
  ['new coffee grinder 4500 on ICICI card', { amount: '4500', categoryId: 'Equipment', accountId: 'ICICI Credit Card' }],
  ['chai 40 cash', { amount: '40', categoryId: 'Snacks', accountId: 'Cash' }],
  ['got salary 68k in SBI', { kind: 'income', amount: '68000', categoryId: 'Salary', accountId: 'SBI' }],
  ['transfer 5000 from SBI to PhonePe wallet', { kind: 'transfer', amount: '5000', accountId: 'SBI', toAccountId: 'PhonePe Wallet' }],
  ['dinner 1800 on ICICI card split with Aditi and Rohan', { categoryId: 'Dining out', accountId: 'ICICI Credit Card', splitWith: ['Aditi', 'Rohan'] }],
  ['petrol 2k on 12th', { amount: '2000', categoryId: 'Fuel', date: '2026-11-12' }],
  ['movie tickets 600 last friday phonepe', { categoryId: 'Movies & events', accountId: 'PhonePe Wallet', date: '2026-11-13' }],
  ['paid credit card bill 26000 from sbi to icici credit card', { kind: 'transfer', amount: '26000', accountId: 'SBI', toAccountId: 'ICICI Credit Card' }],
  ['medicines 340 at apollo 3 days ago', { merchant: 'Apollo', categoryId: 'Medicines', date: '2026-11-11' }],
];
for (const [phrase, want] of cases) {
  test(`voice: "${phrase}"`, () => {
    const got = parseSpoken(phrase, ctx) as Record<string, unknown>;
    for (const [k, v] of Object.entries(want)) assert.deepEqual(got[k], v, `${k} for "${phrase}"`);
  });
}
