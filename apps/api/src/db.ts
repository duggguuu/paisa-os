import postgres from 'postgres';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Sql = postgres.Sql<{}>;
// Inside sql.begin() callbacks postgres.js hands us a TransactionSql, which can do everything we use.
export type Tx = postgres.TransactionSql<{}> | Sql;

/**
 * int8 (bigint) columns come back as JS numbers. Paise fit comfortably:
 * 2^53 paise is about ₹90 lakh crore.
 */
export function makeSql(url: string): Sql {
  // Neon's copy-paste URLs include channel_binding=require, which postgres.js would forward
  // to the server as a startup parameter. TLS still comes from sslmode=require.
  try {
    const u = new URL(url);
    if (u.searchParams.has('channel_binding')) { u.searchParams.delete('channel_binding'); url = u.toString(); }
  } catch { /* not a URL; let postgres.js report it */ }
  return postgres(url, {
    max: Number(process.env.DB_POOL_MAX ?? 10),
    onnotice: () => {},
    transform: { undefined: null },
    types: {
      int8: {
        to: 20,
        from: [20],
        serialize: (x: number) => String(x),
        parse: (x: string) => {
          const n = Number(x);
          if (!Number.isSafeInteger(n)) throw new Error(`bigint ${x} exceeds safe integer range`);
          return n;
        },
      },
    } as any,
  }) as unknown as Sql;
}

export function findMigrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'db', 'migrations');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('db/migrations not found; set MIGRATIONS_DIR');
}

/**
 * Apply new migrations in filename order. Each applied file's checksum is recorded; if an
 * already-applied file is later edited, startup stops here instead of silently running with
 * a schema that no longer matches the code. (On Render a failed start keeps the previous
 * version live, so your data is never touched.) Change the schema by adding a new file.
 */
export async function migrate(sql: Sql): Promise<string[]> {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  await sql`alter table schema_migrations add column if not exists checksum text`;
  const dir = findMigrationsDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const done = new Map((await sql<{ name: string; checksum: string | null }[]>`select name, checksum from schema_migrations`).map((r) => [r.name, r.checksum]));
  const applied: string[] = [];
  for (const f of files) {
    const body = fs.readFileSync(path.join(dir, f), 'utf8');
    const checksum = crypto.createHash('sha256').update(body.replace(/\r\n/g, '\n')).digest('hex');
    if (done.has(f)) {
      const was = done.get(f);
      if (was === null) await sql`update schema_migrations set checksum = ${checksum} where name = ${f}`;
      else if (was !== checksum) {
        throw new Error(`Migration ${f} was edited after it was applied to this database. Never edit an applied migration: put the change in a new file (e.g. ${nextName(files)}).`);
      }
      continue;
    }
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name, checksum) values (${f}, ${checksum})`;
    });
    applied.push(f);
  }
  return applied;
}

function nextName(files: string[]): string {
  const n = Math.max(0, ...files.map((f) => Number(f.split('_')[0]) || 0)) + 1;
  return `${String(n).padStart(3, '0')}_describe_change.sql`;
}
