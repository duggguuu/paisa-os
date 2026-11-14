/**
 * Small motion helpers (no animation library):
 *  - useSize: an element's real pixel width, so charts draw at their true size instead of
 *    stretching a fixed viewBox (which blew text and dots up on wide screens).
 *  - useCountUp: numbers that roll up to their value.
 *  - useAppear: false on the first frame, true right after, to drive CSS transitions.
 * Everything respects "reduce motion".
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function useSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => setSize((s) => (s.width === el.clientWidth && s.height === el.clientHeight ? s : { width: el.clientWidth, height: el.clientHeight }));
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/** Animate from the previous value to `value` over `ms`. */
export function useCountUp(value: number, ms = 750) {
  const [shown, setShown] = useState(reducedMotion() ? value : 0);
  const from = useRef(reducedMotion() ? value : 0);
  useEffect(() => {
    if (reducedMotion()) { setShown(value); from.current = value; return; }
    const start = performance.now(), a = from.current, b = value;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const v = a + (b - a) * easeOut(t);
      setShown(v);
      from.current = v;
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return shown;
}

/** True one frame after mount (or after `key` changes), so transitions play from their start state. */
export function useAppear(key?: unknown) {
  const [on, setOn] = useState(reducedMotion());
  useEffect(() => {
    if (reducedMotion()) return;
    setOn(false);
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setOn(true)));
    return () => cancelAnimationFrame(raf);
  }, [key]);
  return on;
}
