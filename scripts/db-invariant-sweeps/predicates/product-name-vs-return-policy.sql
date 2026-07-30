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
-- * Every alternative is anchored with \m (start-of-word). Without it, "no"
--   matches inside an ordinary word and a name ending "...NO RETURN" would be
--   claimed by any word merely ending in "no". The phrase set covers both word
--   orders of the final-sale wording ("FINAL SALE", "ALL SALES FINAL", and
--   "ALL SALES ARE FINAL") and NO/NON RETURN separated by a space, a hyphen, or
--   nothing at all.
--
-- * "NON-RETURN VALVE" is excluded by a negative lookahead. A non-return valve
--   (equivalently a check valve) is a real piece of spray equipment, and its
--   name is a hydraulic description, not a merchandise policy. Without the
--   exclusion a perfectly returnable valve would be flagged forever, and the
--   only way to quiet it would be to misclassify it or allowlist it.
--
--   The exclusion is narrowed twice over, because the equipment term is exactly
--   "NON-RETURN VALVE" and nothing else:
--     - it covers RETURN/RETURNS but NOT RETURNABLE — "NON-RETURNABLE VALVE"
--       says the valve cannot be sent back, which is the policy this predicate
--       exists to catch;
--     - it applies to the NON spelling but NOT to NO — "NO RETURN VALVE" is a
--       policy marker on a valve, not the name of a check valve.
--   That is why NO and NON are separate alternatives below rather than the
--   tidier (no|non). Widening the lookahead in either direction silently drops
--   a real violation, which is a false negative on the unsafe side.
--
-- * A no-return assertion is often written as a compound: "NO REFUNDS OR
--   RETURNS", "NOT REFUNDABLE OR RETURNABLE". The separator class only spans
--   whitespace and punctuation, so an intervening WORD used to break the match
--   and the product kept the 'unknown' default with the sweep silent — another
--   false negative on the unsafe side. All three negation alternatives — NO,
--   NOT and NON — therefore allow one optional refund/exchange/credit clause
--   between the negation and the return word. The vocabulary is a closed list
--   on purpose: allowing any intervening words would let "NO TILL ... RETURN
--   TRAY" style names match. On the NON alternative the clause is attached to
--   the RETURNABLE arm only, leaving the RETURN/RETURNS arm and its valve
--   lookahead exactly as described above.
--
-- * The negation does not always come first. "RETURNS NOT ACCEPTED" and
--   "RETURN NOT ALLOWED" reject a return just as plainly, and every
--   negation-first alternative misses them. A return-first alternative covers
--   that word order, again over a closed verb list (accepted/allowed/
--   permitted) so that an ordinary name like "RETURN LABEL NOT INCLUDED" does
--   not flag.
--
--   Regression cases for the intended phrase set — and for the near-miss false
--   positives — are asserted in
--   src/__tests__/predicate-product-name-vs-return-policy.test.ts, which reads
--   this pattern out of this file so the two cannot drift apart. Those fixtures
--   are synthetic strings, never real catalog names (see CONTAINMENT below).
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
   WHERE p.product_name ~* '(\mnon[[:space:][:punct:]]*(return(s)?\M(?![[:space:][:punct:]]*valves?\M)|((refundable|exchangeable)[[:space:][:punct:]]*(or|and)?[[:space:][:punct:]]*)?returnable\M))|(\mno[[:space:][:punct:]]*((refunds?|exchanges?|credits?)[[:space:][:punct:]]*(or|and)?[[:space:][:punct:]]*)?return(s|able)?\M)|(\mnot[[:space:][:punct:]]*((refundable|exchangeable)[[:space:][:punct:]]*(or|and)?[[:space:][:punct:]]*)?returnable\M)|(\mreturns?[[:space:][:punct:]]*((are|is)[[:space:][:punct:]]*)?not[[:space:][:punct:]]*(accepted|allowed|permitted)\M)|(\mfinal[[:space:][:punct:]]*sales?\M)|(\msales?[[:space:][:punct:]]*(are[[:space:][:punct:]]*)?final\M)'
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
