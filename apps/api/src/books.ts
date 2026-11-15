import { z } from 'zod';
import type { Sql, Tx } from './db.js';
import { audit, LedgerError } from './ledger.js';
import { todayIST } from './money.js';

/**
 * Default category tree (category › subcategory). Icons are emoji so they render everywhere.
 * Existing names never change (past transactions point at them); new ones are added by migration 009
 * for books created before. Keep the two in step when you add defaults.
 */
export const DEFAULT_CATEGORIES: { expense: [string, string, string[]][]; income: [string, string, string[]][] } = {
  expense: [
    ['Food', '🍲', ['Groceries', 'Ration & staples', 'Vegetables & fruits', 'Milk & dairy', 'Meat, fish & eggs', 'Bakery & sweets', 'Drinking water', 'Dining out', 'Delivery', 'Snacks & coffee', 'Office meals']],
    ['Household help', '🧑‍🍳', ['Cook', 'Maid', 'Cleaning', 'Laundry & ironing', 'Driver', 'Babysitter & nanny', 'Gardener', 'Security & watchman']],
    ['Housing', '🏠', ['Rent', 'Maintenance', 'Electricity', 'Internet', 'Water & gas', 'Cooking gas (LPG)', 'Repairs & services', 'Furniture & furnishing', 'Appliances', 'Home decor', 'Pest control', 'Property tax', 'Brokerage & deposit']],
    ['Transport', '🛵', ['Fuel', 'Cab & auto', 'Public transport', 'Parking & tolls', 'Vehicle service', 'Train', 'Bike & car rental', 'FASTag recharge']],
    ['Vehicle', '🚗', ['Insurance', 'Spare parts & tyres', 'Accessories', 'Washing & detailing', 'Fines & challans', 'PUC & registration', 'Road tax']],
    ['Shopping', '🛍️', ['Apparel', 'Footwear', 'Accessories', 'Jewellery', 'Electronics', 'Household', 'Home & kitchen', 'Gifts given', 'Stationery', 'Online orders']],
    ['Bills & subscriptions', '🧾', ['Mobile', 'Subscriptions', 'Insurance', 'DTH & cable TV', 'OTT streaming', 'Music streaming', 'Cloud & software', 'News & magazines']],
    ['Health', '🩺', ['Doctor', 'Medicines', 'Fitness', 'Medical tests & scans', 'Hospital', 'Dental', 'Eye care', 'Therapy & counselling', 'Physiotherapy', 'Vaccines', 'Supplements', 'Health insurance']],
    ['Personal care', '💈', ['Salon & grooming', 'Skincare', 'Cosmetics', 'Spa & massage', 'Toiletries']],
    ['Entertainment', '🎬', ['Movies & events', 'Games', 'Outings', 'Concerts & shows', 'Sports events', 'Adventure & activities']],
    ['Education', '📚', ['Courses', 'Books', 'School fees', 'College fees', 'Coaching & tuition', 'Exam fees', 'Online learning', 'Stationery & supplies']],
    ['Travel', '✈️', ['Flights & trains', 'Stays', 'Local travel', 'Visa & passport', 'Travel insurance', 'Food on trips', 'Sightseeing', 'Forex & card fees']],
    ['Family', '👪', ['Parents', 'Siblings', 'Partner', 'Relatives', 'Elder care']],
    ['Kids', '🧸', ['Daycare', 'School supplies', 'Toys', 'Clothes', 'Activities & classes', 'Baby care']],
    ['Pets', '🐾', ['Pet food', 'Vet', 'Grooming', 'Pet supplies']],
    ['Social life', '🍻', ['Parties', 'Drinks', 'Treats for friends', 'Dates']],
    ['Gifts & occasions', '🎁', ['Birthdays', 'Weddings', 'Festivals', 'Anniversaries']],
    ['Hobbies', '🎨', ['Sports & gear', 'Music', 'Photography', 'Gaming', 'Arts & crafts']],
    ['Religious & charity', '🪔', ['Donations', 'Temple & worship', 'Pooja items', 'Religious events']],
    ['Work', '💼', ['Office supplies', 'Co-working', 'Professional fees', 'Work travel', 'Memberships']],
    ['Fees & charges', '🏦', ['Bank charges', 'Interest paid', 'Late fees', 'Card annual fee', 'Processing fees', 'Convenience fees', 'Brokerage']],
    ['Taxes', '🧮', ['Income tax', 'Advance tax', 'GST', 'Professional tax']],
    ['Other', '•', []],
  ],
  income: [
    ['Salary', '💼', ['Bonus', 'Incentive & commission', 'Arrears', 'Leave encashment']],
    ['Business & freelance', '🧑‍💻', ['Freelance', 'Consulting', 'Business income', 'Side projects']],
    ['Interest', '🏦', ['Savings interest', 'FD interest', 'RD interest', 'Bond interest']],
    ['Dividends', '📈', []],
    ['Capital gains', '📊', ['Stocks', 'Mutual funds', 'Property', 'Gold']],
    ['Rental income', '🏘️', ['House rent', 'Other rent']],
    ['Pension', '👵', []],
    ['Other income', '•', ['Prizes & winnings', 'Royalties']],
    ['Refunds & cashback', '↩️', ['Refunds', 'Cashback & rewards']],
    ['Gifts received', '🎁', ['Cash gifts', 'Shagun']],
    ['Money in (not income)', '📥', ['Repayments', 'From family', 'Reimbursements', 'Sold something', 'Deposit returned', 'Insurance claims', 'Other money in']],
  ],
};

