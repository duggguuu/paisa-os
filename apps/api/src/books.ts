import { z } from 'zod';
import type { Sql, Tx } from './db.js';
import { audit, LedgerError } from './ledger.js';
import { todayIST } from './money.js';

/** Default category tree. Icons are emoji so they render everywhere without an icon font. */
export const DEFAULT_CATEGORIES: { expense: [string, string, string[]][]; income: [string, string, string[]][] } = {
  expense: [
    ['Food', '🍲', ['Groceries', 'Dining out', 'Delivery', 'Snacks & coffee']],
    ['Housing', '🏠', ['Rent', 'Maintenance', 'Electricity', 'Internet', 'Water & gas']],
    ['Transport', '🛵', ['Fuel', 'Cab & auto', 'Public transport', 'Parking & tolls', 'Vehicle service']],
    ['Shopping', '🛍️', ['Apparel', 'Electronics', 'Household', 'Gifts given']],
    ['Bills & subscriptions', '🧾', ['Mobile', 'Subscriptions', 'Insurance']],
    ['Health', '🩺', ['Doctor', 'Medicines', 'Fitness']],
    ['Entertainment', '🎬', ['Movies & events', 'Games', 'Outings']],
    ['Personal care', '💈', []],
    ['Education', '📚', ['Courses', 'Books']],
    ['Travel', '✈️', ['Flights & trains', 'Stays', 'Local travel']],
    ['Family', '👪', ['Parents', 'Siblings']],
    ['Social life', '🍻', []],
    ['Hobbies', '🎨', []],
    ['Religious & charity', '🪔', []],
    ['Fees & charges', '🏦', ['Bank charges', 'Interest paid', 'Late fees']],
    ['Taxes', '🧮', []],
    ['Other', '•', []],
  ],
  income: [
    ['Salary', '💼', []],
    ['Interest', '🏦', []],
    ['Dividends', '📈', []],
    ['Refunds & cashback', '↩️', []],
    ['Gifts received', '🎁', []],
    ['Other income', '•', []],
  ],
};

async function insertCategories(tx: Tx, bookId: string) {
  for (const cls of ['expense', 'income'] as const) {
    let sort = 0;
    for (const [name, icon, subs] of DEFAULT_CATEGORIES[cls]) {
      const [parent] = await tx<{ id: string }[]>`
        insert into account (book_id, class, kind, name, icon, sort) values (${bookId}, ${cls}, 'category', ${name}, ${icon}, ${sort++})
        returning id`;
      let s = 0;
      for (const sub of subs) {
        await tx`insert into account (book_id, class, kind, name, parent_id, sort) values (${bookId}, ${cls}, 'category', ${sub}, ${parent.id}, ${s++})`;
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
export async function seedRealBookAccounts(tx: Tx, bookId: string) {
  const accounts: [string, string, string, string, object][] = [
    ['Axis Bank', 'bank', 'Axis Bank', '🏦', { salary: true, debit_card: true }],
    ['HDFC Bank', 'bank', 'HDFC Bank', '🏦', { debit_card: true }],
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
  icon: z.string().max(8).optional().nullable(),
});

export async function createCategory(sql: Sql, bookId: string, input: z.infer<typeof CategoryInput>) {
  return sql.begin(async (tx) => {
    if (input.parentId) {
      const [p] = await tx<{ class: string; parent_id: string | null }[]>`
        select class, parent_id from account where id = ${input.parentId} and book_id = ${bookId} and kind = 'category'`;
      if (!p) throw new LedgerError('parent_not_found', 'parent category not found', 404);
      if (p.class !== input.class) throw new LedgerError('bad_parent', 'parent is a different type of category');
      if (p.parent_id) throw new LedgerError('too_deep', 'categories go two levels deep: category › subcategory');
    }
    try {
      const [row] = await tx<{ id: string }[]>`
        insert into account (book_id, class, kind, name, parent_id, icon) values (${bookId}, ${input.class}, 'category', ${input.name}, ${input.parentId ?? null}, ${input.icon ?? null})
        returning id`;
      await audit(tx, bookId, 'category', row.id, 'create', null, input, 'user');
      return row.id;
    } catch (e: any) {
      if (e?.code === '23505') throw new LedgerError('duplicate_name', `${input.name} already exists there`, 409);
      throw e;
    }
  });
}
