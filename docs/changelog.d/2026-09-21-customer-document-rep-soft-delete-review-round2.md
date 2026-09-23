## 2026-09-21 - soft_delete_customer_document: Codex review round 2 fixes

Codex `gpt-5.6-luna` xhigh review, round 2, of the parked
`20260921180000_soft_delete_customer_document_rpc.sql` and its page change.

**Fixed.**
- **HIGH:** the retry path's assignment re-check now locks the customer row `FOR SHARE`, just as
  the first call does. A reassignment that is still in progress now waits instead of racing the
  check.
- **MED:** the preflight also requires the shared `check_idempotency_intent` helper to keep its
  operation comparison, not only its actor and fingerprint comparisons.
- **MED:** the prover now shows that a deactivated rep retrying their own valid key is refused
  with `INSUFFICIENT_ROLE`. That exercises the auth-before-receipt order in running code, not
  only through the postflight's source-text position check.
- **MED, page PR:** the Remove button compares the confirmed document and customer ids without
  regard to letter case.

**Deferred (LOW).** The key validation accepts embedded control characters and refuses a key that
is entirely non-ASCII. It is the same predicate as `adjust_inventory`, whose control-character
gap was accepted on 2026-09-20. The page only ever sends ASCII keys it generates itself.
