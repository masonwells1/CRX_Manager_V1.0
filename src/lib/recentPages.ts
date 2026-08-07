/**
 * Recent page visit tracking for Command Palette.
 * Extracted to a separate module to avoid breaking React Fast Refresh
 * in CommandPalette.tsx (which must only export React components).
 */

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
 * Lifetime visit counts keyed by base path ('/invoices/abc-123' counts as
 * '/invoices'). Feeds the sidebar "Frequent" section.
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
    const base = '/' + (path.split('/')[1] || '');
    const counts = getVisitCounts();
    counts[base] = (counts[base] || 0) + 1;
    localStorage.setItem(COUNT_KEY, JSON.stringify(counts));
  } catch {
    // ignore storage errors
  }
}
