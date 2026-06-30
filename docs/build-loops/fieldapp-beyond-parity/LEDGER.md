# Field-App Beyond-Parity Loop — LEDGER

**State:** RUNNING. §1 BUILT + Codex-done (commit `1711f135`). Next: §2 Watchdog.
**Regenerated from:** `PROGRESS.json`. This is the human-readable source of truth for resume.
**Owner decision (2026-06-29):** grower portal (§7–§10) SKIPPED this round — building §1–§6 only.

## Progress: 1 / 6 sections built (portal §7–§10 deferred)

| # | Section | Phase | Status | Migration? | Risk | Codex |
|---|---------|-------|--------|-----------|------|-------|
| 1 | AI Label-Data Backfill | 1 Enablers | **BUILT** | yes | medium | DONE (8 rounds, ~14 fixed) |
| 2 | Wrong-Field / Wrong-Rate / Double-Bill Watchdog | 1 Enablers | PENDING | yes | low-med | — |
| 3 | Office Cockpit (exception dashboard) | 2 Office | PENDING | no | low | — |
| 4 | Auto-Invoice on Completion → review/post queue | 2 Office | PENDING | yes | **med-high (MONEY)** | — |
| 5 | Label-Rate Guardrails | 3 Compliance | PENDING | yes | medium | — |
| 6 | "Your Field Was Sprayed" Proof Notification | 4 Customer | PENDING | yes | medium | — |
| 7–10 | Grower Portal (4 sections) | 4 Customer | **DEFERRED** | yes | HIGH | — |

## Build order (this round)
1 ✅ → 2 → 3 → 4 → 5 → 6 (respect `depends_on`: §5 needs §1; §3 wants §2; §4 after §3).

## §1 commits (on `feat/fieldapp-beyond-parity`)
`d514fb15` build → `af61ad7` `8b664ca` `9a34c83` (codex r1–r3) → `ed18246` (validation hardening, opus) → `1382dd6` (commit bookkeeping) → `5ddcb47` (manual-draft + doc sync) → `fdc97a9` (blank-text) → `1711f135` (status-clamp + error msgs). 8 Codex rounds, all High/Med fixed + rolled-back-smoke-proven.

## Open questions (need Mason — non-blocking until the gate)
- **§4 money:** confirm any per-acre pricing default not already encoded in the existing transfer/split/price RPCs.
- **§5:** hard-block vs warn on an over-label rate — default WARN; hard-block is an owner decision.
- **§6:** a new edge-function email_type deploy is owner-gated.
- **§1:** the PROD load of accepted label values is Mason's review-and-approve task at the gate; live Google Vision extraction needs `GOOGLE_VISION_API_KEY` + an edge-fn deploy (owner-gated) — the review/accept/coverage tool works without it.

## Parked-Low
- **§1 P3:** `create_label_draft` idempotency is check-then-insert (not atomic) — rare concurrent-create race; the `idempotency_keys` unique key + `ON CONFLICT` already prevents duplicate-key rows.
- **§1:** `errMessage()` error-surfacing applied to §1 only; the `err instanceof Error` pattern is house-wide (~19 files) — a separate cleanup.

## Migrations created (for the production gate, apply in TIMESTAMP order)
- `20260629210000_product_label_drafts.sql` — §1: `product_label_drafts` staging table (RLS admin-only) + `products.max_label_rate`/`_unit` columns + 4 SECDEF RPCs (`create_label_draft`, `commit_label_draft`, `get_label_coverage_report`, `bulk_create_label_drafts`, anon EXECUTE revoked). **LOCAL only — owner-gated for PROD.**
