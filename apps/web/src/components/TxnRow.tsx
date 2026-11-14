import { money } from '../lib';
import { useUi } from '../App';
import { tint } from './Icons';

/** One transaction in a list. Expenses show plain; income and incoming money show green with +. */
export function TxnRow({ t }: { t: any }) {
  const { openTxn } = useUi();
  const ps: any[] = t.postings ?? [];
  const cats = ps.filter((p) => p.kind === 'category');
  const moneyOut = ps.find((p) => p.kind !== 'category' && p.amount < 0);
  const moneyIn = ps.find((p) => p.kind !== 'category' && p.amount > 0);
  const icon = cats[0]?.icon ?? (t.kind === 'transfer' ? '⇄' : '•');
  let sub = '';
  if (t.kind === 'transfer') sub = `${moneyOut?.name ?? '?'} → ${moneyIn?.name ?? '?'}`;
  else if (t.kind === 'split') sub = `Split · ${moneyOut?.name ?? ''}`;
  else sub = [cats.map((c) => c.name).join(', '), (t.kind === 'income' || t.kind === 'refund' ? moneyIn : moneyOut)?.name].filter(Boolean).join(' · ');
  const incoming = t.kind === 'income' || t.kind === 'refund';
  const title = t.merchant ?? t.description ?? (t.kind === 'transfer' ? 'Transfer' : cats[0]?.name ?? 'Transaction');
  return (
    <button className={`item ${t.status === 'void' ? 'void' : ''}`} onClick={() => openTxn(t.id)}>
      <div className="avatar" style={tint(icon)} aria-hidden>{icon}</div>
      <div className="grow">
        <div className="title">{title}</div>
        <div className="sub">{sub}{t.source !== 'manual' ? ` · ${t.source}` : ''}</div>
      </div>
      <div className={`amt num ${incoming ? 'pos' : ''}`}>
        {incoming ? '+' : ''}{money(t.amount)}
      </div>
    </button>
  );
}
