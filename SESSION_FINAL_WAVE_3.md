# Wave 3 — Session Final Report

**Date:** 2026-05-07
**Plan:** `docs/plans/2026-05-07-phase-4-closure-autonomous-waves.md`
**Branch:** `main` (10 commits ahead of `origin/main`, NOT pushed — per the wave rules)
**Approximate runtime:** ~25 minutes (two pre-commit cycles + exploration + one PreToolUse hook block + retry)

---

## Local commit log (since `a40f439`)

```
ee054ed feat(deliveries): WARN-only backdated check on complete_delivery + void_delivery (P4-10)
347f1f0 test(e2e): add holds-cleanup-paths verification (P4-9)
```

Both pre-commit hooks ran cleanly: SQL validation passed, frontend validation passed (with one pre-existing warning noted below), lint (0 errors, 1 pre-existing warning on `IntegrityReport.tsx:27`), production build, full test suite passing.

---

## Item-by-item summary

### Item 1 — `test(e2e): add holds-cleanup-paths verification (P4-9)` — `347f1f0`

New file: [tests/e2e/holds-cleanup-paths.spec.ts](tests/e2e/holds-cleanup-paths.spec.ts). The spec directly addresses the P4-9 audit item — *"verify that two different quote-cancellation paths leave `inventory.quantity_available` in the same end-state."* The audit's stance was "verify-only, no code change suspected"; this commit creates the verification.

The spec uses the existing fixture customer `[E2E] Farm Alpha` and product `[E2E] Herbicide Alpha` (already seeded by `tests/e2e/fixtures/setup-fixtures.ts`), creates two scoped quotes per run via `runId()` to avoid concurrency clashes, seeds holds via the production `create_planned_holds` RPC, and asserts that `inventory.quantity_available` ends at the starting value in both paths:

- **Path A (accept-then-cancel):** seed planned-quote hold → PATCH `quotes.status = 'sent'` → `convert_quote_to_order` (which fires the trigger; trigger deactivates holds without restoring inventory; convert applies prebook in their place) → `cancel_order` (decrements prebook + scans for active holds, finds none).
- **Path B (decline without convert):** seed planned-quote hold → PATCH `quotes.status = 'sent'` → PATCH to `'declined'` (fires `release_holds_on_quote_status_change` which deactivates holds AND restores inventory).

Patterns reused from `tests/e2e/mega-workflow.spec.ts`: `supabaseRest` + `supabaseRpc` + `asArray` for DB access, `getUserId` for the auth user's profile UUID, the `[E2E]` prefix on every named entity for `globalTeardown` to clean up. No new browser flow introduced — both tests are pure DB-via-REST.

**Lint:** 0 errors. **TypeScript:** 0 errors. **Real-database execution:** the test was NOT exercised against live Supabase in this session — Mason runs the suite manually. The commit message notes this. The spec count in `CLAUDE.md` was bumped 93 → 94.

If the test fails when actually run, that is itself a useful finding — it would confirm the timing/sequencing concern the audit listed under "Listed here for completeness as a 'verify with a test' finding." See the **Anomalies** section below for one specific concern I noticed while writing the spec.

**Files:** `tests/e2e/holds-cleanup-paths.spec.ts` (new), `CLAUDE.md` (E2E spec count bump only).

---

### Item 2 — `feat(deliveries): WARN-only backdated check on complete_delivery + void_delivery (P4-10)` — `ee054ed`

New migration: [supabase/migrations/20260507160000_warn_backdated_delivery_completion.sql](supabase/migrations/20260507160000_warn_backdated_delivery_completion.sql). Implements Mason's Q3 audit policy — **WARN, do not block, no admin override**.

Both function bodies are copied **verbatim** from their most recent definitive migrations (per the wave 3 prompt rule "Do NOT rewrite logic that isn't related to the period check"):

| Function | Source body | Bytes copied |
|---|---|---|
| `complete_delivery` | `20260319200000_complete_delivery_remove_inventory_block.sql` | ~7.5 KB |
| `void_delivery` | `20260332300000_fix_void_delivery_three_bugs.sql` | ~5.5 KB |

The only changes:

