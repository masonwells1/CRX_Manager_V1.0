/**
 * Recent page visit tracking for Command Palette.
 * Extracted to a separate module to avoid breaking React Fast Refresh
 * in CommandPalette.tsx (which must only export React components).
 */

const RECENT_KEY = 'crx-recent-pages';
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

export function recordPageVisit(path: string, title: string) {
  try {
    const items = getRecentItems().filter((r) => r.path !== path);
    items.unshift({ path, title, timestamp: Date.now() });
    localStorage.setItem(RECENT_KEY, JSON.stringify(items.slice(0, MAX_RECENT)));
  } catch {
    // ignore storage errors
  }
}
