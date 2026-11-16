import { flipSign } from '../lib';

/**
 * The ± key next to an amount. Phone number pads (inputMode="decimal") have no minus key,
 * so this flips the sign of the typed amount. Pressing it keeps focus on the amount.
 */
export function SignToggle({ value, onChange, label = 'Make negative' }: { value: string; onChange: (v: string) => void; label?: string }) {
  const neg = /^\s*[-−]/.test(value);
  return (
    <button type="button" className={`sign-toggle ${neg ? 'on' : ''}`} aria-pressed={neg} aria-label={neg ? 'Make positive' : label}
      title={neg ? 'Make positive' : label}
      onMouseDown={(e) => e.preventDefault()} onClick={() => onChange(flipSign(value))}>
      {neg ? '−' : '±'}
    </button>
  );
}
