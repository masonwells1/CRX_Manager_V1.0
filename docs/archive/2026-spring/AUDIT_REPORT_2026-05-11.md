# CRX Manager Audit Report — 2026-05-11

**Branch:** `claude/app-review-audit-yseuL`
**Run by:** `/audit` skill

## Summary

| Check | Result |
|---|---|
| SQL Validation | 61 violations / 52 warnings — **all in old migrations, no new ones** |
| Frontend Validation | PASS |
| ESLint | PASS — 0 errors, 1 pre-existing warning |
| TypeScript | PASS |
| Production Build | PASS (37s, 147 PWA precache entries) |
| Unit Tests | 1872 passed / 68 skipped (130 files) |
| Doc Drift | PASS (one minor inconsistency, see below) |
| Supabase Security Advisors | **1 ERROR / 438 WARN** |
| Supabase Performance Advisors | 0 ERROR / 97 WARN / 159 INFO |

**Overall:** Local code health is green. Action items are all on the Supabase side (security advisors).

---

## Local checks — clean

### SQL migrations
- 285 migration files scanned.
- 61 violations, 52 warnings.
- All violations are in pre-May 2026 migrations. Most recent offender: `20260332700000_fix_idempotency_column_refs_round3.sql`. Per the script's own note, these are expected (they're the bugs that later migrations fixed).
- No violations in any May 2026 migration.

### Frontend validation
- No output, no violations.

### ESLint
- 0 errors.
- 1 warning (pre-existing, not from this branch):
  - `src/pages/IntegrityReport.tsx:27` — `useEffect` missing `fetchReport` dependency.

### TypeScript
- Clean (`tsc --noEmit -p tsconfig.app.json`).

### Build
- Succeeds in 37s. 147 PWA precache entries.
- Bundle size note (informational, not a failure): `vendor-mapbox` chunk is 1.68 MB minified / 463 KB gzipped — over the 500 KB advisory.

### Unit tests
- 1872 passed, 68 skipped, 130 files. Matches `CLAUDE.md` exactly.

### Doc drift
| Metric | CLAUDE.md says | Actual |
|---|---|---|
| Pages | 65 | 65 ✅ |
| Migrations | 285 | 285 ✅ |
| Edge Functions (Current State) | 8 | 8 ✅ |
| Unit tests | 1,872 | 1872 ✅ |
| Unit test files | 130 | 130 ✅ |
| E2E specs | 94 | 94 ✅ |

**Minor inconsistency:** The "Edge Functions" prose section of `CLAUDE.md` still says "7 in supabase/functions/" while the Current State block (and reality) say 8. Update the prose section to match.

---

## Supabase Security Advisors — needs attention

### ERROR (1)
- **`security_definer_view` on `public.profile_public_view`**
  - View is defined with `SECURITY DEFINER` — enforces the view creator's permissions instead of the caller's, bypassing RLS.
  - **Fix:** drop `SECURITY DEFINER` on the view, or convert to a function with explicit `SET search_path = public, pg_temp`.

### WARN — Hard Red Line violations (6)
Effective RLS bypass. CLAUDE.md says "every table must have RLS — no exceptions." These tables have RLS *enabled* but the policies are always-true, which is functionally equivalent to no RLS.

- **`public.blend_ticket_fields`** — INSERT, UPDATE, DELETE all unrestricted for `authenticated`
  - Policies: `blend_ticket_fields_insert`, `blend_ticket_fields_update`, `blend_ticket_fields_delete`
- **`public.field_crop_history`** — INSERT, UPDATE, DELETE all unrestricted for `authenticated`
  - Policies: `Authenticated users can insert crop history`, `Authenticated users can update crop history`, `Authenticated users can delete crop history`

**Fix:** rewrite each policy with a real predicate (tenant scoping, ownership, role check) rather than `USING (true)` / `WITH CHECK (true)`.

### WARN — function_search_path_mutable (4)
SECURITY DEFINER functions missing `SET search_path = public, pg_temp`. CLAUDE.md flags this as mandatory.

- `public.guard_audit_log_immutable`
- `public._fill_audit_actor`
- `public._enforce_quote_status_transition`
- `public._enforce_return_status_transition`

**Fix:** one-line migration each adding `SET search_path = public, pg_temp`.

### WARN — public_bucket_allows_listing (3)
Public storage buckets with broad SELECT policies that let any client list every file.

- `delivery-photos` — policies: `Authenticated users can upload 1evsna5_2`, `delivery_photos_select`
- `receiving-photos` — policies: `Authenticated users can upload 1evsna5_2`, `recv_photos_storage_read`
- `team-note-attachments` — policies: `Anyone can view team note attachments`, `Authenticated users can upload 1evsna5_2`

**Fix:** narrow the SELECT policies. Public buckets don't need broad SELECT — clients can fetch by object URL without listing.

### WARN — auth_leaked_password_protection (1)
Supabase Auth's "leaked password protection" is disabled.

**Fix:** enable in Auth settings (Dashboard → Authentication → Password protection).

### Routine warnings (424)
- `anon_security_definer_function_executable` × 212
- `authenticated_security_definer_function_executable` × 212

These are informational warnings about your SECURITY DEFINER RPCs being callable by `anon` / `authenticated` roles. This is intentional (it's how the frontend calls RPCs), so they can be triaged as "by design" — no action unless any specific function shouldn't be callable.

---

## Supabase Performance Advisors

| Finding | Level | Count |
|---|---|---|
| `auth_rls_initplan` | WARN | 63 |
| `multiple_permissive_policies` | WARN | 33 |
| `duplicate_index` | WARN | 1 |
| `unused_index` | INFO | 87 |
| `unindexed_foreign_keys` | INFO | 72 |

None blocking. Worth a sweep when there's time:
- `auth_rls_initplan`: wrap `auth.uid()` calls in policies as `(SELECT auth.uid())` so Postgres caches them per-query instead of re-evaluating per-row. Significant speedup on large tables.
- `multiple_permissive_policies`: consolidate overlapping permissive policies on the same table/role/action — Postgres OR's them and evaluates each one separately.
- `unindexed_foreign_keys`: add indexes on FK columns that filter joins or cascading deletes.
- `unused_index`: review and drop any indexes that haven't been used since stats were last reset.
- `duplicate_index`: drop the duplicate (run `\d <table>` in `psql` to identify).

---

## Recommended priority order

1. **`blend_ticket_fields` always-true RLS** (Hard Red Line violation)
2. **`field_crop_history` always-true RLS** (Hard Red Line violation)
3. **`profile_public_view` SECURITY DEFINER** (only ERROR-level finding)
4. **4 functions missing `SET search_path`** (cheap fix, prevents future search-path attacks)
5. **3 public buckets with broad SELECT** (data-exposure risk)
6. Enable leaked-password protection (one click in Dashboard)
7. CLAUDE.md prose: change "7 in supabase/functions/" to "8 in supabase/functions/"
8. Performance sweep (RLS initplan, multiple policies, FK indexes) — low priority

---

## Files / references

- Validation scripts: `scripts/validate-sql-migrations.sh`, `scripts/validate-frontend.sh`
- Schema-aware hooks: `.claude/hooks/`
- Doc drift sources of truth: `CLAUDE.md` "Current State" block
- Audit skill: `.claude/skills/audit/SKILL.md`
