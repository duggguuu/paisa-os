import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseStatement, guessBooking, extractMerchant } from '../src/statement.ts';
import { parseReceipt } from '../src/receipt.ts';
import { parseCasText } from '../src/cas.ts';

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));

// Axis-style CSV: preamble lines, then Tran Date / CHQNO / PARTICULARS / DR / CR / BAL / SOL.
const AXIS = `Name :- SAM RAO
Account No :- 9180XXXXXXXX1234
Statement of Account No - 9180XXXXXXXX1234 for the period (From : 01-10-2026 To : 31-10-2026)

Tran Date,CHQNO,PARTICULARS,DR,CR,BAL,SOL
01-10-2026,,OPENING BALANCE,,,"1,00,000.00",
02-10-2026,,UPI/P2M/427512345678/SWIGGY LIMITED/Payment/AXIS BANK,450.00,,"99,550.00",4567
03-10-2026,,NEFT/AXISN12345678901/ACME TECHNOLOGIES PVT LTD/SALARY OCT,,"1,20,000.00","2,19,550.00",4567
05-10-2026,,ATM-WDL/MUMBAI ANDHERI/1234,"5,000.00",,"2,14,550.00",4567
07-10-2026,,BILLDESK/HDFC CREDIT CARD PAYMENT/AB12,"26,257.00",,"1,88,293.00",4567
10-10-2026,,ACH-DR/ICCL ZERODHA/SIP,"10,000.00",,"1,78,293.00",4567
31-10-2026,,Int.Pd:9180XXXXXXXX1234:01-07-2026 to 30-09-2026,,812.00,"1,79,105.00",4567
`;

// HDFC "delimited" export: Date / Narration / Chq./Ref.No. / Value Dt / Withdrawal Amt. / Deposit Amt. / Closing Balance
const HDFC = `  Date     ,Narration                                         ,Chq./Ref.No.    ,Value Dt ,Withdrawal Amt.  ,Deposit Amt.     ,Closing Balance
 ********,********,********,********,********,********,********
 01/11/26 ,UPI-ZOMATO LTD-ZOMATO.PAYU@AXISBANK-UTIB0000100-431212345678-ZOMATO ORDER ,0000431212345678,01/11/26 ,          620.00 ,             0.00 ,        48140.00
 02/11/26 ,UPI-RAHUL SHARMA-RAHUL@OKICICI-ICIC0001234-431298765432-DINNER SPLIT ,0000431298765432,02/11/26 ,            0.00 ,           800.00 ,        48940.00
 03/11/26 ,POS 416021XXXXXX1234 DMART AVENUE SUPERM ,000000000000000,03/11/26 ,        2345.50 ,             0.00 ,        46594.50
`;

test('statement: Axis CSV with a preamble', () => {
  const s = parseStatement(AXIS);
  assert.equal(s.rows.length, 6, 'opening balance line has no amount');
  assert.deepEqual(s.rows[0], { date: '2026-10-02', description: 'UPI/P2M/427512345678/SWIGGY LIMITED/Payment/AXIS BANK', amount: -450_00, balance: 99_550_00, ref: '427512345678', merchant: 'Swiggy' });
  assert.equal(s.rows[1].amount, 1_20_000_00);
  assert.equal(s.rows[1].merchant, 'Acme');
  assert.deepEqual(s.closing, { balance: 1_79_105_00, date: '2026-10-31' });
});

test('statement: HDFC delimited export', () => {
  const s = parseStatement(HDFC);
  assert.equal(s.rows.length, 3);
  assert.equal(s.rows[0].date, '2026-11-01');
  assert.equal(s.rows[0].amount, -620_00);
  assert.equal(s.rows[0].merchant, 'Zomato');
  assert.equal(s.rows[0].ref, '431212345678');
  assert.equal(s.rows[1].amount, 800_00);
  assert.equal(s.rows[2].merchant, 'Dmart Avenue Superm');
  assert.deepEqual(s.closing, { balance: 46_594_50, date: '2026-11-03' });
});

