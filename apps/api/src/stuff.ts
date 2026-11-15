/**
 * Stuff: things you own, want, asked about, dropped or sold — linked to the ledger.
 *
 * Buying (from a screenshot or a sentence, parsed in the browser) books ONE expense for what you
 * paid, then puts each item in Own. A matching Want item (same product code in its link, or a
 * close name) moves to Own instead of being duplicated. Selling books the money in and moves the
 * item to Sold, so it leaves Own but keeps its history.
 */
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql, Tx } from './db.js';
import { createTxn, LedgerError, audit } from './ledger.js';
import { todayIST } from './money.js';

const LISTS = ['own', 'want', 'asked', 'dropped', 'sold'] as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const paise = z.number().int().min(0).max(1e13);

export const ItemInput = z.object({
  list: z.enum(LISTS),
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().max(60).optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
  price: paise.optional().nullable(),
  store: z.string().trim().max(80).optional().nullable(),
  link: z.string().trim().max(500).optional().nullable(),
  meta: z.record(z.string(), z.unknown()).optional(),
  acquiredOn: date.optional().nullable(),
});
type Item = z.infer<typeof ItemInput>;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['the', 'a', 'an', 'and', 'with', 'of', 'fit', 'regular', 'relaxed', 'mens', 'men', 'man', 'size', 'colour', 'color']);
const words = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length > 1 && !STOP.has(w)));
/** Share of the shorter name's words found in the other (0–1). */
export function nameMatch(a: string, b: string) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  let hit = 0;
  for (const w of small) if (big.has(w) || [...big].some((x) => x.length > 4 && w.length > 4 && (x.startsWith(w) || w.startsWith(x)))) hit++;
  return hit / small.size;
}
/** Product code inside a store link, e.g. H&M productpage.1351283001 → 1351283001. */
const codeInLink = (link?: string | null) => (link?.match(/(\d{8,})/)?.[1] ?? null);

export async function list(sql: Sql | Tx, bookId: string, which?: string) {
  return sql<any[]>`
    select i.*, i.acquired_on::text as acquired_on, i.sold_on::text as sold_on from stuff_item i
    where i.book_id = ${bookId} ${which ? sql`and i.list = ${which}` : sql``}
    order by i.list, i.category nulls last, i.sort, i.created_at`;
}

export async function create(sql: Sql, bookId: string, input: Item) {
  const [row] = await sql<{ id: string }[]>`
    insert into stuff_item (book_id, list, name, category, notes, price, store, link, meta, acquired_on)
    values (${bookId}, ${input.list}, ${input.name}, ${input.category ?? null}, ${input.notes ?? null}, ${input.price ?? null},
            ${input.store ?? null}, ${input.link ?? null}, ${sql.json((input.meta ?? {}) as any)}, ${input.acquiredOn ?? null})
    returning id`;
  return row.id;
}

export async function update(sql: Sql, bookId: string, id: string, input: Item) {
  const r = await sql`
    update stuff_item set list = ${input.list}, name = ${input.name}, category = ${input.category ?? null}, notes = ${input.notes ?? null},
      price = ${input.price ?? null}, store = ${input.store ?? null}, link = ${input.link ?? null},
      meta = ${sql.json((input.meta ?? {}) as any)}, acquired_on = ${input.acquiredOn ?? null}, updated_at = now()
    where id = ${id} and book_id = ${bookId}`;
  if (!r.count) throw new LedgerError('not_found', 'item not found', 404);
}

export async function remove(sql: Sql, bookId: string, id: string) {
  await sql`delete from stuff_item where id = ${id} and book_id = ${bookId}`;
}

/** Bulk import (e.g. from the sheet). Skips items already on the same list by name. */
export async function importItems(sql: Sql, bookId: string, items: Item[]) {
  const existing = await list(sql, bookId);
  const seen = new Set(existing.map((e) => `${e.list}|${norm(e.name)}`));
  let added = 0, skipped = 0;
  await sql.begin(async (tx) => {
    for (const [i, it] of items.entries()) {
      const k = `${it.list}|${norm(it.name)}`;
      if (seen.has(k)) { skipped++; continue; }
      seen.add(k);
      await tx`insert into stuff_item (book_id, list, name, category, notes, price, store, link, meta, acquired_on, sort)
               values (${bookId}, ${it.list}, ${it.name}, ${it.category ?? null}, ${it.notes ?? null}, ${it.price ?? null}, ${it.store ?? null},
                       ${it.link ?? null}, ${tx.json((it.meta ?? {}) as any)}, ${it.acquiredOn ?? null}, ${i})`;
      added++;
    }
    await audit(tx, bookId, 'stuff', bookId, 'import', null, { added, skipped }, 'user');
  });
  return { added, skipped };
}

/** The owner's sheet snapshot (data/stuff-sheet.json), if this copy of the app has one. Clean exports don't. */
function snapshotFile() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const d of [path.resolve(here, '../data'), path.resolve(here, '../../data')]) {
    const f = path.join(d, 'stuff-sheet.json');
    if (fs.existsSync(f)) return f;
  }
  return null;
}
export const hasSnapshot = () => snapshotFile() !== null;
export function sheetSnapshot(): Item[] {
  const f = snapshotFile();
  if (!f) throw new LedgerError('no_snapshot', 'This copy of the app has no sheet snapshot', 404);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

// ---------- buying ----------
export const PurchaseInput = z.object({
  date: date.optional(),
  accountId: z.string().uuid(),
  categoryId: z.string().uuid(),          // expense category for the whole order
  store: z.string().trim().max(80).optional().nullable(),
  total: paise.refine((n) => n > 0, 'total must be more than zero'),
  note: z.string().trim().max(500).optional().nullable(),
  idempotencyKey: z.string().uuid().optional(),
  items: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    category: z.string().trim().max(60).optional().nullable(),
    brand: z.string().trim().max(60).optional().nullable(),
    colour: z.string().trim().max(60).optional().nullable(),
    size: z.string().trim().max(30).optional().nullable(),
    artNo: z.string().trim().max(40).optional().nullable(),
    quantity: z.number().int().min(1).max(99).optional(),
    paid: paise.optional().nullable(),     // this line's share of the total, after discounts
    listPrice: paise.optional().nullable(),
  })).max(100),
});

