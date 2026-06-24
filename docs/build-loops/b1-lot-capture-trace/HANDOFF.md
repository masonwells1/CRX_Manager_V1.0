# HANDOFF — B1 Lot Capture & Trace (built, reviewed, PARKED for owner approval)

**Status:** `AWAITING-OWNER-APPROVAL`. The feature is fully built, reviewed, and pushed on
branch **`feat/application-lot-capture`**. **Nothing is live.** The database migration is **not
applied**, the branch is **not merged to `main`**, and **nothing is deployed**. Those are the
owner-gated steps below.

**Date:** 2026-06-23 · **Branch:** `feat/application-lot-capture` (pushed to origin) · **Build loop:**
`docs/build-loops/b1-lot-capture-trace/` (`SCOPE-OF-WORK.md` = what, `BUILD-LOOP.md` = how, `STATE.md` = the per-phase log).

---

## 1. What B1 is (plain English)

Today the chemical **LOT / batch number** of a product is tracked only on paper. B1 brings lot into
the system and links it to what was actually applied, so the business can answer the recall /
compliance question: **"which lot of which product went on which field, on what date, for which
customer?"** It is **capture-and-trace only** — no per-lot inventory math (that heavier work is a
later wave). This is the keystone the future grower portal and compliance-packet generator build on.

## 2. What was built

- **Database (one new additive migration `20260622170000_application_record_lots.sql`):**
  - New table **`application_record_lots`** — one row per (application record, product, lot);
    multiple lots per product allowed. Writes are **RPC-only** (no direct client write — RLS
    default-denies); SELECT is admin/sales, or an applicator on their own records.
  - **`set_application_record_lots`** — replace-all save of a record's lots (strict-actor,
    in-body admin/sales gate, parent `FOR UPDATE` race-lock, canonical idempotency, validates each
    product is on the record + the source receipt matches + rejects duplicate lots; writes an
    `activity_feed` audit row).
  - **`get_recent_lots_for_product`** — recent received lots for the application-time suggestion
    dropdown (read-only, admin/sales).
  - **`get_lot_application_trace`** — the recall payoff: every application that used a lot
    (read-only, admin/sales, case-insensitive). Invoiced status reports **only active invoices**
    (voided/cancelled/soft-deleted invoices read as not-invoiced).
  - **Blend-ticket lot propagation** — `create_application_record_from_blend_ticket` reproduced
    verbatim from live with ONLY an auto-INSERT of lots from `blend_ticket_products.lot_number`
    added (no new overload).
- **Types:** 5 interfaces in `src/types/index.ts`.
- **UI:** `LotsEditorModal` (lots-applied editor on Application Records) + `/lot-trace` recall page
  (admin/sales; wired into routes, page-permissions, sidebar, command palette).
- **Typed-client shim `src/lib/lotRpc.ts`** — bridges the parked table/RPCs into the typed client
  with NO `any`/`@ts-ignore`. Reverts to direct typed calls once `src/types/supabase.ts` is
  regenerated post-apply.
- **Tests + docs:** component tests (editor 6, trace 6) + shim contract test (10); B1 documented in
  `database-schema.md`, `rpc-functions.md`, `pages-routes.md`, `CHANGELOG.md`, `CLAUDE.md`
  (table/RPC entries tagged "pending apply").

## 3. Per-phase review verdicts (all gated by Codex + scoped subagents)

| Phase | Verdict | Notes |
|---|---|---|
| 1 — migration | **SHIP** (Codex 7 rounds) | rls-security/compliance/migration-drift CLEAN; rolled-back smoke proven |
| 2 — types | **SHIP** | types-drift reviewer 0/0/0 |
| 3 — editor UI | **SHIP-WITH-FOLLOWUPS** | 2 P2s fixed; pre-apply-button accepted-by-design (lands-together) |
| 4 — trace page | **SHIP** | 4 P2/P3 fixed (incl. audit trail + blend invoice derivation) |
| 5 — tests + docs | **SHIP-WITH-FOLLOWUPS** | shim test + docs; Codex full-branch review fixed 3 P2s (stale trace summary, out-of-order trace responses, job invoice_id not filtered for inactive invoices); **1 same-class P2 deferred at the round cap** (see §5) |

## 4. Proof method (how it was verified WITHOUT touching prod)

- The migration was exercised by **rolled-back `BEGIN…ROLLBACK` smokes** against live (zero prod
  footprint) in Phase 1 and re-smoked for the Phase-4 SQL edits — covering all 3 RPCs, every
  validation branch, blend propagation/dedup, the trace, and the role gate.
