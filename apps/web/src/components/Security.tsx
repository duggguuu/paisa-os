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

/** Full-screen lock. Shown whenever the server says this session (or this tab) is locked. */
export function LockScreen({ email }: { email?: string }) {
  const qc = useQueryClient();
  const avail = useQuery({ queryKey: ['platform-auth'], queryFn: async () => browserSupportsWebAuthn() && (await platformAuthenticatorIsAvailable()), staleTime: Infinity });
  const keys = useQuery({ queryKey: ['auth'], queryFn: () => api<any>('/api/auth/status') });
  const faceId = avail.data !== false && keys.data?.passkeyLogin !== false;
  const o = usePrefetchedOptions('/api/auth/unlock/options', faceId);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState('');
  async function unlock() {
    setErr(null); setBusy(true);
    try {
      const optionsJSON = await o.take();          // instant when prefetched: keeps Safari's tap window
      const response = await startAuthentication({ optionsJSON });
      await api('/api/auth/unlock/verify', { method: 'POST', body: { response } });
      await qc.invalidateQueries();
    } catch (e: any) { setErr(faceIdError(e)); o.reload(); }
    finally { setBusy(false); }
  }
  async function unlockWithPassword(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      await api('/api/auth/unlock/password', { method: 'POST', body: { password } });
      setPassword('');
      await qc.invalidateQueries();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }
  const showPassword = usePassword || !faceId;
  return (
    <div className="lock-screen">
      <img src="/logo-mark.png" alt="" className="lock-logo" />
      <h1>Paisa is locked</h1>
      {email && <p className="muted small">{email}</p>}
      {!showPassword && <button className="btn accent" onClick={unlock} disabled={busy}><Icon name="faceid" /> {busy ? 'Checking…' : o.ready ? 'Unlock with Face ID' : 'Getting ready…'}</button>}
      {showPassword && (
        <form onSubmit={unlockWithPassword} style={{ display: 'grid', gap: 8, width: 'min(320px, 100%)' }}>
          <input className="input" type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          <button className="btn accent" disabled={busy || !password}>{busy ? 'Checking…' : 'Unlock'}</button>
        </form>
      )}
      {err && <p className="error">{err}</p>}
      {faceId && <button className="btn small" style={{ marginTop: 12 }} onClick={() => { setErr(null); setUsePassword(!usePassword); }}>{usePassword ? 'Use Face ID instead' : 'Use password instead'}</button>}
      <button className="btn small" style={{ marginTop: 8 }} onClick={async () => { await api('/api/auth/logout', { method: 'POST' }); forgetUnlockKey(); window.location.href = '/'; }}>Log out instead</button>
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
      <div className="row" style={{ marginBottom: 8 }}><Icon name="faceid" /><b>Face ID</b></div>
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
        <span><b>Lock Paisa</b><span className="tiny faint">Unlock with Face ID{has ? '' : ' (once set up)'} or your password.</span></span>
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
      {err && <p className="error">{err}</p>}
      <p className="tiny faint" style={{ marginBottom: 0 }}>Uses a passkey: Face ID unlocks a key that never leaves your phone. You can always log in with your password too.</p>
    </div>
  );
}
