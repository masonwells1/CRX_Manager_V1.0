#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = path.join(root, 'scripts', 'smoke', 'smoke-supplier-cost-basis-phase2-live.sql');
const sql = readFileSync(file, 'utf8');

function requireToken(token) {
  if (!sql.includes(token)) throw new Error(`live Phase 2 smoke is missing: ${token}`);
}

for (const token of [
  'BEGIN;',
  'SET LOCAL ROLE authenticated;',
  'RESET ROLE;',
  'gen_random_uuid()',
  'public.preview_product_cost_basis_changes(',
  'public.apply_product_cost_basis_change_set(',
  'public.create_pricing_workbook_export(',
  "'public.product_cost_basis', 'INSERT'",
  "'public.product_cost_basis', 'UPDATE'",
  "'public.product_cost_basis', 'DELETE'",
  'unauthenticated preview expected AUTH_REQUIRED',
  'non-admin preview expected ADMIN_REQUIRED',
  'forged preview expected ACTOR_MISMATCH',
  'unauthenticated apply expected AUTH_REQUIRED',
  'non-admin apply expected ADMIN_REQUIRED',
  'forged apply expected ACTOR_MISMATCH',
  "e.value->'rows'->0",
  "RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK supplier_cost_basis_phase2_live'",
]) requireToken(token);

for (const forbidden of [
  '\\set',
  'pg_read_file(',
  'eeeeeeee-eeee-',
  'ffffffff-ffff-',
  'aaaaaaaa-aaaa-',
  'SMOKE_FAIL: base and Wells fixture costs were not baselined exactly once',
]) {
  if (sql.includes(forbidden)) throw new Error(`live Phase 2 smoke retained forbidden fixture dependency: ${forbidden}`);
}

if (sql.includes('COMMIT;')) throw new Error('live Phase 2 smoke must never commit');
if (sql.indexOf('BEGIN;') > sql.lastIndexOf('SMOKE_PASS_ROLLBACK')) {
  throw new Error('live Phase 2 smoke pass token must remain inside its transaction');
}

console.log('PASS: live Phase 2 smoke is self-contained and rollback-only.');
