# Codex Review Prompt — Final Pre-Push Audit of All 2026-05-26 Changes

**For:** Codex (or any independent reviewer/model with repo + live-DB read access).
**Repo:** https://github.com/masonwells1/CRX_Manager_V1.0 (branch `main`, local-only — not yet pushed).
**Supabase project ref:** `rhyzpcqhnizqbxphqdkr` (read-only access only).

**Your job:** Final adversarial review before `git push origin main`. Audit the **complete set of 4 commits** that this branch is ahead of `origin/main`, plus the **2 live migrations** and **3 Edge Function deploys** they correspond to. Verify everything was applied correctly, find anything missed, and give a clear ship/hold verdict. **REPORT-ONLY: do not modify code, migrations, the database, or push. Read-only SQL only.** Be ruthless — this is the last review before production state diverges further from `origin/main` history.

---

## What you're auditing

### Local commits ahead of `origin/main` (4 commits)

```
05be295 fix(audit): close B7/B8/B9 from post-Codex audit + reconcile migration versions   ← NEW (this session)
a824952 chore: regenerate schema-registry stamp after audit migration apply
fce0629 fix(audit): apply 2026-05-25 ultra-review remediation (Codex + 2 Claude audits)
c36e25e docs(audits): add 2026-05-25 ultra-review, remediation plan, and Codex review prompt
```

`c36e25e` was already on `origin/main` before this session — it added the audit docs from the prior session's pre-remediation Codex review. The 3 commits **above** that are what this push will deliver to production.

### Live state changes already executed via MCP (not yet on remote)

1. **Migration `20260526151856_execute_full_codebase_ultra_review`** applied to live (verification block passed atomically). 1,604 lines. Renames functions, revokes anon grants, adds CHECK constraints, creates a sequence, adds a delivery-signature trigger.
2. **Migration `20260526201319_revoke_anon_on_secdef_dml_helpers`** applied to live (verification block passed). Revokes anon + authenticated EXECUTE on 6 SECDEF DML helper functions; explicit GRANT to service_role.
3. **`reset-user-password`** Edge Function deployed v11 → **v12 ACTIVE** (entity_recipient block + fail-loud CORS).
4. **`create-user`** Edge Function deployed v18 → v19 → **v20 ACTIVE** (phone-error Sentry capture, then B8 entity_recipient guard on reset_password branch).

### Session history (so you know who reviewed what already)

Three prior audit/review passes have signed off on parts of this work:

| Session | Scope | Outcome |
|---|---|---|
| **Original 10-domain audit** (`2026-05-25-full-codebase-ultra-review.md`) | Pre-remediation — identified RLS-1 P0 + 6 P1s | Codex's remediation drafted from these findings |
| **Pre-remediation Codex review** (`2026-05-25-codex-review-prompt.md`) | Audited the original 10-domain findings | Mostly AGREE, surfaced minor refinements |
| **Parallel Claude session** (§§1–10 of disposition doc) | Audited Codex's in-flight remediation; added B4/B5/B6/C1; executed Phases 1–7 | Migration + 2 edge deploys landed via MCP |
| **Post-apply Codex audit** (`2026-05-26-codex-post-apply-audit-prompt.md`) | Reviewed commits `fce0629` + `a824952` | Surfaced B7/B8/B9 → fixed in `05be295` |
| **This audit (you)** | Final pre-push review of all 4 commits + live state | TBD |

---

## Read first

1. `docs/audits/2026-05-26-claude-disposition-of-codex-execution.md` — full disposition. Sections 1-10 are the parallel session's audit of Codex's remediation; **§11** is the post-Codex audit reconciliation.
2. `docs/audits/2026-05-25-full-codebase-ultra-review.md` — original 10-domain audit.
3. `docs/audits/2026-05-25-14-domain-review-supplement.md` — parallel session's 14-domain supplement (AppSec/Concurrency/Date-time/Referential integrity additions).
4. `docs/audits/2026-05-26-codex-post-apply-audit-prompt.md` — the audit prompt YOU previously responded to, surfacing B7/B8/B9.
5. `docs/CHANGELOG.md` top two entries (2026-05-26 + 2026-05-26 post-Codex).
6. `CLAUDE.md` — Hard Red Lines, Schema Gotchas, Canonical Patterns.
7. The 4 commits via `git show fce0629`, `git show a824952`, `git show 05be295`, `git show c36e25e`.