/** Income categories that are money coming in but not earnings (excluded from income totals). */
export const NOT_INCOME = new Set(['Money in (not income)', 'Refunds & cashback', 'Gifts received']);

async function insertCategories(tx: Tx, bookId: string) {
  for (const cls of ['expense', 'income'] as const) {
    let sort = 0;
    for (const [name, icon, subs] of DEFAULT_CATEGORIES[cls]) {
      const meta = cls === 'income' && NOT_INCOME.has(name) ? { not_income: true } : {};
      const [parent] = await tx<{ id: string }[]>`
        insert into account (book_id, class, kind, name, icon, sort, meta) values (${bookId}, ${cls}, 'category', ${name}, ${icon}, ${sort++}, ${tx.json(meta)})
        returning id`;
      let s = 0;
      for (const sub of subs) {
        await tx`insert into account (book_id, class, kind, name, parent_id, sort, meta) values (${bookId}, ${cls}, 'category', ${sub}, ${parent.id}, ${s++}, ${tx.json(meta)})`;
      }
    }
  }
}

export async function createBook(tx: Tx, userId: string, name: string, isDemo: boolean): Promise<string> {
  const [book] = await tx<{ id: string }[]>`
    insert into book (user_id, name, is_demo) values (${userId}, ${name}, ${isDemo}) returning id`;
  await tx`insert into account (book_id, class, kind, name, sort) values (${book.id}, 'equity', 'equity', 'Opening balances', 0)`;
  await insertCategories(tx, book.id);
  return book.id;
}

/** Your real book starts with your stated accounts at zero; you enter the opening balances. */
export async function seedRealBookAccounts(tx: Tx, bookId: string, banks: string[] = []) {
  // Nothing personal is baked in: the owner names their banks at setup (or gets one generic account).
  const names = [...new Set(banks.map((b) => b.trim()).filter(Boolean))].slice(0, 6);
  const accounts: [string, string, string, string, object][] = [
    ...(names.length ? names : ['Bank account']).map((n, i): [string, string, string, string, object] =>
      [n, 'bank', names.length ? n : '', '🏦', i === 0 ? { salary: true, debit_card: true } : { debit_card: true }]),
    ['Cash', 'cash', '', '💵', {}],
  ];
  let sort = 0;
  for (const [name, kind, inst, icon, meta] of accounts) {
    await tx`insert into account (book_id, class, kind, name, institution, icon, meta, sort)
             values (${bookId}, 'asset', ${kind}, ${name}, ${inst || null}, ${icon}, ${tx.json(meta as any)}, ${sort++})`;
  }
}

const KIND_CLASS: Record<string, 'asset' | 'liability'> = {
  bank: 'asset', cash: 'asset', wallet: 'asset', fd: 'asset', investment: 'asset', receivable: 'asset',
  credit_card: 'liability', loan: 'liability', payable: 'liability',
};

