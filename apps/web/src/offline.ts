/**
 * Offline support.
 *
 * 1. A copy of what you've looked at (the query cache) is kept on this device in IndexedDB, per book,
 *    so the app opens with your data when there's no connection. The login status is NOT kept:
 *    offline, the app lock is checked on the device instead (Face ID, or your PIN against a salted
 *    hash saved after your last PIN unlock).
 * 2. New transactions saved offline go into an outbox (localStorage) with their idempotency key and
 *    are sent, in order, as soon as you're online and unlocked. The key makes a resend harmless: the
 *    server returns the entry it already has instead of adding it twice.
 * Logging out deletes all of it from the device.
 */
import { dehydrate, hydrate, type QueryClient } from '@tanstack/react-query';

// ---------- tiny IndexedDB key-value store ----------
const DB = 'paisa-offline', STORE = 'kv';
function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const q = fn(t.objectStore(STORE));
    q.onsuccess = () => res(q.result as T);
    q.onerror = () => rej(q.error);
  });
}
const kvGet = <T>(k: string) => idb<T | undefined>('readonly', (s) => s.get(k)).catch(() => undefined);
const kvSet = (k: string, v: unknown) => idb('readwrite', (s) => s.put(v, k)).catch(() => undefined);
const kvClear = () => idb('readwrite', (s) => s.clear()).catch(() => undefined);

const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* full or blocked */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const book = () => (ls.get('paisa.book') === 'demo' ? 'demo' : 'real');

// ---------- the saved copy of your data ----------
const SKIP = new Set(['auth', 'platform-auth', 'delete-preview', 'unlock-options']);
export const SAVED_AT = 'paisa.offline.savedAt';

export async function restoreCache(qc: QueryClient) {
  const saved = await kvGet<any>(`cache:${book()}`);
  if (saved) { try { hydrate(qc, saved); } catch { /* old format */ } }
}

export function persistCache(qc: QueryClient) {
  let t: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    t = null;
    if (ls.get('paisa.offline.off') === '1') return;
    const state = dehydrate(qc, { shouldDehydrateQuery: (q) => q.state.status === 'success' && !SKIP.has(String(q.queryKey[0])) });
    kvSet(`cache:${book()}`, state);
    ls.set(SAVED_AT, new Date().toISOString());
  };
  qc.getQueryCache().subscribe((e) => {
    if (e.type !== 'updated' || e.action.type !== 'success') return;
    if (!t) t = setTimeout(save, 1500);
  });
}

/** What the offline screen needs to know about you, saved whenever the app sees your login status. */
export type OfflineUser = { email: string; lockEnabled: boolean; pinLength: number | null };
export function rememberUser(u: any) {
  if (!u) return;
  const v: OfflineUser = { email: u.email, lockEnabled: !!u.lockEnabled, pinLength: u.pin?.length ?? null };
  ls.set('paisa.offline.user', JSON.stringify(v));
}
export function offlineUser(): OfflineUser | null {
  try { return JSON.parse(ls.get('paisa.offline.user') ?? 'null'); } catch { return null; }
}

export async function forgetOffline() {
  await kvClear();
  for (const k of ['paisa.offline.user', 'paisa.offline.pin', 'paisa.offline.passkeys', SAVED_AT, OUTBOX]) ls.del(k);
  try { sessionStorage.removeItem(UNLOCKED); } catch { /* ignore */ }
}

// ---------- unlocking while offline ----------
const UNLOCKED = 'paisa.offline.unlocked';
export const offlineUnlocked = () => { try { return sessionStorage.getItem(UNLOCKED) === '1'; } catch { return false; } };
const markUnlocked = () => { try { sessionStorage.setItem(UNLOCKED, '1'); } catch { /* ignore */ } };

const b64 = (u: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(u)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function pinHash(pin: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: 210_000 }, key, 256));
}
/** After a successful PIN unlock online: keep a salted hash so the same PIN works offline. */
export async function rememberPin(pin: string) {
  try {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    ls.set('paisa.offline.pin', JSON.stringify({ salt: b64(salt), hash: await pinHash(pin, salt), tries: 0 }));
  } catch { /* no WebCrypto */ }
}
export const hasOfflinePin = () => !!ls.get('paisa.offline.pin');
export async function unlockWithPin(pin: string): Promise<string | null> {
  const v = JSON.parse(ls.get('paisa.offline.pin') ?? 'null');
  if (!v) return 'No PIN saved on this device yet. Unlock once with your PIN while online.';
  if (v.tries >= 5) return 'Too many wrong PINs. Connect to the internet to unlock.';
  if ((await pinHash(pin, unb64(v.salt))) === v.hash) {
    ls.set('paisa.offline.pin', JSON.stringify({ ...v, tries: 0 })); markUnlocked(); return null;
  }
  ls.set('paisa.offline.pin', JSON.stringify({ ...v, tries: v.tries + 1 }));
  return v.tries + 1 >= 5 ? 'Too many wrong PINs. Connect to the internet to unlock.' : `Wrong PIN. ${4 - v.tries} ${4 - v.tries === 1 ? 'try' : 'tries'} left.`;
}

