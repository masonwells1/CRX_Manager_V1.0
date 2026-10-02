## 2026-09-21 - soft_delete_customer_document: Codex review round 4 fixes

Codex `gpt-5.6-luna` xhigh review, round 4, of the parked
`20260921180000_soft_delete_customer_document_rpc.sql`.

**Fixed.**
- **(MED) Guard body pinned:** the preflight now pins `guard_customer_document_update`'s exact body
  (md5 of the LF-normalized source, `49056708bdd24900db157ef617d763b3`, 1086 characters, read
  read-only from live on 2026-09-21). Checking only its message text let drift in the actual
  enforcement pass. The rebuilt real schema matches the same pin.
- **(LOW) Committed races proven:** the prover now commits a customer reassignment, and separately
  a rep deactivation, while a removal is waiting on that row. In both cases the waiting removal is
  refused (`CUSTOMER_DOCUMENT_NOT_FOUND` / `INSUFFICIENT_ROLE`) and the document stays active.
  Before, it only proved that the removal waits.
- **(LOW, page PR) Test title:** the page test now says it proves key retention only. The
  server-side replay is proven by the prover.

**Refuted.** *(HIGH) "a caller holding another user's key gets a mismatch error instead of
NOT_FOUND":*
- Keys are random 122-bit values, never displayed or shared.
- `IDEMPOTENCY_ACTOR_MISMATCH` carries no result, and the result-bearing `INTENT_MISMATCH` is
  reachable only by the key's own actor.
- Moving the receipt lookup after the document lookup would break every retry: the document is
  already removed by then.
- The order is the same as in the reviewed, live `adjust_inventory`.

**Deferred (MED).** The exact-ACL postflight does not account for roles that inherit EXECUTE
through membership in `authenticated`. That is platform-wide role configuration, not specific to
this function, and it belongs with the separate grants audit. The header now states the limit.
