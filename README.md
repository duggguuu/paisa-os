# Paisa OS

A personal finance app built on a double-entry ledger. Built so far: login, accounts, transactions, transfers, splits, refunds, budgets, Stats (with a spending donut), net worth, Zerodha holdings sync, voice entry, receipt scanning, recurring bills, bank-statement import with reconciliation, mutual-fund CAS import, Splitwise sync, insights, savings goals, a Budget Planner, a Financial Health score, an AI Copilot, an installable iPhone app and a separate demo book.

**Changing the app later:** read `CLAUDE.md` first. In short: your data lives in Neon and deploys only replace code, so schema changes go in new migration files.

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

There are 45 API tests (ledger, API, recurring, imports, CAS, Splitwise, insights), plus 18 parser tests run by `npm run test:web` (voice, bank statements, receipts, CAS, Splitwise exports). They cover the ledger rules (every transaction sums to zero; transfers, card payments and lending aren't spending; refunds, splits, voids, idempotency, duplicate UPI references, the append-only audit log) as well as stats, net worth, safe-to-spend and the Kite sync against a fake Kite API. **Warning:** the tests drop and recreate the `public` schema of the test database.

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

## Voice entry

Tap **Say it** on Home, or the mic in the Add sheet, and say something like:

- "spent 450 on Swiggy from HDFC card yesterday"
- "groceries 1,200 at DMart using Axis"
- "got salary 1.2 lakh in Axis"
- "transfer 5000 from Axis to Paytm wallet"
- "dinner 1800 on HDFC card split with Aditi and Rohan"

The sentence fills in the form: amount, place, category, account, date and split. You check it and tap Save, and nothing is saved automatically. The parsing happens on your device, with no AI service involved. Speech-to-text uses the browser's own engine: Chrome, and Safari with Siri turned on. If the mic isn't available (some iPhone home-screen apps block it), tap the text box and use the 🎤 key on the iPhone keyboard. Typed or dictated sentences are understood the same way.

## Face ID

**Settings → Face ID → Set up Face ID on this device**, then turn on **Lock Paisa** and pick how long it can sit idle (1, 5, 15 or 60 minutes).
- When you come back after that long, Paisa asks for Face ID before showing anything. The server enforces this: a locked session can't read any data.
- The login screen also gets **Log in with Face ID**.
- This uses passkeys (WebAuthn): Face ID unlocks a key that never leaves your phone, and the server stores only the public key.
- Passkeys are tied to the app's web address. If you move to a new domain, set Face ID up again.
- Removing your last passkey turns the lock off automatically, so you can't get locked out. Your password always works.

## Themes

Tap 🎨 on Home, or the three round buttons on **More**:
- **Dark mode:** cycles Auto → Dark → Light.
- **High contrast:** on or off.
- **Theme:** Monotone, Pastel, Cyber, Brass, Editorial, Terracotta, Forest, Risograph, Sepia, Glass (default), Spider-Verse or Spider-Verse 2.

Appearance is saved on each device. It's also under Settings → Appearance.

## Install on iPhone

1. Open the app's URL in **Safari**.
2. Tap **Share**, then **Add to Home Screen**, then **Add**.
3. Open **Paisa** from the home screen. (After an icon change, delete the old home-screen icon and add it again; iOS caches icons.) It runs full-screen like an app. Log in once more inside it, because home-screen apps keep their own login, separate from Safari's.

## Bills & recurring

Under **Settings → Tools → Bills & recurring** (or the Bills shortcut on Home), add rent, SIPs, EMIs, subscriptions and salary.
- **Safe-to-spend** subtracts every bill or SIP still due this month, including overdue ones.
- **Home** shows what's due, with one-tap **Log** or **Skip**.
- Turn on **Log automatically** for fixed payments, and they post themselves on the due date.
- Each occurrence can only be logged once, even from two devices.

## Receipt scanning

In the Add sheet, tap 📷 and photograph a bill. It reads the total, shop and date on your phone; the photo is never uploaded. The reader (about 5 MB) downloads the first time and is cached after that.

## Import a bank statement

**Import → Bank / card statement.**
1. Pick the account and choose the file:
   - **Axis:** Download as **CSV**.
   - **HDFC:** Download → **Delimited** (or TXT).
   - **Excel files:** open them and use "Save as CSV".
2. Check the preview. Paisa:
   - pulls out the merchant and suggests the booking: categories, ATM withdrawal → Cash, card bill → transfer, SIP → investments, salary and interest;
   - skips rows already imported;
   - leaves unticked any rows that look like something you entered by hand.
3. Import. Paisa then compares its balance with the statement's closing balance, and can add one adjustment to match. Each import can be undone from **Recent imports**.

## Mutual funds (CAS)

**Import → Mutual funds (CAS).**
1. Request a **Detailed** CAS from camsonline.com (CAMS + KFintech) or MF Central.
2. Choose the PDF and enter its password (usually your PAN in capitals). It's unlocked and read in your browser.
3. Check the funds, then tap **Add to net worth**.

Funds Zerodha already reports are skipped, so nothing counts twice. Import a newer CAS any time to update values.

## Splitwise

**Free account (spreadsheet exports):**
1. On splitwise.com (on a computer), open each group, click the ⚙ gear in the right-hand column, then **Export as spreadsheet**.
2. Do the same for each friend you have non-group expenses with.
3. In Paisa, open **Splitwise** and upload all the files together.
4. Tick which name is you, pick the account your Splitwise payments usually go through, and choose a period.
5. Check one balance against Splitwise. If it's the wrong way round, tap **Flip**. Then **Import**.

To update later, export again and re-upload; only new expenses are added. An expense that appears in both a group export and a friend export is counted once.

The export only gives each person's net per expense, so Paisa works out the rest:
- If you're owed money on an expense, you paid it, and your share is the cost minus what you're owed.
- If you owe money, your share is what you owe.
- With several people, your amount is split across the people on the other side, in proportion.
- The direction (paid vs owes) is checked against "X paid Y" settle-up rows.

**Splitwise Pro (automatic sync):** under "Have Splitwise Pro?", connect with an API key from secure.splitwise.com/apps. It uses Splitwise's exact who-owes-whom data.

**Either way:**
- Your share counts as spending.
- Each friend becomes a person in Accounts with the same balance as Splitwise. Older history becomes their opening balance.
- Settle-ups are transfers.
- Paisa never writes to Splitwise.

## Goals

**Goals** tracks what you're saving for: a progress bar, a projected finish date ("You will reach your goal on…") and **Boost My Goal**.
- A goal can follow a real account, such as a dedicated FD or savings account. Its progress is that account's balance, and boosting it records a transfer into that account.
- Or a goal can be money you set aside in your head. Boosts add to it without touching your balances.
- The projection uses what you've added over the last 3 months.

## Budget Planner and Financial Health

**Budget Planner** shows:
- income, planned expenses (budgets plus fixed bills), remaining, and budget used, each with a 6-month mini chart and the change from last month;
- spent vs budgeted vs remaining;
- a category table with On track / Behind / Over badges. Type a monthly budget straight into the table.

**Financial Health** is a score from 0 to 100, made of six weighted parts, each explained in the card:
- savings rate (25);
- emergency fund in months of spending (25);
- budgets on track (15);
- card and loan dues (15);
- spending trend (10);
- goals on track (10).

## AI Copilot

Tap ✦ on Home or **AI Copilot** to ask questions in plain words, or by voice:
- "Can I afford a ₹60,000 laptop?"
- "Why did my spending increase?"
- "How can I save more?"
- "When will I reach my goal?"
- "How much did I spend on food?"
- "What bills are due?"

**Private mode (default, free):** answers are worked out on your server from your numbers. Nothing is sent anywhere.

**Claude mode (optional):** add `ANTHROPIC_API_KEY` under Render → Environment to answer any free-form question with Claude (model `claude-opus-5-5`, low effort; override with `COPILOT_MODEL`). Each question sends a summary to Anthropic: totals, categories, goals, bills and net worth by account type. It doesn't include account numbers or individual transactions. It costs roughly ₹2 per question, and if Claude is unavailable the app falls back to private mode.

## Insights

**Insights** works out patterns from your own data:
- spending pace vs your usual month;
- categories running hot;
- budgets about to run out;
- subscriptions you aren't tracking yet (one tap to track them);
- savings rate, unusually large purchases, people who owe you, idle cash in savings, and weekend spending.

It's rule-based and runs on your server; nothing goes to an AI service. A version written by Claude would need a paid Anthropic API key (usually a few rupees a month at this volume). Add one later if you want it.
