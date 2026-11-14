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
import crypto from 'node:crypto';
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
  id: number | string; date: string; description: string; kind: 'expense' | 'split' | 'transfer';
  yourShare: number; youPaid: number; categoryId: string | null; categoryName: string | null;
  people: { swId: number | string; name: string; amount: number }[]; // + they owe you more, − you owe them more
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
      const rec = touch(userById.get(p.swId as number), p.swId as number);
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
  const result = await bookPlan(sql, bookId, { ...p, defaultAccountId: p.defaultAccountId }, opts.skip ?? [], {
    ref: (e) => `sw:${e.id}`,
    meta: (fr) => ({ splitwise_id: String(fr.swId) }),
  });
  await sql`update splitwise_link set last_synced_at = now() where book_id = ${bookId}`;
  return result;
}

interface Friend { swId: number | string; name: string; allTime: number; window: number; accountId: string | null }

/** Book a plan (from the API or from spreadsheet exports): link/create people, then one transaction per expense. */
async function bookPlan(sql: Sql, bookId: string,
  p: { since: string | null; defaultAccountId: string; expenses: Plan[]; friends: Friend[] },
  skipIds: (number | string)[], how: { ref: (e: Plan) => string; meta: (f: Friend) => Record<string, string> }) {
  await checkDefaultAccount(sql, bookId, p.defaultAccountId);
  const skip = new Set(skipIds.map(String));
  const result = { imported: 0, alreadyImported: 0, skipped: 0, peopleCreated: 0, openingSet: 0, errors: [] as string[] };

  await sql.begin(async (tx) => {
    // People: link or create. New people get an opening balance = everything before the start date.
    const accountFor = new Map<string, string>();
    for (const fr of p.friends) {
      let id = fr.accountId;
      if (!id) {
        let name = fr.name.slice(0, 60);
        const [clash] = await tx<{ id: string }[]>`select id from account where book_id = ${bookId} and class = 'asset' and lower(name) = lower(${name})`;
        if (clash) name = `${name} (Splitwise)`.slice(0, 60);
        [{ id }] = await tx<{ id: string }[]>`
          insert into account (book_id, class, kind, name, icon, meta)
          values (${bookId}, 'asset', 'receivable', ${name}, '🧑', ${tx.json(how.meta(fr))}) returning id`;
        result.peopleCreated++;
        const opening = fr.allTime - fr.window;
        if (opening !== 0) {
          await setOpeningBalance(tx, bookId, id!, opening, addDays(p.since ?? '2000-01-01', -1));
          result.openingSet++;
        }
      } else {
        await tx`update account set meta = meta || ${tx.json(how.meta(fr))} where id = ${id}`;
      }
      accountFor.set(String(fr.swId), id!);
    }

    for (const e of p.expenses) {
      if (e.status === 'imported') { result.alreadyImported++; continue; }
      if (e.status !== 'new' || skip.has(String(e.id))) { result.skipped++; continue; }
      const postings: PostingDraft[] = [];
      if (e.yourShare > 0 && e.categoryId) postings.push({ accountId: e.categoryId, amount: e.yourShare });
      if (e.bank !== 0) postings.push({ accountId: p.defaultAccountId, amount: e.bank });
      for (const pe of e.people) postings.push({ accountId: accountFor.get(String(pe.swId))!, amount: pe.amount, memo: pe.amount > 0 ? `${pe.name} owes you` : `you owe ${pe.name}` });
      if (postings.length < 2) { result.skipped++; continue; }
      try {
        await tx.savepoint((sp) => createRawTxn(sp as unknown as Tx, bookId, {
          kind: e.kind, date: e.date, merchant: e.description, note: 'From Splitwise', source: 'splitwise', externalRef: how.ref(e), postings,
        }, 'splitwise'));
        result.imported++;
      } catch (err: any) {
        result.errors.push(`${e.description} (${e.date}): ${err.message}`);
      }
    }
    await audit(tx, bookId, 'splitwise', bookId, 'sync', null, { since: p.since, ...result, errors: result.errors.length }, 'splitwise');
  });
  return result;
}

// ---------- Spreadsheet exports (free accounts) ----------
/*
 * Splitwise's "Export as spreadsheet" (per group or friend) gives one row per expense:
 *   Date, Description, Category, Cost, Currency, <one column per person>
 * where each person column is that person's net for the expense (they sum to zero).
 * It doesn't say who paid or who owes whom, so:
 *   - your share: if you're owed (+), you paid the bill: share = cost − net; if you owe (−): share = −net
 *   - who: your net is spread over the people on the other side, in proportion to theirs
 *     (exact when one person paid, which is the usual case)
 *   - settle-ups (category "Payment" or "A paid B") move money, they aren't spending
 * The sign convention is detected from "A paid B" rows; the preview lets you flip it if needed.
 */
