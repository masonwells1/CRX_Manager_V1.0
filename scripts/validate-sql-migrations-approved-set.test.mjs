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
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
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
/**
 * The canonical full before-state (Codex High, round 20).
 *
 * HASH_EXPR above covers the row identity and the column being rewritten, and
 * for nineteen rounds that was the accepted shape. It is a bypass: an order can
 * change hands (`customer_id`, `salesman_id`), advance its lifecycle
 * (`status`, `pricing_status`), be re-parented to a different quote, or be soft
 * deleted, all without moving `total_profit` — so a digest taken at approval
 * still matched, and a stale authorization rewrote authoritative money on a row
 * nobody had approved in its current state.
 *
 * `to_jsonb(o.*)` hashes every column the row has, which is a provable superset
 * of any list the validator could enumerate. It is also the shape a real author
 * will reach for: `orders` has nine material columns, and hand-listing nine
 * columns is how one gets quietly dropped.
 */
const WHOLE_ROW_HASH_EXPR =
  `encode(digest(string_agg(o.id::text || ':' || to_jsonb(o.*)::text, ',' ORDER BY o.id), 'sha256'), 'hex')`;
/**
 * The same binding written out by hand, for the author who prefers it: every
 * material column `orders` carries, per .claude/schema-registry.json.
 */
const ENUMERATED_HASH_EXPR =
  `encode(digest(string_agg(id::text || ':' || quote_id::text || ':' || customer_id::text` +
  ` || ':' || status::text || ':' || total_price::text || ':' || total_cost::text` +
  ` || ':' || total_profit::text || ':' || salesman_id::text` +
  ` || ':' || coalesce(deleted_at::text, '') || ':' || pricing_status::text` +
  // Round 21 added lifecycle booleans to the material set, and `orders.is_planned`
  // is one: a planned order flipped to real between the digest and the write is
  // a different row in every way that matters. Enumerating by hand means
  // keeping up with the registry — which is why the whole-row projection above
  // is the shape the guard actually recommends.
  ` || ':' || is_planned::text, ',' ORDER BY id), 'sha256'), 'hex')`;
/**
 * The enumeration with one lifecycle flag dropped (Codex High, round 21).
 *
 * Through round 20 `is_planned` was not counted as material, so this shape was
 * accepted: an order could be flipped from planned to real between the approval
 * and the apply and the digest still matched. An on/off flag is state, and a
 * row whose state moved is not the row that was approved.
 */
const ENUMERATED_MINUS_FLAG_EXPR = ENUMERATED_HASH_EXPR.replace(
  ` || ':' || is_planned::text`,
  '',
);
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
 * @param {'whole'|'enumerated'|'assigned'} [o.bind='whole']
 *   which before-state the digest covers. `assigned` is the round-19 shape —
 *   ids plus the rewritten column only — and is now a real bypass, not a
 *   synthetic one.
 */
