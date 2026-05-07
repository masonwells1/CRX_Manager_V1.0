-- ============================================================================
-- Wave B audit follow-up — rename invoices.temperature to temperature_text
-- (audit finding B-3)
-- ----------------------------------------------------------------------------
-- Wave B.1 (20260507100000) added invoices.temperature as a free-form text
-- column for the field-app "Applied Info" tab. The shape conflicted with
-- five sibling temperature fields elsewhere in the codebase that are all
-- numeric:
--   - BlendTicket.temperature                  : number
--   - FieldAppLocation.temperature             : number
--   - JobAppliedInfo.temperature               : number
--   - reportPdf.ts assumes numeric             : number
--   - LogbookReport.tsx assumes numeric        : number
--
-- src/pages/JobDetail.tsx already renders {appliedInfo.temperature}°F
-- assuming numeric. The Wave B.1 column comment example "72F" would render
-- as "72F°F". Reports that aggregate temperature across types would break.
--
-- Per Mason's Q9 the value is intentionally free-form (the user might write
-- "72F" or "high 70s" or "75 °F"), so we keep the text type but rename the
-- column so the contract surface clearly signals "unparsed entry":
--
--   invoices.temperature  ->  invoices.temperature_text
--
-- This is a column-rename only. No data is touched. The Invoice TypeScript
-- interface and FieldApplicationInvoice.tsx are updated in the same commit.
-- ============================================================================

ALTER TABLE invoices RENAME COLUMN temperature TO temperature_text;

COMMENT ON COLUMN invoices.temperature_text IS
  'Field-app invoice-level applied-info temperature, free-form text (e.g. "72F", "high 70s"). Renamed from "temperature" in Wave B audit B-3 to disambiguate from the numeric temperature columns on blend_tickets, field_app_locations, and job_applied_info.';
