#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildMaintainedSource } from "./apply-live-testdata-maintenance-20260812.mjs";

const { output, blob } = buildMaintainedSource();
assert.equal(blob, "9e566b17ccd1ce11e31ea17e8e268a31fd7b134a", "pinned generated blob");

const scratch = mkdtempSync(path.join(tmpdir(), "crx-live-guard-candidate-test-"));
try {
  const candidatePath = path.join(scratch, "candidate.mjs");
  writeFileSync(candidatePath, output, "utf8");
  const { classifySql } = await import(pathToFileURL(candidatePath).href);

  const blocked = [
    "ALTER TABLE public.profiles ADD COLUMN x text; -- RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'",
    "UPDATE customers SET phone = '555' WHERE id = 1 -- [E2E]",
    "SELECT '[E2E]'; UPDATE customers SET phone = '555' WHERE id = 1",
    "UPDATE customers SET notes = '[E2E] fixture' WHERE id = 1",
    "UPDATE customers SET phone = '555' WHERE name LIKE '[E2E]%' OR id = 1",
    "UPDATE profiles SET role = 'admin' WHERE id = '00000000-0000-0000-0000-000000000000'",
    "INSERT INTO some_log_table (x) VALUES (1)",
    "MERGE INTO invoices i USING source_rows s ON i.id=s.id WHEN MATCHED THEN UPDATE SET total_cents=1",
    "SELECT * INTO public.guard_bypass FROM public.profiles",
    "COMMENT ON TABLE public.profiles IS 'raw change'",
    "SELECT preview_product_cost_basis_changes('00000000-0000-0000-0000-000000000000')",
    "DO $$ BEGIN UPDATE customers SET phone='owned' WHERE id=1; COMMIT; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;",
    "DO $$ BEGIN UPDATE customers SET phone='owned' WHERE id=1; ROLLBACK; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;",
  ];
  for (const sql of blocked) {
    assert.equal(classifySql(sql).block, true, `must block: ${sql}`);
  }

  const allowed = [
    "SELECT * FROM customers WHERE id = 1",
    "INSERT INTO customers (name) VALUES ('[E2E] Farm Alpha')",
    "UPDATE customers SET phone = '555' WHERE name LIKE '[E2E]%'",
    "DELETE FROM customers WHERE name ILIKE '[E2E]%'",
    "UPDATE pg_temp.some_log_table SET x = 1 WHERE id = 1",
    "CREATE TEMP TABLE scratch AS SELECT 1",
    "BEGIN; ALTER TABLE invoices ADD COLUMN x text; ROLLBACK;",
    "DO $$ BEGIN PERFORM 1; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;",
  ];
  for (const sql of allowed) {
    assert.equal(classifySql(sql).block, false, `must allow: ${sql}`);
  }

  process.stdout.write(`live-testdata maintenance candidate: ${blocked.length + allowed.length} assertions passed\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
