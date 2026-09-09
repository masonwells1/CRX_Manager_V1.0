## 2026-09-09 — close the PR #624 durable-intent mirror race

`useUncertainMutationIntent` now always presents the caller's current request
as the candidate to IndexedDB. The authoritative record decides whether a
pending request must be retained, a changed request must be refused, an expired
request remains locked, or a resolved tombstone permits a new key. A stale
localStorage pending mirror therefore cannot replay an earlier inventory hold
or adjustment and falsely report a later action as successful.

Added a cross-tab regression that reproduces a resolved IndexedDB record with a
stale pending local mirror. It failed before the change by returning the old
adjustment payload and passed after the change with the new payload and key.
The frontend safety contracts now guard the durable frozen-request binding for
holds and adjustments; retirement retains its payload-scoped key assertions.

No migration was applied, no database was queried, and no production behavior
was verified in this change.
