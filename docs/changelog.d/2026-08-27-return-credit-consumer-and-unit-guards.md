## 2026-08-27 - Return-credit consumer and inventory-unit guards

- Order Detail and the Orders list now count only active, non-deleted sale invoices as billing coverage. A return credit no longer hides the Create Invoice recovery action or reduces an order's invoiced percentage.
- Return receiving now validates every linked restocked line against the authoritative order-item product and unit before writing inventory, and seeds a missing warehouse row with that source unit. The one verified source-free legacy RMA keeps its immutable stored unit because no order item exists for comparison.
- The rollback-only return-credit smoke plants a unit mismatch and proves both the public source-verification wrapper and the private receive implementation reject it without creating inventory or advancing the return, before restoring the fixture and exercising the successful receive path.
- Verification: 45 focused UI/migration tests passed, the full suite passed 4,814 tests with 123 skipped, typecheck/lint/docs/build passed, and the fresh-live-read-only-schema disposable proof ended with 40 mutant detections, `SMOKE_PASS_ROLLBACK`, and zero residue.
