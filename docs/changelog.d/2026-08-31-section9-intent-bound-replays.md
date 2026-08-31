## 2026-08-31 — Bind Section 9 PO/AP replays to the exact request

Added a local-only migration that binds `receive_po_items`, vendor-bill edits,
vendor-payment recording, and vendor-bill voids to the authenticated actor and
the exact request payload before replaying an idempotency receipt. The browser
now discards a key after the database proves it belongs to another request, so
the operator can retry their current intent safely. Vendor-bill edits now use
the same exact cumulative-PO overage confirmation and logged reason as bill
creation, and the migration fails closed if any wrapped public RPC has an
unexpected overload.

No migration was applied and no live data changed. Local SQL, focused tests,
and rollback-only smoke proof remain required before a governed rollout.
