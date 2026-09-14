## 2026-09-13 - Receiving recovery source contracts

Updated existing inventory and accounts-payable source assertions to match the reviewed receiving recovery behavior: route changes clear the visible cleanup notice, restored requests use neutral reconciliation wording, owned pending receipts prevent dismissal, and foreign requests cannot be submitted from this page. The receiving success contract also checks that data refresh happens before cleanup failure suppresses form dismissal.

No product code, database migration, or live data changed. The two affected suites pass all 43 tests; type checking, lint and build pass. Complete coverage and final delivery evidence are recorded separately when those runs finish.
