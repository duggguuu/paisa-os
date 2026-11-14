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

- `apps/api/src/`: Fastify API. Core files: `ledger.ts` (posting rules), `stats.ts`, `dashboard.ts` (net worth, safe-to-spend), `kite.ts` (read-only Zerodha), `db.ts` (pool + migrations). Feature modules: `recurring.ts`, `importer.ts` (statements), `cas.ts`, `splitwise.ts` (read-only), `insights.ts`, `goals.ts`, `planner.ts` (Budget Planner numbers, Financial Health score), `copilot.ts` (local engine; Claude only if `ANTHROPIC_API_KEY` is set), with routes in `routes-extra.ts`.
- Passkeys/app lock: `passkeys.ts` (@simplewebauthn/server). The RP ID comes from PUBLIC_URL/RENDER_EXTERNAL_URL, so changing the domain invalidates existing passkeys. `requireAuth` enforces the lock (HTTP 423); only the unlock, lock, status and logout routes accept a locked session. Lock = idle (`lock_minutes`) **or** lock-on-open: every login/unlock returns an `unlockKey` that the web app keeps in sessionStorage and sends as `x-unlock`; the session stores hashes of the last 8 (`session.unlock_keys`), so a new tab or a fresh app start is locked. Unlock with Face ID or the password (`/api/auth/unlock/password`). Any raw `fetch` to /api must send `authHeaders()` from `lib.ts`.
- Stuff: `stuff.ts`, routes `/api/stuff/*`. Purchases create one expense and move Want → Own (matched by product code in the link, or by name). Sales create income and move Own → Sold. The 'Yash's Stuff' Claude Sheet can't be reached from the server; Claude syncs it through the Claude Docs connector when asked. OCR is on the device (`receipt.ts` `ocrImages`, which inverts dark screenshots); parsers are in `web/src/orders.ts`.
- Owe & owed (`debts.ts`, page `/debts`): typed balances are set exactly with an equity adjustment (never spending). Receivable `meta.segment` = person | lent | splitwise ("Splitwise (overall)"). Loans are `kind='loan'` accounts with meta {lender, type: emi|interest_only, rate, emi, emi_day, end_date}; interest-only payments are all interest (logged as an expense); `PUT /api/loans/:id` corrects a loan (adjusts principal today, updates its rule); the EMI is a monthly transfer rule, and logging it splits into principal + 'Interest paid' (spending) via `emiSplit`.
- FDs (`fds.ts`, page `/fds`): `kind='fd'` accounts, meta {bank, rate, start, maturity, compounding}; ledger balance = principal, value today/at maturity is computed. Maturing posts bank +credited, FD −principal, 'Interest' income −interest (external_ref `fd:<id>`) and archives the FD.
- Goal contributions are earmarks, not ledger postings: they never change balances or spending. A boost on an account-linked goal creates a real transfer.
- Idempotency by `txn.external_ref` (unique per book): `rec:<rule>:<date>` for recurring, `stmt:<ref|hash>` for statements, `sw:<id>` for Splitwise. Keep new integrations on this pattern so re-running never duplicates.
- `apps/web/src/`: React PWA. Browser-side parsers (no external AI): `voice.ts` (sentences), `statement.ts` (bank CSV/TXT), `receipt.ts` (Tesseract OCR, lazy-loaded), `cas.ts` (pdf.js, lazy-loaded). `styles.css` holds base tokens; `themes.css` holds the 12 themes (`html[data-theme]`), light/dark (`data-mode`), contrast (`data-contrast`) and the compact density. `theme.ts` stores the choice per device. Income is `--inc` (blue) and expense is `--exp` (red) in every theme. Shared dashboard pieces are in `components/Planner.tsx`.
- Demo reset (`seed-demo-data.ts`) must delete every table that references accounts or txns before deleting them (stuff_item references txn). Update it whenever a new table points at `account`.
- `db/migrations/`: append-only SQL.
- `render.yaml`: the Render blueprint.
