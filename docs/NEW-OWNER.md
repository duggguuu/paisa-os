# Paisa OS: your own private finance app

Paisa OS keeps track of your money: spending, budgets, salary and income tax, loans, FDs, goals and money you've lent. It runs on your phone like an app (Face ID included) and on your laptop in the browser.

This guide sets up **your own copy**. It takes about 45 minutes, once, and costs ₹0.

---

## Contents

1. [Why your data stays yours](#1-why-your-data-stays-yours)
2. [Before you start](#2-before-you-start)
3. [GitHub: get your copy of the app](#3-github-get-your-copy-of-the-app)
4. [Neon: create your database](#4-neon-create-your-database)
5. [Render: put the app online](#5-render-put-the-app-online)
6. [First visit: create your login](#6-first-visit-create-your-login)
7. [Your iPhone: install the app and turn on Face ID](#7-your-iphone-install-the-app-and-turn-on-face-id)
8. [Your laptop: set a PIN](#8-your-laptop-set-a-pin)
9. [Getting started inside the app](#9-getting-started-inside-the-app)
   - [Reminders and notifications](#reminders-and-notifications)
10. [Getting updates](#10-getting-updates)
11. [Backups](#11-backups)
12. [Privacy checklist](#12-privacy-checklist)
13. [If something goes wrong](#13-if-something-goes-wrong)

---

## 1. Why your data stays yours

The app is made of three pieces, and **you own all three**:

| Piece | What it holds | Who can get in |
|---|---|---|
| **Your GitHub copy** | The app's code only. Never any of your money data. | You |
| **Your Neon database** | All of your data: transactions, balances, salary, everything. | You |
| **Your Render server** | Runs the app at your own web address. | You |

So:

- **Nobody else can see your data.** That includes the person who shared this app with you. Their copy of Paisa runs on their own accounts and has no way to reach your database, because it doesn't have your database password.
- **You can't see theirs either.** Your copy has no link to their database or their server.
- **Your code started fresh.** The code you receive contains no one else's data, and none of the history of how it was built.
- **Updates come only when you choose.** An update changes code only, never data, and nothing reaches your app until you approve it (see [section 10](#10-getting-updates)).
- **Reading files stays on your phone.** Screenshots, payslips and bank statements you upload are read on your own device; they aren't sent anywhere to be read.

---

## 2. Before you start

You need:

- **A laptop** with Chrome or Safari. Setup is much easier on a laptop than a phone.
- **An email address that only you can read.** You'll use it for all three sign-ups below. Turn on two-step login for it if you haven't (Gmail: myaccount.google.com → Security → 2-Step Verification).
- **A password manager, or a safe place to note things down.** You'll create a few passwords and one long "connection string".
- **The invite.** The person sharing the app will invite your GitHub username to a repository called **`paisa-os-app`**. Send them your username after step 3.1.

Keep this guide open in one tab and do the steps in another.

---

## 3. GitHub: get your copy of the app

GitHub stores code. You'll make your own copy (a **fork**) of the app.

### 3.1 Create your account

1. Go to **github.com** and click **Sign up**.
2. Enter your email, a strong password and a username (for example `priya-r`). Finish the verification.
3. Turn on two-factor login:
   1. Click your profile picture (top right) → **Settings** → **Password and authentication**.
   2. Click **Enable two-factor authentication**, then follow the steps using an authenticator app (Google Authenticator, Microsoft Authenticator or 1Password).
   3. **Save the recovery codes** somewhere safe.
4. **Send your GitHub username** to the person sharing the app so they can invite you.

### 3.2 Accept the invite

1. You'll get an email titled *"… invited you to collaborate on paisa-os-app"*. You'll also see a notification on github.com.
2. Click **View invitation**, then **Accept invitation**.

The `paisa-os-app` page opens. It holds a clean copy of the app's code and nothing else.

### 3.3 Make your own copy (fork)

1. On the `paisa-os-app` page, click **Fork** (top right).
2. Fill in:
   - **Owner:** you.
   - **Repository name:** leave it as `paisa-os-app`.
   - **Copy the main branch only:** leave it ticked.
3. Click **Create fork**.

You now have **`your-username/paisa-os-app`**. It's private, and this is the copy your app will run from.

> Your copy of the code is linked to the shared one only so you can **pull in updates when you choose**. Nothing flows the other way: your data is never in the code, and no one can change your copy except you.

---

## 4. Neon: create your database

Neon stores all of your data. The free plan gives 0.5 GB, which is years of transactions, and it doesn't expire.

1. Go to **neon.tech** → **Sign up**. Use the same email, or **Continue with GitHub**.
2. Turn on two-factor login: profile picture → **Account settings** → **Security**.
3. Click **Create project** (or **New project**) and fill in:
   - **Project name:** `paisa`.
   - **Postgres version:** leave the default.
   - **Region:** **AWS Asia Pacific (Singapore)**, the closest to India.
4. Click **Create**.
5. On the project dashboard, click **Connect** (top right). In the window that opens:
   - **Branch:** `main` · **Database:** `neondb` · **Role:** leave as is.
   - Turn **Connection pooling** **off**.
   - Copy the **connection string**. It looks like this:

     ```
     postgresql://neondb_owner:AbCdEf123@ep-something-123456.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
     ```
6. Save it in your password manager as **"Paisa database"**.

> ⚠️ **This connection string is the key to all your data.** Never send it to anyone or paste it into a chat (including AI assistants), an email or a document. The only place it goes is Render, in the next step.

---

## 5. Render: put the app online

Render runs the app and gives it a web address.

1. Go to **render.com** → **Get Started**. Choose **Sign up with GitHub** and allow Render to access your account.
2. Turn on two-factor login: profile picture → **Account Settings** → **Security**.
3. Give Render access to your repo:
   1. Click **New** (top right) → **Blueprint**.
   2. If `paisa-os-app` isn't listed, click **Configure account** / **Connect GitHub**, choose **Only select repositories**, pick **`your-username/paisa-os-app`** and click **Install**.
4. Back on **New Blueprint**, pick **`paisa-os-app`** and click **Connect**.
5. Render reads the setup file in the code and shows one free web service called `paisa-os`. Fill in:
   - **Blueprint name:** `paisa`.
   - **DATABASE_URL:** paste the Neon connection string from step 4.
   - **APP_SECRET:** Render fills it in for you. **Never change it later**; it protects your logins and saved keys.
6. Click **Apply** (or **Deploy Blueprint**). The first build takes 5–8 minutes. Click into the `paisa-os` service and open **Logs** to watch it.
7. When it says **Live**, your address appears at the top of the service page, for example **`https://paisa-os-ab12.onrender.com`**. Save it.

**About the free plan:** the app sleeps after 15 minutes of no use. The next visit wakes it in about a minute (you'll see the logo with "Waking up…"); after that it's fast.

---

## 6. First visit: create your login

**Do this straight after step 5.** The first person to open the address becomes the app's only owner. After that, nobody else can create a login on your copy.

1. Open your address on your laptop.
2. You'll see **"Your money, finally in one place."** Fill in:
   - **Email.**
   - **Password:** at least 10 characters, and **not one you use anywhere else**.
   - **Your bank accounts:** your bank names separated by commas, for example `SBI, ICICI Bank`. **Put the bank your salary goes into first.**
3. Click **Create and continue**.

You're in. You get two separate **books**:

- **My money:** your real one. Your banks and Cash, each starting at ₹0.
- **Sample data:** made-up transactions to explore. Switch in **Settings**; a yellow banner shows whenever you're looking at it. It never mixes with your real data.

---

## 7. Your iPhone: install the app and turn on Face ID

1. On your iPhone, open your address in **Safari** (it must be Safari).
2. Tap **Share** (the square with an arrow) → **Add to Home Screen** → **Add**.
3. Open **Paisa** from your home screen and log in with your email and password.
4. Go to **Settings → Security → Face ID (phone) → Set up Face ID on this device** and approve with Face ID.
5. Under **Lock Paisa**, keep both switches on:
   - **Lock Paisa**: the lock itself.
   - **Every time it opens**: asks for Face ID whenever you open the app.
   - Then pick how long it can be idle before it locks again (5 minutes is a good default).

From now on, opening Paisa asks for Face ID.

> Face ID logins are saved in your iCloud Keychain. Use **your own Apple ID**; a shared Apple ID would share them.

---

## 8. Your laptop: set a PIN

1. Open your address in Chrome or Safari and log in.
2. Go to **Settings → Security → Laptop PIN → Set a PIN**.
3. Enter a 4–6 digit PIN twice, plus your account password. Patterns like 1111 or 1234 aren't allowed.

From now on, every new tab or browser restart asks for the PIN, and your password always works too. After 5 wrong PINs, the PIN is paused until you unlock with your password.

---

## 9. Getting started inside the app

Do these once, in this order:

1. **Set your balances.** **Accounts** → tap each bank → enter today's balance. Do the same for Cash.
2. **Add your cards and wallets.** **Accounts → + Add** for credit cards, wallets (e.g. PhonePe) and investments. For a credit card, enter what you currently owe on it.
3. **Your salary.** **More → Salary & tax**:
   - **Upload payslips:** PDF, Excel, CSV or TXT, several at once. Paisa reads the earnings and deductions, and can set your monthly salary from the latest one.
   - Or tap **Type it in** to enter it by hand.
   - Pick the bank it lands in and the pay day. **Last day of the month** is the default; Paisa logs it for you that day.
   - The **Tax simulator** shows your tax under the New Regime, with "what if" sliders.
4. **Past transactions (optional).** **Import**: download a statement from your net banking as PDF, Excel, CSV or TXT and upload it. If you choose a password-protected PDF, it asks for the password. You then review every row before saving anything.
5. **Adding money in and out day to day:**
   - Tap **+**, or speak: tap the mic and say *"spent 450 on Swiggy from ICICI card yesterday"*.
   - Or tap 📷 to scan a bill or receipt.
6. **Zerodha (optional).** To see your stocks and mutual funds at market value, go to **Settings → Zerodha (Kite)**. It needs your own Kite Connect app from developers.kite.trade (Zerodha may charge for it); Settings shows the exact **redirect URL** to give that app. Then tap **Accounts → Holdings → Log in & sync** about once a day. Paisa only reads your holdings; it can't place orders.
7. **Optional extras:** **Budget Planner**, **Goals**, **Bills & recurring**, **Owe & owed** (money you've lent, borrowed, or that friends owe you), **FDs** and **Splitwise** (import its exports or screenshots). In FDs you note which bank the FD is in and which account the money came from, set the duration (years, months, days), and see the expected return; the app suggests today's rate for that bank and tenure, and **Compare rates** lists banks side by side. If your FD receipt shows the maturity amount, type it in and the app uses that figure. Pick the bank from the list (your own accounts are at the top) and the exact scheme from the second list: each bank's 1-, 2-, 3- and 5-year rates, or for the Post Office its Time Deposits, NSC, KVP, Monthly Income Scheme and Senior Citizens scheme. Choosing where the money came from takes it out of that account. Tap an FD to edit or delete it.

**Deleting an account:** Accounts → tap the account → **Delete account**. You'll see what goes with it, then enter your app PIN (or your password if you haven't set a PIN). **Hide** is the safer choice: it keeps the history.

**Only salary counts as income.** Money coming in that isn't earnings (a friend paying you back, money from family, refunds) goes under **"Money in (not income)"**. It still shows in your balances; it just isn't counted as earnings. At the bottom of **Salary & tax** you can review your incoming money and move anything that isn't earnings out of income, using **Select all** to do several at once.

### Reminders and notifications

Paisa can nudge you three times a day (morning, afternoon, night) to add your expenses, and remind you before any **mandate or subscription** renews.

1. **On your iPhone:** open Paisa **from the home-screen icon** (it doesn't work in plain Safari), then go to **Settings → Notifications → Turn on notifications** and tap **Allow**. Do the same on your laptop if you want them there too.
2. Pick your three times (default 9 AM, 2 PM and 9 PM). **Show amounts in notifications** is off, because notifications appear on your lock screen.
3. **One-time setup so reminders arrive on time.** The free server sleeps when unused, so an hourly "alarm" on GitHub wakes it:
   1. In the app: **Settings → Notifications → How**. You'll need two things from there, **your app address** and **Copy key**.
   2. On GitHub, open **your** `paisa-os-app` → **Settings → Secrets and variables → Actions → New repository secret**:
      - Name `PAISA_URL`, value: your app address (e.g. `https://paisa-os-ab12.onrender.com`).
      - Name `PAISA_CRON_KEY`, value: the key you copied.
   3. Open the **Actions** tab of your repo. Because it's a fork, GitHub asks first: click **I understand my workflows, go ahead and enable them**.
   4. Click **Reminders → Run workflow → Run workflow**. Within a minute the box in Settings → Notifications turns green.
4. **Mandates & subscriptions** (More menu): add each auto-debit (Netflix, gym, insurance, SIPs, UPI AutoPay, e-NACH…) with its next renewal date, and under **Remind me** choose when you want to hear about it (e.g. *1 day before at 9 AM* and *on the day at 9 PM*).

The key only lets the alarm ask your app to send your reminders. It can't read anything. Keep it private anyway.

**Hide amounts:** tap the **eye** button (on Home, in the laptop sidebar, or the small floating button on your phone) to hide every amount, for example when someone is looking at your screen. Tap again to show them. On a laptop, **Shift + H** does the same. It stays the way you left it on that device.

**Themes:** the app starts in **Monotone, light**. Tap the palette icon on Home to choose another look, light or dark; your choice is remembered on that device.

**Renaming or moving a subcategory:** **More → Categories**, tap ✎ on the subcategory. You can rename it, move it under a different category, change its icon, or hide it. Past transactions move with it. While adding a transaction you can also tap **✎ Edit** next to the subcategories to rename one in place.

**Swipe on a transaction** (Home or Trans.): left to delete (with Undo), right to edit.

**Holdings:** under Accounts → Holdings you can search, filter (Stocks / Funds, Gainers / Losers) and sort (value, gain ₹, gain %, invested, name). Your choice is remembered on each device.

### The AI Copilot (optional)

**More → AI Copilot** answers questions about your money. Out of the box it runs entirely on your server and understands common questions (can I afford X, how to save more, budgets, bills, goals).

For the **smarter Copilot**, add an Anthropic API key. It can then:
- look up any transaction or compare any months;
- check your investments, FDs, loans, subscriptions and salary;
- work out what-ifs ("if I prepay ₹1 lakh on my loan…");
- draft entries for you ("add ₹450 groceries yesterday"). It never saves anything itself: you tap **Review & add**.

To set it up:

1. Create an account at **console.anthropic.com**, add a little credit (**Billing**), then **API keys → Create key** and copy it.
2. In **Render → paisa-os → Environment → Add environment variable**: name `ANTHROPIC_API_KEY`, value the key. Save; Render restarts the app.

Each question costs a small amount on that Anthropic account. With the key set, a summary of your numbers, plus whatever the Copilot looks up to answer, is sent to Anthropic. To go back to fully private mode, delete the variable.

---

## 10. Getting updates

When the app gets new features, they arrive in the shared `paisa-os-app`. **Your app doesn't change until you pull them in.** It takes one tap:

1. Open **github.com/your-username/paisa-os-app**.
2. If there's an update, you'll see **"This branch is 1 commit behind …:main"**.
3. *(Optional)* To see what changed, click **Sync fork → Compare**. Updates only ever touch code files; your data isn't in the code.
4. Click **Sync fork → Update branch**.
5. Render notices and redeploys by itself in about 5 minutes. Check under **Render → paisa-os → Events**.

That's it. Your data in Neon is never touched by an update.

**Rules that keep it private:**

- **Never add anyone as a collaborator on your fork** (Settings → Collaborators should stay empty). Only you should be able to change the code your app runs.
- **Don't change APP_SECRET or DATABASE_URL in Render** unless you're moving your database on purpose.
- **Keep a backup copy of the code:** every few months, on your fork page, click **Code → Download ZIP**. If you're ever removed from the shared repo, GitHub deletes your fork, but **your app keeps running** and **your data is untouched**. You'd just make a new private repo from the ZIP and point Render at it (Render → Settings → Repository).

---

## 11. Backups

**Automatic daily backup (set it up once):**

1. In the app: **Settings → Backup → Set backup passphrase**. Choose something you'll remember, at least 10 characters; a short sentence works well. **Write it down somewhere safe.** Without it, nobody (not even you) can open a backup.
2. That's it if your reminders are already set up (Settings → Notifications shows green). The same GitHub alarm (the `PAISA_URL` and `PAISA_CRON_KEY` secrets from section 9) runs the backup every night at 2 AM.
3. To check it right away: on GitHub, open your `paisa-os-app` → **Actions → Daily backup → Run workflow**. Settings → Backup turns green with the time of the last backup.

Each night's backup **replaces the previous one**, so there is always exactly one: the newest. It's encrypted with your passphrase and kept inside your own private GitHub repository.

**To get the backup file:** GitHub → your `paisa-os-app` → **Actions → Daily backup** → the newest run → **Artifacts → paisa-backup**. It downloads as a zip; unzip it to get `paisa-backup.json`. You can also tap **Settings → Backup → Download a backup now** at any time.

**To restore:** **Settings → Backup → Restore from a backup** → choose `paisa-backup.json` → type the passphrase. Paisa first shows what's inside (how many transactions, from which dates). Only after you enter your login password does it replace your data. It also keeps a safety copy of what was there before. This works on a brand-new copy of the app too, for example if you ever move to a new database.

Not included: your Zerodha and Splitwise links (they hold secret keys). Link them again after a restore.

**Also available:**

- **Settings → Export everything** downloads your data as plain, unencrypted JSON. Keep that file private.
- **Neon:** **Branches → Restore** can roll the database back to an earlier moment (within the free plan's history window).

GitHub pauses scheduled jobs in a repository that has had no activity for 60 days. If that happens, GitHub emails you; open **Actions** and click **Enable workflow**. Tapping **Sync fork** when updates arrive also counts as activity.

---

## 12. Privacy checklist

- [ ] Two-factor login on **email, GitHub, Neon and Render**.
- [ ] **Your own Apple ID**, phone passcode and laptop user account.
- [ ] The **Neon connection string** is only in your password manager and in Render.
- [ ] **Paisa password** is unique (used nowhere else).
- [ ] **Face ID** on your phone, **PIN** on your laptop, **Lock Paisa** on.
- [ ] **Your fork has no collaborators.**
- [ ] **Show amounts in notifications** stays off unless your lock screen is private.
- [ ] If you ask an AI assistant about your money, use **your own account**: conversations stay in the account that had them.

---

## 13. If something goes wrong

**"Waking up…" for a while.** The free plan sleeps after 15 idle minutes. Wait about a minute and it opens.

**The build failed on Render.**
1. Open **Render → paisa-os → Events**, click the failed deploy and read the last lines of the log.
2. Check that **DATABASE_URL** (Render → paisa-os → **Environment**) is the full Neon string, starting with `postgresql://`, and that **Connection pooling** was off when you copied it.
3. Click **Manual Deploy → Deploy latest commit**.

**I forgot my password.** There's no email reset, because nothing is ever sent anywhere. Instead:
1. Go to Render → paisa-os → **Environment** → **Add Environment Variable**.
2. Name: `RESET_OWNER_PASSWORD`. Value: a new password of 10+ characters. Click **Save**; the app restarts.
3. Log in with the new password.
4. **Delete that variable again** and save.

All devices are logged out and the laptop PIN is cleared; set them up again in Settings.

**Face ID stopped working, or I have a new phone.** Log in with your password, then go to **Settings → Security → Set up Face ID on this device**. You can remove old devices from the same screen.

**The PIN is "paused".** That happens after 5 wrong tries. Tap **Use password**; the PIN works again after that.

**A Zerodha login comes back saying the app is locked.** Open the app, unlock it, then tap **Accounts → Holdings → Log in & sync** again.

**An update broke something.** In Render → paisa-os → **Events**, open the previous successful deploy and click **Rollback**. Your data isn't affected. Then tell the person who shares the updates.

**Something else.** Render → paisa-os → **Logs** shows what the app is doing.
