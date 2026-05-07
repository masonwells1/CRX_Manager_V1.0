-- ============================================================================
-- Wave B.1 — Persist field-app Applied Info (audit finding P2-1)
-- ----------------------------------------------------------------------------
-- The "Applied Info" tab on FieldApplicationInvoice.tsx renders three editable
-- inputs (windDirection, temperature, applicator) that look identical to the
-- rest of the form, are styled with the same green focus ring, and flip the
-- dirty flag — but the values were local React state only:
--
--   - windDirection was used as a per-location FALLBACK in the Save and
--     Preview RPC payloads (l.wind_direction || windDirection || null), but
--     the invoice-level value itself was never persisted.
--   - temperature and applicator were never read anywhere except their own
--     onChange handlers.
--
-- After save+reload, all three fields were blank — silently discarding what
-- the user thought they captured. State compliance, dispute defence, and
-- applicator history all live in these fields.
--
-- Per Mason's answer to audit Q9: these are business-internal only, NOT
-- required by Illinois state law. Columns are nullable; the page should
-- soft-warn on blank but never reject. invoices.applicator_name already
-- exists (added by a prior migration but never wired); this migration adds
-- the two missing columns.
-- ============================================================================

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS wind_direction text,
  ADD COLUMN IF NOT EXISTS temperature    text;

COMMENT ON COLUMN invoices.wind_direction IS
  'Field-app invoice-level applied-info wind direction (free-form text — e.g. "NW @ 5mph"). Per-location wind in field_app_locations.wind_direction is preferred when set; this column is the fallback default for the day. Wave B.1 / audit finding P2-1.';
COMMENT ON COLUMN invoices.temperature IS
  'Field-app invoice-level applied-info temperature (free-form text — e.g. "72F"). Wave B.1 / audit finding P2-1.';
COMMENT ON COLUMN invoices.applicator_name IS
  'Name of the person who applied the chemicals. Wave B.1 / audit finding P2-1 wired the read+write path for this previously-unused column.';
