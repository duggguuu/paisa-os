import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib';
import { useUi } from '../App';
import { scriptableScript, WIDGET_FEATURES } from '../widget-script';

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

/** Settings → Widgets: the view-only link + Scriptable script for iPhone home-screen and Lock Screen widgets. */
export function WidgetsSettings() {
  const qc = useQueryClient();
  const { toast } = useUi();
  const q = useQuery({ queryKey: ['widgets'], queryFn: () => api<any>('/api/widgets') });
  const auth = useQuery({ queryKey: ['auth'], queryFn: () => api<any>('/api/auth/status') });
  const [asking, setAsking] = useState(false);
  const [secret, setSecret] = useState('');
  const [script, setScript] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const link = q.data?.link;
  const pinInfo = auth.data?.user?.pin;
  const pin = pinInfo && !pinInfo.blocked ? pinInfo : null;

  const copy = async (s: string, what: string) => { try { await navigator.clipboard.writeText(s); toast(`${what} copied`); } catch { toast("Couldn't copy; select it by hand"); } };

  async function make() {
    setErr(null); setBusy(true);
    try {
      const r = await api<any>('/api/widgets/link', { method: 'POST', body: pin ? { pin: secret } : { password: secret } });
      setScript(scriptableScript(r.dataUrl, r.appUrl));
      setAsking(false); setSecret('');
      await qc.invalidateQueries({ queryKey: ['widgets'] });
    } catch (e: any) { setErr(e.message); setSecret(''); } finally { setBusy(false); }
  }
  async function off() {
    if (!confirm('Turn off the widget link? Your home-screen widgets stop updating until you make a new one.')) return;
    await api('/api/widgets/link', { method: 'DELETE' });
    setScript(null);
    await qc.invalidateQueries({ queryKey: ['widgets'] });
    toast('Widget link turned off');
  }
  async function hide(v: boolean) {
    await api('/api/widgets/hide', { method: 'PUT', body: { hide: v } });
    await qc.invalidateQueries({ queryKey: ['widgets'] });
  }

  if (!q.data) return <div className="card"><div className="skeleton" /></div>;
  return (
    <div className="card">
      <p className="small" style={{ marginTop: 0 }}>Put Paisa on your iPhone <b>home screen</b> and <b>Lock Screen</b> in small, medium and large sizes. iPhone only lets App Store apps make widgets, so this uses the free <b>Scriptable</b> app to draw them. Widgets for Paisa's own Home screen are under <b>Home → Widgets → Edit</b>.</p>

      <div className={`notif-status ${link.enabled ? 'ok' : 'warn'}`}>
        <span>{link.enabled ? `Widget link on${link.lastUsedAt ? ` · last updated ${when(link.lastUsedAt)}` : ' · not used yet'}` : 'No widget link yet'}</span>
        {link.enabled && <button className="btn small" onClick={off}>Turn off</button>}
      </div>

      <label className="toggle-row" style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '12px 0' }}>
        <input type="checkbox" checked={link.hideAmounts} onChange={(e) => hide(e.target.checked)} />
        <span><b>Hide amounts on iPhone widgets</b><span className="tiny faint" style={{ display: 'block' }}>Shows ₹ •••• instead of numbers, for widgets other people might see. Percentages and bill names still show.</span></span>
      </label>

      {!asking && !script && (
        <button className="btn accent small" onClick={() => { setAsking(true); setErr(null); }}>{link.enabled ? 'Make a new link and script' : 'Set up iPhone widgets'}</button>
      )}
      {asking && (
        <div className="backup-form">
          <p className="tiny faint">The link lets a widget read a summary of your money (no transactions, and it can't change anything). {link.enabled ? 'Making a new one turns the old one off.' : ''}</p>
          <input className="input" type="password" autoFocus inputMode={pin ? 'numeric' : undefined} maxLength={pin ? pin.length : 200}
            placeholder={pin ? 'Your app PIN' : 'Your Paisa login password'} value={secret}
            onChange={(e) => setSecret(pin ? e.target.value.replace(/\D/g, '') : e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') make(); }} />
          <div className="row" style={{ gap: 8 }}>
            <button className="btn accent grow" disabled={busy || !secret} onClick={make}>{busy ? 'Making…' : 'Make widget link'}</button>
            <button className="btn" onClick={() => setAsking(false)}>Cancel</button>
          </div>
          {err && <p className="error" role="alert">{err}</p>}
        </div>
      )}

      {script && (
        <div className="notif-setup small">
          <p><b>Your script is ready.</b> It holds your new link, so keep it to yourself. It's shown only now; if you lose it, make a new one.</p>
          <button className="btn accent block" onClick={() => copy(script, 'Script')}>Copy widget script</button>
          <ol>
            <li>Install <b>Scriptable</b> from the App Store (free).</li>
            <li>Open it, tap <b>+</b>, paste the script, and name it <b>Paisa</b> (tap the title at the top).</li>
            <li>On your home screen, touch and hold an empty spot → <b>Edit → Add Widget</b> → <b>Scriptable</b> → pick <b>small, medium or large</b> → <b>Add Widget</b>.</li>
            <li>Touch and hold the new widget → <b>Edit Widget</b>: Script = <b>Paisa</b>, and Parameter = what it shows (below). Add as many widgets as you like, each with its own size and parameter.</li>
            <li>Lock Screen: touch and hold the Lock Screen → <b>Customise → Lock Screen</b> → tap the widget area → <b>Scriptable</b>, then set the same Script and Parameter.</li>
          </ol>
          <p style={{ marginBottom: 4 }}><b>Parameters</b> (tap to copy). Add <code>,hide</code> to hide amounts on just that widget, like <code>networth,hide</code>.</p>
          <div className="list">
            {WIDGET_FEATURES.map((f) => (
              <button key={f.id} className="item" onClick={() => copy(f.id, `"${f.id}"`)}>
                <div className="grow"><div className="title"><code>{f.id}</code></div><div className="sub">{f.label}</div></div>
              </button>
            ))}
          </div>
          <p className="tiny faint">Widgets refresh about every 30 minutes (iPhone decides exactly when). Tapping one opens Paisa. If you're offline they show the last numbers and say "offline".</p>
          <button className="btn block" onClick={() => setScript(null)}>Done</button>
        </div>
      )}
    </div>
  );
}