- **Caveat (honest):** the Phase-5 change to `get_lot_application_trace` (filtering a job's
  `invoice_id` through the active-invoice predicate) was reviewed by rls-security + migration-drift
  (both CLEAN) but **was NOT live-smoked** — this session has no Supabase MCP. **This is folded into
  the apply-time smoke below** (Step 3), which re-smokes all 3 RPCs anyway.
- UI is proven by mocked-RPC component tests; the **live UI walkthrough moves to post-apply** (the
  page calls RPCs that don't exist until the migration is live).
- Full `lint + typecheck + build + ~2,110-test suite` green on every commit (pre-commit hook).

---

## 5. ✅ RESOLVED (post-loop, commit `95dbc78`) — LotsEditorModal save/close race

**Fixed** — Codex review of the commit found no actionable bugs. The modal now passes a guarded
`handleClose` to `<Modal>` that no-ops while `saving`, so Escape / backdrop / X can't dismiss it
mid-save (the save-success path still calls `onClose()` directly, so a finished save closes normally).
A regression test (save in flight → X + Escape don't close; completion closes exactly once) was
proven to fail on the pre-fix code. *Original issue, for the record:* on a slow save a user could
close record A, open/edit record B, and have A's save-completion close B and drop B's unsaved edits.

**Remaining (post-apply, non-blocking) followups:** regenerate `src/types/supabase.ts` then simplify
the `lotRpc.ts` shim to direct typed calls; optional feature-flag on the "Lots" button.

---

## 6. EXACT ordered steps to go live (each needs Mason's explicit OK)

> **First, work from the feature branch:** `git fetch origin && git checkout feat/application-lot-capture`
> (or add a worktree on it). The migration file + this handoff live there. Confirm the branch is at
> origin's tip (`git rev-parse HEAD` == `git rev-parse origin/feat/application-lot-capture`).
>
> These are the hard gates the build loop did NOT cross. Do them in order. Steps 1, 4, 5 are the
> dangerous ones (live DB / merge to prod / deploy). This requires a **write-enabled** Supabase MCP —
> the build-loop session was read-only by design, so the apply runs from a normal session.

1. **Apply the migration to the live DB** — `apply_migration` on project `rhyzpcqhnizqbxphqdkr`,
   name `20260622170000_application_record_lots`, query = the **exact bytes** of
   `supabase/migrations/20260622170000_application_record_lots.sql`.
   - The `migration-apply-guard` hook requires a **fresh** proof file (≤30 min old). The one at
     `.claude/session-state/migration-review-20260622170000_application_record_lots.json` documents
     the clean reviewers + the content hash but **will be expired** — regenerate it with a current
     timestamp right before applying. The bound hash is
     **`queryHash = 21fe836dac4a6752c3a9f490edb6624fc52b107a724c68991e9aef4f066f1acb`** (sha256 of
     the exact file bytes, LF); the applied query must be byte-identical or the guard re-blocks.
   - Optional: run `/explain-migration` first so Mason sees in plain English what changes.
2. **Regenerate the schema registry** — `/regen-schema-registry` (live MCP introspection), so the
   schema-aware hooks know the new table/RPCs. Then regenerate `src/types/supabase.ts`
   (`generate_typescript_types`) and simplify the `lotRpc.ts` shim to direct typed calls.
3. **Post-apply smoke + invariant sweeps** — run a functional smoke of each new RPC
   (`set_application_record_lots`, `get_recent_lots_for_product`, `get_lot_application_trace` —
   **including the new behavior: a lot on a voided/cancelled/soft-deleted job invoice must report
   `invoice_id = NULL`**), confirm blend-ticket lot auto-propagation end-to-end, then
   `node scripts/db-invariant-sweeps/run-sweeps.mjs` (execute each query via MCP; every one must
   return ZERO rows). `get_advisors` should be unchanged.
4. **Merge `feat/application-lot-capture` → `main`** (the §5 editor race is already fixed; the UI
   calls the new RPCs, so code and migration must land together).
5. **Deploy** — pushing the merge to `main` auto-deploys to Vercel (croprxsolutions.app). Then do the
   **live UI walkthrough**: open `/lot-trace`, trace a known lot; open a record's Lots editor, add 2
   lots to one product, save, reload, confirm persisted; screenshot.
6. **Mason's in-app smoke** — click through it in the live app.

## 7. Rollback (if needed after apply)

`DROP FUNCTION get_lot_application_trace(text); DROP FUNCTION get_recent_lots_for_product(uuid);
DROP FUNCTION set_application_record_lots(uuid, jsonb, uuid, text); DROP TABLE
application_record_lots;` and restore the prior `create_application_record_from_blend_ticket` body
(from `20260610145350`). Vercel rollback is one click.
