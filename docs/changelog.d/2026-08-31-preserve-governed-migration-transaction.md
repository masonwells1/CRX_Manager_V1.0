## 2026-08-31 - Preserve the governed migration transaction

The gauntlet cutover safety fix originally added explicit transaction wrappers
around four migration files. CRX's governed migration runner already supplies
the outer transaction, so an inner `COMMIT` could prematurely commit that
runner-owned transaction and separate schema changes from ledger handling.

The redundant wrappers were removed. The shared receipt-table locks and
fail-closed legacy-receipt checks are unchanged and remain held by the governed
outer transaction for each complete migration.
