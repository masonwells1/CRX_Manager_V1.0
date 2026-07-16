# Claude Disposition of Codex Review — 2026-06-10 Remediation Batch

**Codex verdict:** NEEDS-WORK (1 HIGH, 4 MED, 4 follow-ups; 7 confirmations)
**Claude verdict after independent verification:** all findings real; **all remediated this round** (3 new migrations applied live + frontend fixes + doc fixes + merge-conflict resolution). One follow-up (AR dedup) fixed; one (warn-not-block visibility) fixed via activity_feed without an RPC contract change.

Every claim was re-verified before acting (live SQL / code reads cited per item). The fixes themselves went through the full gate: rls-security + migration-drift + compliance reviewers (their 1 HIGH + 4 MEDs on MY fixes also fixed before apply), live pre-checks, rolled-back e2e smoke tests, B7 renames.

## Per-finding disposition

| # | Codex finding | Verified | Action |
|---|---|---|---|
| HIGH | Commission correction internally inconsistent — `order_profit` not synced; Reports shows stale value; ORD-2026-0189 needs Mason's confirmation | **CONFIRMED live** (4 rows: e.g. 0189 amount $2,455.37 vs stored profit $250) | `20260610145433` syncs `order_profit` for the 4 pending rows with an exactly-4 assertion + amount≡profit×split consistency check. **Mason confirmed the 0189 recalc stands** ("skip commission", chat 2026-06-10); nothing paid. |
| MED | Multi-field blend tickets duplicate quantities (record per field × full product_data; ledger refs first record only) | **CONFIRMED** by body inspection | `20260610145350` — single record per ticket + `application_record_fields` per field (complete_job pattern); ledger references the one record. e2e smoke (2 fields incl. NULL acres) PASS. |
| MED | Raw receiving delete leaves PO header stale | **CONFIRMED** (trigger had no status recalc) | `20260610145427` — appended the RPC's status CASE to the trigger **+ cancelled-PO guard in both trigger and RPC** (review-round finding). Smoke: fully_received→partially_received on raw delete; cancelled PO untouched. |
| MED | TransactionLedgerModal adds prebook-only qty to the running balance | **CONFIRMED** (`signedQuantity` returned raw qty) | `computeRunningBalance` now applies `-qty` for `prebook_reconciliation` (the modal is a NET-FREE balance — booked/prebooked subtract — so an increase in prebooked reduces it; "zero" is correct only for the available-frame in `reconciliation.ts`, which already was). Row display unchanged. Test added. |
| MED | InvoiceDetail stale-fetch guard incomplete (parent order/deliveries/siblings/quote/shares unguarded) | **CONFIRMED** | `isStale()` checks added at the remaining choke points (post-Promise.all, pre-shares/write-offs). |
| F/U | AR replay counted as new send (`deduplicated` omitted from `SendEmailResult`) | **CONFIRMED** (`send-email/index.ts:287` returns it; type lacked it) | Type extended; AR-reminder loop counts deduped replays as `skipped` (still backfills the tracking row); statement loop gets a distinct deduped counter in toast + activity log. |
| F/U | Warn-not-block invisible to user (RPC returns uuid[]; UI toasts success) | **CONFIRMED** | Folded into `20260610145350`: complete_job-style `activity_feed` entry with the ⚠ short-stock count — surfaced without changing the RPC return contract. (A richer return shape is possible later; deferred deliberately.) |
| F/U | AGENTS.md says 380 migrations | **CONFIRMED** | Regenerated (`node scripts/regenerate-agents-md.mjs`) → 406. |
| F/U | PR #72 draft + CONFLICTING; head advanced past reviewed commit | **CONFIRMED** (`mergeable_state: dirty` vs main's PR #63/#75) | `origin/main` merged into the branch (CLAUDE.md conflicts resolved: our 217-RPC/403-migration counts + ultra-review entry kept; main's doc-accuracy entry + 1,924 test count + vite 7 bump taken). Full suite green on vite 7. Draft status stands until Mason's merge call. |
| ✔ | 7 confirmations (migrations applied, reversal policy, trigger attached, anon revoked, CHECK superset, clean toolchain) | — | No action. |

## Review-gate findings on the fixes themselves (all fixed pre-apply)
- **drift HIGH:** `application_record_fields.acres` NOT NULL vs my nullable COALESCE — would have been this RPC's 5th latent break; fixed with complete_job's fallback chain (`actual → planned → fields.total_acres → 0`) and exercised in the smoke test.
- **rls MED:** idempotency lookup not operation-scoped — scoped to `'create_app_record_from_bt'`.
- **compliance/rls MED:** PO recalc could resurrect a cancelled PO (and on the trigger path would trip `_enforce_po_status_transition`, aborting the delete) — `AND status <> 'cancelled'` in both bodies; live check: 0 receiving rows currently on cancelled/draft POs.
- **drift MED:** data-fix could pass vacuously — exactly-4-rows `GET DIAGNOSTICS` assertion added.
- **drift M2 (design call):** per-field `customer_id` attribution dropped with the single-record design — documented in the migration header; Q6-B multi-customer **billing** is unaffected (separate RPC); revisit only if a true multi-customer compliance record is needed.

## New observations for the ledger
- **Live-only migration `20260610145253 partial_quote_draw_down`** appeared during this session (applied 14:52 UTC, not by this session, no disk file on this branch) — presumably Mason's parallel session; its disk file should arrive when that branch merges. Re-check version parity after both branches land (B7).
- **`docs/reference/migration-history.md` doc-debt:** rows for the entire 2026-06-09 sprint + 2026-06-10 morning batch were never added; a gap-marker row now points at the CLAUDE.md entries. Backfill when convenient.
