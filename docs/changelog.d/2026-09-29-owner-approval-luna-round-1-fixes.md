## 2026-09-29 — owner approval route: Luna round 1 fixes

Fixes for the first Luna (gpt-6-luna, xhigh) review of the Windows Hello owner-approval route
(see `2026-09-29-owner-windows-hello-migration-approval.md`):

- **HIGH, a misleading reason in the dialog.** The signed findings must now equal the classifier's
  current categories AND reason text, in order. A hand-built payload that keeps the category but
  softens what Mason reads is refused. (This was already fixed in the working tree when Luna
  reviewed the earlier commit.)
- **HIGH, double use in a race.** An approval is now claimed with an exclusive marker file
  (`owner-approval-used-<nonce>.json`, created with `wx`), so only one of two racing applies can
  transmit.
- **MED, expiry at transmission.** `apply-migration-file.mjs` re-checks the 30-minute window just
  before sending.
- **MED, fail-open on a damaged record.** A damaged marker still counts as used, and an unreadable
  state directory refuses the apply.
- Also: the apply script confirms from the LIVE ledger that the migration is not already applied.
  It does so after invalidating the snapshot, so the pinned snapshot-before-first-fetch invariant
  still holds.

Proof: `owner-approval-lib.test.mjs` 49 assertions, `migration-apply-lib.test.mjs` 291,
`migration-apply-guard.test.mjs` 123. Disabling the exclusive claim, the transmit-time expiry check
or the reason match each turns the suite red.
