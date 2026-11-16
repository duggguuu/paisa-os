/**
 * Encrypted backups of the owner's real book.
 *
 * - The owner sets a backup passphrase once (Settings → Backup). We derive a key from it with scrypt
 *   and keep that key encrypted with APP_SECRET in app_setting, so the nightly job can encrypt
 *   without the owner present. The passphrase itself is never stored.
 * - A backup file is JSON: { format, v, createdAt, kdf {salt,N,r,p}, iv, tag, data } where data is
 *   AES-256-GCM over gzip(JSON of every book table). Anyone with the passphrase can decrypt it,
 *   including a fresh copy of the app on a new database; APP_SECRET is not needed.
 * - GitHub Actions (.github/workflows/backup.yml) calls POST /api/cron/backup daily with the cron
 *   key and keeps only the newest file as a workflow artifact (each day replaces the previous one).
 * - Restore replaces the book's data in ONE transaction: it all lands, or nothing changes.
 *   Left out on purpose: audit_log (append-only), Kite/Splitwise links (secrets; re-link after a
 *   restore), login, passkeys and sessions.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { Sql } from './db.js';
import { LedgerError } from './ledger.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const KDF = { N: 1 << 15, r: 8, p: 1 };
type Cipher = { encrypt(s: string): string; decrypt(s: string): string };

/** Tables restored in this order (parents first); deleted in reverse-ish order below. */
const TABLES = ['account', 'import_batch', 'recurring_rule', 'txn', 'posting', 'budget', 'goal', 'goal_contribution', 'holding_snapshot', 'salary_profile', 'salary_slip', 'stuff_item'] as const;

export interface BackupFile { format: 'paisa-backup'; v: 1; createdAt: string; kdf: { name: 'scrypt'; salt: string; N: number; r: number; p: number }; iv: string; tag: string; data: string }

async function derive(passphrase: string, salt: Buffer, k = KDF) {
  return scrypt(passphrase.normalize('NFC'), salt, 32, { N: k.N, r: k.r, p: k.p, maxmem: 256 * k.N * k.r });
}

const settingKey = (userId: string) => `backup:${userId}`;

export async function status(sql: Sql, userId: string) {
  const [row] = await sql<{ value: any }[]>`select value from app_setting where key = ${settingKey(userId)}`;
  return { configured: !!row?.value?.key, lastBackupAt: row?.value?.lastBackupAt ?? null, lastBackupBytes: row?.value?.lastBackupBytes ?? null, hint: row?.value?.hint ?? null };
}

