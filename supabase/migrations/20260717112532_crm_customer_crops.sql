-- CRM relationship-intelligence follow-up: crops assigned per customer.
-- Additive only. No RLS change: the existing customers_update policy already
-- governs who may edit a customer row, and crop edits ride that same policy.

ALTER TABLE public.customers
  ADD COLUMN crops text[] NOT NULL DEFAULT '{}';

-- Controlled list only. Array-uniqueness is intentionally NOT enforced
-- (kept simple); the constraint bounds allowed values AND array shape.
-- The dimension check closes the containment loophole where a
-- multidimensional array (e.g. '{{corn}}') passes <@; array_ndims('{}') is
-- NULL, so the empty default is allowed via the explicit equality branch.
ALTER TABLE public.customers
  ADD CONSTRAINT customers_crops_allowed_check
  CHECK (
    crops <@ ARRAY['corn','soybeans','wheat','milo','cotton','alfalfa','pasture_hay','other']::text[]
    AND (crops = '{}' OR array_ndims(crops) = 1)
  );

COMMENT ON COLUMN public.customers.crops IS
  'Crops this customer grows, from a controlled list (owner decision 2026-07-17). Allowed values are enforced by customers_crops_allowed_check; the customer edit UI is the editor. Duplicates are permitted (array-uniqueness intentionally not enforced).';
