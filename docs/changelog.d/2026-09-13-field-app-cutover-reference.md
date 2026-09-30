## 2026-09-13 - Field-application cutover reference correction

Corrected the RPC reference's deployment sequence: phase 1 installs the advisory
barrier while preserving generic creation and committed retries; only phase 2,
committed separately after the receipt-expiry gate passes, refuses new generic
field-application invoices. Neither phase is applied to production by this change.

This resolves Codex's PR #660 comment 3999703310. The SQL and executable cutover
proof are unchanged; verification checks the reference against both migration
bodies and the existing disposable PostgreSQL proof.

**Result (added 2026-09-30):** the outcome of that comparison was not recorded when this
entry was written. The current evidence is `npm run proof:field-app-season` on the
field-season delivery head (see `2026-09-30-field-season-review-round-fixes.md`). Production
apply was not verified: neither phase is applied live.
