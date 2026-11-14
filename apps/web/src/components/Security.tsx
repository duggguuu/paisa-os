import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { startAuthentication, startRegistration, browserSupportsWebAuthn, platformAuthenticatorIsAvailable } from '@simplewebauthn/browser';
import { api } from '../lib';
import { Icon } from './Icons';

/** Friendly message for the ways a Face ID prompt can fail. */
function faceIdError(e: any): string {
  if (e?.name === 'NotAllowedError') return 'Face ID was cancelled or timed out. Try again.';
  if (e?.name === 'InvalidStateError') return 'This device already has Face ID set up for Paisa.';
  return e?.message ?? 'Face ID failed.';
}

export async function loginWithFaceId() {
  const optionsJSON = await api<any>('/api/auth/passkey/options', { method: 'POST', body: {} });
  const response = await startAuthentication({ optionsJSON });
  await api('/api/auth/passkey/verify', { method: 'POST', body: { response } });
}

export async function unlockWithFaceId() {
  const optionsJSON = await api<any>('/api/auth/unlock/options', { method: 'POST', body: {} });
  const response = await startAuthentication({ optionsJSON });
  await api('/api/auth/unlock/verify', { method: 'POST', body: { response } });
}

/** Full-screen lock. Shown whenever the server says the session is locked. */
export function LockScreen({ email }: { email?: string }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function unlock() {
    setErr(null); setBusy(true);
    try { await unlockWithFaceId(); await qc.invalidateQueries(); }
    catch (e: any) { setErr(faceIdError(e)); }
    finally { setBusy(false); }
  }
  return (
    <div className="lock-screen">
      <img src="/logo-mark.png" alt="" className="lock-logo" />
      <h1>Paisa is locked</h1>
      {email && <p className="muted small">{email}</p>}
      <button className="btn accent" onClick={unlock} disabled={busy} autoFocus><Icon name="faceid" /> {busy ? 'Checking…' : 'Unlock with Face ID'}</button>
      {err && <p className="error">{err}</p>}
      <button className="btn small" style={{ marginTop: 18 }} onClick={async () => { await api('/api/auth/logout', { method: 'POST' }); window.location.href = '/'; }}>Log out instead</button>
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

  async function addDevice() {
    setErr(null); setBusy(true);
    try {
      const optionsJSON = await api<any>('/api/passkeys/register/options', { method: 'POST', body: {} });
      const response = await startRegistration({ optionsJSON });
      const name = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : /Mac/.test(navigator.userAgent) ? 'Mac' : 'This device';
      await api('/api/passkeys/register/verify', { method: 'POST', body: { response, deviceName: name } });
      await qc.invalidateQueries({ queryKey: ['passkeys'] });
      await qc.invalidateQueries({ queryKey: ['auth'] });
    } catch (e: any) { setErr(faceIdError(e)); } finally { setBusy(false); }
  }
  async function setLock(lockEnabled: boolean, lockMinutes?: number) {
    setErr(null);
    try { await api('/api/security', { method: 'PUT', body: { lockEnabled, lockMinutes } }); await qc.invalidateQueries({ queryKey: ['auth'] }); }
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
      {has && (
        <>
          <label className="toggle" style={{ marginTop: 10 }}>
            <input type="checkbox" checked={!!u?.lockEnabled} onChange={(e) => setLock(e.target.checked)} />
            <span><b>Lock Paisa</b><span className="tiny faint">Ask for Face ID when you come back after being away.</span></span>
          </label>
          {u?.lockEnabled && (
            <div className="seg full">
              {MINUTES.map((m) => <button key={m} className={u.lockMinutes === m ? 'on' : ''} onClick={() => setLock(true, m)}>{m < 60 ? `${m} min` : '1 hour'}</button>)}
            </div>
          )}
        </>
      )}
      {err && <p className="error">{err}</p>}
      <p className="tiny faint" style={{ marginBottom: 0 }}>Uses a passkey: Face ID unlocks a key that never leaves your phone. You can always log in with your password too.</p>
    </div>
  );
}
