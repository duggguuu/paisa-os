import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { money } from '../lib';
import { bio } from '../device';
import {
  discard, flushOutbox, hasOfflinePasskey, hasOfflinePin, outbox, SAVED_AT, unlockWithFaceId, unlockWithPin, type OfflineUser, type Pending,
} from '../offline';

export function useOnline() {
  const [on, setOn] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const up = () => setOn(true), down = () => setOn(false);
    window.addEventListener('online', up); window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  return on;
}

function useOutbox() {
  const [items, setItems] = useState<Pending[]>(outbox());
  useEffect(() => {
    const f = () => setItems(outbox());
    window.addEventListener('paisa:outbox', f); window.addEventListener('storage', f);
    return () => { window.removeEventListener('paisa:outbox', f); window.removeEventListener('storage', f); };
  }, []);
  return items;
}

const when = (iso: string | null) => {
  if (!iso) return 'earlier';
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
};

function describe(p: Pending) {
  const b = p.body ?? {};
  const amt = typeof b.amount === 'number' ? money(b.amount) : b.lines ? money(b.lines.reduce((s: number, l: any) => s + l.amount, 0)) : '';
  const what = b.kind === 'transfer' ? 'Transfer' : b.kind === 'income' ? 'Income' : b.kind === 'split' ? 'Split' : 'Expense';
  return `${what} ${amt}${b.merchant ? ` · ${b.merchant}` : ''}${b.date ? ` · ${b.date}` : ''}`;
}

/** Top-of-page strip: offline, and/or entries waiting to be sent. Tap to see them. */
export function OfflineBar() {
  const online = useOnline();
  const items = useOutbox();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [synced, setSynced] = useState<number | null>(null);
  useEffect(() => {
    const f = (e: Event) => { setSynced((e as CustomEvent).detail); qc.invalidateQueries(); setTimeout(() => setSynced(null), 4000); };
    window.addEventListener('paisa:synced', f);
    return () => window.removeEventListener('paisa:synced', f);
  }, [qc]);
  useEffect(() => { if (online) { flushOutbox(); qc.invalidateQueries(); } }, [online, qc]);
  const savedAt = (() => { try { return localStorage.getItem(SAVED_AT); } catch { return null; } })();
  const failed = items.filter((i) => i.error);
  if (online && !items.length && !synced) return null;
  return (
    <div className={`offline-bar ${online ? '' : 'off'}`}>
      <button className="offline-line" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="dot" aria-hidden />
        <span className="grow">
          {!online ? <>Offline · showing what was saved at {when(savedAt)}</> : synced ? <>Synced {synced} entr{synced === 1 ? 'y' : 'ies'} saved offline</> : <>Back online · sending saved entries…</>}
          {items.length > 0 && <> · <b>{items.length} waiting to sync</b></>}
          {failed.length > 0 && <> · <b>{failed.length} need a look</b></>}
        </span>
        {items.length > 0 && <span className="tiny">{open ? 'Hide' : 'Show'}</span>}
      </button>
      {open && items.length > 0 && (
        <div className="offline-list">
          {items.map((p) => (
            <div key={p.key} className="offline-item">
              <span className="grow">{describe(p)}{p.error && <span className="error" style={{ display: 'block', margin: 0 }}>{p.error}</span>}</span>
              <button className="btn small" onClick={() => { if (confirm('Discard this entry? It was never sent.')) discard(p.key); }}>Discard</button>
            </div>
          ))}
          <p className="tiny faint" style={{ margin: '6px 0 0' }}>New entries are sent in order as soon as you're online{online ? '' : ''} and unlocked. Balances and totals update once they're sent. Edits and deletes need a connection.</p>
          {online && <button className="btn small" onClick={() => flushOutbox()}>Send now</button>}
        </div>
      )}
    </div>
  );
}

/** The app lock when there's no connection: Face ID on the phone itself, or your PIN checked on this device. */
export function OfflineLock({ user, onUnlocked }: { user: OfflineUser; onUnlocked: () => void }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const face = hasOfflinePasskey(), canPin = hasOfflinePin() && !!user.pinLength;
  async function tryFace() { setBusy(true); setErr(null); const e = await unlockWithFaceId(); setBusy(false); if (e) setErr(e); else onUnlocked(); }
  async function tryPin(v: string) { setBusy(true); setErr(null); const e = await unlockWithPin(v); setBusy(false); setPin(''); if (e) setErr(e); else onUnlocked(); }
  return (
    <div className="lock-screen">
      <img src="/logo-mark.png" alt="" className="lock-logo" />
      <h1>Paisa is locked</h1>
      <p className="muted small">You're offline. {face || canPin ? 'Unlock on this device to see your saved data and add entries.' : `Unlock once with ${bio()} or your PIN while online, and it will work offline next time.`}</p>
      {face && <button className="btn accent" disabled={busy} onClick={tryFace}>{busy ? 'Checking…' : `Unlock with ${bio()}`}</button>}
      {canPin && (
        <label className="pin-boxes" aria-label={`Enter your ${user.pinLength}-digit PIN`} style={{ marginTop: 12 }}>
          <input type="password" inputMode="numeric" pattern="[0-9]*" autoComplete="off" maxLength={user.pinLength!} value={pin} disabled={busy} autoFocus={!face}
            onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(0, user.pinLength!); setPin(v); if (v.length === user.pinLength) tryPin(v); }} />
          {Array.from({ length: user.pinLength! }, (_, i) => <span key={i} className={i < pin.length ? 'on' : ''} />)}
        </label>
      )}
      {err && <p className="error">{err}</p>}
      <p className="tiny faint" style={{ maxWidth: 320, textAlign: 'center' }}>{user.email}</p>
    </div>
  );
}
