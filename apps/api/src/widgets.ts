/**
 * Widgets: one compact summary of the book, used by the Home screen tiles (with a session) and by the
 * iPhone home-screen widgets (Scriptable), which call GET /api/widget/data?t=<token> with a view-only
 * link. The link token is random (256 bits); only its SHA-256 is stored, in app_setting `widget:<userId>`.
 * The link can only read this summary; it can't see transactions, change anything, or open the app.
 */
import crypto from 'node:crypto';
import type { Sql } from './db.js';
import { home } from './dashboard.js';
import { listGoals } from './goals.js';
import { listFds } from './fds.js';
import { periodContaining, todayIST } from './money.js';

const DAY = 86_400_000;
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

async function budgetSummary(sql: Sql, bookId: string, from: string, to: string) {
  const rows = await sql<{ id: string; name: string; icon: string | null; limit: string; spent: string }[]>`
    with b as (
      select c.id, c.name, c.icon,
        sum(case b.period when 'monthly' then b.amount when 'annual' then b.amount / 12 else b.amount * 52 / 12 end)::bigint as lim
      from budget b join account c on c.id = b.category_id where b.book_id = ${bookId} group by c.id, c.name, c.icon)
    select b.id, b.name, b.icon, b.lim::text as limit,
      coalesce((select sum(p.amount) from posting p join txn t on t.id = p.txn_id join account a on a.id = p.account_id
        where t.book_id = ${bookId} and t.status = 'posted' and (a.id = b.id or a.parent_id = b.id)
          and t.occurred_on >= ${from} and t.occurred_on < ${to}), 0)::text as spent
    from b`;
  const items = rows.map((r) => ({ name: r.name, icon: r.icon, limit: Number(r.limit), spent: Number(r.spent) }));
  return {
    limit: items.reduce((s, x) => s + x.limit, 0),
    spent: items.reduce((s, x) => s + x.spent, 0),
    top: [...items].sort((a, b) => b.spent / Math.max(b.limit, 1) - a.spent / Math.max(a.limit, 1)).slice(0, 4),
  };
}

export async function widgetData(sql: Sql, bookId: string, monthStartDay: number) {
  const today = todayIST();
  const month = periodContaining('month', today, monthStartDay);
  const [h, goals, fds, budget] = await Promise.all([
    home(sql, bookId, monthStartDay, today), listGoals(sql, bookId), listFds(sql, bookId, today), budgetSummary(sql, bookId, month.from, month.to),
  ]);
  const total = Math.max(1, days(month.from, month.to));
  const daysLeft = Math.min(total, Math.max(1, days(today, month.to)));
  const sts = h.safeToSpend.amount;
  const next = fds.nextMaturity;
  return {
    asOf: new Date().toISOString(),
    month: { from: month.from, to: month.to, daysLeft, daysTotal: total },
    safeToSpend: { amount: sts, perDay: sts > 0 ? Math.round(sts / daysLeft) : 0 },
    thisMonth: { spent: Number(h.monthSummary.spent), earned: Number(h.monthSummary.earned) },
    netWorth: { total: h.netWorth.netWorth, assets: h.netWorth.assets, liabilities: h.netWorth.liabilities },
    budget,
    bills: h.dueSoon.slice(0, 5).map((r: any) => ({ name: r.name as string, amount: Number(r.amount), due: r.next_due as string, overdue: !!r.overdue, today: !!r.today })),
    fds: {
      count: fds.totals.count, principal: fds.totals.principal, valueNow: fds.totals.valueNow, atMaturity: fds.totals.atMaturity,
      next: next ? { name: next.name, maturity: next.maturity, atMaturity: next.atMaturity, daysLeft: next.daysLeft } : null,
    },
    goals: goals.filter((g) => !g.done).sort((a, b) => b.progress - a.progress).slice(0, 4)
      .map((g) => ({ name: g.name, icon: g.icon, saved: g.saved, target: g.target, progress: g.progress })),
    topSpending: h.topCategories.map((c: any) => ({ name: c.name as string, icon: c.icon as string | null, amount: Number(c.amount) })),
  };
}

// ── View-only link for home-screen widgets ─────────────────────────────────
const key = (userId: string) => `widget:${userId}`;
const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

export async function linkStatus(sql: Sql, userId: string) {
  const [row] = await sql<{ value: any }[]>`select value from app_setting where key = ${key(userId)}`;
  const v = row?.value;
  return { enabled: !!v?.hash, createdAt: v?.createdAt ?? null, lastUsedAt: v?.lastUsedAt ?? null, hideAmounts: !!v?.hideAmounts };
}

/** Make a new link (the old one stops working). Returns the token once; only its hash is kept. */
export async function newLink(sql: Sql, userId: string) {
  const token = crypto.randomBytes(32).toString('base64url');
  const cur = await linkStatus(sql, userId);
  const value = { hash: hash(token), createdAt: new Date().toISOString(), lastUsedAt: null, hideAmounts: cur.hideAmounts };
  await sql`insert into app_setting (key, value, updated_at) values (${key(userId)}, ${sql.json(value)}, now())
            on conflict (key) do update set value = excluded.value, updated_at = now()`;
  return token;
}

export async function setHideAmounts(sql: Sql, userId: string, hide: boolean) {
  await sql`insert into app_setting (key, value, updated_at) values (${key(userId)}, ${sql.json({ hideAmounts: hide })}, now())
            on conflict (key) do update set value = app_setting.value || ${sql.json({ hideAmounts: hide })}, updated_at = now()`;
}

export async function revokeLink(sql: Sql, userId: string) {
  await sql`update app_setting set value = (value - 'hash') || '{"lastUsedAt": null}'::jsonb, updated_at = now() where key = ${key(userId)}`;
}

/** Find whose link this is. Constant work per call: one indexed lookup by the hash. */
export async function userForToken(sql: Sql, token: string) {
  if (!token || token.length < 30 || token.length > 100) return null;
  const [row] = await sql<{ key: string; value: any }[]>`
    select key, value from app_setting where key like 'widget:%' and value->>'hash' = ${hash(token)} limit 1`;
  if (!row) return null;
  const userId = row.key.slice('widget:'.length);
  const last = row.value?.lastUsedAt ? Date.parse(row.value.lastUsedAt) : 0;
  if (Date.now() - last > 10 * 60_000) {
    await sql`update app_setting set value = value || ${sql.json({ lastUsedAt: new Date().toISOString() })} where key = ${row.key}`;
  }
  return { userId, hideAmounts: !!row.value?.hideAmounts };
}

// ── Home screen tiles (which ones, what size, in what order) ───────────────
export const TILE_IDS = ['spend', 'month', 'networth', 'budget', 'bills', 'fds', 'goals', 'top'] as const;
export type Tile = { id: typeof TILE_IDS[number]; size: 's' | 'm' | 'l' };
export const DEFAULT_TILES: Tile[] = [{ id: 'budget', size: 'm' }, { id: 'networth', size: 's' }, { id: 'fds', size: 's' }];

export async function getTiles(sql: Sql, userId: string): Promise<Tile[]> {
  const [row] = await sql<{ value: any }[]>`select value from app_setting where key = ${'tiles:' + userId}`;
  return Array.isArray(row?.value?.tiles) ? row.value.tiles : DEFAULT_TILES;
}

export async function saveTiles(sql: Sql, userId: string, tiles: Tile[]) {
  await sql`insert into app_setting (key, value, updated_at) values (${'tiles:' + userId}, ${sql.json({ tiles })}, now())
            on conflict (key) do update set value = excluded.value, updated_at = now()`;
}
