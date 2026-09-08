## 2026-08-31 - Gauntlet caller-side safety fixes

- Serializes pending cycle-count edits before completion and refreshes the authoritative item state.
- Binds bulk field import, recipe duplication, negative-inventory reconciliation, and damaged-receipt alerts to stable per-intent retry keys.
- Makes mixed extension/application function-name collisions visible to the overload invariant and classifies deliberate legacy-tab redirects correctly in the route crawl.
