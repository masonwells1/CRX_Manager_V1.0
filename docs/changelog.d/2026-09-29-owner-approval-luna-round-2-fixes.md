## 2026-09-29 — owner approval route: Luna round 2 fixes

Second Luna (gpt-6-luna, xhigh) review of the Windows Hello owner-approval route:

- **HIGH, reuse after deleting the local "used" marker.** A migration Mason approved now carries a
  guard inside its own transaction (`ownerOnceGuardSql`). The guard:
  - takes `pg_advisory_xact_lock` on the migration's name;
  - raises `OWNER_APPROVAL_ALREADY_APPLIED` if the ledger already holds it.

  So one install per approval is enforced by the database, not by an agent-writable file.
  Proven on a throwaway Postgres 16 in Docker:
  - two applies in a row: the first installed, the second was refused, the counter ended at 1 and
    the ledger held 1 row;
  - two applies at the same moment: the same result (the second waited on the lock, then refused).
- **HIGH, a stale PR view before transmission.** The separate live-ledger lookup added in round 1
  was a network call between the gate and the transmission. It is removed; the in-transaction guard
  replaces it. The window between the gate and the send is back to what every other apply has,
  which is pre-existing and not widened by this change.
- **MED, clipped reasons.** The approval window now shows the safety check's full reason text.
- **BLOCKER, a look-alike approval window (documented residual, pending Mason's call).** Windows
  Hello's prompt cannot display the signed content, so a program running as Mason could draw a
  fake window before triggering the real prompt. The DECISION_LOG entry now says so plainly:
  - the signature proves Mason's physical presence and consent, not that he read the true summary;
  - it can unlock only a migration whose exact PR head CodeRabbit approved and Sol cleared.

  The earlier wording "what he read is what he signed" was corrected.

Proof: `owner-approval-lib.test.mjs` 51 assertions, `migration-apply-lib.test.mjs` 291; the Docker
run above.
