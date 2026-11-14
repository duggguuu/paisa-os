/**
 * Splitwise import (read-only: this app never writes to Splitwise).
 *
 * Every Splitwise friend becomes a person account here (they owe you = positive balance).
 * Each expense is booked from your point of view, using Splitwise's own `repayments`
 * (who owes whom, per expense):
 *   - your share (owed_share)            → spending, in a matching category
 *   - what you paid (paid_share)         → out of your chosen default account
 *   - "X owes you" / "you owe Y"         → X's / Y's person account
 * Settle-ups (payment = true) move money between that person and your default account.
 *
 * Balances are computed from the full history, not taken from Splitwise's totals, so the
 * direction is unambiguous. Expenses before the chosen start date aren't imported one by one;
 * they become each new person's opening balance, so every balance still matches Splitwise.
 * Each expense is booked with external_ref `sw:<id>`, so re-syncing never duplicates.
 */
import { z } from 'zod';
import type { Sql, Tx } from './db.js';
import type { Cipher } from './crypto.js';
import { createRawTxn, LedgerError, audit, type PostingDraft } from './ledger.js';
import { setOpeningBalance } from './books.js';
import { addDays } from './money.js';

const BASE = 'https://secure.splitwise.com/api/v3.0';
type Fetch = typeof fetch;

async function sw(f: Fetch, apiKey: string, path: string) {
  const res = await f(`${BASE}${path}`, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } });
  if (res.status === 401) throw new LedgerError('splitwise_auth', 'Splitwise rejected the API key. Create a new one and link again.', 401);
  if (!res.ok) throw new LedgerError('splitwise_error', `Splitwise returned ${res.status}`, 502);
  return res.json() as Promise<any>;
}

export const LinkInput = z.object({ apiKey: z.string().trim().min(10).max(200), defaultAccountId: z.string().uuid() });

export async function link(sql: Sql, cipher: Cipher, bookId: string, input: z.infer<typeof LinkInput>, f: Fetch = fetch) {
  await checkDefaultAccount(sql, bookId, input.defaultAccountId);
  const me = (await sw(f, input.apiKey, '/get_current_user')).user;
  if (!me?.id) throw new LedgerError('splitwise_error', 'Could not read your Splitwise profile');
  const name = [me.first_name, me.last_name].filter(Boolean).join(' ');
  await sql`
    insert into splitwise_link (book_id, api_key_enc, sw_user_id, sw_user_name, default_account_id)
    values (${bookId}, ${cipher.encrypt(input.apiKey)}, ${me.id}, ${name}, ${input.defaultAccountId})
    on conflict (book_id) do update set api_key_enc = excluded.api_key_enc, sw_user_id = excluded.sw_user_id,
      sw_user_name = excluded.sw_user_name, default_account_id = excluded.default_account_id`;
  return { userName: name };
}

async function checkDefaultAccount(sql: Sql | Tx, bookId: string, accountId: string) {
  const [a] = await sql<{ kind: string }[]>`select kind from account where id = ${accountId} and book_id = ${bookId}`;
  if (!a || !['bank', 'cash', 'wallet', 'credit_card'].includes(a.kind)) throw new LedgerError('bad_account', 'pick a bank, cash, wallet or card account for Splitwise payments');
}

export async function status(sql: Sql, bookId: string) {
  const [l] = await sql<any[]>`
    select l.sw_user_name, l.default_account_id, l.last_synced_at, a.name as default_account_name
    from splitwise_link l left join account a on a.id = l.default_account_id where l.book_id = ${bookId}`;
  return l ?? null;
}

export async function unlink(sql: Sql, bookId: string) {
  await sql`delete from splitwise_link where book_id = ${bookId}`;
}

export async function setDefaultAccount(sql: Sql, bookId: string, accountId: string) {
  await checkDefaultAccount(sql, bookId, accountId);
  await sql`update splitwise_link set default_account_id = ${accountId} where book_id = ${bookId}`;
}