export const AccountInput = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(['bank', 'cash', 'wallet', 'fd', 'investment', 'receivable', 'credit_card', 'loan', 'payable']),
  institution: z.string().trim().max(60).optional().nullable(),
  icon: z.string().max(8).optional().nullable(),
  color: z.string().max(20).optional().nullable(),
  // For assets: money you have. For liabilities: money you owe. Paise, may be 0.
  openingBalance: z.number().int().min(0).max(1e13).default(0),
  openingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export async function createAccount(sql: Sql, bookId: string, input: z.infer<typeof AccountInput>) {
  return sql.begin(async (tx) => {
    const cls = KIND_CLASS[input.kind];
    let row: { id: string };
    try {
      [row] = await tx<{ id: string }[]>`
        insert into account (book_id, class, kind, name, institution, icon, color, meta)
        values (${bookId}, ${cls}, ${input.kind}, ${input.name}, ${input.institution ?? null}, ${input.icon ?? null},
                ${input.color ?? null}, ${tx.json((input.meta ?? {}) as any)})
        returning id`;
    } catch (e: any) {
      if (e?.code === '23505') throw new LedgerError('duplicate_name', `an account named ${input.name} already exists`, 409);
      throw e;
    }
    if (input.openingBalance) await setOpeningBalance(tx, bookId, row.id, input.openingBalance, input.openingDate ?? todayIST());
    await audit(tx, bookId, 'account', row.id, 'create', null, input, 'user');
    return row.id;
  });
}

/** Opening balance is a single 'opening' transaction against the equity account; replaced on edit. */
export async function setOpeningBalance(tx: Tx, bookId: string, accountId: string, amount: number, date: string) {
  const [acc] = await tx<{ class: string }[]>`select class from account where id = ${accountId} and book_id = ${bookId}`;
  if (!acc) throw new LedgerError('account_not_found', 'account not found', 404);
  const [equity] = await tx<{ id: string }[]>`select id from account where book_id = ${bookId} and kind = 'equity' limit 1`;
  const existing = await tx<{ id: string }[]>`
    select t.id from txn t join posting p on p.txn_id = t.id
    where t.book_id = ${bookId} and t.kind = 'opening' and p.account_id = ${accountId}`;
  for (const e of existing) await tx`delete from txn where id = ${e.id}`;
  if (amount === 0) return;
  const signed = acc.class === 'asset' ? amount : -amount;
  const [t] = await tx<{ id: string }[]>`
    insert into txn (book_id, kind, occurred_on, description, source) values (${bookId}, 'opening', ${date}, 'Opening balance', 'manual')
    returning id`;
  await tx`insert into posting (txn_id, account_id, amount) values (${t.id}, ${accountId}, ${signed}), (${t.id}, ${equity.id}, ${-signed})`;
}

export const AccountPatch = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  institution: z.string().trim().max(60).optional().nullable(),
  icon: z.string().max(8).optional().nullable(),
  color: z.string().max(20).optional().nullable(),
  isArchived: z.boolean().optional(),
  openingBalance: z.number().int().min(0).max(1e13).optional(),
  openingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export async function updateAccount(sql: Sql, bookId: string, accountId: string, p: z.infer<typeof AccountPatch>) {
  await sql.begin(async (tx) => {
    const [before] = await tx<any[]>`select * from account where id = ${accountId} and book_id = ${bookId}`;
    if (!before) throw new LedgerError('account_not_found', 'account not found', 404);
    await tx`
      update account set
        name = ${p.name ?? before.name},
        institution = ${p.institution === undefined ? before.institution : p.institution},
        icon = ${p.icon === undefined ? before.icon : p.icon},
        color = ${p.color === undefined ? before.color : p.color},
        is_archived = ${p.isArchived ?? before.is_archived},
        meta = ${tx.json({ ...before.meta, ...(p.meta ?? {}) })}
      where id = ${accountId}`;
    if (p.openingBalance !== undefined) {
      if (before.kind === 'category' || before.kind === 'equity') throw new LedgerError('bad_account', 'categories have no opening balance');
      const [existing] = await tx<{ occurred_on: string }[]>`
        select t.occurred_on::text from txn t join posting p on p.txn_id = t.id
        where t.kind = 'opening' and p.account_id = ${accountId} limit 1`;
      await setOpeningBalance(tx, bookId, accountId, p.openingBalance, p.openingDate ?? existing?.occurred_on ?? todayIST());
    }
    await audit(tx, bookId, 'account', accountId, 'update', before, p, 'user');
  });
}

