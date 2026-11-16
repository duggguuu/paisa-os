import { money } from '../lib';
import { useUi } from '../App';
import { tint } from './Icons';
import { SwipeTxn } from './Swipe';

/** One transaction in a list. Expenses show plain; income and incoming money show green with +. */
export function TxnRow({ t }: { t: any }) {
  const { openTxn } = useUi();
  const ps: any[] = t.postings ?? [];
  const cats = ps.filter((p) => p.kind === 'category');
  const moneyOut = ps.find((p) => p.kind !== 'category' && p.amount < 0);
  const moneyIn = ps.find((p) => p.kind !== 'category' && p.amount > 0);
  const icon = cats[0]?.icon ?? (t.kind === 'transfer' ? '⇄' : '•');
  // Direction comes from the money account when we have it, so a negative expense (money back)
  // shows as incoming and a negative income (taken back) as outgoing.
  const known = (t.kind === 'expense' || t.kind === 'income') && (moneyIn || moneyOut);
  const incoming = known ? !!moneyIn : t.kind === 'income' || t.kind === 'refund';
  const reversed = known && (t.kind === 'expense') === incoming;
  let sub = '';
  if (t.kind === 'transfer') sub = `${moneyOut?.name ?? '?'} → ${moneyIn?.name ?? '?'}`;
  else if (t.kind === 'split') sub = `Split · ${moneyOut?.name ?? ''}`;
  else sub = [cats.map((c) => c.name).join(', '), (incoming ? moneyIn : moneyOut)?.name].filter(Boolean).join(' · ');
  const title = t.merchant ?? t.description ?? (t.kind === 'transfer' ? 'Transfer' : cats[0]?.name ?? 'Transaction');
  return (
    <SwipeTxn t={t}>
    <button className={`item ${t.status === 'void' ? 'void' : ''}`} onClick={() => openTxn(t.id)}>
      <div className="avatar" style={tint(icon)} aria-hidden>{icon}</div>
      <div className="grow">
        <div className="title">{title}</div>
        <div className="sub">{sub}{t.source !== 'manual' ? ` · ${t.source}` : ''}</div>
      </div>
      <div className={`amt num ${incoming ? 'pos' : ''}`}>
        {incoming ? '+' : reversed ? '−' : ''}{money(t.amount)}
      </div>
    </button>
    </SwipeTxn>
  );
}
