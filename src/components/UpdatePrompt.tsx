/**
 * UpdatePrompt — Shows a dismissible banner when a new app version is ready.
 *
 * Previously the PWA used registerType: 'autoUpdate' which silently forced
 * a full page reload when the service worker updated — wiping any form data
 * the user had typed (especially on mobile after switching apps).
 *
 * Now we use registerType: 'prompt': the service worker waits patiently until
 * the user taps "Update Now", so form data is never lost unexpectedly.
 */
import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { RefreshCw, X } from 'lucide-react';

export default function UpdatePrompt() {
  const [visible, setVisible] = useState(false);

  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegistered(r: ServiceWorkerRegistration | undefined) {
      // Periodically check for updates (every 60 minutes)
      if (r) {
        setInterval(() => r.update(), 60 * 60 * 1000);
      }
    },
  });

  useEffect(() => {
    if (needRefresh) setVisible(true);
  }, [needRefresh]);

  if (!visible) return null;

  return (
    <div
      role="alert"
      data-testid="update-prompt"
      className="fixed inset-x-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom)+0.75rem)] z-40 flex items-center gap-3 rounded-xl border border-crx-green/30 bg-white px-4 py-3 shadow-xl ring-1 ring-crx-green/10 md:inset-x-auto md:bottom-4 md:left-1/2 md:w-full md:max-w-sm md:-translate-x-1/2 md:shadow-lg"
    >
      <RefreshCw className="w-4 h-4 text-crx-green flex-shrink-0" />
      <span className="min-w-0 flex-1 text-sm text-nav-dark">
        A new version of the app is ready.
      </span>
      <button
        type="button"
        onClick={() => updateServiceWorker(true)}
        className="min-h-11 flex-shrink-0 rounded-lg bg-crx-green px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-crx-green-hover focus:outline-none focus:ring-2 focus:ring-crx-green focus:ring-offset-2"
      >
        Update now
      </button>
      <button
        type="button"
        onClick={() => setVisible(false)}
        aria-label="Dismiss"
        className="min-h-11 min-w-11 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-crx-green focus:ring-offset-2"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
