/**
 * Zerodha Kite Connect (Personal, free tier): read-only holdings sync.
 * Kite requires a manual login once a day; we store the day's access token encrypted
 * and pull holdings into dated snapshots. No order endpoints are ever called.
 */
import crypto from 'node:crypto';
import type { Sql } from './db.js';
import type { Cipher } from './crypto.js';
import { audit, LedgerError } from './ledger.js';

const API = 'https://api.kite.trade';
export type Fetch = typeof fetch;

export function loginUrl(apiKey: string) {
  return `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(apiKey)}`;
}

export async function saveCredentials(sql: Sql, cipher: Cipher, bookId: string, apiKey: string, apiSecret: string) {
  await sql`
    insert into kite_link (book_id, api_key, api_secret_enc) values (${bookId}, ${apiKey}, ${cipher.encrypt(apiSecret)})
    on conflict (book_id) do update set api_key = excluded.api_key, api_secret_enc = excluded.api_secret_enc,
      access_token_enc = null, token_obtained_at = null`;
}

export async function getLink(sql: Sql, bookId: string) {
  const [l] = await sql<any[]>`select * from kite_link where book_id = ${bookId}`;
  return l ?? null;
}

async function kiteCall(f: Fetch, path: string, init: RequestInit & { apiKey: string; token?: string }) {
  const headers: Record<string, string> = { 'X-Kite-Version': '3' };
  if (init.token) headers.Authorization = `token ${init.apiKey}:${init.token}`;
  if (init.body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const res = await f(`${API}${path}`, { method: init.method ?? 'GET', headers, body: init.body });
  const json: any = await res.json().catch(() => ({}));
  if (res.status === 403 || json?.error_type === 'TokenException') {
    throw new LedgerError('kite_login_required', 'Zerodha session expired. Log in to Kite again.', 401);
  }
  if (!res.ok || json?.status !== 'success') {
    throw new LedgerError('kite_error', `Kite: ${json?.message ?? res.statusText}`, 502);
  }
  return json.data;
}

/** Exchange the request_token from Kite's redirect for the day's access token. */
export async function completeLogin(sql: Sql, cipher: Cipher, bookId: string, requestToken: string, f: Fetch = fetch) {
  const link = await getLink(sql, bookId);
  if (!link) throw new LedgerError('kite_not_linked', 'Add your Kite API key and secret in Settings first', 400);
  const secret = cipher.decrypt(link.api_secret_enc);
  const checksum = crypto.createHash('sha256').update(link.api_key + requestToken + secret).digest('hex');
  const body = new URLSearchParams({ api_key: link.api_key, request_token: requestToken, checksum }).toString();
  const data = await kiteCall(f, '/session/token', { method: 'POST', body, apiKey: link.api_key });
  await sql`update kite_link set access_token_enc = ${cipher.encrypt(data.access_token)}, token_obtained_at = now(),
              kite_user_id = ${data.user_id ?? null} where book_id = ${bookId}`;
}

async function zerodhaAccount(sql: Sql, bookId: string): Promise<string> {
  const [acc] = await sql<{ id: string }[]>`
    select id from account where book_id = ${bookId} and kind = 'investment' and meta->>'kite' = 'true' limit 1`;
  if (acc) return acc.id;
  const [row] = await sql<{ id: string }[]>`
    insert into account (book_id, class, kind, name, institution, icon, meta)
    values (${bookId}, 'asset', 'investment', 'Zerodha', 'Zerodha', '📈', ${sql.json({ kite: true })}) returning id`;
  return row.id;
}

const toPaise = (rupees: number) => Math.round(rupees * 100);

export async function syncHoldings(sql: Sql, cipher: Cipher, bookId: string, f: Fetch = fetch) {
  const link = await getLink(sql, bookId);
  if (!link) throw new LedgerError('kite_not_linked', 'Add your Kite API key and secret in Settings first', 400);
  if (!link.access_token_enc) throw new LedgerError('kite_login_required', 'Log in to Kite to sync', 401);
  const token = cipher.decrypt(link.access_token_enc);
  const opts = { apiKey: link.api_key, token };

  const equity: any[] = await kiteCall(f, '/portfolio/holdings', opts);
  let mf: any[] = [];
  let mfError: string | null = null;
  try {
    mf = await kiteCall(f, '/mf/holdings', opts);
  } catch (e: any) {
    if (e.code === 'kite_login_required') throw e;
    mfError = e.message; // Some Personal apps can't read MF holdings; equity still syncs.
  }

  // Unused funds: cash sitting in the Kite account, not yet invested (equity segment, today's live balance).
  let funds: number | null = null;
  try {
    const m = await kiteCall(f, '/user/margins', opts);
    const eq = m?.equity;
    const v = Number(eq?.available?.live_balance ?? eq?.available?.cash ?? eq?.net);
    if (Number.isFinite(v)) funds = v;
  } catch (e: any) {
    if (e.code === 'kite_login_required') throw e;
  }

  const accountId = await zerodhaAccount(sql, bookId);
  const takenAt = new Date().toISOString();
  const rows = [
    ...equity.map((h) => {
      const qty = Number(h.quantity ?? 0) + Number(h.t1_quantity ?? 0);
      return {
        instrument: h.tradingsymbol, isin: h.isin ?? null, asset_type: 'equity',
        quantity: qty, avg_price: Number(h.average_price ?? 0), last_price: Number(h.last_price ?? 0),
        value_paise: toPaise(qty * Number(h.last_price ?? 0)),
      };
    }),
    ...mf.map((h) => ({
      instrument: h.fund ?? h.tradingsymbol, isin: h.tradingsymbol ?? null, asset_type: 'mf',
      quantity: Number(h.quantity ?? 0), avg_price: Number(h.average_price ?? 0), last_price: Number(h.last_price ?? 0),
      value_paise: toPaise(Number(h.quantity ?? 0) * Number(h.last_price ?? 0)),
    })),
  ].filter((r) => r.quantity > 0);
  // Stored as one 'cash' row so the account's value = holdings + unused funds.
  if (funds !== null && funds > 0) rows.push({ instrument: 'Unused funds', isin: null, asset_type: 'cash', quantity: 1, avg_price: funds, last_price: funds, value_paise: toPaise(funds) });

  await sql.begin(async (tx) => {
    for (const r of rows) {
      await tx`insert into holding_snapshot (book_id, account_id, taken_at, source, instrument, isin, asset_type, quantity, avg_price, last_price, value_paise)
               values (${bookId}, ${accountId}, ${takenAt}, 'kite', ${r.instrument}, ${r.isin}, ${r.asset_type}, ${r.quantity}, ${r.avg_price}, ${r.last_price}, ${r.value_paise})`;
    }
    await audit(tx, bookId, 'holdings', accountId, 'sync', null, { count: rows.length, takenAt, mfError }, 'kite');
  });
  return { accountId, takenAt, equityCount: rows.filter((r) => r.asset_type === 'equity').length, mfCount: rows.filter((r) => r.asset_type === 'mf').length, mfError, fundsPaise: funds !== null ? toPaise(funds) : null };
}

/** Latest snapshot per investment account. */
export async function latestHoldings(sql: Sql, bookId: string) {
  return sql<any[]>`
    with latest as (
      select account_id, max(taken_at) as taken_at from holding_snapshot where book_id = ${bookId} group by account_id
    )
    select h.account_id, h.taken_at, h.instrument, h.isin, h.asset_type, h.quantity::float8 as quantity,
           h.avg_price::float8 as avg_price, h.last_price::float8 as last_price, h.value_paise,
           round(h.quantity * h.avg_price * 100)::bigint as cost_paise
    from holding_snapshot h join latest l on l.account_id = h.account_id and l.taken_at = h.taken_at
    order by h.value_paise desc`;
}