// ---------- planning ----------
const paise = (s: string | number | null | undefined) => Math.round(Number(s ?? 0) * 100);
const nameOf = (u: any) => [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim() || `Splitwise user ${u?.id ?? ''}`;
/** Splitwise dates are UTC timestamps; book them on the Indian calendar day. */
const istDate = (iso: string) => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 10);

/** Splitwise category → words to look for in your category names (first match wins). */
const CATEGORY_MAP: [RegExp, string[]][] = [
  [/dining|restaurant/i, ['dining out', 'food']],
  [/groceries/i, ['groceries', 'food']],
  [/liquor|bar/i, ['social', 'outings', 'dining out']],
  [/food|drink/i, ['dining out', 'food']],
  [/taxi|uber|car|bus|train|transport|parking/i, ['cab & auto', 'public transport', 'transport']],
  [/gas|fuel/i, ['fuel', 'transport']],
  [/plane|flight|hotel|travel/i, ['flights & trains', 'stays', 'travel']],
  [/rent|mortgage/i, ['rent', 'housing']],
  [/electric/i, ['electricity', 'housing']],
  [/water|heat|utilities/i, ['water & gas', 'housing']],
  [/tv|phone|internet/i, ['internet', 'mobile', 'bills']],
  [/household|furniture|maintenance|cleaning/i, ['household', 'maintenance', 'housing']],
  [/movies|music|games|sports|entertainment/i, ['movies & events', 'outings', 'entertainment']],
  [/clothing/i, ['apparel', 'shopping']],
  [/electronics/i, ['electronics', 'shopping']],
  [/gifts/i, ['gifts given', 'shopping']],
  [/medical|health/i, ['doctor', 'medicines', 'health']],
  [/education/i, ['courses', 'education']],
  [/insurance/i, ['insurance', 'bills']],
  [/taxes/i, ['taxes']],
];

interface Plan {
  id: number; date: string; description: string; kind: 'expense' | 'split' | 'transfer';
  yourShare: number; youPaid: number; categoryId: string | null; categoryName: string | null;
  people: { swId: number; name: string; amount: number }[]; // + they owe you more, − you owe them more
  bank: number; // signed change to your default account (paise)
  status: 'new' | 'imported' | 'before_start';
  updatedAt: string;
}

async function fetchAll(f: Fetch, apiKey: string) {
  const all: any[] = [];
  for (let offset = 0; offset < 50_000; offset += 200) {
    const page = (await sw(f, apiKey, `/get_expenses?limit=200&offset=${offset}`)).expenses ?? [];
    all.push(...page);
    if (page.length < 200) break;
  }
  return all;
}

