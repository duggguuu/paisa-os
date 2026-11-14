import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib';
import { loginWithFaceId } from '../components/Security';
import { Icon } from '../components/Icons';

export function Login({ setupNeeded, passkeyLogin }: { setupNeeded: boolean; passkeyLogin?: boolean }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      await api(setupNeeded ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', body: { email, password } });
      await qc.invalidateQueries({ queryKey: ['auth'] });
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="login">
      <div className="login-box">
        <div className="hero">
          <div className="brand"><span className="logo-tile"><img src="/logo-mark.png" alt="" /></span>Paisa OS</div>
          <h1>{setupNeeded ? 'Your money, finally in one place.' : 'Welcome back.'}</h1>
          <p>{setupNeeded ? 'Create your login. This app has one owner: you.' : 'Log in to see where your month stands.'}</p>
        </div>
        <form onSubmit={submit} className="card">
          <div className="field"><label htmlFor="email">Email</label>
            <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
          <div className="field"><label htmlFor="pw">Password</label>
            <input id="pw" className="input" type="password" autoComplete={setupNeeded ? 'new-password' : 'current-password'} minLength={10}
              value={password} onChange={(e) => setPassword(e.target.value)} required />
            {setupNeeded && <span className="tiny faint">At least 10 characters.</span>}</div>
          {err && <p className="error" role="alert">{err}</p>}
          <button className="btn accent block" disabled={busy}>{busy ? 'One moment…' : setupNeeded ? 'Create and continue' : 'Log in'}</button>
        </form>
        {!setupNeeded && passkeyLogin && (
          <button className="btn block" style={{ marginTop: 12 }} disabled={busy} onClick={async () => {
            setErr(null); setBusy(true);
            try { await loginWithFaceId(); await qc.invalidateQueries({ queryKey: ['auth'] }); }
            catch (e: any) { setErr(e?.name === 'NotAllowedError' ? 'Face ID was cancelled. Try again or use your password.' : e.message); }
            finally { setBusy(false); }
          }}><Icon name="faceid" /> Log in with Face ID</button>
        )}
        {setupNeeded
          ? <p className="note">You'll also get a separate demo book with sample data to explore. It never mixes with your real records.</p>
          : <p className="note">Private, single-owner ledger · Double-entry under the hood</p>}
      </div>
    </div>
  );
}
