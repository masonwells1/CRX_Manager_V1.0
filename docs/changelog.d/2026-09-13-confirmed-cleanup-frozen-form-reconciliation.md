## 2026-09-13 - Keep confirmed transactions visible until their browser retry record clears

Independent owner-requested Opus review of the unpublished receiving correction found a second-shipment substitution path in Quick Receive and an empty locked payment form after reopening. This reconciliation supersedes the close/reset/navigation behavior described in the preceding unpublished confirmed-mutations entry.

After a validated committed result or saved receipt, retry-record cleanup failure now preserves the original visible form and frozen fields in Inventory receiving, Receiving Hub, Quick Receive, vendor-bill creation and vendor payments. Each screen explains that the transaction was recorded once and the remaining problem is browser cleanup, with an unchanged retry, reload and staff escalation path. Data refreshes still run; green workflow completion, close/reset/navigation wait for successful cleanup. Exception reporting is itself guarded so telemetry cannot convert the committed transaction into failure.

Quick Receive stays on its locked original review and cannot start another shipment until reconciliation completes. Vendor payments preserve normal and recovered-payment forms and restore frozen fields if reopened. Receiving Hub keeps the original receipt dialog retryable even after the committed line disappears from the inbound board. A foreign Inventory receiving dialog may be dismissed while its underlying mutation lock remains intact.

Rendered regression checks use the real uncertain-intent hook and real RPC-result guard. They cover cleanup failure and recovery, unchanged receiving/bill/payment retries, payment reopening, actual Hub board disappearance, failed error-reporting transport, and Quick Receive's original receipt replay followed by a genuinely new shipment allocation and new key.

No SQL executable, RPC payload, money calculation, permission, authentication or live business-data change. The inventory migration remains NOT APPLIED. Fresh final-candidate reviews and protected CI/CodeRabbit delivery remain required.
