/**
 * Bank / card statement import.
 *
 * The browser parses the file (CSV/TXT exports from Axis, HDFC or any bank) into rows and
 * proposes how each should be booked. The server:
 *   preview: flags rows already in the ledger (exact by reference, or "possibly the same"
 *            as something you entered by hand: same account, same amount, within 3 days),
 *            and suggests categories from your own history for each merchant.
 *   commit:  books the chosen rows in one import batch. Every row carries an external_ref,
 *            which the database keeps unique, so importing the same file twice adds nothing.
 *   then reports the reconciliation: your balance on the statement's last date vs the
 *   statement's closing balance.
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import type { Sql } from './db.js';
import { createTxn, accountBalances, LedgerError, audit } from './ledger.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const id = z.string().uuid();

export const PreviewInput = z.object({
  accountId: id,
  rows: z.array(z.object({
    date, amount: z.number().int().refine((n) => n !== 0), // paise; + money into this account, − money out
    description: z.string().max(400), merchant: z.string().max(120).optional().nullable(),
    ref: z.string().max(60).optional().nullable(), balance: z.number().int().optional().nullable(),
  })).min(1).max(5000),
});

/** Stable reference for a statement row: the bank's own ref when there is one. */
export function rowRef(accountId: string, r: { date: string; amount: number; description: string; ref?: string | null; balance?: number | null }) {
  if (r.ref && r.ref.replace(/0/g, '').length >= 4) return `stmt:${r.ref}`;
  const h = crypto.createHash('sha1').update(`${accountId}|${r.date}|${r.amount}|${r.balance ?? ''}|${r.description.trim().toLowerCase()}`).digest('hex').slice(0, 20);
  return `stmt:${h}`;
}

export async function preview(sql: Sql, bookId: string, input: z.infer<typeof PreviewInput>) {
  const [acc] = await sql<{ id: string; class: string }[]>`select id, class from account where id = ${input.accountId} and book_id = ${bookId}`;
  if (!acc || !['asset', 'liability'].includes(acc.class)) throw new LedgerError('bad_account', 'pick the bank or card account this statement is for');
  const refs = input.rows.map((r) => rowRef(input.accountId, r));
  const rawRefs = input.rows.map((r) => r.ref).filter(Boolean) as string[];
  const existing = await sql<{ external_ref: string }[]>`
    select external_ref from txn where book_id = ${bookId} and status = 'posted'
      and (external_ref = any(${refs}) or external_ref = any(${rawRefs.map((r) => `upi:${r}`)}))`;
  const have = new Set(existing.map((e) => e.external_ref));

  // Hand-entered transactions on this account in the statement's date range (±3 days).
  const dates = input.rows.map((r) => r.date).sort();
  const manual = await sql<{ id: string; date: string; amount: number; title: string | null }[]>`
    select t.id, t.occurred_on::text as date, p.amount, coalesce(t.merchant, t.description) as title
    from txn t join posting p on p.txn_id = t.id
    where t.book_id = ${bookId} and t.status = 'posted' and p.account_id = ${input.accountId}
      and t.kind <> 'opening' and t.import_batch_id is null and coalesce(t.external_ref, '') not like 'stmt:%'
      and t.occurred_on between (${dates[0]}::date - 3) and (${dates[dates.length - 1]}::date + 3)`;
  const sign = acc.class === 'asset' ? 1 : -1; // posting sign of "money into this account"
  const used = new Set<string>();

  // Your own history: merchant → most used category / transfer target.
  const merchants = [...new Set(input.rows.map((r) => r.merchant?.toLowerCase()).filter(Boolean))] as string[];
  const hist = merchants.length ? await sql<{ merchant: string; category_id: string | null; n: number }[]>`
    select lower(t.merchant) as merchant, p.account_id as category_id, count(*)::int as n
    from txn t join posting p on p.txn_id = t.id join account a on a.id = p.account_id
    where t.book_id = ${bookId} and t.status = 'posted' and a.kind = 'category' and lower(t.merchant) = any(${merchants})
    group by 1, 2 order by n desc` : [];
  const histMap = new Map<string, string>();
  for (const h of hist) if (!histMap.has(h.merchant)) histMap.set(h.merchant, h.category_id!);

  const rows = input.rows.map((r, i) => {
    const ref = refs[i];
    if (have.has(ref) || (r.ref && have.has(`upi:${r.ref}`))) return { index: i, ref, status: 'duplicate' as const };
    const target = r.amount * sign;
    const match = manual.find((m) => !used.has(m.id) && m.amount === target && Math.abs(Date.parse(m.date) - Date.parse(r.date)) <= 3 * 86_400_000);
    if (match) { used.add(match.id); return { index: i, ref, status: 'possible' as const, match }; }
    return { index: i, ref, status: 'new' as const, suggestedCategoryId: r.merchant ? histMap.get(r.merchant.toLowerCase()) ?? null : null };
  });
  return { rows };
}