test('statement: booking guesses (ATM → cash, card bill, SIP, salary, interest, food)', () => {
  const accounts = [
    { id: 'axis', name: 'SBI', kind: 'bank' }, { id: 'cash', name: 'Cash', kind: 'cash' },
    { id: 'card', name: 'ICICI Credit Card', kind: 'credit_card' }, { id: 'inv', name: 'Zerodha', kind: 'investment' },
  ];
  const ctx = { accounts, categories: fx.categories, accountId: 'axis' };
  const rows = parseStatement(AXIS).rows;
  const g = rows.map((r) => guessBooking(r, ctx));
  assert.deepEqual(g[0], { kind: 'expense', categoryId: 'Delivery', otherAccountId: null });
  assert.deepEqual(g[1], { kind: 'income', categoryId: 'Salary', otherAccountId: null });
  assert.deepEqual(g[2], { kind: 'transfer', categoryId: null, otherAccountId: 'cash' });
  assert.deepEqual(g[3], { kind: 'transfer', categoryId: null, otherAccountId: 'card' });
  assert.deepEqual(g[4], { kind: 'transfer', categoryId: null, otherAccountId: 'inv' });
  assert.deepEqual(g[5], { kind: 'income', categoryId: 'Interest', otherAccountId: null });
  assert.equal(extractMerchant('NEFT CR-HDFC0000001-ACME CORP-SAM-HDFCN52026'), 'Acme Corp');
});

test('receipt: total, date and shop from OCR text', () => {
  const ocr = `THIRD WAVE COFFEE ROASTERS
Indiranagar, Bengaluru
GSTIN: 29ABCDE1234F1Z5
Tax Invoice
Date: 12/11/2026 Time: 18:42
Cappuccino 1 x 280.00 280.00
Croissant 1 x 220.00 220.00
Sub Total 500.00
CGST 2.5% 12.50
SGST 2.5% 12.50
Grand Total ₹ 525.00
Cash 600.00 Change 75.00`;
  assert.deepEqual(parseReceipt(ocr, '2026-11-14'), { amount: '525', date: '2026-11-12', merchant: 'Third Wave Coffee Roasters' });
});

test('CAS: detailed CAMS/KFintech statement', () => {
  const text = `Consolidated Account Statement
01-Apr-2026 To 31-Oct-2026
Folio No: 12345678 / 90 PAN: ABCDE1234F KYC: OK
B205RG-Axis Bluechip Fund - Direct Growth - ISIN: INF846K01DP8(Advisor: DIRECT) Registrar : KFINTECH
Opening Unit Balance: 1,000.000
10-Apr-2026 Purchase - SIP 5,000.00 95.238 52.50 1,095.238
Closing Unit Balance: 1,095.238 NAV on 31-Oct-2026: INR 58.40 Total Cost Value: 57,500.00 Market Value on 31-Oct-2026: INR 63,961.90
Folio No: 9988776 PAN: ABCDE1234F
P8R2-Parag Parikh Flexi Cap Fund - Direct Plan Growth - ISIN: INF879O01027(Advisor: DIRECT) Registrar : CAMS
Closing Unit Balance: 512.345 NAV on 31-Oct-2026: INR 89.2332 Total Cost Value: 40,000.00 Market Value on 31-Oct-2026: INR 45,718.39
`;
  const r = parseCasText(text);
  assert.equal(r.statementDate, '2026-10-31');
  assert.equal(r.holdings.length, 2);
  assert.deepEqual(r.holdings[0], { isin: 'INF846K01DP8', name: 'Axis Bluechip Fund - Direct Growth', folio: '12345678 / 90', units: 1095.238, nav: 58.4, value: 63961.9, cost: 57500 });
  assert.equal(r.holdings[1].name, 'Parag Parikh Flexi Cap Fund - Direct Plan Growth');
  assert.equal(r.holdings[1].value, 45718.39);
});

