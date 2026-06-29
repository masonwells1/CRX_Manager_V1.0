# Field-App Beyond-Parity Loop — LEDGER

**State:** SCAFFOLDED — not started. Kicks off after Mason ships the ChemMan-parity rebuild to live.
**Regenerated from:** `PROGRESS.json`. This is the human-readable source of truth for resume.

## Progress: 0 / 10 sections built

| # | Section | Phase | Status | Migration? | Risk | Codex |
|---|---------|-------|--------|-----------|------|-------|
| 1 | AI Label-Data Backfill | 1 Enablers | PENDING | yes | medium | — |
| 2 | Wrong-Field / Wrong-Rate / Double-Bill Watchdog | 1 Enablers | PENDING | yes | low-med | — |
| 3 | Office Cockpit (exception dashboard) | 2 Office | PENDING | no | low | — |
| 4 | Auto-Invoice on Completion → review/post queue | 2 Office | PENDING | yes | **med-high (MONEY)** | — |
| 5 | Label-Rate Guardrails | 3 Compliance | PENDING | yes | medium | — |
| 6 | "Your Field Was Sprayed" Proof Notification | 4 Customer | PENDING | yes | medium | — |
| 7 | Grower Portal — Login & security scoping | 4 Customer | PENDING | yes | **HIGH (auth surface)** | — |
| 8 | Grower Portal — My Fields & Application History | 4 Customer | PENDING | yes | medium | — |
| 9 | Grower Portal — My Invoices & Balance | 4 Customer | PENDING | yes | medium | — |
| 10 | Grower Portal — Self-serve compliance records | 4 Customer | PENDING | yes | medium | — |

## Build order
1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 (respect `depends_on`: §5 needs §1; §3 wants §2; §4 after §3; §8–§10 after §7).

## Open questions (need Mason — non-blocking until the gate)
- **Sequencing:** default = 4 internal first, then §6, then portal (§7–§10). Mason may drop the portal this round or move it earlier before kickoff.
- **§4 money:** confirm any per-acre pricing default not already encoded in the existing transfer/split/price RPCs.
- **§5:** hard-block vs warn on an over-label rate — default WARN; hard-block is an owner decision.
- **§6:** a new edge-function email_type deploy is owner-gated.
- **§1:** the PROD load of accepted label values is Mason's review-and-approve task at the gate.

## Parked-Low
(none yet)

## Migrations created (for the production gate)
(none yet)