/** After a successful Face ID unlock online: remember which passkey this device used. */
export function rememberPasskey(id: string) {
  const ids: string[] = JSON.parse(ls.get('paisa.offline.passkeys') ?? '[]');
  if (!ids.includes(id)) ls.set('paisa.offline.passkeys', JSON.stringify([...ids, id].slice(-5)));
}
export const hasOfflinePasskey = () => JSON.parse(ls.get('paisa.offline.passkeys') ?? '[]').length > 0;
/** Face ID offline: the phone checks your face itself, so only a real Face ID match lets you in. */
export async function unlockWithFaceId(): Promise<string | null> {
  const ids: string[] = JSON.parse(ls.get('paisa.offline.passkeys') ?? '[]');
  if (!ids.length) return 'Face ID hasn’t been used on this device yet. Unlock once while online.';
  try {
    const cred = await navigator.credentials.get({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname, userVerification: 'required', timeout: 60_000,
      allowCredentials: ids.map((id) => ({ type: 'public-key' as const, id: Uint8Array.from(atob(id.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(id.length / 4) * 4, '=')), (c) => c.charCodeAt(0)) })),
    } });
    if (!cred) return 'Face ID didn’t work. Try again or use your PIN.';
    markUnlocked();
    return null;
  } catch { return 'Face ID was cancelled or didn’t match.'; }
}

// ---------- outbox: entries saved offline ----------
const OUTBOX = 'paisa.outbox';
export type Pending = { key: string; book: 'real' | 'demo'; path: string; method: string; body: any; at: string; error?: string };
export const outbox = (): Pending[] => { try { return JSON.parse(ls.get(OUTBOX) ?? '[]'); } catch { return []; } };
const saveOutbox = (x: Pending[]) => { ls.set(OUTBOX, JSON.stringify(x)); window.dispatchEvent(new Event('paisa:outbox')); };

export function canQueue(method: string, path: string) { return method === 'POST' && path === '/api/txns'; }
export function enqueue(path: string, method: string, body: any) {
  const key = body?.idempotencyKey ?? crypto.randomUUID();
  const item: Pending = { key, book: book(), path, method, body: { ...body, idempotencyKey: key }, at: new Date().toISOString() };
  saveOutbox([...outbox().filter((x) => x.key !== key), item]);
  return item;
}
export function discard(key: string) { saveOutbox(outbox().filter((x) => x.key !== key)); }

let flushing = false;
/** Send queued entries in order. Stops at the first network/lock problem; keeps rejected ones with the reason. */
export async function flushOutbox(): Promise<number> {
  if (flushing || !navigator.onLine) return 0;
  flushing = true;
  let sent = 0;
  try {
    for (const item of outbox()) {
      if (item.error) continue;                           // needs fixing or discarding by you
      let res: Response;
      try {
        res = await fetch(item.path, {
          method: item.method, credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-book': item.book, 'x-unlock': (() => { try { return sessionStorage.getItem('paisa.unlock') ?? ''; } catch { return ''; } })() },
          body: JSON.stringify(item.body),
        });
      } catch { break; }                                   // still offline
      if (res.status === 401 || res.status === 423) break; // log in / unlock first; try again then
      if (res.ok || res.status === 409) { discard(item.key); sent++; continue; }
      const msg = await res.json().then((j) => j?.message).catch(() => null);
      saveOutbox(outbox().map((x) => (x.key === item.key ? { ...x, error: msg ?? `Rejected (${res.status})` } : x)));
    }
  } finally { flushing = false; }
  if (sent) window.dispatchEvent(new CustomEvent('paisa:synced', { detail: sent }));
  return sent;
}

export function installOutbox() {
  const go = () => { flushOutbox().catch(() => undefined); };
  window.addEventListener('online', go);
  window.addEventListener('focus', go);
  setInterval(() => { if (outbox().length) go(); }, 20_000);
  go();
}
