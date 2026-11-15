import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePayslip } from '../src/payslip.ts';
import { textRows, type Row } from '../src/files.ts';

// Rows shaped like pdf.js output from a two-column payslip (made-up company and amounts).
const R = (y: number, ...cells: [number, string][]): Row => ({ y, cells: cells.map(([x, text]) => ({ x, text, w: text.length * 4 })) });
const twoCol: Row[] = [
  R(43, [220, 'ACME LABS PVT. LTD.']),
  R(136, [232, 'Payslip for the month of October 2026']),
  R(257, [24, 'Company'], [162, 'Acme Labs Pvt. Ltd.']),
  R(284, [24, 'Earnings'], [302, 'Deductions']),
  R(296, [24, 'Particulars'], [157, 'Rates/Month'], [263, 'Amount'], [302, 'Particulars'], [541, 'Amount']),
  R(307, [24, 'Basic Salary'], [171, '50,000.00'], [262, '48,000.00'], [302, 'Profession Tax'], [550, '200.00']),
  R(318, [24, 'House Rent Allowance'], [171, '20,000.00'], [262, '20,000.00'], [302, 'Provident Fund'], [544, '1,800.00']),
  R(329, [24, 'Internet Charges'], [175, '1,000.00'], [266, '1,000.00'], [302, 'Income Tax'], [544, '2,500.00']),
  R(336, [24, 'Reimbursement']),
  R(374, [24, 'Total Earnings'], [160, '71,000.00'], [251, '69,000.00'], [302, 'Total Deductions'], [540, '4,500.00']),
  R(390, [24, 'In words ( ) : Sixty Four Thousand Five Hundred Only'], [483, 'Net Salary : 64,500.00']),
];

test('payslip: two-column PDF layout, wrapped names, actual (not rate) amounts, kinds', () => {
  const s = parsePayslip(twoCol);
  assert.equal(s.month, '2026-10');
  assert.equal(s.employer, 'Acme Labs Pvt. Ltd.');
  assert.deepEqual(s.earnings.map((e) => [e.name, e.monthly]), [['Basic Salary', 48_000_00], ['House Rent Allowance', 20_000_00], ['Internet Charges Reimbursement', 1_000_00]]);
  assert.deepEqual(s.deductions.map((d) => [d.name, d.kind, d.monthly]), [['Profession Tax', 'pt', 200_00], ['Provident Fund', 'pf', 1_800_00], ['Income Tax', 'tds', 2_500_00]]);
  assert.equal(s.gross, 69_000_00);
  assert.equal(s.net, 64_500_00);
  assert.deepEqual(s.warnings, []);
});

test('payslip: one-column CSV export (earnings block, then deductions block)', () => {
  const csv = `Acme Labs Pvt Ltd,
Salary slip,September 2026
Earnings,Amount
Basic,40000
HRA,16000
Special Allowance,12000
Total Earnings,68000
Deductions,Amount
EPF,1800
Professional Tax,200
TDS,3000
Total Deductions,5000
Net Pay,63000`;
  const s = parsePayslip(textRows(csv));
  assert.equal(s.month, '2026-09');
  assert.equal(s.earnings.length, 3);
  assert.deepEqual(s.deductions.map((d) => d.kind), ['pf', 'pt', 'tds']);
  assert.equal(s.net, 63_000_00);
  assert.deepEqual(s.warnings, []);
});

test('payslip: Excel-style side-by-side columns', () => {
  const csv = `Pay slip for Aug 2026
Earnings,Amount,Deductions,Amount
Basic,30000,PF,1800
HRA,12000,Professional Tax,200
Conveyance,1600,,
Total Earnings,43600,Total Deductions,2000
Net Salary,41600`;
  const s = parsePayslip(textRows(csv));
  assert.equal(s.month, '2026-08');
  assert.equal(s.earnings.length, 3);
  assert.equal(s.deductions.length, 2);
  assert.equal(s.net, 41_600_00);
  assert.deepEqual(s.warnings, []);
});

test('payslip: mismatched totals produce a warning instead of silently saving', () => {
  const s = parsePayslip(textRows(`Payslip October 2026\nEarnings,Amount\nBasic,30000\nTotal Earnings,35000\nDeductions,Amount\nPF,1800\nNet Pay,28200`));
  assert.ok(s.warnings.some((w) => /Earnings add up/.test(w)));
});
