/**
 * The ledger: turns user-level transactions (expense, income, transfer, split, refund)
 * into balanced postings. This module is the only writer of txn/posting rows.
 */
import { z } from 'zod';
import type { Sql, Tx } from './db.js';

export class LedgerError extends Error {
  constructor(public code: string, message: string, public status = 422) {
    super(message);
  }
}

const paise = z.number().int().positive().max(1e13);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const id = z.string().uuid();

const common = {
  date,
  merchant: z.string().trim().max(120).optional().nullable(),
  description: z.string().trim().max(200).optional().nullable(),
  note: z.string().trim().max(2000).optional().nullable(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  source: z.enum(['manual', 'voice', 'sms', 'import', 'verified']).optional(),
  externalRef: z.string().trim().max(80).optional().nullable(),
  idempotencyKey: id.optional(),
};

export const TxnInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('expense'), amount: paise, accountId: id, categoryId: id, ...common }),
  z.object({ kind: z.literal('income'), amount: paise, accountId: id, categoryId: id, ...common }),
  z.object({ kind: z.literal('transfer'), amount: paise, fromAccountId: id, toAccountId: id, ...common }),
  z.object({
    kind: z.literal('split'),
    accountId: id, // the account that paid
    lines: z
      .array(
        z.object({
          amount: paise,
          categoryId: id.optional(), // your share(s): expense categories
          receivableId: id.optional(), // someone else's share: a receivable account
          memo: z.string().max(200).optional(),
        }).refine((l) => !!l.categoryId !== !!l.receivableId, 'each line needs exactly one of categoryId or receivableId'),
      )
      .min(1)
      .max(50),
    ...common,
  }),
  z.object({ kind: z.literal('refund'), amount: paise, refundOf: id, accountId: id.optional(), ...common }),
]);
export type TxnInput = z.infer<typeof TxnInput>;

interface AccountRow { id: string; class: string; kind: string; name: string; is_archived: boolean }
interface PostingDraft { accountId: string; amount: number; memo?: string | null }

async function loadAccounts(tx: Tx, bookId: string, ids: string[]): Promise<Map<string, AccountRow>> {
  const rows = await tx<AccountRow[]>`
    select id, class, kind, name, is_archived from account where book_id = ${bookId} and id = any(${ids}::uuid[])`;
  const map = new Map(rows.map((r) => [r.id, r]));
  for (const i of ids) if (!map.has(i)) throw new LedgerError('account_not_found', `account ${i} not found in this book`, 404);
  return map;
}

const isMoneyAccount = (a: AccountRow) => (a.class === 'asset' || a.class === 'liability') && a.kind !== 'receivable';

function need(cond: boolean, code: string, msg: string) {
  if (!cond) throw new LedgerError(code, msg);
}

