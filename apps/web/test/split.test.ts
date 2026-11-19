import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSplit } from '../src/split-math.ts';

const T = 1000_00;
test('split equally: remainder paise stay with you', () => {
  const r = computeSplit(100_01, 'equal', ['a', 'b'], '', {});
  assert.deepEqual(r.others.map((o) => o.amount), [33_33, 33_33]);
  assert.equal(r.mine, 33_35);
});
test('split by %: my share typed, the rest divided among the blanks', () => {
  const r = computeSplit(T, 'percent', ['a', 'b'], '40', {});
  assert.equal(r.mine, 400_00);
  assert.deepEqual(r.others.map((o) => o.amount), [300_00, 300_00]);
  const r2 = computeSplit(T, 'percent', ['a', 'b'], '40', { a: '35' });
  assert.deepEqual([r2.mine, ...r2.others.map((o) => o.amount)], [400_00, 350_00, 250_00]);
  const r3 = computeSplit(T, 'percent', ['a'], '', { a: '30' });
  assert.equal(r3.mine, 700_00, 'blank "you" takes the rest');
  assert.equal(computeSplit(T, 'percent', ['a', 'b'], '0', {}).mine, 0, 'you can pay entirely for others');
});
test('split by %: totals must make 100%', () => {
  assert.match(computeSplit(T, 'percent', ['a'], '60', { a: '50' }).error!, /more than 100%/);
  assert.match(computeSplit(T, 'percent', ['a'], '30', { a: '50' }).error!, /need to make 100%/);
  assert.match(computeSplit(T, 'percent', ['a'], 'x', {}).error!, /numbers/);
});
test('split by ₹ and odd percentages always add up to the total', () => {
  const r = computeSplit(T, 'amount', ['a', 'b'], '', { a: '250.50' });
  assert.equal(r.others[0].amount, 250_50);
  assert.equal(r.mine + r.others.reduce((s, o) => s + o.amount, 0), T);
  const r2 = computeSplit(999_99, 'percent', ['a', 'b'], '', {});
  assert.equal(r2.mine + r2.others.reduce((s, o) => s + o.amount, 0), 999_99);
  assert.match(computeSplit(T, 'amount', ['a'], '600', { a: '500' }).error!, /more than the total/);
});
