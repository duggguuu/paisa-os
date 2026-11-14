import postgres from 'postgres';
import fs from 'node:fs';
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

export async function migrate(sql: Sql): Promise<string[]> {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const dir = findMigrationsDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const done = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const body = fs.readFileSync(path.join(dir, f), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name) values (${f})`;
    });
    applied.push(f);
  }
  return applied;
}
