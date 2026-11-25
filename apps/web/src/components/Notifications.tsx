import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib';
import { useUi } from '../App';

const HOURS = Array.from({ length: 24 }, (_, h) => h);
export const hourLabel = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? ' AM' : ' PM'}`;
const SLOT = ['Morning', 'Afternoon', 'Night'];

function deviceName() {
  const ua = navigator.userAgent;
  return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : 'This device';
}
const b64ToBytes = (s: string) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };

/** Why push can't work here, if it can't. */
function unsupported(): string | null {
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone;
  if (/iPhone|iPad/.test(navigator.userAgent) && !standalone) return 'On iPhone, notifications work in the installed app: in Safari tap Share → Add to Home Screen, open Paisa from your home screen, then come back here.';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return /Android/i.test(navigator.userAgent)
    ? 'This browser can’t show notifications. Open Paisa in Chrome (or install it from Chrome: ⋮ → Install app), then come back here.'
    : 'This browser can’t show notifications. Use Chrome, Edge, Firefox, or Safari on a Mac / the installed iPhone app (iOS 16.4 or later).';
  return null;
}

/** Settings → Notifications. */
export function NotificationSettings() {
  const qc = useQueryClient();
  const { toast } = useUi();
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => api<any>('/api/notifications') });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const d = q.data;
  const why = unsupported();
  const permission = typeof Notification !== 'undefined' ? Notification.permission : 'default';

  async function enable() {
    setErr(null); setBusy(true);
    try {
      const p = await Notification.requestPermission();
      if (p !== 'granted') throw new Error(p === 'denied' ? 'Notifications are blocked for Paisa. Allow them in your phone or browser settings, then try again.' : 'Notifications weren’t allowed.');
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(d.publicKey) }));
      await api('/api/notifications/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), device: deviceName() } });
      await qc.invalidateQueries({ queryKey: ['notifications'] });
      toast('Notifications on for this device');
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  async function savePrefs(patch: any) {
    const prefs = { ...d.prefs, ...patch, daily: { ...d.prefs.daily, ...(patch.daily ?? {}) } };
    qc.setQueryData(['notifications'], { ...d, prefs });
    try { await api('/api/notifications/prefs', { method: 'PUT', body: prefs }); } catch (e: any) { setErr(e.message); qc.invalidateQueries({ queryKey: ['notifications'] }); }
  }
  async function test() {
    setErr(null);
    try {
      const r = await api<any>('/api/notifications/test', { method: 'POST', body: {} });
      toast(r.sent ? `Sent to ${r.sent} device${r.sent === 1 ? '' : 's'}` : 'No device received it. Turn notifications on first.');
    } catch (e: any) { setErr(e.message); }
  }
  const copy = async (t: string, what: string) => { try { await navigator.clipboard.writeText(t); toast(`${what} copied`); } catch { window.prompt(`Copy ${what}:`, t); } };

  if (!d) return <div className="card"><div className="skeleton" /></div>;
  const lastTick = d.lastTick ? new Date(d.lastTick) : null;
  const tickOk = lastTick && Date.now() - lastTick.getTime() < 3 * 3600_000;

  return (
    <div className="card notif">
      {why ? <p className="small muted" style={{ marginTop: 0 }}>{why}</p> : (
        <div className="spread" style={{ gap: 10, flexWrap: 'wrap' }}>
          <span className="small">{permission === 'granted' && d.devices.length ? 'Notifications are on.' : 'Get reminders on this device.'}</span>
          <span className="row" style={{ gap: 6 }}>
            <button className="btn small accent" disabled={busy} onClick={enable}>{busy ? 'Asking…' : d.devices.length ? 'Add this device' : 'Turn on notifications'}</button>
            {d.devices.length > 0 && <button className="btn small" onClick={test}>Send a test</button>}
          </span>
        </div>
      )}
      {d.devices.length > 0 && (
        <div className="notif-devices">
          {d.devices.map((x: any) => (
            <div key={x.id} className="spread small">
              <span>{x.device ?? 'Device'} <span className="faint tiny">· added {new Date(x.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span></span>
              <button className="btn small danger" onClick={async () => { await api(`/api/notifications/devices/${x.id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['notifications'] }); }}>Remove</button>
            </div>
          ))}
        </div>
      )}

      <label className="toggle" style={{ marginTop: 12 }}>
        <input type="checkbox" checked={d.prefs.daily.enabled} onChange={(e) => savePrefs({ daily: { enabled: e.target.checked } })} />
        <span><b>Remind me to add expenses</b><span className="tiny faint">Three times a day (India time).</span></span>
      </label>
      {d.prefs.daily.enabled && (
        <div className="notif-hours">
          {[0, 1, 2].map((i) => (
            <label key={i} className="field" style={{ margin: 0 }}>
              <span className="tiny faint">{SLOT[i]}</span>
              <select className="input" value={d.prefs.daily.hours[i] ?? [9, 14, 21][i]}
                onChange={(e) => { const hours = [...d.prefs.daily.hours]; while (hours.length < 3) hours.push([9, 14, 21][hours.length]); hours[i] = Number(e.target.value); savePrefs({ daily: { hours } }); }}>
                {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
              </select>
            </label>
          ))}
        </div>
      )}
      <label className="toggle">
        <input type="checkbox" checked={d.prefs.amounts} onChange={(e) => savePrefs({ amounts: e.target.checked })} />
        <span><b>Show amounts in notifications</b><span className="tiny faint">Off by default: notifications can appear on your lock screen.</span></span>
      </label>
      <p className="tiny faint" style={{ margin: '8px 0 0' }}>Renewal reminders are set on each mandate or subscription (More → Mandates &amp; subscriptions).</p>

      <div className={`notif-status ${tickOk ? 'ok' : 'warn'}`}>
        <span>{tickOk ? `Delivery is set up. Last check ${lastTick!.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}.` : lastTick ? `Last check was ${lastTick.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}. Delivery may be paused.` : 'One-time setup needed so reminders arrive on time.'}</span>
        <button className="btn small" onClick={() => setShowSetup(!showSetup)}>{showSetup ? 'Hide' : 'How'}</button>
      </div>
      {showSetup && (
        <div className="notif-setup small">
          <p>The free server sleeps when nobody is using it, so an hourly alarm wakes it to send what's due. It's a GitHub Actions job that's already in your repository; it just needs two secrets:</p>
          <ol>
            <li>On GitHub, open your Paisa repository → <b>Settings → Secrets and variables → Actions → New repository secret</b>.</li>
            <li>Name <code>PAISA_URL</code>, value <code className="sel">{d.appUrl}</code> <button className="btn small" onClick={() => copy(d.appUrl, 'URL')}>Copy</button></li>
            <li>Name <code>PAISA_CRON_KEY</code>, value: <button className="btn small" onClick={() => copy(d.cronKey, 'Key')}>Copy key</button> <span className="tiny faint">(keep it private; it only lets the alarm send your reminders)</span></li>
            <li>Open the <b>Actions</b> tab. If asked, click <b>I understand my workflows, enable them</b>. Then open <b>Reminders → Run workflow</b> once to check.</li>
          </ol>
          <p className="tiny faint">Within an hour this box turns green. GitHub can run the alarm a little late; reminders still go out (up to 3 hours late, never twice).</p>
        </div>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}
