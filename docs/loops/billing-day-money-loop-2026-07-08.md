# Loop mission — Billing-day money fixes + delivery splits + correctness follow-ups

**Open from a FRESH session with:** `/run-loop docs/loops/billing-day-money-loop-2026-07-08.md`
**Created:** 2026-07-08 · **Owner:** Mason (zero coding — explain in plain English, PushNotify on any decision) · **Source:** business-workflow-review-2026-07 (`docs/audits/business-workflow-review-2026-07/report.md` §3.2/§3.3/§3.10 + `findings.json`) and the loop-ledger follow-ups.

> Excludes the **credit-memo fix** (Mason is building that separately — see `docs/audits/credit-memo-apply-HANDOFF-2026-07-08.md`). This loop and credit-memo touch the SAME money functions (`allocate_payment`, `mark_overdue_invoices`, the Payments screen); **Step 0 coordinates so they don't collide.**

---

## Driver
**Codex builds, Claude orchestrates + verifies + implements, Codex reviews before every ship** (Mason's words 2026-07-08: "codex the workers, claude orchestrator and implementer, codex review before push and ship"). Per cycle:
1. **Claude (orchestrator)** re-verifies the unit isn't already shipped (list_migrations + grep + git ancestry), then gathers a live-schema grounding brief (columns, CHECK constraints, existing RPC defs via `pg_get_functiondef`, the inline four-lever consumers, dependent objects).
2. **Codex (worker)** builds the fix (migration SQL + frontend) from that brief + the finding + `docs/reference/sql-canonical-patterns.md`. For the two DESIGN-REVIEW-FIRST units (flagged in the worklist), Codex reviews the DESIGN before building — BLOCKER → park + PushNotify + handoff, skip to next.
3. **Claude (implementer/verifier)** reviews Codex's output against the live DB, runs the 5 CRX reviewers (rls-security / migration-drift / typescript-types-drift / pdf-output / compliance), runs a **rolled-back live smoke** (`BEGIN; <mig>; ROLLBACK;` + `plpgsql_check`), runs typecheck+build+tests, fixes any gap itself, and writes the apply-guard reviewer-proof.
4. **Codex (reviewer)** runs the pre-ship review gate on the final diff (`codex exec`, default model — `gpt-5.5-codex` is NOT available on this account); must return clean / blockers-fixed (cap 3 rounds, else park).
5. **Ship** (autonomous — see Delivery gate).
Next cycle triggers automatically when the prior unit ships or parks. No per-fix owner click; Mason reachable via `PushNotification` for BLOCKERs/decisions only.

## Granularity
**One unit per cycle** = one migration (+ its coupled frontend), fully proven + Codex-clean + shipped (or parked) + ledger-updated before the next unit starts. Never batch two money migrations into one review.

## Worktree
**Dedicated, isolated: `C:\CRX_BillingFix`, branch `fix/billing-day-money-2026-07`.** Step 0 creates it off the latest `origin/main` (`git worktree add`). NEVER a shared tree. Run `git worktree list` first (collision check) — if the path is already checked out by another session, STOP and ask Mason.

## Definition of done
Loop ENDS when every worklist unit is either **DONE** (shipped live + Codex-clean + pushed to `main`, with a `PROOF — Ran: … · Saw: …` ledger line) or **PARKED** with a written reason + a handoff (design-review-first BLOCKERs land as a `docs/audits/*-HANDOFF-*.md` like credit-memo did). Ledger `docs/loops/billing-day-money-ledger.md` complete; final plain-English summary + a `PushNotification` to Mason.

## Delivery gate
**Autonomous ship — Mason's explicit 2026-07-08 authorization.** Each live migration apply + push-to-main (Vercel deploy) happens WITHOUT a per-fix owner click, but ONLY after ALL of: (a) 5 CRX reviewers clean, (b) rolled-back live smoke passes, (c) a REAL Codex pre-ship verdict is clean, (d) the apply-guard reviewer-proof file exists, (e) the codex-push-guard proof exists for the push. **Hard STOPS that still halt for Mason (PushNotify + park, never force):** any Codex BLOCKER (design-review or fix) after the 3-round cap · a failing live smoke · **edge-function deploy** · **data deletion** · touching files the parallel **credit-memo** build owns while it's in-flight · a unit needing a business decision (e.g. the posting-policy choice). **Scope limit — do NOT route around the harness:** this runs **attended/hands-off** (Mason launched + reachable). It is NOT armed for a fully-unattended overnight run — the autopilot guard blocks live money-apply while Mason is away by design; if Mason wants overnight, switch this loop to park-and-batch mode instead (build+prove everything, apply the vetted batch on his one OK).

---

## Step 0 — setup + credit-memo coordination (do FIRST, once)
1. `git worktree list` (collision check) → create `C:\CRX_BillingFix` on `fix/billing-day-money-2026-07` off fresh `origin/main`.
2. **Credit-memo coordination:** check if credit-memo has landed on `main` (grep for `apply_credit_memo_to_invoice` / `credit_applied_cents` in live `list_migrations`).
   - If LANDED → good; the four-lever consumers now read the credit lever. Re-ground every money unit on the post-credit-memo definitions.
   - If STILL IN-FLIGHT (a parallel session owns it) → **PARK** the units that overlap its files (`allocate_payment`, `mark_overdue_invoices`, Payments UI) until it lands; work the non-overlapping units (delivery splits, correctness follow-ups) first, then rebase.
3. `npm ci`; confirm `npm run typecheck` + `npm run build` green before starting.

## Worklist (ordered — safe/small first, design-review-first ones flagged)

**Bucket C — smaller correctness follow-ups (start here: low blast radius, warms up the harness)**
- **C1 · Reserve-side unit normalization.** The hold engines `_sync_job_holds` / `_sync_quote_job_reservations` null-to-raw on units like `pt/ac` (U11 fixed only the deduction side). Mirror U11's `normalize_rate_unit` on the reserve side. Ref: `business-workflow-fix-ledger.md` U11 follow-up. Migration, S.
- **C2 · Applicator snapshot in logbook RPCs.** `get_logbook_*`, FieldDashboard, LotTrace RPCs still read live `profiles` instead of N2-7's `applicator_name`/license snapshot columns. Re-emit to prefer the snapshot. Ref: `business-workflow-fix-ledger.md` N2-7 PARKED follow-up. Migration, S.
- **C3 · Wire the "built but unused" safety signals (§3.10).** negative-stock-as-low-stock, `get_expiring_planned_holds` callers, prepay column on AR aging. Frontend-only (read-only queries, no migration). Ref: report §3.10. S.

**Bucket 1 — rest of billing-day money fixes (§3.2, credit-memo excluded)**
- **M1 · Overdue invoices on the Payments page.** Widen the Payments query + the Record-Payment button gate to include `overdue` (RPC already accepts it). Ref: `PaymentAllocation.tsx:152`, findings.json:544. **VERIFY-FIRST — may already be shipped by U1 (`20260706000000`); confirm live, skip if done.** Frontend, S.
- **M3 · `allocate_payment` over-allocation guard.** Server-side `sum(allocations) ≤ check amount`. Ref: report §3.2. **VERIFY-FIRST — likely already shipped as `20260706000000_allocate_payment_over_allocation_guard`; confirm live, skip if done.** Migration, S.
- **M4 · Posting-policy alignment (needs an owner decision).** One posting policy across the 5 posting surfaces + make chemical batch-post partial-tolerant (not all-or-nothing). Ref: report §3.2 + §6 decision 7. **PushNotify Mason for the policy choice before building.** Migration + frontend, S-M.
- **M2 · Partial/follow-up deliveries never billed. 🔶 DESIGN-REVIEW-FIRST.** Make the delivery auto-invoice check per-delivery, not per-order, so each completed delivery bills its own quantities exactly once. Ref: report §3.2 ("the one to review carefully"), mig `20260620220000:226,244-250`. Codex design-reviews FIRST; BLOCKER → handoff + park. Migration, M.

**Bucket 2 — landlord/tenant splits on the delivery side (§3.3)**
- **S1 · Delivery auto-invoice becomes split-aware. 🔶 DESIGN-REVIEW-FIRST (biggest, most money-sensitive).** Today the delivery auto-draft mono-bills the primary customer and the split path is gated off once a delivery exists. Make it emit a per-owner invoice GROUP like the spray-job side already does (U7 `20260707140000` is the working reference — `invoices.invoice_group_id`, `calculate_billing_splits`, penny-exact by acres). Ref: report §3.3, findings.json:1311. Codex design-reviews FIRST (this is as landmine-y as credit-memo); BLOCKER → handoff + park. Migration + frontend, L.

## Design-review-first sub-protocol (M2 and S1 only)
Before building, Claude writes a short design + verified live-schema facts (like `credit-memo-apply-design-2026-07-08.md`) → Codex adversarial DESIGN review (`codex exec`, ask "how does this lose money / drift AR / double-bill") → if **BLOCKER**, write `docs/audits/<unit>-HANDOFF-<date>.md` with the corrected plan, PARK the unit, PushNotify Mason, move on. Only build once the design is Codex-cleared.

## Per-cycle proof (every unit, in the ledger)
`PROOF — Ran: <5 reviewers + rolled-back smoke + typecheck/build/tests + Codex verdict> · Saw: <live result — e.g. $10k−$2k−$8k → paid/0, or the split penny-exact> · Shipped: <migration id + live version + commit sha> · Not verified: <…>`.

## Hard rules (add to, never replace, the /run-loop launcher rules)
- Money is `bigint` cents; every SECDEF fn `SET search_path=public,pg_temp`; every mutating RPC actor-gated + idempotent (bind idempotency to the real args); after `.update()/.delete()` → `checkMutationResult`; revoke anon on every new SECDEF fn + run `db-invariant-sweeps` after.
- NEVER apply a live money migration without a REAL Codex verdict this session (queued ≠ reviewed).
- If a unit touches a file the credit-memo build is actively editing → park it, don't race.
- Stop/pause from Mason = hard halt (checkpoint the ledger).