export const CsvInput = z.object({
  me: z.string().trim().min(1).max(120),
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  defaultAccountId: z.string().uuid(),
  flip: z.boolean().optional(),
  skip: z.array(z.string().max(100)).max(20000).optional(),
  files: z.array(z.object({
    name: z.string().max(200),
    rows: z.array(z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      description: z.string().max(300),
      category: z.string().max(100).optional().nullable(),
      cost: z.number().int().nonnegative(),
      currency: z.string().max(8).optional().nullable(),
      nets: z.record(z.string().max(120), z.number().int()),
    })).max(20000),
  })).min(1).max(100),
});
type CsvIn = z.infer<typeof CsvInput>;

const keyName = (n: string) => n.trim().toLowerCase();

/** Which way round are the numbers? +1: positive = paid more / is owed. −1: positive = owes. */
export function detectSign(input: Pick<CsvIn, 'files'>): { sign: 1 | -1; evidence: number } {
  let votes = 0, evidence = 0;
  for (const f of input.files) {
    for (const r of f.rows) {
      const m = r.description.match(/^\s*(.+?)\s+paid\s+(.+?)\s*\.?\s*$/i);
      if (!m) continue;
      const payer = Object.keys(r.nets).find((n) => keyName(n).startsWith(keyName(m[1]).replace(/\.$/, '').split(' ')[0]));
      if (!payer || r.nets[payer] === 0) continue;
      votes += r.nets[payer] > 0 ? 1 : -1;
      evidence++;
    }
  }
  return { sign: votes < 0 ? -1 : 1, evidence };
}

