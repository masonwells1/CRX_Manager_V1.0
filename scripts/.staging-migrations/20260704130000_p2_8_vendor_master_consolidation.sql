-- ============================================================================
-- P2-8 — Vendor master consolidation
-- PARKED: owner-gated. Do NOT apply without Mason's explicit OK.
-- ----------------------------------------------------------------------------
-- WHY: two vendors exist twice in the master with spelling variants, so bills,
--   POs, and product records split across both — and create_vendor_bill's
--   name<->PO match (lower(trim(po.vendor)) = lower(trim(vendor.name))) can hit
--   VENDOR_PO_MISMATCH when a bill's canonical vendor is billed against a PO that
--   still carries the duplicate spelling.
--     "The Anderson's"   -> "The Andersons"      (canonical)
--     "Van Deist Supply" -> "Van Diest Supply"   (canonical)
--
-- WHAT (one migration, applies atomically). EVERY step is gated on the CANONICAL
--   vendor existing AND being active (deleted_at IS NULL) — Codex P2 hardening: a
--   pair whose canonical is missing/soft-deleted is skipped ENTIRELY, so we never
--   rename strings onto a non-existent master or soft-delete a duplicate that has
--   no canonical twin. (On live 2026-07-04 both canonicals are present + active, so
--   all pairs apply; the guard just makes the script safe on any environment/drift.)
--   1) Repoint vendor_bills.vendor_id off each duplicate onto its active canonical.
--      vendor_bills.vendor_id is the ONLY FK to vendors (vendor_payments links to
--      vendor_bills, not vendors). 0 bills reference the duplicates live.
--   2) Normalize the free-text vendor strings on purchase_orders (3 rows) and
--      products (72 rows) to the canonical spelling.
--   3) Soft-delete each duplicate vendor row (deleted_at). REVERSIBLE and safe:
--      create_vendor_bill already rejects a soft-deleted vendor (VENDOR_NOT_FOUND),
--      and both UI read paths — Vendors list (Vendors.tsx:58) and the bill picker
--      (NewVendorBill.tsx:65) — filter deleted_at IS NULL, so the duplicate leaves
--      every picker while history is preserved. No HARD delete (data-safe).
--
-- PROOF: rolled-back live smoke (before/after counts). Codex R2 verdict: <pending>.
-- ============================================================================

-- 1) Repoint vendor_bills FKs (defensive; 0 rows today). Gated on active canonical.
WITH m AS (
  SELECT d.id AS dup_id, c.id AS canon_id
  FROM (VALUES ('The Anderson''s', 'The Andersons'),
               ('Van Deist Supply', 'Van Diest Supply')) AS p(dup_name, canon_name)
  JOIN vendors d ON d.name = p.dup_name
  JOIN vendors c ON c.name = p.canon_name AND c.deleted_at IS NULL
)
UPDATE vendor_bills vb
   SET vendor_id = m.canon_id
  FROM m
 WHERE vb.vendor_id = m.dup_id;

-- 2) Normalize the free-text vendor strings (only pairs with an active canonical).
WITH m AS (
  SELECT p.dup_name, p.canon_name
  FROM (VALUES ('The Anderson''s', 'The Andersons'),
               ('Van Deist Supply', 'Van Diest Supply')) AS p(dup_name, canon_name)
  JOIN vendors c ON c.name = p.canon_name AND c.deleted_at IS NULL
)
UPDATE purchase_orders po
   SET vendor = m.canon_name
  FROM m
 WHERE po.vendor = m.dup_name;

WITH m AS (
  SELECT p.dup_name, p.canon_name
  FROM (VALUES ('The Anderson''s', 'The Andersons'),
               ('Van Deist Supply', 'Van Diest Supply')) AS p(dup_name, canon_name)
  JOIN vendors c ON c.name = p.canon_name AND c.deleted_at IS NULL
)
UPDATE products pr
   SET vendor = m.canon_name
  FROM m
 WHERE pr.vendor = m.dup_name;

-- 3) Soft-delete each duplicate — ONLY when its canonical exists and is active.
WITH m AS (
  SELECT d.id AS dup_id
  FROM (VALUES ('The Anderson''s', 'The Andersons'),
               ('Van Deist Supply', 'Van Diest Supply')) AS p(dup_name, canon_name)
  JOIN vendors d ON d.name = p.dup_name
  JOIN vendors c ON c.name = p.canon_name AND c.deleted_at IS NULL
)
UPDATE vendors v
   SET deleted_at = now(),
       updated_at = now()
  FROM m
 WHERE v.id = m.dup_id
   AND v.deleted_at IS NULL;
