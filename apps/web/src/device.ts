/**
 * Which kind of device this is, and what to call its built-in unlock (the passkey's user check):
 * Face ID on iPhone/iPad, fingerprint (or face / screen lock) on Android, Touch ID on a Mac,
 * Windows Hello on Windows. The same passkey code runs everywhere; only the words change.
 */
export type Platform = 'iphone' | 'ipad' | 'android' | 'mac' | 'windows' | 'other';

export function platform(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent;
  if (/iPhone|iPod/.test(ua)) return 'iphone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ipad';
  if (/Android/i.test(ua)) return 'android';
  if (/Mac/.test(ua)) return 'mac';
  if (/Windows/.test(ua)) return 'windows';
  return 'other';
}

/** The phone's own unlock, as people call it on this device ("Unlock with ___"). */
export function bio(p: Platform = platform()): string {
  return p === 'android' ? 'Fingerprint' : p === 'mac' ? 'Touch ID' : p === 'windows' ? 'Windows Hello' : 'Face ID';
}
/** Lower-case form for the middle of a sentence ("…asks for your fingerprint"). */
export function bioLower(p: Platform = platform()): string {
  return p === 'android' ? 'your fingerprint' : bio(p);
}
/** "Face ID", or "Face ID / fingerprint" where we can't tell which phone (server-written text, docs). */
export const BIO_ANY = 'Face ID / fingerprint';

export function deviceName(p: Platform = platform()): string {
  if (p === 'android') {
    // "Mozilla/5.0 (Linux; Android 15; Pixel 9) …" → "Pixel 9"
    const m = navigator.userAgent.match(/Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?\)/);
    const model = m?.[1]?.trim();
    return model && model !== 'K' ? model : 'Android phone';
  }
  return { iphone: 'iPhone', ipad: 'iPad', mac: 'Mac', windows: 'Windows PC', other: 'This device' }[p];
}

/** Opened from the home-screen icon (installed), not in a browser tab. */
export function isInstalled(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || !!(navigator as any).standalone;
}

// ---------- "Install app" on Android (Chrome, Edge, Samsung Internet) ----------
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
let deferred: InstallEvent | null = null;

/** Call once at start-up: Chrome fires this early, before any screen that shows the button exists. */
export function captureInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();               // keep Chrome's mini bar away; we show our own button
    deferred = e as InstallEvent;
    window.dispatchEvent(new Event('paisa:installable'));
  });
  window.addEventListener('appinstalled', () => { deferred = null; window.dispatchEvent(new Event('paisa:installable')); });
}
export const canPromptInstall = () => !!deferred;
/** Shows Chrome's install dialog. Returns true if installed. */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const e = deferred; deferred = null;
  await e.prompt();
  const { outcome } = await e.userChoice;
  window.dispatchEvent(new Event('paisa:installable'));
  return outcome === 'accepted';
}

/** Icon for the phone's unlock button. */
export const bioIcon = (p: Platform = platform()) => (p === 'android' ? 'fingerprint' : 'faceid');
