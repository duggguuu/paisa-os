import { test } from 'node:test';
import assert from 'node:assert/strict';
import { money, compact, maskText, maskNum, setPrivate, MASK } from '../src/lib.ts';

test('privacy mode hides every amount, in any format, and shows them again', () => {
  setPrivate(true);
  assert.equal(money(1_23_456_78), MASK);
  assert.equal(money(-500_00, { whole: true }), MASK, 'sign hidden too');
  assert.equal(compact(98_40_000_00), MASK);
  assert.equal(money(5), money(9_99_99_999_00), 'same mask for small and huge amounts');
  const t = maskText('You spent ₹12,400 on Food, 18% above usual. Rs 500 cashback; INR 2,000 refund; about 1.2 lakh saved; ₹3.4k left; 2 crore goal.');
  assert.ok(!/\d{3}|1\.2|3\.4|2 crore/.test(t), t);
  assert.ok(t.includes('18%'), 'percentages stay');
  assert.equal(maskNum('12.5'), '•••••');
  setPrivate(false);
  assert.equal(money(1_23_456_78), '₹1,23,456.78');
  assert.equal(maskText('₹12,400'), '₹12,400');
});
