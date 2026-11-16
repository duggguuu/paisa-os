/**
 * Motion effects with no library: confetti, the "saved" check and scroll reveals.
 * Each one does nothing when the device asks for reduced motion. (Page-morph View Transitions
 * were removed: they froze tab switches for seconds on phones.)
 */
import { reducedMotion } from './motion';

/** A short confetti burst from the top-centre (goal reached, month under budget). */
export function confetti(opts: { count?: number; ms?: number } = {}) {
  if (reducedMotion() || typeof document === 'undefined') return;
  const count = opts.count ?? 140, ms = opts.ms ?? 1900;
  const c = document.createElement('canvas');
  c.className = 'fx-confetti';
  c.setAttribute('aria-hidden', 'true');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = innerWidth * dpr; c.height = innerHeight * dpr;
  document.body.appendChild(c);
  const ctx = c.getContext('2d');
  if (!ctx) { c.remove(); return; }
  ctx.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const colors = ['--accent', '--accent-2', '--green', '--amber', '--indigo', '--inc', '--exp'].map((v) => css.getPropertyValue(v).trim()).filter(Boolean);
  const parts = Array.from({ length: count }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 80, y: innerHeight * 0.28,
    vx: (Math.random() - 0.5) * 11, vy: -Math.random() * 11 - 4,
    w: 5 + Math.random() * 5, h: 8 + Math.random() * 6, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.35,
    color: colors[Math.floor(Math.random() * colors.length)] || '#3b7cf5',
  }));
  const start = performance.now();
  const frame = (now: number) => {
    const t = now - start;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.32; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.globalAlpha = Math.max(0, 1 - t / ms); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.fillStyle = p.color; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)) + 1); ctx.restore();
    }
    if (t < ms) requestAnimationFrame(frame); else c.remove();
  };
  requestAnimationFrame(frame);
}

/** A check mark that draws itself in the middle of the screen (an entry was saved). */
export function savedCheck() {
  if (reducedMotion() || typeof document === 'undefined') return;
  const el = document.createElement('div');
  el.className = 'fx-check';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="23" pathLength="1"/><path d="M15 27 l7 7 l15 -16" pathLength="1"/></svg>';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 950);
}

/** Show confetti once per goal when it reaches 100%. */
export function celebrateGoals(goals: { id: string; done?: boolean; progress?: number }[] | undefined) {
  if (!goals?.length) return;
  let seen: string[] = [];
  try { seen = JSON.parse(localStorage.getItem('paisa.goalsCelebrated') ?? '[]'); } catch { /* ignore */ }
  const firstRun = !localStorage.getItem('paisa.goalsCelebrated');
  const done = goals.filter((g) => g.done || (g.progress ?? 0) >= 1).map((g) => g.id);
  const fresh = done.filter((id) => !seen.includes(id));
  if (!fresh.length) return;
  try { localStorage.setItem('paisa.goalsCelebrated', JSON.stringify([...seen, ...fresh])); } catch { /* ignore */ }
  if (!firstRun) confetti(); // don't celebrate goals that were already done before this feature existed
}

/**
 * Scroll reveals: list rows and cards below the fold fade and rise in, one after another, as they
 * scroll into view. Content already on screen is never hidden. Installed once from main.tsx.
 */
export function installScrollReveal() {
  if (reducedMotion() || typeof IntersectionObserver === 'undefined') return;
  const SEL = '.list > .item, .main .card, .goal-card, .kpi-card, .cat-group';
  let batch = 0;
  const io = new IntersectionObserver((entries) => {
    let i = 0;
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target as HTMLElement;
      io.unobserve(el);
      el.style.transitionDelay = `${Math.min(i++, 6) * 45}ms`;
      el.classList.add('rv-in');
      setTimeout(() => { el.classList.remove('rv', 'rv-in'); el.style.transitionDelay = ''; }, 900);
    }
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.05 });
  const scan = (root: ParentNode) => {
    const els = root.querySelectorAll<HTMLElement>(SEL);
    if (!els.length) return;
    batch++;
    const vh = innerHeight;
    els.forEach((el) => {
      if (el.dataset.rv || el.closest('.sheet, .scrim, .sheet-wrap')) return;
      el.dataset.rv = String(batch);
      if (el.getBoundingClientRect().top < vh) return; // on screen already: leave it alone
      el.classList.add('rv');
      io.observe(el);
    });
  };
  let queued = false;
  const mo = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; scan(document); });
  });
  mo.observe(document.body, { childList: true, subtree: true });
  scan(document);
}
