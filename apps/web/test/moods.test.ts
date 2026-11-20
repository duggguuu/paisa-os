import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MOODS, MOOD_GROUPS, payMethodFromText, moodFromText } from '../src/moods.ts';

test('mood list matches the server list and every mood has a group', () => {
  const src = fs.readFileSync(new URL('../../api/src/ledger.ts', import.meta.url), 'utf8');
  const server = JSON.parse(src.match(/export const MOODS = (\[[^\]]*\])/)![1].replace(/'/g, '"'));
  assert.deepEqual(MOODS.map((m) => m.id).sort(), [...server].sort());
  for (const m of MOODS) assert.ok(MOOD_GROUPS.some((g) => g.id === m.group), m.id);
});

test('payment method and mood from a sentence', () => {
  assert.equal(payMethodFromText('450 at Starbucks via UPI'), 'upi');
  assert.equal(payMethodFromText('paid with GPay'), 'upi');
  assert.equal(payMethodFromText('2000 on my SBI debit card'), 'debit_card');
  assert.equal(payMethodFromText('rent by net banking'), 'netbanking');
  assert.equal(payMethodFromText('sent via NEFT'), 'netbanking');
  assert.equal(payMethodFromText('lunch 300'), null);
  assert.equal(moodFromText('impulse buy on Amazon 2999'), 'impulse');
  assert.equal(moodFromText('splurged on headphones'), 'splurge');
  assert.equal(moodFromText('groceries 800'), null);
});
