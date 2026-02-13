-- Phase 4A: Saved Blend Recipes / Programs
-- Allows users to save frequently-used chemical blend recipes
-- and apply them with one click during blend ticket creation.

-- ============================================================
-- 1. Tables
-- ============================================================

CREATE TABLE IF NOT EXISTS blend_recipes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text,
  recipe_type text NOT NULL DEFAULT 'generic'
    CHECK (recipe_type IN ('crop_specific', 'generic')),
  crop_type   text,          -- corn, soybeans, wheat, other
  timing      text,          -- pre-emerge, post-emerge, early-season, late-season, burndown
  created_by  uuid NOT NULL REFERENCES auth.users(id) DEFAULT auth.uid(),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE TABLE IF NOT EXISTS blend_recipe_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id   uuid NOT NULL REFERENCES blend_recipes(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id),
  product_name text NOT NULL DEFAULT '',
  quantity    numeric(10,2) NOT NULL DEFAULT 0,
  unit        text NOT NULL DEFAULT 'gal',
  rate_per_acre numeric(10,4),
  sort_order  integer NOT NULL DEFAULT 0,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_blend_recipes_created_by ON blend_recipes(created_by);
CREATE INDEX IF NOT EXISTS idx_blend_recipes_recipe_type ON blend_recipes(recipe_type);
CREATE INDEX IF NOT EXISTS idx_blend_recipes_crop_type ON blend_recipes(crop_type);
CREATE INDEX IF NOT EXISTS idx_blend_recipes_is_active ON blend_recipes(is_active);
CREATE INDEX IF NOT EXISTS idx_blend_recipe_items_recipe ON blend_recipe_items(recipe_id);
CREATE INDEX IF NOT EXISTS idx_blend_recipe_items_product ON blend_recipe_items(product_id);

-- Updated_at trigger
CREATE TRIGGER set_blend_recipes_updated_at
  BEFORE UPDATE ON blend_recipes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ============================================================
-- 2. RLS Policies
-- ============================================================

ALTER TABLE blend_recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE blend_recipe_items ENABLE ROW LEVEL SECURITY;

-- blend_recipes: all authenticated can read active, admin/owner can write
DROP POLICY IF EXISTS blend_recipes_select ON blend_recipes;
CREATE POLICY blend_recipes_select ON blend_recipes
  FOR SELECT USING (true);

DROP POLICY IF EXISTS blend_recipes_insert ON blend_recipes;
CREATE POLICY blend_recipes_insert ON blend_recipes
  FOR INSERT WITH CHECK (
    is_admin() OR created_by = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS blend_recipes_update ON blend_recipes;
CREATE POLICY blend_recipes_update ON blend_recipes
  FOR UPDATE USING (
    is_admin() OR created_by = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS blend_recipes_delete ON blend_recipes;
CREATE POLICY blend_recipes_delete ON blend_recipes
  FOR DELETE USING (is_admin());

-- blend_recipe_items: follows parent recipe access
DROP POLICY IF EXISTS blend_recipe_items_select ON blend_recipe_items;
CREATE POLICY blend_recipe_items_select ON blend_recipe_items
  FOR SELECT USING (true);

DROP POLICY IF EXISTS blend_recipe_items_insert ON blend_recipe_items;
CREATE POLICY blend_recipe_items_insert ON blend_recipe_items
  FOR INSERT WITH CHECK (
    is_admin()
    OR EXISTS (
      SELECT 1 FROM blend_recipes br
      WHERE br.id = blend_recipe_items.recipe_id
        AND br.created_by = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS blend_recipe_items_update ON blend_recipe_items;
CREATE POLICY blend_recipe_items_update ON blend_recipe_items
  FOR UPDATE USING (
    is_admin()
    OR EXISTS (
      SELECT 1 FROM blend_recipes br
      WHERE br.id = blend_recipe_items.recipe_id
        AND br.created_by = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS blend_recipe_items_delete ON blend_recipe_items;
CREATE POLICY blend_recipe_items_delete ON blend_recipe_items
  FOR DELETE USING (
    is_admin()
    OR EXISTS (
      SELECT 1 FROM blend_recipes br
      WHERE br.id = blend_recipe_items.recipe_id
        AND br.created_by = (SELECT auth.uid())
    )
  );
