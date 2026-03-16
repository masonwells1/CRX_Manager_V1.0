# Infrastructure Hardening — Design

> **Date:** 2026-03-16 | **Status:** Implemented

## Overview

Four quick-win infrastructure improvements to harden CRX Manager for production use.

## Changes

### A1: Unhandled Rejection Safety Net (`main.tsx`)
- Added `window.addEventListener('unhandledrejection', ...)` before React renders
- Catches async errors that escape React's ErrorBoundary (fire-and-forget calls, service worker errors)
- Reports to Sentry with `mechanism: 'unhandledrejection'` tag

### A7: ESLint `no-console` Rule (`eslint.config.js`)
- Rule: `'no-console': ['warn', { allow: ['warn', 'error'] }]`
- Prevents accidental `console.log` debug statements from shipping
- Allows `console.error` (real error paths) and `console.warn` (graceful fallbacks)
- Zero existing violations — purely preventive

### A3: Sentry Sourcemap Uploads (`vite.config.ts`)
- Installed `@sentry/vite-plugin` (dev dependency)
- Build: `sourcemap: 'hidden'` — generates maps without linking them in JS files
- Plugin uploads maps to Sentry during build, then deletes them from `dist/`
- **Only active when `SENTRY_AUTH_TOKEN` is set** (Vercel CI, not local dev)
- Requires 3 env vars in Vercel: `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`

### A5: Per-Route Error Boundaries (`ErrorBoundary.tsx`, `App.tsx`)
- Enhanced `ErrorBoundary` with `inline` prop for compact in-page error UI
- Inline mode shows "This page crashed" with "Try Again" + "Go Back" buttons
- Added `RouteShell` component in `App.tsx` wrapping all authenticated routes
- If one page crashes, sidebar navigation still works — no full reload needed
- Root `ErrorBoundary` remains as ultimate fallback
- 2 new unit tests for inline mode

## Setup Required (Sentry Sourcemaps)

To activate sourcemap uploads, add these to Vercel Environment Variables:

1. **`SENTRY_AUTH_TOKEN`** — Create at sentry.io > Settings > Auth Tokens (scope: `org:read`, `project:releases`, `project:write`)
2. **`SENTRY_ORG`** — Your Sentry organization slug
3. **`SENTRY_PROJECT`** — Your Sentry project slug
