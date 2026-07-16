# Graphify Overnight Bug Hunt — 2026-07-15

Self-contained overnight find → adversarially verify → fix → adversarially re-review loop approved by Mason on 2026-07-15. This mission extends the canonical `.claude/commands/overnight-bug-hunt.md`; that command remains authoritative when this document is silent.

## Driver

Codex drives each cycle. Graphify scopes the smallest connected source surface, the canonical Workflow performs the read-only hunt and adversarial verification, and an independent headless Codex review gates both the finding and the actual fix. A cycle advances automatically after its ledger/report checkpoint. Mason is not expected to answer overnight unless a hard delivery gate is reached.

## Granularity

One reviewed unit is one confirmed finding. Each unit receives an independent finding gate, the smallest safe fix, real-path verification, an independent fix-diff gate, and an isolated commit. One cycle covers one non-overlapping subsystem key so ownership and evidence remain clear.

## Worktree

This mission owns `C:\Users\mason\.codex\worktrees\e472\CRX_Manager` on branch `claude/overnight-bug-hunt`. It must never edit `C:\Users\mason\.codex\worktrees\2632\CRX_Manager` or branch `codex/money-inventory-gauntlet-fixes`.

## Definition of done

Stop when three consecutive complete dry cycles have no new confirmed findings and no blocked/unverified evidence, or at approximately 07:00 America/Chicago, or immediately when Mason says stop. At stop, every candidate must be fixed and proven, refuted with evidence, deferred to an owning session, or parked with a plain-English reason. `docs/audits/overnight-bug-hunt/REPORT.md` must contain the morning summary and proof for every completed cycle.

## Delivery gate

The loop may make local commits only on `claude/overnight-bug-hunt`. It must not push, merge, deploy, apply a live migration, deploy an Edge Function, delete or mutate production data, change secrets/permissions/billing, or edit the active remediation branch/worktree. Migration, Edge Function, permission, and data fixes are report-only parked findings unless Mason explicitly approves them later.

## Active ownership exclusion — money/inventory remediation

Owner task: Codex thread `019f67f6-8536-7b53-9487-319972813b50`, branch `codex/money-inventory-gauntlet-fixes`.

Exclude these findings and boundaries completely:

1. Delivery actor authorization, supplied business date, and admin-only voiding.
2. RPC-only delivery, receiving, purchase-order, AP/vendor-payment, and prepayment mutations.
3. Purchase-order receiving/edit/import behavior and received-line immutability.
4. Misc-charge invoice creation/reclassification, the `ORDERLESS_INVOICE_TYPE_LOCKED` guard, field-application save behavior, statements, writeoffs, and finance-charge dates.
5. AP totals and voided vendor-payment math.
6. Penny-exact prepayment allocation and mutation hardening.
7. Inventory on-order/reversal math and transaction-ledger displays.

Never edit these owned files:

- `docs/reference/migration-history.md`
- `docs/reference/rpc-functions.md`
- `src/components/inventory/TransactionLedgerModal.test.ts`
- `src/components/inventory/TransactionLedgerModal.tsx`
- `src/components/prepay/PrepaymentManagerPanel.tsx`
- `src/components/purchase-orders/BulkPOImport.tsx`
- `src/pages/InvoiceDetail.tsx`
- `src/pages/PurchaseOrderDetail.tsx`
- `src/types/supabase.ts`
- `src/lib/moneyInventoryGauntletFixes.test.ts`
- `supabase/migrations/20260715210000_gauntlet_access_boundaries.sql`
- `supabase/migrations/20260715210100_gauntlet_money_workflows.sql`
- `supabase/migrations/20260715210200_gauntlet_inventory_accuracy.sql`

If a candidate touches an excluded symbol, file, RPC, or lifecycle, record it as `DEFERRED_ACTIVE_OWNER` and move on without proposing or writing a competing fix.

## Queue

Run non-overlapping slices in this order:

1. `jobs-to-billing` — job/recipe/application handoff only; defer invoice or inventory overlap.
2. `field-app-invoices` — field/application navigation and pre-save workflow only; defer owned invoice-core and all field-application save behavior.
3. `frontend-safety` — skip every owned file.
4. `lifecycle-invariants` — focus jobs, quotes, returns, commissions, and scheduling; exclude delivery, PO, invoice, prepay, and inventory findings.
5. `edge-and-pdf` — Edge findings are park-only; PDFs may receive green fixes.
6. `docs-deps-tests` — skip the two owned reference documents and money/inventory test gaps.

## Per-cycle proof

Each cycle records:

- Graphify build commit and exact scoped query.
- Candidate nodes and source files inspected.
- Finding-gate verdict with evidence.
- Ownership-collision disposition.
- Fix-gate verdict for any edited diff.
- Commands run and the behavior observed.
- Commit SHA for a green fix, or the parked/refuted/deferred reason.
