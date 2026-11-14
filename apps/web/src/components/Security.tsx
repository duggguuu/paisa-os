import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { startAuthentication, startRegistration, browserSupportsWebAuthn, platformAuthenticatorIsAvailable } from '@simplewebauthn/browser';
import { api, forgetUnlockKey } from '../lib';
import { Icon } from './Icons';

/** Friendly message for the ways a Face ID prompt can fail. */
function faceIdError(e: any): string {
  if (e?.name === 'NotAllowedError') return 'Face ID was cancelled or didn\'t start. Tap the button again.';
  if (e?.name === 'InvalidStateError') return 'This device already has Face ID set up for Paisa.';
  return e?.message ?? 'Face ID failed.';
}

/**
 * Safari only shows Face ID if the request starts right after the tap. Asking the server for a
 * challenge first (a slow network, or Render waking up) uses up that window, so the prompt is
 * silently refused. So we fetch the challenge *before* the tap and keep it fresh: the tap then
 * goes straight to Face ID. (Challenges live 120 s on the server; we refresh every 90 s.)
 */
function usePrefetchedOptions(path: string, enabled = true) {
  const [opts, setOpts] = useState<{ json: any; at: number } | null>(null);
  const load = useCallback(async () => {
    try { setOpts({ json: await api<any>(path, { method: 'POST', body: {} }), at: Date.now() }); }
    catch { setOpts(null); }
  }, [path]);
  useEffect(() => {
    if (!enabled) return;
    load();
    const t = setInterval(load, 90_000);
    const onShow = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onShow);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onShow); };
  }, [enabled, load]);
  /** Fresh options right now: the prefetched ones if young enough, else fetched (slower). */
  const take = async () => {
    const fresh = opts && Date.now() - opts.at < 100_000 ? opts.json : await api<any>(path, { method: 'POST', body: {} });
    setOpts(null);
    return fresh;
  };
  return { ready: !!opts, take, reload: load };
}

export function useFaceIdLogin(enabled: boolean) {
  const o = usePrefetchedOptions('/api/auth/passkey/options', enabled);
  return {
    ready: o.ready,
    async run() {
      try {
        const optionsJSON = await o.take();
        const response = await startAuthentication({ optionsJSON });
        await api('/api/auth/passkey/verify', { method: 'POST', body: { response } });
      } catch (e: any) { o.reload(); throw new Error(faceIdError(e)); }
    },
  };
}

