# Paisa OS: your own private copy

This is a personal finance app (expenses, budgets, salary and tax, loans, FDs, goals) that runs on **your own free accounts**. Nobody else, including whoever gave you this code, can see your data. Here's why:

- **Your data lives in a database you create and own** (Neon). Only you have its password.
- **The app runs on a server you create and own** (Render), with a secret key that only your server knows.
- **It has its own web address**, so logins, Face ID and passkeys are tied to your copy only.
- **There is no shared server, no shared database and no admin account.** Another person's copy of Paisa has no way to reach yours, because it doesn't have your database password or your server.

Setup takes about 30 minutes, once. It costs ₹0.

---

## What you need

- A laptop with a browser.
- An email address that **only you** can read. Use it for all three sign-ups below, and turn on two-factor login for it.

## 1. GitHub: hold your copy of the code

1. Sign up at **github.com** with your email. Turn on two-factor authentication (Settings → Password and authentication).
2. Click **New repository**. Name it `paisa-os` and choose **Private**. Don't add a README.
3. Upload the code you were given:
   - **Easiest:** on the empty repo page, click **uploading an existing file**, then drag in every file and folder from the `paisa-os` folder you received. Commit.
   - **Or, if someone pushes it for you:** invite them as a collaborator for those 5 minutes, then **remove them** (Settings → Collaborators). The repo only holds code, never your data, but nobody else should be able to change the code your app runs.

## 2. Neon: your database

1. Sign up at **neon.tech** with the same email and turn on two-factor login.
2. **Create project**:
   - Name: `paisa`.
   - Region: **AWS Asia Pacific (Singapore)**.
3. On the project dashboard, click **Connect**. Turn **Connection pooling off**, then copy the connection string. It starts with `postgresql://` and ends with `?sslmode=require`.
4. Keep it somewhere safe, such as your password manager. **This string is the key to your data. Never share it or paste it into chats.**

## 3. Render: run the app

1. Sign up at **render.com**. Choose **Sign in with GitHub**, so Render can see your `paisa-os` repo. Turn on two-factor login.
2. Click **New → Blueprint** and pick your `paisa-os` repo. Render reads `render.yaml` and creates a free web service.
3. It asks for **DATABASE_URL**: paste the Neon string from step 2.
4. It creates **APP_SECRET** by itself. Don't change it later.
5. Click **Apply**. The first build takes about 5 minutes. When it says **Live**, open the address it shows, for example `https://paisa-os-xxxx.onrender.com`.

## 4. First visit: create your login

1. Open your address. The first person to visit becomes the **only** owner, so do this straight away.
2. Enter your email, a password of at least 10 characters that you don't use anywhere else, and your bank account names (for example "SBI, ICICI Bank"). The first bank is where your salary lands.
3. On your iPhone: open the address in Safari → Share → **Add to Home Screen**. Open the app from there, then go to **Settings → Security → Set up Face ID on this device**.
4. On your laptop: go to **Settings → Security → Laptop PIN**. From then on, every new tab asks for the PIN.

You also get a separate **sample data** book to explore (Settings). It never mixes with your real records.

## Keeping it private: a short checklist

- [ ] Two-factor login on your email, GitHub, Neon and Render.
- [ ] Your **own Apple ID / iCloud**. Passkeys (Face ID logins) sync through iCloud Keychain, so a shared Apple ID would share them.
- [ ] Your own phone passcode, and your own user account on any shared computer.
- [ ] Never share the Neon connection string, your Render login or your app password. Not even with someone you trust, and not in chats with AI assistants.
- [ ] Use your own AI account if you ask an assistant about your money. Conversations live in that account.
- [ ] **Updates:** Render redeploys whenever *your* repo changes. Only you can change it, so nothing reaches your app unless you add it. If you're sent a newer version, read what changed before you upload it.

## If something goes wrong

- **The app shows "Waking up…" for a while:** free Render services sleep after 15 minutes idle. The first visit takes up to a minute.
- **You forget your password:** there's no email reset (by design, nothing is sent anywhere). Instead:
  1. In Render → your service → **Environment**, add `RESET_OWNER_PASSWORD` with a new password (10+ characters). Save; the app restarts.
  2. Log in with that password.
  3. **Delete the variable again** and save.

  Every device is logged out, and the laptop PIN is cleared. Set it again in Settings.
- **Backups:** Settings → Export downloads all your data. Neon also keeps a short history you can restore from (Branches → restore).
