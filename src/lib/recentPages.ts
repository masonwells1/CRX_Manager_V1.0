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
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function recordPageVisit(path: string, title: string) {
  try {
    const items = getRecentItems().filter((r) => r.path !== path);
    items.unshift({ path, title, timestamp: Date.now() });
    localStorage.setItem(RECENT_KEY, JSON.stringify(items.slice(0, MAX_RECENT)));
  } catch {
    // ignore storage errors
  }
  try {
    const key = getVisitCountKey(path);
    const counts = getVisitCounts();
    counts[key] = (counts[key] || 0) + 1;
    localStorage.setItem(COUNT_KEY, JSON.stringify(counts));
  } catch {
    // ignore storage errors
  }
}
