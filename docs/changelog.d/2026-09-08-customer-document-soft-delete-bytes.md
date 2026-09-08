## 2026-09-08 — Customer-document soft-delete byte guard prepared

- Added a forward-only Storage policy candidate that refuses an uploader's subsequent server byte
  requests as soon as customer-document metadata is soft-deleted.
- Preserved the upload response with a five-minute exception that applies only while no metadata row
  exists for an assigned customer's path.
- Replaced 60-second signed bearer links with authenticated Storage downloads, making every new
  server byte request evaluate the current policy.
- Added a network-isolated PostgreSQL proof that reproduces the historical leak, observes the fixed
  behavior, checks exact replay and real hidden cross-customer metadata, and mutation-tests exact
  policy, NULL-expression, helper-drift, and overload guards, plus a focused browser-helper test
  that refuses a download when Storage denies the actor.

This migration is parked in source and has **not** been applied live. Merging it does not change
production until Mason separately authorizes a governed migration apply.
