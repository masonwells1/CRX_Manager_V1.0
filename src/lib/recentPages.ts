/**
 * Recent page visit tracking for Command Palette.
 * Extracted to a separate module to avoid breaking React Fast Refresh
 * in CommandPalette.tsx (which must only export React components).
 */

import { getPageKeyFromPath } from './pagePermissions';

const RECENT_KEY = 'crx-recent-pages';
const COUNT_KEY = 'crx-page-visit-counts';
const MAX_RECENT = 20;

export interface RecentItem {
  path: string;
  title: string;
  timestamp: number;
}

export function getRecentItems(): RecentItem[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * Canonical visit-count key for a route. Uses the permission page key, so
 * reused editor routes (/invoices/field-app/* → 'field-invoices') and nested
 * nav paths (/split-billing/new) credit the page they belong to. Falls back
 * to the first path segment for non-permissionable routes (/team-board etc.).
 * Both the recorder and the sidebar "Frequent" lookup must use this key.
 */
export function getVisitCountKey(path: string): string {
  return getPageKeyFromPath(path) ?? '/' + (path.split('/')[1] || '');
}

/**
 * Lifetime visit counts keyed by getVisitCountKey(). Feeds the sidebar
 * "Frequent" section.
 */
export function getVisitCounts(): Record<string, number> {
  try {
    const raw = localStorage.getItem(COUNT_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      Object.values(parsed).every((value) => Number.isSafeInteger(value) && (value as number) >= 0)
    ) {
      return parsed as Record<string, number>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Fired on window after a visit count is written, so live UI can recompute. */
export const VISIT_COUNTS_CHANGED_EVENT = 'crx:visit-counts-changed';

// Redirect aliases (e.g. /field-invoices/unbilled → /field-invoices?tab=…)
// commit two pathnames for a single user navigation, both resolving to the
// same canonical key moments apart. Skip the duplicate count.
const REDIRECT_DEDUPE_MS = 5000;

export function recordPageVisit(path: string, title: string) {
  let previous: RecentItem | undefined;
  try {
    const items = getRecentItems();
    previous = items[0];
    const deduped = items.filter((r) => r.path !== path);
    deduped.unshift({ path, title, timestamp: Date.now() });
    localStorage.setItem(RECENT_KEY, JSON.stringify(deduped.slice(0, MAX_RECENT)));
  } catch {
    // ignore storage errors
  }
  try {
    const key = getVisitCountKey(path);
    const isRedirectDuplicate =
      previous !== undefined &&
      getVisitCountKey(previous.path) === key &&
      Date.now() - previous.timestamp < REDIRECT_DEDUPE_MS;
    if (!isRedirectDuplicate) {
      const counts = getVisitCounts();
      counts[key] = (counts[key] || 0) + 1;
      localStorage.setItem(COUNT_KEY, JSON.stringify(counts));
      window.dispatchEvent(new Event(VISIT_COUNTS_CHANGED_EVENT));
    }
  } catch {
    // ignore storage errors
  }
}
