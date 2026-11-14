import { money } from '../lib';
import { useCountUp } from '../motion';

/** A rupee amount that rolls up to its value (and to each new value). */
export function RollingMoney({ value }: { value: number }) {
  return <>{money(Math.round(useCountUp(value, 900)), { whole: true })}</>;
}
