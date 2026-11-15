import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { Sql } from './db.js';
import { hashPassword, verifyPassword, newToken, sha256, makeCipher } from './crypto.js';
import { TxnInput, createTxn, updateTxn, voidTxn, restoreTxn, getTxn, accountBalances, bookIntegrity, LedgerError } from './ledger.js';
import { AccountInput, AccountPatch, CategoryInput, CategoryPatch, createAccount, updateAccount, createCategory, updateCategory, createBook, seedRealBookAccounts } from './books.js';
import * as stats from './stats.js';
import { home, netWorth, safeToSpend } from './dashboard.js';
import * as kite from './kite.js';
import { seedDemo } from './seed-demo-data.js';
import { todayIST, periodContaining } from './money.js';
import { registerExtras } from './routes-extra.js';
import * as passkeys from './passkeys.js';
import { postAutoDue } from './recurring.js';

export interface AppConfig {
  sql: Sql;
  appSecret: string;
  publicUrl: string; // where the app is served, used for the Kite redirect
  webDist?: string;
  secureCookies?: boolean;
  fetch?: typeof fetch;
  logger?: boolean;
  trustProxy?: boolean;
}

const SESSION_COOKIE = 'paisa_sid';
const SESSION_DAYS = 30;

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    book?: { id: string; is_demo: boolean; month_start_day: number };
  }
}

