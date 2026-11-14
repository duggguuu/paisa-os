/** Appearance preferences (per device): theme, light/dark/auto, contrast. */
export type Mode = 'auto' | 'light' | 'dark';
export interface Prefs { theme: string; mode: Mode; contrast: 'normal' | 'high' }

export const THEMES: { id: string; name: string; swatch: string }[] = [
  { id: 'monotone', name: 'Monotone', swatch: 'linear-gradient(135deg,#f2f2f2,#8a8a8a 55%,#2b2b2b)' },
  { id: 'pastel', name: 'Pastel', swatch: 'linear-gradient(135deg,#d9cffb,#bfeede 60%,#f7d6c4)' },
  { id: 'cyber', name: 'Cyber', swatch: 'linear-gradient(135deg,#ff2bd6,#7b3cff 50%,#00e5ff)' },
  { id: 'brass', name: 'Brass', swatch: 'linear-gradient(135deg,#e3c98b,#a87b2e 55%,#4a3312)' },
  { id: 'editorial', name: 'Editorial', swatch: 'linear-gradient(135deg,#f4ece4,#c98a8f 55%,#5a1f28)' },
  { id: 'terracotta', name: 'Terracotta', swatch: 'linear-gradient(135deg,#e3a072,#c2613c 55%,#6f7a3a)' },
  { id: 'forest', name: 'Forest', swatch: 'linear-gradient(135deg,#8aa04a,#3f6e3a 55%,#1f2d1a)' },
  { id: 'risograph', name: 'Risograph', swatch: 'linear-gradient(135deg,#0078bf,#5a3ad0 50%,#ff48b0)' },
  { id: 'sepia', name: 'Sepia', swatch: 'linear-gradient(135deg,#f0e0c0,#c9a97a 55%,#8a6a45)' },
  { id: 'glass', name: 'Glass', swatch: 'linear-gradient(135deg,#bde4ff,#4a88f7 55%,#1d2f5a)' },
  { id: 'spider-verse', name: 'Spider-Verse', swatch: 'linear-gradient(135deg,#e5137a,#8e2de2 50%,#00b4d8)' },
  { id: 'spider-verse-2', name: 'Spider-Verse 2', swatch: 'linear-gradient(135deg,#f107a3,#9b2ff7 55%,#6a5af9)' },
];

const KEY = 'paisa.appearance';
const DEFAULTS: Prefs = { theme: 'glass', mode: 'auto', contrast: 'normal' };

export function getPrefs(): Prefs {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return DEFAULTS; }
}

const systemDark = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;

export function apply(p: Prefs = getPrefs()) {
  const root = document.documentElement;
  const dark = p.mode === 'dark' || (p.mode === 'auto' && systemDark());
  root.dataset.theme = THEMES.some((t) => t.id === p.theme) ? p.theme : 'glass';
  root.dataset.mode = dark ? 'dark' : 'light';
  root.dataset.contrast = p.contrast;
  root.style.colorScheme = dark ? 'dark' : 'light';
  // Status bar / browser chrome colour follows the theme background.
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  let meta = document.querySelector('meta[name="theme-color"]:not([media])') as HTMLMetaElement | null;
  document.querySelectorAll('meta[name="theme-color"][media]').forEach((m) => m.remove());
  if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
  if (bg) meta.content = bg;
}

export function setPrefs(patch: Partial<Prefs>) {
  const next = { ...getPrefs(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage unavailable: still applies for this visit */ }
  apply(next);
  window.dispatchEvent(new Event('paisa:appearance'));
  return next;
}

/** Call once at startup: applies prefs and follows the system setting while in Auto. */
export function initTheme() {
  apply();
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (getPrefs().mode === 'auto') apply(); }); } catch { /* old Safari */ }
}
