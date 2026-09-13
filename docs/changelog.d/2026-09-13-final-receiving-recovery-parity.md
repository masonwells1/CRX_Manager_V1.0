## 2026-09-13 - Complete receiving and payment recovery display corrections

The recovered vendor-payment cleanup report now includes operation=record_vendor_payment, matching the ordinary confirmed-payment path. Quick Receive allows Back to Edit while another screen owns the saved request, preserving the request and blocking receipt submission; its own pending receipt remains frozen. Purchase Order fill-step Cancel uses the same ownership-aware close rule as its review step.

The shared blocked-request message now conditionally describes another page or tab, and otherwise directs staff to authoritative reconciliation. It no longer asserts that a damaged local saved record belongs to a nonexistent other page. This is display text only; the existing conservative durable lock and retry rules are unchanged.

Rendered recovery tests assert Cancel and X remain disabled for owned Receiving Hub and Vendor Payment requests, check the recovered-payment reporting tag, and explicitly reset the Quick Receive module-factory reporting mock between tests. Earlier entries from this unpublished lane were corrected for exact scope and route-reset wording before landing. No live business transaction, storage protocol, RPC payload, money math, executable SQL, permissions or authentication changes. Inventory migration 20260908130000 remains NOT APPLIED.
