import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, Route, Routes, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { installViewTransitions } from './motion-fx';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, getBook, setBook } from './lib';
import { Login } from './pages/Login';
import { Home } from './pages/Home';
import { Activity } from './pages/Activity';
import { Accounts } from './pages/Accounts';
import { Stats } from './pages/Stats';
import { Settings } from './pages/Settings';
import { Recurring } from './pages/Recurring';
import { Insights } from './pages/Insights';
import { Import } from './pages/Import';
import { Splitwise } from './pages/Splitwise';
import { Goals } from './pages/Goals';
import { Copilot } from './pages/Copilot';
import { Budgets } from './pages/Budgets';
import { QuickAdd, type QuickAddPreset } from './components/QuickAdd';
import { TxnDetail } from './components/TxnDetail';
import { Icon } from './components/Icons';
import { LockScreen } from './components/Security';
import { More } from './pages/More';
import { Stuff } from './pages/Stuff';
import { Debts } from './pages/Debts';
import { Fds } from './pages/Fds';
import { Salary } from './pages/Salary';
import { Categories } from './pages/Categories';
import { Mandates } from './pages/Mandates';
import { PrivacyToggle, usePrivacy } from './components/PrivacyToggle';
import { isPrivate, setPrivate } from './lib';

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
  const qc = useQueryClient();
  // staleTime 0: re-checked whenever the app comes back to the foreground, so the lock shows straight away.
  const status = useQuery({ queryKey: ['auth'], queryFn: () => api('/api/auth/status'), staleTime: 0 });
  useEffect(() => {
    const locked = () => qc.invalidateQueries({ queryKey: ['auth'] });
    window.addEventListener('paisa:locked', locked);
    return () => window.removeEventListener('paisa:locked', locked);
  }, [qc]);
  // Hide the splash (index.html) once we know where to go; keep it up at least briefly so it doesn't flash.
  useEffect(() => {
    if (status.isLoading) return;
    const el = document.getElementById('splash');
    if (!el) return;
    const shownFor = performance.now();
    const t = setTimeout(() => { el.classList.add('done'); setTimeout(() => el.remove(), 400); }, Math.max(0, 700 - shownFor));
    return () => clearTimeout(t);
  }, [status.isLoading]);
  if (status.isLoading) return null;
  if (status.isError) return <div className="main"><p className="error">Can't reach the server. Check your connection and reload.</p></div>;
  if (!status.data.user) return <Login setupNeeded={status.data.setupNeeded} passkeyLogin={status.data.passkeyLogin} />;
  if (status.data.user.locked) return <LockScreen email={status.data.user.email} />;
  return <Shell />;
}

function Shell() {
  const loc = useLocation();
  // Privacy mode: re-render everything when amounts are hidden or shown (money() reads the flag).
  usePrivacy();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.shiftKey && !e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'h' && !/input|textarea|select/i.test(t.tagName) && !t.isContentEditable) setPrivate(!isPrivate());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const qc = useQueryClient();
  const navigate = useNavigate();
  // Page morph: in-app links change pages inside a View Transition (cards morph into the new title).
  useEffect(() => installViewTransitions((to) => navigate(to)), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [add, setAdd] = useState<QuickAddPreset | null>(null);
  // A daily reminder opens the app with ?add=1: go straight to "Add transaction".
  useEffect(() => {
    const p = new URLSearchParams(loc.search);
    if (p.get('add') === '1' && loc.pathname === '/') { setAdd({}); navigate('/', { replace: true }); }
  }, [loc.search, loc.pathname]); // eslint-disable-line react-hooks/exhaustive-deps
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
    ['/activity', 'Trans.', 'book'],
    ['/stats', 'Stats', 'stats'],
    ['/accounts', 'Accounts', 'accounts'],
    ['/more', 'More', 'more'],
  ];

  return (
    <UiCtx.Provider value={ui}>
      <div className="app">
        <nav className="sidebar" aria-label="Main">
          <div className="brand"><img src="/logo-mark.png" alt="" className="logo-img" />Paisa OS</div>
          <PrivacyToggle className="nav-privacy" label />
          {links.filter(([to]) => to !== '/more').map(([to, label, icon]) => (
            <NavLink key={to} to={to} end={to === '/'}><Icon name={icon} />{label}</NavLink>
          ))}
          <NavLink to="/goals"><Icon name="target" />Goals</NavLink>
          <NavLink to="/stuff"><Icon name="wallet" />Stuff</NavLink>
          <NavLink to="/salary"><Icon name="wallet" />Salary &amp; tax</NavLink>
          <NavLink to="/debts"><Icon name="users" />Owe &amp; owed</NavLink>
          <NavLink to="/fds"><Icon name="wallet" />FDs</NavLink>
          <div className="nav-group">Plan</div>
          <NavLink to="/copilot"><Icon name="sparkle" />AI Copilot</NavLink>
          <NavLink to="/budgets"><Icon name="pie" />Budget Planner</NavLink>
          <NavLink to="/recurring"><Icon name="repeat" />Bills &amp; recurring</NavLink>
          <NavLink to="/mandates"><Icon name="repeat" />Mandates &amp; subs</NavLink>
          <NavLink to="/insights"><Icon name="spark" />Insights</NavLink>
          <div className="nav-group">Tools</div>
          <NavLink to="/import"><Icon name="upload" />Import</NavLink>
          <NavLink to="/splitwise"><Icon name="users" />Splitwise</NavLink>
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
          <div className="page-anim" key={loc.pathname}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/activity" element={<Activity />} />
            <Route path="/stats" element={<Stats />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/recurring" element={<Recurring />} />
            <Route path="/insights" element={<Insights />} />
            <Route path="/import" element={<Import />} />
            <Route path="/splitwise" element={<Splitwise />} />
            <Route path="/goals" element={<Goals />} />
            <Route path="/copilot" element={<Copilot />} />
            <Route path="/budgets" element={<Budgets />} />
            <Route path="/more" element={<More />} />
            <Route path="/stuff" element={<Stuff />} />
            <Route path="/debts" element={<Debts />} />
            <Route path="/fds" element={<Fds />} />
            <Route path="/salary" element={<Salary />} />
            <Route path="/categories" element={<Categories />} />
            <Route path="/mandates" element={<Mandates />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </div>
        </main>
        {loc.pathname !== '/' && <PrivacyToggle className="privacy-float" />}
        <button className="fab-float" aria-label="Add transaction" title="Add transaction" onClick={() => setAdd({})}><Icon name="plus" /></button>
        <nav className="tabbar" aria-label="Main">
          {links.map(([to, label, icon]) => (
            <NavLink key={to} to={to} end={to === '/'}><Icon name={icon} /><span>{label}</span></NavLink>
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