export async function planCsv(sql: Sql, bookId: string, input: CsvIn) {
  const detected = detectSign(input);
  const sign = (detected.sign * (input.flip ? -1 : 1)) as 1 | -1;
  const me = keyName(input.me);
  const since = input.since ?? null;
  const cats = await sql<{ id: string; name: string }[]>`
    select id, name from account where book_id = ${bookId} and kind = 'category' and class = 'expense' and not is_archived
      and not exists (select 1 from account c where c.parent_id = account.id)`;
  const other = cats.find((c) => c.name === 'Other') ?? cats[0];
  const pickCategory = (swName: string | null | undefined, desc: string) => {
    const hay = `${swName ?? ''} ${desc}`;
    for (const [re, needles] of CATEGORY_MAP) {
      if (!re.test(hay)) continue;
      for (const n of needles) { const c = cats.find((x) => x.name.toLowerCase().includes(n)); if (c) return c; }
    }
    return other;
  };
  const done = new Set((await sql<{ external_ref: string }[]>`
    select external_ref from txn where book_id = ${bookId} and status = 'posted' and external_ref like 'swcsv:%'`).map((r) => r.external_ref));

  // Groups (more columns) first, so when a friend export repeats a group expense, the group version wins.
  const files = [...input.files].sort((a, b) => Object.keys(b.rows[0]?.nets ?? {}).length - Object.keys(a.rows[0]?.nets ?? {}).length);
  const seen = new Map<string, number>();
  const people = new Map<string, { swId: string; name: string; allTime: number; window: number }>();
  const plans: Plan[] = [];
  let skippedCurrency = 0, skippedInconsistent = 0, duplicatesAcrossFiles = 0, notInvolved = 0;
  const seenInFile = new Map<string, Map<string, number>>();

  for (const f of files) {
    const local = new Map<string, number>();
    seenInFile.set(f.name, local);
    for (const r of f.rows) {
      if (r.currency && r.currency.toUpperCase() !== 'INR') { skippedCurrency++; continue; }
      const meCol = Object.keys(r.nets).find((n) => keyName(n) === me);
      if (!meCol) continue;
      // The same expense can appear in a group export and a friend export: key it without the people columns.
      const base = `${r.date}|${r.description.trim().toLowerCase()}|${r.cost}`;
      const occ = (local.get(base) ?? 0) + 1;
      local.set(base, occ);
      const key = `${base}#${occ}`;
      if ((seen.get(key) ?? 0) > 0) { duplicatesAcrossFiles++; continue; }
      seen.set(key, 1);

      const nets = Object.fromEntries(Object.entries(r.nets).map(([k, v]) => [k, v * sign]));
      const mine = nets[meCol];
      if (mine === 0) { notInvolved++; continue; }
      const isPayment = /^payment$/i.test(r.category ?? '') || /\bpaid\b/i.test(r.description) && Object.values(nets).filter((v) => v !== 0).length === 2 && !r.category;
      const others = Object.entries(nets).filter(([k, v]) => k !== meCol && v !== 0 && Math.sign(v) === -Math.sign(mine));
      const pool = others.reduce((s, [, v]) => s + Math.abs(v), 0);
      if (!pool) { skippedInconsistent++; continue; }
      // Spread your net over the other side, in proportion; the last person absorbs rounding.
      let left = mine;
      const lines = others.map(([k, v], i) => {
        const amt = i === others.length - 1 ? left : Math.round((mine * Math.abs(v)) / pool);
        left -= amt;
        return { swId: keyName(k), name: k.trim(), amount: amt };
      }).filter((l) => l.amount !== 0);
      let yourShare = 0, bank: number, kind: Plan['kind'];
      if (isPayment) { bank = -mine; kind = 'transfer'; }
      else if (mine > 0) { yourShare = r.cost - mine; bank = -r.cost; kind = yourShare > 0 ? 'split' : 'transfer'; }
      else { yourShare = -mine; bank = 0; kind = 'split'; }
      if (yourShare < 0 || yourShare > r.cost) { skippedInconsistent++; continue; }

      const inWindow = !since || r.date >= since;
      for (const l of lines) {
        if (!people.has(l.swId)) people.set(l.swId, { swId: l.swId, name: l.name, allTime: 0, window: 0 });
        const p = people.get(l.swId)!;
        p.allTime += l.amount;
        if (inWindow) p.window += l.amount;
      }
      const cat = !isPayment && yourShare > 0 ? pickCategory(r.category, r.description) : null;
      const ref = `swcsv:${crypto.createHash('sha1').update(key).digest('hex').slice(0, 24)}`;
      plans.push({
        id: ref, date: r.date, description: r.description.slice(0, 120) || (isPayment ? 'Settle up' : 'Splitwise expense'), kind,
        yourShare, youPaid: mine > 0 && !isPayment ? r.cost : 0, categoryId: cat?.id ?? null, categoryName: cat?.name ?? null,
        people: lines, bank, status: done.has(ref) ? 'imported' : inWindow ? 'new' : 'before_start', updatedAt: '',
      });
    }
  }
  plans.sort((a, b) => b.date.localeCompare(a.date));

  const persons = await sql<{ id: string; name: string; swname: string | null }[]>`
    select id, name, meta->>'splitwise_name' as swname from account where book_id = ${bookId} and kind = 'receivable'`;
  const balances = await sql<{ id: string; balance: number }[]>`
    select p.account_id as id, sum(p.amount)::bigint as balance from posting p join txn t on t.id = p.txn_id
    where t.book_id = ${bookId} and t.status = 'posted' and p.account_id = any(${persons.map((p) => p.id)}::uuid[]) group by 1`;
  const balOf = new Map(balances.map((b) => [b.id, b.balance]));
  const friends = [...people.values()].map((p) => {
    const first = p.name.split(' ')[0].toLowerCase();
    const linked = persons.find((x) => x.swname === p.swId) ?? persons.find((x) => x.name.toLowerCase() === p.name.toLowerCase())
      ?? persons.find((x) => !x.swname && x.name.toLowerCase() === first);
    return { ...p, accountId: linked?.id ?? null, accountName: linked?.name ?? null, appBalance: linked ? balOf.get(linked.id) ?? 0 : null };
  }).sort((a, b) => Math.abs(b.allTime) - Math.abs(a.allTime));

  return {
    since, sign, signEvidence: detected.evidence, flipped: !!input.flip,
    expenses: plans.filter((p) => p.status !== 'before_start'), friends,
    skippedCurrency, skippedInconsistent, duplicatesAcrossFiles, notInvolved,
    total: input.files.reduce((s, f) => s + f.rows.length, 0),
  };
}

export async function importCsv(sql: Sql, bookId: string, input: CsvIn) {
  const p = await planCsv(sql, bookId, input);
  return bookPlan(sql, bookId, { since: p.since, defaultAccountId: input.defaultAccountId, expenses: p.expenses, friends: p.friends }, input.skip ?? [], {
    ref: (e) => String(e.id),
    meta: (fr) => ({ splitwise_name: String(fr.swId) }),
  });
}
