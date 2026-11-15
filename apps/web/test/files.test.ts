import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { excelRows, rowsToGrid, pdfTableGrid, textRows, type Row } from '../src/files.ts';
import { parseStatementGrid, isStatementHeader } from '../src/statement.ts';

test('Excel bank statement: empty debit/credit cells keep columns aligned', async () => {
  const ws = XLSX.utils.aoa_to_sheet([
    ['Statement of account'], [],
    ['Tran Date', 'Particulars', 'Debit', 'Credit', 'Balance'],
    ['01-11-2026', 'UPI/P2M/612345678901/SWIGGY/Pay', '450.00', '', '9,550.00'],
    ['02-11-2026', 'NEFT/ACME LABS/SALARY OCT', '', '64,500.00', '74,050.00'],
  ]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const file = new File([buf], 'statement.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const p = parseStatementGrid(rowsToGrid(await excelRows(file)));
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0].amount, -450_00);
  assert.equal(p.rows[1].amount, 64_500_00);
});

test('PDF statement table: values land under their headers; wrapped narration joins its row', () => {
  const R = (y: number, ...cells: [number, string][]): Row => ({ y, cells: cells.map(([x, text]) => ({ x, text, w: text.length * 4.5 })) });
  const rows: Row[] = [
    R(80, [40, 'Account Statement']),
    R(120, [40, 'Date'], [110, 'Narration'], [330, 'Withdrawal'], [410, 'Deposit'], [490, 'Balance']),
    R(135, [40, '01/11/26'], [110, 'UPI-ZOMATO-zomato@hdfc'], [336, '320.00'], [494, '9,680.00']),
    R(146, [110, 'ORDER 5541']),
    R(158, [40, '02/11/26'], [110, 'IMPS-RAHUL-repay'], [414, '2,000.00'], [494, '11,680.00']),
  ];
  const grid = pdfTableGrid(rows, isStatementHeader);
  assert.equal(grid.length, 3);
  assert.equal(grid[1][1], 'UPI-ZOMATO-zomato@hdfc ORDER 5541');
  const p = parseStatementGrid(grid);
  assert.deepEqual(p.rows.map((r) => r.amount), [-320_00, 2_000_00]);
});

test('text files: picks the delimiter (comma, tab, semicolon)', () => {
  assert.deepEqual(textRows('a;b;c\n1;2;3').map((r) => r.cells.map((c) => c.text)), [['a', 'b', 'c'], ['1', '2', '3']]);
  assert.deepEqual(textRows('a\tb\n"x, y"\t2').map((r) => r.cells.map((c) => c.text)), [['a', 'b'], ['x, y', '2']]);
  assert.deepEqual(textRows('name,amt\n"Rao, S",1,200').map((r) => r.cells.length), [2, 3]);
});
