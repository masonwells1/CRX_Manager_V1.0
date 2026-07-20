\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

SELECT set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
SET ROLE authenticated;

SELECT public.create_pricing_workbook_export(
  ARRAY[
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'::uuid,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'::uuid
  ],
  '11111111-1111-4111-8111-111111111111'::uuid,
  'phase1a-xlsx-real-export'
)::text;
