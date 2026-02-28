# Migration History (83 migrations)

Migrations are in `supabase/migrations/` ordered by timestamp prefix.

| # | Timestamp | Description |
|---|-----------|-------------|
| 1 | 20260206172436 | Full schema creation (all tables, indexes, RLS) |
| 2 | 20260206174345 | Security & performance fixes (consolidated RLS, auth.uid() optimization) |
| 3 | 20260206174743 | Profile auto-creation trigger |
| 4 | 20260206191309 | Automatic price calculation |
| 5 | 20260206191700 | Gross margin display fields |
| 6 | 20260206192224 | Fix margin terminology |
| 7 | 20260206195903 | EPA registration field |
| 8 | 20260206201328 | Team board collaboration features |
| 9 | 20260206203908 | Blend tickets system |
| 10 | 20260207000001 | Fix customer RLS for sales_rep |
| 11 | 20260207_gap_analysis_fixes | Payments table, reorder_point, commission paid fields |
| 12 | 20260207_gap_analysis_fixes_2 | Additional gap fixes |
| 13 | 20260208194203 | Soft delete for team notes |
| 14 | 20260209040254 | Fix soft delete activity logging |
| 15 | 20260209040325 | Fix payment RLS policies |
| 16 | 20260209143537 | Inventory overhaul (holds, is_planned) |
| 17 | 20260210_fix_rls_critical_issues | Sales rep INSERT permissions |
| 18 | 20260211190000 | Billing & invoicing system |
| 19 | 20260212000000 | Fields & geospatial |
| 20 | 20260212100000 | Blend recipes system |
| 21 | 20260213000000 | Inventory enhancements (warehouses, cycle counts) |
| 22 | 20260213100000 | Returns/RMA system |
| 23 | 20260213200000 | Reporting, compliance & rebates |
| 24 | 20260214000000 | Phase 4B Mapbox integration (geo RPCs, PostGIS) |
| 25 | 20260214200000 | Vehicles table |
| 26 | 20260214210000 | Applicator role expansion |
| 27 | 20260214220000 | Application records table + RPCs |
| 28 | 20260215200000 | Job scheduling tables |
| 29 | 20260216200000 | Reporting RPCs (10 report functions) |
| 30 | 20260217200000 | Accounting periods (month-end close) |
| 31 | 20260217210000 | Commission payments |
| 32 | 20260218200000 | Financial workflows (write-offs, finance charges, prepayments) |
| 33 | 20260219200000 | Invoice/statement enrichment |
| 34 | 20260219210000 | Invoice/statement RPCs |
| 35 | 20260220200000 | Finance charge intelligence |
| 36 | 20260221200000 | Grower share pricing |
| 37 | 20260222200000 | Batch operations |
| 38 | 20260223200000 | Payment allocation |
| 39 | 20260224200000 | Year-end summary |
| 40 | 20260225200000 | Delivery system enhancements |
| 41 | 20260226200000 | Receiving system enhancements |
| 42 | 20260227200000 | Delivery integrity & quick delivery |
| 43+ | Various | Safety audit, page permissions, business logic, dashboard alerts, Quick Receive |
| 44 | 20260312200000 | Business logic audit fixes: inventory hold auto-release trigger (declined/expired/accepted), `post_invoice()` period enforcement via `check_period_open()`, `save_customer()` commission split validation (must sum to 100%), `create_quick_delivery()` inventory pre-check with `FOR UPDATE` locks, `convert_quote_to_order()` explicit hold release |
| 45 | 20260315200000 | Emergency RPC fixes: 9 broken functions with wrong column references (allocate_payment, cancel_delivery, auto_expire_quotes, cancel_order, check_customer_credit_limit, create_quick_delivery schema fixes) |
| 46 | 20260315200001 | Accounting integrity & hardening: expand audit log CHECK constraints, period enforcement in 10 financial RPCs, FOR UPDATE locks, void_invoice 4-bug fix, commission season convention, cycle count guards, return processing dedup |
