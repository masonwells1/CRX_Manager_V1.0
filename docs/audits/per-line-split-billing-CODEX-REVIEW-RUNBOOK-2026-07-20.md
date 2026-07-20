# Per-Line Split-Billing — Codex Round-6 Review Runbook (front → back)

**Purpose:** the definitive to-do list for the FINAL independent Codex review that gates go-live.
Codex round 6 was usage-blocked until ~2026-07-24. Run this the moment Codex is available.
This feature is the risky class (money + RLS + live migrations), so a genuinely CLEAN Codex
verdict is the HARD gate before any apply / merge / flag-flip.

**Branch:** `claude/per-line-split-billing-build` · **PR:** #164 · **review HEAD:** `c4a79c66`
(the two commits since `bc91afc9` are the Fable adversarial fixes `5ad316de`, decision-log
`8b03cb88`, the CodeQL `crypto.randomUUID()` fix `21943958`, and this runbook/changelog).
**State at time of writing:** flag OFF · migrations NOT applied · PR NOT merged.

---

## ⏳ OPEN P2 BACKLOG — 4 items from Codex ROUND 7 (fix these in the NEXT fresh session)

Codex has now run rounds 6 (8 findings) and 7 (6 findings). Round-6 (4 P1 + 4 P2) is FULLY fixed +
proven + committed. Round-7's **two P1s are fixed + proven** (PROOFOK 57/57): the review-card readback
now filters to active-group members (`.not('invoice_group_id','is',null)`), and the RPC rejects the
same chemical product on >1 line (`SPLIT_DUPLICATE_PRODUCT`, RUP under-report guard). Mason chose
(2026-07-20) to land the P1s and take the **4 remaining P2s in a FRESH focused session** (money/
regulatory + schema/trigger work → fatigue risk; billing isn't used until next year). None of these 4
bills a wrong amount on a normal path. Do them, re-prove, then re-run `codex review --base main`
(round 8) → loop until clean → go-live.

The 4 P2s (all in `supabase/migrations/20260718030000_..._save_rpc.sql` unless noted):
1. **Uniform-override audit base (~line 1036)** — when ALL effective per-person overrides are identical,
   the resolved representative price is replaced with the override BEFORE the calculator runs, so the
   calculator emits the override as `base_unit_price_cents` and PASS 2 records `price_mode='override'`
   with base == effective price — losing the true tier/quote/service base. Fix: keep the resolved base
   for the audit (`base_unit_price_cents`/`base_price_source`); use the override only for the amount.
2. **Posting-boundary item-field tamper (~line 1751 snapshot trigger + `guard_split_invoice_items`)** —
   the Fable-E tie checks only `extended_cents`=share amount + count. A direct admin PATCH of a split
   item's `product_id`/`quantity`/`unit_price_cents`/`billing_line_id` that leaves `extended_cents`
   unchanged passes, so posting can print/RUP-report item details that disagree with the allocation.
   Fix: extend `guard_split_invoice_items` (currently BEFORE DELETE, gated by `crx.split_writer` GUC)
   to BEFORE UPDATE of those material columns, OR cross-check them against shares/billing lines at post.
3. **Snapshot provenance (~line 1761 + schema 20260718010000)** — the post snapshot copies effective
   qty/amounts but drops base price/source, split_mode/price_mode, override reasons, and calc/vector
   hashes; after post→unpost→re-save deletes the live shares/billing lines it's the only history, so the
   prior posted allocation can't be fully audited. Fix: ADD those columns to
   `invoice_line_share_snapshots` (in the parked 010000 — NOT yet applied, so editing it is allowed) and
   populate them in the snapshot trigger.
4. **Combined-list field context (~line 1144 child INSERT)** — split children omit `field_names`,
   `crop_type`, `total_acres` (rely on group-level `field_app_locations`), so `FieldInvoicesListPanel`
   and `buildInvoicePdfDataFromRow` (which read invoice-row fields) show blank acreage in the COMBINED
   list + its PDFs/exports. Fix: populate those 3 columns on each child row (mirror the normal
   field-app invoice flow / `save_field_app_invoice`).

Also still latent (RLS reviewer non-finding, verify in round 8): a VOIDED (not cancelled) child that is
`jobs.invoice_id` is detached from the group on re-save but NOT repointed to a surviving member (the B1
repoint NOT-EXISTS excludes only 'cancelled'). Pre-existing; confirm whether it needs a fix.

## How to run it

```
cd <this branch's worktree>
codex review --base main        # per-change mode, whole branch diff vs main
```
Prior rounds' transcripts: `scratchpad/codex-review-round{2..6}.txt`. Round counts so far:
10, 13, 6, 10, 8 — NOT yet converged, so EXPECT findings; loop fix→prove→re-Codex until truly clean.

## Review ORDER — front (data layer) → back (UI), because bugs compound downward

### 1. DB schema — `supabase/migrations/20260718010000_per_line_split_billing_schema.sql`
- [ ] New tables (`field_app_billing_sets`, `field_app_billing_lines`, `invoice_line_shares`,
      `invoice_line_share_snapshots`) each ENABLE RLS + have policies in the same migration.
- [ ] New columns on existing tables (`invoices.field_app_billing_set_id`, `invoices.send_disposition`,
      `invoice_items.billing_line_id`) are NULLABLE + bare FK (NO ACTION) — deploy-safe before frontend.
- [ ] `snapshot allocated_acres` is numeric(12,4) (widened from (,2) — round-4 F9).
- [ ] No generated-column writes; money columns are bigint cents.

### 2. Calculator RPC — `supabase/migrations/20260718020000_per_line_split_billing_calculator.sql`
- [ ] Pure/deterministic split math: micro-pct sums to exactly 100000000; largest-remainder
      allocation; half-away-from-zero rounding; no float on money.
- [ ] Per-child COGS uses `_lr_allocate_int` on the ONE canonical line cost (round-2 #G / round-5).

### 3. Save/Post RPC — `supabase/migrations/20260718030000_per_line_split_billing_save_rpc.sql` (BIGGEST surface)
- [ ] SECURITY DEFINER + `SET search_path = public, pg_temp`; anon EXECUTE revoked; strict actor
      binding (auth.uid() == p_performed_by); `p_idempotency_key text DEFAULT NULL` enforced.
- [ ] Server-side FLAG enforcement (round-2 #B): RPC refuses when `per_line_split_billing_enabled`≠'true'
      so a direct PostgREST call can't run the money path during the flag-off window.
- [ ] Cross-rep RLS: a non-admin may only touch a set whose children's customers are assigned to them
      (`SPLIT_SET_NOT_OWNED`, `SPLIT_JOB_NOT_ASSIGNED`), incl. null-customer job guard.
- [ ] Positive-amount guards server-side: chemical/service manual + flat reject ≤0 (round-5);
      **service `source_acres`>0** (Fable A / `SPLIT_SERVICE_ACRES_NONPOSITIVE`); per-SHARE override >0.
- [ ] Source-job lifecycle: consume like `transfer_job_to_invoice` (status→invoiced + link) so the
      normal flow's guard fires (double-bill #E); job immutable on re-save; field-set EQUALITY vs
      job_fields (round-5); dup field IDs rejected (round-4 F7).
- [ ] Commissions: resolve `jobs.commission_split`, per-child pending commissions, profit uses the
      LR-allocated per-child chemical COGS (round-5); **re-save SOFT-cancels** (deleted_at + status
      'cancelled' + amount 0), never hard-DELETE (Fable B — FK vs commission_payment_items).
      OWNER-SETTLED: NO job-level clamp (per-child mirrors live; DECISION_LOG 2026-07-19).
- [ ] Re-save clear DELETEs only draft/unposted children (Fable M1); NULL invoice_items.billing_line_id
      before deleting field_app_billing_lines (Fable C — soft-deleted-child re-save unbrick).
- [ ] Wrapper already-posted block excludes cancelled/voided; PASS-2 reuse + orphan-cancel only
      draft/unposted (Fable D — void-child re-save unbrick).
- [ ] B1 immutability: job invoice_id folded into the completed→invoiced statement; re-save anchor
      repoint only when stale, under `SET LOCAL app.admin_override='true'` (non-admin sales_rep path).
- [ ] Posting boundary: snapshot trigger validates item↔share COUNT, share-sum=header, AND per-item
      extended=share amount (Fable E / `SPLIT_POST_ITEM_SHARE_MISMATCH`); snapshot rows self-contained
      (line_kind/product_id/application_service_id/description); generic `save_invoice` on a split child
      is blocked (`guard_split_invoice_items` + `crx.split_writer` GUC).
- [ ] `source_unit_price_cents` reflects a uniform override (Fable F).

### 4. Edge fn — `supabase/functions/send-email/index.ts`  (NOT deployed by merge — separate gate)
- [ ] Invoice email REQUIRES a valid invoice resource row; loads `send_disposition`; refuses
      `suppressed_zero_total`; FAILS CLOSED (503) on lookup error EXCEPT pre-migration 42703/PGRST204
      (fail-open only for the missing-column window) — round-5.

### 5. Frontend
- [ ] `src/pages/FieldAppSplitInvoiceEditor.tsx` — flag self-gate; Post enabled ONLY after a
      successful full readback (`loadResults` returns boolean; stale bail ≠ success); `activeLoadSetIdRef`
      latest-load-wins race guard; money as cents; assertRpcResult/checkMutationResult; no confirm/alert.
- [ ] `src/pages/InvoiceDetail.tsx` — preflight must NOT name `field_app_billing_set_id` (deploy-order);
      split child (draft/unposted) routes to `/split-billing/:id`; split-invoice margin uses header
      `total_cost_cents`.
- [ ] `src/pages/FieldApplicationInvoice.tsx` — tolerant `select('*')` detects a split child + redirects.
- [ ] List panels + `src/lib/fieldInvoiceList.ts` + `emailService.ts` — all reads of new columns use
      `select('*')` / optional access (deploy-safe); `$0` suppression gates on server `send_disposition`.
- [ ] `src/App.tsx` routes flag-gated + role-protected; `Sidebar.tsx` link hidden while OFF;
      `pagePermissions.ts` correct.

### 6. Cross-cutting invariants (whole-diff)
- [ ] Money never float anywhere; group total is reporting-only (not a 5th balance lever).
- [ ] Deploy-order safety holds (frontend safe before migration; migration safe before flag).
- [ ] No new SECURITY DEFINER without revoke-anon + search_path; no service_role in frontend.
- [ ] Idempotency on every mutating RPC; no `--no-verify`, no generated-column writes.

## If Codex comes back CLEAN → the go-live sequence (from memory; Mason's final look first)
1. (this review) CLEAN Codex verdict — DONE gate.
2. Fix anything real Codex flags → re-prove in live PG (BEGIN..ROLLBACK; harness at
   `scratchpad/split_rpc_proof_harness.sql`, bundle build per memory) → re-Codex until clean.
3. Apply the 3 migrations to live IN ORDER: 010000 → 020000 → 030000 (additive; apply-guard proof gate).
4. Regenerate the `rpcFixtureLiveDiff` live-pg_proc snapshot; drop the "+2 parked" entries.
5. Merge PR #164 (Vercel prod deploy) once checks + CodeRabbit clean.
6. Flip `per_line_split_billing_enabled` = 'true' in `app_settings`.
7. Verify live (real-path, not "tests pass"): editor renders, a safe read proves the RPC path,
   no console/advisor errors. Report proof + plain-English summary to Mason.

## Open, non-blocking notes
- Owner-decisions SETTLED (DECISION_LOG 2026-07-19): per-child commissions (no job clamp) +
  no job-less double-submit guard. Do NOT re-open.
- Option A-vs-B settled: Option B (each co-owner own tier). Do NOT re-open.
- Billing isn't used until next year — there is ample review runway; do not rush the gate.
