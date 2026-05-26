# Codex Review Prompt — Post-Apply Audit of the 2026-05-26 Remediation

**For:** Codex (or any independent reviewer/model with repo + live-DB access).
**Repo:** https://github.com/masonwells1/CRX_Manager_V1.0 (branch `main`).
**Supabase project ref:** `rhyzpcqhnizqbxphqdkr` (read-only access only).
**Commits under review:** `fce0629` (main remediation) and `a824952` (schema-registry stamp). Local-only; not yet pushed.

**Your job:** Adversarially verify the work just executed by a parallel Claude session that audited Codex's *original* remediation and then applied an amended migration + redeployed two Edge Functions to live. The earlier model audited Codex; you are now auditing the next model. Re-derive every conclusion from the code, the commits, and (where possible) the live database. **REPORT-ONLY: do not modify code, migrations, or the database. Read-only SQL only — never INSERT/UPDATE/DELETE/DDL/migration/deploy.** Be ruthless; the parallel session ran end-to-end fast and may have missed regressions the original Codex+10-domain audit would have caught.

---

## What was done (so you know what to audit)

A parallel Claude session executed a 7-phase remediation on the same day as the original ultra-review + Codex remediation:

1. **Audited Codex's pre-existing in-flight remediation** (the uncommitted source/edge fixes + the new untracked migration `20260526090000_execute_full_codebase_ultra_review.sql`). Wrote section §10 of `docs/audits/2026-05-26-claude-disposition-of-codex-execution.md` (sections 1-9 are from the prior session).
2. **Confirmed via live DB queries** that the prior session's §5 unverified claims held (`_insert_commissions_for_order` was `SECURITY DEFINER`, `next_invoice_number` had 2 overloads, `commission_payments.total_amount` exists, no test files referenced old English error strings).
3. **Disagreed with A4** — only 3 invoice sequences existed live (`cs_/mc_/base`), not 4. The historical migration creating `cm_invoice_number_seq` was never applied (disk-vs-live drift).
4. **Surfaced three new BLOCKERS** the prior 10-domain audit missed:
   - **B4** — `execute_sql_readonly(text)` SECURITY DEFINER + anon-EXECUTE + arbitrary `SELECT/WITH` body → anon could read every public table bypassing RLS.
   - **B5** — `unapply_credit_memo` same actor-forgery anti-pattern as the RLS-1 cluster (`v_actor := COALESCE(p_performed_by, auth.uid())`); prefix `unapply` missed by Codex's regex.
   - **B6** — `next_invoice_number('credit_memo')` references `public.cm_invoice_number_seq::regclass`, which doesn't exist live. Migration would apply cleanly but `issue_return_credit` would crash on first credit-memo issuance.
5. **Reaffirmed C1** with live evidence (`auto_expire_quotes`, `retry_failed_notifications`, `revert_quote_status` are anon-callable and missed by the original regex).
6. **Edited the migration file** with 4 additive changes:
   - B6: `CREATE SEQUENCE IF NOT EXISTS public.cm_invoice_number_seq` near the top.
   - C1: regex extended to include `auto|retry|revert` prefixes.
   - B4 + B5: explicit `REVOKE EXECUTE FROM PUBLIC, anon; GRANT EXECUTE TO authenticated;` on the two functions.
   - Verification block: 3 new assertions (sequence exists, B4 anon-revoke, B5 anon-revoke).
7. **Mid-flight catch — B2 reversion.** Phase 2's full vitest suite caught that the prior session's B2 (Promise.all restoration in `src/pages/CustomerDetail.tsx`) broke the `assertRpcCoverage` zero-baseline test — the regex requires `= await supabase.rpc(...)` directly, which Promise.all array elements don't match. Reverted to sequential awaits with proper destructuring + per-RPC `assertRpcResult`. Documented as §10.8 of the disposition doc.
8. **Ran full validation pre-commit**: `npm run lint` (0 errors), `npm run typecheck` (0 errors), `npm test` (130/130 files, 1,921 passed + 70 skipped), `scripts/validate-sql-migrations.sh --max-violations=61` (exit 0).
9. **Refreshed three docs**: `CLAUDE.md` + `docs/CHANGELOG.md` + `docs/reference/migration-history.md` with the parallel-audit additions on top of Codex's original entries.
10. **Committed everything** as commit `fce0629` (20 files, +2,710 / -69 lines). Pre-commit hook re-ran lint+build+tests and passed.
11. **Applied migration to live** via `mcp_supabase_apply_migration`. All 7 verification assertions passed atomically.
12. **Redeployed two Edge Functions** via `mcp_supabase_deploy_edge_function`: `reset-user-password` v11→v12, `create-user` v18→v19. Both ACTIVE.
13. **Verified live state** via post-apply SQL — every claimed change matched expectations.
14. **Regenerated schema-registry stamp** (`node scripts/regenerate-schema-registry.mjs`). No structural changes to the JSON beyond the date.
15. **Committed schema-registry** as commit `a824952` (1 file, 1 insertion / 1 deletion).

