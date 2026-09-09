## 2026-09-09 - PR 624 intent mirror narrowing

Restored exact receiving retries only when the IndexedDB durable coordinator still
holds the matching pending record. The localStorage mirror remains presentation
state: a resolved or absent coordinator record receives the caller's fresh payload,
and malformed mirror state still requires reconciliation.

The receiving regression now models a real reload by persisting the same pending
record in both stores. Its frozen payload and idempotency key were observed at the
RPC boundary. The stale-mirror race stayed closed: restoring the old mirror-seeding
expression made the unchanged hook regression fail, while the restored candidate
passed it.

Restamped the unapplied, unmerged create-inventory-hold receipt-binding migration
from `20260905230000` to `20260908130000`, above the current on-disk high-water.
The SQL was not changed, it was not applied, and no database access occurred.