export async function plan(sql: Sql, cipher: Cipher, bookId: string, since: string | null, f: Fetch = fetch) {
  const [l] = await sql<any[]>`select * from splitwise_link where book_id = ${bookId}`;
  if (!l) throw new LedgerError('splitwise_not_linked', 'Link Splitwise first', 400);
  const apiKey = cipher.decrypt(l.api_key_enc);
  const me = Number(l.sw_user_id);
  const expenses = await fetchAll(f, apiKey);

  const cats = await sql<{ id: string; name: string }[]>`
    select id, name from account where book_id = ${bookId} and kind = 'category' and class = 'expense' and not is_archived
      and not exists (select 1 from account c where c.parent_id = account.id)`;
  const other = cats.find((c) => c.name === 'Other') ?? cats[0];
  const pickCategory = (swName: string | undefined, desc: string) => {
    const hay = `${swName ?? ''} ${desc}`;
    for (const [re, needles] of CATEGORY_MAP) {
      if (!re.test(hay)) continue;
      for (const n of needles) { const c = cats.find((x) => x.name.toLowerCase().includes(n)); if (c) return c; }
    }
    return other;
  };
  const done = new Set((await sql<{ external_ref: string }[]>`
    select external_ref from txn where book_id = ${bookId} and status = 'posted' and external_ref like 'sw:%'`).map((r) => r.external_ref));

  const people = new Map<number, { swId: number; name: string; allTime: number; window: number }>();
  const touch = (u: any, id: number) => {
    if (!people.has(id)) people.set(id, { swId: id, name: nameOf(u), allTime: 0, window: 0 });
    return people.get(id)!;
  };
  const plans: Plan[] = [];
  let skippedCurrency = 0, skippedInconsistent = 0;

  for (const e of expenses) {
    if (e.deleted_at) continue;
    const mine = (e.users ?? []).find((u: any) => Number(u.user_id) === me);
    if (!mine) continue;
    if ((e.currency_code ?? 'INR') !== 'INR') { skippedCurrency++; continue; }
    const userById = new Map((e.users ?? []).map((u: any) => [Number(u.user_id), u.user ?? { id: u.user_id }]));
    let reps: { from: number; to: number; amount: number }[] = (e.repayments ?? []).map((r: any) => ({ from: Number(r.from), to: Number(r.to), amount: paise(r.amount) }));
    // Older two-person expenses can lack repayments: derive it from the other person's balance.
    if (!reps.some((r) => r.from === me || r.to === me) && paise(mine.net_balance) !== 0 && (e.users ?? []).length === 2) {
      const other = (e.users as any[]).find((u) => Number(u.user_id) !== me);
      const net = paise(mine.net_balance);
      reps = [net > 0 ? { from: Number(other.user_id), to: me, amount: net } : { from: me, to: Number(other.user_id), amount: -net }];
    }
    const lines: Plan['people'] = [];
    for (const r of reps) {
      if (r.to === me && r.from !== me) lines.push({ swId: r.from, name: nameOf(userById.get(r.from)), amount: r.amount });
      if (r.from === me && r.to !== me) lines.push({ swId: r.to, name: nameOf(userById.get(r.to)), amount: -r.amount });
    }
    const date = istDate(e.date ?? e.created_at);
    const inWindow = !since || date >= since;
    for (const p of lines) {
      const rec = touch(userById.get(p.swId), p.swId);
      rec.allTime += p.amount;
      if (inWindow) rec.window += p.amount;
    }
    const personSum = lines.reduce((s, p) => s + p.amount, 0);
    let yourShare = 0, youPaid = 0, bank: number, kind: Plan['kind'];
    if (e.payment) {
      bank = -personSum; // they paid you → money in; you paid them → money out
      kind = 'transfer';
    } else {
      yourShare = paise(mine.owed_share);
      youPaid = paise(mine.paid_share);
      bank = -youPaid;
      // Rounding guard: Splitwise shares and repayments should agree; if a paisa is off, it goes to your share.
      const drift = youPaid - yourShare - personSum;
      if (Math.abs(drift) <= 2) yourShare += drift;
      else { skippedInconsistent++; continue; } // inconsistent data: leave it out rather than book something wrong
      kind = yourShare > 0 ? (lines.length ? 'split' : 'expense') : 'transfer';
    }
    if (bank === 0 && yourShare === 0 && lines.length === 0) continue;
    const cat = !e.payment && yourShare > 0 ? pickCategory(e.category?.name, e.description ?? '') : null;
    plans.push({
      id: Number(e.id), date, description: (e.description ?? (e.payment ? 'Settle up' : 'Splitwise expense')).slice(0, 120), kind,
      yourShare, youPaid, categoryId: cat?.id ?? null, categoryName: cat?.name ?? null, people: lines, bank,
      status: done.has(`sw:${e.id}`) ? 'imported' : inWindow ? 'new' : 'before_start', updatedAt: e.updated_at,
    });
  }
  plans.sort((a, b) => b.date.localeCompare(a.date));

  // Map Splitwise people to person accounts (existing link, then same name, else new).
  const persons = await sql<{ id: string; name: string; sw: string | null }[]>`
    select id, name, meta->>'splitwise_id' as sw from account where book_id = ${bookId} and kind = 'receivable'`;
  const balances = await sql<{ id: string; balance: number }[]>`
    select p.account_id as id, sum(p.amount)::bigint as balance from posting p join txn t on t.id = p.txn_id
    where t.book_id = ${bookId} and t.status = 'posted' and p.account_id = any(${persons.map((p) => p.id)}::uuid[]) group by 1`;
  const balOf = new Map(balances.map((b) => [b.id, b.balance]));
  const friends = [...people.values()].map((p) => {
    const linked = persons.find((x) => x.sw === String(p.swId)) ?? persons.find((x) => !x.sw && x.name.toLowerCase() === p.name.toLowerCase())
      ?? persons.find((x) => !x.sw && x.name.split(' ')[0].toLowerCase() === p.name.split(' ')[0].toLowerCase() && p.name.split(' ').length === 1);
    return { ...p, accountId: linked?.id ?? null, accountName: linked?.name ?? null, appBalance: linked ? balOf.get(linked.id) ?? 0 : null };
  }).filter((p) => p.allTime !== 0 || plans.some((x) => x.status !== 'before_start' && x.people.some((y) => y.swId === p.swId)))
    .sort((a, b) => Math.abs(b.allTime) - Math.abs(a.allTime));

  return { since, defaultAccountId: l.default_account_id as string | null, expenses: plans.filter((p) => p.status !== 'before_start'), friends, skippedCurrency, skippedInconsistent, total: expenses.length };
}

