-- ============================================================================
-- APPLIED LIVE 2026-07-02 (Mason authorized; gated MCP apply; rls-security + migration-drift + Codex CLEAN; verified live).
-- Mason applies via the DRAFT/APPLY protocol after review. Directions CONFIRMED by Mason
-- 2026-07-02: 'Nufarm' canonical casing; 'Bayer (BASF)' LEFT ALONE.
--
-- SCOPE NARROWED (Codex P2, 2026-07-02): this migration does MANUFACTURER merges ONLY
-- (products.manufacturer). The VENDOR merges (The Andersons, Van Diest) were PULLED OUT —
-- grounding found the `vendors` MASTER table carries BOTH spellings as SEPARATE rows, and
-- create_vendor_bill matches vendors.name to purchase_orders.vendor, so renaming only the PO
-- strings would desync the master and throw VENDOR_PO_MISMATCH on AP billing. A correct vendor
-- fix is a full master MERGE (FK repoint on vendor_bills/vendor_payments + dedup + rename PO &
-- products strings together) — deferred to the Wave-2 loop as "vendor master consolidation".
--
-- WHAT: consolidate misspelled/variant manufacturer free-text strings into one canonical each.
-- WHY:  products.manufacturer is free-typed; rebate program matching copies it verbatim, so typos
--       split matching. Safe now: no FK on the string; rebate_programs/rebate_claims are 0 rows;
--       manufacturer is NOT read by create_vendor_bill (that keys off vendor, untouched here).
-- SCOPE: pure UPDATEs on products.manufacturer, each narrow (WHERE col = exact string). Includes
--        2 extra typos grounding found (Buffallo Molasses, Ag Bio Logic LLC.). trg_validate_product_units
--        fires on products UPDATE but grounding verified ZERO of these rows fail its unit check.
--
-- SMOKE (2026-07-02, live tx aborted via RAISE — NOTHING persisted): 10 rows updated total
--   (1 Cortteva→Corteva, 2 Syngeta/Syngtenta→Syngenta, 2 NuFarm→Nufarm, 1 Alchemy Bioscience→
--   BioScience, 2 Buffallo→Buffalo, 2 'Ag Bio Logic LLC.'→'Ag Bio Logic LLC') — matches grounding.
-- CODEX: <PENDING — /codex-review this session>
-- ============================================================================

UPDATE public.products SET manufacturer = 'Corteva'            WHERE manufacturer = 'Cortteva';            -- 1
UPDATE public.products SET manufacturer = 'Syngenta'           WHERE manufacturer IN ('Syngeta', 'Syngtenta'); -- 2
UPDATE public.products SET manufacturer = 'Nufarm'             WHERE manufacturer = 'NuFarm';               -- 2 (Mason: Nufarm canonical)
UPDATE public.products SET manufacturer = 'Alchemy BioScience' WHERE manufacturer = 'Alchemy Bioscience';   -- 1 (majority casing)
UPDATE public.products SET manufacturer = 'Buffalo Molasses'   WHERE manufacturer = 'Buffallo Molasses';    -- 2 (extra typo found)
UPDATE public.products SET manufacturer = 'Ag Bio Logic LLC'   WHERE manufacturer = 'Ag Bio Logic LLC.';    -- 2 (extra: trailing period)
