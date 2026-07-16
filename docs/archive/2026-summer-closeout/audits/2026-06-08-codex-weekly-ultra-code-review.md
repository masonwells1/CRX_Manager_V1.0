# Codex Weekly Ultra Code Review - 2026-06-08

**Scope reviewed:** commits and working-tree changes from 2026-06-01 through 2026-06-08 on branch `fix/architecture-weakness-2026-06-08`.

**Range:** `3f242f59e15ec1c3be9a80bfcbdfbdbc0d8524ae..995320b8d8ebfe0461315088cb168efbb0282318`

**Current worktree note:** while this review was running, two extra uncommitted changes appeared:

- Modified: `docs/audits/2026-06-08-architecture-weakness-audit.md`
- Untracked: `supabase/migrations/20260608150000_drop_deprecated_record_payment.sql`

**Verdict:** BLOCKED for further shipping until the `save_blend_ticket` strict-actor guard is fixed. The dependency upgrade also needs a clean-install validation pass before anyone relies on the green tests.

## Findings

### [HIGH / SHIP BLOCKER] `save_blend_ticket` still trusts caller-supplied `p_performed_by`

The 2026-06-08 AW-1 migration correctly wires idempotency into `save_blend_ticket`, but it preserves the older authorization pattern that the prior migration already called out as forgeable. The function checks `profiles.id = p_performed_by`, not `auth.uid()`, so the caller controls which profile is used for the role check.

Evidence:

- Prior warning: `supabase/migrations/20260530194520_save_blend_ticket_canonical_return.sql:21` explicitly says this is a `p_performed_by rather than auth.uid()` forgeable-actor pattern.
- New migration still accepts caller-supplied actor: `supabase/migrations/20260608144210_save_blend_ticket_idempotency.sql:26`.
- New migration still authorizes against that parameter: `supabase/migrations/20260608144210_save_blend_ticket_idempotency.sql:40`.
- New migration writes the same parameter into `activity_feed`: `supabase/migrations/20260608144210_save_blend_ticket_idempotency.sql:114`.
- The frontend passes the profile id as an RPC argument: `src/pages/BlendTicketDetail.tsx:361`.
- The same call now passes idempotency at `src/pages/BlendTicketDetail.tsx:362`, so the function was touched in this branch and this was the right moment to close the actor gap.
- Live metadata captured earlier in this review showed `authenticated` can execute the function, `anon` cannot, `check_idempotency` is present, and the body still does not mention `auth.uid` or `ACTOR_MISMATCH`. A later Supabase CLI refresh timed out, so I could not recapture that table output at report-writing time.

Impact:

Any authenticated user who can supply or learn an active `admin` or `sales_rep` profile UUID can satisfy the role check and run the SECURITY DEFINER mutation as that actor. This is not only audit attribution: the function updates blend ticket header fields and replaces ticket products, then logs the forged actor.

Fix for Claude:

Create a follow-up `CREATE OR REPLACE FUNCTION public.save_blend_ticket(...)` migration that derives the actor from `auth.uid()` and rejects mismatches before idempotency lookup:

```sql
v_actor := auth.uid();

IF v_actor IS NULL THEN
  RAISE EXCEPTION 'AUTH_REQUIRED';
END IF;

IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
  RAISE EXCEPTION 'ACTOR_MISMATCH';
END IF;

IF NOT EXISTS (
  SELECT 1
  FROM profiles
  WHERE id = v_actor
    AND is_active = true
    AND role IN ('admin', 'sales_rep')
) THEN
  RAISE EXCEPTION 'INSUFFICIENT_ROLE';
END IF;
```

Then use `v_actor` for `activity_feed.performed_by`. Keep the idempotency check after the auth/role guard so a cached result cannot leak to an unauthorized caller.

### [MED / VALIDATION BLOCKER] Local checks did not exercise the upgraded dependency tree

`package.json` and `package-lock.json` were upgraded, but the local `node_modules` tree is still on older packages. The normal checks passed, but they ran against the old installed versions.

Evidence:

- `package.json:42` requests `react-router-dom` `^7.17.0`.
- `package.json:61` requests `@vitest/coverage-v8` `^4.1.8`.
- `package.json:78` requests `vitest` `^4.1.8`.
- `package.json:76` keeps root `vite` at `^5.4.2`.
- `package-lock.json:10679-10680` locks `node_modules/vitest` to `4.1.8`.
- `package-lock.json:10704` shows Vitest wants Vite `^6.0.0 || ^7.0.0 || ^8.0.0`.
- `package-lock.json:11267-11268` adds a nested `vite` `8.0.16` under Vitest.
- `npm ls vitest @vitest/coverage-v8 react-router-dom react-router vite --depth=1` failed with `ELSPROBLEMS`: installed `vitest@3.2.4`, `@vitest/coverage-v8@3.2.4`, and `react-router-dom@7.13.1` are invalid against the new root ranges.
- `npm run test` printed `RUN v3.2.4`, confirming the test run used the old Vitest.
- `npm run build` printed `vite v5.4.21`, confirming the build used the old root Vite setup.

