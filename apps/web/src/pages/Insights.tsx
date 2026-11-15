import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, maskText } from '../lib';
import { RuleSheet } from './Recurring';

export interface Insight {
  id: string; tone: 'good' | 'warn' | 'info'; icon: string; title: string; body: string;
  action?: { label: string; to?: string; recurring?: Record<string, unknown> };
}

export function InsightCard({ i, onRecurring }: { i: Insight; onRecurring: (r: Record<string, unknown>) => void }) {
  const navigate = useNavigate();
  return (
    <div className={`insight ${i.tone}`}>
      <div className="ins-icon" aria-hidden>{i.icon}</div>
      <div className="grow">
        <div className="ins-title">{maskText(i.title)}</div>
        <div className="small muted">{maskText(i.body)}</div>
        {i.action && (
          <button className="ins-action" onClick={() => (i.action!.recurring ? onRecurring(i.action!.recurring) : navigate(i.action!.to!))}>
            {maskText(i.action.label)} ›
          </button>
        )}
      </div>
    </div>
  );
}

export function Insights() {
  const q = useQuery({ queryKey: ['insights'], queryFn: () => api<Insight[]>('/api/insights') });
  const [rule, setRule] = useState<Record<string, unknown> | null>(null);
  return (
    <>
      <h1 className="page-title">Insights</h1>
      <p className="small muted" style={{ marginTop: -8 }}>Patterns in your own numbers, recalculated every time you open this. Worked out on your server; nothing is sent to an AI service.</p>
      {!q.data ? <div className="card"><div className="skeleton" /></div> : q.data.length === 0 ? (
        <div className="card empty-state"><div style={{ fontSize: 34 }}>✨</div><b>Nothing stands out right now</b>
          <p className="small muted">Insights appear as you log a few weeks of spending: pace vs your usual month, budgets running out, subscriptions, people who owe you and more.</p></div>
      ) : (
        <div className="insights">{q.data.map((i) => <InsightCard key={i.id} i={i} onRecurring={setRule} />)}</div>
      )}
      {rule && <RuleSheet initial={rule} onClose={() => setRule(null)} />}
    </>
  );
}
