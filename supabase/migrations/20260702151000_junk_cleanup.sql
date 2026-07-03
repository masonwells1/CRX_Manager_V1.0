-- ============================================================================
-- APPLIED LIVE 2026-07-02 (Mason authorized; gated MCP apply; rls-security + migration-drift + Codex CLEAN; verified live).
-- Mason applies via the DRAFT/APPLY protocol after review. Actions CONFIRMED by Mason
-- 2026-07-02 after grounding corrected the packet: only the 8 fake recipes are safely
-- deletable; the 3 'test' products are HIDDEN (not deleted); the 'we' PO is NOT touched.
--
-- WHAT: (1) hard-DELETE the 8 fake 'RTJ Recipe …' blend_recipes (0 FK refs — grounding
--           verified blend_recipe_items + jobs both have 0 rows pointing at these ids);
--       (2) HIDE the 3 fully-fake [UI-TEST] products via is_active=false (they are
--           FK-referenced by a whole test order/invoice/delivery/job/PO chain, so a hard
--           DELETE would error on NO-ACTION FKs — Mason chose hide over teardown).
-- NOT DONE HERE (by Mason's decision / grounding):
--       - PO 'we' (PO-2026-0030): a REAL open $7,717 PO with 4 real on-order line items —
--         Mason fixes/voids it in the app. Deleting would cascade-wipe real on-order qty.
--       - "bad emails": grounding found 0 malformed customer emails. Nothing to clean.
-- SCOPE: 8 DELETEs (by exact id) + 1 UPDATE (3 ids). The DELETE is IRREVERSIBLE — the rows
--        are confirmed junk (auto-generated 'RTJ Recipe <rand>' names, 0 references).
--
-- SMOKE (2026-07-02, live tx aborted via RAISE — NOTHING persisted): DELETE matched EXACTLY
--   8 recipes (deleted_recipes=8); UPDATE hid EXACTLY 3 [UI-TEST] products (hidden_products=3).
-- CODEX: <PENDING — /codex-review this session>
-- ============================================================================

-- (1) Delete the 8 fake RTJ blend recipes (exact ids from live grounding).
DELETE FROM public.blend_recipes
WHERE id IN (
  'de5d47b7-71c8-4bf2-9f84-aecd9909b8c5',
  '12df1483-84f6-4678-8eec-d23294ec366a',
  '81166cce-53ed-4594-8cae-97a46ab65dab',
  '10619fa0-2fe6-46e2-907a-aeaecbfe7e72',
  '1f9c7d28-d14f-4546-8ef4-7602ba97eed8',
  '5245c21e-fcf7-40e3-9d5c-f46adaf50134',
  '039820f8-5223-4d3b-b504-43c5b46f00d5',
  '65dbfece-a3ab-42a3-9d99-fc547e4d4e78'
)
AND name LIKE 'RTJ Recipe%';   -- belt-and-suspenders: only ever these junk rows

-- (2) Hide the 3 fully-fake [UI-TEST] products (cannot delete — referenced by a test chain).
UPDATE public.products
SET is_active = false
WHERE id IN (
  'b0000000-0000-0000-0000-000000000001',
  'b0000000-0000-0000-0000-000000000002',
  'b0000000-0000-0000-0000-000000000003'
)
AND product_name LIKE '[UI-TEST]%';
