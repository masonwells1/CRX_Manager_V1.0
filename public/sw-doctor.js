/**
 * Service Worker Doctor — Self-healing for stale PWA caches.
 *
 * Problem: Safari iOS is aggressive about serving cached service worker
 * content. After a new deploy, Safari may still serve the OLD index.html
 * that references OLD JS filenames (with different hashes). Those files
 * no longer exist on the server -> JS never loads -> white screen.
 *
 * Solution: This script checks if the React app mounted within 10 seconds.
 * If not, it unregisters the SW, clears all caches, and reloads.
 * A retry counter in sessionStorage prevents infinite reload loops.
 */
(function () {
  'use strict';

  var MAX_RETRIES = 2;
  var TIMEOUT_MS = 10000;
  var STORAGE_KEY = 'crx_sw_fix_count';

  // Skip if no service worker support (nothing to fix)
  if (!('serviceWorker' in navigator)) return;

  var timer = setTimeout(function () {
    // Check if React has mounted — the loading spinner has class "crx-loading"
    // React replaces root's children when it mounts, removing the spinner
    var spinner = document.querySelector('#root > .crx-loading');
    if (!spinner) return; // App loaded fine

    // App didn't load — attempt self-healing
    var retries = parseInt(sessionStorage.getItem(STORAGE_KEY) || '0', 10);

    if (retries >= MAX_RETRIES) {
      // Already retried twice — show error message instead of infinite loop
      var msg = document.createElement('p');
      msg.textContent = 'Unable to load the app. Please clear your browser data for this site and try again.';
      msg.style.cssText = 'color:#333;font-size:16px;max-width:300px;line-height:1.5;text-align:center';
      spinner.textContent = '';
      spinner.appendChild(msg);
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }

    // Increment retry counter
    sessionStorage.setItem(STORAGE_KEY, String(retries + 1));

    // Unregister all service workers
    navigator.serviceWorker.getRegistrations().then(function (registrations) {
      registrations.forEach(function (reg) {
        reg.unregister();
      });
    });

    // Clear all caches
    if ('caches' in window) {
      caches.keys().then(function (keys) {
        keys.forEach(function (name) {
          caches.delete(name);
        });
      });
    }

    // Reload after a brief delay to let cleanup finish
    setTimeout(function () {
      location.reload();
    }, 600);
  }, TIMEOUT_MS);

  // Cancel the timeout if React mounts successfully
  // (React replaces root content, removing .crx-loading)
  var observer = new MutationObserver(function () {
    var spinner = document.querySelector('#root > .crx-loading');
    if (!spinner) {
      clearTimeout(timer);
      observer.disconnect();
      // Clear retry counter on success
      sessionStorage.removeItem(STORAGE_KEY);
    }
  });

  // Start observing — wait for root to exist (should already be in DOM)
  var root = document.getElementById('root');
  if (root) {
    observer.observe(root, { childList: true });
  }
})();
