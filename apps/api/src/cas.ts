/**
 * Mutual fund holdings from a CAS (Consolidated Account Statement, CAMS/KFintech or MF Central).
 *
 * The PDF is unlocked and read in the browser (the password never reaches the server). The
 * browser sends the parsed holdings; this stores them as a dated snapshot on a "Mutual funds"
 * investment account, the same way Zerodha syncs work. Funds Zerodha already reports (same
 * ISIN in the latest Kite sync) are skipped so nothing is counted twice in net worth.
 */
import { z } from 'zod';
import type { Sql } from './db.js';
import { audit } from './ledger.js';

export const CasInput = z.object({
  statementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fileName: z.string().max(200).optional().nullable(),
  holdings: z.array(z.object({
    isin: z.string().regex(/^IN[A-Z0-9]{10}$/),
    name: z.string().trim().min(1).max(200),
    folio: z.string().max(40).optional().nullable(),
    units: z.number().nonnegative(),
    nav: z.number().nonnegative(),
    value: z.number().nonnegative(),          // rupees
    cost: z.number().nonnegative().optional().nullable(),
  })).max(500),
});

async function casAccount(sql: Sql, bookId: string): Promise<string> {
  const [acc] = await sql<{ id: string }[]>`
    select id from account where book_id = ${bookId} and kind = 'investment' and (meta->>'cas')::boolean is true limit 1`;
  if (acc) return acc.id;
  const [row] = await sql<{ id: string }[]>`
    insert into account (book_id, class, kind, name, institution, icon, meta)
    values (${bookId}, 'asset', 'investment', 'Mutual funds', 'CAS', '🧺', ${sql.json({ cas: true })})
    on conflict do nothing returning id`;
  if (row) return row.id;
  const [byName] = await sql<{ id: string }[]>`select id from account where book_id = ${bookId} and kind = 'investment' and lower(name) = 'mutual funds'`;
  await sql`update account set meta = meta || '{"cas": true}'::jsonb where id = ${byName.id}`;
  return byName.id;
}

export async function importCas(sql: Sql, bookId: string, input: z.infer<typeof CasInput>) {
  const kiteIsins = new Set((await sql<{ isin: string }[]>`
    with latest as (select account_id, max(taken_at) as taken_at from holding_snapshot where book_id = ${bookId} and source = 'kite' group by account_id)
    select h.isin from holding_snapshot h join latest l on l.account_id = h.account_id and l.taken_at = h.taken_at where h.isin is not null`).map((r) => r.isin));
  const keep = input.holdings.filter((h) => h.units > 0 && !kiteIsins.has(h.isin));
  const skipped = input.holdings.filter((h) => kiteIsins.has(h.isin)).map((h) => h.name);
  const accountId = await casAccount(sql, bookId);
  // Snapshot time = end of the statement date (IST), so a newer Kite sync of other funds doesn't hide it.
  const takenAt = `${input.statementDate}T23:59:00+05:30`;
  await sql.begin(async (tx) => {
    for (const h of keep) {
      const avg = h.cost && h.units ? h.cost / h.units : h.nav;
      await tx`insert into holding_snapshot (book_id, account_id, taken_at, source, instrument, isin, asset_type, quantity, avg_price, last_price, value_paise)
               values (${bookId}, ${accountId}, ${takenAt}, 'cas', ${h.name}, ${h.isin}, 'mf', ${h.units}, ${avg}, ${h.nav}, ${Math.round(h.value * 100)})`;
    }
    await tx`insert into import_batch (book_id, account_id, source, file_name, rows_total, rows_imported, closing_date)
             values (${bookId}, ${accountId}, 'cas', ${input.fileName ?? null}, ${input.holdings.length}, ${keep.length}, ${input.statementDate})`;
    await audit(tx, bookId, 'holdings', accountId, 'cas', null, { count: keep.length, skipped: skipped.length, statementDate: input.statementDate }, 'cas');
  });
  return { accountId, imported: keep.length, skippedAlreadyInZerodha: skipped, value: Math.round(keep.reduce((s, h) => s + h.value, 0) * 100) };
}
