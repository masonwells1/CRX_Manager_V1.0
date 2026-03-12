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
    onRegistered(r) {
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
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-xl border border-crx-green/30 bg-white px-4 py-3 shadow-lg max-w-sm w-full mx-4"
    >
      <RefreshCw className="w-4 h-4 text-crx-green flex-shrink-0" />
      <span className="flex-1 text-sm text-nav-dark">
        A new version of the app is ready.
      </span>
      <button
        onClick={() => updateServiceWorker(true)}
        className="text-sm font-semibold text-crx-green hover:underline flex-shrink-0"
      >
        Update Now
      </button>
      <button
        onClick={() => setVisible(false)}
        aria-label="Dismiss"
        className="text-gray-400 hover:text-gray-600"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