Impact:

The green build/test results are still useful for the current local tree, but they do not prove that a fresh checkout using the new lockfile works. This matters because the security-fix commit is exactly a package upgrade.

Fix for Claude:

Before merge/push confidence, run a clean install validation:

```bash
npm ci
npm run typecheck
npm run lint
npm run build
npm run test
```

If `npm ci` upgrades the local tree to Vitest 4 / React Router 7.17 and all checks still pass, this finding is closed.

### [MED / WORKTREE FOLLOW-UP] Uncommitted AW-3 migration needs docs/count cleanup if kept

An untracked migration appeared during review: `supabase/migrations/20260608150000_drop_deprecated_record_payment.sql`. The SQL itself is small and looks targeted: it drops the deprecated seven-argument `record_payment(...)` function.

Evidence:

- New untracked migration drops the seven-arg function at `supabase/migrations/20260608150000_drop_deprecated_record_payment.sql:15`.
- The latest historical stub is the same seven-arg function shape in `supabase/migrations/20260311200000_invoice_ar_single_source.sql:1050-1059`.
- `src/lib/rpcContracts.test.ts:307` already says the `record_payment` contract was removed and `allocate_payment` should be used instead.
- No frontend `.rpc('record_payment')` caller was found.
- But `docs/reference/rpc-functions.md:57` still lists `record_payment()` as a current RPC.
- `CLAUDE.md:11` and `CLAUDE.md:289` still say 371 migrations; keeping this migration would make the disk count 372.
- `CLAUDE.md:12` still says AW-3 is pending.
- `docs/reference/migration-history.md` does not yet list `20260608150000_drop_deprecated_record_payment`.

Impact:

This is not a runtime bug if the migration remains uncommitted. If Claude intends to keep/apply/commit it, the repo docs will be stale immediately after the migration lands.

Fix for Claude:

If keeping this migration, update the migration count, add it to `docs/reference/migration-history.md`, remove or mark `record_payment()` as dropped/deprecated in `docs/reference/rpc-functions.md`, and update the `CLAUDE.md` current-state line from AW-3 pending to completed. If the migration is not ready, leave the docs alone and keep it uncommitted.

## No Finding After Review

- Money/PDF formatter consolidation: no cents-vs-dollars misclassification found. `src/lib/money.ts:21-27` preserves the two distinct helpers; mixed files like `src/pages/ARaging.tsx:18` and `src/pages/Rebates.tsx:25` import both.
- Dead-code cleanup: exact-symbol greps found no live references to the removed type names. The Receiving Log filter refresh remains covered because `fetchData` depends on the filters and the remaining effect depends on `fetchData`.
- Dashboard alert cleanup: removed `_alerts` was explicitly discarded before deletion, and `get_expiring_planned_holds` is no longer called by Dashboard.
- `src/lib/db.ts` request ID cleanup: removing the old static `global.headers` value is OK because the custom fetch wrapper still sets a fresh `X-Request-ID` per request at `src/lib/db.ts:28-31`.
- New `/map-drift-audit` and `/architecture-weakness-audit` command files are read-only by design and delegate to single canonical prompt files, which avoids command/prompt drift.

## Verification Run

Passed:

- `git diff --check 3f242f59e15ec1c3be9a80bfcbdfbdbc0d8524ae..HEAD`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm run test` - 130 files passed, 1,924 tests passed, 70 skipped

Warnings/limits:

- The test suite still emits existing React `act(...)`, duplicate key, and jsdom canvas warnings.
- The build still warns about large chunks and the CJS Vite Node API deprecation.
- The dependency validation is limited because local `node_modules` is stale versus `package.json` and `package-lock.json`.
- Supabase CLI `db query --linked` timed out near the end of the review, so the final report relies on live DB metadata captured earlier in this same review plus committed migration evidence.

## Suggested Claude Handoff Prompt

```text
Read docs/audits/2026-06-08-codex-weekly-ultra-code-review.md.

Implement only the listed fixes. Do not push, deploy, or apply migrations without Mason's explicit approval.

Priority:
1. Fix HIGH blocker: add strict auth.uid()/ACTOR_MISMATCH actor enforcement to save_blend_ticket while preserving the new idempotency behavior.
2. Run clean dependency validation with npm ci, then typecheck/lint/build/test.
3. Decide whether to keep the uncommitted AW-3 record_payment drop migration. If keeping it, update migration docs/counts and rpc-functions docs.

After changes, report file:line evidence and exact commands run.
```