---

## Read first

1. `docs/audits/2026-05-26-claude-disposition-of-codex-execution.md` — full disposition. Sections 1-9 are the prior session (Codex's original work audit). **Section 10** is the parallel-session audit + reconciliation under review.
2. `docs/audits/2026-05-25-full-codebase-ultra-review.md` — the original 10-domain audit (Codex's source-of-record findings).
3. `docs/audits/2026-05-25-14-domain-review-supplement.md` — the parallel session's 14-domain supplement (added AppSec / Concurrency / Date-time / Referential integrity domains).
4. `supabase/migrations/20260526090000_execute_full_codebase_ultra_review.sql` — the migration that was applied to live (1,604 lines).
5. `CLAUDE.md` — project rules (Hard Red Lines, Schema Gotchas, Canonical Patterns).
6. `git show fce0629 --stat` and `git show a824952 --stat` — the actual commits.

Exclude `node_modules/`, `.claude/worktrees/`, `.playwright-mcp/` from all searches.

---

## What to scrutinize

### 1. The migration as committed — does it match what was applied?

The migration file on disk (in commit `fce0629`) was passed verbatim to `apply_migration`. Verify:
- **Byte-for-byte intent match.** Read the disk file and confirm every block in §10.3 of the disposition doc (B4 REVOKEs, B5 REVOKEs, B6 sequence creation, C1 regex extension, verification assertions) actually appears in the SQL.
- **No silent edits** between commit and apply. The migration was a single MCP call; no intermediate edits should exist.
- **BEGIN/COMMIT framing.** The migration is wrapped in its own `BEGIN; ... COMMIT;` AND `apply_migration` may have added its own outer transaction. Confirm via `list_migrations` that version `20260526090000` is the latest applied. If MCP nested a transaction, did any of the inner `DO $$ BEGIN ... END $$` blocks (which use PL/pgSQL `EXCEPTION`) interact oddly with the outer wrapper?

### 2. The 4 parallel-audit additions (B4, B5, B6, C1) — correct and complete?

**B6 (sequence creation):**
- Confirm `public.cm_invoice_number_seq` exists live (`SELECT * FROM pg_sequences WHERE sequencename='cm_invoice_number_seq'`).
- Does it have a sane `start_value` and `increment_by`? (The `CREATE SEQUENCE IF NOT EXISTS` used PostgreSQL defaults — `start 1 increment 1`.) Is that what credit memos need, or should it have started higher to avoid collision with any historical CM-prefixed invoice numbers? Query: `SELECT invoice_number FROM invoices WHERE invoice_number LIKE 'CM-%'` — if any exist with a number ≥ 1, the sequence will hand out a duplicate.
- Is the sequence ownership and search_path correct?

**B4 + B5 (explicit REVOKEs):**
- Confirm live: `has_function_privilege('anon', 'public.execute_sql_readonly(text)', 'EXECUTE') = false` AND `has_function_privilege('anon', 'public.unapply_credit_memo(uuid,text,uuid,text)', 'EXECUTE') = false`.
- Did the migration also REVOKE `EXECUTE` from `PUBLIC` for both? (The audit doc claims yes; verify.)
- Is `authenticated` still able to call them (legitimate flow)? Confirm `has_function_privilege('authenticated', ..., 'EXECUTE') = true` for both.
- **Frontend impact verification:** `execute_sql_readonly` is supposedly called only from `src/lib/schemaIntegrityLive.test.ts:44`. Confirm — and check whether that test is currently RUN in CI (look at `vitest.config.ts` and any env-gating). If the test runs with the anon key, revoking anon EXECUTE breaks it. If it runs with service_role, revoke is harmless.
- `unapply_credit_memo` — is there REALLY no production caller? Grep `src/`, `supabase/functions/`, and the deployed Edge Function bodies (via `get_edge_function`).

**C1 (regex extension):**
- Confirm live: `auto_expire_quotes`, `retry_failed_notifications`, `revert_quote_status` all now have `has_function_privilege('anon', ..., 'EXECUTE') = false`.
- Are there OTHER functions newly matched by the extended regex that shouldn't have been revoked? Run the full filter: `SELECT proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND prosecdef AND proname !~ '^_' AND proname ~* '^(auto|retry|revert)'`. Check each is acceptable to have anon revoked.

### 3. The B2 reversion in `CustomerDetail.tsx` — actually correct?

Phase 2 caught the `assertRpcCoverage` regression and reverted to sequential awaits. Read `src/pages/CustomerDetail.tsx:265-310` (the financials tab) and verify:
- All 3 calls (`get_ar_aging`, `get_customer_statement`, `prepay_credits` table read) are in their own `const { data, error } = await ...` form.
- `assertRpcResult` is called on each of the 2 RPC results.
- `prepay_credits` is a table SELECT not an RPC — does NOT need `assertRpcResult` per the convention.
- Error handling (`if (error) throw error`) is preserved on all 3.
- The `try/catch + Sentry.captureException` wrapper is preserved.
- `financialsFetched.current = true` still gates re-fetches.
- The inline comment documenting WHY sequential (not Promise.all) is present and accurate.

Then **run vitest**: `npx vitest run src/lib/assertRpcCoverage.test.ts` — confirm 3/3 pass and the file-violation count is 0.

### 4. The deployed Edge Functions — do they match repo source byte-for-byte?

Two functions were redeployed:
- `reset-user-password` v11 → v12
- `create-user` v18 → v19

Pull each via `get_edge_function(slug=...)` and diff against the repo source (`supabase/functions/reset-user-password/index.ts` and `supabase/functions/create-user/index.ts` plus `supabase/functions/_shared/{auth.ts,sentry.ts}`).

Specifically verify:
- **reset-user-password v12** contains the `entity_recipient` block at the equivalent of repo lines 87-106 (`if (targetProfile?.role === "entity_recipient") return 403`). This was the EDGE-2 fix.
- **reset-user-password v12** uses `getAllowedOrigin()` (the fail-loud module-load function) and NOT `getCorsHeaders(req)` + the hardcoded `ALLOWED_ORIGINS[]` fallback. This was the EDGE-1 fix.
- **create-user v19** contains the phone-error Sentry capture (`if (phoneError) { await captureEdgeException(phoneError, { ..., level: "warning" }) }`) at the equivalent of repo lines 138-150. This was the EDGE-3 fix.
- Both functions still call `requireActiveProfile(adminClient, caller.id, ["admin"])` (Codex F1 / 2026-05-16 — must NOT have regressed).
- Both `verify_jwt: true`.
- Neither function has any code regression vs. its prior version that's worse than what was claimed.

### 5. The verification block — assertions actually correct?

Read `supabase/migrations/20260526090000:1539-1602` (the final `DO $$ ... END $$` block). For each assertion:
- Does it actually verify what it claims to?
- Is the SQL syntactically and semantically right? (E.g., `has_function_privilege('anon', 'public.execute_sql_readonly(text)', 'EXECUTE')` — does the function signature string EXACTLY match the live pg_proc identity_args? A typo would silently pass.)
- Would a malformed assertion silently allow a broken migration to apply? Cross-check against the live state.

### 6. False negatives — anything the parallel audit missed?

The parallel audit added 4 domains beyond the 10 Codex covered (AppSec, Concurrency, Date-time, Referential integrity — see `2026-05-25-14-domain-review-supplement.md`). Re-audit the same 10 original domains for anything missed:

- **Money/AR** — re-verify no GENERATED-column writes, no `parseFloat` on `*_cents`, period-close gating on every reversal path (the original audit found D1-01 and D1-02 — `void_payment` and `reverse_write_off` STILL don't call `check_period_open()` per §10 unless folded in here; confirm they remain unaddressed and were intentionally deferred or are still pending).
- **Pipeline + holds** — `complete_delivery` requires nonblank `p_signed_by` per the new `guard_completed_delivery_signature` trigger; verify the trigger fires (try an INSERT with empty signed_by via execute_sql with read-only intent — actually, since execute_sql is read-only by MCP design, query `SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname='trg_guard_completed_delivery_signature'` and confirm the trigger definition).
- **Inventory** — verify the holds-restoration symmetry per the 14-domain supplement claim that the asymmetry doesn't actually exist in current code (D4-04 reframe).
- **Idempotency** — the audit identified ~9–13 RPCs that declare `p_idempotency_key` but don't honor it (`save_blend_ticket`, `save_job`, `create_invoice_from_delivery`, `create_followup_delivery`, `duplicate_quote`, etc.). Verify which were FIXED by this migration (`duplicate_quote` + `create_followup_delivery` should now be canonical) and which remain DEFERRED. The migration's scope was narrower than the full IDEM-1 set.

### 7. Disk-vs-live drift — does the live state match what `fce0629` committed?

The parallel audit found one disk-vs-live drift (`cm_invoice_number_seq` migration file existed on disk but was never applied — that's what triggered B6). Look for other instances:
- For each function the migration redefined (`save_customer`, `apply_write_off`, `issue_return_credit`, `void_order`, `next_invoice_number`, `duplicate_quote`, `create_followup_delivery`, `generate_finance_charges`, `void_commission_payment`, `validate_commission_split_json`, `_insert_commissions_for_order`, `guard_completed_delivery_signature`, `compute_commission_amount`), pull `pg_get_functiondef(oid)` and confirm it matches the migration source byte-for-byte (modulo whitespace normalization).
- For the REVOKE/GRANT sweep — run the original anon-EXECUTE query from §10.1 Q4. The list should be much shorter now. Anything still anon-callable that's also a mutator? Flag as a follow-up B7+.

### 8. The two commits — clean and reversible?

- `git show fce0629` — does it show exactly 20 changed files matching §1.1 of the disposition doc, plus the 3 audit-doc files added?
- `git show a824952` — does it show only the schema-registry stamp diff?
- `git revert fce0629 a824952` — would this cleanly revert the working tree? (Don't actually run revert; just inspect the diff.) Note: live DB state would NOT auto-revert — that requires a manual reverse migration. Is the reverse-migration path documented anywhere?

### 9. New findings — surface anything missed

The parallel audit explicitly tagged §10.3 with three blockers (B4/B5/B6) and §10.4 with C1. Did it miss a **B7**?
- Spot-check ALL the verification block's claims against live state, not just the 7 assertions in the SQL.
- Check security advisor (`mcp_supabase_get_advisors security`) — what changed in the count of warnings/errors before vs after this migration? Is any new advisor warning introduced by the changes?
- Check performance advisor — any new findings?
- Spot-check whether ANY frontend RPC call shape changed by the function signature changes (e.g., `next_invoice_number` no-arg overload was dropped — any frontend caller that passed zero args is now broken, even though TS types might disagree).

---

## Live verification queries to run

```sql
-- 1. Migration listed in schema_migrations
SELECT version, name FROM supabase_migrations.schema_migrations
WHERE version = '20260526090000';

-- 2. Sequence exists with default values
SELECT sequencename, start_value, increment_by, last_value, max_value
FROM pg_sequences WHERE schemaname='public' AND sequencename='cm_invoice_number_seq';

-- 3. All 7 verification block assertions hold
SELECT
  (SELECT count(*) FROM pg_proc WHERE proname='next_invoice_number' AND pronamespace='public'::regnamespace) AS overloads_should_be_1,
  has_function_privilege('anon', 'public.apply_write_off(uuid,bigint,text,uuid,text)', 'EXECUTE') AS anon_apply_writeoff_should_be_false,
  has_function_privilege('anon', 'public.execute_sql_readonly(text)', 'EXECUTE') AS anon_exec_sql_should_be_false,
  has_function_privilege('anon', 'public.unapply_credit_memo(uuid,text,uuid,text)', 'EXECUTE') AS anon_unapply_should_be_false,
  EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE c.relkind='S' AND n.nspname='public' AND c.relname='cm_invoice_number_seq') AS cm_seq_should_be_true,
  (SELECT count(*) FROM pg_proc WHERE proname='validate_commission_split_json' AND pronamespace='public'::regnamespace) AS validate_fn_should_be_1,
  (SELECT count(*) FROM pg_proc WHERE proname='guard_completed_delivery_signature' AND pronamespace='public'::regnamespace) AS guard_fn_should_be_1;

-- 4. Count of anon-executable SECDEF mutating-class functions after the sweep
-- (should be much smaller than the 215 the prior audit counted)
SELECT count(*)
FROM pg_proc p
WHERE p.pronamespace='public'::regnamespace
  AND p.prosecdef
  AND p.proname !~ '^_'
  AND has_function_privilege('anon', p.oid, 'EXECUTE') = true
  AND p.proname ~* '^(apply|approve|auto|batch|cancel|close|complete|confirm|convert|create|delete|duplicate|edit|generate|issue|link|load|manual|mark|post|receive|reassign|record|reconcile|release|reopen|restore|retire|retry|reverse|revert|rollover|save|start|transition|transfer|unlink|update|void)';

-- 5. Generated columns still GENERATED ALWAYS (no regression)
SELECT table_name, column_name, generation_expression
FROM information_schema.columns
WHERE table_schema='public' AND is_generated='ALWAYS'
ORDER BY table_name;

-- 6. _insert_commissions_for_order is now SECURITY INVOKER (B3)
SELECT proname, prosecdef AS is_definer
FROM pg_proc WHERE proname='_insert_commissions_for_order' AND pronamespace='public'::regnamespace;

-- 7. Function definition diff — read each redefined function's live source
-- and compare against the migration SQL
SELECT pg_get_functiondef(oid)
FROM pg_proc WHERE proname IN (
  'save_customer','apply_write_off','issue_return_credit','void_order',
  'next_invoice_number','duplicate_quote','create_followup_delivery',
  'generate_finance_charges','void_commission_payment',
  'validate_commission_split_json','_insert_commissions_for_order',
  'guard_completed_delivery_signature','compute_commission_amount'
) AND pronamespace='public'::regnamespace
ORDER BY proname;

-- 8. Trigger registered correctly
SELECT pg_get_triggerdef(oid)
FROM pg_trigger
WHERE tgname='trg_guard_completed_delivery_signature';

-- 9. Verify anon table-level DML revoke held
SELECT count(*) FROM information_schema.role_table_grants
WHERE grantee='anon' AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')
  AND table_schema='public';
-- Expected: 0
```

For the deployed Edge Functions, use:

```
mcp_supabase_list_edge_functions
-- Expected: reset-user-password v12 ACTIVE, create-user v19 ACTIVE.

mcp_supabase_get_edge_function(slug='reset-user-password')
mcp_supabase_get_edge_function(slug='create-user')
-- Then diff each against supabase/functions/<slug>/index.ts and _shared/{auth,sentry}.ts
```

---

## Output format

For each section above: **AGREE / DISAGREE / NEEDS-MORE-INFO**, with file:line OR DB-object evidence and your severity (P0/P1/P2/P3/INFO). Then:

- **New findings** (B7+) the parallel audit missed (full detail + severity + proposed fix).
- **Regression check:** did any of the 4 parallel-audit additions (B4/B5/B6/C1) introduce a NEW problem?
- **Deploy verdict:** were the two Edge Function deploys correct, or should one be rolled back?
- **Live-state verdict:** does the live database match the disposition doc + commit fce0629's claims, or is there drift?
- **Final call:** is the audit remediation safe to push (`git push origin main`), or should we hold for a fix first?

Be specific. If you find Codex's regex in the migration handles a case incorrectly, show the query that proves it.

---

## Sign-off criteria

Codex signs off when:
1. All 7 verification-block assertions held live (queryable).
2. Both Edge Function deploys match repo source byte-for-byte.
3. No new B7+ blocker found.
4. The B2 reversion in `CustomerDetail.tsx` is correct AND `assertRpcCoverage` test passes.
5. Live state matches the commit's claims.
6. No frontend regression introduced by the function signature/behavior changes.

If any item fails, flag it with severity + proposed fix. Do NOT execute any fix yourself — report only.

---

*Generated 2026-05-26 by the parallel Claude session that executed Phases 1-7 of the remediation. Cross-references:*
- *`docs/audits/2026-05-26-claude-disposition-of-codex-execution.md` §10 (parallel reconciliation)*
- *`docs/audits/2026-05-25-full-codebase-ultra-review.md` (original 10-domain audit)*
- *`docs/audits/2026-05-25-14-domain-review-supplement.md` (14-domain supplement)*
- *`docs/audits/2026-05-25-codex-review-prompt.md` (the pre-remediation Codex prompt — same workflow, different scope)*
- *Commits `fce0629` (main) + `a824952` (schema-registry).*
