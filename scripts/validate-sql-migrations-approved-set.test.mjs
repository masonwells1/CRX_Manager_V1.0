#!/usr/bin/env node
/**
 * Mutation tests for the APPROVED-SET BINDING block in
 * scripts/validate-sql-migrations.sh.
 *
 * A guard nobody has tried to break is decoration. Every case below is a real
 * bypass someone could write; the test asserts the guard actually stops it.
 * Written after an adversarial review found the first cut of this guard
 * fail-open in three separate ways (see the 2026-08-10 DECISION_LOG entry).
 *
 * Each fixture is a synthetic migration written into a scratch directory, run
 * through the real script, and classified by what the script printed for it.
 */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'validate-sql-migrations.sh');
const HEX = 'a'.repeat(64);
const OTHER_HEX = 'b'.repeat(64);

/**
 * A digest block that is genuinely fail-closed: computed, compared, aborts.
 *
 * sha256 via encode(digest(...), 'hex'), not md5 — the declared digest is 64
 * hex characters, and an md5 fixture would compare a 32-character value to it
 * and could never match. The fixture has to be a migration someone could
 * actually ship, or it tests the guard against a shape that does not exist.
 *
 * The hashed material is `id || ':' || total_profit` — the row identity AND the
 * before-value of the column being rewritten. Identity alone is not an approved
 * set: a population with the same ids but different money would still pass.
 */
const HASH_EXPR = `encode(digest(string_agg(id::text || ':' || total_profit::text, ',' ORDER BY id), 'sha256'), 'hex')`;
/** A real hash, correctly assigned — but over a constant. Binds nothing. */
const CONST_HASH_EXPR = `encode(digest('approved', 'sha256'), 'hex')`;
/**
 * The constant hash again, this time inside a SELECT that ALSO computes a
 * perfectly good string_agg over the ids and the rewritten column — into a
 * throwaway variable. Every token a statement-wide check looks for is present
 * (table, string_agg, id, total_profit) and not one of them is an input to the
 * hash the guard is comparing. This is the exact bypass the round-7 guard
 * admitted (Codex High, round 8); only reading the hash call's own arguments
 * catches it.
 */
const CONST_HASH_DECOY_SELECT =
  `SELECT ${CONST_HASH_EXPR},\n         string_agg(id::text || ':' || total_profit::text, ',' ORDER BY id)\n` +
  `    INTO actual, junk FROM public.orders`;
/**
 * A digest block that hashes rows chosen by a PREDICATE. Through round 9 this
 * was the accepted shape, and it was a working bypass: hashing
 * `orders WHERE stale` never constrained what the writes selected, so an
 * unrestricted `UPDATE public.orders` satisfied every check (Codex High, round
 * 10, finding 2). Kept as a fixture so the bypass stays proven closed.
 */
const PREDICATE_DIGEST_BLOCK = `DO $$
DECLARE actual text;
BEGIN
  SELECT ${HASH_EXPR} INTO actual FROM public.orders WHERE stale;
  IF actual IS DISTINCT FROM '${HEX}' THEN
    RAISE EXCEPTION 'APPROVED_SET_DRIFTED: expected ${HEX}, got %', actual;
  END IF;
END $$;`;

/**
 * The shape that replaced it. There is no static way to prove two arbitrary SQL
 * predicates select the same rows, so the second predicate is removed instead:
 * one id array, captured once under FOR UPDATE, hashed, and written through.
 *
 * @param {object} [o]
 * @param {boolean} [o.lock=true]   capture under FOR UPDATE
 * @param {boolean} [o.count=true]  assert ROW_COUNT against the captured set
 * @param {string}  [o.writeWhere]  override the write's row selection
 */
function goodSetBlock({ lock = true, count = true, writeWhere = 'WHERE id = ANY(v_ids)' } = {}) {
  return (
    `DO $$\nDECLARE v_ids uuid[]; actual text; n integer;\nBEGIN\n` +
    `  SELECT array_agg(s.id ORDER BY s.id) INTO v_ids\n` +
    `    FROM (SELECT id FROM public.orders WHERE stale ORDER BY id${lock ? ' FOR UPDATE' : ''}) s;\n` +
    `  SELECT ${HASH_EXPR} INTO actual FROM public.orders WHERE id = ANY(v_ids);\n` +
    `  IF actual IS DISTINCT FROM '${HEX}' THEN\n` +
    `    RAISE EXCEPTION 'APPROVED_SET_DRIFTED: %', actual;\n  END IF;\n` +
    `  UPDATE public.orders SET total_profit = 0 ${writeWhere};\n` +
    (count
      ? `  GET DIAGNOSTICS n = ROW_COUNT;\n` +
        `  IF n <> array_length(v_ids, 1) THEN\n` +
        `    RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n  END IF;\n`
      : '') +
    `END $$;`
  );
}

