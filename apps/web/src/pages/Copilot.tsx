import { Fragment, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, maskText, money, shortDate } from '../lib';
import { useUi } from '../App';
import { Icon } from '../components/Icons';
import { listen, speechSupported } from '../voice';

interface Draft { kind: 'expense' | 'income'; amount: number; categoryId: string; categoryName: string; accountId: string; accountName: string; date: string; merchant: string | null; note: string | null }
interface Msg { role: 'user' | 'assistant'; content: string; engine?: 'claude' | 'local'; drafts?: Draft[]; looked?: string[] }

const LOOKED: Record<string, string> = {
  find_transactions: 'transactions', spending_breakdown: 'spending', accounts: 'balances', investments: 'investments & FDs',
  debts_and_loans: 'loans & debts', bills_and_subscriptions: 'bills & subscriptions', salary_and_tax: 'salary', goals: 'goals', draft_transaction: 'a draft',
};

const SUGGESTIONS = [
  'Can I afford a ₹60,000 laptop?',
  'Compare my spending this month with the last 3 months',
  'Which subscriptions renew in the next 2 weeks?',
  'How are my investments and FDs doing?',
  'If I prepay ₹1 lakh on my loan, what do I save?',
  'Add ₹450 for groceries yesterday',
];
const SUGGESTIONS_LOCAL = SUGGESTIONS.slice(0, 1).concat(['How can I save more each month?', 'Why did my spending increase?', 'When will I reach my savings goal?']);
const KEY = 'paisa.copilot';

/** Render the small subset of formatting the copilot uses: **bold** and "• " lists. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
        part.startsWith('**') && part.endsWith('**') ? <b key={i}>{part.slice(2, -2)}</b> : <Fragment key={i}>{part}</Fragment>)}
    </>
  );
}

export function Copilot() {
  const { openAdd } = useUi();
  const info = useQuery({ queryKey: ['copilot'], queryFn: () => api<{ engine: 'claude' | 'local' }>('/api/copilot') });
  const [msgs, setMsgs] = useState<Msg[]>(() => {
    try { return JSON.parse(sessionStorage.getItem(KEY) ?? '[]'); } catch { return []; }
  });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    try { sessionStorage.setItem(KEY, JSON.stringify(msgs.slice(-30))); } catch { /* ignore */ }
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [msgs, busy]);

  async function ask(q: string) {
    const question = q.trim();
    if (!question || busy) return;
    setText('');
    const history = msgs.slice(-8).map(({ role, content }) => ({ role, content }));
    setMsgs((m) => [...m, { role: 'user', content: question }]);
    setBusy(true);
    try {
      const r = await api<{ answer: string; engine: 'claude' | 'local'; drafts?: Draft[]; looked?: string[] }>('/api/copilot', { method: 'POST', body: { question, history } });
      setMsgs((m) => [...m, { role: 'assistant', content: r.answer, engine: r.engine, drafts: r.drafts, looked: [...new Set(r.looked ?? [])] }]);
    } catch (e: any) {
      setMsgs((m) => [...m, { role: 'assistant', content: `Sorry, I couldn't answer that: ${e.message}` }]);
    } finally { setBusy(false); }
  }

  async function mic() {
    if (listening) { stopRef.current?.(); return; }
    try {
      const l = listen((t) => setText(t));
      stopRef.current = l.stop; setListening(true);
      const t = await l.done;
      if (t.trim()) ask(t);
    } catch (e: any) {
      setMsgs((m) => [...m, { role: 'assistant', content: e.message }]);
    } finally { setListening(false); stopRef.current = null; }
  }

  return (
    <div className="copilot">
      <div className="page-head">
        <h1 className="page-title">AI Financial Copilot</h1>
        {msgs.length > 0 && <button className="btn small" onClick={() => setMsgs([])}>New chat</button>}
      </div>

      {msgs.length === 0 && (
        <>
          <div className="copilot-hero">
            <div className={`orb ${busy ? 'thinking' : ''}`} aria-hidden />
            <h2>Ask Anything About Your Money</h2>
            <p>Get instant answers, personalised advice and smart recommendations from your own numbers.</p>
          </div>
          <div className="suggest">{(info.data?.engine === 'local' ? SUGGESTIONS_LOCAL : SUGGESTIONS).map((s) => <button key={s} onClick={() => ask(s)}>{s}</button>)}</div>
        </>
      )}

      <div className="chat" aria-live="polite">
        {msgs.map((m, i) => (
          <div key={i} className={`bubble-msg ${m.role === 'user' ? 'me' : 'ai'}`}>
            <Rich text={m.role === 'assistant' ? maskText(m.content) : m.content} />
            {m.drafts?.map((d, k) => (
              <div key={k} className="draft-card">
                <div className="grow">
                  <div className="title">{d.merchant ?? d.categoryName} <span className={`num ${d.kind === 'income' ? 'pos' : ''}`}>{d.kind === 'income' ? '+' : ''}{money(d.amount)}</span></div>
                  <div className="sub">{d.categoryName} · {d.accountName} · {shortDate(d.date)}{d.note ? ` · ${d.note}` : ''}</div>
                </div>
                <button className="btn small accent" onClick={() => openAdd({ draft: d })}>Review &amp; add</button>
              </div>
            ))}
            {m.role === 'assistant' && m.engine && <span className="eng">{m.engine === 'claude' ? `Answered by Claude${m.looked?.length ? ` · checked ${m.looked.map((l) => LOOKED[l] ?? l).join(', ')}` : ''}` : 'Worked out from your data on your server'}</span>}
          </div>
        ))}
        {busy && <div className="bubble-msg ai"><span className="faint">Thinking…</span></div>}
        <div ref={endRef} />
      </div>

      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); ask(text); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={listening ? 'Listening…' : 'Type your question…'} aria-label="Your question" enterKeyHint="send" />
        {speechSupported() && <button type="button" className={`mic-b ${listening ? 'on' : ''}`} onClick={mic} aria-label={listening ? 'Stop' : 'Ask by voice'}><Icon name={listening ? 'stop' : 'mic'} /></button>}
        <button className="send" aria-label="Send" disabled={busy}><Icon name="send" /></button>
      </form>
      {info.data && msgs.length === 0 && (
        <p className="tiny faint" style={{ textAlign: 'center', margin: '10px 0 0' }}>
          {info.data.engine === 'claude'
            ? 'Uses Claude: a summary of your numbers, plus whatever it looks up to answer (transactions, balances, holdings…), is sent to Anthropic. Nothing is saved without you.'
            : 'Private mode: answers are worked out on your server and nothing is sent to an AI service. Add an Anthropic API key on the server for the smarter Copilot.'}
        </p>
      )}
    </div>
  );
}
