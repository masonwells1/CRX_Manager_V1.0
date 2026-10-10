-- STATUS: NOT APPLIED.
-- ONE-SHOT DATA migration (owner-approved in chat, 2026-10-07; registered in
-- supabase/baselines/one-shot-migrations.json): record 53 completed spring 2026 deliveries on
-- 33 orders as billed outside CRX. Mason confirmed they were billed in Chem Man, CRX's predecessor,
-- before CRX invoicing was in use.
--
--   * 26 fulfilled orders with no CRX invoice at all (36 deliveries);
--   * ORD-2026-0186: delivery DEL-00031 only — its other delivery, DEL-00074, is covered by the CRX
--     draft invoice CS-2026-0055 and is deliberately NOT recorded (the guard would refuse it);
--   * 6 partially fulfilled orders (0161, 0162, 0172, 0176, 0331, 0343): only their COMPLETED
--     deliveries. Anything delivered on them later is billed in CRX as normal.
--
-- Effect: inserts 53 rows into delivery_external_billings (20261007150000). Creates no invoice,
-- revenue or AR, moves no stock, changes no existing row. The table's guard trigger re-checks every
-- row at insert time: completed, not deleted, on an order, and not covered by an active CRX invoice.
-- None of these orders has field allocations (checked 2026-10-07), so none is a split-billed order.
--
-- Re-runnable while all 53 deliveries are still completed: ON CONFLICT DO NOTHING, then the
-- postflight asserts all 53 are recorded (after a void, a re-run fails closed at the preflight).
-- Rollback (new reviewed migration): DELETE FROM public.delivery_external_billings WHERE delivery_id
-- IN (the 53 below). That only removes the records; nothing else was changed.
-- ORDERING: strictly after 20261007150000_record_deliveries_billed_outside_crx.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE crx_chem_man_deliveries (delivery_number text PRIMARY KEY, order_number text NOT NULL)
  ON COMMIT DROP;

INSERT INTO crx_chem_man_deliveries (delivery_number, order_number) VALUES
    ('DEL-00060', 'ORD-2026-0152'),
    ('DEL-00050', 'ORD-2026-0153'),
    ('DEL-00080', 'ORD-2026-0153'),
    ('DEL-00048', 'ORD-2026-0160'),
    ('DEL-00078', 'ORD-2026-0160'),
    ('DEL-00035', 'ORD-2026-0161'),
    ('DEL-00071', 'ORD-2026-0161'),
    ('DEL-00081', 'ORD-2026-0161'),
    ('DEL-00024', 'ORD-2026-0162'),
    ('DEL-00040', 'ORD-2026-0162'),
    ('DEL-00066', 'ORD-2026-0169'),
    ('DEL-00056', 'ORD-2026-0170'),
    ('DEL-00057', 'ORD-2026-0171'),
    ('DEL-00055', 'ORD-2026-0172'),
    ('DEL-00037', 'ORD-2026-0174'),
    ('DEL-00054', 'ORD-2026-0174'),
    ('DEL-00004', 'ORD-2026-0176'),
    ('DEL-00034', 'ORD-2026-0176'),
    ('DEL-00076', 'ORD-2026-0176'),
    ('DEL-00012', 'ORD-2026-0177'),
    ('DEL-00044', 'ORD-2026-0178'),
    ('DEL-00046', 'ORD-2026-0178'),
    ('DEL-00061', 'ORD-2026-0178'),
    ('DEL-00039', 'ORD-2026-0179'),
    ('DEL-00047', 'ORD-2026-0179'),
    ('DEL-00013', 'ORD-2026-0182'),
    ('DEL-00079', 'ORD-2026-0182'),
    ('DEL-00014', 'ORD-2026-0183'),
    ('DEL-00031', 'ORD-2026-0186'),
    ('DEL-00030', 'ORD-2026-0188'),
    ('DEL-00053', 'ORD-2026-0188'),
    ('DEL-00032', 'ORD-2026-0331'),
    ('DEL-00042', 'ORD-2026-0331'),
    ('DEL-00067', 'ORD-2026-0331'),
    ('DEL-00033', 'ORD-2026-0343'),
    ('DEL-00052', 'ORD-2026-0343'),
    ('DEL-00088', 'ORD-2026-0343'),
    ('DEL-00092', 'ORD-2026-0343'),
    ('DEL-00026', 'ORD-2026-0344'),
    ('DEL-00041', 'ORD-2026-0344'),
    ('DEL-00051', 'ORD-2026-0344'),
    ('DEL-00062', 'ORD-2026-0347'),
    ('DEL-00063', 'ORD-2026-0348'),
    ('DEL-00064', 'ORD-2026-0349'),
    ('DEL-00068', 'ORD-2026-0350'),
    ('DEL-00069', 'ORD-2026-0351'),
    ('DEL-00070', 'ORD-2026-0352'),
    ('DEL-00072', 'ORD-2026-0353'),
    ('DEL-00089', 'ORD-2026-0358'),
    ('DEL-00090', 'ORD-2026-0359'),
    ('DEL-00091', 'ORD-2026-0360'),
    ('DEL-00093', 'ORD-2026-0361'),
    ('DEL-00094', 'ORD-2026-0362');

