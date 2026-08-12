#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildMaintainedSource } from "./apply-live-testdata-maintenance-20260812.mjs";

const { output, blob } = buildMaintainedSource();
assert.equal(blob, "d15d0c77077e50648ce785c306a8832d34a097a9", "pinned generated blob");

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
    "DO $$ BEGIN IF false THEN RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END IF; UPDATE customers SET phone='owned' WHERE id=1; END $$;",
    "DO $$ BEGIN UPDATE customers SET phone='owned' WHERE id=1; BEGIN RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; EXCEPTION WHEN OTHERS THEN NULL; END; END $$;",
    "DO $$ BEGIN RETURN; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;",
    "UPDATE customers SET phone='owned' WHERE id=1 AND '[E2E]'='[E2E]'",
    "DELETE FROM customers WHERE id=1 AND '[E2E]'='[E2E]'",
    "VALUES (public.cancel_order('00000000-0000-0000-0000-000000000000'))",
    "WITH source AS (SELECT 1 AS x) SELECT x INTO public.guard_bypass FROM source",
    "INSERT INTO customers (name) VALUES ('[E2E] Farm Alpha')",
    "UPDATE customers SET phone = '555' WHERE name LIKE '[E2E]%'",
    "DELETE FROM customers WHERE name ILIKE '[E2E]%'",
    "DELETE FROM customers WHERE NOT (name ILIKE '[E2E]%')",
    "INSERT INTO customers (name, notes) VALUES ('Real Customer', '[E2E] marker')",
    "WITH seed AS (INSERT INTO customers (name) VALUES ('[E2E] probe') RETURNING id) DELETE FROM customers WHERE id IS NOT NULL",
    "SELECT E'foo\\''; DROP TABLE public.customers",
    "SELECT E'foo\\''; TRUNCATE public.customers",
    "SELECT E'foo\\''; GRANT ALL ON public.customers TO anon",
    "SELECT E'foo\\''; INSERT INTO customers (name) VALUES ('owned')",
    "SELECT E'foo\\''; UPDATE customers SET phone='owned' WHERE id=1",
    "SELECT E'foo\\''; DELETE FROM customers WHERE id=1",
    "EXPLAIN ANALYZE SELECT public.cancel_order('00000000-0000-0000-0000-000000000000')",
    "CREATE TEMP TABLE scratch AS SELECT public.cancel_order('00000000-0000-0000-0000-000000000000')",
    "INSERT INTO pg_temp.scratch SELECT public.cancel_order('00000000-0000-0000-0000-000000000000')",
    "DO $$ BEGIN PERFORM nextval('invoice_number_seq'); RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;",
    "DO $$ BEGIN PERFORM setval('invoice_number_seq', 1); RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;",
    "BEGIN; DO $$ BEGIN PERFORM nextval('invoice_number_seq'); RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$; ROLLBACK;",
    "BEGIN; DO $$ BEGIN PERFORM setval('invoice_number_seq', 1); RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$; ROLLBACK;",
    "SELECT 1 -- comment\r; UPDATE customers SET phone='owned' WHERE id=1",
    "SELECT 1 -- comment\r; DELETE FROM customers WHERE id=1",
    "SELECT 1 -- comment\r; DROP TABLE public.customers",
    "SELECT 1 -- comment\r; GRANT ALL ON public.customers TO anon",
    "SELECT 1 -- comment\r; SELECT public.cancel_order('00000000-0000-0000-0000-000000000000')",
    "WITH a AS (SELECT E'foo\\'$x$'), b AS (DELETE FROM customers RETURNING id), c AS (SELECT '$x$') SELECT 1;",
    "BEGIN; ALTER TABLE public.customers DISABLE ROW LEVEL SECURITY; END; BEGIN; ROLLBACK;",
    "BEGIN; ROLLBACK; ALTER TABLE public.customers DISABLE ROW LEVEL SECURITY; BEGIN; ROLLBACK;",
    "SELECT 1 AS open$x$; ALTER TABLE public.customers DISABLE ROW LEVEL SECURITY; SELECT 1 AS close$x$;",
    "SELECT 1 AS open$x$; TRUNCATE public.customers; SELECT 1 AS close$x$;",
    "SELECT 1 /* x */ -- comment\r; ALTER TABLE public.customers DISABLE ROW LEVEL SECURITY;",
    "SELECT 1 /* x */ -- comment\r; DELETE FROM customers WHERE id=1;",
    "BEGIN; CREATE FUNCTION pg_temp.get_pwn() RETURNS bigint LANGUAGE sql AS $$ SELECT setval('invoice_number_seq', 1) $$; SELECT pg_temp.get_pwn(); ROLLBACK;",
    "SELECT 1 AS é$x$; DELETE FROM public.customers WHERE id = 1; SELECT 1 AS é$x$;",
    "CREATE TEMP VIEW customer_passthrough AS SELECT * FROM public.customers; UPDATE pg_temp.customer_passthrough SET phone = 'owned' WHERE id = 1;",
    "CREATE TEMP TABLE customer_passthrough AS SELECT 1; DROP TABLE pg_temp.customer_passthrough; CREATE TEMP VIEW customer_passthrough AS SELECT * FROM public.customers; UPDATE pg_temp.customer_passthrough SET phone = 'owned' WHERE id = 1;",
    "UPDATE pg_temp.some_log_table SET x = 1 WHERE id = 1",
    "BEGIN; COPY public.customers TO PROGRAM 'example-command'; ROLLBACK;",
    "BEGIN; COPY public.customers TO '/tmp/customer-export.csv'; ROLLBACK;",
    "BEGIN; VACUUM public.customers; ROLLBACK;",
  ];
  for (const sql of blocked) {
    assert.equal(classifySql(sql).block, true, `must block: ${sql}`);
  }

  const allowed = [
    "SELECT * FROM customers WHERE id = 1",
    "CREATE TEMP TABLE some_log_table AS SELECT 1 AS id, 0 AS x; UPDATE pg_temp.some_log_table SET x = 1 WHERE id = 1",
    "CREATE TEMP TABLE scratch AS SELECT 1",
    "BEGIN; ALTER TABLE invoices ADD COLUMN x text; ROLLBACK;",
    "BEGIN; SET LOCAL statement_timeout = '1s'; SELECT 1; ROLLBACK;",
  ];
  for (const sql of allowed) {
    const result = classifySql(sql);
    assert.equal(result.block, false, `must allow: ${sql}; got ${JSON.stringify(result)}`);
  }

  process.stdout.write(`live-testdata maintenance candidate: ${blocked.length + allowed.length} assertions passed\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
