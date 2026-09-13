## 2026-09-13 - Inventory: reconcile independent Opus and CodeRabbit findings

Independent Claude Opus CLI review of candidate `908940b51d5ec572ee0f84e706a27d69434c8d4d`
completed with `NEEDS-WORK`: one HIGH, one MED, seven LOW and six NIT findings.
Both substantive findings were confirmed and corrected before another delivery candidate:

- The parked hold-migration test now checks its required predecessor, authored ordering and
  `NOT APPLIED` status. Adding a later unrelated migration no longer invalidates this test.
- A confirmed hold or adjustment remains successful when browser retry-record cleanup fails.
  Staff receive a warning and refreshed inventory, while the unchanged receipt/key stays available
  for exact reconciliation. Reopening a locked adjustment restores its frozen quantity and note.
- Completing an older acknowledged request after coordinator eviction clears only that request's
  acknowledgement; a newer local mirror and its foreign lock remain intact.
- Durable conflict/storage errors use plain language. A recovered hold with unavailable customer
  names displays `Saved customer (name unavailable)` and preserves the actual frozen customer ID.
- Hold and adjustment dialogs owned by another surface can close and reopen. Their stored keys,
  payloads, disabled fields and mutation locks remain unchanged; owned pending retries remain locked.

CodeRabbit's two reference findings were also corrected: the current superseding note points to
migration-history row 927, and the page comment distinguishes the installed June hold RPC from
the parked September intent-binding migration. Historical row references remain historical.

The parked SQL file's **rollback comment only** now requires a reviewed forward migration that
explicitly emits a NULL-safe public role gate; a bare implementation rename is unsafe. Its
executable SQL and the disposable concurrency prover are unchanged. No live apply or data mutation
was performed. The previously observed PostgreSQL 17 disposable proof remains supporting evidence:
93 replays, legacy receipt refusal, actor binding, one concurrent hold/receipt with equal actual
returned IDs, rolled-back smoke checks and migration rerun.

Observed local verification: 127 tests passed across ten focused suites, including rendered
confirmed-success storage failures, exact-key retries, failed customer lookup recovery and
foreign-dialog dismissal/reopen without mutation. Typecheck and lint passed. A fresh final-SHA
independent review, full remote delivery checks and authenticated CodeRabbit final review are still
required before merge; this ledger does not claim that unpublished changes have landed.

Review reconciliation retained two safety limitations rather than converting uncertainty into new
inventory work: unreadable session storage stays fail-closed, and a copied tab acknowledgement
conflicting with newer shared work stays locked. Neither condition proves the old mutation failed.
Staff must verify Active Holds/transaction history and obtain admin reconciliation; never clear
storage or mint a fresh key blindly. The existing expired-request recovery design is assigned to
the landing coordinator for 2026-09-18 in `docs/manual/KNOWN_ISSUES.md`; these browser-storage cases
are inputs to that separate recovery design, not a claim that a recovery control already exists.

The remaining optional Opus observations concern pre-existing Receive-modal close presentation,
stacked recovery-modal focus, a harmless double coordinator write and disposable-prover staging/
timeout polish. They do not change this delivery's receipt safety argument. They remain recorded
in the private full per-finding reconciliation instead of widening this inventory delivery.

Rollback and verification remain the normal Vercel previous-deployment rollback and fresh safe
inventory Hold/Adjustment open/cancel/console verification after the actual production deployment.
Applying the parked SQL remains separately authorized, with a new live read-only preflight first.
