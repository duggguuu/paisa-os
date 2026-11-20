/**
 * The mindset behind a spend. Optional, one per expense. Keep the ids in step with MOODS in
 * apps/api/src/ledger.ts (the database only checks the shape, so adding one needs no migration).
 */
export type MoodGroup = 'need' | 'want' | 'moment';
export type Mood = { id: string; emoji: string; label: string; hint: string; group: MoodGroup };

export const MOOD_GROUPS: { id: MoodGroup; label: string; hint: string }[] = [
  { id: 'need', label: 'Needed it', hint: 'Things life runs on' },
  { id: 'want', label: 'Chose it', hint: 'Wants you picked on purpose' },
  { id: 'moment', label: 'In the moment', hint: 'Spends worth a second look' },
];

export const MOODS: Mood[] = [
  { id: 'essential', emoji: '🧾', label: 'Essential', hint: 'Had to: rent, bills, groceries, medicine', group: 'need' },
  { id: 'daily', emoji: '☀️', label: 'Daily', hint: 'Routine, everyday spending', group: 'need' },
  { id: 'planned', emoji: '🗓️', label: 'Planned', hint: 'Thought through or saved up for', group: 'need' },
  { id: 'growth', emoji: '🌱', label: 'Growth', hint: 'Learning, health, things that make you better', group: 'want' },
  { id: 'social', emoji: '🥂', label: 'Social', hint: 'Time with friends and family', group: 'want' },
  { id: 'gift', emoji: '🎁', label: 'Giving', hint: 'For someone else', group: 'want' },
  { id: 'treat', emoji: '🍰', label: 'Treat', hint: 'A small, earned reward', group: 'want' },
  { id: 'splurge', emoji: '🎉', label: 'Splurge', hint: 'Spent big on a want, knowingly', group: 'want' },
  { id: 'luxury', emoji: '💎', label: 'Luxury', hint: 'Paid for the premium version', group: 'want' },
  { id: 'impulse', emoji: '⚡', label: 'Impulse', hint: "Didn't plan it, just bought it", group: 'moment' },
  { id: 'convenience', emoji: '🛵', label: 'Convenience', hint: 'Paid extra to save effort: delivery, cabs', group: 'moment' },
  { id: 'comfort', emoji: '🫂', label: 'Comfort', hint: 'Stressed, low or tired spending', group: 'moment' },
  { id: 'bored', emoji: '🥱', label: 'Bored', hint: 'Scrolling and killing time', group: 'moment' },
  { id: 'fomo', emoji: '👀', label: 'FOMO', hint: 'A sale, hype, or everyone else had it', group: 'moment' },
];

export const moodById = (id: string | null | undefined) => (id ? MOODS.find((m) => m.id === id) ?? null : null);

/** How money left a bank account. */
export const PAY_METHODS = [
  { id: 'upi', label: 'UPI', icon: '📲' },
  { id: 'debit_card', label: 'Debit Card', icon: '💳' },
  { id: 'netbanking', label: 'Net Banking', icon: '🏦' },
] as const;
export type PayMethod = (typeof PAY_METHODS)[number]['id'];
export const payMethodLabel = (id: string | null | undefined) => PAY_METHODS.find((m) => m.id === id)?.label ?? null;

/** Words in a spoken/typed sentence that say how you paid ("…via UPI", "on my debit card"). */
export function payMethodFromText(text: string): PayMethod | null {
  const t = text.toLowerCase();
  if (/\b(upi|gpay|google pay|phonepe|paytm|bhim)\b/.test(t)) return 'upi';
  if (/\bdebit\s*card\b|\bswiped?\b/.test(t)) return 'debit_card';
  if (/\bnet\s*-?\s*banking\b|\bneft\b|\bimps\b|\brtgs\b/.test(t)) return 'netbanking';
  return null;
}

/** Mood words in a sentence ("impulse buy", "splurged on…"). */
export function moodFromText(text: string): string | null {
  const t = text.toLowerCase();
  const hits: [RegExp, string][] = [
    [/\bimpulse\b/, 'impulse'], [/\bsplurg/, 'splurge'], [/\bluxury\b/, 'luxury'], [/\btreat(ed)? (my|our)sel/, 'treat'],
    [/\bfomo\b/, 'fomo'], [/\bbored\b/, 'bored'], [/\bessential\b/, 'essential'], [/\bgift\b/, 'gift'],
  ];
  return hits.find(([r]) => r.test(t))?.[1] ?? null;
}
