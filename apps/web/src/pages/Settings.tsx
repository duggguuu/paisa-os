import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib';
import { useUi } from '../App';

export function Settings() {
  const qc = useQueryClient();
  const { book, switchBook, toast } = useUi();
  const kite = useQuery({ queryKey: ['kite'], queryFn: () => api<any>('/api/kite') });
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [err, setErr] = useState<string | null>(null);

  async function saveKite(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    try {
      await api('/api/kite/credentials', { method: 'PUT', body: { apiKey: apiKey.trim(), apiSecret: apiSecret.trim() } });
      setApiKey(''); setApiSecret('');
      await qc.invalidateQueries({ queryKey: ['kite'] });
      toast('Zerodha keys saved. Now log in from Accounts → Holdings.');
    } catch (e: any) { setErr(e.message); }
  }

  async function exportJson() {
    const res = await fetch('/api/export', { headers: { 'x-book': book }, credentials: 'same-origin' });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `paisa-${book}-export.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    qc.clear();
    window.location.href = '/';
  }

  return (
    <>
      <h1 className="page-title">Settings</h1>

      <div className="section-title">Which book</div>
      <div className="card">
        <div className="seg full">
          <button className={book === 'real' ? 'on' : ''} onClick={() => switchBook('real')}>My money</button>
          <button className={book === 'demo' ? 'on' : ''} onClick={() => switchBook('demo')}>Sample data</button>
        </div>
        <p className="tiny faint" style={{ marginBottom: 0 }}>The sample book has six months of made-up transactions to explore features with. It's a separate ledger and never mixes with your records.</p>
        {book === 'demo' && (
          <button className="btn small" style={{ marginTop: 10 }} onClick={async () => { await api('/api/demo/reset', { method: 'POST' }); await qc.invalidateQueries(); toast('Sample data reset'); }}>Reset sample data</button>
        )}
      </div>

      <div className="section">
        <div className="section-title">Zerodha (Kite)</div>
        <div className="card">
          {kite.data?.linked ? (
            <p className="small" style={{ marginTop: 0 }}>Connected with API key <span className="num">{kite.data.apiKey}</span>. Sync from Accounts → Holdings. Paste new keys below to replace them.</p>
          ) : (
            <ol className="small muted" style={{ paddingLeft: 18, marginTop: 0 }}>
              <li>Sign in at developers.kite.trade and create a <b>Personal</b> app (free).</li>
              <li>Set its redirect URL to: <span className="num" style={{ color: 'var(--ink)', wordBreak: 'break-all' }}>{kite.data?.redirectUrl}</span></li>
              <li>Paste the app's API key and secret here.</li>
            </ol>
          )}
          <form onSubmit={saveKite}>
            <div className="field"><label>API key</label><input className="input num" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" required /></div>
            <div className="field"><label>API secret</label><input className="input num" type="password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} autoComplete="off" required /></div>
            {err && <p className="error">{err}</p>}
            <button className="btn primary block">Save keys</button>
          </form>
          <p className="tiny faint" style={{ marginBottom: 0 }}>The secret is encrypted before it's stored. Paisa only reads holdings; it never places orders.</p>
        </div>
      </div>

      <div className="section">
        <div className="section-title">Voice</div>
        <div className="card small muted">Voice entry arrives in the next build. It'll use your browser's speech recognition by default, with Sarvam as a switch here for better Hinglish.</div>
      </div>

      <div className="section">
        <div className="section-title">Your data</div>
        <div className="list">
          <button className="item" onClick={exportJson}><div className="grow"><div className="title">Export everything</div><div className="sub">Accounts, transactions, entries, budgets and holdings as JSON</div></div></button>
          <button className="item" onClick={logout}><div className="grow"><div className="title">Log out</div></div></button>
        </div>
      </div>
    </>
  );
}
