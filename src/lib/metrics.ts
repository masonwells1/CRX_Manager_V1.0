/**
 * Operational metrics — lightweight wrappers around Sentry for
 * business-level observability.
 *
 * These are NOT error reports. They add:
 *  1. User context (ID + role) on every session so error reports
 *     include who was affected.
 *  2. Navigation breadcrumbs so Sentry shows the page trail
 *     leading up to any error.
 *  3. Business event tracking (breadcrumbs) for key workflows so the
 *     trail leading up to any error shows recent business activity.
 *     (Business events are NOT sent to the Sentry Issues list.)
 *
 * All functions are fire-and-forget; they never throw.
 */
import { Sentry } from './sentry';

// ── User context ────────────────────────────────────────────────

/**
 * Tag the current Sentry scope with user info.
 * Call once after login / profile load.
 * Sentry strips emails by default; we only send ID + role.
 */
export function setUserContext(userId: string, role: string) {
  try {
    Sentry.setUser({ id: userId });
    Sentry.setTag('user_role', role);
  } catch {
    // Sentry not initialised (dev mode) — ignore
  }
}

/**
 * Clear user context on logout.
 */
export function clearUserContext() {
  try {
    Sentry.setUser(null);
  } catch {
    // ignore
  }
}

// ── Navigation breadcrumbs ──────────────────────────────────────

/**
 * Record a navigation breadcrumb.
 * Call from the router or a top-level layout component.
 */
export function trackNavigation(route: string) {
  try {
    Sentry.addBreadcrumb({
      category: 'navigation',
      message: route,
      level: 'info',
    });
  } catch {
    // ignore
  }
}

// ── Business events ─────────────────────────────────────────────

type EventLevel = 'info' | 'warning';

interface BusinessEventData {
  /** Human-readable description shown in Sentry */
  message: string;
  /** Sentry level — defaults to 'info' */
  level?: EventLevel;
  /** Arbitrary key/value pairs attached as extra context */
  data?: Record<string, string | number | boolean | null>;
}

/**
 * Track a significant business event as a Sentry breadcrumb — part of the
 * debugging trail shown alongside any later error report. Business events are
 * deliberately NOT sent to the Sentry Issues list (they are not errors; owner
 * decision 2026-07-01 — Sentry is not used as a business-activity feed).
 *
 * Use sparingly — only for events that matter operationally:
 *  - quote_created, order_placed, delivery_completed
 *  - payment_allocated, invoice_generated
 *  - month_end_closed, commission_paid
 *
 * @param name  Machine-readable event name (e.g. "order_placed")
 * @param opts  Message, level, and optional data
 */
export function trackBusinessEvent(name: string, opts: BusinessEventData) {
  try {
    // Breadcrumb for the trail. Intentionally NOT captured as a Sentry issue —
    // business activity is kept out of the error stream (see note above).
    Sentry.addBreadcrumb({
      category: 'business',
      message: `${name}: ${opts.message}`,
      level: opts.level ?? 'info',
      data: opts.data ?? undefined,
    });
  } catch {
    // ignore
  }
}
