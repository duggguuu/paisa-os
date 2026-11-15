import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newRegimeTax } from '../src/tax.ts';

test('new regime: ₹12.75L salary is tax-free (₹75k standard deduction + 87A rebate)', () => {
  const r = newRegimeTax({ salary: 12_75_000 });
  assert.equal(r.taxable, 12_00_000);
  assert.equal(r.total, 0);
});

test('new regime: marginal relief just above ₹12L', () => {
  const r = newRegimeTax({ salary: 13_00_000 });     // taxable 12.25L: slab tax 63,750, capped at the 25,000 above 12L
  assert.equal(r.taxable, 12_25_000);
  assert.equal(r.slabTax, 63_750);
  assert.equal(r.total, 26_000);                        // 25,000 + 4% cess
});

test('new regime: ₹20L and ₹30L salaries', () => {
  assert.equal(newRegimeTax({ salary: 20_00_000 }).total, 1_92_400);  // taxable 19.25L → 1,85,000 + cess
  assert.equal(newRegimeTax({ salary: 30_00_000 }).total, 4_75_800);  // taxable 29.25L → 4,57,500 + cess
});

test('new regime: 10% surcharge above ₹50L', () => {
  const r = newRegimeTax({ salary: 60_00_000 });      // taxable 59.25L → 13,57,500 + 10% surcharge + cess
  assert.equal(r.surcharge, 1_35_750);
  assert.equal(r.total, 15_52_980);
});

test("employer NPS is deductible up to 14% of basic + DA", () => {
  const r = newRegimeTax({ salary: 15_00_000, basicDa: 6_00_000, employerNps: 1_00_000 });
  assert.equal(r.employerNps, 84_000);
  assert.equal(r.taxable, 15_00_000 - 75_000 - 84_000);
});
