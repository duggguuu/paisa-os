/** Small stroke icon set (24px grid, currentColor). */
const P: Record<string, string> = {
  home: 'M3.5 10.5 12 4l8.5 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-4v-6h-6v6H5A1.5 1.5 0 0 1 3.5 19z',
  activity: 'M4 6.5h16M4 12h16M4 17.5h10',
  stats: 'M4 20V10M10 20V4M16 20v-7M21 20H3',
  accounts: 'M3.5 8.5 12 4l8.5 4.5M5 10v7M9.5 10v7M14.5 10v7M19 10v7M3.5 20h17',
  settings: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4ZM19.4 13.5l1.6 1.2-1.8 3.1-1.9-.7a7 7 0 0 1-1.9 1.1l-.3 2h-3.6l-.3-2a7 7 0 0 1-1.9-1.1l-1.9.7-1.8-3.1 1.6-1.2a7 7 0 0 1 0-3l-1.6-1.2 1.8-3.1 1.9.7a7 7 0 0 1 1.9-1.1l.3-2h3.6l.3 2a7 7 0 0 1 1.9 1.1l1.9-.7 1.8 3.1-1.6 1.2a7 7 0 0 1 0 3Z',
  plus: 'M12 5v14M5 12h14',
  mic: 'M12 3.5a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0v-5a3 3 0 0 0-3-3ZM6 11a6 6 0 0 0 12 0M12 17v3.5M9 20.5h6',
  stop: 'M8 8h8v8H8z',
  out: 'M7 17 17 7M9 7h8v8',
  in: 'M17 7 7 17M15 17H7V9',
};

export function Icon({ name, className = 'i' }: { name: keyof typeof P | string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === 'plus' ? 2.2 : 1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name]} />
    </svg>
  );
}

/** Stable pastel hue per label, so "Food" is always the same colour. */
export function tint(seed: string | null | undefined): React.CSSProperties {
  let h = 0;
  for (const ch of seed ?? '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { ['--h' as any]: h % 360 };
}
