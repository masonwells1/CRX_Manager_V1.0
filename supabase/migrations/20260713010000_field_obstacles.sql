-- ChemMan parity M9: point obstacles pinned to mapped fields.
--
-- Obstacles are company-wide operational map data. Authenticated users can read
-- them; admins and sales reps can create, edit, or delete them. GeoJSON shape is
-- validated more strictly in the client, while the database enforces an object floor.

CREATE TABLE IF NOT EXISTS public.field_obstacles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id      uuid NOT NULL REFERENCES public.fields(id) ON DELETE CASCADE,
  kind          text NOT NULL
    CHECK (kind IN ('oil_well', 'windmill', 'tower', 'tree_line', 'power_line', 'waterway', 'other')),
  label         text,
  point_geojson jsonb NOT NULL CHECK (jsonb_typeof(point_geojson) = 'object'),
  created_by    uuid DEFAULT auth.uid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_field_obstacles_field_id
  ON public.field_obstacles (field_id);

DROP TRIGGER IF EXISTS set_field_obstacles_updated_at ON public.field_obstacles;
CREATE TRIGGER set_field_obstacles_updated_at
  BEFORE UPDATE ON public.field_obstacles
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE public.field_obstacles IS
  'Point obstacles and hazards pinned to fields for office, crew map, and printed-map visibility.';

ALTER TABLE public.field_obstacles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS field_obstacles_select ON public.field_obstacles;
CREATE POLICY field_obstacles_select ON public.field_obstacles
  FOR SELECT TO authenticated
  -- Match the parent fields table's SELECT breadth (fields_select,
  -- 20260214210000): obstacles are meaningless without field read access.
  USING (is_admin() OR is_sales_rep() OR is_applicator());

DROP POLICY IF EXISTS field_obstacles_insert ON public.field_obstacles;
CREATE POLICY field_obstacles_insert ON public.field_obstacles
  FOR INSERT TO authenticated
  WITH CHECK (
    (is_admin() OR is_sales_rep())
    AND created_by = (select auth.uid())
  );

DROP POLICY IF EXISTS field_obstacles_update ON public.field_obstacles;
CREATE POLICY field_obstacles_update ON public.field_obstacles
  FOR UPDATE TO authenticated
  USING (is_admin() OR is_sales_rep())
  WITH CHECK (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS field_obstacles_delete ON public.field_obstacles;
CREATE POLICY field_obstacles_delete ON public.field_obstacles
  FOR DELETE TO authenticated
  USING (is_admin() OR is_sales_rep());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.field_obstacles TO authenticated;
REVOKE ALL ON public.field_obstacles FROM anon;