const CASES = [
  // ── must VIOLATE ────────────────────────────────────────────────────────
  {
    name: 'multiline UPDATE with the table on the next line',
    expect: 'violation',
    sql: `DO $$\nBEGIN\n  UPDATE\n    public.orders\n  SET total_profit = 0;\nEND $$;\n`,
  },
  {
    name: 'quoted identifiers: "public"."order_items"',
    expect: 'violation',
    sql: `UPDATE "public"."order_items" SET profit = 0;\n`,
  },
  {
    name: 'UPDATE ONLY',
    expect: 'violation',
    sql: `UPDATE ONLY public.commissions SET commission_amount = 0;\n`,
  },
  {
    name: 'DELETE FROM a business table',
    expect: 'violation',
    sql: `DELETE FROM public.invoice_items WHERE id IS NOT NULL;\n`,
  },
  {
    name: 'digest present only in a comment',
    expect: 'violation',
    sql: `-- APPROVED_SET_DIGEST: ${HEX}\nUPDATE public.orders SET total_profit = 0;\n`,
  },
  {
    name: 'digest compared AFTER the write',
    expect: 'violation',
    sql: `-- APPROVED_SET_DIGEST: ${HEX}\nUPDATE public.orders SET total_profit = 0;\n${PREDICATE_DIGEST_BLOCK}\n`,
  },
  {
    name: 'digest mentioned in executable SQL but never compared',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\nDECLARE v text;\nBEGIN\n  SELECT '${HEX}' INTO v;\nEND $$;\n` +
      `UPDATE public.orders SET total_profit = 0;\n`,
  },
  {
    name: 'digest compared against another literal, nothing computed',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\nBEGIN\n  IF '${HEX}' <> '${OTHER_HEX}' THEN\n` +
      `    RAISE EXCEPTION 'drift';\n  END IF;\n  UPDATE public.orders SET total_profit = 0;\nEND $$;\n`,
  },
  {
    name: 'comparison with no RAISE in its own IF block (unrelated RAISE nearby)',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\nDECLARE actual text;\nBEGIN\n` +
      `  SELECT ${HASH_EXPR} INTO actual FROM public.orders;\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n    RAISE NOTICE 'drifted, carrying on';\n  END IF;\n` +
      `  IF false THEN\n    RAISE EXCEPTION 'unreachable';\n  END IF;\n` +
      `  UPDATE public.orders SET total_profit = 0;\nEND $$;\n`,
  },
  {
    // The inversion, not a near-miss: this aborts when the data is RIGHT and
    // writes when it has drifted. It is the most dangerous shape here because
    // it reads exactly like a guard.
    name: 'equality polarity: IF actual = digest THEN RAISE (writes on drift)',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\nDECLARE actual text;\nBEGIN\n` +
      `  SELECT ${HASH_EXPR} INTO actual FROM public.orders;\n` +
      `  IF actual = '${HEX}' THEN\n    RAISE EXCEPTION 'drift';\n  END IF;\n` +
      `  UPDATE public.orders SET total_profit = 0;\nEND $$;\n`,
  },
  {
    // A real hash is computed — over the right table, even — but into a
    // different variable than the one compared. The compared value is hand-set.
    name: 'hash computed into a different variable than the one compared',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\nDECLARE actual text; other text;\nBEGIN\n` +
      `  SELECT ${HASH_EXPR} INTO other FROM public.orders;\n` +
      `  actual := '${HEX}';\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n    RAISE EXCEPTION 'drift';\n  END IF;\n` +
      `  UPDATE public.orders SET total_profit = 0;\nEND $$;\n`,
  },
  {
    // A block comment mentioning CREATE FUNCTION must not pin the scanner in
    // function-body mode and swallow every rewrite after it.
    name: 'block comment naming CREATE FUNCTION does not hide the rewrite',
    expect: 'violation',
    sql: `/* CREATE FUNCTION public.decoy() is not defined here */\nUPDATE public.orders SET total_profit = 0;\n`,
  },
  {
    name: 'one-line CREATE FUNCTION ... LANGUAGE plpgsql closes before the rewrite',
    expect: 'violation',
    sql:
      `CREATE OR REPLACE FUNCTION public.f_inline() RETURNS void AS $$ BEGIN NULL; END $$ LANGUAGE plpgsql;\n` +
      `UPDATE public.orders SET total_profit = 0;\n`,
  },
  {
    name: 'waiver that does not name the table it waives',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: NOT-REQUIRED (invoices) - column added by this migration\n` +
      `UPDATE public.orders SET total_profit = 0;\n`,
  },
  {
    // Naming the table is not enough. The waiver's only honest use is a column
    // this migration adds; rewriting a pre-existing column is the author
    // waiving their own guard.
    name: 'waiver on a table that gets no ADD COLUMN in this migration',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: NOT-REQUIRED (orders) - reviewed by hand\n` +
      `UPDATE public.orders SET total_profit = 0;\n`,
  },
  {
    // An UPSERT never spells UPDATE first, but DO UPDATE rewrites rows that
    // already exist — the same money mutation wearing a different keyword.
    name: 'INSERT ... ON CONFLICT DO UPDATE rewrites existing rows',
    expect: 'violation',
    sql:
      `INSERT INTO public.orders (id, total_profit) VALUES (1, 0)\n` +
      `ON CONFLICT (id) DO UPDATE SET total_profit = EXCLUDED.total_profit;\n`,
  },
  {
    name: 'MERGE INTO ... WHEN MATCHED THEN UPDATE rewrites existing rows',
    expect: 'violation',
    sql:
      `MERGE INTO public.orders t\nUSING (SELECT 1 AS id) s ON t.id = s.id\n` +
      `WHEN MATCHED THEN UPDATE SET total_profit = 0;\n`,
  },
  {
    // A real hash, correctly assigned to the compared variable — of a constant.
    // It proves the migration can call digest(), and nothing else.
    name: 'hash of a constant, not of the rows being rewritten',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\nDECLARE actual text;\nBEGIN\n` +
      `  SELECT ${CONST_HASH_EXPR} INTO actual;\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n    RAISE EXCEPTION 'drift';\n  END IF;\n` +
      `  UPDATE public.orders SET total_profit = 0;\nEND $$;\n`,
  },
  {
    // Codex round 8. The hash is still of a constant, but the SELECT around it
    // names the table, the ids and the rewritten column, so a check that reads
    // the whole statement finds everything it was looking for. Only reading the
    // hash call's own arguments catches this.
    name: 'constant hash smuggled past a real string_agg computed alongside it',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\nDECLARE actual text; junk text;\nBEGIN\n` +
      `  ${CONST_HASH_DECOY_SELECT};\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n    RAISE EXCEPTION 'drift';\n  END IF;\n` +
      `  UPDATE public.orders SET total_profit = 0;\nEND $$;\n`,
  },
  {
    // The hash argument is a string literal that merely SPELLS the column
    // names. Literals are stripped before the span is inspected precisely so
    // quoted text cannot stand in for hashed data.
    name: 'hash of a literal that spells the column names',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\nDECLARE actual text;\nBEGIN\n` +
      `  SELECT encode(digest('id total_profit string_agg', 'sha256'), 'hex')\n` +
      `    INTO actual FROM public.orders;\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n    RAISE EXCEPTION 'drift';\n  END IF;\n` +
      `  UPDATE public.orders SET total_profit = 0;\nEND $$;\n`,
  },
  {
    // Real columns, hashed — but one row at a time, with no ordered aggregate.
    // A digest of whichever row the planner happened to return authorizes that
    // row, not the population.
    name: 'hash of row values with no string_agg over the population',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\nDECLARE actual text;\nBEGIN\n` +
      `  SELECT encode(digest(id::text || ':' || total_profit::text, 'sha256'), 'hex')\n` +
      `    INTO actual FROM public.orders LIMIT 1;\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n    RAISE EXCEPTION 'drift';\n  END IF;\n` +
      `  UPDATE public.orders SET total_profit = 0;\nEND $$;\n`,
  },
  {
    // Codex's own example: application_services stores customer-facing rates
    // and internal costs in cents, and the hand-written allowlist never named
    // it. Default-deny over the schema registry is what covers it now.
    name: 'application_services is protected by default-deny',
    expect: 'violation',
    sql: `UPDATE public.application_services SET cost_per_acre_cents = 0;\n`,
  },
  {
    name: 'customer_application_rates is protected by default-deny',
    expect: 'violation',
    sql: `UPDATE public.customer_application_rates SET rate_cents = 0;\n`,
  },
  {
    name: 'supplier_price_observations is protected by default-deny',
    expect: 'violation',
    sql: `UPDATE public.supplier_price_observations SET price_cents = 0;\n`,
  },
  {
    name: 'invoice_line_share_snapshots is protected by default-deny',
    expect: 'violation',
    sql: `DELETE FROM public.invoice_line_share_snapshots WHERE id IS NOT NULL;\n`,
  },
  {
    name: 'app_settings is protected by default-deny',
    expect: 'violation',
    sql: `UPDATE public.app_settings SET value = 'x';\n`,
  },
  {
    name: 'hash of an unrelated table',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\nDECLARE actual text;\nBEGIN\n` +
      `  SELECT ${HASH_EXPR} INTO actual FROM public.app_settings;\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n    RAISE EXCEPTION 'drift';\n  END IF;\n` +
      `  UPDATE public.orders SET total_profit = 0;\nEND $$;\n`,
  },
  {
    name: 'hash covers row ids but not the column being rewritten',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\nDECLARE actual text;\nBEGIN\n` +
      `  SELECT encode(digest(string_agg(id::text, ',' ORDER BY id), 'sha256'), 'hex')\n` +
      `    INTO actual FROM public.orders;\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n    RAISE EXCEPTION 'drift';\n  END IF;\n` +
      `  UPDATE public.orders SET total_profit = 0;\nEND $$;\n`,
  },
  {
    // Adds a harmless column, then rides that waiver into a pre-existing money
    // column. Table-level waiver checking cannot see this; column-level can.
    name: 'waiver adds one column but rewrites a pre-existing money column too',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: NOT-REQUIRED (orders) - backfills a column this migration adds\n` +
      `ALTER TABLE public.orders ADD COLUMN note text;\n` +
      `UPDATE public.orders SET note = 'x', total_profit = 0;\n`,
  },
  {
    name: 'waiver on a DELETE, which backfills nothing',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: NOT-REQUIRED (invoice_items) - cleanup\n` +
      `ALTER TABLE public.invoice_items ADD COLUMN note text;\n` +
      `DELETE FROM public.invoice_items WHERE id IS NOT NULL;\n`,
  },
  {
    name: 'inventory is covered, not just the ordering tables',
    expect: 'violation',
    sql: `UPDATE public.inventory SET quantity_on_hand = 0;\n`,
  },
  {
    name: 'vendor_payments is covered',
    expect: 'violation',
    sql: `UPDATE public.vendor_payments SET amount_cents = 0;\n`,
  },

  // ── must WARN (accepted, but never silent) ──────────────────────────────
  {
    name: 'waiver naming every table, backfilling a column this migration adds',
    expect: 'warning',
    sql:
      `-- APPROVED_SET_DIGEST: NOT-REQUIRED (orders) - backfills a column this migration adds\n` +
      `ALTER TABLE public.orders ADD COLUMN total_profit bigint;\n` +
      `UPDATE public.orders SET total_profit = 0;\n`,
  },

  // ── must PASS silently ──────────────────────────────────────────────────
  {
    name: 'correct fail-closed digest: one captured set drives the hash and the write',
    expect: 'silent',
    sql: `-- APPROVED_SET_DIGEST: ${HEX}\n${goodSetBlock()}\n`,
  },
  {
    name: 'rewrite inside a function body is runtime logic, not a data migration',
    expect: 'silent',
    sql:
      `CREATE OR REPLACE FUNCTION public.f_fixture()\nRETURNS void AS $$\nBEGIN\n` +
      `  UPDATE public.orders SET total_profit = 0;\nEND;\n$$ LANGUAGE plpgsql;\n`,
  },
  {
    name: 'the words "update orders" inside a string literal are not a rewrite',
    expect: 'silent',
    sql: `DO $$\nBEGIN\n  RAISE NOTICE 'about to update orders and delete from invoices';\nEND $$;\n`,
  },
  {
    // The only tables outside the default-deny set are the reason-annotated
    // exemptions: append-only logs, retry queues, operational plumbing. Bulk
    // rewrites there are ordinary maintenance, and flagging them would be the
    // noise that gets a guard switched off.
    name: 'an exempt log table (activity_feed) is not in scope',
    expect: 'silent',
    sql: `UPDATE public.activity_feed SET description = 'x';\n`,
  },
  {
    // Round 8 exempted this as "RPC replay bookkeeping" — operational
    // plumbing holding no money. That is true of the rows and false of their
    // purpose: a used idempotency key that no longer exists is a key whose
    // money or inventory RPC executes a second time. Same for
    // offline_action_receipts and the throttling tables (Codex High, round 9).
    name: 'deleting idempotency_keys re-arms replayed money RPCs',
    expect: 'violation',
    // A DELETE assigns no columns, which is exactly the field-shift case.
    mustReport: 'DELETE FROM public.idempotency_keys',
    sql: `DELETE FROM public.idempotency_keys WHERE created_at < now();\n`,
  },
  {
    name: 'deleting offline_action_receipts re-arms replayed offline actions',
    expect: 'violation',
    sql: `DELETE FROM public.offline_action_receipts WHERE created_at < now();\n`,
  },
  {
    name: 'deleting rate_limit_log re-arms throttled abuse',
    expect: 'violation',
    sql: `DELETE FROM public.rate_limit_log WHERE created_at < now();\n`,
  },
  {
    // A table nobody has ever created is not in the registry, so default-deny
    // cannot protect it. Asserted so the failure mode is a documented one:
    // protection follows the registry, and a stale registry is a real gap.
    name: 'a table absent from the schema registry is out of scope',
    expect: 'silent',
    sql: `UPDATE public.not_a_real_crx_table SET x = 0;\n`,
  },
  {
    // A plain INSERT adds rows; it rewrites no approved population. Flagging it
    // would make the guard noise, and noise is how a guard gets switched off.
    name: 'a plain INSERT with no ON CONFLICT DO UPDATE is not a rewrite',
    expect: 'silent',
    sql: `INSERT INTO public.orders (id, total_profit) VALUES (1, 0);\n`,
  },

  // ── round 9: TRUNCATE ───────────────────────────────────────────────────
  // The most total rewrite there is, and it spells neither UPDATE nor DELETE,
  // so round 8 produced no finding for it at all (Codex High, round 9).
  {
    name: 'TRUNCATE of a business table is a rewrite',
    expect: 'violation',
    mustReport: 'TRUNCATE public.orders;',
    sql: `TRUNCATE public.orders;\n`,
  },
  {
    name: 'TRUNCATE TABLE ONLY a, b RESTART IDENTITY CASCADE names both tables',
    expect: 'violation',
    sql: `TRUNCATE TABLE ONLY public.orders, ONLY public.order_items RESTART IDENTITY CASCADE;\n`,
  },
  {
    name: 'TRUNCATE of an exempt log table is not in scope',
    expect: 'silent',
    sql: `TRUNCATE public.activity_feed;\n`,
  },
  {
    // A TRUNCATE assigns no column, so it can never be "backfilling a column
    // this migration adds" — the waiver must not rescue it, exactly as for a
    // DELETE.
    name: 'a NOT-REQUIRED waiver cannot excuse a TRUNCATE',
    expect: 'violation',
    sql: `-- APPROVED_SET_DIGEST: NOT-REQUIRED (orders)\nTRUNCATE public.orders;\n`,
  },

  // ── round 9: top-level dynamic SQL ──────────────────────────────────────
  // String literals are stripped before scanning so prose cannot fabricate a
  // match — which also means a write hidden inside one cannot be read. Refused
  // rather than analyzed (Codex High, round 9).
  {
    name: 'EXECUTE of a literal statement hides the write from every static guard',
    expect: 'violation',
    mustReport: "EXECUTE 'DELETE FROM public.orders';",
    sql: `DO $$\nBEGIN\n  EXECUTE 'DELETE FROM public.orders';\nEND $$;\n`,
  },
  {
    name: 'EXECUTE format(...) is dynamic too',
    expect: 'violation',
    sql: `DO $$\nBEGIN\n  EXECUTE format('UPDATE %I SET total_profit = 0', 'orders');\nEND $$;\n`,
  },
  {
    name: 'EXECUTE of a composed variable is dynamic too',
    expect: 'violation',
    sql: `DO $$\nDECLARE v_sql text := 'UPDATE public.orders SET total_profit = 0';\nBEGIN\n  EXECUTE v_sql;\nEND $$;\n`,
  },
  {
    // GRANT EXECUTE and trigger bodies are the ordinary, non-dynamic uses of
    // the keyword. Flagging them would fire on most migrations in the repo.
    name: 'GRANT EXECUTE ON FUNCTION is not dynamic SQL',
    expect: 'silent',
    sql: `GRANT EXECUTE ON FUNCTION public.f_fixture() TO authenticated;\n`,
  },
  {
    name: 'REVOKE EXECUTE ON FUNCTION is not dynamic SQL',
    expect: 'silent',
    sql: `REVOKE EXECUTE ON FUNCTION public.f_fixture() FROM anon;\n`,
  },
  {
    name: 'CREATE TRIGGER ... EXECUTE FUNCTION is not dynamic SQL',
    expect: 'silent',
    sql:
      `CREATE TRIGGER trg_fixture AFTER INSERT ON public.orders\n` +
      `  FOR EACH ROW EXECUTE FUNCTION public.f_fixture();\n`,
  },

  // ── round 9: digest coverage is per-table and per-column ────────────────
  // Round 8 handed the digest check the UNION of rewritten tables and columns
  // and asked only that ANY ONE of each appear. Hash the cheap table, rewrite
  // the expensive one alongside it, and the guard was satisfied by the first
  // (Codex High, round 9).
  {
    name: 'a digest over one table does not authorize rewriting a second',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\nDECLARE actual text;\nBEGIN\n` +
      `  SELECT ${HASH_EXPR} INTO actual FROM public.orders WHERE stale;\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_DRIFTED: %', actual;\n  END IF;\n` +
      `  UPDATE public.orders SET total_profit = 0;\n` +
      `  UPDATE public.order_items SET total_profit = 0;\nEND $$;\n`,
  },
  {
    name: 'a digest covering one assigned column does not authorize a second',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\nDECLARE actual text;\nBEGIN\n` +
      `  SELECT ${HASH_EXPR} INTO actual FROM public.orders WHERE stale;\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_DRIFTED: %', actual;\n  END IF;\n` +
      `  UPDATE public.orders SET total_profit = 0, subtotal_cents = 0;\nEND $$;\n`,
  },
  {
    // Round 10 accepted this shape: two tables, two captured arrays, two
    // digests, both compared. Codex broke it in round 11 — see the pair of
    // cases below. Coverage accumulates across every hash assigned to the
    // compared variable, but only ONE comparison is verified fail-closed, so
    // the second table's digest was material nothing checked. Rather than
    // guess which comparison governs which digest, a multi-table repair is now
    // refused outright and must be split into one migration per table.
    name: 'round-11: a repair spanning two tables is refused, however well formed',
    expect: 'violation',
    mustReport: 'UPDATE public.order_items SET total_profit = 0 WHERE id = ANY(v_item_ids);',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\n` +
      `DECLARE v_ids uuid[]; v_item_ids uuid[]; actual text; n integer;\nBEGIN\n` +
      `  SELECT array_agg(s.id ORDER BY s.id) INTO v_ids\n` +
      `    FROM (SELECT id FROM public.orders WHERE stale ORDER BY id FOR UPDATE) s;\n` +
      `  SELECT array_agg(s.id ORDER BY s.id) INTO v_item_ids\n` +
      `    FROM (SELECT id FROM public.order_items WHERE stale ORDER BY id FOR UPDATE) s;\n` +
      `  SELECT ${HASH_EXPR} INTO actual FROM public.orders WHERE id = ANY(v_ids);\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_DRIFTED: %', actual;\n  END IF;\n` +
      `  SELECT ${HASH_EXPR} INTO actual FROM public.order_items WHERE id = ANY(v_item_ids);\n` +
      `  IF actual IS DISTINCT FROM '${OTHER_HEX}' THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_DRIFTED: %', actual;\n  END IF;\n` +
      `  UPDATE public.orders SET total_profit = 0 WHERE id = ANY(v_ids);\n` +
      `  GET DIAGNOSTICS n = ROW_COUNT;\n` +
      `  IF n <> array_length(v_ids, 1) THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n  END IF;\n` +
      `  UPDATE public.order_items SET total_profit = 0 WHERE id = ANY(v_item_ids);\n` +
      `  GET DIAGNOSTICS n = ROW_COUNT;\n` +
      `  IF n <> array_length(v_item_ids, 1) THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n  END IF;\nEND $$;\n`,
  },

  {
    // The exact bypass Codex reported in round 11: take the well-formed
    // two-table repair above and delete the SECOND table's comparison. Table,
    // column and captured-set coverage all stay satisfied — by a digest that is
    // now never checked — so order_items could be rewritten after its approved
    // population had drifted, while orders' check still passed.
    name: 'Codex round-11 bypass: two tables, the second comparison deleted',
    expect: 'violation',
    mustReport: 'UPDATE public.order_items SET total_profit = 0 WHERE id = ANY(v_item_ids);',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\n` +
      `DECLARE v_ids uuid[]; v_item_ids uuid[]; actual text; n integer;\nBEGIN\n` +
      `  SELECT array_agg(s.id ORDER BY s.id) INTO v_ids\n` +
      `    FROM (SELECT id FROM public.orders WHERE stale ORDER BY id FOR UPDATE) s;\n` +
      `  SELECT array_agg(s.id ORDER BY s.id) INTO v_item_ids\n` +
      `    FROM (SELECT id FROM public.order_items WHERE stale ORDER BY id FOR UPDATE) s;\n` +
      `  SELECT ${HASH_EXPR} INTO actual FROM public.orders WHERE id = ANY(v_ids);\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_DRIFTED: %', actual;\n  END IF;\n` +
      `  SELECT ${HASH_EXPR} INTO actual FROM public.order_items WHERE id = ANY(v_item_ids);\n` +
      `  UPDATE public.orders SET total_profit = 0 WHERE id = ANY(v_ids);\n` +
      `  GET DIAGNOSTICS n = ROW_COUNT;\n` +
      `  IF n <> array_length(v_ids, 1) THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n  END IF;\n` +
      `  UPDATE public.order_items SET total_profit = 0 WHERE id = ANY(v_item_ids);\n` +
      `  GET DIAGNOSTICS n = ROW_COUNT;\n` +
      `  IF n <> array_length(v_item_ids, 1) THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n  END IF;\nEND $$;\n`,
  },
  {
    // The single-table form of the same accumulation hole: two hashes into one
    // variable, one comparison. The comparison sees whatever ran last, so the
    // other digest is coverage no verified check governs.
    name: 'round-11: two digests computed into the same compared variable',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\n` +
      `DECLARE v_ids uuid[]; actual text; n integer;\nBEGIN\n` +
      `  SELECT array_agg(s.id ORDER BY s.id) INTO v_ids\n` +
      `    FROM (SELECT id FROM public.orders WHERE stale ORDER BY id FOR UPDATE) s;\n` +
      `  SELECT ${HASH_EXPR} INTO actual FROM public.orders WHERE id = ANY(v_ids);\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_DRIFTED: %', actual;\n  END IF;\n` +
      `  SELECT ${HASH_EXPR} INTO actual FROM public.orders WHERE id = ANY(v_ids);\n` +
      `  UPDATE public.orders SET total_profit = 0 WHERE id = ANY(v_ids);\n` +
      `  GET DIAGNOSTICS n = ROW_COUNT;\n` +
      `  IF n <> array_length(v_ids, 1) THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n  END IF;\nEND $$;\n`,
  },

  // ── round 10: the digest must cover the rows actually WRITTEN ────────────
  // Every check above proves the digest is real, fail-closed, and mentions the
  // rewritten tables and columns. None of it proved the hashed rows and the
  // written rows are the same rows — and they were not required to be, which
  // was a working bypass (Codex High, round 10, finding 2).
  {
    name: 'Codex round-10 bypass: hash a predicate, then rewrite the whole table',
    expect: 'violation',
    mustReport: 'UPDATE public.orders SET total_profit = 0;',
    sql: `-- APPROVED_SET_DIGEST: ${HEX}\n${PREDICATE_DIGEST_BLOCK}\nUPDATE public.orders SET total_profit = 0;\n`,
  },
  {
    // The narrower version of the same hole: the write IS restricted, just not
    // to the set that was approved.
    name: 'a write bound to a different array than the digest hashed',
    expect: 'violation',
    sql: `-- APPROVED_SET_DIGEST: ${HEX}\n${goodSetBlock({ writeWhere: 'WHERE id = ANY(v_other)' })}\n`,
  },
  {
    // Without the lock the ids are a snapshot: a concurrent transaction can
    // change an approved row between the digest and the write, and the digest
    // that authorized the write no longer describes it.
    name: 'the captured id set is not locked with FOR UPDATE',
    expect: 'violation',
    sql: `-- APPROVED_SET_DIGEST: ${HEX}\n${goodSetBlock({ lock: false })}\n`,
  },
  {
    // The set bounds the write from above but not from below. Without the
    // count, a write that silently touched FEWER rows than were approved — a
    // trigger, a partial predicate, a row already gone — still reports success.
    name: 'the row count is never asserted against the captured set',
    expect: 'violation',
    sql: `-- APPROVED_SET_DIGEST: ${HEX}\n${goodSetBlock({ count: false })}\n`,
  },
  {
    // An id array that is not read out of the table approves nothing: the
    // digest and the write agree with each other about a set neither of them
    // got from the database.
    name: 'an id set assigned from a literal, never captured from the table',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\n` +
      `DECLARE v_ids uuid[] := ARRAY[]::uuid[]; actual text; n integer;\nBEGIN\n` +
      `  SELECT ${HASH_EXPR} INTO actual FROM public.orders WHERE id = ANY(v_ids);\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_DRIFTED: %', actual;\n  END IF;\n` +
      `  UPDATE public.orders SET total_profit = 0 WHERE id = ANY(v_ids);\n` +
      `  GET DIAGNOSTICS n = ROW_COUNT;\n` +
      `  IF n <> array_length(v_ids, 1) THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n  END IF;\nEND $$;\n`,
  },
];

