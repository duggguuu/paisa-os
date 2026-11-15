import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles.css';
import './themes.css';
import { initTheme } from './theme';
import { App } from './App';

initTheme();

// Service worker: only for notifications (no caching). Registering it is harmless where push isn't supported.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { /* not available (e.g. private mode) */ });

const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: (n, e: any) => e?.status !== 401 && n < 2, refetchOnWindowFocus: true } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
