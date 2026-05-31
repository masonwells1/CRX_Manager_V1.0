# Phase 4 Closure Plan — Pre-Execution Review & Reconciliation Tracker

**Created:** 2026-05-07
**Reviewer:** Claude Opus 4.7 (1M context), independent pass
**Plan reviewed:** [docs/plans/2026-05-07-phase-4-closure-autonomous-waves.md](../plans/2026-05-07-phase-4-closure-autonomous-waves.md)
**Purpose:** track which of these findings get addressed during the Wave 2/3/4 implementation, and reconcile with a second-opinion Opus review at the end before commit.

---

## How to use this document

1. **During implementation** — as Mason or an agent works through the plan, mark each finding's `Status` field below as work progresses. The Status Dashboard at the top is the at-a-glance view.
2. **Before committing the final batch** — paste the [second-opinion review prompt](#second-opinion-review-prompt) at the bottom of this doc into a fresh Claude Code session. That session writes its findings into the [Second-Opinion Notes](#second-opinion-notes) section.
3. **Reconciliation pass** — walk through every finding in this doc. For each, confirm:
   - Was it addressed? (Status = DONE)
   - Did the second-opinion reviewer agree? (yes/no/added detail)
   - Are we satisfied with the resolution, or do we need to redo something? (Decision field)
4. **If anything needs redoing**, log it in the [Reconciliation Punch List](#reconciliation-punch-list) section at the bottom and fix it before the final commit.

**Status legend:**
- `TODO` — not started
- `IN PROGRESS` — being worked on now
- `DONE` — addressed in code
- `SKIP` — intentionally skipped (with reason in Decision field)
- `N/A` — finding turned out to be wrong on closer inspection

---

## Status Dashboard

| # | Finding | Severity | Wave | Status | Decision/Notes |
|---|---|---|---|---|---|
| 1 | Wave 4 SQL — wrong `activity_feed` columns | 🟥 BLOCKER | 4 | DONE | Verified in `20260507170000_create_inventory_hold_rpc.sql:138-148` — correct columns used. Implementer flagged the issue inline. |
| 2 | Wave 4 SQL — raw idempotency vs canonical helpers | 🟥 BLOCKER | 4 | DRIFT NOTED | `20260507170000` uses Wave A.6's raw-SQL idempotency pattern (cited as precedent in comment), NOT Wave B.2's `check_idempotency()`/`save_idempotency()` helpers. Both patterns exist in the codebase. Defensible but inconsistent — could be normalized in a future cleanup sprint. Not blocking. |
| 3 | Wave 3 — `notify_admins()` doesn't exist | 🟥 BLOCKER | 3 | DONE | Wave 3 migration `20260507160000` uses inline `FOR v_admin IN ... LOOP INSERT INTO notifications` pattern. |
| 4 | Wave 4 — references stale `complete_delivery` migration | 🟧 STALE | 4 | DONE | Migration `20260507160000` corrected 2026-05-07 to use latest canonical body from `20260331200000_fix_complete_delivery_precheck.sql`, restoring the inventory-precheck fix that was accidentally erased. Typecheck passed. |
| 5 | InventoryPage line numbers stale (post-Wave-B.3) | 🟧 STALE | 2, 4 | TODO | |
| 6 | Wave 2 Item 1 (P4-13) already done | 🟦 SCOPE | 2 | TODO | |
| 7 | Wave 2 Item 3 (P4-12) half-done; only frontend needs fix | 🟦 SCOPE | 2 | TODO | |
| 8 | Strict actor pattern conflicts with codebase | 🟨 DRIFT | 4 | ADOPTED | `20260507170000:58-65` uses strict pattern with `AUTH_REQUIRED`/`ACTOR_MISMATCH`. Comment cites "Phase 13" — not yet verified that's a documented standard. Now a one-off in the codebase unless other RPCs migrate to match. Decide: leave as-is, or open a follow-up to normalize. |
| 9 | Force-retry UX has no precedent | 🟨 DRIFT | 4 | ADOPTED | `InventoryPage.tsx:373-405` first attempts non-force; on `INSUFFICIENT_HOLD_INVENTORY` error, pops `ReasonModal` (admin) or toasts error (sales rep), then retries with `p_force=true`. Clean implementation; "UX preview only" comment makes intent explicit. New pattern in codebase. |
| 10 | Error string convention diverges | 🟨 DRIFT | 4 | ADOPTED | RPC uses machine codes (`INSUFFICIENT_HOLD_INVENTORY`, `INVALID_QUANTITY`, etc.) so frontend can parse for force-retry. Codes carry human-readable suffixes (`:118-123`) so error toasts still readable. Consistent within this RPC. |
| 11 | Self-review scope only covers Waves 1-4 | 🟦 SCOPE | 4 | TODO | |
| 12 | Wave 4 time budget too low | 🟦 SCOPE | 4 | TODO | |
| 13 | `SESSION_FINAL_WAVE_1.md` was missing | 🟦 SCOPE | 2 | DONE | Mason created it manually during 2026-05-07 session. |

---

## Severity legend

- **🟥 BLOCKER** — autonomous run will fail or apply-broken SQL. Must address before Wave 4 commits.
- **🟧 STALE** — line numbers, file paths, or function bodies the plan cites no longer match current code. Wastes agent time.
- **🟨 DRIFT** — plan diverges from canonical patterns. Code works but creates inconsistency.
- **🟦 SCOPE** — item already done, fix targets non-existent bug, or scope/time off.

---

## Finding 1 🟥 BLOCKER — Wave 4 Item 1 SQL skeleton uses wrong `activity_feed` columns

**Status:** TODO
**Wave:** 4 Item 1
**Where in plan:** lines 471–479 (`INSERT INTO activity_feed` inside `create_inventory_hold` skeleton)

**The problem:**
Plan SQL writes into columns named `(event, description, performed_by, entity_type, entity_id, severity)`. None of those names match the real `activity_feed` table.

**Real schema** (confirmed in 4 places):
| Plan column | Real column |
|---|---|
| `event` | `event_type` |
| `description` | `description` ✓ |
| `performed_by` | `performed_by` ✓ |
| `entity_type` | `related_entity_type` |
| `entity_id` | `related_entity_id` |
| `severity` | does not exist; real column is `customer_id` |

**Evidence:**
- [supabase/migrations/20260507110000_returns_lifecycle_rebuild.sql:99-105](../../supabase/migrations/20260507110000_returns_lifecycle_rebuild.sql) (Wave B.2)
- [supabase/migrations/20260331200000_fix_complete_delivery_precheck.sql:194-202](../../supabase/migrations/20260331200000_fix_complete_delivery_precheck.sql)
- [supabase/migrations/20260311200000_wave2_audit_fixes.sql:1309-1316](../../supabase/migrations/20260311200000_wave2_audit_fixes.sql)
- [supabase/migrations/20260228200000_safety_audit_hardening.sql:772-779](../../supabase/migrations/20260228200000_safety_audit_hardening.sql)

**Impact:** running this migration would fail at apply-time with `column "event" of relation "activity_feed" does not exist`. Mason would see the error during Supabase apply and have to abort.

**Fix:** rewrite plan lines 471–479 to use real columns. Drop the `severity` field; `customer_id` can be `NULL` for non-customer holds or `p_customer_id` for hold-against-customer.

**Verification step (post-implementation):** open the new `create_inventory_hold` migration. Search for `INSERT INTO activity_feed`. Confirm the column list matches `(event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)`.

**Decision/Notes:** _(fill in when reconciling)_

---

## Finding 2 🟥 BLOCKER — Wave 4 Item 1 idempotency uses raw SQL instead of canonical helpers

**Status:** TODO
**Wave:** 4 Item 1
**Where in plan:** lines 401–406 and 482–487

**The problem:**
Plan uses direct table access:
```sql
SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key;
...
INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at) VALUES (...);
```

**Canonical pattern in this codebase** (used by every other RPC):
```sql
v_existing := check_idempotency(p_idempotency_key, 'create_inventory_hold');
IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
...
PERFORM save_idempotency(p_idempotency_key, 'create_inventory_hold', v_result);
```

**Helper functions defined at:** [supabase/migrations/20260210000000_tier3_idempotency_and_triggers.sql:36, 60](../../supabase/migrations/20260210000000_tier3_idempotency_and_triggers.sql)

**Used by, for example:**
- `release_inventory_hold` ([supabase/migrations/20260311200000_wave2_audit_fixes.sql:1283-1284, 1322](../../supabase/migrations/20260311200000_wave2_audit_fixes.sql))
- Every Wave B.2 RPC ([supabase/migrations/20260507110000_returns_lifecycle_rebuild.sql:69-72, 110](../../supabase/migrations/20260507110000_returns_lifecycle_rebuild.sql))
- `cancel_cycle_count` ([supabase/migrations/20260501130000_field_app_workflow_phase18.sql:174-176, 200-202](../../supabase/migrations/20260501130000_field_app_workflow_phase18.sql))

**Impact:** the migration would technically work, but it adds a 7th-style outlier in a codebase that's been deliberately standardized. Wave A.6 (commit `d8bdbee`) was specifically about consolidating on these helpers. Going off-script here undoes that work.

**Fix:** use `check_idempotency()` / `save_idempotency()` like the rest of the codebase.

**Verification step:** in the new migration, grep for `idempotency_keys`. The only direct reference to that table should be implicit through the helper calls. Direct `SELECT ... FROM idempotency_keys` or `INSERT INTO idempotency_keys` is a smell.

**Decision/Notes:** _(fill in when reconciling)_

---

## Finding 3 🟥 BLOCKER — Wave 3 references a `notify_admins()` SQL helper that doesn't exist

**Status:** TODO
**Wave:** 3 Item 2
**Where in plan:** line 297

**The problem:**
Plan says: *"Also create an admin notification (use the existing `notify_admins(...)` helper — search for it in migrations to find current API)."*

`grep -r "notify_admins" supabase/migrations/` returns **zero hits**. The only repo hit is in `src/lib/activityLogger.ts` (frontend code, not callable from SQL).

**How admin notifications actually work in this codebase:**
Direct loop with `INSERT INTO notifications`. Example from `complete_delivery`:
```sql
FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true LOOP
  INSERT INTO notifications (user_id, type, title, message, related_entity_type, related_entity_id)
  VALUES (v_admin.id, 'warning', 'Title', 'Message', 'entity_type', entity_id);
END LOOP;
```

(See [supabase/migrations/20260319200000_complete_delivery_remove_inventory_block.sql:191-214](../../supabase/migrations/20260319200000_complete_delivery_remove_inventory_block.sql) for the canonical pattern.)

**Impact:** the autonomous Wave 3 agent will burn time grepping for a function that doesn't exist, then either invent one (drift) or stall. Plan must specify the inline pattern.

**Fix:** replace plan line 297 with the inline `FOR v_admin IN ... LOOP INSERT INTO notifications` pattern (adapted to whatever fields the `notifications` table actually has — verify schema first).

**Verification step:** open the Wave 3 backdated-delivery-WARN migration. Search for `notify_admins`. Should be **zero hits** in the SQL. Search for `INSERT INTO notifications` — should match the canonical pattern.

**Decision/Notes:** _(fill in when reconciling)_

---

## Finding 4 🟧 STALE — Wave 4 Item 2 references the wrong `complete_delivery` migration

**Status:** TODO
**Wave:** 4 Item 2
**Where in plan:** line 515

**The problem:**
Plan says: *"Update `complete_delivery` to set the flag in the IF FOUND ... ELSE INSERT branch (lines :128-136 of `20260319200000_complete_delivery_remove_inventory_block.sql`)."*

The latest `complete_delivery` is in [supabase/migrations/20260331200000_fix_complete_delivery_precheck.sql](../../supabase/migrations/20260331200000_fix_complete_delivery_precheck.sql) (12 days **after** the migration the plan cites). The newer body uses a pre-loop physical-stock check that **RAISES EXCEPTION** if no inventory row exists — there is no `IF FOUND ... ELSE INSERT` branch in current code.

**Critical follow-on:** the bug P4-7 was trying to fix (auto-creating an inventory row at -X) **may already be gone**. Wave 4 Item 2 might spend an hour writing a `manufactured_at_delivery` column for a code path that no longer exists.

**Impact:** P4-7's premise is invalidated. Need to verify current behavior before doing the work.

**Fix:** before kicking off Wave 4 Item 2, re-verify by reading the latest `complete_delivery` body end-to-end. If the auto-create-at-negative branch is genuinely gone, P4-7 collapses to a doc-only "verified, no longer applicable" commit.

**Verification step:** read [supabase/migrations/20260331200000_fix_complete_delivery_precheck.sql](../../supabase/migrations/20260331200000_fix_complete_delivery_precheck.sql) lines 80–140. Confirm whether (a) the function raises if no row exists, (b) silently no-ops, or (c) auto-creates a new row. Decide whether `manufactured_at_delivery` is still needed.

**Decision/Notes:** _(fill in when reconciling)_

---

## Finding 5 🟧 STALE — Plan's `InventoryPage.tsx` line numbers are pre-Wave-B.3

**Status:** TODO
**Wave:** 2 Item 2, 4 Item 1

**The problem:**
Wave B.3 (commit `88d6d22`) refactored `InventoryPage.tsx` from 1554 lines down to 1445. Plan citations:

| Plan reference | Plan claim | Actual location (current code) |
|---|---|---|
| Wave 2 Item 2 (line 197) | "manual-hold warning at `:319`" | `:329-334` |
| Wave 2 Item 2 (line 195) | "adjust modal (~lines 1497-1517)" | `:1387-1404` (file ends at line 1445) |
| Wave 4 Item 1 (line 496) | "hold-creation handler (~lines 333-343)" | `:338-346` |
| Wave 4 Item 1 (line 498) | "browser-side warning at line 319" | `:329-334` |

**Impact:** mostly time-wastage. Autonomous agent will read wrong lines, then have to grep for the actual code.

**Fix:** patch the plan with corrected line numbers, OR replace with name-based grep targets like *"the `handleCreateHold` function"* and *"the Adjust Modal `<Modal open={adjustOpen}` block"* — names are stable across refactors, line numbers aren't.

**Verification step:** when reviewing implementation, confirm the agent edited the right code by grepping for `handleCreateHold` and `Manual Adjustment` modal title — not by line number.

**Decision/Notes:** _(fill in when reconciling)_

---

## Finding 6 🟦 SCOPE — Wave 2 Item 1 (P4-13) is already done

**Status:** TODO
**Wave:** 2 Item 1

**The problem:**
Plan instructs the agent to *add* a disabled-button-with-tooltip for non-admin users on the receiving-log reverse button. The pattern is **already implemented** at [src/pages/PurchaseOrderDetail.tsx:746-763](../../src/pages/PurchaseOrderDetail.tsx):

```tsx
{isAdmin ? (
  <button onClick={() => openReverseModal(rec)} ...>
    <RotateCcw className="w-4 h-4" />
  </button>
) : (
  <button disabled
    title="Ask an admin to reverse this receive."
    aria-label="Ask an admin to reverse this receive">
    <RotateCcw className="w-4 h-4" />
  </button>
)}
```

**Impact:** Wave 2 Item 1 collapses to a doc-only "verified, already implemented" commit. Saves ~30 minutes.

**Fix:** when the agent reaches Wave 2 Item 1, it should verify the current code, NOT add the pattern again. Update CHANGELOG to note "verified P4-13 already implemented in `PurchaseOrderDetail.tsx`."

**Verification step:** confirm no commit modifies `PurchaseOrderDetail.tsx` to add a disabled-button-with-tooltip in this work session — it's already there.

**Decision/Notes:** _(fill in when reconciling)_

---

## Finding 7 🟦 SCOPE — Wave 2 Item 3 (P4-12) is half done; only frontend needs fix

**Status:** TODO _(file `src/pages/CycleCounts.tsx` was modified in working tree as of 2026-05-07 — likely this fix in progress)_
**Wave:** 2 Item 3

**The problem:**
Plan instructs the agent to verify or fix `cancel_cycle_count` idempotency on both server and client.

**Server side (already complete):** [supabase/migrations/20260501130000_field_app_workflow_phase18.sql:147-208](../../supabase/migrations/20260501130000_field_app_workflow_phase18.sql) — the RPC has `p_idempotency_key` param + `check_idempotency` + `save_idempotency` + admin-only auth. Properly built.

**Client side (still broken):** [src/pages/CycleCounts.tsx:326-329](../../src/pages/CycleCounts.tsx) calls:
```typescript
const { error } = await supabase.rpc('cancel_cycle_count', {
  p_cycle_count_id: activeCount.id,
  p_performed_by: profile.id,
});
```
Does NOT pass `p_idempotency_key`. The hook for `cancel_cycle_count` doesn't even exist in the file (compare to lines 56–58 — `complete_cycle_count` and `reverse_completed_cycle_count` both have hooks; cancel does not).

**Impact:** Wave 2 Item 3 narrows to ~5 lines of frontend, no migration needed. Plan's branching instruction "If broken: write a NEW migration" is misleading.

**Fix:**
1. Add `const cancelCycleCountIdem = useIdempotencyKey('cancel_cycle_count', profile?.id || '');` near the other idempotency hooks at the top of the component.
2. In `executeCancelCount`, before the RPC call: `const key = cancelCycleCountIdem.getKey();`
3. Pass `p_idempotency_key: key` in the RPC payload.
4. After success: `cancelCycleCountIdem.resetKey();`

**Verification step:** open `src/pages/CycleCounts.tsx`. Confirm `useIdempotencyKey('cancel_cycle_count', ...)` exists. Confirm `executeCancelCount` passes `p_idempotency_key` to the RPC.

**Decision/Notes:** _(fill in when reconciling)_

---

## Finding 8 🟨 DRIFT — Wave 4 strict-actor pattern conflicts with rest of codebase

**Status:** TODO
**Wave:** 4 Item 1

**The problem:**
Plan SQL uses a stricter actor-validation pattern:
```sql
v_actor := auth.uid();
IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
IF p_performed_by IS NOT NULL AND p_performed_by != v_actor THEN
  RAISE EXCEPTION 'ACTOR_MISMATCH';
END IF;
```

Canonical pattern (used in `complete_delivery:44`, `release_inventory_hold:1287`, every Wave B.2 RPC):
```sql
v_actor := COALESCE(p_performed_by, auth.uid());
```

**Impact:** plan's strict pattern is more secure but creates a one-off in the codebase. Either commit to migrating all RPCs (separate sprint) or use the canonical pattern.

**Fix:** decide once. The plan claims this is "Phase 13" — if Phase 13 was actually shipped and is the new standard, find evidence in migrations. Otherwise, drop back to the canonical pattern.

**Verification step:** search migrations for "Phase 13" — confirm whether strict-actor was a designed standard or a one-off in this plan.

**Decision/Notes:** _(fill in when reconciling)_

---

## Finding 9 🟨 DRIFT — Wave 4 force-retry UX has no precedent

**Status:** TODO
**Wave:** 4 Item 1
**Where in plan:** line 498

**The problem:**
Plan says: *"If the RPC raises `INSUFFICIENT_HOLD_INVENTORY`, parse the error and show a ReasonModal (admin-only) to capture the force reason, then retry with `p_force: true`."*

`ReasonModal` exists ([src/components/ui/ReasonModal.tsx](../../src/components/ui/ReasonModal.tsx)) and is used by Returns. But the **error-parse-and-retry-with-force** flow has no existing example.

**Closest precedent:** PO over-receive ([src/pages/PurchaseOrderDetail.tsx:201-238](../../src/pages/PurchaseOrderDetail.tsx)) collects the reason **upfront** before the RPC call, not after a server rejection.

**Impact:** the autonomous agent will be writing a novel UX with no reference. Likely outcomes: rough edges, OR the agent gives up and uses the upfront-prompt pattern (which contradicts the plan).

**Fix:** either explicitly reference an existing example to mirror, OR rewrite the instruction to match the upfront pattern: "Show a force-toggle checkbox in the hold modal (admin-only). When checked, prompt for reason via ReasonModal. Pass `p_force: true` and `p_force_reason` only if checked."

**Verification step:** when reviewing the implemented hold-creation flow, confirm whether it shows the reason prompt before or after the first failed attempt. Either is OK if conscious.

**Decision/Notes:** _(fill in when reconciling)_

---

## Finding 10 🟨 DRIFT — Wave 4 error string convention diverges

**Status:** TODO
**Wave:** 4 Item 1

**The problem:**
Plan strings: `'AUTH_REQUIRED'`, `'INSUFFICIENT_ROLE'`, `'INSUFFICIENT_HOLD_INVENTORY'`, `'FORCE_REQUIRES_ADMIN'`, `'FORCE_REQUIRES_REASON'`, `'INVALID_HOLD_TYPE'`.

Canonical (used by `complete_delivery`, `release_inventory_hold`): plain English, e.g. `'Only admin or sales_rep can complete deliveries'`, `'Inventory hold not found'`.

**Tradeoff:**
- Plan codes are parseable by frontend (`error.message.startsWith('INSUFFICIENT_')`) — needed for the force-retry flow.
- Canonical strings are user-readable — fine for direct toast display.

**Impact:** mixed convention in the codebase. Frontend's force-retry logic needs a parseable signal — but the plan also tells the frontend to "show error as toast" which assumes user-readable.

**Fix:** decide. If retry-on-force is needed, machine codes are right; tell the frontend to translate them via a `humanizeHoldError(code)` helper. If the upfront-pattern from Finding 9 is adopted, plain English is fine.

**Verification step:** read the implemented `create_inventory_hold` RPC errors. If they're machine codes, confirm the frontend translates them for the user.

**Decision/Notes:** _(fill in when reconciling)_

---

## Finding 11 🟦 SCOPE — Wave 4 self-review only covers Waves 1-4, not Waves A & B

**Status:** TODO
**Wave:** 4 Item 4

**The problem:**
Plan instruction (line 585): *"Run `git log <wave-1-base>..HEAD --oneline` to list every commit landed across Waves 1-4."*

The original Wave A and Wave B work (~13 commits from `a419da8` through `cdcce80` plus `9f1b2b9`) is also part of the Phase 4 closure. Wave B.3 had its own self-review (commit `cdcce80`) but only of itself.

**Impact:** if the goal of the self-review is "did we close Phase 4 cleanly?", scoping it to the new Waves 1–4 leaves ~13 commits' worth of risk un-reviewed.

**Fix:** decide. Either expand the self-review base to `e6dd416` or earlier (covers all of Waves A + B + 1–4), OR explicitly scope-down to "the 4-wave autonomous-run output only" and accept that Waves A & B were only reviewed at-the-time.

**Verification step:** when the self-review pass runs, confirm what commit range it actually audits.

**Decision/Notes:** _(fill in when reconciling)_

---

## Finding 12 🟦 SCOPE — Wave 4 is under-budgeted at 3-4 hours

**Status:** TODO
**Wave:** 4

**The problem:**
Plan estimates Wave 4 at 3–4 hours. My estimate: 5–7 hours.

**Why:** Wave 4 has two heavy migrations (each requires reading current `complete_delivery` body, copying verbatim, adding the diff carefully, plus sanity-test SQL); a frontend rewire of hold creation with a novel force-retry UX (Finding 9); a sprayer-packet TODO doc; AND a self-review pass over potentially 13+ commits. Pre-commit hook is 4–5 min × ~6 commits = 25–30 min just in hook time.

**Impact:** if Mason kicks off Wave 4 expecting 4 hours, he'll be tempted to interrupt — which is the worst time to interrupt an autonomous run.

**Fix:** rebudget to 6 hours, OR split Wave 4 into 4a (P4-3 RPC + sprayer TODO) and 4b (P4-7 + self-review).

**Verification step:** record actual wall-clock time when Wave 4 runs. Compare to estimate.

**Decision/Notes:** _(fill in when reconciling)_

---

## Finding 13 🟦 SCOPE — Wave 1 final report was missing → resolved

**Status:** DONE
**Wave:** 2 (entry condition)

**The problem:**
Wave 2's prompt instructs the agent to read `SESSION_FINAL_WAVE_1.md` at the repo root. Wave 1 shipped 4 commits but no such file was written.

**Resolution:** Mason created `SESSION_FINAL_WAVE_1.md` manually during the 2026-05-07 session. Wave 2 should now find the file when it kicks off.

**Decision/Notes:** Resolved without further action. Going forward, autonomous waves should be modified to fail-soft when their predecessor's final report is missing — but that's a plan-template improvement, not a current-task blocker.

---

# Second-Opinion Review

When all current implementation work is finished and ready to commit, paste the prompt below into a fresh Claude Code session (Opus 4.7, 1M context recommended). The session writes its findings into the [Second-Opinion Notes](#second-opinion-notes) section below. Then reconcile.

## Second-Opinion Review Prompt

```
You are an independent reviewer. Mason Wells (CRX Manager V1.0 owner, 0 coding experience) has a 4-wave autonomous-run plan at docs/plans/2026-05-07-phase-4-closure-autonomous-waves.md and an internal review of that plan at docs/audits/2026-05-07-phase-4-closure-plan-review.md. The implementation work has just finished; nothing has been committed yet. Your job is to independently verify (a) the plan, (b) the internal review, and (c) the actual implemented changes — do NOT modify code or commit anything.

Read in this order:
1. CLAUDE.md (project rules, current state, hard red lines)
2. docs/workflows/SAFE_DEVELOPMENT_RULES.md (mandatory safety rules)
3. docs/plans/2026-05-07-phase-4-closure-autonomous-waves.md (the plan)
4. docs/audits/2026-05-07-phase-4-closure-plan-review.md (the internal review — that is what YOU are double-checking)
5. docs/audits/2026-05-04-phase-4-inventory-purchasing-audit.md (the original audit)
6. docs/audits/2026-05-04-complete-software-excellence-audit-summary.md (master summary)
7. The 10 audit Q&A answers Mason gave on 2026-05-06 (memory file or inline conversation)

Then run `git status` and `git diff` against `origin/main` (or against the latest pushed commit) to see what implementation actually changed. Verify each of the 13 findings in the internal review against the actual code:

- BLOCKER 1 (activity_feed columns): grep the new migration's INSERT INTO activity_feed. Does it use event_type, related_entity_type, related_entity_id, customer_id?
- BLOCKER 2 (idempotency helpers): grep the new migration. Does it call check_idempotency and save_idempotency, or does it INSERT INTO idempotency_keys directly?
- BLOCKER 3 (notify_admins): grep all new migrations for notify_admins. Should be zero hits.
- STALE 1 (complete_delivery): if a manufactured_at_delivery migration was written, confirm it targets the LATEST complete_delivery body, not the older one. If no such migration was written, confirm the decision was documented.
- STALE 2 (InventoryPage line numbers): confirm any code edits in InventoryPage.tsx hit the right functions (handleCreateHold, the Adjust Modal block).
- SCOPE 1 (P4-13 already done): confirm no commit re-adds the disabled-tooltip pattern to PurchaseOrderDetail.tsx.
- SCOPE 2 (P4-12 frontend fix): confirm CycleCounts.tsx now passes p_idempotency_key for cancel_cycle_count.
- DRIFT 8/9/10: read the implemented create_inventory_hold RPC and the frontend wiring. Note which actor pattern, error string convention, and force-retry UX were adopted.
- SCOPE 11 (self-review base): confirm what commit range the self-review actually audited.
- SCOPE 12 (time budget): if available, note actual wall-clock time vs estimate.
- SCOPE 13 (Wave 1 report): confirm SESSION_FINAL_WAVE_1.md exists.

Then assess:
- Are any of my 13 findings WRONG (cited evidence doesn't actually support the claim)?
- Are there findings I MISSED that the implementation should have addressed? Specifically check:
  * Did the audit Q&A answers (especially Q3 inventory reversal, Q4 period-reopen, Q9 nullable Applied Info) get honored end-to-end?
  * Did Wave 3 Item 1 (E2E test) get written, and does it follow the project's E2E protocol (E2E_PREFIX, fixture reuse from tests/e2e/fixtures/e2e-constants.ts)?
  * Did Wave 4 Item 2 (P4-7) make a defensible decision (do it, skip it, document why)?
  * Are any new RPCs missing the standard fixtures (RLS, search_path, GRANT EXECUTE)?
  * Does CLAUDE.md need its Current State counts updated (page, migration, RPC, test counts)?

Output format:
1. One-line verdict: "Ready to commit" / "Needs touch-up before commit" / "Significant rework required"
2. Findings I had right (just count them, no detail unless one needs revision)
3. Findings I had WRONG (detail each — what evidence I cited that doesn't hold up)
4. Findings I MISSED (detail each — file:line + impact)
5. Concrete actions needed before commit (numbered list)

Write your output INTO docs/audits/2026-05-07-phase-4-closure-plan-review.md, in the section titled "## Second-Opinion Notes" near the bottom. Append; do NOT replace existing content. Do NOT modify any other file.

Cite file:line for every claim — no claims without evidence.
```

---

## Second-Opinion Notes

_(Empty until the second-opinion review prompt is run. The fresh session will write its output here.)_

---

## Reconciliation Punch List

After both reviews are in, walk through every finding in the Status Dashboard above. For each, decide:

- **Resolution OK** — addressed, both reviews agree, no action needed.
- **Resolution wrong** — needs to be redone. Add to the punch list below.
- **Resolution intentional** — diverged from the audit on purpose. Document why in Decision/Notes.

### Items needing fix before commit

_(Add rows here as the reconciliation pass turns up issues. Each row should have: finding number from above, what's wrong, who/how to fix, status.)_

| Finding # | What's wrong | Fix approach | Status |
|---|---|---|---|
| New (Wave 4 reconciliation) | `create_inventory_hold` RPC accepts `p_hold_type IN ('manual','crop_program')` but takes no `p_source_id` — `'crop_program'` holds need source_id for the trigger that releases them on quote-status-change. Frontend currently passes only `'manual'`, so not broken in production today. | Either narrow the CHECK to `'manual'` only, OR add `p_source_id uuid DEFAULT NULL` parameter and INSERT it into `inventory_holds.source_id`. Low priority. | OPEN |

### Final commit checklist

When the punch list is empty:

- [ ] All 13 findings are either DONE, SKIP (with documented reason), or N/A
- [ ] Second-opinion review has run and is documented above
- [ ] Reconciliation pass found nothing remaining to fix (or all fixes have been applied)
- [ ] `npm run build` passes
- [ ] `npm run test` passes
- [ ] CLAUDE.md Current State counts updated (page/migration/RPC/test counts)
- [ ] `docs/CHANGELOG.md` has an entry for this work
- [ ] All migrations have sanity-test SQL in their commit message bodies
- [ ] No commits that bypass `--no-verify` or skip pre-commit hooks
- [ ] `git status` is clean except for the staged commits ready to push
