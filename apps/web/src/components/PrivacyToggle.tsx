import { useEffect, useState } from 'react';
import { isPrivate, setPrivate } from '../lib';
import { Icon } from './Icons';

/** Re-render on privacy changes (any component that shows amounts can use it; the shell does). */
export function usePrivacy() {
  const [on, setOn] = useState(isPrivate());
  useEffect(() => {
    const f = () => setOn(isPrivate());
    window.addEventListener('paisa:privacy', f);
    return () => window.removeEventListener('paisa:privacy', f);
  }, []);
  return on;
}

/** The eye button: hide / show every amount in the app. */
export function PrivacyToggle({ className = 'icon-btn', label = false }: { className?: string; label?: boolean }) {
  const on = usePrivacy();
  const text = on ? 'Show amounts' : 'Hide amounts';
  return (
    <button type="button" className={`${className} privacy-btn ${on ? 'on' : ''}`} onClick={() => setPrivate(!on)}
      aria-pressed={on} aria-label={text} title={`${text} (Shift+H)`}>
      <Icon name={on ? 'eyeOff' : 'eye'} />{label && <span>{text}</span>}
    </button>
  );
}