export const CategoryInput = z.object({
  name: z.string().trim().min(1).max(60),
  class: z.enum(['expense', 'income']),
  parentId: z.string().uuid().optional().nullable(),
  icon: z.string().max(16).optional().nullable(),
  /** New top-level income category only: money coming in that isn't earnings (excluded from income). */
  notIncome: z.boolean().optional(),
});

/** Categories the app itself relies on (fallbacks, salary, interest): they can be renamed but not hidden. */
const SYSTEM_CATEGORIES = new Set(['salary', 'interest', 'interest paid', 'other', 'other income', 'other money in', 'bank charges', 'money in (not income)']);

export const CategoryPatch = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  icon: z.string().max(16).optional().nullable(),
  isArchived: z.boolean().optional(),
});

export async function updateCategory(sql: Sql, bookId: string, id: string, p: z.infer<typeof CategoryPatch>) {
  return sql.begin(async (tx) => {
    const [before] = await tx<any[]>`select * from account where id = ${id} and book_id = ${bookId} and kind = 'category'`;
    if (!before) throw new LedgerError('not_found', 'category not found', 404);
    if (p.isArchived && SYSTEM_CATEGORIES.has(String(before.name).toLowerCase()))
      throw new LedgerError('system_category', `${before.name} is used by the app itself, so it can't be hidden. You can rename it.`, 400);
    try {
      await tx`update account set name = coalesce(${p.name ?? null}, name), icon = ${p.icon === undefined ? before.icon : p.icon},
                 is_archived = coalesce(${p.isArchived ?? null}, is_archived) where id = ${id}`;
    } catch (e: any) {
      if (e?.code === '23505') throw new LedgerError('duplicate_name', `${p.name} already exists there`, 409);
      throw e;
    }
    // Hiding a category hides its subcategories too; showing it again brings them back.
    if (p.isArchived !== undefined && !before.parent_id) await tx`update account set is_archived = ${p.isArchived} where parent_id = ${id}`;
    await audit(tx, bookId, 'category', id, 'update', before, p, 'user');
  });
}

export async function createCategory(sql: Sql, bookId: string, input: z.infer<typeof CategoryInput>) {
  return sql.begin(async (tx) => {
    if (input.parentId) {
      const [p] = await tx<{ class: string; parent_id: string | null }[]>`
        select class, parent_id from account where id = ${input.parentId} and book_id = ${bookId} and kind = 'category'`;
      if (!p) throw new LedgerError('parent_not_found', 'parent category not found', 404);
      if (p.class !== input.class) throw new LedgerError('bad_parent', 'parent is a different type of category');
      if (p.parent_id) throw new LedgerError('too_deep', 'categories go two levels deep: category › subcategory');
    }
    // Subcategories inherit "not income" from their parent; new top-level income categories can opt in.
    const [parent] = input.parentId ? await tx<{ meta: any }[]>`select meta from account where id = ${input.parentId}` : [];
    const notIncome = input.class === 'income' && (input.parentId ? !!parent?.meta?.not_income : !!input.notIncome);
    const [{ next }] = await tx<{ next: number }[]>`
      select coalesce(max(sort), -1)::int + 1 as next from account
      where book_id = ${bookId} and kind = 'category' and class = ${input.class} and parent_id is not distinct from ${input.parentId ?? null}`;
    try {
      const [row] = await tx<{ id: string }[]>`
        insert into account (book_id, class, kind, name, parent_id, icon, sort, meta)
        values (${bookId}, ${input.class}, 'category', ${input.name}, ${input.parentId ?? null}, ${input.icon ?? null}, ${next}, ${tx.json(notIncome ? { not_income: true } : {})})
        returning id`;
      await audit(tx, bookId, 'category', row.id, 'create', null, input, 'user');
      return row.id;
    } catch (e: any) {
      if (e?.code === '23505') throw new LedgerError('duplicate_name', `${input.name} already exists there`, 409);
      throw e;
    }
  });
}