Exclude `node_modules/`, `.claude/worktrees/`, `.playwright-mcp/` from all searches.

---

## What to scrutinize

### 1. Live state matches commits (no drift)

For every change in the 3 push-pending commits, confirm the live database / Edge Function state matches:

**Migration `20260526151856`** — 7 verification assertions ran at apply time; re-verify each independently:
```sql
SELECT
  (SELECT count(*) FROM pg_proc WHERE proname='next_invoice_number' AND pronamespace='public'::regnamespace) AS overloads,
  has_function_privilege('anon', 'public.apply_write_off(uuid,bigint,text,uuid,text)', 'EXECUTE') AS anon_apply_writeoff,
  has_function_privilege('anon', 'public.execute_sql_readonly(text)', 'EXECUTE') AS anon_exec_sql_readonly,
  has_function_privilege('anon', 'public.unapply_credit_memo(uuid,text,uuid,text)', 'EXECUTE') AS anon_unapply,
  EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND n.nspname='public' AND c.relname='cm_invoice_number_seq') AS cm_seq;
-- Expected: 1, false, false, false, true
```

**Migration `20260526201319`** — 6 functions REVOKE + GRANT verification:
```sql
SELECT proname,
       has_function_privilege('anon', oid, 'EXECUTE') AS anon,
       has_function_privilege('authenticated', oid, 'EXECUTE') AS authn,
       has_function_privilege('service_role', oid, 'EXECUTE') AS service_role
FROM pg_proc
WHERE pronamespace='public'::regnamespace
  AND proname IN ('check_idempotency','check_rate_limit','check_remainder_reminders','cleanup_rate_limits','log_failed_notification','notify_damaged_receiving')
ORDER BY proname;
-- Expected (all 6): anon=false, authn=false, service_role=true
```

**Edge Function deploys** — pull each via `get_edge_function` and confirm:
- `reset-user-password` v12 ACTIVE; deployed source matches `supabase/functions/reset-user-password/index.ts` byte-for-byte; entity_recipient block present.
- `create-user` v20 ACTIVE; deployed source matches `supabase/functions/create-user/index.ts` byte-for-byte; entity_recipient block present in BOTH the create-user flow context AND the reset_password branch (B8 fix at lines 86-104 of repo source).

### 2. The B7 rename — clean enough?

Two migration files were renamed via `git mv` to match MCP-stamped versions:
- `20260526090000_execute_full_codebase_ultra_review.sql` → `20260526151856_*.sql`
- `20260526170000_revoke_anon_on_secdef_dml_helpers.sql` → `20260526201319_*.sql` (new file, untracked at rename time)

Verify:
- `git log --follow` on each renamed file shows the rename rather than a delete + add. (`git show 05be295 --stat` should display the rename as `R`.)
- File contents are identical to what was committed in `fce0629` and what was passed to MCP `apply_migration`. The git blob hash for `20260526151856_*.sql` in `05be295` should equal the blob hash for `20260526090000_*.sql` in `fce0629`. Confirm:
  ```bash
  git rev-parse fce0629:supabase/migrations/20260526090000_execute_full_codebase_ultra_review.sql
  git rev-parse 05be295:supabase/migrations/20260526151856_execute_full_codebase_ultra_review.sql
  # Should be identical.
  ```
- All doc cross-references now consistently say `20260526151856` (and the new `20260526201319`); no leftover `20260526090000` or `20260526170000` references except inside historical audit-doc sections that intentionally document the drift.

### 3. The B8 fix — actually closes the gap?

`supabase/functions/create-user/index.ts:86-104` adds the entity_recipient guard to the reset_password branch. Verify:
- The guard runs **before** `adminClient.auth.admin.updateUserById`, not after.
- The lookup uses `adminClient` (service_role) not `callerClient` (anon-with-JWT). If it used `callerClient`, RLS on `profiles_select` might return null and the guard would falsely allow the reset.
- The response is status 403 with a clear message, matching the reset-user-password v12 pattern.
- The block is inside `if (action === "reset_password")` and not somewhere that also blocks normal user creation.
- Deployed v20 source from `get_edge_function` matches the repo source byte-for-byte (no MCP-edge-side mutation).

### 4. The B9 migration — completeness check

Codex's original B9 query found 6 SECDEF DML functions without `auth.uid()` checks. The migration revokes those 6. **Re-run the original scan** to verify no others slipped through:

