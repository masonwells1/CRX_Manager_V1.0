## 2026-10-04 — Library updates: the Dependabot minor-and-patch group (re-delivered from #863)

Dependabot PR #863 bumped 11 libraries. It closed itself when #877 (Tailwind 4) changed the
lockfile, so this PR re-applies the same versions on top of current `main`. `autoprefixer` is no
longer a dependency after #877, so 10 bumps remain:

| Package | From | To |
| --- | --- | --- |
| `@mapbox/mapbox-gl-draw` | 1.5.1 | 1.5.2 |
| `@sentry/react` | 10.73.0 | 10.76.0 |
| `@supabase/supabase-js` | 2.115.0 | 2.117.2 |
| `lucide-react` | 1.41.0 | 1.51.0 |
| `mapbox-gl` | 3.30.0 | 3.32.0 |
| `react-router-dom` | 7.18.3 | 7.18.4 |
| `@types/node` (dev) | 26.4.1 | 26.6.4 |
| `eslint-plugin-react-refresh` (dev) | 0.5.6 | 0.5.7 |
| `globals` (dev) | 17.12.0 | 17.13.0 |
| `typescript-eslint` (dev) | 8.69.0 | 8.71.0 |

**Removed the `@mapbox/mapbox-gl-draw` → `nanoid ^5.1.16` override.** #360 added it to keep the draw
path at or above 5.1.16, the fix for the non-secure generator's negative-size infinite loop.
Draw 1.5.2 declares `nanoid ^6.0.0`, which is also outside the advisory range, and the override was
forcing it back onto 5.x, a major version it does not support (flagged by the Codex connector on
this PR). The draw path now resolves `nanoid@6.0.1`. Its `non-secure/index.js` keeps the guarded
`while (i-- > 0)` loop, and it exports the `customAlphabet` that draw imports. `postcss` still
resolves its own `nanoid@3.3.18`, unchanged.

**Proof observed.**
- On #863's head `9ca801f` (same versions, Tailwind 3): `npm ci`, build, typecheck, lint and all
  382 test files passed. A logged-in pass of 12 pages on the local dev server made about 230
  Supabase reads with 0 failures; icons rendered, and every route resolved. On #863's Vercel
  preview, the Fields map rendered satellite tiles, and the new-field boundary tool drew and
  measured a polygon, which was then removed without saving.
- On this branch (current `main`, Tailwind 4): `npm ci`, build, typecheck, lint and all 382 test
  files (5,459 tests) passed, and `npm audit` reports 0 vulnerabilities.

**Not verified here.** Sentry event delivery was not exercised, because no error was triggered.