/** Phones and tablets use Face ID; laptops and desktops use the PIN. */
export function isPhone() {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod|Android/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

type Method = 'faceid' | 'pin' | 'password';

/** Full-screen lock. Shown whenever the server says this session (or this tab) is locked. */
export function LockScreen({ email }: { email?: string }) {
  const qc = useQueryClient();
  const avail = useQuery({ queryKey: ['platform-auth'], queryFn: async () => browserSupportsWebAuthn() && (await platformAuthenticatorIsAvailable()), staleTime: Infinity });
  const status = useQuery({ queryKey: ['auth'], queryFn: () => api<any>('/api/auth/status') });
  const pin = status.data?.user?.pin as { length: number; blocked: boolean } | null | undefined;
  const faceIdOk = avail.data !== false && !!status.data?.passkeyLogin;
  const pinOk = !!pin && !pin.blocked;
  const preferred: Method = isPhone() ? (faceIdOk ? 'faceid' : pinOk ? 'pin' : 'password') : (pinOk ? 'pin' : 'password');
  const [chosen, setChosen] = useState<Method | null>(null);
  const method: Method = chosen === 'pin' && !pinOk ? 'password' : chosen ?? preferred;
  const o = usePrefetchedOptions('/api/auth/unlock/options', method === 'faceid');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState('');

  async function done() { setSecret(''); await qc.invalidateQueries(); }
  async function faceId() {
    setErr(null); setBusy(true);
    try {
      const optionsJSON = await o.take();          // instant when prefetched: keeps Safari's tap window
      const response = await startAuthentication({ optionsJSON });
      await api('/api/auth/unlock/verify', { method: 'POST', body: { response } });
      await done();
    } catch (e: any) { setErr(faceIdError(e)); o.reload(); }
    finally { setBusy(false); }
  }
  async function submit(value = secret) {
    if (!value || busy) return;
    setErr(null); setBusy(true);
    try {
      await api(method === 'pin' ? '/api/auth/unlock/pin' : '/api/auth/unlock/password', { method: 'POST', body: method === 'pin' ? { pin: value } : { password: value } });
      await done();
    } catch (e: any) {
      setSecret('');
      setErr(e.message);
      if (e.code === 'pin_locked') await qc.invalidateQueries({ queryKey: ['auth'] });
    } finally { setBusy(false); }
  }
  const switchTo = (m: Method) => { setErr(null); setSecret(''); setChosen(m); };
  const others = (['faceid', 'pin', 'password'] as Method[]).filter((m) => m !== method && (m !== 'faceid' || faceIdOk) && (m !== 'pin' || pinOk));
  const label = { faceid: 'Use Face ID', pin: 'Use PIN', password: 'Use password' };

  return (
    <div className="lock-screen">
      <img src="/logo-mark.png" alt="" className="lock-logo" />
      <h1>Paisa is locked</h1>
      {email && <p className="muted small">{email}</p>}
      {method === 'faceid' && <button className="btn accent" onClick={faceId} disabled={busy}><Icon name="faceid" /> {busy ? 'Checking…' : o.ready ? 'Unlock with Face ID' : 'Getting ready…'}</button>}
      {method === 'pin' && pin && (
        <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="pin-form">
          <label className="pin-boxes" aria-label={`Enter your ${pin.length}-digit PIN`}>
            <input type="password" inputMode="numeric" pattern="[0-9]*" autoComplete="off" maxLength={pin.length} value={secret} autoFocus disabled={busy}
              onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(0, pin.length); setSecret(v); if (v.length === pin.length) submit(v); }} />
            {Array.from({ length: pin.length }, (_, i) => <span key={i} className={i < secret.length ? 'on' : ''} />)}
          </label>
          <span className="tiny faint">{busy ? 'Checking…' : `Enter your ${pin.length}-digit PIN`}</span>
        </form>
      )}
      {method === 'password' && (
        <form onSubmit={(e) => { e.preventDefault(); submit(); }} style={{ display: 'grid', gap: 8, width: 'min(320px, 100%)' }}>
          <input className="input" type="password" autoComplete="current-password" placeholder="Password" value={secret} onChange={(e) => setSecret(e.target.value)} autoFocus />
          <button className="btn accent" disabled={busy || !secret}>{busy ? 'Checking…' : 'Unlock'}</button>
          {!isPhone() && !pin && <span className="tiny faint">Tip: set a short PIN in Settings → Security for quicker unlocking on this laptop.</span>}
          {pin?.blocked && <span className="tiny faint">The PIN is paused after too many wrong tries. The password turns it back on.</span>}
        </form>
      )}
      {err && <p className="error">{err}</p>}
      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
        {others.map((m) => <button key={m} className="btn small" onClick={() => switchTo(m)}>{label[m]}</button>)}
      </div>
      <button className="btn small" style={{ marginTop: 4 }} onClick={async () => { await api('/api/auth/logout', { method: 'POST' }); forgetUnlockKey(); window.location.href = '/'; }}>Log out instead</button>
    </div>
  );
}

/** Settings → Security: the laptop PIN. */
function PinSettings({ pin }: { pin: { length: number; blocked: boolean } | null | undefined }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setMsg(null);
    if (!/^\d{4,6}$/.test(p1)) return setErr('PIN must be 4 to 6 digits');
    if (p1 !== p2) return setErr("The two PINs don't match");
    try {
      await api('/api/security/pin', { method: 'PUT', body: { pin: p1, password } });
      setP1(''); setP2(''); setPassword(''); setOpen(false); setMsg('PIN saved');
      await qc.invalidateQueries({ queryKey: ['auth'] });
    } catch (e: any) { setErr(e.message); }
  }
  const digits = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => set(e.target.value.replace(/\D/g, '').slice(0, 6));
  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
      <div className="spread"><b>Laptop PIN</b>{pin && <span className="tiny faint">{pin.length} digits{pin.blocked ? ' · paused' : ''}</span>}</div>
      <p className="tiny faint" style={{ margin: '4px 0 8px' }}>On a laptop or desktop browser the lock asks for this PIN. Your phone keeps using Face ID. The PIN only unlocks; logging in still needs your password or Face ID.</p>
      {!open && (
        <div className="row" style={{ gap: 8 }}>
          <button className="btn small" onClick={() => { setOpen(true); setMsg(null); }}>{pin ? 'Change PIN' : 'Set a PIN'}</button>
          {pin && <button className="btn small danger" onClick={async () => { if (confirm('Remove the PIN? The laptop will ask for your password instead.')) { await api('/api/security/pin', { method: 'DELETE' }); await qc.invalidateQueries({ queryKey: ['auth'] }); } }}>Remove</button>}
        </div>
      )}
      {open && (
        <form onSubmit={save} style={{ display: 'grid', gap: 8 }}>
          <div className="grid2">
            <input className="input num" type="password" inputMode="numeric" placeholder="New PIN (4–6 digits)" value={p1} onChange={digits(setP1)} autoFocus />
            <input className="input num" type="password" inputMode="numeric" placeholder="Repeat PIN" value={p2} onChange={digits(setP2)} />
          </div>
          <input className="input" type="password" autoComplete="current-password" placeholder="Your account password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <div className="row" style={{ gap: 8 }}>
            <button className="btn small accent" disabled={!p1 || !p2 || !password}>Save PIN</button>
            <button type="button" className="btn small" onClick={() => { setOpen(false); setErr(null); }}>Cancel</button>
          </div>
        </form>
      )}
      {err && <p className="error">{err}</p>}
      {msg && <p className="small" style={{ color: 'var(--inc)' }}>{msg}</p>}
    </div>
  );
}

