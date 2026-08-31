# Handoff — Gauntlet Sections 2–6 remediation (completed/superseded)

**Date:** 2026-07-18
**Branch:** `claude/gauntlet-test-coverage-to1yl0`  ·  **PR:** #165 (draft)
**Audit report:** `docs/audits/gauntlet/2026-07-18-sections-02-06-adversarial-loop.md`

> **Superseded 2026-07-18:** do not execute the apply instructions or use the old
> pre-apply filenames below. All six migrations were applied live, renamed to their
> Supabase-assigned versions, and reached `SMOKE_PASS_ROLLBACK`. Canonical release state
> is recorded in `docs/reference/migration-history.md` rows 749–754 and 759–762,
> including the final B2/H3 closure and intermediate-window reconciliation. Supplier Pricing
> Phase 1a was separately reconciled to `main` by PR #163; its forward correction applied
> live as ledger version `20260718154131`.

## Context (what's already done)

Six confirmed gauntlet findings (H1, B2, H2, H3, H4, H5) are **built, reviewed, fail-first
proven on live, committed, and pushed**. Each migration reproduces the verbatim live
function body with one targeted change. Each passed `rls-security-reviewer` +
`migration-drift-reviewer` (0 BLOCKER) and ships a fail-first smoke that FAILED on the
pre-fix live function (rolled back — nothing mutated).

**Historical pre-apply state:** at the time this handoff was written, none were applied and
#165 was still draft. That state is no longer current; use the supersession note above.

Commits: `d74c778` (H1), `a9418fc` (B2), `bd8b9c6` (H2), `87ed264` (H3/H4/H5),
`51c5328` (tooling: graphify skips gracefully when absent).

---

## 1. Historical apply plan — completed; do not rerun

`git fetch && git checkout claude/gauntlet-test-coverage-to1yl0 && git pull` first.

For **each** migration, in this order: `node scripts/write-apply-proofs.mjs <mig>` (runs
Sol/Codex + mints the apply-guard proof — mints NOTHING on a BLOCKERS/failed run) →
`apply_migration` via Supabase MCP → `node scripts/smoke/run-smoke.mjs --spec <spec>`
(expect `SMOKE_PASS_ROLLBACK` — now that the fix is live it should PASS).

| # | Migration (without `.sql`) | Smoke spec | Fix |
|---|---|---|---|
| 1 | `20260718131500_revert_quote_escape_hatch_for_cancelled_order` | `revert_quote_status` | B2 |
| 2 | `20260718124500_harden_prepay_and_payment_role_gate` | `apply_prepay_to_invoice` | H1 |
| 3 | `20260718133000_void_invoice_block_applied_payments` | `void_invoice` | H3 |
| 4 | `20260718132000_finance_charge_month_dedup` | `generate_finance_charges` | H2 |
| 5 | `20260718134000_forbid_restore_cancelled_order` | `restore_cancelled_order` | H4 |
| 6 | `20260718134500_backfill_invoice_refuse_split_billing` | `create_invoice_for_unbilled_delivery` | H5 |

If any Codex verdict is BLOCKERS: stop, fix or park, and surface it to Mason.

## 2. Post-apply housekeeping — completed

- **B7 rename:** rename each migration file to the version stamp Supabase assigns on apply.
- **Update `docs/reference/migration-history.md`** rows 745–750 from *"BUILT — NOT YET
  APPLIED"* → *"APPLIED LIVE"* with the applied date.
- **Run `npm run db-sweeps`** after applying — execute each block read-only via MCP; expect
  zero unallowlisted violations.
- Schema-registry regen is **not** needed for these six (all `CREATE OR REPLACE FUNCTION`,
  no new enum / generated column / table).

## 3. Merge PR #165 — current remaining release step

Mark ready-for-review (triggers CodeRabbit) → read + fix any real CodeRabbit issue →
confirm the required **Vercel** check is green → squash-merge into `main`.

## 4. Frontend UX follow-up (real, lower priority — separate PR)

Three fixes now make an RPC **refuse** where the UI button previously "worked". Polish the
UX so users don't hit a raw error toast:

- **H4** — the "restore cancelled order" action now always errors (`ORDER_RESTORE_NOT_SUPPORTED`);
  **hide/remove** that button. Callers: `src/pages/OrderDetail.tsx`.
- **H3** — "void invoice" errors when payments are applied (`INVOICE_HAS_APPLIED_PAYMENTS`);
  optionally pre-check and disable, or surface the "unapply the payment first" message.
  Callers: `src/pages/InvoiceDetail.tsx`.
- **H5** — the delivery "backfill invoice" action errors on split-billing orders
  (`ORDER_NEEDS_SPLIT_BILLING`); optionally hide it for `needs_split_billing` orders.
  Callers: `src/pages/DeliveryDetail.tsx`, `src/components/integrity/IntegrityCleanupPanel.tsx`.

The RPC guards are the safety net; this is UX polish, not required for the fix.

## 5. B1 — historical question, resolved by PR #163

At handoff time, live prod ran the whole **Supplier Pricing Phase 1a** feature — migrations
`20260717042803` / `20260717112011` / `20260717171331` + a live SECURITY DEFINER trigger
`guard_and_version_product_pricing` — but it is **unmerged on `main`** and its source lives
only on `origin/feat/supplier-pricing-phase1a`. The repo cannot currently rebuild prod, and
the registry-driven hooks are blind to the live trigger.

This repository gap was subsequently reconciled by PR #163. The separate provenance
investigation remains a closeout task; do not use this historical section as evidence of
current branch or live state.

---

**Summary:** §1–§3 = make the six fixes live and merged (Codex can run end-to-end). §4 = a
small cleanup PR. §5 needs Mason's call before Codex touches it.