function goodSetBlock({
  lock = true,
  count = true,
  writeWhere = 'WHERE id = ANY(v_ids)',
  bind = 'whole',
} = {}) {
  const digest =
    bind === 'whole'
      ? `  SELECT ${WHOLE_ROW_HASH_EXPR} INTO actual FROM public.orders o WHERE o.id = ANY(v_ids);\n`
      : bind === 'enumerated'
        ? `  SELECT ${ENUMERATED_HASH_EXPR} INTO actual FROM public.orders WHERE id = ANY(v_ids);\n`
        : `  SELECT ${HASH_EXPR} INTO actual FROM public.orders WHERE id = ANY(v_ids);\n`;
  return (
    `DO $$\nDECLARE v_ids uuid[]; actual text; n integer;\nBEGIN\n` +
    `  SELECT array_agg(s.id ORDER BY s.id) INTO v_ids\n` +
    `    FROM (SELECT id FROM public.orders WHERE stale ORDER BY id${lock ? ' FOR UPDATE' : ''}) s;\n` +
    digest +
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

/**
 * The same shape for a DELETE (Codex High, round 15).
 *
 * A DELETE assigns no columns, so through round 14 the coverage check had
 * nothing to require beyond row ids — and a row id is the one thing that does
 * NOT change when the row does. A commission approved for deletion while it was
 * pending could be paid out in the interval and the id-only digest would still
 * match. The guard now substitutes the target table's lifecycle and financial
 * columns from the schema registry, so `material: false` below is a real bypass
 * someone could write, not a synthetic one.
 *
 * @param {object} [o]
 * @param {boolean} [o.material=true] hash the before-values, not just the ids
 * @param {string}  [o.table='commissions'] table to delete from
 */
function goodDeleteSetBlock({ material = true, table = 'commissions' } = {}) {
  // Round 15 enumerated four columns here. Round 20 widened `commissions`'
  // material set to ten — the parent identifiers Codex named (order_id,
  // invoice_id, job_id) and the payee (customer_id, recipient,
  // recipient_user_id) alongside the money and lifecycle it already had — so
  // the enumeration is replaced by the whole-row projection that covers all of
  // them and cannot fall behind the registry.
  const before = ` || ':' || to_jsonb(d.*)::text`;
  const alias = material ? ' d' : '';
  return (
    `DO $$\nDECLARE v_ids uuid[]; actual text; n integer;\nBEGIN\n` +
    `  SELECT array_agg(s.id ORDER BY s.id) INTO v_ids\n` +
    `    FROM (SELECT id FROM public.${table} WHERE stale ORDER BY id FOR UPDATE) s;\n` +
    `  SELECT encode(digest(string_agg(id::text${material ? before : ''}, ',' ORDER BY id), 'sha256'), 'hex')\n` +
    `    INTO actual FROM public.${table}${alias} WHERE id = ANY(v_ids);\n` +
    `  IF actual IS DISTINCT FROM '${HEX}' THEN\n` +
    `    RAISE EXCEPTION 'APPROVED_SET_DRIFTED: %', actual;\n  END IF;\n` +
    `  DELETE FROM public.${table} WHERE id = ANY(v_ids);\n` +
    `  GET DIAGNOSTICS n = ROW_COUNT;\n` +
    `  IF n <> array_length(v_ids, 1) THEN\n` +
    `    RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n  END IF;\n` +
    `END $$;`
  );
}

/**
 * ROUND 22 (Codex High). Every proof scanner reads the migration line by line
 * and strips only `--` comments, so it cannot tell code from a string shaped
 * like code. PostgreSQL's dollar quoting makes that a working bypass: the decoy
 * needs no escaping and reads exactly like the real guard. The digest scan stops
 * at the FIRST occurrence of the hex, finds a canonical mismatch test on that
 * line, and passes — while the statement that actually runs is a bare UPDATE
 * bound to nothing.
 */
// Two deliberate spellings here. The decoy is a plain assignment, not
// `PERFORM <tag>...`, because the write scanner reads the RAW file and would
// take that for a function call and refuse the migration down a different path.
// And the inner literal is anonymously tagged (`$$`), not named: a NAMED tag is
// one token, and any name that some other fixture happens to define as a
// mutating function would again refuse this down that other path. Either slip
// leaves the case passing even with the blanking removed.
const DQ_DECOY_BLOCK =
  `DO $outer$\nDECLARE v_ids uuid[]; actual text; n integer; note text;\nBEGIN\n` +
  `  note := $$\n` +
  `  SELECT array_agg(s.id ORDER BY s.id) INTO v_ids\n` +
  `    FROM (SELECT id FROM public.orders WHERE stale ORDER BY id FOR UPDATE) s;\n` +
  `  SELECT ${WHOLE_ROW_HASH_EXPR} INTO actual FROM public.orders o WHERE o.id = ANY(v_ids);\n` +
  `  IF actual IS DISTINCT FROM '${HEX}' THEN\n` +
  `    RAISE EXCEPTION 'APPROVED_SET_DRIFTED: %', actual;\n  END IF;\n` +
  `  GET DIAGNOSTICS n = ROW_COUNT;\n` +
  `  IF n <> array_length(v_ids, 1) THEN\n` +
  `    RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n  END IF;\n` +
  `  $$;\n` +
  `  UPDATE public.orders SET total_profit = 0;\n` +
  `END $outer$;`;

/** The same text parked in a function body that is defined and never called. */
const DQ_FUNCTION_DECOY =
  `CREATE FUNCTION public.pretend_guard() RETURNS void AS $body$\nBEGIN\n` +
  `  IF current_setting('x') IS DISTINCT FROM '${HEX}' THEN\n` +
  `    RAISE EXCEPTION 'APPROVED_SET_DRIFTED';\n  END IF;\nEND\n` +
  `$body$ LANGUAGE plpgsql;`;

const CASES = [
  // ── must VIOLATE ────────────────────────────────────────────────────────
  {
    name: 'multiline UPDATE with the table on the next line',
    expect: 'violation',
    sql: `DO $$\nBEGIN\n  UPDATE\n    public.orders\n  SET total_profit = 0;\nEND $$;\n`,
  },
  {
    // Comments and literals are not three independent removals. The scanner
    // used to delete block comments first, so a `/*` living inside a `--`
    // comment opened a block nothing ever closed and every following line was
    // blanked — the money scanner went blind for the rest of the file.
    name: 'a block-comment opener inside a line comment does not blind the scanner',
    expect: 'violation',
    sql: `-- see /* the ledger note\nUPDATE public.orders SET total_profit = 0;\n`,
  },
  {
    // Same fail-open through the other channel: `/*` inside a string literal
    // is data, not a comment opener.
    name: 'a block-comment opener inside a string literal does not blind the scanner',
    expect: 'violation',
    sql:
      `INSERT INTO public.activity_log (description) VALUES ('/*');\n` +
      `UPDATE public.orders SET total_profit = 0;\n`,
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
    // ---- Codex round-15 bypass: ids stay constant, state does not ---------
    // Everything the round-14 guard asked of a DELETE is here: one table, a
    // real sha256, compared for mismatch before the write, over the set the
    // write itself uses, with the row count asserted. The only thing missing
    // is the rows' before-values — and without them the digest says nothing
    // about whether these commissions are still the pending ones that were
    // approved, or have since been paid.
    name: 'DELETE whose digest covers row ids but no material before-values',
    expect: 'violation',
    mustReport: 'order_profit',
    sql: `-- APPROVED_SET_DIGEST: ${HEX}\n${goodDeleteSetBlock({ material: false })}\n`,
  },
  {
    // The other half of the round-15 fix. product_families is a protected
    // business table with no lifecycle, financial, ownership or parent column
    // in the registry, so there is no before-value for a digest to bind and the
    // id-only check would be all that is left. Refused rather than passed on
    // ids alone — the author can still waive it, loudly and by name.
    //
    // This fixture used idempotency_keys until round 20 widened "material" to
    // include reference columns; `request_actor_id` now binds that table. It
    // then used product_families until round 21 widened it again to lifecycle
    // booleans, and `is_active` binds that one. Both moves were predicted here,
    // and the instruction is unchanged: when a widening reaches this table,
    // move the case to whatever table is genuinely unbindable — do not delete
    // it. The refusal is the only thing standing between an id-only DELETE and
    // a silent pass.
    name: 'DELETE from a table with no material before-values is refused outright',
    expect: 'violation',
    mustReport: 'no lifecycle or financial column',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\n` +
      `${goodDeleteSetBlock({ material: false, table: 'unit_conversions' })}\n`,
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
    // The DELETE the round-15 rule is meant to admit: the same fixture as the
    // bypass above, with the table's lifecycle and financial before-values
    // hashed alongside the ids. If any of them moves between approval and
    // apply, the digest stops matching and the migration aborts.
    name: 'correct fail-closed DELETE: the digest covers the rows AND their material state',
    expect: 'silent',
    sql: `-- APPROVED_SET_DIGEST: ${HEX}\n${goodDeleteSetBlock()}\n`,
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
    // Through round 20 this case asserted the opposite — that a name the
    // registry has never heard of was out of scope — and documented the stale
    // registry as a known gap. Codex round 21 showed it was not a gap but the
    // bypass: create an automatically updatable view over order_items, write
    // through the view, and the protected rows change while the scan reads an
    // unregistered name and asks for no digest. An unresolvable write target is
    // now refused rather than ignored, so the assertion is inverted.
    name: 'a write to a relation absent from the schema registry is refused',
    expect: 'violation',
    mustReport: 'not_a_real_crx_table',
    sql: `UPDATE public.not_a_real_crx_table SET x = 0;\n`,
  },
  {
    // The bypass itself, spelled out. The view is created right here, which is
    // exactly why creating it is no excuse.
    name: 'writing through a view created in the same migration is refused',
    expect: 'violation',
    mustReport: 'which is a view',
    sql:
      `CREATE VIEW public.oi_shim AS SELECT * FROM public.order_items;\n` +
      `UPDATE public.oi_shim SET profit = 0;\n`,
  },
  {
    // Defining a view is not a write, so on its own it says nothing. This case
    // exists to put the name into the repo-wide view index that the next case
    // depends on.
    name: 'defining a view is not itself a rewrite',
    expect: 'silent',
    sql: `CREATE OR REPLACE VIEW public.legacy_orders_v AS SELECT * FROM public.orders;\n`,
  },
  {
    // And a view defined by ANOTHER migration is refused too — otherwise the
    // bypass just splits across two files, which is why the view index is built
    // over every migration rather than only the file being scanned.
    name: 'writing through a view defined by another migration is refused',
    expect: 'violation',
    mustReport: 'which is a view',
    sql: `UPDATE public.legacy_orders_v SET total_profit = 0;\n`,
  },
  {
    // ROUND 22 (Codex High). The round-21 view refusal above matches on a bare
    // name, and through round 21 ANY name still carrying a dot was returned
    // unexamined — the reasoning being that `auth.` and `storage.` are not
    // business tables. But the caller has already stripped `public.`, so the
    // schema qualifier was itself the bypass: put the shim view in a schema the
    // migration invents, and the write lands on protected rows while the scan
    // sees a dotted name it decided not to look at.
    name: 'writing through a view in a schema this migration invents is refused',
    expect: 'violation',
    mustReport: 'repair.orders_v',
    sql:
      `CREATE SCHEMA repair;\n` +
      `CREATE VIEW repair.orders_v AS SELECT * FROM public.orders;\n` +
      `UPDATE repair.orders_v SET total_profit = 0;\n`,
  },
  {
    // The same hole without the view — an invented schema is refused for being
    // unaccounted-for, whatever the relation behind the name turns out to be.
    name: 'writing a table in an unrecognized schema is refused',
    expect: 'violation',
    mustReport: 'shadow.orders',
    sql: `UPDATE shadow.orders SET total_profit = 0;\n`,
  },
  {
    // And the other direction, so the fix is an allowlist rather than a blanket
    // refusal: the fixed set of Supabase/PostgreSQL infrastructure schemas is
    // still out of scope. Measured across every migration in this repo, the only
    // schemas a write actually names are public, storage, and auth.
    name: 'writing a Supabase infrastructure schema is still out of scope',
    expect: 'silent',
    sql:
      `UPDATE storage.objects SET updated_at = now();\n` +
      `UPDATE auth.users SET raw_app_meta_data = '{}'::jsonb;\n`,
  },
  {
    // ROUND 22 (Codex High), the dollar-quoted decoy. Every element of a
    // canonical approved-set repair is present in the file — the locked
    // capture, the whole-row hash, the mismatch test, the row-count assertion —
    // and none of it executes. The scanners saw proof because they read text.
    name: 'a digest comparison inside a dollar-quoted literal is not proof',
    expect: 'violation',
    mustReport: 'documented, never compared',
    sql: `-- APPROVED_SET_DIGEST: ${HEX}\n${DQ_DECOY_BLOCK}\n`,
  },
  {
    // The same claim made from a function body. Defining a guard is not running
    // one, and this migration never calls it.
    name: 'a digest comparison inside a function body that is never called is not proof',
    expect: 'violation',
    mustReport: 'documented, never compared',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\n${DQ_FUNCTION_DECOY}\n` +
      `UPDATE public.orders SET total_profit = 0;\n`,
  },
  {
    // And the surgical half: blanking inert text must not cost a real repair its
    // proof. This is the canonical passing shape with an ordinary dollar-quoted
    // NOTICE sitting in front of the guard — the literal goes, the guard stays.
    name: 'a dollar-quoted literal alongside a real guard does not blank the guard',
    expect: 'silent',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\n` +
      `${goodSetBlock().replace('BEGIN\n', 'BEGIN\n  RAISE NOTICE $msg$ starting the repair $msg$;\n')}\n`,
  },
  {
    // A scratch table the migration creates for itself holds no business rows,
    // so binding it would be theatre. This is the line between fail-closed and
    // unusable.
    name: 'writing a scratch table this migration creates is not a rewrite',
    expect: 'silent',
    sql:
      `CREATE TEMP TABLE ids_to_fix (id uuid);\n` +
      `UPDATE ids_to_fix SET id = gen_random_uuid();\n`,
  },
  {
    // `FOR UPDATE` is a lock strength, `GRANT ... UPDATE ON` is a privilege and
    // `BEFORE INSERT OR UPDATE ON` is a trigger event. None of them names a
    // write target, and reading the next token as one would turn every foreign
    // key and trigger in the repo into a violation.
    name: 'FOR UPDATE, GRANT UPDATE and trigger events are not write targets',
    expect: 'silent',
    sql:
      `GRANT SELECT, UPDATE ON public.orders TO authenticated;\n` +
      `CREATE TRIGGER t BEFORE INSERT OR UPDATE ON public.orders\n` +
      `  FOR EACH ROW EXECUTE FUNCTION public.noop();\n` +
      `DO $$\nDECLARE r record;\nBEGIN\n` +
      `  SELECT * INTO r FROM public.orders WHERE stale FOR UPDATE SKIP LOCKED;\n` +
      `END $$;\n`,
  },
  {
    // Another schema is another concern. auth.users and storage.objects are not
    // public business tables, and refusing them would make the guard noise.
    name: 'a write into a non-public schema is out of scope',
    expect: 'silent',
    sql: `UPDATE auth.users SET raw_app_meta_data = '{}'::jsonb;\n`,
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
      `  SELECT ${WHOLE_ROW_HASH_EXPR} INTO actual FROM public.orders o WHERE o.id = ANY(v_ids);\n` +
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
      `  SELECT ${WHOLE_ROW_HASH_EXPR} INTO actual FROM public.orders o WHERE o.id = ANY(v_ids);\n` +
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
      `  SELECT ${WHOLE_ROW_HASH_EXPR} INTO actual FROM public.orders o WHERE o.id = ANY(v_ids);\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_DRIFTED: %', actual;\n  END IF;\n` +
      `  SELECT ${WHOLE_ROW_HASH_EXPR} INTO actual FROM public.orders o WHERE o.id = ANY(v_ids);\n` +
      `  UPDATE public.orders SET total_profit = 0 WHERE id = ANY(v_ids);\n` +
      `  GET DIAGNOSTICS n = ROW_COUNT;\n` +
      `  IF n <> array_length(v_ids, 1) THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n  END IF;\nEND $$;\n`,
  },

  // ── round 12: the dataflow between digest and write must be immutable ────
  // Round 11 proved the digest is checked and covers the write's table and
  // columns. It still only proved that SOME earlier statement captured the id
  // array and that SOME nested statement raised — neither of which survives a
  // determined author. Both holes below passed every earlier round.
  {
    // Codex round 12, finding 3a. The approved digest is computed and compared
    // over the captured set — and then the set is captured AGAIN, unfiltered,
    // and THAT is what the write and the row-count assertion use. Every check
    // through round 11 passed: real digest, fail-closed comparison, matching
    // table and column, write bound to `id = ANY(v_ids)`, count asserted
    // against `array_length(v_ids, 1)` — of the second capture, consistently.
    // The whole table is rewritten while the guard reports it bound.
    name: 'Codex round-12 bypass: the captured set is re-assigned after the digest is checked',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\n` +
      `DECLARE v_ids uuid[]; actual text; n integer;\nBEGIN\n` +
      `  SELECT array_agg(s.id ORDER BY s.id) INTO v_ids\n` +
      `    FROM (SELECT id FROM public.orders WHERE stale ORDER BY id FOR UPDATE) s;\n` +
      `  SELECT ${WHOLE_ROW_HASH_EXPR} INTO actual FROM public.orders o WHERE o.id = ANY(v_ids);\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_DRIFTED: %', actual;\n  END IF;\n` +
      `  SELECT array_agg(s.id ORDER BY s.id) INTO v_ids\n` +
      `    FROM (SELECT id FROM public.orders ORDER BY id FOR UPDATE) s;\n` +
      `  UPDATE public.orders SET total_profit = 0 WHERE id = ANY(v_ids);\n` +
      `  GET DIAGNOSTICS n = ROW_COUNT;\n` +
      `  IF n <> array_length(v_ids, 1) THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n  END IF;\nEND $$;\n`,
  },
  {
    // The `:=` spelling of the same trick. A guard that only recognised
    // `INTO v_ids` would have accepted this one unchanged.
    name: 'round-12: the same re-assignment written with := instead of INTO',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\n` +
      `DECLARE v_ids uuid[]; actual text; n integer;\nBEGIN\n` +
      `  SELECT array_agg(s.id ORDER BY s.id) INTO v_ids\n` +
      `    FROM (SELECT id FROM public.orders WHERE stale ORDER BY id FOR UPDATE) s;\n` +
      `  SELECT ${WHOLE_ROW_HASH_EXPR} INTO actual FROM public.orders o WHERE o.id = ANY(v_ids);\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_DRIFTED: %', actual;\n  END IF;\n` +
      `  v_ids := ARRAY(SELECT id FROM public.orders ORDER BY id);\n` +
      `  UPDATE public.orders SET total_profit = 0 WHERE id = ANY(v_ids);\n` +
      `  GET DIAGNOSTICS n = ROW_COUNT;\n` +
      `  IF n <> array_length(v_ids, 1) THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n  END IF;\nEND $$;\n`,
  },
  {
    // Codex round 12, finding 3b. The mismatch branch contains a RAISE
    // EXCEPTION — nested one level deeper, under a condition that is never
    // true. Through round 11 the check asked only whether a raise appeared
    // anywhere inside the branch, so a drifted population passed silently and
    // the rewrite went ahead. The raise must be in the comparison's OWN body.
    name: 'Codex round-12 bypass: the mismatch raise is real but unreachable',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\n` +
      `DECLARE v_ids uuid[]; actual text; n integer;\nBEGIN\n` +
      `  SELECT array_agg(s.id ORDER BY s.id) INTO v_ids\n` +
      `    FROM (SELECT id FROM public.orders WHERE stale ORDER BY id FOR UPDATE) s;\n` +
      `  SELECT ${WHOLE_ROW_HASH_EXPR} INTO actual FROM public.orders o WHERE o.id = ANY(v_ids);\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n` +
      `    IF false THEN\n` +
      `      RAISE EXCEPTION 'APPROVED_SET_DRIFTED: %', actual;\n    END IF;\n  END IF;\n` +
      `  UPDATE public.orders SET total_profit = 0 WHERE id = ANY(v_ids);\n` +
      `  GET DIAGNOSTICS n = ROW_COUNT;\n` +
      `  IF n <> array_length(v_ids, 1) THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n  END IF;\nEND $$;\n`,
  },
  {
    // Same shape one level down in the row-count assertion: the count check is
    // the backstop that catches a write touching more rows than were approved,
    // so burying ITS raise is the same bypass with a different target.
    name: 'round-12: the row-count assertion raises only inside a nested branch',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\n` +
      `DECLARE v_ids uuid[]; actual text; n integer;\nBEGIN\n` +
      `  SELECT array_agg(s.id ORDER BY s.id) INTO v_ids\n` +
      `    FROM (SELECT id FROM public.orders WHERE stale ORDER BY id FOR UPDATE) s;\n` +
      `  SELECT ${WHOLE_ROW_HASH_EXPR} INTO actual FROM public.orders o WHERE o.id = ANY(v_ids);\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_DRIFTED: %', actual;\n  END IF;\n` +
      `  UPDATE public.orders SET total_profit = 0 WHERE id = ANY(v_ids);\n` +
      `  GET DIAGNOSTICS n = ROW_COUNT;\n` +
      `  IF n <> array_length(v_ids, 1) THEN\n` +
      `    IF false THEN\n` +
      `      RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n    END IF;\n  END IF;\nEND $$;\n`,
  },

  // ── round 13: the predicate and the two assertions, read literally ──────
  // Round 12 read each of these three shapes loosely enough that a bypass
  // could wear the right words in the wrong arrangement.
  {
    // The array only had to be MENTIONED in the row selection, not to BE it.
    name: 'Codex round-13 bypass: the write predicate is widened with OR TRUE',
    expect: 'violation',
    sql: `-- APPROVED_SET_DIGEST: ${HEX}\n${goodSetBlock({ writeWhere: 'WHERE id = ANY(v_ids) OR TRUE' })}\n`,
  },
  {
    // Same hole, no boolean operator at all: concatenate a second array into
    // the one that was approved and the write covers both populations.
    name: 'round-13: the approved array is concatenated with another array',
    expect: 'violation',
    sql: `-- APPROVED_SET_DIGEST: ${HEX}\n${goodSetBlock({ writeWhere: 'WHERE id = ANY(v_ids || v_extra)' })}\n`,
  },
  {
    // The row-count guard running backwards: it aborts when the write hit
    // exactly the approved rows and succeeds when it hit some other number.
    name: 'Codex round-13 bypass: the row-count assertion is inverted to =',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\n` +
      `DECLARE v_ids uuid[]; actual text; n integer;\nBEGIN\n` +
      `  SELECT array_agg(s.id ORDER BY s.id) INTO v_ids\n` +
      `    FROM (SELECT id FROM public.orders WHERE stale ORDER BY id FOR UPDATE) s;\n` +
      `  SELECT ${WHOLE_ROW_HASH_EXPR} INTO actual FROM public.orders o WHERE o.id = ANY(v_ids);\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_DRIFTED: %', actual;\n  END IF;\n` +
      `  UPDATE public.orders SET total_profit = 0 WHERE id = ANY(v_ids);\n` +
      `  GET DIAGNOSTICS n = ROW_COUNT;\n` +
      `  IF n = array_length(v_ids, 1) THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n  END IF;\nEND $$;\n`,
  },
  {
    // Milder form of the same thing: one direction of drift goes unasserted.
    name: 'round-13: the row count is compared with < instead of a mismatch',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\n` +
      `DECLARE v_ids uuid[]; actual text; n integer;\nBEGIN\n` +
      `  SELECT array_agg(s.id ORDER BY s.id) INTO v_ids\n` +
      `    FROM (SELECT id FROM public.orders WHERE stale ORDER BY id FOR UPDATE) s;\n` +
      `  SELECT ${WHOLE_ROW_HASH_EXPR} INTO actual FROM public.orders o WHERE o.id = ANY(v_ids);\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_DRIFTED: %', actual;\n  END IF;\n` +
      `  UPDATE public.orders SET total_profit = 0 WHERE id = ANY(v_ids);\n` +
      `  GET DIAGNOSTICS n = ROW_COUNT;\n` +
      `  IF n < array_length(v_ids, 1) THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n  END IF;\nEND $$;\n`,
  },
  {
    // Depth alone does not say WHICH arm: the abort sits in the ELSE, so a
    // drifted digest falls straight through to the write.
    name: 'Codex round-13 bypass: the digest aborts in the ELSE arm, not the mismatch arm',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\n` +
      `DECLARE v_ids uuid[]; actual text; n integer;\nBEGIN\n` +
      `  SELECT array_agg(s.id ORDER BY s.id) INTO v_ids\n` +
      `    FROM (SELECT id FROM public.orders WHERE stale ORDER BY id FOR UPDATE) s;\n` +
      `  SELECT ${WHOLE_ROW_HASH_EXPR} INTO actual FROM public.orders o WHERE o.id = ANY(v_ids);\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n` +
      `    NULL;\n` +
      `  ELSE\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_DRIFTED: %', actual;\n  END IF;\n` +
      `  UPDATE public.orders SET total_profit = 0 WHERE id = ANY(v_ids);\n` +
      `  GET DIAGNOSTICS n = ROW_COUNT;\n` +
      `  IF n <> array_length(v_ids, 1) THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n  END IF;\nEND $$;\n`,
  },
  {
    // The row-count assertion with the same misplacement.
    name: 'round-13: the row-count abort sits in the ELSE arm',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\n` +
      `DECLARE v_ids uuid[]; actual text; n integer;\nBEGIN\n` +
      `  SELECT array_agg(s.id ORDER BY s.id) INTO v_ids\n` +
      `    FROM (SELECT id FROM public.orders WHERE stale ORDER BY id FOR UPDATE) s;\n` +
      `  SELECT ${WHOLE_ROW_HASH_EXPR} INTO actual FROM public.orders o WHERE o.id = ANY(v_ids);\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_DRIFTED: %', actual;\n  END IF;\n` +
      `  UPDATE public.orders SET total_profit = 0 WHERE id = ANY(v_ids);\n` +
      `  GET DIAGNOSTICS n = ROW_COUNT;\n` +
      `  IF n <> array_length(v_ids, 1) THEN\n` +
      `    NULL;\n` +
      `  ELSE\n` +
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
    name: 'a digest that omits a lifecycle flag does not bind the row',
    expect: 'violation',
    mustReport: 'is_planned',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\n` +
      `${goodSetBlock({ bind: 'enumerated' }).replace(
        ENUMERATED_HASH_EXPR,
        ENUMERATED_MINUS_FLAG_EXPR,
      )}\n`,
  },
  {
    name: 'the captured id set is not locked with FOR UPDATE',
    expect: 'violation',
    sql: `-- APPROVED_SET_DIGEST: ${HEX}\n${goodSetBlock({ lock: false })}\n`,
  },
  {
    // The lock check used to search the capture statement as raw text, so any
    // occurrence of the words satisfied it. A block comment is the cheapest
    // possible decoy: it reads as documentation, takes no lock at all, and
    // through round 20 it turned the whole guard off (Codex High, round 21).
    name: 'FOR UPDATE inside a block comment is not a row lock',
    expect: 'violation',
    mustReport: 'captured without FOR UPDATE',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\n` +
      `${goodSetBlock({ lock: false }).replace('ORDER BY id)', 'ORDER BY id /* FOR UPDATE */)')}\n`,
  },
  {
    // Same decoy, carried in a string literal instead. Both channels have to
    // be blanked by the same stateful scanner, or closing one just moves the
    // bypass into the other.
    name: 'FOR UPDATE inside a string literal is not a row lock',
    expect: 'violation',
    mustReport: 'captured without FOR UPDATE',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\n` +
      `${goodSetBlock({ lock: false }).replace(
        'WHERE stale ORDER BY id)',
        `WHERE note <> 'FOR UPDATE' AND stale ORDER BY id)`,
      )}\n`,
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
      `  SELECT ${WHOLE_ROW_HASH_EXPR} INTO actual FROM public.orders o WHERE o.id = ANY(v_ids);\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_DRIFTED: %', actual;\n  END IF;\n` +
      `  UPDATE public.orders SET total_profit = 0 WHERE id = ANY(v_ids);\n` +
      `  GET DIAGNOSTICS n = ROW_COUNT;\n` +
      `  IF n <> array_length(v_ids, 1) THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n  END IF;\nEND $$;\n`,
  },

  // ── round 14: a whole physical line is not a scope ───────────────────────
  // The body scanner used to skip the ENTIRE line once it saw CREATE FUNCTION,
  // so anything sharing that line with the definition vanished with it.
  {
    name: 'top-level UPDATE trailing a one-line function definition',
    expect: 'violation',
    mustReport: 'update',
    sql:
      `CREATE FUNCTION public.f() RETURNS void LANGUAGE sql AS $fn$ SELECT 1 $fn$; ` +
      `UPDATE public.orders SET total_profit = 0;\n`,
  },
  {
    name: 'top-level UPDATE leading a one-line function definition',
    expect: 'violation',
    mustReport: 'update',
    sql:
      `UPDATE public.orders SET total_profit = 0; ` +
      `CREATE FUNCTION public.f() RETURNS void LANGUAGE sql AS $fn$ SELECT 1 $fn$;\n`,
  },
  {
    name: 'a one-line function whose BODY writes is still just a definition',
    expect: 'silent',
    sql:
      `CREATE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS ` +
      `$fn$ BEGIN UPDATE public.orders SET total_profit = 0; END $fn$;\n`,
  },

  // ── round 14: a decoy is not an abort ────────────────────────────────────
  {
    name: 'the abort is prose inside a string literal, not a real RAISE',
    expect: 'violation',
    mustReport: 'does not RAISE EXCEPTION inside its own IF block',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\n` +
      `DECLARE v_ids uuid[]; actual text; n integer;\nBEGIN\n` +
      `  SELECT array_agg(s.id ORDER BY s.id) INTO v_ids\n` +
      `    FROM (SELECT id FROM public.orders WHERE stale ORDER BY id FOR UPDATE) s;\n` +
      `  SELECT ${WHOLE_ROW_HASH_EXPR} INTO actual FROM public.orders o WHERE o.id = ANY(v_ids);\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n` +
      `    RAISE NOTICE 'would RAISE EXCEPTION APPROVED_SET_DRIFTED: %', actual;\n  END IF;\n` +
      `  UPDATE public.orders SET total_profit = 0 WHERE id = ANY(v_ids);\n` +
      `  GET DIAGNOSTICS n = ROW_COUNT;\n  IF n <> array_length(v_ids, 1) THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n  END IF;\nEND $$;\n`,
  },
  {
    name: 'the abort is inside a block comment',
    expect: 'violation',
    mustReport: 'does not RAISE EXCEPTION inside its own IF block',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\n` +
      `DECLARE v_ids uuid[]; actual text; n integer;\nBEGIN\n` +
      `  SELECT array_agg(s.id ORDER BY s.id) INTO v_ids\n` +
      `    FROM (SELECT id FROM public.orders WHERE stale ORDER BY id FOR UPDATE) s;\n` +
      `  SELECT ${WHOLE_ROW_HASH_EXPR} INTO actual FROM public.orders o WHERE o.id = ANY(v_ids);\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n` +
      `    /* RAISE EXCEPTION on drift -- TODO */ NULL;\n  END IF;\n` +
      `  UPDATE public.orders SET total_profit = 0 WHERE id = ANY(v_ids);\n` +
      `  GET DIAGNOSTICS n = ROW_COUNT;\n  IF n <> array_length(v_ids, 1) THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n  END IF;\nEND $$;\n`,
  },

  // ── round 14: the count assertion must compare a MEASURED count ──────────
  {
    name: 'the count assertion compares the approved set to itself',
    expect: 'violation',
    mustReport: 'does not compare a measured row count',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\n` +
      goodSetBlock({ count: false }).replace(
        /END \$\$;$/,
        `  GET DIAGNOSTICS n = ROW_COUNT;\n` +
          `  IF cardinality(v_ids) <> cardinality(v_ids) THEN\n` +
          `    RAISE EXCEPTION 'APPROVED_SET_COUNT';\n  END IF;\nEND $$;`,
      ) +
      `\n`,
  },
  {
    name: 'the count is asserted before GET DIAGNOSTICS ever measures it',
    expect: 'violation',
    mustReport: 'does not compare a measured row count',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\n` +
      goodSetBlock({ count: false }).replace(
        /END \$\$;$/,
        `  IF n <> array_length(v_ids, 1) THEN\n` +
          `    RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n  END IF;\n` +
          `  GET DIAGNOSTICS n = ROW_COUNT;\nEND $$;`,
      ) +
      `\n`,
  },
  {
    // The two cases above are both caught twice over: once because neither
    // operand is a measured count, and again because nothing was measured
    // before the test. This one is caught ONLY by the operand check — it does
    // name the real ROW_COUNT variable, and it does name it after the
    // measurement, but it slips a fudge factor in so the test can never fire.
    // Without it, breaking the operand check alone leaves every case green.
    name: 'the count is compared against a doctored row count (n - 1)',
    expect: 'violation',
    mustReport: 'does not compare a measured row count',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\n` +
      goodSetBlock({ count: false }).replace(
        /END \$\$;$/,
        `  GET DIAGNOSTICS n = ROW_COUNT;\n` +
          `  IF cardinality(v_ids) <> n - 1 THEN\n` +
          `    RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n  END IF;\nEND $$;`,
      ) +
      `\n`,
  },

  // ── round 17, SEC-001: a digest binds rows, registration contains replay ──
  // A digest-bound repair is by definition ONE-SHOT: it was approved against
  // one population. The apply-time replay guard and the replay-plan builder
  // both act only on what supabase/baselines/one-shot-migrations.json lists,
  // so an unregistered repair is contained by nothing — a replay onto a
  // restored database hands it straight through to rows that never approved
  // it. `unregistered` keeps this fixture out of the registry the harness
  // writes for every other case.
  {
    name: 'a digest-bound repair that is not registered as one-shot',
    expect: 'violation',
    mustReport: 'not registered as one-shot',
    unregistered: true,
    sql: `-- APPROVED_SET_DIGEST: ${HEX}\n${goodSetBlock()}\n`,
  },

  // ── round 17, SEC-002: a single-quoted function body hides its writes ────
  // Every scanner here strips single-quoted literals before looking for
  // writes, so a body written as a string is invisible three times over: the
  // UPDATE is not seen, the function is not indexed as mutating, and the call
  // below is not refused. Refuse the shape instead of parsing it.
  {
    name: 'a called function whose single-quoted body rewrites a protected table',
    expect: 'violation',
    mustReport: 'single-quoted string',
    sql:
      `CREATE FUNCTION public._fix() RETURNS void LANGUAGE plpgsql AS ` +
      `'BEGIN UPDATE public.orders SET total_profit = 0; END;';\n` +
      `SELECT public._fix();\n`,
  },
  {
    name: 'the single-quoted body opens on the line after AS',
    expect: 'violation',
    mustReport: 'single-quoted string',
    sql:
      `CREATE OR REPLACE FUNCTION public._fix2() RETURNS void\nLANGUAGE plpgsql\nAS\n` +
      `'BEGIN UPDATE public.orders SET total_profit = 0; END;';\n` +
      `SELECT public._fix2();\n`,
  },

  // ── round 18, F1: dynamic SQL hidden one level down ──────────────────────
  // The dollar-quoted body is readable, so the round-17 refusal stands down —
  // but the write inside it is a runtime string. The mutating-function index
  // blanks quoted literals before it looks for DML, so the UPDATE is not there
  // to find and the helper looks read-only; and the top-level scanner removes
  // function bodies before it looks for EXECUTE, so the dynamic SQL is not
  // seen there either. Two blind spots that line up exactly: define the
  // helper, call it, and rewrite a protected table with nothing reporting it.
  {
    name: 'a called function whose dollar-quoted body EXECUTEs a rewrite',
    expect: 'violation',
    mustReport: 'builds SQL at runtime',
    sql:
      `CREATE FUNCTION public._dyn() RETURNS void LANGUAGE plpgsql AS $$\n` +
      `BEGIN\n` +
      `  EXECUTE 'UPDATE public.orders SET total_profit = 0';\n` +
      `END;\n` +
      `$$;\n` +
      `SELECT public._dyn();\n`,
  },

  // ── round 18, F2: a registry key that no guard actually reads ────────────
  // The apply-time one-shot guard and the replay planner both read
  // `registry.one_shot` and nothing else. A key of the same name sitting
  // anywhere else in the file — the `_comment` block, say — satisfies a text
  // search and contains nothing. `decoyRegistered` writes exactly that shape.
  {
    name: 'a digest-bound repair whose registry key sits outside the one_shot map',
    expect: 'violation',
    mustReport: 'does not list this migration in one_shot',
    unregistered: true,
    decoyRegistered: true,
    sql: `-- APPROVED_SET_DIGEST: ${HEX}\n${goodSetBlock()}\n`,
  },

  // ── round 19, F1: a qualified name the tokenizer had split in three ──────
  // `UPDATE public . orders` is legal PostgreSQL. The tokenizer keeps `.` as an
  // ordinary character but splits on whitespace, and every target read took the
  // single token after UPDATE / DELETE FROM / INSERT INTO as the table — so it
  // read `public`, matched no protected table, and reported no rewrite at all.
  // A money rewrite needing neither a digest nor one-shot registration, written
  // with nothing more exotic than a space (Codex High, round 19).
  {
    name: 'space-separated qualification: UPDATE public . orders',
    expect: 'violation',
    sql: `UPDATE public . orders SET total_profit = 0;\n`,
  },
  {
    name: 'the qualification is split across lines',
    expect: 'violation',
    sql: `UPDATE public\n  .\n  orders\n  SET total_profit = 0;\n`,
  },
  {
    name: 'quoted identifiers, split: "public" . "order_items"',
    expect: 'violation',
    sql: `UPDATE "public" . "order_items" SET profit = 0;\n`,
  },
  {
    name: 'DELETE FROM public . commissions',
    expect: 'violation',
    sql: `DELETE FROM public . commissions WHERE id IS NOT NULL;\n`,
  },
  {
    // The same spelling one level down. The helper index flattens a body to a
    // single line before matching, so a split qualification did not match
    // `(public\.)?<table>` there either and the function looked read-only.
    name: 'a called function whose body splits the qualification',
    expect: 'violation',
    sql:
      `CREATE FUNCTION public._split() RETURNS void LANGUAGE plpgsql AS $$\n` +
      `BEGIN\n` +
      `  UPDATE public . orders SET total_profit = 0;\n` +
      `END;\n` +
      `$$;\n` +
      `SELECT public._split();\n`,
  },

  // ── round 19, F2: the proof variable is written twice ────────────────────
  // The digest check proved a hash had been assigned to the compared variable
  // and stopped there. A plain overwrite afterwards was invisible: the digest
  // is genuinely computed, the comparison genuinely reads the variable, and the
  // value it reads is whatever that second statement left there. The comparison
  // then passes however far the population has drifted (Codex High, round 19).
  //
  // The overwrite deliberately does NOT spell the digest out. Writing
  // `actual := '<HEX>'` is caught a step earlier — that line becomes the first
  // executable mention of the digest and fails the mismatch-test check — so it
  // would prove a different rule. Reading a saved value out of a notes table is
  // the same bypass with nothing for the earlier check to catch.
  {
    name: 'the compared digest is overwritten after it is computed',
    expect: 'violation',
    mustReport: 'Assign the compared variable exactly once',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\n` +
      goodSetBlock().replace(
        `  IF actual IS DISTINCT FROM '${HEX}' THEN`,
        `  SELECT saved INTO actual FROM public.repair_notes WHERE key = 'orders';\n` +
          `  IF actual IS DISTINCT FROM '${HEX}' THEN`,
      ) +
      `\n`,
  },
  {
    // The same gap on the row-count side: GET DIAGNOSTICS measures the write,
    // then a second assignment replaces the measurement with the approved
    // count, and the assertion compares that count with itself.
    name: 'the measured row count is overwritten before the assertion',
    expect: 'violation',
    mustReport: 'assigned more than once before the assertion',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\n` +
      goodSetBlock().replace(
        `  IF n <> array_length(v_ids, 1) THEN`,
        `  n := array_length(v_ids, 1);\n  IF n <> array_length(v_ids, 1) THEN`,
      ) +
      `\n`,
  },

  // ── round 19, F3: an abort that can never run ────────────────────────────
  // Both fail-closed checks walked physical lines, giving each line one depth.
  // A line that opened an IF and closed it again therefore changed nothing, so
  // `IF false THEN RAISE EXCEPTION ...; END IF;` written on one line put a
  // RAISE at depth one inside the mismatch branch while the branch fell
  // straight through to the write (Codex High, round 19).
  {
    name: 'the digest mismatch branch aborts only inside an unreachable same-line IF',
    expect: 'violation',
    mustReport: 'does not RAISE EXCEPTION inside its own IF block',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\n` +
      goodSetBlock().replace(
        `    RAISE EXCEPTION 'APPROVED_SET_DRIFTED: %', actual;\n`,
        `    IF false THEN RAISE EXCEPTION 'drift'; END IF;\n`,
      ) +
      `\n`,
  },
  {
    name: 'the row-count assertion aborts only inside an unreachable same-line IF',
    expect: 'violation',
    mustReport: 'row count is never asserted against the approved set',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\n` +
      goodSetBlock().replace(
        `    RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n`,
        `    IF false THEN RAISE EXCEPTION 'count'; END IF;\n`,
      ) +
      `\n`,
  },

  // ── round 20: a digest binds the ROW, not just the column being written ──
  // Rounds 9-19 asked an UPDATE's digest to cover the columns the migration
  // ASSIGNS. That is the whole hole: the assigned column is the one thing
  // guaranteed not to have moved, since the approval was granted precisely
  // because of its value. Everything that decides whether this is still the
  // row anyone approved — who owns it, what it hangs off, where it is in its
  // lifecycle — sat outside the hash (Codex High, round 20).
  {
    name: 'UPDATE digest covers the rewritten column but not ownership or lifecycle',
    expect: 'violation',
    mustReport: 'customer_id',
    sql: `-- APPROVED_SET_DIGEST: ${HEX}\n${goodSetBlock({ bind: 'assigned' })}\n`,
  },
  {
    // The same fixture with the whole row hashed. This is the shape the rule
    // is meant to admit, and the one the round-20 shortcut exists for.
    name: 'correct UPDATE: the digest binds the whole before-state via to_jsonb',
    expect: 'silent',
    sql: `-- APPROVED_SET_DIGEST: ${HEX}\n${goodSetBlock({ bind: 'whole' })}\n`,
  },
  {
    // And by hand, for the author who would rather list them. If the two
    // spellings ever stop agreeing, one of them is wrong.
    name: 'correct UPDATE: the digest enumerates every material column instead',
    expect: 'silent',
    sql: `-- APPROVED_SET_DIGEST: ${HEX}\n${goodSetBlock({ bind: 'enumerated' })}\n`,
  },
  {
    // The shortcut's own failure mode. A whole-row projection names no table,
    // so on a two-table repair `to_jsonb(o.*)` would silently excuse the
    // columns of the table it does NOT cover. It is accepted for single-table
    // repairs only; here order_items.profit must still be called out.
    name: 'to_jsonb of one table does not excuse a second table it never covers',
    expect: 'violation',
    mustReport: 'profit',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\nDECLARE v_ids uuid[]; actual text; n integer;\nBEGIN\n` +
      `  SELECT array_agg(s.id ORDER BY s.id) INTO v_ids\n` +
      `    FROM (SELECT id FROM public.orders WHERE stale ORDER BY id FOR UPDATE) s;\n` +
      `  SELECT encode(digest(string_agg(o.id::text || ':' || to_jsonb(o.*)::text, ',' ORDER BY o.id), 'sha256'), 'hex')\n` +
      `    INTO actual FROM public.orders o JOIN public.order_items oi ON oi.order_id = o.id\n` +
      `    WHERE o.id = ANY(v_ids);\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_DRIFTED: %', actual;\n  END IF;\n` +
      `  UPDATE public.orders SET total_profit = 0 WHERE id = ANY(v_ids);\n` +
      `  UPDATE public.order_items SET profit = 0 WHERE id = ANY(v_ids);\n` +
      `  GET DIAGNOSTICS n = ROW_COUNT;\n  IF n <> array_length(v_ids, 1) THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n  END IF;\nEND $$;\n`,
  },
];

// A stamp no real migration uses, so these fixtures are never mistaken for
// history. What actually makes them in-force is that they are absent from the
// grandfather manifest — the stamp is only there to keep the names unique.
const IN_FORCE = 29990101;

/**
 * A migration that is genuinely on the history side: its basename is in
 * scripts/approved-set-grandfathered.txt and it violates the rule outright, so
 * "silent" can only mean the grandfather lookup exempted it and never that the
 * file happened to be clean. Copied byte-for-byte from the repo.
 */
const GRANDFATHERED = '20260228200000_season_calendar_oct_sep.sql';
const GRANDFATHERED_BODY = readFileSync(
  join(HERE, '..', 'supabase', 'migrations', GRANDFATHERED),
  'utf8',
);
/**
 * The same bytes under a name nobody has approved. Before round 14 the rule was
 * scoped by the timestamp in the filename, so writing a new migration with an
 * old-looking stamp put it on the history side and it was never scanned at all
 * — the guard switched off by the input it was guarding (Codex High, round 14,
 * CRX-SEC-001). Content decides now, so this must be caught.
 */
const BACKDATED = '20260101000001_backdated.sql';

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

/**
 * Editing a grandfathered migration puts it back in force. This needs its own
 * validator run because the fixture has to reuse the real basename, which the
 * verbatim-copy case already occupies. Two files, so it costs seconds.
 *
 * @returns {string[]} failure descriptions, empty when the guard behaved
 */
/**
 * The real repo keeps a one-shot registry beside the migrations, and since
 * round 17 a digest-bound repair must appear in it — an approved-set repair is
 * one-shot by construction, and registration is what stops a replay re-running
 * it against a population that never approved it. A fixture directory with no
 * registry would therefore fail every digest-bound case for the wrong reason,
 * so every harness builds one.
 *
 * @param {string} dir fixture root (the directory holding `supabase/`)
 * @param {string[]} stems migration basenames without the `.sql` suffix
 * @param {string[]} decoys stems written OUTSIDE the one_shot map, which is
 *   what a text search for the name matches and what no guard reads
 */
function writeOneShotRegistry(dir, stems, decoys = []) {
  const baselines = join(dir, 'supabase', 'baselines');
  mkdirSync(baselines, { recursive: true });
  const one_shot = {};
  for (const stem of stems) one_shot[stem] = 'fixture: approved against a synthetic population';
  const _comment = {};
  for (const stem of decoys) _comment[stem] = 'fixture: a key no guard reads';
  writeFileSync(
    join(baselines, 'one-shot-migrations.json'),
    `${JSON.stringify(decoys.length ? { _comment, one_shot } : { one_shot }, null, 2)}\n`,
    'utf8',
  );
}

function runEditedGrandfather() {
  const dir = mkdtempSync(join(tmpdir(), 'crx-approved-set-edited-'));
  const migrations = join(dir, 'supabase', 'migrations');
  mkdirSync(migrations, { recursive: true });
  writeOneShotRegistry(dir, [GRANDFATHERED.replace(/\.sql$/, '')]);
  writeFileSync(
    join(migrations, GRANDFATHERED),
    `${GRANDFATHERED_BODY}\n-- a later edit, however small\n`,
    'utf8',
  );
  const res = spawnSync('bash', [SCRIPT, '--max-violations=999'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env },
  });
  const out = `${res.stdout || ''}\n${res.stderr || ''}`;
  rmSync(dir, { recursive: true, force: true });

  const got = classify(out, GRANDFATHERED);
  if (got === 'violation') return [];
  return [
    `  an edited grandfathered migration is back in force\n    expected violation, got ${got}`,
  ];
}

function run() {
  const dir = mkdtempSync(join(tmpdir(), 'crx-approved-set-'));
  const migrations = join(dir, 'supabase', 'migrations');
  mkdirSync(migrations, { recursive: true });

  const names = [];
  const registered = [];
  const decoys = [];
  CASES.forEach((c, i) => {
    const name = `${IN_FORCE}${String(i).padStart(6, '0')}_case_${i}.sql`;
    writeFileSync(join(migrations, name), c.sql, 'utf8');
    names.push(name);
    // Everything is registered except the cases whose whole point is that they
    // are not — otherwise those cases would pass for a reason they never
    // tested. A decoy is written into the file but outside the one_shot map,
    // so it is still unregistered as far as any guard is concerned.
    if (!c.unregistered) registered.push(name.replace(/\.sql$/, ''));
    if (c.decoyRegistered) decoys.push(name.replace(/\.sql$/, ''));
  });
  writeOneShotRegistry(
    dir,
    [...registered, GRANDFATHERED.replace(/\.sql$/, ''), BACKDATED.replace(/\.sql$/, '')],
    decoys,
  );
  // A real grandfathered migration, byte-for-byte, must stay silent: applied
  // history cannot be edited, so retro-checking it would only produce noise.
  // The same bytes under an unapproved (old-looking) name must be caught.
  writeFileSync(join(migrations, GRANDFATHERED), GRANDFATHERED_BODY, 'utf8');
  writeFileSync(join(migrations, BACKDATED), GRANDFATHERED_BODY, 'utf8');

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
  // Not "silent": this file also trips an unrelated column-alias WARNING, and
  // asserting on that would make the case fail whenever some other check
  // changes. What is under test is the approved-set rule, so what has to be
  // absent is the VIOLATION — which the identical bytes under an unapproved
  // name (below) do produce.
  const gfGot = classify(out, GRANDFATHERED);
  if (gfGot === 'violation') {
    failures.push(
      `  a migration in the grandfather manifest is history\n    expected no violation, got ${gfGot}`,
    );
  }
  const backGot = classify(out, BACKDATED);
  if (backGot !== 'violation') {
    failures.push(
      `  the same bytes under an unapproved name are in force\n` +
        `    expected violation, got ${backGot}`,
    );
  }

  rmSync(dir, { recursive: true, force: true });
  failures.push(...runEditedGrandfather());

  if (failures.length > 0) {
    console.error(`❌ approved-set guard: ${failures.length} case(s) behaved wrong\n`);
    console.error(failures.join('\n'));
    console.error('\n--- validator output ---\n');
    console.error(out);
    process.exit(1);
  }
  console.log(`✅ approved-set guard: ${CASES.length + 3} mutation cases behaved correctly`);
}

run();
