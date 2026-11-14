import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { NavLink, Route, Routes, Navigate, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, getBook, setBook } from './lib';
import { Login } from './pages/Login';
import { Home } from './pages/Home';
import { Activity } from './pages/Activity';
import { Accounts } from './pages/Accounts';
import { Stats } from './pages/Stats';
import { Settings } from './pages/Settings';
import { QuickAdd, type QuickAddPreset } from './components/QuickAdd';
import { TxnDetail } from './components/TxnDetail';
import { Icon } from './components/Icons';

interface Ui {
  openAdd: (preset?: QuickAddPreset) => void;
  openTxn: (id: string) => void;
  toast: (msg: string, action?: { label: string; run: () => void }) => void;
  book: 'real' | 'demo';
  switchBook: (b: 'real' | 'demo') => void;
}
const UiCtx = createContext<Ui>(null as any);
export const useUi = () => useContext(UiCtx);

export function App() {
  const status = useQuery({ queryKey: ['auth'], queryFn: () => api('/api/auth/status') });
  if (status.isLoading) return <div className="main"><div className="skeleton" style={{ width: 120, marginTop: 40 }} /></div>;
  if (status.isError) return <div className="main"><p className="error">Can't reach the server. Check your connection and reload.</p></div>;
  if (!status.data.user) return <Login setupNeeded={status.data.setupNeeded} />;
  return <Shell />;
}

function Shell() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [add, setAdd] = useState<QuickAddPreset | null>(null);
  const [txn, setTxn] = useState<string | null>(null);
  const [toastState, setToast] = useState<{ msg: string; action?: { label: string; run: () => void }; id: number } | null>(null);
  const [book, setBookState] = useState(getBook());

  const toast = useCallback((msg: string, action?: { label: string; run: () => void }) => {
    const id = Date.now();
    setToast({ msg, action, id });
    setTimeout(() => setToast((t) => (t?.id === id ? null : t)), action ? 10_000 : 3_500);
  }, []);
  const switchBook = useCallback((b: 'real' | 'demo') => {
    setBook(b);
    setBookState(b);
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
    navigate('/');
  }, [qc, navigate]);

  const ui = useMemo<Ui>(() => ({ openAdd: (p) => setAdd(p ?? {}), openTxn: setTxn, toast, book, switchBook }), [toast, book, switchBook]);

  const links: [string, string, string][] = [
    ['/', 'Home', 'home'],
    ['/activity', 'Activity', 'activity'],
    ['/stats', 'Stats', 'stats'],
    ['/accounts', 'Accounts', 'accounts'],
  ];

  return (
    <UiCtx.Provider value={ui}>
      <div className="app">
        <nav className="sidebar" aria-label="Main">
          <div className="brand"><span className="brand-mark" aria-hidden>₹</span>Paisa OS</div>
          {links.map(([to, label, icon]) => (
            <NavLink key={to} to={to} end={to === '/'}><Icon name={icon} />{label}</NavLink>
          ))}
          <NavLink to="/settings"><Icon name="settings" />Settings</NavLink>
          <button className="btn accent add" onClick={() => setAdd({})}><Icon name="plus" />Add transaction</button>
          <div className="foot">{book === 'demo' ? 'Viewing sample data' : 'Your private ledger'}</div>
        </nav>
        <main className="main">
          {book === 'demo' && (
            <div className="banner warn">
              <span>You're viewing <b>sample data</b>. Nothing here is real.</span>
              <button onClick={() => switchBook('real')}>Back to my money</button>
            </div>
          )}
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/activity" element={<Activity />} />
            <Route path="/stats" element={<Stats />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <nav className="bottom-nav" aria-label="Main">
          {links.slice(0, 2).map(([to, label, icon]) => (
            <NavLink key={to} to={to} end={to === '/'}><Icon name={icon} />{label}</NavLink>
          ))}
          <button className="fab" aria-label="Add transaction" onClick={() => setAdd({})}><Icon name="plus" /></button>
          {links.slice(2).map(([to, label, icon]) => (
            <NavLink key={to} to={to}><Icon name={icon} />{label}</NavLink>
          ))}
        </nav>
      </div>
      {add && <QuickAdd preset={add} onClose={() => setAdd(null)} />}
      {txn && <TxnDetail id={txn} onClose={() => setTxn(null)} />}
      {toastState && (
        <div className="toast" role="status">
          <span>{toastState.msg}</span>
          {toastState.action && <button onClick={() => { toastState.action!.run(); setToast(null); }}>{toastState.action.label}</button>}
        </div>
      )}
    </UiCtx.Provider>
  );
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
        <div className="grab" />
        <div className="spread"><h2>{title}</h2><button className="btn small" onClick={onClose} aria-label="Close">Close</button></div>
        {children}
      </div>
    </>
  );
}