DO $preflight$
BEGIN
  IF to_regclass('public.delivery_external_billings') IS NULL THEN
    RAISE EXCEPTION 'CHEM_MAN_MARK_PREFLIGHT: apply 20261007150000_record_deliveries_billed_outside_crx first';
  END IF;
  -- The per-row safety checks live in this guard; refuse if it is not in place.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.delivery_external_billings'::regclass
                  AND tgname = 'trg_guard_delivery_external_billing' AND tgenabled = 'O' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'CHEM_MAN_MARK_PREFLIGHT: the recording guard trigger is missing or disabled';
  END IF;
  IF (SELECT count(*) FROM crx_chem_man_deliveries) <> 53
     OR (SELECT count(DISTINCT order_number) FROM crx_chem_man_deliveries) <> 33 THEN
    RAISE EXCEPTION 'CHEM_MAN_MARK_PREFLIGHT: expected 53 deliveries on 33 orders';
  END IF;
  -- Every listed delivery must be exactly one completed, live delivery on the named order.
  IF (SELECT count(*)
        FROM crx_chem_man_deliveries c
        JOIN public.deliveries d ON d.delivery_number = c.delivery_number
        JOIN public.orders o ON o.id = d.order_id AND o.order_number = c.order_number
       WHERE d.status = 'completed' AND d.deleted_at IS NULL AND o.deleted_at IS NULL) <> 53 THEN
    RAISE EXCEPTION 'CHEM_MAN_MARK_PREFLIGHT: a listed delivery is missing, not completed, deleted, or on a different order';
  END IF;
  -- None of these orders may be split-billed: recording a delivery of a split-billed order would
  -- leave its remaining deliveries unbillable in CRX (see 20261007150000's header).
  IF EXISTS (
    SELECT 1
      FROM crx_chem_man_deliveries c
      JOIN public.orders o ON o.order_number = c.order_number
     WHERE o.needs_split_billing IS TRUE
        OR EXISTS (SELECT 1 FROM public.order_item_field_allocations a
                     JOIN public.order_items oi ON oi.id = a.order_item_id
                    WHERE oi.order_id = o.id)
  ) THEN
    RAISE EXCEPTION 'CHEM_MAN_MARK_PREFLIGHT: a listed order is split-billed; re-check before recording';
  END IF;
  -- The recorder is Mason's admin profile.
  IF NOT EXISTS (SELECT 1 FROM public.profiles
                  WHERE id = '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f' AND role = 'admin' AND is_active) THEN
    RAISE EXCEPTION 'CHEM_MAN_MARK_PREFLIGHT: recording profile is not an active admin';
  END IF;
END
$preflight$;

INSERT INTO public.delivery_external_billings (delivery_id, reason, recorded_by)
SELECT d.id,
       'Billed outside CRX in Chem Man (spring 2026, before CRX invoicing was in use); owner confirmed 2026-10-07',
       '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f'::uuid
  FROM crx_chem_man_deliveries c
  JOIN public.deliveries d ON d.delivery_number = c.delivery_number
 ORDER BY d.id
ON CONFLICT (delivery_id) DO NOTHING;

DO $postflight$
BEGIN
  IF (SELECT count(*)
        FROM crx_chem_man_deliveries c
        JOIN public.deliveries d ON d.delivery_number = c.delivery_number
        JOIN public.delivery_external_billings b ON b.delivery_id = d.id) <> 53 THEN
    RAISE EXCEPTION 'CHEM_MAN_MARK_POSTFLIGHT: not all 53 deliveries are recorded';
  END IF;
END
$postflight$;