const MINUTES = [1, 5, 15, 60];

/** Settings → Face ID & app lock. */
export function SecuritySettings() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['auth'], queryFn: () => api<any>('/api/auth/status') });
  const keys = useQuery({ queryKey: ['passkeys'], queryFn: () => api<any[]>('/api/passkeys') });
  const avail = useQuery({ queryKey: ['platform-auth'], queryFn: async () => browserSupportsWebAuthn() && (await platformAuthenticatorIsAvailable()), staleTime: Infinity });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const u = status.data?.user;
  const reg = usePrefetchedOptions('/api/passkeys/register/options', avail.data !== false);

  async function addDevice() {
    setErr(null); setBusy(true);
    try {
      const optionsJSON = await reg.take();
      const response = await startRegistration({ optionsJSON });
      const name = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : /Mac/.test(navigator.userAgent) ? 'Mac' : 'This device';
      await api('/api/passkeys/register/verify', { method: 'POST', body: { response, deviceName: name } });
      await qc.invalidateQueries({ queryKey: ['passkeys'] });
      await qc.invalidateQueries({ queryKey: ['auth'] });
    } catch (e: any) { setErr(faceIdError(e)); reg.reload(); } finally { setBusy(false); }
  }
  async function setLock(lockEnabled: boolean, lockMinutes?: number, lockOnOpen?: boolean) {
    setErr(null);
    try { await api('/api/security', { method: 'PUT', body: { lockEnabled, lockMinutes, lockOnOpen } }); await qc.invalidateQueries({ queryKey: ['auth'] }); }
    catch (e: any) { setErr(e.message); }
  }

  const has = (keys.data?.length ?? 0) > 0;
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}><Icon name="faceid" /><b>Face ID (phone)</b></div>
      {avail.data === false && <p className="small muted" style={{ marginTop: 0 }}>This browser can't use Face ID or Touch ID. On iPhone, open Paisa from the home screen (or Safari) to set it up.</p>}
      {keys.data?.map((k) => (
        <div key={k.id} className="spread small" style={{ padding: '6px 0' }}>
          <span>{k.device_name ?? 'Device'} <span className="faint">· added {new Date(k.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span></span>
          <button className="btn small danger" onClick={async () => { if (confirm('Remove Face ID for this device?')) { await api(`/api/passkeys/${encodeURIComponent(k.id)}`, { method: 'DELETE' }); await qc.invalidateQueries(); } }}>Remove</button>
        </div>
      ))}
      <button className="btn block" style={{ marginTop: 6 }} disabled={busy || avail.data === false} onClick={addDevice}>
        {busy ? 'Waiting for Face ID…' : has ? 'Add this device too' : 'Set up Face ID on this device'}
      </button>
      <label className="toggle" style={{ marginTop: 10 }}>
        <input type="checkbox" checked={!!u?.lockEnabled} onChange={(e) => setLock(e.target.checked)} />
        <span><b>Lock Paisa</b><span className="tiny faint">Phone: Face ID{has ? '' : ' (once set up)'}. Laptop: your PIN. Password always works.</span></span>
      </label>
      {u?.lockEnabled && (
        <>
          <label className="toggle">
            <input type="checkbox" checked={u.lockOnOpen !== false} onChange={(e) => setLock(true, undefined, e.target.checked)} />
            <span><b>Every time it opens</b><span className="tiny faint">A new browser tab, or reopening the iPhone app, asks first.</span></span>
          </label>
          <div className="tiny faint" style={{ margin: '6px 0 4px' }}>And after being away for</div>
          <div className="seg full">
            {MINUTES.map((m) => <button key={m} className={u.lockMinutes === m ? 'on' : ''} onClick={() => setLock(true, m)}>{m < 60 ? `${m} min` : '1 hour'}</button>)}
          </div>
        </>
      )}
      <PinSettings pin={u?.pin} />
      {err && <p className="error">{err}</p>}
      <p className="tiny faint" style={{ marginBottom: 0 }}>Face ID uses a passkey: Face ID unlocks a key that never leaves your phone. You can always log in with your password too.</p>
    </div>
  );
}
