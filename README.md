# Paisa OS

A personal finance app built on a double-entry ledger. Phase 3 (core) is in this build: login, accounts, transactions, transfers, splits, refunds, budgets, Stats, net worth, Zerodha holdings sync and a separate demo book.

## Run it locally

You need Node 22+ and PostgreSQL 15+.

```bash
npm install
cp .env.example .env            # set APP_SECRET to 32+ random characters
createdb paisa
npm run build
DATABASE_URL=postgres://localhost/paisa APP_SECRET=... npm start
```

Open http://localhost:8080. The first visit asks you to create your login (one owner only). You get two books:

- **My money:** Axis Bank, HDFC Bank and Cash at ₹0. Tap each one under Accounts to enter today's balance.
- **Sample data:** six months of made-up transactions. Switch to it in Settings; a banner shows whenever you're viewing it.

For development, run `npm run dev:api` (port 8080) and `npm run dev:web` (port 5173, which proxies `/api`).

## Tests

```bash
createdb paisa_test
npm test
```

There are 31 tests. They cover the ledger rules (every transaction sums to zero; transfers, card payments and lending aren't spending; refunds, splits, voids, idempotency, duplicate UPI references, the append-only audit log) as well as stats, net worth, safe-to-spend and the Kite sync against a fake Kite API. **Warning:** the tests drop and recreate the `public` schema of the test database.

## Deploy for free (Render + Neon)

Cost: ₹0. The app runs on Render's free web plan and the database on Neon's free Postgres (0.5 GB, which is years of transactions, and it doesn't expire).

1. **Database (Neon).** Sign up at neon.tech, then create a project in region *AWS Asia Pacific (Singapore)*. On the dashboard click **Connect** and turn **Connection pooling off**. Copy the connection string: it starts with `postgresql://` and ends with `?sslmode=require`.
2. **Code (GitHub).** Push this `app` folder to a **private** GitHub repo. `render.yaml` must be at the repo root.
3. **App (Render).** Sign up at render.com with GitHub, then go to **New → Blueprint** and pick the repo. Render reads `render.yaml`:
   - Paste the Neon string into `DATABASE_URL`.
   - `APP_SECRET` is generated for you. **Never change it afterwards:** it encrypts your Kite secret and signs logins.
   - `PUBLIC_URL` isn't needed. Render's own URL (`https://paisa-os-xxxx.onrender.com`) is picked up automatically.
4. Click **Apply**. The first build takes about 3 minutes, and migrations run on start. Open the URL and create your login.
5. On your phone, open the URL and choose **Add to Home Screen**. It installs as an app (PWA).

**About the free plan**
- Render puts the app to sleep after 15 minutes with no visits. The first open after that takes about 30–50 seconds; after that it's instant. To keep it awake, add a free monitor at uptimerobot.com that pings `https://<your-app>.onrender.com/api/health` every 10 minutes. One always-on service fits within Render's 750 free hours a month.
- Every push to the repo's main branch redeploys automatically.
- Backups: Neon keeps a short point-in-time restore window on the free plan. Use **Settings → Export** in the app now and then for a copy you control.

**Other hosts.** `railway.json` still works on Railway (paid, about $5/month), and the app runs anywhere Node 22 and Postgres are available. Set `TRUST_PROXY=1` when the app sits behind a proxy.

## Connect Zerodha

1. At developers.kite.trade, create a **Personal** app. It's free and has no market data, which this app doesn't need.
2. Set its redirect URL to `PUBLIC_URL/api/kite/callback`. Settings shows the exact URL.
3. Paste the API key and secret into Settings.
4. Go to Accounts → Holdings → **Log in & sync**. Zerodha requires this login once a day.

The app only ever calls `/session/token`, `/portfolio/holdings` and `/mf/holdings`; it never places orders. Each sync is stored as a dated snapshot, and net worth uses the latest one. If mutual fund holdings don't come through on a Personal app, equity still syncs and the app tells you.

## How the numbers work

- Money is stored as integer paise, never as floats.
- Each transaction is a set of postings (a debit is positive) that must sum to zero. A deferred database trigger enforces this, so the API can't break it either.
- Categories are income and expense accounts. Spending is the net debit to expense accounts, so refunds reduce it automatically.
- Balances, budgets and stats are computed from postings every time. No totals are stored.
- Deleting a transaction voids it rather than erasing it, and you can restore it. Every create, edit, void and restore goes into `audit_log`, which the database blocks from being edited.
- For a period still in progress, Stats compares against the same number of days last period. For example, 14 days of November are compared with 1–14 October.

## Layout

```
db/migrations/      SQL schema (raw SQL, no ORM)
apps/api/src/       Fastify API: ledger.ts, books.ts, stats.ts, dashboard.ts, kite.ts, app.ts
apps/api/test/      ledger + API tests (node:test, real Postgres)
apps/web/src/       React PWA: Home, Activity, Stats, Accounts, Settings, quick-add
```

## Not built yet

These are planned for Phase 4:

- Voice entry
- Recurring rules (safe-to-spend doesn't subtract upcoming bills until these exist)
- Axis and HDFC statement import with reconciliation
- CAS import
- AI insights
- Receipt scanning