export async function buildApp(cfg: AppConfig): Promise<FastifyInstance> {
  const { sql } = cfg;
  const cipher = makeCipher(cfg.appSecret);
  const app = Fastify({ logger: cfg.logger ?? false, bodyLimit: 1_000_000, trustProxy: cfg.trustProxy ?? false });
  await app.register(cookie, { secret: cfg.appSecret });

  // ---------- security headers (every response) ----------
  // A strict Content Security Policy: only this app's own scripts run (the two small inline scripts in
  // index.html are allowed by exact hash), nothing is fetched from other sites, and the app can't be
  // framed. OCR files are self-hosted for this reason. API responses are never cached.
  const inlineHashes: string[] = [];
  const indexHtml = cfg.webDist ? path.join(cfg.webDist, 'index.html') : null;
  if (indexHtml && fs.existsSync(indexHtml)) {
    for (const m of fs.readFileSync(indexHtml, 'utf8').matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      inlineHashes.push(`'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
    }
  }
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${inlineHashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('content-security-policy', csp);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('permissions-policy', 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), interest-cohort=()');
    if (cfg.secureCookies) reply.header('strict-transport-security', 'max-age=63072000; includeSubDomains');
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    return payload;
  });

  // ---------- errors ----------
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'invalid_input', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), issues: err.issues });
    }
    if (err instanceof LedgerError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err?.code === 'P0001') return reply.status(422).send({ error: 'ledger_rule', message: err.message }); // raised by DB triggers
    if (err?.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: 'bad_request', message: err.message });
    app.log.error(err);
    return reply.status(500).send({ error: 'server_error', message: 'Something went wrong. Nothing was saved.' });
  });

  // ---------- auth ----------
  const loginAttempts = new Map<string, { n: number; until: number }>();

  async function startSession(reply: any, userId: string) {
    const token = newToken();
    const unlockKey = newToken();
    // Logging in (password or Face ID) counts as unlocking this tab.
    await sql`insert into session (token_hash, user_id, expires_at, unlocked_until, unlock_keys)
              select ${sha256(token)}, ${userId}, now() + ${`${SESSION_DAYS} days`}::interval, now() + make_interval(mins => lock_minutes), ${[sha256(unlockKey)]}
              from app_user where id = ${userId}`;
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'lax', secure: cfg.secureCookies ?? false, path: '/', maxAge: SESSION_DAYS * 86400,
    });
    return unlockKey;
  }

  /** Unlock this session for the calling tab: new idle window + a fresh per-tab key (last 8 kept). */
  async function unlockSession(req: FastifyRequest) {
    const unlockKey = newToken();
    await sql`update session set unlocked_until = now() + make_interval(mins => (select lock_minutes from app_user where id = ${req.userId!})),
                unlock_keys = (array_prepend(${sha256(unlockKey)}::text, unlock_keys))[1:8]
              where token_hash = ${sha256(req.cookies[SESSION_COOKIE]!)}`;
    return unlockKey;
  }

  /**
   * Session check. With the app lock on, a session is locked when it has been idle longer than
   * lock_minutes, or (lock on open) when the calling tab has no unlock key from this session:
   * a new tab or a fresh app start must unlock. Locked calls answer 423. Activity slides the window.
   */
  async function requireAuth(req: FastifyRequest, opts: { allowLocked?: boolean } = {}) {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) throw new LedgerError('unauthenticated', 'Please log in', 401);
    const key = req.headers['x-unlock'];
    const keyHash = typeof key === 'string' && key.length >= 20 && key.length <= 100 ? sha256(key) : '';
    const [s] = await sql<{ user_id: string; lock_enabled: boolean; lock_minutes: number; locked: boolean; refresh: boolean }[]>`
      select s.user_id, u.lock_enabled, u.lock_minutes,
             u.lock_enabled and (s.unlocked_until is null or s.unlocked_until < now()
                                 or (u.lock_on_open and not (${keyHash}::text = any(s.unlock_keys)))) as locked,
             coalesce(s.unlocked_until, now()) < now() + make_interval(mins => u.lock_minutes) - interval '30 seconds' as refresh
      from session s join app_user u on u.id = s.user_id
      where s.token_hash = ${sha256(token)} and s.expires_at > now()`;
    if (!s) throw new LedgerError('unauthenticated', 'Session expired. Please log in again.', 401);
    req.userId = s.user_id;
    (req as any).locked = s.locked;
    if (s.locked && !opts.allowLocked) throw new LedgerError('locked', 'Paisa is locked. Unlock with Face ID or your password.', 423);
    if (!s.locked && s.lock_enabled && s.refresh) {
      await sql`update session set unlocked_until = now() + make_interval(mins => ${s.lock_minutes}) where token_hash = ${sha256(token)}`;
    }
    const which = req.headers['x-book'] === 'demo';
    const [book] = await sql<any[]>`select id, is_demo, month_start_day from book where user_id = ${s.user_id} and is_demo = ${which}`;
    if (!book) throw new LedgerError('no_book', 'Book not found', 404);
    req.book = book;
  }

  // Passkey ceremonies: the challenge rides in a signed, httpOnly cookie for two minutes.
  const pk = passkeys.passkeyConfig(cfg.publicUrl);
  const CHALLENGE_COOKIE = 'paisa_wa';
  const setChallenge = (reply: any, purpose: string, challenge: string) =>
    reply.setCookie(CHALLENGE_COOKIE, `${purpose}:${challenge}`, { signed: true, httpOnly: true, sameSite: 'strict', secure: cfg.secureCookies ?? false, path: '/api/', maxAge: 120 });
  const takeChallenge = (req: FastifyRequest, reply: any, purpose: string) => {
    const raw = req.cookies[CHALLENGE_COOKIE];
    reply.clearCookie(CHALLENGE_COOKIE, { path: '/api/' });
    const u = raw ? req.unsignCookie(raw) : null;
    if (!u?.valid || !u.value?.startsWith(`${purpose}:`)) throw new LedgerError('passkey_expired', 'That took too long. Try Face ID again.', 400);
    return u.value.slice(purpose.length + 1);
  };

  const Credentials = z.object({ email: z.string().email().max(200), password: z.string().min(10).max(200) });

  app.get('/api/auth/status', async (req) => {
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from app_user`;
    const [{ k }] = await sql<{ k: number }[]>`select count(*)::int as k from webauthn_credential`;
    let user = null;
    try {
      await requireAuth(req, { allowLocked: true });
      const [u] = await sql<any[]>`select email, lock_enabled, lock_minutes, lock_on_open, pin_hash is not null as has_pin, pin_length, pin_failures from app_user where id = ${req.userId!}`;
      user = { email: u.email, lockEnabled: u.lock_enabled, lockMinutes: u.lock_minutes, lockOnOpen: u.lock_on_open, locked: !!(req as any).locked,
        pin: u.has_pin ? { length: u.pin_length, blocked: u.pin_failures >= 5 } : null };
    } catch { /* not logged in */ }
    return { setupNeeded: n === 0, passkeyLogin: k > 0, user };
  });

  // Face ID login (no session yet).
  app.post('/api/auth/passkey/options', async (_req, reply) => {
    const o = await passkeys.authenticationOptions(sql, pk);
    setChallenge(reply, 'login', o.challenge);
    return o;
  });
  app.post('/api/auth/passkey/verify', async (req, reply) => {
    const userId = await passkeys.verifyAuthentication(sql, pk, takeChallenge(req, reply, 'login'), (req.body as any)?.response);
    return { ok: true, unlockKey: await startSession(reply, userId) };
  });

  // Unlock a locked session with Face ID.
  app.post('/api/auth/unlock/options', async (req, reply) => {
    await requireAuth(req, { allowLocked: true });
    const o = await passkeys.authenticationOptions(sql, pk, req.userId);
    setChallenge(reply, 'unlock', o.challenge);
    return o;
  });
  app.post('/api/auth/unlock/verify', async (req, reply) => {
    await requireAuth(req, { allowLocked: true });
    await passkeys.verifyAuthentication(sql, pk, takeChallenge(req, reply, 'unlock'), (req.body as any)?.response, req.userId);
    return { ok: true, unlockKey: await unlockSession(req) };
  });
  // Unlock with the PIN (laptop browsers). 5 wrong tries in a row turn the PIN off until the password unlocks.
  const PIN_TRIES = 5;
  app.post('/api/auth/unlock/pin', async (req) => {
    await requireAuth(req, { allowLocked: true });
    const pin = z.object({ pin: z.string().regex(/^\d{4,6}$/) }).parse(req.body).pin;
    const [u] = await sql<{ pin_hash: string | null; pin_failures: number }[]>`select pin_hash, pin_failures from app_user where id = ${req.userId!}`;
    if (!u.pin_hash) throw new LedgerError('no_pin', 'No PIN is set. Unlock with your password.', 400);
    if (u.pin_failures >= PIN_TRIES) throw new LedgerError('pin_locked', 'Too many wrong PINs. Unlock with your password.', 429);
    if (!(await verifyPassword(pin, u.pin_hash))) {
      const [{ pin_failures: n }] = await sql<{ pin_failures: number }[]>`update app_user set pin_failures = pin_failures + 1 where id = ${req.userId!} returning pin_failures`;
      throw new LedgerError(n >= PIN_TRIES ? 'pin_locked' : 'bad_pin', n >= PIN_TRIES ? 'Too many wrong PINs. Unlock with your password.' : `Wrong PIN. ${PIN_TRIES - n} ${PIN_TRIES - n === 1 ? 'try' : 'tries'} left.`, 401);
    }
    await sql`update app_user set pin_failures = 0 where id = ${req.userId!}`;
    return { ok: true, unlockKey: await unlockSession(req) };
  });

  // Unlock with the account password (for browsers without Face ID). Rate-limited like login.
  app.post('/api/auth/unlock/password', async (req) => {
    await requireAuth(req, { allowLocked: true });
    const password = z.object({ password: z.string().min(1).max(200) }).parse(req.body).password;
    const k = `unlock:${req.userId}`;
    const att = loginAttempts.get(k);
    if (att && att.n >= 5 && att.until > Date.now()) throw new LedgerError('rate_limited', 'Too many attempts. Try again in 15 minutes, or use Face ID.', 429);
    const [u] = await sql<{ password_hash: string }[]>`select password_hash from app_user where id = ${req.userId!}`;
    if (!(await verifyPassword(password, u.password_hash))) {
      loginAttempts.set(k, { n: (att && att.until > Date.now() ? att.n : 0) + 1, until: Date.now() + 15 * 60_000 });
      throw new LedgerError('bad_credentials', 'Wrong password', 401);
    }
    loginAttempts.delete(k);
    await sql`update app_user set pin_failures = 0 where id = ${req.userId!}`;
    return { ok: true, unlockKey: await unlockSession(req) };
  });
  app.post('/api/auth/lock', async (req) => {
    await requireAuth(req, { allowLocked: true });
    await sql`update session set unlocked_until = now() - interval '1 second', unlock_keys = '{}' where token_hash = ${sha256(req.cookies[SESSION_COOKIE]!)}`;
    return { ok: true };
  });

  // Single-user app: setup works exactly once, while no user exists.
  app.post('/api/auth/setup', async (req, reply) => {
    const body = Credentials.parse(req.body);
    const banks = z.object({ banks: z.array(z.string().trim().min(1).max(40)).max(6).optional() }).parse(req.body ?? {}).banks ?? [];
    const userId = await sql.begin(async (tx) => {
      await tx`lock table app_user in exclusive mode`;
      const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from app_user`;
      if (n > 0) throw new LedgerError('already_setup', 'This app already has an owner. Log in instead.', 409);
      const [u] = await tx<{ id: string }[]>`insert into app_user (email, password_hash) values (${body.email.toLowerCase()}, ${await hashPassword(body.password)}) returning id`;
      const real = await createBook(tx, u.id, 'My money', false);
      await seedRealBookAccounts(tx, real, banks);
      await createBook(tx, u.id, 'Demo', true);
      return u.id;
    });
    const [demo] = await sql<{ id: string }[]>`select id from book where user_id = ${userId} and is_demo`;
    await seedDemo(sql, demo.id);
    return { ok: true, unlockKey: await startSession(reply, userId) };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = Credentials.parse(req.body);
    const key = `${req.ip}:${body.email.toLowerCase()}`;
    const att = loginAttempts.get(key);
    if (att && att.n >= 5 && att.until > Date.now()) throw new LedgerError('rate_limited', 'Too many attempts. Try again in 15 minutes.', 429);
    const [u] = await sql<{ id: string; password_hash: string }[]>`select id, password_hash from app_user where email = ${body.email.toLowerCase()}`;
    if (!u || !(await verifyPassword(body.password, u.password_hash))) {
      const n = (att && att.until > Date.now() ? att.n : 0) + 1;
      loginAttempts.set(key, { n, until: Date.now() + 15 * 60_000 });
      throw new LedgerError('bad_credentials', 'Wrong email or password', 401);
    }
    loginAttempts.delete(key);
    return { ok: true, unlockKey: await startSession(reply, u.id) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await sql`delete from session where token_hash = ${sha256(token)}`;
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // Zerodha sends the browser back here with a full page load, which can't carry the tab's unlock
  // key (x-unlock). So this route needs only a logged-in session, not an unlocked tab: it stores the
  // Kite token, returns no data, and redirects into the app (which shows the lock screen if needed).
  app.get('/api/kite/callback', async (req, reply) => {
    try { await requireAuth(req, { allowLocked: true }); } catch { return reply.redirect('/?kite=login_needed'); }
    const q = z.object({ request_token: z.string().min(4).max(128).optional(), status: z.string().optional() }).safeParse(req.query);
    if (!q.success || q.data.status !== 'success' || !q.data.request_token) return reply.redirect('/accounts?kite=cancelled');
    const book = req.book!.id;
    try { await kite.completeLogin(sql, cipher, book, q.data.request_token, cfg.fetch); } catch { return reply.redirect('/accounts?kite=login_failed'); }
    try {
      await kite.syncHoldings(sql, cipher, book, cfg.fetch);
      return reply.redirect('/accounts?kite=synced');
    } catch {
      return reply.redirect('/accounts?kite=login_ok_sync_failed');
    }
  });

  // ---------- everything below needs a session ----------
  await app.register(async (api) => {
    api.addHook('preHandler', async (req) => requireAuth(req));
    const B = (req: FastifyRequest) => req.book!.id;

    api.get('/api/book', async (req) => req.book);

    // Face ID: register this device, list/remove passkeys, app-lock settings
    api.post('/api/passkeys/register/options', async (req, reply) => {
      const o = await passkeys.registrationOptions(sql, pk, req.userId!);
      setChallenge(reply, 'register', o.challenge);
      return o;
    });
    api.post('/api/passkeys/register/verify', async (req, reply) => {
      const b = req.body as any;
      return passkeys.verifyRegistration(sql, pk, req.userId!, takeChallenge(req, reply, 'register'), b?.response, typeof b?.deviceName === 'string' ? b.deviceName.slice(0, 60) : null);
    });
    api.get('/api/passkeys', async (req) => passkeys.listPasskeys(sql, req.userId!));
    api.delete('/api/passkeys/:id', async (req) => { await passkeys.removePasskey(sql, req.userId!, (req.params as any).id); return { ok: true }; });
    api.put('/api/security', async (req) => {
      const b = z.object({ lockEnabled: z.boolean(), lockMinutes: z.number().int().min(1).max(1440).optional(), lockOnOpen: z.boolean().optional() }).parse(req.body);
      await sql`update app_user set lock_enabled = ${b.lockEnabled}, lock_minutes = coalesce(${b.lockMinutes ?? null}, lock_minutes),
                  lock_on_open = coalesce(${b.lockOnOpen ?? null}, lock_on_open) where id = ${req.userId!}`;
      await sql`update session set unlocked_until = now() + make_interval(mins => (select lock_minutes from app_user where id = ${req.userId!}))
                where token_hash = ${sha256(req.cookies[SESSION_COOKIE]!)}`;
      return { ok: true };
    });

    // Unlock PIN: set/change needs the account password; remove needs an unlocked session.
    api.put('/api/security/pin', async (req) => {
      const b = z.object({ pin: z.string().regex(/^\d{4,6}$/, 'PIN must be 4 to 6 digits'), password: z.string().min(1).max(200) }).parse(req.body);
      const [u] = await sql<{ password_hash: string }[]>`select password_hash from app_user where id = ${req.userId!}`;
      if (!(await verifyPassword(b.password, u.password_hash))) throw new LedgerError('bad_credentials', 'Wrong password', 401);
      if (/^(\d)\1+$/.test(b.pin) || '0123456789'.includes(b.pin) || '9876543210'.includes(b.pin)) throw new LedgerError('weak_pin', 'Pick a PIN that isn\'t all one digit or a straight run like 1234.', 400);
      await sql`update app_user set pin_hash = ${await hashPassword(b.pin)}, pin_length = ${b.pin.length}, pin_failures = 0 where id = ${req.userId!}`;
      return { ok: true };
    });
    api.delete('/api/security/pin', async (req) => {
      await sql`update app_user set pin_hash = null, pin_length = null, pin_failures = 0 where id = ${req.userId!}`;
      return { ok: true };
    });

    // Accounts and categories
    api.get('/api/accounts', async (req) => {
      const rows = await accountBalances(sql, B(req));
      return rows.filter((r) => r.kind !== 'category');
    });
    api.post('/api/accounts', async (req) => ({ id: await createAccount(sql, B(req), AccountInput.parse(req.body)) }));
    api.patch('/api/accounts/:id', async (req) => {
      await updateAccount(sql, B(req), (req.params as any).id, AccountPatch.parse(req.body));
      return { ok: true };
    });
    api.get('/api/categories', async (req) => {
      return sql<any[]>`
        select a.id, a.name, a.class, a.parent_id, a.icon, a.sort, a.is_archived, (a.class = 'income' and not counts_as_income(a)) as not_income,
          (select count(*)::int from posting p join txn t on t.id = p.txn_id
             where p.account_id = a.id and t.status = 'posted' and t.occurred_on > current_date - 90) as recent_uses
        from account a where a.book_id = ${B(req)} and a.kind = 'category' and (not a.is_archived or ${(req.query as any)?.all === '1'})
        order by a.class, a.sort, a.name`;
    });
    api.post('/api/categories', async (req) => ({ id: await createCategory(sql, B(req), CategoryInput.parse(req.body)) }));
    api.patch('/api/categories/:id', async (req) => { await updateCategory(sql, B(req), (req.params as any).id, CategoryPatch.parse(req.body)); return { ok: true }; });

    // Category suggestion: what did you use last time for this merchant?
    api.get('/api/suggest', async (req) => {
      const q = z.object({ merchant: z.string().min(1).max(120) }).parse(req.query);
      const [cat] = await sql<{ category_id: string }[]>`
        select p.account_id as category_id
        from txn t join posting p on p.txn_id = t.id join account a on a.id = p.account_id
        where t.book_id = ${B(req)} and t.status = 'posted' and a.kind = 'category' and lower(t.merchant) = lower(${q.merchant})
        group by p.account_id order by count(*) desc, max(t.occurred_on) desc limit 1`;
      const [acc] = await sql<{ account_id: string }[]>`
        select p.account_id
        from txn t join posting p on p.txn_id = t.id join account a on a.id = p.account_id
        where t.book_id = ${B(req)} and t.status = 'posted' and lower(t.merchant) = lower(${q.merchant})
          and a.class in ('asset', 'liability') and a.kind <> 'receivable'
        order by t.occurred_on desc, t.created_at desc limit 1`;
      return { categoryId: cat?.category_id ?? null, accountId: acc?.account_id ?? null };
    });

    // Transactions
    api.get('/api/txns', async (req) => {
      const q = z.object({
        from: z.string().optional(), to: z.string().optional(), q: z.string().max(100).optional(),
        accountId: z.string().uuid().optional(), categoryId: z.string().uuid().optional(),
        min: z.coerce.number().optional(), max: z.coerce.number().optional(),
        kind: z.enum(['expense', 'income', 'transfer', 'split', 'refund', 'opening']).optional(),
        includeVoid: z.coerce.boolean().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100), before: z.string().optional(),
      }).parse(req.query);
      const like = q.q ? `%${q.q.replace(/[%_]/g, (m) => '\\' + m)}%` : null;
      return sql<any[]>`
        select t.id, t.occurred_on::text as date, t.kind, t.status, t.merchant, t.description, t.note, t.tags, t.source, t.external_ref,
               t.refund_of, t.created_at,
               (select sum(abs(p.amount)) / 2 from posting p where p.txn_id = t.id)::bigint as amount,
               (select json_agg(json_build_object('accountId', p.account_id, 'name', a.name, 'class', a.class, 'kind', a.kind,
                         'icon', coalesce(a.icon, pa.icon), 'parent', pa.name, 'amount', p.amount) order by p.id)
                  from posting p join account a on a.id = p.account_id left join account pa on pa.id = a.parent_id
                  where p.txn_id = t.id) as postings
        from txn t
        where t.book_id = ${B(req)}
          ${q.includeVoid ? sql`` : sql`and t.status = 'posted'`}
          ${q.from ? sql`and t.occurred_on >= ${q.from}` : sql``}
          ${q.to ? sql`and t.occurred_on < ${q.to}` : sql``}
          ${q.kind ? sql`and t.kind = ${q.kind}` : sql``}
          ${like ? sql`and (t.merchant ilike ${like} or t.description ilike ${like} or t.note ilike ${like} or ${q.q!} = any(t.tags))` : sql``}
          ${q.accountId ? sql`and exists (select 1 from posting p where p.txn_id = t.id and p.account_id = ${q.accountId})` : sql``}
          ${q.categoryId ? sql`and exists (select 1 from posting p join account a on a.id = p.account_id where p.txn_id = t.id and (a.id = ${q.categoryId} or a.parent_id = ${q.categoryId}))` : sql``}
          ${q.min !== undefined ? sql`and (select sum(abs(p.amount)) / 2 from posting p where p.txn_id = t.id) >= ${q.min}` : sql``}
          ${q.max !== undefined ? sql`and (select sum(abs(p.amount)) / 2 from posting p where p.txn_id = t.id) <= ${q.max}` : sql``}
          ${q.before ? sql`and t.occurred_on <= ${q.before}` : sql``}
        order by t.occurred_on desc, t.created_at desc
        limit ${q.limit}`;
    });
    api.get('/api/txns/:id', async (req) => {
      const t = await getTxn(sql, B(req), (req.params as any).id);
      if (!t) throw new LedgerError('txn_not_found', 'transaction not found', 404);
      t.history = await sql<any[]>`select action, before, after, source, at from audit_log where entity = 'txn' and entity_id = ${t.id} order by id`;
      return t;
    });
    api.post('/api/txns', async (req, reply) => {
      const r = await createTxn(sql, B(req), TxnInput.parse(req.body));
      return reply.status(r.duplicate ? 200 : 201).send(r);
    });
    api.put('/api/txns/:id', async (req) => updateTxn(sql, B(req), (req.params as any).id, TxnInput.parse(req.body)));
    api.delete('/api/txns/:id', async (req) => { await voidTxn(sql, B(req), (req.params as any).id); return { ok: true }; });
    api.post('/api/txns/:id/restore', async (req) => { await restoreTxn(sql, B(req), (req.params as any).id); return { ok: true }; });

    // Budgets
    api.get('/api/budgets', async (req) => sql<any[]>`
      select b.*, c.name, c.icon from budget b join account c on c.id = b.category_id where b.book_id = ${B(req)} order by c.sort`);
    api.put('/api/budgets', async (req) => {
      const b = z.object({ categoryId: z.string().uuid(), period: z.enum(['weekly', 'monthly', 'annual']), amount: z.number().int().positive() }).parse(req.body);
      const [c] = await sql<any[]>`select id from account where id = ${b.categoryId} and book_id = ${B(req)} and class = 'expense'`;
      if (!c) throw new LedgerError('bad_category', 'budgets apply to expense categories', 422);
      await sql`insert into budget (book_id, category_id, period, amount) values (${B(req)}, ${b.categoryId}, ${b.period}, ${b.amount})
                on conflict (book_id, category_id, period) do update set amount = excluded.amount`;
      return { ok: true };
    });
    api.delete('/api/budgets/:id', async (req) => {
      await sql`delete from budget where id = ${(req.params as any).id} and book_id = ${B(req)}`;
      return { ok: true };
    });

    // Home and statistics
    api.get('/api/home', async (req) => {
      await postAutoDue(sql, B(req)); // auto-post rules that came due (idempotent)
      return home(sql, B(req), req.book!.month_start_day);
    });
    api.get('/api/networth', async (req) => netWorth(sql, B(req)));
    api.get('/api/safe-to-spend', async (req) => safeToSpend(sql, B(req), req.book!.month_start_day));

    const StatsQuery = z.object({
      period: z.enum(['week', 'month', 'year', 'custom']).default('month'),
      anchor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // exclusive
      categoryId: z.string().uuid().optional(),
    });
    api.get('/api/stats', async (req) => {
      const q = StatsQuery.parse(req.query);
      const msd = req.book!.month_start_day;
      const ranges = stats.resolvePeriod(q.period, q.anchor ?? todayIST(), msd, q.from && q.to ? { from: q.from, to: q.to } : undefined);
      const r = ranges.current;
      const [sum, prevSum, categories, merchants, accounts, people, daily, excluded, trend] = await Promise.all([
        stats.summary(sql, B(req), r),
        ranges.previous ? stats.summary(sql, B(req), ranges.previous) : null,
        stats.byCategory(sql, B(req), q.period, ranges, q.categoryId),
        stats.byMerchant(sql, B(req), r, q.categoryId),
        stats.byAccount(sql, B(req), r),
        stats.byPerson(sql, B(req), r),
        stats.daily(sql, B(req), r),
        stats.excluded(sql, B(req), r),
        q.period === 'custom' ? [] : stats.trend(sql, B(req), q.period, r, msd),
      ]);
      const transactions = q.categoryId ? await stats.transactionsFor(sql, B(req), r, q.categoryId) : [];
      const incomeCategories = await stats.byIncomeCategory(sql, B(req), r);
      return { period: q.period, range: r, previousRange: ranges.previous, comparedToDate: ranges.toDate, summary: sum, previousSummary: prevSum, categories, incomeCategories, merchants, accounts, people, daily, excluded, trend, transactions };
    });

    api.get('/api/integrity', async (req) => bookIntegrity(sql, B(req)));

    // Export: everything in the book as JSON (CSV export is built from this in the web app)
    api.get('/api/export', async (req, reply) => {
      const b = B(req);
      const [accounts, txns, postings, budgets, holdings, recurring, imports, goals, goalContributions, stuffItems] = await Promise.all([
        sql`select * from account where book_id = ${b}`,
        sql`select * from txn where book_id = ${b}`,
        sql`select p.* from posting p join txn t on t.id = p.txn_id where t.book_id = ${b}`,
        sql`select * from budget where book_id = ${b}`,
        sql`select * from holding_snapshot where book_id = ${b}`,
        sql`select * from recurring_rule where book_id = ${b}`,
        sql`select * from import_batch where book_id = ${b}`,
        sql`select * from goal where book_id = ${b}`,
        sql`select * from goal_contribution where book_id = ${b}`,
        sql`select * from stuff_item where book_id = ${b}`,
      ]);
      reply.header('Content-Disposition', `attachment; filename="paisa-export-${todayIST()}.json"`);
      // Secrets (Kite, Splitwise keys) are deliberately left out.
      return { exportedAt: new Date().toISOString(), accounts, txns, postings, budgets, holdings, recurring, imports, goals, goalContributions, stuff: stuffItems };
    });

    // Demo book: reset to fresh sample data
    api.post('/api/demo/reset', async (req) => {
      if (!req.book!.is_demo) throw new LedgerError('not_demo', 'Only the demo book can be reset', 403);
      await seedDemo(sql, B(req), { reset: true });
      return { ok: true };
    });

    // Zerodha Kite
    api.get('/api/kite', async (req) => {
      const link = await kite.getLink(sql, B(req));
      const holdings = await kite.latestHoldings(sql, B(req));
      const today = todayIST();
      const tokenFresh = !!link?.token_obtained_at && todayIST(new Date(link.token_obtained_at)) === today;
      return {
        linked: !!link, apiKey: link?.api_key ?? null, tokenFresh, kiteUserId: link?.kite_user_id ?? null,
        redirectUrl: `${cfg.publicUrl}/api/kite/callback`, holdings,
      };
    });
    api.put('/api/kite/credentials', async (req) => {
      const b = z.object({ apiKey: z.string().trim().min(6).max(64), apiSecret: z.string().trim().min(6).max(128) }).parse(req.body);
      await kite.saveCredentials(sql, cipher, B(req), b.apiKey, b.apiSecret);
      return { ok: true };
    });
    api.get('/api/kite/login-url', async (req) => {
      const link = await kite.getLink(sql, B(req));
      if (!link) throw new LedgerError('kite_not_linked', 'Add your Kite API key and secret first', 400);
      return { url: kite.loginUrl(link.api_key) };
    });
    api.post('/api/kite/sync', async (req) => kite.syncHoldings(sql, cipher, B(req), cfg.fetch));
    await registerExtras(api, { sql, cipher, fetch: cfg.fetch });
  });

  app.get('/api/health', async () => {
    await sql`select 1`;
    return { ok: true, today: todayIST(), month: periodContaining('month', todayIST()) };
  });

  // ---------- web app ----------
  if (cfg.webDist && fs.existsSync(cfg.webDist)) {
    await app.register(fastifyStatic, { root: cfg.webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'not_found' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