export const CommitInput = z.object({
  accountId: id,
  fileName: z.string().max(200).optional().nullable(),
  closing: z.object({ balance: z.number().int(), date }).optional().nullable(),
  rows: z.array(z.object({
    date, amount: z.number().int().refine((n) => n !== 0), description: z.string().max(400),
    merchant: z.string().max(120).optional().nullable(), ref: z.string().max(60).optional().nullable(), balance: z.number().int().optional().nullable(),
    kind: z.enum(['expense', 'income', 'transfer']),
    categoryId: id.optional().nullable(), otherAccountId: id.optional().nullable(),
  })).max(5000),
  totalRows: z.number().int().min(0).optional(),
});

export async function commit(sql: Sql, bookId: string, input: z.infer<typeof CommitInput>) {
  const [batch] = await sql<{ id: string }[]>`
    insert into import_batch (book_id, account_id, source, file_name, rows_total, closing_balance, closing_date)
    values (${bookId}, ${input.accountId}, 'statement', ${input.fileName ?? null}, ${input.totalRows ?? input.rows.length},
            ${input.closing?.balance ?? null}, ${input.closing?.date ?? null})
    returning id`;
  let imported = 0, skipped = 0;
  const errors: { row: number; message: string }[] = [];
  for (const [i, r] of input.rows.entries()) {
    const amount = Math.abs(r.amount);
    const common = {
      date: r.date, merchant: r.merchant || null, description: r.description.slice(0, 200), source: 'import' as const,
      externalRef: rowRef(input.accountId, r),
    };
    let tx: any;
    if (r.kind === 'transfer') {
      if (!r.otherAccountId) { errors.push({ row: i, message: 'transfer needs the other account' }); continue; }
      tx = r.amount < 0
        ? { kind: 'transfer', amount, fromAccountId: input.accountId, toAccountId: r.otherAccountId, ...common }
        : { kind: 'transfer', amount, fromAccountId: r.otherAccountId, toAccountId: input.accountId, ...common };
    } else {
      if (!r.categoryId) { errors.push({ row: i, message: 'pick a category' }); continue; }
      tx = { kind: r.kind, amount, accountId: input.accountId, categoryId: r.categoryId, ...common };
    }
    try {
      const res = await createTxn(sql, bookId, tx, 'import', { importBatchId: batch.id });
      res.duplicate ? skipped++ : imported++;
    } catch (e: any) {
      if (e?.code === 'duplicate_ref') skipped++;
      else errors.push({ row: i, message: e.message });
    }
  }
  await sql`update import_batch set rows_imported = ${imported}, meta = ${sql.json({ skipped, errors: errors.length })} where id = ${batch.id}`;
  await sql.begin((tx) => audit(tx, bookId, 'import', batch.id, 'statement', null, { accountId: input.accountId, imported, skipped, errors: errors.length }, 'import'));
  const reconciliation = input.closing ? await reconcile(sql, bookId, input.accountId, input.closing.date, input.closing.balance) : null;
  return { batchId: batch.id, imported, skipped, errors, reconciliation };
}

export async function reconcile(sql: Sql, bookId: string, accountId: string, date: string, statementBalance: number) {
  const bal = (await accountBalances(sql, bookId, date)).find((a) => a.id === accountId);
  const ledger = bal?.balance ?? 0;
  return { date, statement: statementBalance, ledger, difference: statementBalance - ledger };
}

export async function batches(sql: Sql, bookId: string) {
  return sql<any[]>`
    select b.id, b.source, b.file_name, b.imported_at, b.rows_total, b.rows_imported, b.closing_balance, b.closing_date::text as closing_date,
           a.name as account_name
    from import_batch b left join account a on a.id = b.account_id
    where b.book_id = ${bookId} order by b.imported_at desc limit 20`;
}

/** Undo an import: void every transaction it created (they stay in history and can be restored). */
export async function undoBatch(sql: Sql, bookId: string, batchId: string) {
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string }[]>`
      update txn set status = 'void', updated_at = now()
      where book_id = ${bookId} and import_batch_id = ${batchId} and status = 'posted'
        and not exists (select 1 from txn r where r.refund_of = txn.id and r.status = 'posted')
      returning id`;
    await audit(tx, bookId, 'import', batchId, 'undo', null, { voided: rows.length }, 'user');
    return { voided: rows.length };
  });
}