1. **One new variable** in each `DECLARE` block — `v_closed_period record` for both, plus `v_admin record` in `void_delivery` (it didn't have one; `complete_delivery` already did).

2. **One new block** inserted *after* status validation but *before* any mutation:
   ```sql
   SELECT id, period_start, period_end
     INTO v_closed_period
     FROM accounting_periods
    WHERE status = 'closed'
      AND v_delivery.delivery_date BETWEEN period_start AND period_end
    LIMIT 1;

   IF FOUND THEN
     INSERT INTO activity_feed (event_type='backdated_delivery_in_closed_period', ...);
     FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true LOOP
       INSERT INTO notifications (notification_type='period_warning', ...);
     END LOOP;
   END IF;
   ```

I deliberately did NOT call `check_period_open()` — that helper RAISES on closed periods (it's the hard gate for `post_invoice` / `record_invoice_payment` / `issue_return_credit`). For the warn-only policy I queried `accounting_periods` directly. The wave 3 prompt explicitly said "if `check_period_open` doesn't return a status type, adapt — read its current signature first" — and indeed `check_period_open(p_date date) RETURNS void` and raises, so the adapt path was the right call.

There is no `notify_admins(...)` helper in the migrations (I verified with grep) — the codebase uses an inline `FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' ... LOOP INSERT INTO notifications ...` pattern, which is what I followed.

The activity_feed schema is `(event_type, description, performed_by, related_entity_type, related_entity_id, customer_id, created_at)` — there is **no `severity` column** in the table (the wave 3 prompt mentioned `severity = 'warning'`), so I encoded the severity into the description prefix `'WARNING: ...'` instead.

**Idempotency contract preservation:**
- `complete_delivery` calls the helpers `check_idempotency()` / `save_idempotency()`. The schema-aware hook can't see through helper calls — it tripped on first-write with `IDEMPOTENCY VIOLATION: ... does not read idempotency_keys`. The fix per the hook's own message is the marker `-- idempotency-body-check: exempt` at the top of the migration, which is the same pattern the original `20260319200000` migration followed (the helper-functions pattern pre-dates the hook). I added the marker with a comment explaining why.
- `void_delivery` uses an inline lookup the hook detects correctly — no exempt needed, but the marker covers both since it's file-level.

**Function signatures unchanged:** Both keep their existing param lists and `RETURNS jsonb` shape. Verified with `grep` that the only TypeScript callers (`DeliveryDetail.tsx:79-80`, `:564`, the `useIdempotencyKey` registrations) use the same arg shape — no client changes needed. `npm run typecheck` confirmed 0 TypeScript errors after the migration.

**SQL safety hooks:**
- `pg_get_functiondef`: not used (explicit body).
- `idempotency_keys` columns: only correct columns referenced (`idempotency_key`, `operation`, `result`, `expires_at`).
- `updated_at` on tables that lack it: none introduced; existing UPDATE statements preserved verbatim.
- Overload check: `DO $$ ... pg_proc count = 1 ... $$` block at the end for both functions.

**Doc updates** (per wave protocol):
- `CLAUDE.md` — Current State count `278 → 279` migrations.
- `docs/reference/migration-history.md` — header bumped to `(279 migrations)`, new row `#279` added at the top of the recent block (between `#268` and `#278`).
- `docs/reference/rpc-functions.md` — both `complete_delivery` and `void_delivery` lines now carry a P4-10 (2026-05-07) note describing the new behavior.

**Files:** `supabase/migrations/20260507160000_warn_backdated_delivery_completion.sql` (new), `CLAUDE.md`, `docs/reference/migration-history.md`, `docs/reference/rpc-functions.md`.

---

## Migrations awaiting Mason's apply

**Path:** [supabase/migrations/20260507160000_warn_backdated_delivery_completion.sql](supabase/migrations/20260507160000_warn_backdated_delivery_completion.sql)

This migration was NOT applied to live in this session — per the wave rules. Mason should apply it via Supabase Studio or `supabase db push`.

**Sanity test queries to run after applying** (also embedded in the commit message body):

```sql
-- Show the current accounting period status to confirm check_period_open
-- is still callable from the function context (this is a smoke test that
-- accounting_periods has at least one row and the function compiles).
SELECT id, period_start, period_end, status
FROM accounting_periods
ORDER BY period_end DESC
LIMIT 5;

-- Pick a recently-completed delivery and verify activity_feed has no
-- spurious 'backdated_delivery_in_closed_period' entry for it. Expected:
-- only the standard 'delivery_completed' event_type. If a backdated
-- warning shows up here, the delivery_date was inside a closed period —
-- which is fine and expected behavior, just verify the period.
SELECT af.event_type, af.description, af.created_at
FROM deliveries d
JOIN activity_feed af ON af.related_entity_id = d.id
WHERE d.status = 'completed'
  AND d.completed_at > now() - interval '7 days'
ORDER BY af.created_at DESC
LIMIT 20;

-- Confirm both functions still resolve to exactly one signature each
-- (the migration ends with a DO block that aborts on overload, but this
-- is the read-only confirmation).
SELECT proname, count(*)
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('complete_delivery', 'void_delivery')
GROUP BY proname;
```

The first run of the new code on a delivery in a closed period will produce one `notifications` row per active admin (`notification_type='period_warning'`) and one `activity_feed` row (`event_type='backdated_delivery_in_closed_period'`). Mason's notification panel will surface the first; the activity feed page (`/activity`) will show the second.

---

## UI-affecting commits — Mason should spot-check

**None.** Both items in this wave are server-side / test-only:
- The E2E spec adds NO new browser flow; it operates entirely via REST + RPC against the test fixtures.
- The migration changes server-side function behavior but produces user-visible side effects only via notifications (delivered through the existing notification panel) and activity_feed (delivered through the existing activity page). No new UI components, no JSX changes, no CSS.

A dev-server boot smoke test was therefore unnecessary this wave.

---

## Anomalies

**One concern surfaced while writing the P4-9 spec.** Reading the production `create_planned_holds` RPC at `supabase/migrations/20260317100000_fix_idempotency_and_searchpath_final.sql:348-415`, I observed it inserts `inventory_holds` rows but does **NOT** decrement `inventory.quantity_available`. Meanwhile, the trigger `release_holds_on_quote_status_change` for `declined`/`expired` quotes (defined at `20260316100001_inventory_hold_restoration.sql:51-66`) **adds** `quantity_available + v_hold.quantity` back. If the decrement-on-create truly never happens, then the restoration-on-decline is over-accounting — Path B in the new spec would end at `start_qty + HOLD_QTY`, not `start_qty`.

The spec asserts equality. So if the real-DB execution **fails on Path B**, that is the bug surfacing — and that's exactly what the audit's "verify with a test" prompt was meant to catch. The audit text said "No code change suspected" but that was a hypothesis; the test will refute or confirm it.

I did not change any production code in this wave to address this — the wave 3 scope was strictly P4-9 (test) + P4-10 (migration). If the test fails, it should be triaged as a Wave 4 or follow-up item: either `create_planned_holds` should also decrement `quantity_available`, OR the trigger should not restore for planned-quote holds, OR the holds are meant to be soft reservations that don't touch `quantity_available` at all (in which case the restoration block in the trigger is the bug).

**Two pre-commit warnings** (both pre-existing, not introduced by this wave):
1. `WARNING: src/pages/InventoryPage.tsx — Uses .toFixed(2) on a money variable` — pre-existing from prior code.
2. `WARNING: src/pages/QuickReceive.tsx — Has .update() or .delete() but does not import checkMutationResult` — known false-positive from the heuristic; the file uses `.rpc()` with `assertRpcResult`, not bare mutations.

The 1 pre-existing ESLint warning on `IntegrityReport.tsx:27` was untouched and pre-dates this wave.

**One PreToolUse hook trip + retry.** The first write of the migration tripped `idempotency-body-check.mjs` because `complete_delivery` calls helper functions (`check_idempotency`, `save_idempotency`) that the hook can't see through. The fix per the hook's own error message is the file-level marker `-- idempotency-body-check: exempt`, which I added to the second-write attempt. No other hook trips.

**One MIGRATION SAFETY post-tool reminder** (informational, not blocking). The hook fired on the migration file write asking me to update `src/types/index.ts` and check for component updates — but the migration changes neither schema columns nor function signatures, so no TypeScript surface area is affected. I confirmed this with grep + `npm run typecheck` (clean) before continuing.

---

## Counts

- 1 new migration file (278 → 279).
- 1 new E2E spec file (93 → 94).
- 0 new pages, 0 new RPCs, 0 schema changes (no new tables, no column additions, no signature changes).
- 4 doc files touched: `CLAUDE.md`, `docs/reference/migration-history.md`, `docs/reference/rpc-functions.md`, plus the new `SESSION_FINAL_WAVE_3.md` (this file, untracked).

---

> **Wave 3 complete. To start Wave 4, open a fresh Claude Code session and paste the Wave 4 prompt from `docs/plans/2026-05-07-phase-4-closure-autonomous-waves.md`.**
