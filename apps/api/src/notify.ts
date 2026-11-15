/**
 * Notifications (Web Push): three daily "add your expenses" nudges and renewal reminders for
 * bills, mandates and subscriptions.
 *
 * - Signing keys (VAPID) are generated once and kept in app_setting; nothing to configure.
 * - The server can't wake itself on Render's free plan, so a scheduler (GitHub Actions, hourly)
 *   calls POST /api/cron/tick with a key derived from APP_SECRET. Each tick sends whatever is due
 *   (catching up to 3 hours late) and logs a key per reminder, so nothing is ever sent twice.
 * - Notifications show no amounts unless the owner turns that on (they appear on the lock screen).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import webpush from 'web-push';
import type { Sql } from './db.js';
import { postAutoDue } from './recurring.js';
import { addDays } from './money.js';

export interface Prefs { daily: { enabled: boolean; hours: number[] }; amounts: boolean }
export const DEFAULT_PREFS: Prefs = { daily: { enabled: true, hours: [9, 14, 21] }, amounts: false };
const CATCH_UP_HOURS = 3;

export function cronKey(appSecret: string) {
  return createHmac('sha256', appSecret).update('paisa-cron-v1').digest('base64url').slice(0, 40);
}
export function cronKeyOk(appSecret: string, given: unknown) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(cronKey(appSecret)), b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function vapidKeys(sql: Sql): Promise<{ publicKey: string; privateKey: string }> {
  const [row] = await sql<{ value: any }[]>`select value from app_setting where key = 'vapid'`;
  if (row) return row.value;
  const keys = webpush.generateVAPIDKeys();
  await sql`insert into app_setting (key, value) values ('vapid', ${sql.json(keys)}) on conflict (key) do nothing`;
  const [again] = await sql<{ value: any }[]>`select value from app_setting where key = 'vapid'`;
  return again.value;
}

export async function getPrefs(sql: Sql, userId: string): Promise<Prefs> {
  const [u] = await sql<{ notify_prefs: any }[]>`select notify_prefs from app_user where id = ${userId}`;
  const p = u?.notify_prefs ?? {};
  return { daily: { ...DEFAULT_PREFS.daily, ...(p.daily ?? {}) }, amounts: !!p.amounts };
}

export async function setPrefs(sql: Sql, userId: string, p: Prefs) {
  const hours = [...new Set(p.daily.hours.map((h) => Math.max(0, Math.min(23, Math.round(h)))))].sort((a, b) => a - b).slice(0, 6);
  await sql`update app_user set notify_prefs = ${sql.json({ daily: { enabled: !!p.daily.enabled, hours }, amounts: !!p.amounts })} where id = ${userId}`;
}

export async function subscribe(sql: Sql, userId: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }, device: string | null) {
  await sql`
    insert into push_subscription (user_id, endpoint, p256dh, auth, device)
    values (${userId}, ${sub.endpoint}, ${sub.keys.p256dh}, ${sub.keys.auth}, ${device})
    on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device`;
}

export interface Payload { title: string; body: string; url: string; tag?: string }

/** Send to every device of a user. Dead subscriptions (404/410) are removed. */
export async function sendToUser(sql: Sql, publicUrl: string, userId: string, payload: Payload, send = webpush.sendNotification) {
  const subs = await sql<{ id: string; endpoint: string; p256dh: string; auth: string }[]>`select id, endpoint, p256dh, auth from push_subscription where user_id = ${userId}`;
  if (!subs.length) return { sent: 0, devices: 0 };
  const keys = await vapidKeys(sql);
  let sent = 0;
  for (const s of subs) {
    try {
      await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), {
        TTL: 6 * 3600, urgency: 'normal',
        vapidDetails: { subject: publicUrl.startsWith('https://') ? publicUrl : 'https://example.invalid', publicKey: keys.publicKey, privateKey: keys.privateKey },
      });
      sent++;
      await sql`update push_subscription set last_ok_at = now() where id = ${s.id}`;
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) await sql`delete from push_subscription where id = ${s.id}`;
    }
  }
  return { sent, devices: subs.length };
}

/** IST date (YYYY-MM-DD) and hour for an instant. */
export function istNow(now = new Date()) {
  const t = new Date(now.getTime() + 5.5 * 3600_000);
  return { date: t.toISOString().slice(0, 10), hour: t.getUTCHours(), minute: t.getUTCMinutes() };
}

