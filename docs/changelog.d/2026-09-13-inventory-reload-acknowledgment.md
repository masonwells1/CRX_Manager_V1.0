## 2026-09-13 - Inventory peer acknowledgment survives reload

Keep a pending mutation acknowledgment in the physical tab's session storage until that tab observes its result or a definitive rejection. Reloading after another tab completes the request restores the original frozen intent and exact receipt retry rather than offering an identical new mutation. If the shared coordinator has advanced to another request, retain the older intent and refuse a new key; expired original acknowledgments also remain locked for reconciliation.

Verification: rendered inventory recovery, shared receiving and payment replay suites, and focused reload regressions cover original receipt replay, acknowledgment clearing, and refusal after newer peer work. No live database migration or inventory transaction is performed by this change.
