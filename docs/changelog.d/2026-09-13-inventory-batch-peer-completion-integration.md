## 2026-09-13 - Inventory batch retry and peer receipt compatibility

The #624 recovery candidate incorporates the batch adjustment change shipped in
PR #682. An exact pending batch key is still required before a retry may claim
the shared durable coordinator. The original tab retains its own acknowledgment
until it reconciles the receipt, including after a peer finishes the batch.

The shared hook now reports a known resolved request only when its request
version matches this tab's retained attempt. Batch adjustment uses that state to
show the existing finished-elsewhere notice instead of offering identical stock
work under a new key. Closing that notice acknowledges the saved retry before
refreshing stock. A local cleanup failure keeps the notice and disabled submit
visible; closing again retries bookkeeping without an inventory RPC.

The rendered batch suite passed all 12 cases using the real shared hook and
IndexedDB coordinator. Its peer-completion regression gives the two simulated
tabs distinct stable identities, injects acknowledgment removal failure, and
observes that stock moves once, failed cleanup does not close or refresh the
dialog, and a second close succeeds without an additional stock request.
Typecheck, lint, agent-workflow checks and documentation drift checks passed.
Full-suite, final commit review, remote review and production verification are
recorded separately by the landing coordinator before delivery.

This integration changes no SQL, grants, money math, storage schema or live
business data. The hold receipt migration remains unapplied; its separately
executed disposable PostgreSQL proof is unchanged by this frontend integration.