// A stamp at/after the cutoff, so the guard is in force.
const IN_FORCE = 29990101;
// A stamp before the cutoff: history, never retro-checked.
const PRE_CUTOFF = '20260101000001_pre_cutoff.sql';

/**
 * The reported block for one file, so a case can assert WHAT the guard said and
 * not merely that it said something. This exists because the round-9 TRUNCATE
 * and dynamic-SQL findings printed a blank source line: `read` treats a tab as
 * IFS whitespace, so the empty written-columns field collapsed and shifted
 * every field after it. The verdict was right and the message was useless, and
 * a violation/silent assertion could not tell the difference.
 */
function blockFor(output, fileName) {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('VIOLATION:') && l.includes(fileName));
  if (start < 0) return '';
  const out = [];
  for (let i = start; i < lines.length && lines[i] !== ''; i++) out.push(lines[i]);
  return out.join('\n');
}

function classify(output, fileName) {
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(fileName)) continue;
    if (lines[i].startsWith('VIOLATION:')) return 'violation';
    if (lines[i].startsWith('WARNING:')) return 'warning';
  }
  return 'silent';
}

function run() {
  const dir = mkdtempSync(join(tmpdir(), 'crx-approved-set-'));
  const migrations = join(dir, 'supabase', 'migrations');
  mkdirSync(migrations, { recursive: true });

  const names = [];
  CASES.forEach((c, i) => {
    const name = `${IN_FORCE}${String(i).padStart(6, '0')}_case_${i}.sql`;
    writeFileSync(join(migrations, name), c.sql, 'utf8');
    names.push(name);
  });
  // The same rewrite, stamped before the cutoff, must stay silent: applied
  // history cannot be edited, so retro-checking it would only produce noise.
  writeFileSync(join(migrations, PRE_CUTOFF), `UPDATE public.orders SET total_profit = 0;\n`, 'utf8');

  const res = spawnSync('bash', [SCRIPT, '--max-violations=999'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env },
  });
  const out = `${res.stdout || ''}\n${res.stderr || ''}`;

  const failures = [];
  CASES.forEach((c, i) => {
    const got = classify(out, names[i]);
    if (got !== c.expect) failures.push(`  ${c.name}\n    expected ${c.expect}, got ${got}`);
    if (c.mustReport && got === 'violation') {
      const block = blockFor(out, names[i]);
      if (!block.includes(c.mustReport)) {
        failures.push(
          `  ${c.name}\n    report is missing ${JSON.stringify(c.mustReport)}\n` +
            block.split('\n').map((l) => `      | ${l}`).join('\n'),
        );
      }
    }
  });
  const preGot = classify(out, PRE_CUTOFF);
  if (preGot !== 'silent') {
    failures.push(`  pre-cutoff migration is history\n    expected silent, got ${preGot}`);
  }

  rmSync(dir, { recursive: true, force: true });

  if (failures.length > 0) {
    console.error(`❌ approved-set guard: ${failures.length} case(s) behaved wrong\n`);
    console.error(failures.join('\n'));
    console.error('\n--- validator output ---\n');
    console.error(out);
    process.exit(1);
  }
  console.log(`✅ approved-set guard: ${CASES.length + 1} mutation cases behaved correctly`);
}

run();
