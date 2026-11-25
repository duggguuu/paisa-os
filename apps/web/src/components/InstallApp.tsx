import { useEffect, useState } from 'react';
import { canPromptInstall, isInstalled, platform, promptInstall } from '../device';

/**
 * "Put Paisa on your home screen". Android (Chrome, Edge, Samsung Internet) gets a real Install button;
 * iPhone gets Safari's steps. Hidden once the app is installed and opened from its icon.
 */
export function InstallApp({ compact = false }: { compact?: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    window.addEventListener('paisa:installable', f);
    return () => window.removeEventListener('paisa:installable', f);
  }, []);
  const p = platform();
  if (isInstalled() || !['android', 'iphone', 'ipad'].includes(p)) return null;
  const ready = canPromptInstall();
  return (
    <div className={`card install-card ${compact ? 'compact' : ''}`}>
      <img src="/icon-192.png" alt="" width={44} height={44} />
      <div className="grow">
        <b>Install Paisa on this phone</b>
        {p === 'android' ? (
          ready
            ? <span className="tiny faint">Opens full-screen from its own icon, with fingerprint unlock, notifications and shortcuts.</span>
            : <span className="tiny faint">In Chrome tap <b>⋮</b> (top right) → <b>Install app</b> (or <b>Add to Home screen</b> → <b>Install</b>).</span>
        ) : (
          <span className="tiny faint">In Safari tap <b>Share</b> → <b>Add to Home Screen</b> → <b>Add</b>, then open Paisa from the new icon.</span>
        )}
      </div>
      {p === 'android' && ready && <button className="btn accent small" onClick={() => promptInstall()}>Install</button>}
    </div>
  );
}
