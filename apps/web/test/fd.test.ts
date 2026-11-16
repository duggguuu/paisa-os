import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMonthsIso, maturityFrom, tenureBetween, tenureLabel, maturityValue, effectiveYield, findBank, rateFor } from '../src/fd-math.ts';

test('FD tenure ↔ maturity date', () => {
  assert.equal(maturityFrom('2026-11-16', { y: 1, m: 3, d: 0 }), '2028-02-16');
  assert.equal(maturityFrom('2026-11-16', { y: 0, m: 0, d: 444 }), '2028-02-03');
  assert.equal(addMonthsIso('2026-01-31', 1), '2026-02-28', 'month-end clamps');
  assert.deepEqual(tenureBetween('2026-11-16', '2028-02-16'), { y: 1, m: 3, d: 0 });
  assert.deepEqual(tenureBetween('2026-11-16', '2027-12-01'), { y: 1, m: 0, d: 15 });
  assert.equal(tenureLabel({ y: 1, m: 3, d: 0 }), '1 yr 3 mo');
  assert.equal(tenureLabel({ y: 0, m: 0, d: 1 }), '1 day');
});

test('FD maturity value and yield', () => {
  assert.equal(maturityValue(1_00_000_00, 7, 365, 'quarterly'), 1_07_185_90); // same as the server
  assert.equal(maturityValue(1_00_000_00, 7, 365, 'simple'), 1_07_000_00);
  assert.equal(effectiveYield(1_00_000_00, 1_07_185_90, 365)!.toFixed(2), '7.19');
  assert.equal(effectiveYield(0, 1, 1), null);
});

test('FD bank matching and tenure rates', () => {
  const table = { asOf: '2026-11-11', source: 'x', sourceUrl: 'x', live: false, banks: [
    { bank: 'State Bank of India', highest: 6.45, y1: 6.25, y3: 6.3, y5: 6.05 },
    { bank: 'HDFC Bank', highest: 6.6, y1: 6.25, y3: 6.55, y5: 6.6 },
    { bank: 'Post Office', highest: 7.5, y1: 6.9, y2: 7.0, y3: 7.1, y5: 7.5 },
  ] };
  assert.equal(findBank(table, 'SBI')?.bank, 'State Bank of India');
  assert.equal(findBank(table, 'hdfc')?.bank, 'HDFC Bank');
  assert.equal(findBank(table, 'HDFC Bank')?.bank, 'HDFC Bank');
  assert.equal(findBank(table, 'Some Coop Bank'), null);
  const hdfc = table.banks[1];
  assert.deepEqual(rateFor(hdfc, 12), { rate: 6.25, label: '1-year' });
  assert.equal(rateFor(hdfc, 24).rate, 6.4);
  assert.equal(rateFor(table.banks[2], 24).rate, 7.0);
  assert.equal(rateFor(hdfc, 36).rate, 6.55);
  assert.equal(rateFor(hdfc, 60).rate, 6.6);
});