```sql
WITH anon_secdef AS (
  SELECT p.oid, p.proname,
         pg_get_function_identity_arguments(p.oid) AS args,
         p.prosrc ~* 'auth\.uid\s*\(' AS refs_auth_uid,
         p.prosrc ~* '\m(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\M' AS has_dml_ddl,
         p.prorettype::regtype::text AS rettype
  FROM pg_proc p
  WHERE p.pronamespace='public'::regnamespace
    AND p.prosecdef
    AND has_function_privilege('anon', p.oid, 'EXECUTE') = true
)
SELECT proname, args, rettype
FROM anon_secdef
WHERE proname !~ '^_'
  AND has_dml_ddl
  AND NOT refs_auth_uid
  AND rettype != 'trigger'
ORDER BY proname;
-- Expected after the migration: zero rows.
```

If any rows are returned, **flag as B10** with severity assessment. Also independently check trigger-returning functions for any that could be exploited via direct call rather than trigger firing.

### 5. The migration's own integrity

- Re-read `supabase/migrations/20260526201319_revoke_anon_on_secdef_dml_helpers.sql` end-to-end. Does the verification `DO $$` block at the bottom actually catch every revocation it claims? Specifically: do the function signatures inside `has_function_privilege(...)` calls **exactly** match the live `pg_proc.identity_args` for those functions? A typo (e.g., `text,text` vs `text, text` — Postgres normalizes, but a wrong arg count would silently pass).
- Are there any other SECDEF helpers callers of these 6 functions (`apply_write_off` etc.) that might break if the helper's grants changed? They shouldn't (postgres owner bypasses), but spot-check ONE money-critical SECDEF wrapper end-to-end.

### 6. The deferred CI break

`src/lib/schemaIntegrityLive.test.ts:44` calls `execute_sql_readonly` using `VITE_SUPABASE_ANON_KEY`. After the B4 revoke in migration `20260526151856`, that test will fail when run with anon credentials against live. Verify:
- Local `vitest.config.ts` / `vite.config.ts:108-112` correctly stubs `VITE_SUPABASE_URL` so the test skips locally (does it? read the actual config).
- `.github/workflows/ci.yml:78-82` passes real credentials; check whether the live schema test job will actually run on push.
- Is this a P2 we should fix in this commit or a P3 follow-up? Codex's original prompt and the post-Codex audit both flagged it as deferred. Confirm or refute that decision.

### 7. Cross-commit consistency

The 3 push-pending commits modify overlapping files. Confirm:
- The final state of each file (per `git show HEAD:<path>` for each file in the squashed diff `fce0629..05be295`) reflects ALL intended fixes layered correctly.
- No fix in `05be295` accidentally reverts something from `fce0629` (e.g., did the `CustomerDetail.tsx` B2 reversion survive correctly through both commits?).
- `git diff origin/main HEAD` shows exactly the set of changes you expect, no surprise additions.

### 8. Frontend regression risk

The B4 + B5 + B9 revokes change anon EXECUTE on 8 SECDEF functions total. Verify the frontend has zero callers of any of them (besides the test file in deferred item):

```bash
rg -n "execute_sql_readonly|unapply_credit_memo|check_idempotency|check_rate_limit|check_remainder_reminders|cleanup_rate_limits|log_failed_notification|notify_damaged_receiving" src/ tests/
```

Anything beyond the documented test caller? Flag immediately.

### 9. Doc accuracy

Spot-check the new audit doc section §11 and CHANGELOG entries:
- Every commit hash referenced is correct.
- Every Edge Function version mentioned matches live.
- Every migration version mentioned matches what's in `schema_migrations`.
- No reference to the pre-rename filenames `20260526090000` or `20260526170000` except in historical context that explicitly documents the drift.

### 10. New findings (B10+)

