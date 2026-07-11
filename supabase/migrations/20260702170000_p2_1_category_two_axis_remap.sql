-- ============================================================================
-- PARKED DRAFT — NOT APPLIED. Structure Wave-2 · P2-1 category two-axis remap.
-- Mason applies via the DRAFT/APPLY protocol with a per-migration OK. DATA migration
-- (re-buckets live product categories) — review the before/after below before applying.
--
-- OWNER (Mason 2026-07-02/03): adopt the two-axis model — `category` = functional class,
--   new `use_timing` = optional application-timing tag. 6 empty-category products classified;
--   2 ambiguous buckets defaulted (flagged below — flip before apply if wrong).
--
-- WHAT:
--   (1) ADD COLUMN products.use_timing text (nullable). No CHECK (products.category has none
--       either; keep both free-text — backfill BEFORE any future enforcement, per the mission).
--   (2) Pull TIMING out of the herbicide categories into use_timing so `category` = 'Herbicide':
--         Post Emergence(91) -> Herbicide / Post-Emergence
--         Pre-Emerge Soybean(84) -> Herbicide / Pre-Emerge Soybean
--         Pre-Emerge Corn(57) -> Herbicide / Pre-Emerge Corn
--         Volunteer Corn(7) -> Herbicide / Volunteer Corn
--         Range Pasture Turf(25) -> Herbicide / Range/Pasture/Turf
--   (3) Consolidate the two foliar buckets -> 'Foliar Fertilizer' / Foliar:
--         Foliar Nutrition(36) + "Foliar Nutrition & Liquid Fertilizer"(16, ambiguous DEFAULT).
--   (4) 'Utility'(2, ambiguous DEFAULT) -> 'Other'.
--   (5) The 6 empty-category products (by id+name), per Mason: Imazuron/Treaty -> Herbicide;
--       Palisade EC -> Other; Piksi Dust Plus -> Foliar Fertilizer/Foliar; Water W/D-Chlorinator
--       -> Other; "1A TEST PRODUCT - FAKE PRODUCT" -> HIDE (is_active=false) + Other.
--   (6) NORMALIZATION TRIGGER trg_normalize_product_category (BEFORE INSERT OR UPDATE OF category):
--       any FUTURE write that uses an old timing/utility category is auto-mapped to the functional
--       category + use_timing. Prevents ProductDetail / BulkProductImport / any RPC from re-drifting
--       the taxonomy after the backfill (Codex P2). Covers bulk import too — no BulkProductImport
--       code change needed. Created AFTER the backfill so it only guards future writes.
--   Categories LEFT UNCHANGED (already clean functional classes; no report churn): Herbicide,
--   Fungicide, Insecticide, Liquid Fertilizer, Adjuvant, Seed Treatment, Dry Water Soluble
--   Fertilizer, Biological, Nitrogen Stabilizer, Other. (Renames like Adjuvant->Adjuvant/Surfactant
--   and Dry Water Soluble->Dry Fertilizer were DROPPED to minimize live sales-report re-bucketing.)
--
-- ** AMBIGUOUS DEFAULTS to confirm before apply: "Foliar Nutrition & Liquid Fertilizer"(16) ->
--    Foliar Fertilizer;  "Utility"(2) -> Other.  Flip either UPDATE below if you want otherwise. **
--
-- IMPACT: products.category is read (GROUP BY / display, no hardcoded old literals) by 6 report
--   RPCs — get_customer_year_end_summary, get_dashboard_action_items, get_inventory_cost_report,
--   get_sales_detail_report, get_sales_summary_report, global_search. Re-bucketing shifts how
--   historical sales group (e.g. "Post Emergence" sales now appear under "Herbicide"). This is the
--   intended consolidation; no report FILTERS on the old strings, so none break. No CHECK/enum, no FK.
--
-- SMOKE (2026-07-03, live BEGIN;...ROLLBACK; — NOTHING persisted, verified column_leaked=false &
--   'Post Emergence' still 91 after): no_old_cats=PASS (0 old timing/utility categories remain);
--   herbicide=272 (91+84+57+7+25+6 + Imazuron+Treaty); foliar_fert=53 (36+16+Piksi); use_timing_set=317;
--   empty_left=0 (all 6 blanks classified); fake is_active=false; use_timing values =
--   [Foliar, Post-Emergence, Pre-Emerge Corn, Pre-Emerge Soybean, Range/Pasture/Turf, Volunteer Corn].
--   RE-SMOKE with the trigger: backfill=PASS; trigger_normalizes=PASS (a later UPDATE to
--   'Post Emergence' auto-became Herbicide/Post-Emergence); plpgsql_check_errors=0; nothing persisted
--   (column/trigger/fn all absent live after).
--   R2 RE-SMOKE (direct-assign): overwrite_stale_tag=PASS (Herbicide/Post-Emergence re-typed to
--   'Pre-Emerge Corn' -> Herbicide/Pre-Emerge Corn), fresh_norm=PASS, plpgsql_check_errors=0.
-- CODEX (6 rounds — the trigger's use_timing handling was the crux):
--   R1: write paths could re-introduce old categories -> added the normalization trigger (6).
--   R2: legacy-alias re-type left a stale tag -> direct-assign each alias's canonical timing.
--   R3/R4: cross-category re-edits leave a stale/invalid tag -> I added a "clear invalid tag" invariant.
--   R5: (a) trigger fired only on category -> widened the column list; (b) no app write path -> added
--        the ProductDetail "Use Timing" combobox + BulkProductImport use_timing column mapping.
--   R6: showed the R3/R4 invariant DISCARDS legitimate free-text timings ('Burndown', 'In-Furrow', ...)
--        — silent data-loss on a column documented as free-text.
--   RESOLUTION: R3/R4 (clear stale) vs R6 (don't discard) are in genuine tension for a free-text column;
--   preserving operator input is the safer call. The trigger now ONLY normalizes the deprecated category
--   aliases (+ direct-assigns each alias's canonical timing) and does NOT police free-text use_timing.
--   Accepted trade-off: a rare cross-category re-edit can leave a cosmetically-stale tag, operator-fixable
--   via the Use-Timing field. So the trigger fires on UPDATE OF category only (its sole job).
--   FINAL SMOKE: backfill=PASS, legacy_norm=PASS, free_text_preserved=PASS ('Burndown' survives),
--   plpgsql_check_errors=0; nothing persisted.
--   ** APPLY-ORDER: apply this migration (adds products.use_timing) BEFORE deploying the coupled
--   ProductDetail/BulkProductImport frontend — they write use_timing; same branch, merge = deploy. **
-- ============================================================================

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS use_timing text;

-- (2) timing-herbicides -> Herbicide + use_timing
UPDATE public.products SET category = 'Herbicide', use_timing = 'Post-Emergence'     WHERE category = 'Post Emergence';
UPDATE public.products SET category = 'Herbicide', use_timing = 'Pre-Emerge Soybean' WHERE category = 'Pre-Emerge Soybean';
UPDATE public.products SET category = 'Herbicide', use_timing = 'Pre-Emerge Corn'    WHERE category = 'Pre-Emerge Corn';
UPDATE public.products SET category = 'Herbicide', use_timing = 'Volunteer Corn'      WHERE category = 'Volunteer Corn';
UPDATE public.products SET category = 'Herbicide', use_timing = 'Range/Pasture/Turf'  WHERE category = 'Range Pasture Turf';

-- (3) foliar consolidation (incl. the ambiguous "& Liquid Fertilizer" bucket -> Foliar Fertilizer)
UPDATE public.products SET category = 'Foliar Fertilizer', use_timing = 'Foliar'
  WHERE category IN ('Foliar Nutrition', 'Foliar Nutrition & Liquid Fertilizer');

-- (4) Utility -> Other (ambiguous DEFAULT)
UPDATE public.products SET category = 'Other' WHERE category = 'Utility';

-- (5) the 6 empty-category products (by UUID; classifications guarded on STILL-uncategorized so a
--     later hand-classification is never overwritten; the fake is hidden by id+name regardless).
UPDATE public.products SET category = 'Herbicide'                            -- Imazuron Herbicide
  WHERE id = '0294faa8-ab0b-488e-9efe-868071738625' AND (category IS NULL OR btrim(category) = '');
UPDATE public.products SET category = 'Herbicide'                            -- Treaty Extra
  WHERE id = 'ac926057-cfae-4070-9cb6-ff2ecc421c3c' AND (category IS NULL OR btrim(category) = '');
UPDATE public.products SET category = 'Other'                                -- Palisade EC (PGR)
  WHERE id = '1a3c082a-1603-4eff-a4db-316af555ff87' AND (category IS NULL OR btrim(category) = '');
UPDATE public.products SET category = 'Foliar Fertilizer', use_timing = 'Foliar'  -- Piksi Dust Plus
  WHERE id = '9a1716a2-8ac3-42e6-887b-64795fca3a57' AND (category IS NULL OR btrim(category) = '');
UPDATE public.products SET category = 'Other'                                -- Water W/ D-Chlorinator
  WHERE id = '4983d7c2-45cc-4acd-b915-45e92184c563' AND (category IS NULL OR btrim(category) = '');
UPDATE public.products SET category = 'Other', is_active = false             -- fake test product -> HIDE
  WHERE id = '8b9c7b32-3257-4609-9a01-59e9413cd983' AND product_name = '1A TEST PRODUCT - FAKE PRODUCT';

-- (6) Normalization trigger — created AFTER the backfill so it only guards FUTURE writes.
-- Any write (UI / bulk import / RPC / direct) that sets an old timing/utility category is
-- auto-mapped to the functional class + use_timing, so the two-axis cleanup can't drift back.
CREATE OR REPLACE FUNCTION public.normalize_product_category()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- Keep the DEPRECATED timing-category aliases from re-entering products.category. Each legacy
  -- category NAME encodes a specific application timing, so on normalization the alias's canonical
  -- timing is authoritative (direct-assign — Codex R2). use_timing is otherwise FREE-TEXT operator
  -- data (no CHECK): the trigger does NOT police or clear typed values, so a legitimate free-text
  -- timing ('Burndown', 'In-Furrow', ...) is never silently discarded (Codex R6). Trade-off: a rare
  -- cross-category re-edit can leave a cosmetically-stale tag (e.g. Foliar Fertilizer keeping a
  -- herbicide timing); that is operator-fixable via the ProductDetail Use-Timing field — preferable
  -- to silently deleting typed input. (Codex R3/R4 flagged clearing; R6 flagged the resulting
  -- data-loss — the two are in tension, and preserving operator free-text is the safer call.)
  IF NEW.category = 'Post Emergence' THEN
    NEW.category := 'Herbicide'; NEW.use_timing := 'Post-Emergence';
  ELSIF NEW.category = 'Pre-Emerge Soybean' THEN
    NEW.category := 'Herbicide'; NEW.use_timing := 'Pre-Emerge Soybean';
  ELSIF NEW.category = 'Pre-Emerge Corn' THEN
    NEW.category := 'Herbicide'; NEW.use_timing := 'Pre-Emerge Corn';
  ELSIF NEW.category = 'Volunteer Corn' THEN
    NEW.category := 'Herbicide'; NEW.use_timing := 'Volunteer Corn';
  ELSIF NEW.category = 'Range Pasture Turf' THEN
    NEW.category := 'Herbicide'; NEW.use_timing := 'Range/Pasture/Turf';
  ELSIF NEW.category IN ('Foliar Nutrition', 'Foliar Nutrition & Liquid Fertilizer') THEN
    NEW.category := 'Foliar Fertilizer'; NEW.use_timing := 'Foliar';
  ELSIF NEW.category = 'Utility' THEN
    NEW.category := 'Other';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_normalize_product_category ON public.products;
CREATE TRIGGER trg_normalize_product_category
  BEFORE INSERT OR UPDATE OF category ON public.products              -- fires on category writes; its
  FOR EACH ROW EXECUTE FUNCTION public.normalize_product_category();  -- only job is normalizing deprecated category aliases