export async function importPlan(sql: Sql, cipher: Cipher, bookId: string, opts: { since: string | null; skip?: number[] }, f: Fetch = fetch) {
  const p = await plan(sql, cipher, bookId, opts.since, f);
  if (!p.defaultAccountId) throw new LedgerError('bad_account', 'Pick the account your Splitwise payments come from');
  const skip = new Set(opts.skip ?? []);
  const result = { imported: 0, alreadyImported: 0, skipped: 0, peopleCreated: 0, openingSet: 0, errors: [] as string[] };

  await sql.begin(async (tx) => {
    // People: link or create. New people get an opening balance = everything before the start date.
    const accountFor = new Map<number, string>();
    for (const fr of p.friends) {
      let id = fr.accountId;
      if (!id) {
        let name = fr.name.slice(0, 60);
        const [clash] = await tx<{ id: string }[]>`select id from account where book_id = ${bookId} and class = 'asset' and lower(name) = lower(${name})`;
        if (clash) name = `${name} (Splitwise)`.slice(0, 60);
        [{ id }] = await tx<{ id: string }[]>`
          insert into account (book_id, class, kind, name, icon, meta)
          values (${bookId}, 'asset', 'receivable', ${name}, '🧑', ${tx.json({ splitwise_id: String(fr.swId) })}) returning id`;
        result.peopleCreated++;
        const opening = fr.allTime - fr.window;
        if (opening !== 0) {
          await setOpeningBalance(tx, bookId, id!, opening, addDays(p.since ?? '2000-01-01', -1));
          result.openingSet++;
        }
      } else {
        await tx`update account set meta = meta || ${tx.json({ splitwise_id: String(fr.swId) })} where id = ${id}`;
      }
      accountFor.set(fr.swId, id!);
    }

    for (const e of p.expenses) {
      if (e.status === 'imported') { result.alreadyImported++; continue; }
      if (skip.has(e.id)) { result.skipped++; continue; }
      const postings: PostingDraft[] = [];
      if (e.yourShare > 0 && e.categoryId) postings.push({ accountId: e.categoryId, amount: e.yourShare });
      if (e.bank !== 0) postings.push({ accountId: p.defaultAccountId!, amount: e.bank });
      for (const pe of e.people) postings.push({ accountId: accountFor.get(pe.swId)!, amount: pe.amount, memo: pe.amount > 0 ? `${pe.name} owes you` : `you owe ${pe.name}` });
      if (postings.length < 2) { result.skipped++; continue; }
      try {
        await tx.savepoint((sp) => createRawTxn(sp as unknown as Tx, bookId, {
          kind: e.kind, date: e.date, merchant: e.description, note: 'From Splitwise', source: 'splitwise', externalRef: `sw:${e.id}`, postings,
        }, 'splitwise'));
        result.imported++;
      } catch (err: any) {
        result.errors.push(`${e.description} (${e.date}): ${err.message}`);
      }
    }
    await tx`update splitwise_link set last_synced_at = now() where book_id = ${bookId}`;
    await audit(tx, bookId, 'splitwise', bookId, 'sync', null, { since: p.since, ...result, errors: result.errors.length }, 'splitwise');
  });
  return result;
}