/** Set (or change) the passphrase. Older backup files keep working with the passphrase they were made with. */
export async function setPassphrase(sql: Sql, cipher: Cipher, userId: string, passphrase: string, hint: string | null) {
  if (passphrase.length < 10) throw new LedgerError('weak_passphrase', 'Use at least 10 characters', 422);
  const salt = randomBytes(16);
  const key = await derive(passphrase, salt);
  const prev = await status(sql, userId);
  const value = { salt: salt.toString('base64'), kdf: KDF, key: cipher.encrypt(key.toString('base64')), hint, lastBackupAt: prev.lastBackupAt, lastBackupBytes: prev.lastBackupBytes };
  await sql`insert into app_setting (key, value, updated_at) values (${settingKey(userId)}, ${sql.json(value)}, now())
            on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

async function tableColumns(sql: Sql, table: string) {
  const rows = await sql<{ column_name: string }[]>`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = ${table} and is_generated = 'NEVER' and coalesce(identity_generation, '') <> 'ALWAYS'
    order by ordinal_position`;
  return rows.map((r) => r.column_name);
}

/** Every row of the book, as plain JSON. */
export async function snapshot(sql: Sql, bookId: string) {
  const tables: Record<string, any[]> = {};
  for (const t of TABLES) {
    // Postgres writes the JSON itself, so dates stay 'YYYY-MM-DD' and big numbers stay exact.
    const inner = t === 'posting' ? 'select p.* from posting p join txn t on t.id = p.txn_id where t.book_id = $1' : `select * from ${t} where book_id = $1`;
    const [r] = await sql.unsafe(`select coalesce(json_agg(x), '[]'::json)::text as rows from (${inner}) x`, [bookId]);
    tables[t] = JSON.parse(r.rows);
  }
  const [book] = await sql<any[]>`select name, month_start_day from book where id = ${bookId}`;
  return { book, tables };
}

export async function makeBackup(sql: Sql, cipher: Cipher, userId: string, bookId: string): Promise<BackupFile> {
  const [row] = await sql<{ value: any }[]>`select value from app_setting where key = ${settingKey(userId)}`;
  if (!row?.value?.key) throw new LedgerError('no_passphrase', 'Set a backup passphrase in Settings → Backup first', 409);
  const key = Buffer.from(cipher.decrypt(row.value.key), 'base64');
  const plain = gzipSync(Buffer.from(JSON.stringify(await snapshot(sql, bookId))));
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(plain), c.final()]);
  const file: BackupFile = {
    format: 'paisa-backup', v: 1, createdAt: new Date().toISOString(),
    kdf: { name: 'scrypt', salt: row.value.salt, ...(row.value.kdf ?? KDF) },
    iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64'),
  };
  const bytes = JSON.stringify(file).length;
  await sql`update app_setting set value = value || ${sql.json({ lastBackupAt: file.createdAt, lastBackupBytes: bytes })}, updated_at = now() where key = ${settingKey(userId)}`;
  return file;
}

export async function openBackup(file: BackupFile, passphrase: string) {
  if (file?.format !== 'paisa-backup' || file.v !== 1) throw new LedgerError('not_a_backup', "That file isn't a Paisa backup", 422);
  const key = await derive(passphrase, Buffer.from(file.kdf.salt, 'base64'), file.kdf);
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
    d.setAuthTag(Buffer.from(file.tag, 'base64'));
    const plain = Buffer.concat([d.update(Buffer.from(file.data, 'base64')), d.final()]);
    return JSON.parse(gunzipSync(plain).toString('utf8')) as Awaited<ReturnType<typeof snapshot>>;
  } catch {
    throw new LedgerError('wrong_passphrase', "Wrong passphrase, or the file was changed", 422);
  }
}

/** What a backup contains, without changing anything. */
export function describe(s: Awaited<ReturnType<typeof snapshot>>, createdAt: string) {
  const t = s.tables;
  return {
    createdAt,
    accounts: (t.account ?? []).filter((a) => a.kind !== 'category' && a.kind !== 'equity').length,
    categories: (t.account ?? []).filter((a) => a.kind === 'category').length,
    transactions: (t.txn ?? []).length,
    recurring: (t.recurring_rule ?? []).length,
    goals: (t.goal ?? []).length,
    firstDate: (t.txn ?? []).map((x) => String(x.occurred_on).slice(0, 10)).sort()[0] ?? null,
    lastDate: (t.txn ?? []).map((x) => String(x.occurred_on).slice(0, 10)).sort().at(-1) ?? null,
  };
}

/** Accounts in parent-first order; txns with the ones they refund first. */
function ordered(table: string, rows: any[]) {
  if (table !== 'account' && table !== 'txn') return rows;
  const ref = table === 'account' ? 'parent_id' : 'refund_of';
  const ids = new Set(rows.map((r) => r.id));
  const done = new Set<string>(); const out: any[] = [];
  let pending = rows;
  while (pending.length) {
    const next = pending.filter((r) => !r[ref] || !ids.has(r[ref]) || done.has(r[ref]));
    if (!next.length) { out.push(...pending); break; }
    for (const r of next) { out.push(r); done.add(r.id); }
    pending = pending.filter((r) => !done.has(r.id));
  }
  return out;
}

/** Replace the book's data with the backup's, in one transaction. */
export async function restore(sql: Sql, bookId: string, s: Awaited<ReturnType<typeof snapshot>>) {
  await sql.begin(async (tx) => {
    await tx`delete from goal_contribution where book_id = ${bookId}`;
    await tx`delete from stuff_item where book_id = ${bookId}`;
    await tx`delete from salary_profile where book_id = ${bookId}`;
    await tx`delete from salary_slip where book_id = ${bookId}`;
    await tx`delete from holding_snapshot where book_id = ${bookId}`;
    await tx`delete from budget where book_id = ${bookId}`;
    await tx`delete from goal where book_id = ${bookId}`;
    await tx`delete from txn where book_id = ${bookId}`; // postings cascade
    await tx`delete from recurring_rule where book_id = ${bookId}`;
    await tx`delete from import_batch where book_id = ${bookId}`;
    await tx`update splitwise_link set default_account_id = null where book_id = ${bookId}`;
    await tx`delete from account where book_id = ${bookId}`;
    for (const t of TABLES) {
      const rows = ordered(t, s.tables[t] ?? []);
      if (!rows.length) continue;
      const cols = await tableColumns(tx as any, t);
      const usable = cols.filter((c) => c in rows[0]);
      const list = usable.map((c) => `"${c}"`).join(', ');
      const select = usable.map((c) => (c === 'book_id' ? '$2::uuid' : `"${c}"`)).join(', ');
      for (let i = 0; i < rows.length; i += 500) {
        await tx.unsafe(`insert into ${t} (${list}) select ${select} from json_populate_recordset(null::${t}, ($1::text)::json)`, usable.includes('book_id') ? [JSON.stringify(rows.slice(i, i + 500)), bookId] : [JSON.stringify(rows.slice(i, i + 500))]);
      }
    }
    if (s.book?.month_start_day) await tx`update book set month_start_day = ${s.book.month_start_day} where id = ${bookId}`;
  });
}