/** Build balanced postings for an input. Positive = debit. */
export async function buildPostings(tx: Tx, bookId: string, input: TxnInput): Promise<PostingDraft[]> {
  switch (input.kind) {
    case 'expense': {
      const acc = await loadAccounts(tx, bookId, [input.accountId, input.categoryId]);
      const a = acc.get(input.accountId)!, c = acc.get(input.categoryId)!;
      need(isMoneyAccount(a), 'bad_account', `${a.name} can't pay for an expense`);
      need(c.class === 'expense', 'bad_category', `${c.name} is not an expense category`);
      return [
        { accountId: c.id, amount: input.amount },
        { accountId: a.id, amount: -input.amount },
      ];
    }
    case 'income': {
      const acc = await loadAccounts(tx, bookId, [input.accountId, input.categoryId]);
      const a = acc.get(input.accountId)!, c = acc.get(input.categoryId)!;
      need(isMoneyAccount(a), 'bad_account', `${a.name} can't receive income`);
      need(c.class === 'income', 'bad_category', `${c.name} is not an income category`);
      return [
        { accountId: a.id, amount: input.amount },
        { accountId: c.id, amount: -input.amount },
      ];
    }
    case 'transfer': {
      need(input.fromAccountId !== input.toAccountId, 'same_account', 'transfer needs two different accounts');
      const acc = await loadAccounts(tx, bookId, [input.fromAccountId, input.toAccountId]);
      for (const a of acc.values()) need(a.class === 'asset' || a.class === 'liability', 'bad_account', `${a.name} can't be part of a transfer`);
      return [
        { accountId: input.toAccountId, amount: input.amount },
        { accountId: input.fromAccountId, amount: -input.amount },
      ];
    }
    case 'split': {
      const ids = [input.accountId, ...input.lines.map((l) => (l.categoryId ?? l.receivableId)!)];
      const acc = await loadAccounts(tx, bookId, [...new Set(ids)]);
      const payer = acc.get(input.accountId)!;
      need(isMoneyAccount(payer), 'bad_account', `${payer.name} can't pay for an expense`);
      const out: PostingDraft[] = [];
      for (const l of input.lines) {
        const target = acc.get((l.categoryId ?? l.receivableId)!)!;
        if (l.categoryId) need(target.class === 'expense', 'bad_category', `${target.name} is not an expense category`);
        else need(target.kind === 'receivable', 'bad_receivable', `${target.name} is not a person/receivable account`);
        out.push({ accountId: target.id, amount: l.amount, memo: l.memo ?? null });
      }
      out.push({ accountId: payer.id, amount: -input.lines.reduce((s, l) => s + l.amount, 0) });
      return out;
    }
    case 'refund': {
      const [orig] = await tx<{ id: string; kind: string; status: string }[]>`
        select id, kind, status from txn where id = ${input.refundOf} and book_id = ${bookId}`;
      if (!orig) throw new LedgerError('txn_not_found', 'original transaction not found', 404);
      need(orig.status === 'posted', 'voided', 'cannot refund a voided transaction');
      const lines = await tx<{ account_id: string; amount: number; class: string; kind: string }[]>`
        select p.account_id, p.amount, a.class, a.kind from posting p join account a on a.id = p.account_id
        where p.txn_id = ${orig.id} order by p.id`;
      const expenseLines = lines.filter((l) => l.class === 'expense' && l.amount > 0);
      need(expenseLines.length > 0, 'not_refundable', 'only expenses can be refunded');
      const [{ refunded }] = await tx<{ refunded: number }[]>`
        select coalesce(sum(p.amount), 0)::bigint as refunded
        from txn t join posting p on p.txn_id = t.id join account a on a.id = p.account_id
        where t.refund_of = ${orig.id} and t.status = 'posted' and a.class = 'expense'`;
      const original = expenseLines.reduce((s, l) => s + l.amount, 0);
      need(input.amount <= original + refunded, 'over_refund', `refund exceeds the remaining ₹${(original + refunded) / 100}`);
      const payer = lines.find((l) => l.amount < 0 && (l.class === 'asset' || l.class === 'liability'));
      const toAccount = input.accountId ?? payer?.account_id;
      need(!!toAccount, 'bad_account', 'choose the account the refund went to');
      const acc = await loadAccounts(tx, bookId, [toAccount!]);
      need(isMoneyAccount(acc.get(toAccount!)!), 'bad_account', 'refunds go to a bank, cash, card or wallet account');
      // Credit categories in proportion to the original split; the last line absorbs rounding.
      const out: PostingDraft[] = [];
      let left = input.amount;
      expenseLines.forEach((l, i) => {
        const share = i === expenseLines.length - 1 ? left : Math.round((input.amount * l.amount) / original);
        left -= share;
        if (share !== 0) out.push({ accountId: l.account_id, amount: -share });
      });
      out.push({ accountId: toAccount!, amount: input.amount });
      return out;
    }
  }
}

function describe(input: TxnInput): string | null {
  return input.description ?? input.merchant ?? null;
}

export interface TxnResult { id: string; duplicate: boolean }

export async function createTxn(sql: Sql, bookId: string, input: TxnInput, actor = 'user'): Promise<TxnResult> {
  return sql.begin(async (tx) => {
    if (input.idempotencyKey) {
      const [existing] = await tx<{ id: string }[]>`
        select id from txn where book_id = ${bookId} and idempotency_key = ${input.idempotencyKey}`;
      if (existing) return { id: existing.id, duplicate: true };
    }
    const postings = await buildPostings(tx, bookId, input);
    let row: { id: string };
    try {
      [row] = await tx<{ id: string }[]>`
        insert into txn (book_id, kind, occurred_on, description, merchant, note, tags, source, external_ref, idempotency_key, refund_of)
        values (${bookId}, ${input.kind}, ${input.date}, ${describe(input)}, ${input.merchant ?? null}, ${input.note ?? null},
                ${input.tags ?? []}, ${input.source ?? 'manual'}, ${input.externalRef ?? null}, ${input.idempotencyKey ?? null},
                ${input.kind === 'refund' ? input.refundOf : null})
        returning id`;
    } catch (e: any) {
      if (e?.code === '23505' && String(e?.constraint_name ?? e?.message).includes('external_ref')) {
        throw new LedgerError('duplicate_ref', `a transaction with reference ${input.externalRef} already exists`, 409);
      }
      throw e;
    }
    for (const p of postings) {
      await tx`insert into posting (txn_id, account_id, amount, memo) values (${row.id}, ${p.accountId}, ${p.amount}, ${p.memo ?? null})`;
    }
    await audit(tx, bookId, 'txn', row.id, 'create', null, { input, postings }, actor);
    return { id: row.id, duplicate: false };
  });
}

