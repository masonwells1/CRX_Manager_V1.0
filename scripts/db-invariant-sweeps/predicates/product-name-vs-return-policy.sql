-- predicate: product-name-vs-return-policy
-- Supplier Pricing Phase 3 Stage C classified the catalog's return policies from
-- an owner-approved packet keyed by product id (migration 20260729213733). The
-- classification is a point-in-time snapshot: nothing in the schema stops a new
-- product arriving tomorrow whose name advertises "NO RETURN" while its
-- return_policy sits at the 'unknown' default, and 'unknown' does NOT trip
-- assert_phase3_return_policy(). The app would happily accept a return the
-- supplier will not honor, and the loss lands on Crop RX.
-- Owner decision 2026-07-29 (Mason): carry the name-vs-policy relationship
-- forward as a permanent check.
--
-- Contract: EXPECT ZERO rows. A row means a product whose NAME asserts it cannot
-- be returned is not classified 'no_return'. Baseline at authoring time: 0
-- violations across 604 products (21 no_return / 2 returnable / 581 unknown) —
-- every one of the 21 matches this pattern and nothing outside them does.
--
-- Deliberate scope decisions:
--
-- * Detector, not a CHECK constraint. A CHECK tying product_name to
--   return_policy would deadlock the ordinary rename path. The live governance
--   trigger is BEFORE INSERT OR UPDATE OF product_family_id, return_policy,
--   packaging_variant, is_full_tote_only — a rename alone does not fire it, but
--   satisfying such a CHECK would force return_policy into the same UPDATE,
--   which does fire it and raises PRODUCT_PHASE3_METADATA_GOVERNED. Renaming a
--   product to include "NO RETURN" would become impossible through the app.
--   A standing sweep surfaces the drift without wedging the edit path.
--
-- * One direction only. The reverse case (return_policy = 'no_return' on a
--   product whose name says nothing) is NOT a violation: it is the expected
--   shape once policies are classified from supplier sheets rather than names,
--   and its failure mode is safe — the app blocks a return that might have been
--   allowed, rather than allowing one that will be refused.
--
-- * No bare "NR" token. It reads as a no-return marker on some supplier SKUs but
--   collides with formulation codes; today it matches zero product names, so
--   including it would buy nothing and cost false positives later.
--
-- * Every alternative is anchored with \m (start-of-word). Without it, "no" would
--   match inside an ordinary word and a name like "MONO RETURN VALVE" would be
--   flagged. The phrase set covers both word orders of the final-sale wording
--   ("FINAL SALE" and "ALL SALES FINAL") and "NON RETURN" separated by a space,
--   a hyphen, or nothing at all. Regression cases for the intended phrase set —
--   and for the near-miss false positives — are asserted in
--   src/__tests__/predicate-product-name-vs-return-policy.test.ts, which reads
--   this pattern out of this file so the two cannot drift apart.
--
-- * Inactive products are in scope. is_active = false only stops new sales; a
--   return can still be filed against a product sold before it was retired.
--   is_active is emitted as a triage column instead.
--
-- CONTAINMENT — the CRX_Manager_V1.0 repo is PUBLIC. Product names and supplier
-- SKUs must never enter a tracked file. This predicate therefore selects the
-- product id and never the name or SKU, so a violation_key is safe to paste into
-- the tracked allowlist.json. Do not add a name or SKU column to this query, and
-- do not paste product names into any allowlist justification — look the id up in
-- the app instead.

WITH flagged AS (
  SELECT p.id,
         p.return_policy,
         p.is_active
    FROM public.products p
   WHERE p.product_name ~* '(\mno[[:space:][:punct:]]*returns?\M)|(\mnon[[:space:][:punct:]]*return(s|able)?\M)|(\mnot[[:space:][:punct:]]*returnable\M)|(\mfinal[[:space:][:punct:]]*sales?\M)|(\msales?[[:space:][:punct:]]*final\M)'
)
SELECT 'products:' || f.id::text AS violation_key,
       'product name asserts it cannot be returned but return_policy is '
         || quote_literal(f.return_policy)
         || ' — assert_phase3_return_policy() will not block a return on it'
         AS reason,
       f.is_active
  FROM flagged f
 WHERE f.return_policy IS DISTINCT FROM 'no_return'
 ORDER BY f.id;
