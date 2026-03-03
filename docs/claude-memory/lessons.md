# Key Lessons & Gotchas

Things that have bitten us before. Check here before debugging mysterious issues.

## Environment
- gh CLI not on PATH in Claude Code bash — always use full path: `"/c/Program Files/GitHub CLI/gh.exe"`
- Session history doesn't persist — save important context to MEMORY.md
- Preview tool launch.json: on Windows use `cmd` as runtimeExecutable with `/c` flag

## React & UI
- react-map-gl v8: import from `'react-map-gl/mapbox'`, NOT bare `'react-map-gl'`
- react-map-gl can't go in Vite manualChunks — only put `mapbox-gl`
- React Router v7 Blocker: `blocker.state === 'blocked'` with `blocker.reset?.()` / `blocker.proceed?.()`
- Lucide React icons don't accept `title` prop — wrap in `<span title="...">`
- JSX `{unknown && <JSX/>}` is unsafe — use ternary `{cond ? <JSX/> : null}` instead

## Supabase
- PostGIS RPCs need `SET search_path = public, extensions`
- Edge Functions: deploy with `--no-verify-jwt` for client-side calls
- PostgrestError is a plain object (not instanceof Error) — multi-level type check for `.message`
- Join inference returns arrays for singular relationships — use `as unknown as Type[]`
- PromiseLike (query builders) has `.then()` but NOT `.catch()` — use `void` prefix
- `null` vs `undefined`: Supabase returns `null`, React props expect `undefined` — use `?? undefined`
- db.ts uses fallback placeholder values so createClient() doesn't crash in CI
- `allocation_sets` table: `entity_type/entity_id` are `NOT NULL` with no defaults + `UNIQUE(entity_type, entity_id, version)` — silently blocks multi-payment scenarios. Use `payments` table for recording invoice payments instead
- `deliveries` table: column is `scheduled_date`, **NOT** `delivery_date`
- `supabaseRpc` test helper does NOT check `resp.ok` — PostgREST HTTP 4xx errors return `{code, message}` JSON which is truthy; `if (result)` blocks silently pass even on DB failure
- `payments.amount` is `numeric` dollars (not cents bigint) — DB RPCs convert: `(p_amount_cents / 100.0)::numeric(12,2)`

## TypeScript & Linting
- ESLint `no-unused-vars` needs `varsIgnorePattern: '^_'` for intentionally-unused vars
- TypeScript `noUnusedLocals` in tsconfig is redundant with ESLint — don't enable both

## Testing
- jsPDF mocks must include ALL methods used — missing mocks cause silent test failures
- E2E `catch` clauses: use `catch(_e)` not `catch(e)` when the error param is unused — ESLint `no-unused-vars` enforces the `_` prefix pattern

## Business Logic
- See CLAUDE.md "Hard Red Lines" for money (bigint cents) and season (October 1-September 30) rules
