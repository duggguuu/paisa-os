import { useEffect, useState } from 'react';
import { THEMES, getPrefs, setPrefs, type Mode, type Prefs } from '../theme';
import { Icon } from './Icons';
import { Sheet } from '../App';

export function useAppearance(): [Prefs, (p: Partial<Prefs>) => void] {
  const [p, setP] = useState(getPrefs());
  useEffect(() => {
    const on = () => setP(getPrefs());
    window.addEventListener('paisa:appearance', on);
    return () => window.removeEventListener('paisa:appearance', on);
  }, []);
  return [p, (patch) => setP(setPrefs(patch))];
}

const NEXT_MODE: Record<Mode, Mode> = { auto: 'dark', dark: 'light', light: 'auto' };

/** The three round buttons: dark mode, contrast, theme palette. */
export function AppearanceButtons({ onPalette }: { onPalette: () => void }) {
  const [p, set] = useAppearance();
  return (
    <div className="appearance-btns">
      <button className={`round-btn ${p.mode !== 'auto' ? 'on' : ''}`} onClick={() => set({ mode: NEXT_MODE[p.mode] })}
        aria-label={`Mode: ${p.mode}. Tap to change`} title={p.mode === 'auto' ? 'Auto (follows phone)' : p.mode === 'dark' ? 'Dark' : 'Light'}>
        <Icon name={p.mode === 'light' ? 'sun' : 'moon'} />{p.mode === 'auto' && <span className="auto-dot">A</span>}
      </button>
      <button className={`round-btn ${p.contrast === 'high' ? 'on' : ''}`} onClick={() => set({ contrast: p.contrast === 'high' ? 'normal' : 'high' })}
        aria-pressed={p.contrast === 'high'} aria-label="High contrast" title="High contrast"><Icon name="contrast" /></button>
      <button className="round-btn" onClick={onPalette} aria-label="Choose theme" title="Theme"><Icon name="palette" /></button>
    </div>
  );
}

export function ThemeList() {
  const [p, set] = useAppearance();
  return (
    <div className="theme-list" role="radiogroup" aria-label="Theme">
      {THEMES.map((t) => (
        <button key={t.id} role="radio" aria-checked={p.theme === t.id} className={`theme-opt ${p.theme === t.id ? 'on' : ''}`} onClick={() => set({ theme: t.id })}>
          <span className="sw" style={{ background: t.swatch }} />
          <span className="nm">{t.name}</span>
          {p.theme === t.id && <span className="ck">✓</span>}
        </button>
      ))}
    </div>
  );
}

export function ModeSeg() {
  const [p, set] = useAppearance();
  return (
    <div className="seg full">
      {(['auto', 'light', 'dark'] as Mode[]).map((m) => (
        <button key={m} className={p.mode === m ? 'on' : ''} onClick={() => set({ mode: m })}>{m === 'auto' ? 'Auto' : m === 'light' ? 'Light' : 'Dark'}</button>
      ))}
    </div>
  );
}

export function ThemeSheet({ onClose }: { onClose: () => void }) {
  const [p, set] = useAppearance();
  return (
    <Sheet title="Appearance" onClose={onClose}>
      <ModeSeg />
      <label className="toggle" style={{ borderTop: 0 }}>
        <input type="checkbox" checked={p.contrast === 'high'} onChange={(e) => set({ contrast: e.target.checked ? 'high' : 'normal' })} />
        <span><b>High contrast</b><span className="tiny faint">Darker text and stronger lines.</span></span>
      </label>
      <ThemeList />
    </Sheet>
  );
}