test('Splitwise export: rows, person columns, total row ignored, "you" guessed across files', async () => {
  const { parseSplitwiseCsv, guessMe } = await import('../src/splitwise-csv.ts');
  const group = parseSplitwiseCsv(`Date,Description,Category,Cost,Currency,Sam R,Kabir M,Meera P
2026-02-10,BigBasket order,Groceries,1200.00,INR,800.00,-400.00,-400.00
2026-03-01,Kabir M. paid Sam R.,Payment,300.00,INR,-300.00,300.00,0.00

2026-11-14,Total balance, , ,INR,500.00,-100.00,-400.00
`, 'Flat.csv');
  assert.deepEqual(group.people, ['Sam R', 'Kabir M', 'Meera P']);
  assert.equal(group.rows.length, 2, 'the Total balance row has no cost, so it is skipped');
  const real = group.rows.filter((r) => r.description !== 'Total balance');
  assert.deepEqual(real[0], { date: '2026-02-10', description: 'BigBasket order', category: 'Groceries', cost: 1200_00, currency: 'INR', nets: { 'Sam R': 800_00, 'Kabir M': -400_00, 'Meera P': -400_00 } });
  const friend = parseSplitwiseCsv('Date,Description,Category,Cost,Currency,Sam R,Kabir M\n2026-02-20,Movie,Movies,600,INR,300,-300\n', 'Kabir.csv');
  assert.equal(guessMe([group, friend]), null, 'ambiguous with one friend export: the app asks');
  const friend2 = parseSplitwiseCsv('Date,Description,Category,Cost,Currency,Riya T,Sam R\n2026-04-02,Cab,Taxi,400,INR,-200,200\n', 'Riya.csv');
  assert.equal(guessMe([group, friend, friend2]), 'Sam R');
});

// <personal> Uses the owner's own data; removed from exports.
const HAS_HM = fs.existsSync(new URL('./hm-ocr.json', import.meta.url));  // personal fixture; not in clean exports
test('orders: the H&M order from real OCR of three overlapping screenshots', { skip: !HAS_HM && 'no personal OCR fixture in this copy' }, async () => {
  const { parseOrderText, mergeOrders } = await import('../src/orders.ts');
  const ocr = JSON.parse(fs.readFileSync(new URL('./hm-ocr.json', import.meta.url), 'utf8'));
  const o = mergeOrders(['13', '14', '15'].map((k) => parseOrderText(ocr[k])));
  assert.equal(o.store, 'H&M');
  assert.equal(o.total, 1167520);
  assert.equal(o.payment, 'UPI');
  assert.deepEqual(o.items.map((i) => i.name), ['Regular Fit Cotton Henley Top', 'Relaxed Fit Printed Cotton Poplin Shirt', 'Loose Straight Jeans', 'Regular Fit Waffled Henley Top', 'Overshirt', 'Regular Fit Shirt']);
  assert.deepEqual(o.items.map((i) => i.artNo), ['1365507002013', '1363609001013', '1357868008021', '1357940002013', '1351283001013', '1309692005013']);
  assert.deepEqual(o.items.map((i) => i.paid), [159920, 183920, 239920, 183920, 239920, 159920], 'last line total comes from the order total');
  assert.equal(o.items.reduce((s, i) => s + (i.paid ?? 0), 0), o.total);
  assert.equal(o.items[2].size, '30/32');
  assert.equal(o.items[2].category, 'Clothes — bottoms');
  assert.equal(o.items[0].colour, 'Dark brown');
});
// </personal>

test('orders: bought/sold sentences', async () => {
  const { parseStuffSentence } = await import('../src/orders.ts');
  let s = parseStuffSentence('bought an Anker charger for 2,499 and a USB-C cable for 499 from Amazon on ICICI card');
  assert.equal(s.kind, 'buy');
  assert.deepEqual(s.items, [{ name: 'Anker charger', amount: 249900 }, { name: 'USB-C cable', amount: 49900 }]);
  assert.equal(s.total, 299800);
  assert.equal(s.store, 'Amazon');
  s = parseStuffSentence('sold my Galaxy S21 for 30k');
  assert.equal(s.kind, 'sell');
  assert.deepEqual(s.items, [{ name: 'Galaxy S21', amount: 3000000 }]);
});

test('splitwise: balances from a friends-list screenshot', async () => {
  const { parseSplitwiseBalances } = await import('../src/orders.ts');
  const ocr = `9:41
Overall, you are owed ₹2,350.00
Rohan Sharma
owes you
₹1,200.00
Aditi
you owe
₹450.00
Kabir M owes you ₹1,600.00
Meera settled up
Q Friends Groups Activity Account`;
  assert.deepEqual(parseSplitwiseBalances(ocr), [
    { name: 'Rohan Sharma', amount: 120000 }, { name: 'Aditi', amount: -45000 }, { name: 'Kabir M', amount: 160000 }, { name: 'Meera', amount: 0 },
  ]);
});
