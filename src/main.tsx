import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initSentry, Sentry } from './lib/sentry';
import App from './App.tsx';
import './index.css';

// Initialize error tracking (no-op if VITE_SENTRY_DSN not set)
initSentry();

// Global safety net — catches unhandled promise rejections that escape React
// (e.g. fire-and-forget async calls, third-party libs, service worker errors)
window.addEventListener('unhandledrejection', (event) => {
  const error = event.reason instanceof Error
    ? event.reason
    : new Error(String(event.reason));
  Sentry.captureException(error, { tags: { mechanism: 'unhandledrejection' } });
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
