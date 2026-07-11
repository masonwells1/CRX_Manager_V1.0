-- =============================================================================
-- fin-invoice-balance-identity.sql — invoice balance components vs their ledgers
-- C9 financial identity suite (docs/audits/2026-06-10-error-prevention-review.md §4)
--
-- IDENTITY
--   invoices.balance_cents is GENERATED ALWAYS AS
--     (total_amount_cents - paid_amount_cents - prepay_applied_cents - write_off_cents)
--   so the generated column itself cannot drift — but its three cached inputs
--   can. For every non-deleted invoice in status ('posted','overdue','paid'):
--     1. write_off_cents     == SUM(write_offs.amount_cents WHERE reversed_at IS NULL)
--     2. prepay_applied_cents == SUM(prepay_applications.applied_amount_cents)
--     3. paid_amount_cents   == SUM(invoice_line_allocations.amount_cents
--                                    via ACTIVE allocation_sets, entity_type='payment')
--                             + SUM(financial_audit_log 'payment_recorded' rows
--                                    for this invoice — the record_invoice_payment
--                                    path, which writes a payments row keyed by
--                                    ORDER, not invoice; the audit log is the only
--                                    per-invoice ledger of that path)
--
-- WOULD HAVE CAUGHT
--   The cached-component drift class behind B2/P1A money findings: any write
--   path that bumps a cached cents column without its ledger row (or vice
--   versa) — e.g. a partial failure between INSERT INTO write_offs and the
--   UPDATE invoices, or a void path that reverses one side only
--   (void_payment's GREATEST(...,0) clamp can silently absorb cents here).
--
-- EXPECTED RESULT
--   Zero rows. Every row is a violation; one row per (invoice, component).
--   First column = stable identity key 'invoice:<uuid>:<component>'.
--
-- KNOWN FALSE-POSITIVE MODES
--   * paid_amount_cents reconstruction depends on financial_audit_log
--     completeness for the legacy record_invoice_payment path. Invoices paid
--     before that RPC logged 'payment_recorded' (or paid by direct SQL) will
--     flag as paid_amount_drift; triage into the FIN-README baseline with row
--     identities, never delete from results.
--   * A void/refund path for record_invoice_payment-style payments does not
--     exist today (payments.deleted_at is never set by any live RPC). If one
--     is added and it does not log a compensating audit row keyed to the
--     invoice, every voided legacy payment will (correctly) flag here until
--     the reconstruction learns the new ledger.
--   * Voided/cancelled/draft/unposted invoices are out of population:
--     void_invoice and cancel_order rewrite their components wholesale.
--   * Credit memos are IN population (status 'posted'): issue_return_credit
--     creates them with paid=prepay=0 and negative total; all three component
--     identities must still hold (their ledgers should simply be empty).
--
-- SCHEMA FACTS (verified live 2026-06-10 against rhyzpcqhnizqbxphqdkr pg_catalog)
--   invoices(id, invoice_number, customer_id, status, invoice_type,
--     total_amount_cents, paid_amount_cents, prepay_applied_cents,
--     write_off_cents, balance_cents GENERATED, deleted_at)
--   write_offs(id, invoice_id, amount_cents CHECK > 0, reversed_at)
--   prepay_applications(id, invoice_id, applied_amount_cents) — immutable
--     (trigger), deleted only under bypass in void_invoice (out of population)
--   invoice_line_allocations(allocation_set_id, invoice_id, amount_cents)
--   allocation_sets(id, entity_type, is_active) — void_payment flips is_active
--   financial_audit_log(operation_type, entity_type 'payment', entity_id,
--     new_values jsonb with 'invoice_id' and 'amount_cents') — written by
--     record_invoice_payment as operation_type='payment_recorded'
--   paid_amount_cents writers in population: allocate_payment,
--     record_invoice_payment, void_payment (verified: cancel_order,
--     create_quick_delivery, transfer_job_to_invoice, issue_return_credit only
--     touch out-of-population statuses or set components to 0 at insert)
-- =============================================================================
WITH population AS (
  SELECT i.id, i.invoice_number, i.customer_id, i.status, i.invoice_type,
         i.paid_amount_cents, i.prepay_applied_cents, i.write_off_cents,
         i.credit_applied_cents
  FROM invoices i
  WHERE i.deleted_at IS NULL
    AND i.status IN ('posted', 'overdue', 'paid')
),
-- credit-memo apply (mig 20260711030000): the 5th balance lever. An invoice is on
-- exactly one side of any application (a memo is never a target and vice-versa), so
-- SUM over both role-columns yields that invoice's own applied total.
credit_ledger AS (
  SELECT inv_id, SUM(amount_cents)::bigint AS cents
  FROM (
    SELECT credit_memo_id    AS inv_id, amount_cents FROM credit_memo_applications WHERE reversed_at IS NULL
    UNION ALL
    SELECT target_invoice_id AS inv_id, amount_cents FROM credit_memo_applications WHERE reversed_at IS NULL
  ) x
  GROUP BY inv_id
),
wo_ledger AS (
  SELECT invoice_id, SUM(amount_cents)::bigint AS cents
  FROM write_offs
  WHERE reversed_at IS NULL
  GROUP BY invoice_id
),
prepay_ledger AS (
  SELECT invoice_id, SUM(applied_amount_cents)::bigint AS cents
  FROM prepay_applications
  GROUP BY invoice_id
),
alloc_ledger AS (
  SELECT ila.invoice_id, SUM(ila.amount_cents)::bigint AS cents
  FROM invoice_line_allocations ila
  JOIN allocation_sets s ON s.id = ila.allocation_set_id
  WHERE s.entity_type = 'payment'
    AND s.is_active
  GROUP BY ila.invoice_id
),
legacy_payment_ledger AS (
  SELECT (fal.new_values ->> 'invoice_id')::uuid AS invoice_id,
         SUM((fal.new_values ->> 'amount_cents')::bigint)::bigint AS cents
  FROM financial_audit_log fal
  WHERE fal.operation_type = 'payment_recorded'
    AND fal.new_values ? 'invoice_id'
    AND fal.new_values ? 'amount_cents'
  GROUP BY 1
)

SELECT
  'invoice:' || p.id::text || ':write_off'                   AS identity_key,
  'write_off_drift'::text                                    AS violation_type,
  p.customer_id,
  COALESCE(w.cents, 0)                                       AS expected_cents,  -- ledger truth
  p.write_off_cents                                          AS actual_cents,    -- cached column
  'invoice ' || p.invoice_number || ' (' || p.status || '): cached write_off_cents='
    || p.write_off_cents::text || ' but SUM(unreversed write_offs)='
    || COALESCE(w.cents, 0)::text                            AS detail
FROM population p
LEFT JOIN wo_ledger w ON w.invoice_id = p.id
WHERE p.write_off_cents <> COALESCE(w.cents, 0)

UNION ALL

SELECT
  'invoice:' || p.id::text || ':prepay',
  'prepay_applied_drift'::text,
  p.customer_id,
  COALESCE(pp.cents, 0),
  p.prepay_applied_cents,
  'invoice ' || p.invoice_number || ' (' || p.status || '): cached prepay_applied_cents='
    || p.prepay_applied_cents::text || ' but SUM(prepay_applications)='
    || COALESCE(pp.cents, 0)::text
FROM population p
LEFT JOIN prepay_ledger pp ON pp.invoice_id = p.id
WHERE p.prepay_applied_cents <> COALESCE(pp.cents, 0)

UNION ALL

SELECT
  'invoice:' || p.id::text || ':paid',
  'paid_amount_drift'::text,
  p.customer_id,
  COALESCE(al.cents, 0) + COALESCE(lp.cents, 0),
  p.paid_amount_cents,
  'invoice ' || p.invoice_number || ' (' || p.status || '): cached paid_amount_cents='
    || p.paid_amount_cents::text
    || ' but active allocations=' || COALESCE(al.cents, 0)::text
    || ' + audited legacy payments=' || COALESCE(lp.cents, 0)::text
    || ' = ' || (COALESCE(al.cents, 0) + COALESCE(lp.cents, 0))::text
FROM population p
LEFT JOIN alloc_ledger al          ON al.invoice_id = p.id
LEFT JOIN legacy_payment_ledger lp ON lp.invoice_id = p.id
WHERE p.paid_amount_cents <> COALESCE(al.cents, 0) + COALESCE(lp.cents, 0)

UNION ALL

SELECT
  'invoice:' || p.id::text || ':credit',
  'credit_applied_drift'::text,
  p.customer_id,
  COALESCE(cr.cents, 0),
  p.credit_applied_cents,
  'invoice ' || p.invoice_number || ' (' || p.status || '): cached credit_applied_cents='
    || p.credit_applied_cents::text || ' but SUM(unreversed credit_memo_applications)='
    || COALESCE(cr.cents, 0)::text
FROM population p
LEFT JOIN credit_ledger cr ON cr.inv_id = p.id
WHERE p.credit_applied_cents <> COALESCE(cr.cents, 0)

ORDER BY violation_type, identity_key;
