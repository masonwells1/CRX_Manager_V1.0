## 2026-09-13 - Valid newer receipt recovery proof

Corrected the newer-mirror recovery fixture to use a valid operation-and-user request key. The test now checks that completion removes the old acknowledgment before reloading, leaves the newer mirror intact, and reload restores the newer saved quantity and exact key under a pending lock. It previously passed because the invalid key produced a generic reconciliation block.

Narrowed the historical concurrent-replay SQLSTATE explanation to that exception path and corrected staff instructions to say request key rather than receipt number. No product code, SQL or live data changed.

CodeRabbit's optional acknowledgment-write optimization is deferred: it changes persistence behavior in shared inventory and money recovery. The existing repeated storage write does not resubmit a transaction, and actual write failure continues to lock safely for reconciliation. This optional performance work is separate from finishing the validated delivery.
