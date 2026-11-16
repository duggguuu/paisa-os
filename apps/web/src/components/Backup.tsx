import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, authHeaders } from '../lib';
import { useUi } from '../App';

type Status = { configured: boolean; lastBackupAt: string | null; lastBackupBytes: number | null; hint: string | null; cronKey: string; appUrl: string };
type Summary = { createdAt: string; accounts: number; categories: number; transactions: number; recurring: number; goals: number; firstDate: string | null; lastDate: string | null };

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

async function download(url: string, name: string) {
  const res = await fetch(url, { headers: authHeaders(), credentials: 'same-origin' });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? `Download failed (${res.status})`);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Settings → Backup: passphrase, nightly GitHub backup status, download now, restore. */
export function BackupSettings() {
  const qc = useQueryClient();
  const { toast } = useUi();
  const q = useQuery({ queryKey: ['backup'], queryFn: () => api<Status>('/api/backup') });
  const [mode, setMode] = useState<null | 'passphrase' | 'restore' | 'setup'>(null);
  const [p1, setP1] = useState(''); const [p2, setP2] = useState(''); const [hint, setHint] = useState(''); const [pw, setPw] = useState('');
  const [file, setFile] = useState<any>(null); const [fileName, setFileName] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const d = q.data;
  if (!d) return <div className="card"><div className="skeleton" /></div>;

  const fresh = d.lastBackupAt && Date.now() - new Date(d.lastBackupAt).getTime() < 30 * 3600_000;
  const reset = () => { setP1(''); setP2(''); setPw(''); setErr(null); setSummary(null); setFile(null); setFileName(''); };
  const copy = async (s: string, what: string) => { try { await navigator.clipboard.writeText(s); toast(`${what} copied`); } catch { toast(`Couldn't copy; select it by hand`); } };

  async function savePassphrase() {
    setErr(null);
    if (p1.length < 10) return setErr('Use at least 10 characters (a short sentence is easiest to remember).');
    if (p1 !== p2) return setErr("The two passphrases don't match.");
    setBusy(true);
    try {
      await api('/api/backup/passphrase', { method: 'PUT', body: { passphrase: p1, hint: hint.trim() || null, password: pw } });
      await qc.invalidateQueries({ queryKey: ['backup'] });
      toast('Backup passphrase saved'); reset(); setMode(d?.configured ? null : 'setup');
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  async function pick(f: File | undefined) {
    if (!f) return;
    setErr(null); setSummary(null);
    try {
      const text = await f.text();
      const json = JSON.parse(text);
      if (json?.format !== 'paisa-backup') throw new Error("That isn't a Paisa backup file (paisa-backup.json). If you downloaded it from GitHub, unzip it first.");
      setFile(json); setFileName(f.name);
    } catch (e: any) { setErr(e instanceof SyntaxError ? "That file isn't a Paisa backup." : e.message); }
  }

  async function check() {
    setErr(null); setBusy(true);
    try { setSummary(await api<Summary>('/api/backup/check', { method: 'POST', body: { file, passphrase: p1 } })); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  async function restore() {
    if (!summary) return;
    if (!confirm(`Replace everything in your book with the backup from ${when(summary.createdAt)}? Anything added after that will be gone (a safety copy of today's data is kept).`)) return;
    setErr(null); setBusy(true);
    try {
      await api('/api/backup/restore', { method: 'POST', body: { file, passphrase: p1, password: pw } });
      await qc.invalidateQueries();
      toast('Restored'); reset(); setMode(null);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="card backup-card">
      {!d.configured ? (
        <p className="small" style={{ marginTop: 0 }}>Every night your whole book is saved, encrypted, to your private GitHub repository. Each night's backup replaces the previous one. Set a backup passphrase to turn it on; only that passphrase can open a backup.</p>
      ) : (
        <div className={`notif-status ${fresh ? 'ok' : 'warn'}`} style={{ marginTop: 0 }}>
          <span>{d.lastBackupAt ? `${fresh ? 'Backed up' : 'Last backup'} ${when(d.lastBackupAt)}${d.lastBackupBytes ? ` · ${Math.max(1, Math.round(d.lastBackupBytes / 1024))} KB` : ''}` : 'Passphrase set. The first nightly backup runs at 2 AM.'}</span>
          <button className="btn small" onClick={() => setMode(mode === 'setup' ? null : 'setup')}>{mode === 'setup' ? 'Hide' : 'How'}</button>
        </div>
      )}

      <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
        <button className={`btn small ${d.configured ? '' : 'accent'}`} onClick={() => { reset(); setMode(mode === 'passphrase' ? null : 'passphrase'); }}>{d.configured ? 'Change passphrase' : 'Set backup passphrase'}</button>
        {d.configured && <button className="btn small" disabled={busy} onClick={async () => { try { setBusy(true); await download('/api/backup/download', `paisa-backup-${new Date().toISOString().slice(0, 10)}.json`); await qc.invalidateQueries({ queryKey: ['backup'] }); } catch (e: any) { toast(e.message); } finally { setBusy(false); } }}>Download a backup now</button>}
        <button className="btn small" onClick={() => { reset(); setMode(mode === 'restore' ? null : 'restore'); }}>Restore from a backup</button>
      </div>

      {mode === 'passphrase' && (
        <div className="backup-form">
          <p className="tiny faint">Write it down somewhere safe. If you lose it, the backups can't be opened, by you or anyone else. Changing it later doesn't affect older files: they still open with the passphrase they were made with.</p>
          <input className="input" type="password" autoComplete="new-password" placeholder="Backup passphrase (10+ characters)" value={p1} onChange={(e) => setP1(e.target.value)} />
          <input className="input" type="password" autoComplete="new-password" placeholder="Type it again" value={p2} onChange={(e) => setP2(e.target.value)} />
          <input className="input" placeholder="Hint for yourself (optional, not the passphrase)" value={hint} onChange={(e) => setHint(e.target.value)} maxLength={80} />
          <input className="input" type="password" autoComplete="current-password" placeholder="Your Paisa login password" value={pw} onChange={(e) => setPw(e.target.value)} />
          <button className="btn accent block" disabled={busy} onClick={savePassphrase}>{busy ? 'Saving…' : 'Save passphrase'}</button>
        </div>
      )}

      {mode === 'setup' && (
        <div className="notif-setup small">
          <p>The nightly backup uses the same GitHub alarm as your reminders. If reminders are already set up (Settings → Notifications is green), <b>there's nothing more to do</b>.</p>
          <p>Otherwise add these two secrets on GitHub: your Paisa repository → <b>Settings → Secrets and variables → Actions → New repository secret</b>:</p>
          <ol>
            <li><code>PAISA_URL</code> = <code className="sel">{d.appUrl}</code> <button className="btn small" onClick={() => copy(d.appUrl, 'URL')}>Copy</button></li>
            <li><code>PAISA_CRON_KEY</code> = <button className="btn small" onClick={() => copy(d.cronKey, 'Key')}>Copy key</button></li>
          </ol>
          <p><b>To get a backup file:</b> GitHub → your repository → <b>Actions → Daily backup</b> → the newest run → <b>Artifacts → paisa-backup</b>. It downloads as a zip; unzip it to get <code>paisa-backup.json</code>. To run one right away: <b>Daily backup → Run workflow</b>.</p>
          <p className="tiny faint">GitHub pauses scheduled jobs in a repository with no commits for 60 days. If that happens it emails you, and one click on "Enable workflow" resumes it.</p>
        </div>
      )}

      {mode === 'restore' && (
        <div className="backup-form">
          <p className="tiny faint">Choose a <code>paisa-backup.json</code> file (from GitHub, unzipped, or one you downloaded here). You'll see what's in it before anything changes.</p>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => pick(e.target.files?.[0])} />
          <button className="btn block" onClick={() => fileRef.current?.click()}>{fileName ? `File: ${fileName}` : 'Choose backup file'}</button>
          {file && <input className="input" type="password" placeholder="Backup passphrase" value={p1} onChange={(e) => { setP1(e.target.value); setSummary(null); }} />}
          {file && !summary && <button className="btn accent block" disabled={busy || !p1} onClick={check}>{busy ? 'Opening…' : 'Open backup'}</button>}
          {d.hint && file && !summary && <p className="tiny faint">Your hint: {d.hint}</p>}
          {summary && (
            <>
              <div className="backup-summary">
                <b>Backup from {when(summary.createdAt)}</b>
                <span>{summary.transactions} transactions{summary.firstDate ? ` (${summary.firstDate} to ${summary.lastDate})` : ''} · {summary.accounts} accounts · {summary.categories} categories · {summary.recurring} bills &amp; subscriptions · {summary.goals} goals</span>
              </div>
              <input className="input" type="password" autoComplete="current-password" placeholder="Your Paisa login password" value={pw} onChange={(e) => setPw(e.target.value)} />
              <button className="btn danger block" disabled={busy || !pw} onClick={restore}>{busy ? 'Restoring…' : 'Replace my data with this backup'}</button>
              <p className="tiny faint">Zerodha and Splitwise links aren't in backups (they hold secret keys); link them again after a restore.</p>
            </>
          )}
        </div>
      )}
      {err && <p className="error" role="alert">{err}</p>}
    </div>
  );
}
