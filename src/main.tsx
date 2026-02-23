import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initSentry } from './lib/sentry';
import App from './App.tsx';
import './index.css';

// Initialize error tracking (no-op if VITE_SENTRY_DSN not set)
initSentry();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
