## 2026-08-26 — every Section 9 receiving surface survives a lost response

The final exact-commit review of the AP-safety remediation found two remaining
ways a successful purchase-order receipt could be duplicated after its response
was lost. Purchase Order Detail restored the frozen request but rechecked it
against the newly reduced remaining quantity, trapping the operator before the
same-key replay could reconcile the committed receipt. Quick Receive still used
an in-memory-only idempotency key, so reload or unmount discarded both the key
and the submitted allocation.

Purchase Order Detail now sends a restored frozen request directly without
revalidating it against post-commit inventory. Quick Receive now atomically
persists the exact allocation, actor, display context, and matching key before
calling `receive_po_items`; after an uncertain result it restores and locks that
request, retries it unchanged, and accepts only a validated committed receipt
before unlocking. Storage failure refuses the mutation before any RPC. A real
component remount test seeds the durable record with a request that the refreshed
review screen would reject, then proves the original payload and key are replayed
and the record is cleared only after the proven result. The Section 9 source
contract also fails if either restored-retry bypass or Quick Receive durable
wiring is removed.

Proof: 342 test files passed with 4,808 tests passed and 123 skipped; typecheck,
full lint, production build, documentation drift, diff checks, the Section 9
rollback/concurrency proof, and exact-commit adversarial review passed before the
main-policy merge. The exact review and PR gates must be refreshed on the final
merge head. No live migration has been applied.