Look for anything none of the prior sessions caught:
- Other migrations on disk that aren't in `schema_migrations`? (B6-style disk-vs-live drift) — run `list_migrations` and compare to `ls supabase/migrations/`.
- Function bodies in migrations that don't match live (post-apply `pg_get_functiondef` comparison)?
- Storage bucket policies still loose (the 14-domain supplement flagged D11-01/D11-02 — those weren't part of this remediation)?
- Anything else.

---

## Output format

For each section above: **AGREE / DISAGREE / NEEDS-MORE-INFO**, with concrete evidence (commit hash + file:line, or DB query result).

Then:

- **New findings (B10+)** — anything missed across all 4 sessions, with severity + proposed fix.
- **Push verdict:** SAFE TO PUSH / HOLD-FIX-FIRST. If hold, list every blocker.
- **Push the deferred CI fix into this commit, or accept the follow-up?** Your call.
- **Sign-off:** if SAFE, your one-sentence summary of why the 4-commit set is production-ready.

Be specific. If you flag a B10, include the query that proves it.

---

## Quick-reference: SQL queries you'll likely want

```sql
-- 1. Latest 6 applied migrations + version map
SELECT version, name FROM supabase_migrations.schema_migrations
ORDER BY version DESC LIMIT 6;

-- 2. Disk migration count vs live count
-- (run `ls supabase/migrations/*.sql | wc -l` for disk;
--  SELECT count(*) FROM supabase_migrations.schema_migrations for live)

-- 3. Disk-vs-live drift — any disk filenames not in live?
-- (compare ls output to schema_migrations.version list)

-- 4. Anon attack surface — broader sweep
SELECT count(*) AS still_anon_callable_mutators
FROM pg_proc p
WHERE p.pronamespace='public'::regnamespace
  AND p.prosecdef
  AND has_function_privilege('anon', p.oid, 'EXECUTE') = true
  AND p.proname !~ '^_'
  AND p.prosrc ~* '\m(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\M'
  AND p.prorettype::regtype::text != 'trigger';

-- 5. Generated columns still GENERATED ALWAYS (no regression)
SELECT table_name, column_name, generation_expression
FROM information_schema.columns
WHERE table_schema='public' AND is_generated='ALWAYS';

-- 6. RLS coverage check — every table has at least 1 policy
SELECT count(*) AS tables_without_policy
FROM pg_tables t
WHERE schemaname = 'public'
  AND NOT EXISTS (
    SELECT 1 FROM pg_policies p
    WHERE p.schemaname = t.schemaname AND p.tablename = t.tablename
  );

-- 7. financial_audit_log immutability trigger still firing
SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname LIKE '%audit_log%' AND NOT tgisinternal;

-- 8. Both verification block assertions from the new migrations passed at apply time
-- (re-run the assertion conditions independently)
```

```bash
# Edge Function deploy state
mcp_supabase_list_edge_functions
# Expected:
#   reset-user-password v12 ACTIVE, verify_jwt: true
#   create-user        v20 ACTIVE, verify_jwt: true
#   send-email         v13 ACTIVE (unchanged)
#   process-blend-ticket v19 ACTIVE (unchanged)
#   process-document   v13 ACTIVE (unchanged)
#   setup-blend-tickets-storage v15 ACTIVE (unchanged)
#   seed-admin         v15 ACTIVE (unchanged)

# Diff deployed vs repo source for the two changed functions
mcp_supabase_get_edge_function(slug='reset-user-password')
mcp_supabase_get_edge_function(slug='create-user')
# Compare against supabase/functions/<slug>/index.ts and _shared/{auth,sentry}.ts.
```

---

## Sign-off criteria

Codex signs off when:
1. All live state matches the committed source (migration bodies via `pg_get_functiondef`, Edge Function deploys byte-for-byte).
2. The completeness re-scan for B9 returns zero rows.
3. No B10 blocker found, or B10 found but its severity is < P1 and explicitly deferred.
4. The CI-break decision on `schemaIntegrityLive.test.ts` is documented (fix-now or follow-up).
5. The 4-commit diff against `origin/main` is internally consistent (no fix accidentally reverted, no cross-commit conflict).

If all 5 pass: **SAFE TO PUSH.** Otherwise list every blocker.

---

*Generated 2026-05-26 by the post-Codex-audit Claude session. Cross-references:*
- *`docs/audits/2026-05-25-full-codebase-ultra-review.md` (original 10-domain audit)*
- *`docs/audits/2026-05-25-14-domain-review-supplement.md` (14-domain supplement)*
- *`docs/audits/2026-05-25-codex-review-prompt.md` (pre-remediation Codex prompt)*
- *`docs/audits/2026-05-25-remediation-plan.md` (Codex's draft plan)*
- *`docs/audits/2026-05-26-claude-disposition-of-codex-execution.md` §1–11*
- *`docs/audits/2026-05-26-codex-post-apply-audit-prompt.md` (your previous prompt — surfaced B7/B8/B9)*
- *Commits `c36e25e`, `fce0629`, `a824952`, `05be295`.*
