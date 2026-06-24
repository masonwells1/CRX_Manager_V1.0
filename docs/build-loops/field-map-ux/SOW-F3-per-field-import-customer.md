# SOW-F3 - Per-Field Customer Assignment on Shapefile Import

## Goal
When importing a `.zip` shapefile of field boundaries, let the user assign a **customer per field**
(a real county / co-op export often covers many growers), with an **"apply to all"** shortcut that
keeps today's fast single-customer path. Today the importer forces every imported field onto one
selected customer.

## Why it matters
A multi-grower file currently has to be imported once per customer (or imported wrong and fixed up
field-by-field). Per-field assignment makes a mixed file a single, correct import.

## Risk
**Frontend-only. No migration.** Confirmed at scoping: `BulkFieldImport.tsx` already saves fields
**one at a time** via `supabase.rpc('save_field', { ... customer_id: pf.customer_id ... })` - so the
save path already accepts a per-field `customer_id`. The change is a UI step that populates each
parsed field's `customer_id` individually; the existing per-field save loop and `set_field_boundary`
/ `set_field_override_acres` calls are untouched.

## Files (read these first; confirm current shape)
- `src/components/fields/BulkFieldImport.tsx` - the import wizard; the parsed-fields list, the single
  `selectedCustomerId`, and the per-field save loop (calls `save_field` with `pf.customer_id`).
- `src/components/fields/AttributeMappingStep.tsx` - the column-mapping step (a model for a new step's
  look/feel).
- `src/components/fields/ImportPreviewMap.tsx` - the preview map (optional: color/label by customer).
- Verify the `save_field` RPC signature still takes `p_customer_id` (it does today) - read it, do NOT
  assume.

## Approach (concrete)
1. **Add a customer-assignment step (or a column in the Review step).** A compact table: one row per
   parsed field (name + acreage), each with a customer dropdown (the same customer picker the wizard
   already uses). Default every field to the single selected customer.
2. **"Apply to all" shortcut.** A control that sets every field's customer to one pick - this is the
   current fast path, so a single-grower file stays one click.
3. **Populate `pf.customer_id` per field** from the assignment, then run the EXISTING save loop
   unchanged. Do not change `save_field` or any RPC.
4. **Validation.** Block import until every field has a customer (`save_field` requires one). Surface
   missing-customer fields clearly (reuse the wizard's existing invalid-field styling).
5. **Optional polish (only if cheap):** color/label the preview-map polygons by assigned customer.

## Acceptance ("done" given the auth wall)
- A component test (extend `BulkFieldImport.test.tsx` if present, else add one) proves: the assignment
  step lists each parsed field; "apply to all" sets every field's customer; the per-field save loop is
  called with the per-field `customer_id`; import is blocked when a field has no customer.
- `npm run lint` + `typecheck` + `build` clean; targeted tests green.
- Single-customer fast path still works in one action (no regression).
- Mason's in-app click-test with a real multi-grower `.zip` is the final proof.

## Gates
Standard cycle. Frontend-only -> ship live when green.

## Owner gate
None expected. If `save_field` turns out NOT to accept a per-field `customer_id` (it does today),
STOP and PARK - that would make this a DB change.
