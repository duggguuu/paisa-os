import { Fragment, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, maskText } from '../lib';
import { Icon } from '../components/Icons';
import { listen, speechSupported } from '../voice';

interface Msg { role: 'user' | 'assistant'; content: string; engine?: 'claude' | 'local' }

const SUGGESTIONS = [
  'Can I afford a ₹60,000 laptop?',
  'How can I save more each month?',
  'Why did my spending increase?',
  'When will I reach my savings goal?',
];
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
      const r = await api<{ answer: string; engine: 'claude' | 'local' }>('/api/copilot', { method: 'POST', body: { question, history } });
      setMsgs((m) => [...m, { role: 'assistant', content: r.answer, engine: r.engine }]);
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
          <div className="suggest">{SUGGESTIONS.map((s) => <button key={s} onClick={() => ask(s)}>{s}</button>)}</div>
        </>
      )}

      <div className="chat" aria-live="polite">
        {msgs.map((m, i) => (
          <div key={i} className={`bubble-msg ${m.role === 'user' ? 'me' : 'ai'}`}>
            <Rich text={m.role === 'assistant' ? maskText(m.content) : m.content} />
            {m.role === 'assistant' && m.engine && <span className="eng">{m.engine === 'claude' ? 'Answered by Claude' : 'Worked out from your data on your server'}</span>}
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
            ? 'Uses Claude: a summary of your numbers (totals, categories, goals) is sent to Anthropic to answer.'
            : 'Private mode: answers are worked out on your server and nothing is sent to an AI service.'}
        </p>
      )}
    </div>
  );
}
