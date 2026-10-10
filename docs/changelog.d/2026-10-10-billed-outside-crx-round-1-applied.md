## 2026-10-10 - Billed-outside-CRX schema and deleted-order freeze APPLIED LIVE

- `20261007150000_record_deliveries_billed_outside_crx` applied 2026-10-10 01:45Z (ledger
  `20261010014555`) with the owner's Windows Hello approval (the scanner flags it destructive for
  the word TRUNCATE in its privilege postflight). Live-verified: delivery_external_billings (5
  columns, RLS on, 0 rows, no API writes), the recording, invoice and order-lock triggers enabled,
  and the dashboard function updated and running.
- `20261007150050_lock_soft_deleted_orders` applied 2026-10-10 01:46Z (ledger `20261010014642`).
  Live-verified: the three deleted-order lock triggers enabled.
- Schema registry and `src/types/supabase.ts` regenerated from live (the new table; plus two
  pre-existing commission-report fields the generator now types as non-null). All 29
  db-invariant sweeps PASS.
- Still pending: `20261007150100` (mark 53 deliveries) and `20261007150200` (release reservations,
  Windows Hello).