export async function purchase(sql: Sql, bookId: string, input: z.infer<typeof PurchaseInput>) {
  const day = input.date ?? todayIST();
  const names = input.items.map((i) => i.name);
  const note = input.note ?? (names.length ? names.join(' · ').slice(0, 500) : null);
  const { id: txnId } = await createTxn(sql, bookId, {
    kind: 'expense', amount: input.total, accountId: input.accountId, categoryId: input.categoryId, date: day,
    merchant: input.store ?? (names.length === 1 ? names[0] : 'Purchase'), note, source: 'receipt', idempotencyKey: input.idempotencyKey,
  });
  const out = { txnId, addedToOwn: [] as string[], movedFromWant: [] as string[], alreadyOwned: [] as string[] };
  await sql.begin(async (tx) => {
    const wants = await list(tx, bookId, 'want');
    const owns = await list(tx, bookId, 'own');
    for (const it of input.items) {
      const meta = Object.fromEntries(Object.entries({ brand: it.brand, colour: it.colour, size: it.size, art_no: it.artNo, quantity: it.quantity, list_price: it.listPrice }).filter(([, v]) => v != null && v !== ''));
      const details = [it.brand, it.colour, it.size && `size ${it.size}`].filter(Boolean).join(', ');
      // 1) A Want item for the same product? Move it to Own.
      const byCode = it.artNo ? wants.find((w) => { const c = codeInLink(w.link); return c && it.artNo!.startsWith(c); }) : null;
      const byName = byCode ? null : wants.map((w) => ({ w, s: nameMatch(w.name, `${it.name} ${it.colour ?? ''}`) })).filter((x) => x.s >= 0.75).sort((a, b) => b.s - a.s)[0]?.w;
      const want = byCode ?? byName;
      if (want) {
        await tx`update stuff_item set list = 'own', price = ${it.paid ?? want.price}, acquired_on = ${day}, txn_id = ${txnId},
                   meta = meta || ${tx.json(meta as any)}, store = coalesce(store, ${input.store ?? null}), updated_at = now()
                 where id = ${want.id}`;
        wants.splice(wants.indexOf(want), 1);
        out.movedFromWant.push(want.name);
        continue;
      }
      // 2) Already in Own (e.g. imported from the sheet)? Just link the purchase.
      const own = owns.find((o) => (it.artNo && o.meta?.art_no === it.artNo) || (!o.txn_id && nameMatch(o.name, it.name) >= 0.9));
      if (own) {
        if (!own.txn_id) await tx`update stuff_item set txn_id = ${txnId}, acquired_on = coalesce(acquired_on, ${day}), price = coalesce(price, ${it.paid ?? null}) where id = ${own.id}`;
        out.alreadyOwned.push(own.name);
        continue;
      }
      // 3) New to Own.
      await tx`insert into stuff_item (book_id, list, name, category, notes, price, store, meta, acquired_on, txn_id)
               values (${bookId}, 'own', ${it.name}, ${it.category ?? null}, ${details || null}, ${it.paid ?? it.listPrice ?? null},
                       ${input.store ?? it.brand ?? null}, ${tx.json(meta as any)}, ${day}, ${txnId})`;
      out.addedToOwn.push(it.name);
    }
    await audit(tx, bookId, 'stuff', txnId, 'purchase', null, out, 'user');
  });
  return out;
}

// ---------- selling ----------
export const SaleInput = z.object({
  itemId: z.string().uuid(),
  price: paise.refine((n) => n > 0),
  date: date.optional(),
  accountId: z.string().uuid(),
  categoryId: z.string().uuid(),
  buyer: z.string().trim().max(80).optional().nullable(),
});

export async function sell(sql: Sql, bookId: string, input: z.infer<typeof SaleInput>) {
  const [item] = await sql<any[]>`select * from stuff_item where id = ${input.itemId} and book_id = ${bookId}`;
  if (!item) throw new LedgerError('not_found', 'item not found', 404);
  if (item.list === 'sold') throw new LedgerError('already_sold', `${item.name} is already marked sold`, 409);
  const day = input.date ?? todayIST();
  const { id } = await createTxn(sql, bookId, {
    kind: 'income', amount: input.price, accountId: input.accountId, categoryId: input.categoryId, date: day,
    merchant: input.buyer || `Sold: ${item.name}`.slice(0, 120), note: `Sold ${item.name}`.slice(0, 500), source: 'manual',
  });
  await sql`update stuff_item set list = 'sold', sold_on = ${day}, sold_price = ${input.price}, sale_txn_id = ${id}, updated_at = now() where id = ${item.id}`;
  return { txnId: id, item: item.name };
}

/** Everything, laid out like the sheet's tabs — for syncing the sheet. */
export async function exportAll(sql: Sql, bookId: string) {
  const rows = await list(sql, bookId);
  const by = (l: string) => rows.filter((r) => r.list === l);
  return { exportedAt: new Date().toISOString(), own: by('own'), want: by('want'), asked: by('asked'), dropped: by('dropped'), sold: by('sold') };
}