export async function updateTxn(sql: Sql, bookId: string, txnId: string, input: TxnInput, actor = 'user'): Promise<TxnResult> {
  return sql.begin(async (tx) => {
    const before = await getTxn(tx, bookId, txnId);
    if (!before) throw new LedgerError('txn_not_found', 'transaction not found', 404);
    if (before.status !== 'posted') throw new LedgerError('voided', 'voided transactions cannot be edited');
    if (before.kind === 'opening') throw new LedgerError('opening', 'edit the account opening balance instead');
    const postings = await buildPostings(tx, bookId, input);
    await tx`delete from posting where txn_id = ${txnId}`;
    await tx`
      update txn set kind = ${input.kind}, occurred_on = ${input.date}, description = ${describe(input)},
        merchant = ${input.merchant ?? null}, note = ${input.note ?? null}, tags = ${input.tags ?? []},
        external_ref = ${input.externalRef ?? null}, refund_of = ${input.kind === 'refund' ? input.refundOf : null},
        updated_at = now()
      where id = ${txnId}`;
    for (const p of postings) {
      await tx`insert into posting (txn_id, account_id, amount, memo) values (${txnId}, ${p.accountId}, ${p.amount}, ${p.memo ?? null})`;
    }
    await audit(tx, bookId, 'txn', txnId, 'update', before, { input, postings }, actor);
    return { id: txnId, duplicate: false };
  });
}

export async function voidTxn(sql: Sql, bookId: string, txnId: string, actor = 'user'): Promise<void> {
  await sql.begin(async (tx) => {
    const before = await getTxn(tx, bookId, txnId);
    if (!before) throw new LedgerError('txn_not_found', 'transaction not found', 404);
    if (before.status === 'void') return;
    const [refunds] = await tx<{ n: number }[]>`
      select count(*)::int as n from txn where refund_of = ${txnId} and status = 'posted'`;
    if (refunds.n > 0) throw new LedgerError('has_refunds', 'void its refunds first');
    await tx`update txn set status = 'void', updated_at = now() where id = ${txnId}`;
    await audit(tx, bookId, 'txn', txnId, 'void', before, null, actor);
  });
}

export async function restoreTxn(sql: Sql, bookId: string, txnId: string, actor = 'user'): Promise<void> {
  await sql.begin(async (tx) => {
    const before = await getTxn(tx, bookId, txnId);
    if (!before) throw new LedgerError('txn_not_found', 'transaction not found', 404);
    if (before.status === 'posted') return;
    try {
      await tx`update txn set status = 'posted', updated_at = now() where id = ${txnId}`;
    } catch (e: any) {
      if (e?.code === '23505') throw new LedgerError('duplicate_ref', 'another transaction now uses this reference', 409);
      throw e;
    }
    await audit(tx, bookId, 'txn', txnId, 'restore', before, null, actor);
  });
}

export async function getTxn(tx: Tx, bookId: string, txnId: string) {
  const [t] = await tx<any[]>`select t.*, t.occurred_on::text as date from txn t where t.id = ${txnId} and t.book_id = ${bookId}`;
  if (!t) return null;
  t.postings = await tx<any[]>`
    select p.account_id, p.amount, p.memo, a.name as account_name, a.class, a.kind
    from posting p join account a on a.id = p.account_id where p.txn_id = ${txnId} order by p.id`;
  return t;
}

export async function audit(tx: Tx, bookId: string, entity: string, entityId: string, action: string, before: unknown, after: unknown, source: string) {
  await tx`insert into audit_log (book_id, entity, entity_id, action, before, after, source)
           values (${bookId}, ${entity}, ${entityId}, ${action}, ${tx.json(before as any)}, ${tx.json(after as any)}, ${source})`;
}

/**
 * Account balances computed from postings (never stored).
 * `balance` is in the account's natural sign: positive means you have money (assets)
 * or owe money (liabilities).
 */
export async function accountBalances(tx: Tx, bookId: string, asOf?: string) {
  const rows = await tx<any[]>`
    select a.id, a.name, a.class, a.kind, a.parent_id, a.institution, a.icon, a.color, a.is_archived, a.meta, a.sort,
           coalesce(sum(p.amount) filter (where t.status = 'posted' ${asOf ? tx`and t.occurred_on <= ${asOf}` : tx``}), 0)::bigint as raw
    from account a
    left join posting p on p.account_id = a.id
    left join txn t on t.id = p.txn_id
    where a.book_id = ${bookId}
    group by a.id
    order by a.class, a.sort, a.name`;
  return rows.map((r) => ({
    ...r,
    balance: r.class === 'asset' || r.class === 'expense' ? r.raw : 0 - r.raw || 0,
  }));
}

/** Sanity check: the whole book must sum to zero. Used by the nightly integrity job and tests. */
export async function bookIntegrity(tx: Tx, bookId: string) {
  const [r] = await tx<{ total: number; unbalanced: number }[]>`
    select
      (select coalesce(sum(p.amount), 0)::bigint from posting p join txn t on t.id = p.txn_id where t.book_id = ${bookId}) as total,
      (select count(*)::int from (
         select p.txn_id from posting p join txn t on t.id = p.txn_id where t.book_id = ${bookId}
         group by p.txn_id having sum(p.amount) <> 0) x) as unbalanced`;
  return { ok: r.total === 0 && r.unbalanced === 0, ...r };
}
