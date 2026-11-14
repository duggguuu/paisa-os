# Paisa OS: rules for changing this app

This app is **live with real financial data**. Production = Render web service (free plan), deployed automatically on every push to `main` of the private repo `duggguuu/paisa-os`. The data lives in a **Neon Postgres** database, which is separate from the code. Deploys replace code, never data.

## Golden rules (data safety)

1. **Never edit or delete a file in `db/migrations/` once it has been pushed.** Change the schema by adding the next numbered file (`002_…sql`, `003_…sql`). `migrate()` checks every applied file's checksum and refuses to start if one was edited. On Render a failed start keeps the previous version live, so this protects the data, but it also blocks the deploy.
2. **Migrations must be additive and safe on existing rows:** `create table`, `add column … default …` or nullable columns, new indexes, new views/functions. Each file runs in one transaction.
3. **Destructive changes** (drop/rename a column or table, changing types, rewriting data) need two steps and a backup:
   - Ship code that stops using the old column first, then drop it in a later migration.
   - Before anything that rewrites or deletes rows, take a backup: Settings → Export in the app, and/or create a Neon branch (a point-in-time copy) in the Neon console.
4. **Ledger invariants are enforced by the database. Don't weaken them:** postings per transaction sum to zero (deferred trigger), `audit_log` is append-only, and deleting a transaction voids it. Money is integer paise, never floats.
5. **Never commit secrets.** `DATABASE_URL`, `APP_SECRET` and Kite keys live only in Render's environment. `APP_SECRET` must never change, because it decrypts the stored Kite secret and signs sessions.
6. **Run `npm test` before every push.** It needs a throwaway Postgres (`TEST_DATABASE_URL`). The tests DROP the `public` schema of that database, so never point `TEST_DATABASE_URL` at Neon production.

## Working on it

- `npm run build` builds the web and API apps. `npm test` runs the API/ledger tests (real Postgres) plus the web voice-parser tests.
- Testing a risky migration against real data: create a Neon **branch** of production, run the new version locally against the branch's URL, check it, then delete the branch.
- The demo book (Settings → sample data) is fully separate from the real book. Use it to try UI changes on the live app.

## Layout

- `apps/api/src/`: Fastify API. Core files: `ledger.ts` (posting rules), `stats.ts`, `dashboard.ts`, `kite.ts` (read-only Zerodha), `db.ts` (pool + migrations).
- `apps/web/src/`: React PWA. `voice.ts` is the local sentence parser for voice entry (no external AI). `styles.css` holds the design tokens ("Emerald & Ivory").
- `db/migrations/`: append-only SQL.
- `render.yaml`: the Render blueprint.