const DAILY = (h: number) => h < 12
  ? { title: 'Good morning ☀️', body: 'Add anything you spent since last night.' }
  : h < 17 ? { title: 'Quick check-in', body: 'Log what you’ve spent so far today.' }
  : { title: 'Before you call it a day 🌙', body: 'Add today’s expenses so your month stays accurate.' };

const MANDATE_LABEL: Record<string, string> = {
  subscription: 'Subscription', upi_autopay: 'UPI AutoPay', enach: 'e-NACH mandate', card_autopay: 'Card auto-pay', standing_instruction: 'Standing instruction', other: 'Auto-debit',
};

function whenText(daysBefore: number, due: string) {
  if (daysBefore === 0) return 'today';
  if (daysBefore === 1) return 'tomorrow';
  const d = new Date(`${due}T00:00:00Z`);
  return `in ${daysBefore} days (${d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })})`;
}

/**
 * One scheduler pass: auto-log due bills, then send every reminder that's due now (or up to
 * CATCH_UP_HOURS late, since hourly schedulers can be delayed). Returns what was sent.
 */
export async function tick(sql: Sql, publicUrl: string, now = new Date(), send = webpush.sendNotification) {
  const { date, hour } = istNow(now);
  const due = (h: number) => hour >= h && hour - h < CATCH_UP_HOURS;
  const out: string[] = [];
  await sql`insert into app_setting (key, value, updated_at) values ('last_tick', ${sql.json({ at: now.toISOString() })}, now())
            on conflict (key) do update set value = excluded.value, updated_at = now()`;
  const users = await sql<{ id: string }[]>`select id from app_user`;
  for (const u of users) {
    const [book] = await sql<{ id: string }[]>`select id from book where user_id = ${u.id} and not is_demo`;
    if (book) await postAutoDue(sql, book.id, date);
    const hasDevice = (await sql<{ n: number }[]>`select count(*)::int as n from push_subscription where user_id = ${u.id}`)[0].n > 0;
    if (!hasDevice || !book) continue;
    const prefs = await getPrefs(sql, u.id);
    const queue: { key: string; payload: Payload }[] = [];

    if (prefs.daily.enabled) {
      for (const h of prefs.daily.hours) {
        if (!due(h)) continue;
        const [{ n }] = await sql<{ n: number }[]>`
          select count(*)::int as n from txn where book_id = ${book.id} and status = 'posted' and kind <> 'opening' and occurred_on = ${date}`;
        const m = DAILY(h);
        queue.push({ key: `daily:${u.id}:${date}:${h}`, payload: { ...m, body: n ? `${m.body} ${n} added today so far.` : m.body, url: '/?add=1', tag: `daily-${h}` } });
      }
    }

    const rules = await sql<any[]>`
      select r.id, r.name, r.amount, r.kind, r.mandate, r.reminders, r.next_due::text as next_due, a.name as account_name
      from recurring_rule r join account a on a.id = r.account_id
      where r.book_id = ${book.id} and r.is_active and jsonb_array_length(r.reminders) > 0`;
    for (const r of rules) {
      for (const rem of r.reminders as { daysBefore: number; hour: number }[]) {
        if (addDays(r.next_due, -rem.daysBefore) !== date || !due(rem.hour)) continue;
        const what = r.mandate ? (MANDATE_LABEL[r.mandate.type] ?? 'Auto-debit') : r.kind === 'income' ? 'Expected' : 'Bill';
        const verb = r.mandate ? (r.mandate.type === 'subscription' ? 'renews' : 'debits') : r.kind === 'income' ? 'arrives' : 'is due';
        const amount = prefs.amounts ? ` · ₹${Math.round(Number(r.amount) / 100).toLocaleString('en-IN')}` : '';
        queue.push({
          key: `rem:${r.id}:${r.next_due}:${rem.daysBefore}`,
          payload: { title: `${r.name} ${verb} ${whenText(rem.daysBefore, r.next_due)}`, body: `${what} from ${r.account_name}${amount}. Cancel or top up before then if you need to.`, url: r.mandate ? '/mandates' : '/recurring', tag: `rem-${r.id}` },
        });
      }
    }

    for (const q of queue) {
      const [claimed] = await sql<{ key: string }[]>`insert into notification_log (key) values (${q.key}) on conflict (key) do nothing returning key`;
      if (!claimed) continue;
      const r = await sendToUser(sql, publicUrl, u.id, q.payload, send);
      out.push(`${q.key} → ${r.sent}/${r.devices}`);
    }
  }
  return { at: now.toISOString(), ist: `${date} ${String(hour).padStart(2, '0')}:00`, sent: out };
}
