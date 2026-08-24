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
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { staleTriggerSources } from './check-trigger-fanout-staleness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'validate-sql-migrations.sh');
const HEX = 'a'.repeat(64);
const OTHER_HEX = 'b'.repeat(64);

function resolveBashExecutable() {
  if (process.platform !== 'win32') return 'bash';

  const whereGit = spawnSync('where.exe', ['git.exe'], { encoding: 'utf8' });
  for (const gitPath of (whereGit.stdout || '').split(/\r?\n/).filter(Boolean)) {
    const candidate = join(dirname(dirname(gitPath.trim())), 'bin', 'bash.exe');
    if (existsSync(candidate)) return candidate;
  }

  throw new Error('Git Bash was not found beside any git.exe on PATH');
}

const BASH = resolveBashExecutable();

function runBash(args, options) {
  const result = spawnSync(BASH, args, options);
  if (result.error) throw result.error;
  return result;
}

/**
 * process.env with every GIT_* variable stripped.
 *
 * This test runs inside the pre-commit hook, and git exports GIT_DIR,
 * GIT_INDEX_FILE and friends to its hooks. A child `git` inheriting those
 * ignores its own cwd and operates on the REAL repository instead of the
 * fixture — `git init` in a temp directory then reinitialises the live repo,
 * which sets core.bare=true on the shared config and breaks every worktree and
 * every session on the machine until someone notices. That is not theoretical:
 * it happened once from a sibling test (fixed in #333) and once from this one.
 *
 * Every subprocess below gets this env, not `process.env` — including the bash
 * scans, since the validator itself shells out to git on the changed-only path.
 * Identity is still passed per invocation with `-c`; never `git config --global`.
 *
 * @returns {NodeJS.ProcessEnv} the environment, with GIT_* removed
 */
function envWithoutGit() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_')),
  );
}

/**
 * Remove a fixture tree after Bash exits.
 *
 * On Windows, MSYS Bash can retain a directory handle for a fraction of a
 * second after spawnSync returns. Node's recursive remover retries EPERM only
 * when maxRetries is non-zero; without that bound the mutation suite aborts
 * during cleanup before it can report the validator assertions.
 *
 * @param {string} dir fixture root
 */
function removeFixtureTree(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EBUSY')) {
      // Some Windows runners retain fixture handles until this Node process
      // exits. Every fixture uses mkdtemp, so leaving that one isolated tree
      // for the OS temp cleaner cannot affect another case.
      return;
    }
    throw error;
  }
}

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
 *
 * `total_profit` is wrapped in coalesce because round 31 made an un-wrapped
 * nullable operand its own violation: `x || NULL` is NULL and string_agg SKIPS
 * NULL inputs, so a row with an unset value drops out of the digest entirely.
 * Every fixture below is meant to fail for the ONE reason it is named after, so
 * the shared expression has to be null-safe or the round-31 message masks them.
 */
const HASH_EXPR = `encode(digest(string_agg(id::text || ':' || coalesce(total_profit::text, ''), ',' ORDER BY id), 'sha256'), 'hex')`;
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
  `encode(digest(string_agg(id::text || ':' || coalesce(quote_id::text, '') || ':' || coalesce(customer_id::text, '')` +
  ` || ':' || coalesce(status::text, '') || ':' || coalesce(total_price::text, '') || ':' || coalesce(total_cost::text, '')` +
  ` || ':' || coalesce(total_profit::text, '') || ':' || coalesce(total_margin_pct::text, '')` +
  ` || ':' || coalesce(salesman_id::text, '')` +
  ` || ':' || coalesce(deleted_at::text, '') || ':' || coalesce(pricing_status::text, '')` +
  // Round 21 added lifecycle booleans to the material set, and `orders.is_planned`
  // is one: a planned order flipped to real between the digest and the write is
  // a different row in every way that matters. Enumerating by hand means
  // keeping up with the registry — which is why the whole-row projection above
  // is the shape the guard actually recommends.
  ` || ':' || coalesce(is_planned::text, ''), ',' ORDER BY id), 'sha256'), 'hex')`;
/**
 * The enumeration with one lifecycle flag dropped (Codex High, round 21).
 *
 * Through round 20 `is_planned` was not counted as material, so this shape was
 * accepted: an order could be flipped from planned to real between the approval
 * and the apply and the digest still matched. An on/off flag is state, and a
 * row whose state moved is not the row that was approved.
 */
const ENUMERATED_MINUS_FLAG_EXPR = ENUMERATED_HASH_EXPR.replace(
  ` || ':' || coalesce(is_planned::text, '')`,
  '',
);
/** The pre-round-33 enumeration: authoritative margin state was omitted. */
const ENUMERATED_MINUS_MARGIN_EXPR = ENUMERATED_HASH_EXPR.replace(
  ` || ':' || coalesce(total_margin_pct::text, '')`,
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
    name: 'MERGE without optional INTO still rewrites existing rows',
    expect: 'violation',
    sql:
      `MERGE public.orders t\nUSING (SELECT 1 AS id) s ON t.id = s.id\n` +
      `WHEN MATCHED THEN UPDATE SET total_profit = 0;\n`,
  },
  {
    name: 'MERGE ONLY without optional INTO can delete existing rows',
    expect: 'violation',
    sql:
      `MERGE ONLY public.orders t\nUSING (SELECT 1 AS id) s ON t.id = s.id\n` +
      `WHEN MATCHED THEN DELETE;\n`,
  },
  {
    name: 'malformed MERGE target fails closed',
    expect: 'violation',
    sql: `MERGE USING (SELECT 1 AS id) s ON true WHEN MATCHED THEN DELETE;\n`,
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
    // Codex High, round 23. `IF NOT EXISTS` on a column that already exists is
    // a no-op, so the migration adds nothing while claiming the waiver that is
    // only honest when it adds the column. Whether the column is new is a fact
    // about the database, so the claim is checked against the schema registry.
    name: 'ADD COLUMN IF NOT EXISTS on a pre-existing column is not an added column',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: NOT-REQUIRED (orders) - backfills a column this migration adds\n` +
      `ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS total_profit numeric;\n` +
      `UPDATE public.orders SET total_profit = 0;\n`,
  },
  {
    // The same evasion with the harmless-column pairing: one genuinely new
    // column earns the waiver, a no-op ALTER smuggles the money column in.
    name: 'a real ADD COLUMN cannot carry a no-op IF NOT EXISTS alongside it',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: NOT-REQUIRED (orders) - backfills columns this migration adds\n` +
      `ALTER TABLE public.orders ADD COLUMN backfill_note_cents bigint;\n` +
      `ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS total_profit numeric;\n` +
      `UPDATE public.orders SET backfill_note_cents = 0, total_profit = 0;\n`,
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
    // The column must be one the trusted base does not already have, or the
    // ALTER would fail at apply time and the waiver would be a fiction. See
    // the round-23 case below.
    name: 'waiver naming every table, backfilling a column this migration adds',
    expect: 'warning',
    sql:
      `-- APPROVED_SET_DIGEST: NOT-REQUIRED (orders) - backfills a column this migration adds\n` +
      `ALTER TABLE public.orders ADD COLUMN margin_review_cents bigint;\n` +
      `UPDATE public.orders SET margin_review_cents = 0;\n`,
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
    // refusal: storage remains out of scope when no checked-in cascade returns
    // to a public business table.
    name: 'writing a Supabase infrastructure schema is still out of scope',
    expect: 'silent',
    sql: `UPDATE storage.objects SET updated_at = now();\n`,
  },
  {
    // ROUND 35 (Sol High). Adding a volatile default evaluates it for existing
    // rows. Excluding every call under ALTER let a scratch-table rewrite invoke
    // a mutator of protected money while the scanner reported nothing.
    name: 'round-35: ADD COLUMN DEFAULT cannot invoke a protected-row mutator',
    expect: 'violation',
    mustReport: 'alter_default_repair_r35',
    sql:
      `CREATE FUNCTION public.alter_default_repair_r35() RETURNS integer\n` +
      `LANGUAGE plpgsql AS $$ BEGIN\n` +
      `  UPDATE public.orders SET total_profit = total_profit;\n` +
      `  RETURN 1;\nEND $$;\n` +
      `CREATE TEMP TABLE scratch_r35 (id integer);\n` +
      `INSERT INTO scratch_r35(id) VALUES (1);\n` +
      `ALTER TABLE scratch_r35 ADD COLUMN probe integer ` +
      `DEFAULT public.alter_default_repair_r35();\n`,
  },
  {
    // ROUND 36 (Sol High). PostgreSQL permits `$` in identifiers. The quoted
    // form previously became an empty function identity in the mutating index
    // and an unrelated `count` token at the call site.
    name: 'round-36: quoted dollar routine identity cannot hide a protected rewrite',
    expect: 'violation',
    mustReport: '_dollar_count',
    sql:
      `CREATE FUNCTION public."$count"() RETURNS void LANGUAGE plpgsql AS $body$\n` +
      `BEGIN\n  UPDATE public.order_items SET total_price = total_price;\nEND\n$body$;\n` +
      `SELECT public."$count"();\nDROP FUNCTION public."$count"();\n`,
  },
  {
    name: 'round-36: unquoted embedded dollar routine identity is preserved too',
    expect: 'violation',
    mustReport: 'repair_dollar_orders',
    sql:
      `CREATE FUNCTION public.repair$orders() RETURNS void LANGUAGE plpgsql AS $$\n` +
      `BEGIN\n  UPDATE public.orders SET total_profit = total_profit;\nEND\n$$;\n` +
      `SELECT public.repair$orders();\n`,
  },
  {
    name: 'round-41: a tag-shaped dollar run inside an identifier is not a quote',
    expect: 'violation',
    mustReport: 'repair_dollar_x_dollar_',
    sql:
      `CREATE FUNCTION public.repair$x$() RETURNS void LANGUAGE plpgsql AS $$\n` +
      `BEGIN\n  UPDATE public.orders SET total_profit = total_profit;\nEND\n$$;\n` +
      `SELECT public.repair$x$();\n`,
  },
  {
    // ROUND 27 (Codex High). The allowlist above was the bypass one more time.
    // `pg_temp` is on it because a temp table is scratch — but a temp VIEW is
    // not scratch, it is a writable alias for permanent rows. A single-table
    // view is automatically updatable, so the two statements below rewrite real
    // order_items rows; the creation WAS indexed, but the write never reached
    // the view check because `pg_temp.` matched the schema exemption first and
    // returned. The apply-time guard sees only `oi_shim`, so nothing else caught
    // it either. The view check now runs BEFORE the schema exemption.
    name: 'writing through a pg_temp view is refused',
    expect: 'violation',
    mustReport: 'pg_temp.oi_shim',
    sql:
      `CREATE TEMP VIEW oi_shim AS\n` +
      `SELECT * FROM public.order_items;\n` +
      `UPDATE pg_temp.oi_shim SET profit = 0;\n`,
  },
  {
    // Same hole, reached through a view another migration defined — the reorder
    // has to consult the repo-wide index, not just what this file created.
    name: 'writing a repo-known view through the pg_temp qualifier is refused',
    expect: 'violation',
    mustReport: 'pg_temp.legacy_orders_v',
    sql: `UPDATE pg_temp.legacy_orders_v SET total_profit = 0;\n`,
  },
  {
    // And the reorder must not cost the exemption its point: a genuine temp
    // TABLE holds no business rows and is still out of scope, qualifier and all.
    name: 'writing a pg_temp scratch table is still out of scope',
    expect: 'silent',
    sql:
      `CREATE TEMP TABLE ids_to_fix_r27 (id uuid);\n` +
      `UPDATE pg_temp.ids_to_fix_r27 SET id = gen_random_uuid();\n`,
  },
  {
    // ROUND 28 (Codex High). The indirect reader skips a mutating function that
    // appears under a statement head of create/alter/drop/grant/..., which is
    // right for a definition and wrong for `CREATE TRIGGER ... EXECUTE
    // FUNCTION`: that statement binds the function to a relation, and the next
    // write to that relation runs it. A plain INSERT was skipped outright
    // (`setp == 0` — it adds rows rather than rewriting them) and the scratch
    // table is `made_table`, so nothing reported at all. This is Codex's own
    // reproducer, verbatim in shape.
    name: 'a trigger attached to a scratch table and then fired is refused',
    expect: 'violation',
    mustReport: 'tmp_fix',
    sql:
      `CREATE FUNCTION public.tmp_fix() RETURNS trigger\n` +
      `LANGUAGE plpgsql SECURITY DEFINER\n` +
      `SET search_path = public, pg_temp AS $$\nBEGIN\n` +
      `  UPDATE public.order_items SET profit = (profit);\n  RETURN NEW;\nEND $$;\n` +
      `CREATE TEMP TABLE scratch_r28 (id integer);\n` +
      `CREATE TRIGGER run_fix AFTER INSERT ON scratch_r28\n` +
      `  FOR EACH ROW EXECUTE FUNCTION public.tmp_fix();\n` +
      `INSERT INTO scratch_r28 (id) VALUES (1);\n`,
  },
  {
    // The false-positive boundary Codex stated with the finding: merely
    // creating a trigger is not a write. Without this the rule becomes "any
    // migration that adds a trigger is a violation", and 107 of the 882
    // migrations in this repository attach one.
    name: 'attaching a trigger without ever firing it stays silent',
    expect: 'silent',
    sql:
      `CREATE FUNCTION public.tmp_fix_quiet() RETURNS trigger\n` +
      `LANGUAGE plpgsql AS $$\nBEGIN\n` +
      `  UPDATE public.order_items SET profit = (profit);\n  RETURN NEW;\nEND $$;\n` +
      `CREATE TEMP TABLE scratch_quiet_r28 (id integer);\n` +
      `CREATE TRIGGER run_quiet AFTER INSERT ON scratch_quiet_r28\n` +
      `  FOR EACH ROW EXECUTE FUNCTION public.tmp_fix_quiet();\n`,
  },
  {
    // The scratch table is incidental. A trigger attached to a real table and
    // fired by this file's own DML on that table is the same bypass.
    name: 'a trigger fired by DML on a real table is refused',
    expect: 'violation',
    mustReport: 'carry_r28',
    sql:
      `CREATE FUNCTION public.carry_r28() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n` +
      `  UPDATE public.order_items SET profit = (profit);\n  RETURN NEW;\nEND $$;\n` +
      `CREATE TRIGGER t_carry_r28 AFTER UPDATE ON public.customers\n` +
      `  FOR EACH ROW EXECUTE FUNCTION public.carry_r28();\n` +
      `UPDATE public.customers SET notes = 'x';\n`,
  },
  {
    // …and the shape almost every migration here uses: a trigger whose body
    // touches nothing protected is not indexed as mutating, so firing it costs
    // nothing. This is what keeps the measured friction at one file.
    name: 'firing an updated_at trigger is not a protected write',
    expect: 'silent',
    sql:
      `CREATE FUNCTION public.touch_r28() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n` +
      `  NEW.updated_at = now();\n  RETURN NEW;\nEND $$;\n` +
      `CREATE TRIGGER t_touch_r28 BEFORE UPDATE ON public.crm_contacts\n` +
      `  FOR EACH ROW EXECUTE FUNCTION public.touch_r28();\n`,
  },
  {
    // ROUND 30 (Codex High), the other half of the same finding. The mutating
    // index was built one level deep: a function was indexed if its OWN body
    // spelled DML on a protected table, or ran dynamic SQL. A wrapper whose
    // body only PERFORMs a mutator spells neither, so it was never indexed —
    // and a top-level call to it asked for no digest and no one-shot
    // registration while the rewrite happened underneath. Wrapping is free and
    // one line long, which is what made this the cheapest bypass on the board.
    //
    // The fix walks the call graph backwards from every known mutator, so
    // "calls something that writes" is itself writing, to any depth.
    name: 'a top-level call to a wrapper around a mutator is refused',
    expect: 'violation',
    mustReport: 'wrap_r30',
    sql:
      `CREATE FUNCTION public.mut_r30() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n` +
      `  UPDATE public.order_items SET profit = (profit);\nEND $$;\n` +
      `CREATE FUNCTION public.wrap_r30() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n` +
      `  PERFORM public.mut_r30();\nEND $$;\n` +
      `SELECT public.wrap_r30();\n`,
  },
  {
    // Depth is not the boundary — one level of wrapping would just become two.
    name: 'a wrapper around a wrapper is refused just the same',
    expect: 'violation',
    mustReport: 'outer_r30',
    sql:
      `CREATE FUNCTION public.inner_r30() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n` +
      `  UPDATE public.order_items SET profit = (profit);\nEND $$;\n` +
      `CREATE FUNCTION public.mid_r30() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n` +
      `  PERFORM public.inner_r30();\nEND $$;\n` +
      `CREATE FUNCTION public.outer_r30() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n` +
      `  PERFORM public.mid_r30();\nEND $$;\n` +
      `SELECT public.outer_r30();\n`,
  },
  {
    // The boundary that keeps the closure affordable: it spreads along call
    // edges out of KNOWN mutators only. A helper that writes nothing protected
    // is not a mutator, so calling it — or calling something that calls it —
    // stays free. Without this the rule degenerates into "any migration that
    // calls any function is a violation".
    name: 'a wrapper around a helper that writes nothing protected stays silent',
    expect: 'silent',
    sql:
      `CREATE FUNCTION public.plain_r30() RETURNS integer LANGUAGE sql AS $$\n` +
      `  SELECT 1;\n$$;\n` +
      `CREATE FUNCTION public.wrapplain_r30() RETURNS integer LANGUAGE plpgsql AS $$\nBEGIN\n` +
      `  RETURN public.plain_r30();\nEND $$;\n` +
      `SELECT public.wrapplain_r30();\n`,
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
    // Another schema is another concern when it has no captured path back into
    // a public business table.
    name: 'a write into a non-public schema is out of scope',
    expect: 'silent',
    sql: `UPDATE storage.objects SET updated_at = now();\n`,
  },
  {
    name: 'round-40: a cross-schema FK cascade back into public is in scope',
    expect: 'violation',
    mustReport: 'profiles',
    sql: `DELETE FROM auth.users WHERE id = '00000000-0000-0000-0000-000000000001';\n`,
  },
  {
    // A plain INSERT adds rows; it rewrites no approved population. Flagging it
    // would make the guard noise, and noise is how a guard gets switched off.
    name: 'a plain INSERT with no ON CONFLICT DO UPDATE is not a rewrite',
    expect: 'silent',
    sql: `INSERT INTO public.orders (id, total_profit) VALUES (1, 0);\n`,
  },
  {
    // A plain INSERT can still rewrite an EXISTING population through a trigger
    // captured in the live fan-out manifest. No trigger is defined in this
    // migration, so the round-28 migration-local attachment scanner cannot be
    // what catches it.
    name: 'a plain INSERT that fires checked-in live fan-out is reported',
    expect: 'violation',
    mustReport: 'write_product_pricing_history',
    sql: `INSERT INTO public.products (id) VALUES ('00000000-0000-0000-0000-000000000001');\n`,
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
    // ROUND 53 (Codex High). CALL writes OUT/INOUT arguments back into the
    // caller, so the load-bearing array can change without an INTO or := at
    // the call site. Keeping the replacement array the same length also makes
    // the ordinary ROW_COUNT assertion pass over the wrong population.
    name: 'round-53: an INOUT procedure replaces the captured ids after approval',
    expect: 'violation',
    mustReport: 'possibly OUT/INOUT procedure',
    sql:
      `CREATE PROCEDURE public._swap_approved_ids(INOUT p_ids uuid[]) LANGUAGE plpgsql AS $$\n` +
      `BEGIN\n` +
      `  SELECT array_agg(s.id ORDER BY s.id) INTO p_ids\n` +
      `    FROM (SELECT id FROM public.orders WHERE NOT stale ORDER BY id LIMIT cardinality(p_ids)) s;\n` +
      `END;\n$$;\n` +
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\n` +
      `DECLARE v_ids uuid[]; actual text; n integer;\nBEGIN\n` +
      `  SELECT array_agg(s.id ORDER BY s.id) INTO v_ids\n` +
      `    FROM (SELECT id FROM public.orders WHERE stale ORDER BY id FOR UPDATE) s;\n` +
      `  SELECT ${WHOLE_ROW_HASH_EXPR} INTO actual FROM public.orders o WHERE o.id = ANY(v_ids);\n` +
      `  IF actual IS DISTINCT FROM '${HEX}' THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_DRIFTED: %', actual;\n  END IF;\n` +
      `  CALL public._swap_approved_ids(v_ids);\n` +
      `  UPDATE public.orders SET total_profit = 0 WHERE id = ANY(v_ids);\n` +
      `  GET DIAGNOSTICS n = ROW_COUNT;\n` +
      `  IF n <> array_length(v_ids, 1) THEN\n` +
      `    RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n  END IF;\nEND $$;\n`,
  },
  {
    // The captured variable token in a procedure identity is not an argument.
    // This control keeps the fail-closed rule on the CALL argument list rather
    // than banning an unrelated, read-only procedure with an unlucky name.
    name: 'round-53 control: a procedure named like the id variable stays deferred',
    expect: 'silent',
    sql:
      `CREATE PROCEDURE public.v_ids(IN p_value integer) LANGUAGE plpgsql AS $$\n` +
      `BEGIN NULL; END;\n$$;\n` +
      `-- APPROVED_SET_DIGEST: ${HEX}\n` +
      goodSetBlock().replace(
        `  UPDATE public.orders SET total_profit = 0 WHERE id = ANY(v_ids);`,
        `  CALL public.v_ids(1);\n  UPDATE public.orders SET total_profit = 0 WHERE id = ANY(v_ids);`,
      ) +
      `\n`,
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
  {
    name: 'an escape-string function body cannot hide a protected rewrite',
    expect: 'violation',
    mustReport: 'single-quoted string',
    sql:
      `CREATE FUNCTION public._escape_fix() RETURNS void LANGUAGE plpgsql AS ` +
      `E'BEGIN UPDATE public.orders SET total_profit = 0; END;';\n` +
      `SELECT public._escape_fix();\n`,
  },
  {
    name: 'a Unicode-string procedure body cannot hide a protected rewrite',
    expect: 'violation',
    mustReport: 'single-quoted string',
    sql:
      `CREATE PROCEDURE public._unicode_fix() LANGUAGE plpgsql AS ` +
      `U&'BEGIN UPDATE public.orders SET total_profit = 0; END;';\n` +
      `CALL public._unicode_fix();\n`,
  },
  {
    name: 'a called dollar-quoted procedure that rewrites protected rows is indirect',
    expect: 'violation',
    mustReport: 'Top-level call to a routine',
    sql:
      `CREATE PROCEDURE public._procedure_fix() LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.orders SET total_profit = 0; END;\n$$;\n` +
      `CALL public._procedure_fix();\n`,
  },
  {
    name: 'a dollar-quoted procedure wrapper inherits a function mutator transitively',
    expect: 'violation',
    mustReport: 'Top-level call to a routine',
    sql:
      `CREATE FUNCTION public._inner_fix() RETURNS void LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.orders SET total_profit = 0; END;\n$$;\n` +
      `CREATE PROCEDURE public._procedure_wrapper() LANGUAGE plpgsql AS $$\n` +
      `BEGIN PERFORM public._inner_fix(); END;\n$$;\n` +
      `CALL public._procedure_wrapper();\n`,
  },
  {
    name: 'a database-qualified SELECT cannot hide a same-file mutating function',
    expect: 'violation',
    mustReport: 'Top-level call to a routine',
    sql:
      `CREATE FUNCTION public._dbq_select_fix() RETURNS void LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.orders SET total_profit = total_profit; END;\n$$;\n` +
      `SELECT postgres.public._dbq_select_fix();\n`,
  },
  {
    name: 'a database-qualified CALL cannot hide a same-file mutating procedure',
    expect: 'violation',
    mustReport: 'Top-level call to a routine',
    sql:
      `CREATE PROCEDURE public._dbq_call_fix() LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.orders SET total_profit = total_profit; END;\n$$;\n` +
      `CALL postgres.public._dbq_call_fix();\n`,
  },
  {
    name: 'a database-qualified PERFORM cannot hide a same-file mutating helper',
    expect: 'violation',
    mustReport: 'Top-level call to a routine',
    sql:
      `CREATE FUNCTION public._dbq_perform_fix() RETURNS void LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.orders SET total_profit = total_profit; END;\n$$;\n` +
      `DO $$ BEGIN PERFORM postgres.public._dbq_perform_fix(); END $$;\n`,
  },
  {
    name: 'a Unicode-named procedure cannot hide a protected rewrite',
    expect: 'violation',
    mustReport: 'Unsupported non-ASCII routine identity',
    sql:
      `CREATE PROCEDURE public.修復() LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.order_items SET profit = profit; END;\n$$;\n` +
      `CALL public.修復();\nDROP PROCEDURE public.修復();\n`,
  },
  {
    name: 'round-40: a plain-string DO block cannot hide direct protected DML',
    expect: 'violation',
    mustReport: 'non-dollar-quoted single-quoted string',
    sql: `DO 'BEGIN UPDATE public.orders SET total_profit = total_profit; END';\n`,
  },
  {
    name: 'round-40: an escape-string DO block cannot hide a resident mutator call',
    expect: 'violation',
    mustReport: 'non-dollar-quoted single-quoted string',
    sql: `DO E'BEGIN PERFORM public.existing_money_repair(); END';\n`,
  },
  {
    name: 'round-40: a split quoted LANGUAGE clause cannot hide a Unicode DO body',
    expect: 'violation',
    mustReport: 'non-dollar-quoted single-quoted string',
    sql:
      `DO LANGUAGE "plpgsql"\n` +
      `U&'BEGIN PERFORM public.existing_money_repair(); END';\n`,
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

  {
    name: 'GET STACKED DIAGNOSTICS overwrites the compared digest after it is computed',
    expect: 'violation',
    mustReport: 'Assign the compared variable exactly once',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\n` +
      goodSetBlock().replace(
        `  IF actual IS DISTINCT FROM '${HEX}' THEN`,
        `  BEGIN\n    RAISE EXCEPTION '%', repeat('a', 64);\n` +
          `  EXCEPTION WHEN OTHERS THEN\n` +
          `    GET STACKED DIAGNOSTICS actual = MESSAGE_TEXT;\n  END;\n` +
          `  IF actual IS DISTINCT FROM '${HEX}' THEN`,
      ) +
      `\n`,
  },
  {
    name: 'GET CURRENT DIAGNOSTICS overwrites the compared digest after it is computed',
    expect: 'violation',
    mustReport: 'Assign the compared variable exactly once',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\n` +
      goodSetBlock().replace(
        `  IF actual IS DISTINCT FROM '${HEX}' THEN`,
        `  GET CURRENT DIAGNOSTICS actual = PG_CONTEXT;\n` +
          `  IF actual IS DISTINCT FROM '${HEX}' THEN`,
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

  {
    name: 'the digest mismatch RAISE is swallowed by a nested exception handler',
    expect: 'violation',
    mustReport: 'does not RAISE EXCEPTION inside its own IF block',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\n` +
      goodSetBlock().replace(
        `    RAISE EXCEPTION 'APPROVED_SET_DRIFTED: %', actual;\n`,
        `    BEGIN\n      RAISE EXCEPTION 'APPROVED_SET_DRIFTED: %', actual;\n` +
          `    EXCEPTION WHEN OTHERS THEN NULL;\n    END;\n`,
      ) +
      `\n`,
  },
  {
    name: 'the row-count RAISE is swallowed by a nested exception handler',
    expect: 'violation',
    mustReport: 'row count is never asserted against the approved set',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\n` +
      goodSetBlock().replace(
        `    RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n`,
        `    BEGIN\n      RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n` +
          `    EXCEPTION WHEN OTHERS THEN NULL;\n    END;\n`,
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
    name: 'UPDATE digest enumeration omits compound money column total_margin_pct',
    expect: 'violation',
    mustReport: 'total_margin_pct',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\n` +
      `${goodSetBlock({ bind: 'enumerated' }).replace(ENUMERATED_HASH_EXPR, ENUMERATED_MINUS_MARGIN_EXPR)}\n`,
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

  // ── round 29: a column type change is a whole-table rewrite ──────────────
  // Every channel above reads a DML verb, and `ALTER TABLE ... ALTER COLUMN c
  // TYPE t USING <expr>` spells none of them while rewriting every row of the
  // table: the USING expression is evaluated per row and its result is what
  // gets stored. No binding is possible, because all rows changed — so it is
  // reported exactly as TRUNCATE is, and needs the same digest (Codex High,
  // round 29). The apply-time analyzer already read this shape as `table.*`;
  // this closes the same gap on the scanner side.
  {
    name: 'a type change with USING on a protected table is a whole-table rewrite',
    expect: 'violation',
    mustReport: 'retype',
    sql:
      `ALTER TABLE public.order_items\n` +
      `  ALTER COLUMN profit TYPE numeric(12,2) USING round(profit, 2);\n`,
  },
  {
    // The other spelling of the same statement. PostgreSQL accepts `SET DATA
    // TYPE` as a synonym, and a rule that reads only one of them is a rule an
    // author defeats by typing three extra words.
    name: 'the SET DATA TYPE spelling of the same rewrite is caught too',
    expect: 'violation',
    mustReport: 'retype',
    sql:
      `ALTER TABLE ONLY public.order_items\n` +
      `  ALTER COLUMN profit SET DATA TYPE numeric(12,2);\n`,
  },
  {
    // The boundaries that keep this affordable. These are what ALTER COLUMN is
    // actually used for in this repository — measured over all 882 migrations,
    // every one of the 11 files that says `ALTER COLUMN` does one of these and
    // none changes a type, so the rule costs the existing tree nothing.
    name: 'a NOT NULL constraint change is not a row rewrite',
    expect: 'silent',
    sql: `ALTER TABLE public.order_items ALTER COLUMN profit SET NOT NULL;\n`,
  },
  {
    name: 'a column default change is not a row rewrite',
    expect: 'silent',
    sql: `ALTER TABLE public.order_items ALTER COLUMN profit SET DEFAULT 0;\n`,
  },
  {
    // The false positive the first cut of this rule actually had. A column
    // literally named `type` puts the word TYPE one token before where the
    // keyword would be, and reading backwards from TYPE mistook the word
    // `column` for the column's name and fired on a plain default change.
    // The reader walks the action list FORWARDS from each ALTER instead, which
    // is the only direction that can tell a name from a keyword.
    name: 'a column named type is not a type change',
    expect: 'silent',
    sql:
      `ALTER TABLE public.order_items ALTER COLUMN type SET DEFAULT 'blend';\n` +
      `ALTER TABLE public.order_items ALTER CONSTRAINT fk_order DEFERRABLE;\n` +
      `ALTER TABLE public.order_items ADD COLUMN probe_note_r29 text;\n`,
  },
  {
    // …and the same column really being retyped still fires, so the case above
    // proves the reader distinguishes them rather than merely going quiet.
    name: 'retyping a column named type is still a whole-table rewrite',
    expect: 'violation',
    mustReport: 'retype',
    sql: `ALTER TABLE public.order_items ALTER COLUMN type TYPE text;\n`,
  },
  {
    // Scratch rows are not business rows. A table this migration created has no
    // approved set to bind, exactly as with every other write channel here.
    name: 'retyping a column of a table this migration created stays silent',
    expect: 'silent',
    sql:
      `CREATE TEMP TABLE scratch_r29 (id integer, amt numeric);\n` +
      `ALTER TABLE scratch_r29 ALTER COLUMN amt TYPE numeric(12,2) USING round(amt, 2);\n`,
  },
  {
    // ROUND 31 (Codex High). Everything above proves the repair rewrote exactly
    // the rows it hashed — for the table the UPDATE names. Triggers were
    // invisible, so this block, which is airtight by every earlier rule, fired
    // write_product_pricing_history underneath and rewrote public.cost_history: rows never
    // captured, never hashed, and not counted by the ROW_COUNT assertion.
    name: 'round-31: a trigger cascade out of the repaired table is reported',
    expect: 'violation',
    mustReport: 'write_product_pricing_history',
    sql: fanoutBlock('products', 'current_cost'),
  },
  {
    name: 'round-31: the cascade report names the table that gets rewritten',
    expect: 'violation',
    mustReport: 'rewrites cost_history',
    sql: fanoutBlock('products', 'current_cost'),
  },
  {
    // The control the two cases above are worthless without. Byte-identical
    // shape on a table nothing cascades out of: if this also violated, the pair
    // would be proving that the fixture is malformed, not that the fan-out gate
    // works.
    name: 'round-31: the same shape on a table with no cascade stays silent',
    expect: 'silent',
    sql: fanoutBlock('commissions', 'commission_amount'),
  },
  {
    // One trigger, three targets. The message only has to name one of them to
    // be actionable, but the migration must not pass.
    name: 'round-31: a trigger that rewrites three tables is reported',
    expect: 'violation',
    mustReport: 'write_product_pricing_history',
    sql: fanoutBlock('products', 'current_cost'),
  },
  {
    name: 'round-33: comment markers inside a quoted routine name cannot hide its rewrite',
    expect: 'violation',
    mustReport: '__now',
    sql:
      `CREATE FUNCTION public."--now"() RETURNS void LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.orders SET total_profit = 0; END $$;\n` +
      `SELECT public."--now"();\n`,
  },
  {
    name: 'round-33: firing a PostgreSQL rule is an unbindable indirect rewrite',
    expect: 'violation',
    mustReport: 'rule_on_scratch_probe',
    sql:
      `CREATE TEMP TABLE scratch_probe(id integer);\n` +
      `CREATE RULE fire_repair AS ON INSERT TO scratch_probe ` +
      `DO ALSO SELECT public.existing_repair();\n` +
      `INSERT INTO scratch_probe(id) VALUES (1);\n`,
  },
  {
    name: 'round-52: selecting through an ON SELECT rule is an unbindable indirect rewrite',
    expect: 'violation',
    mustReport: 'rule_on_select_scratch_probe',
    sql:
      `CREATE FUNCTION public.rule_money_fix() RETURNS integer LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.orders SET total_profit = total_profit; RETURN 1; END $$;\n` +
      `CREATE TABLE public.scratch_probe(id integer);\n` +
      `CREATE RULE "_RETURN" AS ON SELECT TO public.scratch_probe ` +
      `DO INSTEAD SELECT public.rule_money_fix() AS id;\n` +
      `SELECT * FROM public.scratch_probe;\n`,
  },
  {
    name: 'round-52 MUTANT: defining an ON SELECT rule without reading it remains deferred',
    expect: 'silent',
    sql:
      `CREATE FUNCTION public.deferred_rule_money_fix() RETURNS integer LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.orders SET total_profit = total_profit; RETURN 1; END $$;\n` +
      `CREATE TABLE public.deferred_scratch_probe(id integer);\n` +
      `CREATE RULE "_RETURN" AS ON SELECT TO public.deferred_scratch_probe ` +
      `DO INSTEAD SELECT public.deferred_rule_money_fix() AS id;\n`,
  },
  {
    name: 'round-37: a custom operator invocation cannot hide its mutating backing routine',
    expect: 'violation',
    mustReport: 'crxop_eq_eq_eq',
    sql:
      `CREATE FUNCTION public.operator_money_fix(integer, integer) RETURNS boolean LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.orders SET total_profit = total_profit; RETURN true; END $$;\n` +
      `CREATE OPERATOR === (PROCEDURE = public.operator_money_fix, LEFTARG = integer, RIGHTARG = integer);\n` +
      `SELECT 1 === 1;\n`,
  },
  {
    name: 'round-37 MUTANT: an uninvoked custom operator definition remains deferred',
    expect: 'silent',
    sql:
      `CREATE FUNCTION public.operator_definition_only(integer, integer) RETURNS boolean LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.orders SET total_profit = total_profit; RETURN true; END $$;\n` +
      `CREATE OPERATOR !=== (PROCEDURE = public.operator_definition_only, LEFTARG = integer, RIGHTARG = integer);\n`,
  },
  {
    name: 'round-37: a custom operator defined by an older migration is still recognized',
    expect: 'violation',
    mustReport: 'crxop_eq_eq_eq',
    sql: `SELECT 2 === 2;\n`,
  },
  {
    name: 'round-37: a custom operator inside an invoked wrapper is followed transitively',
    expect: 'violation',
    mustReport: 'operator_wrapper',
    sql:
      `CREATE FUNCTION public.operator_money_fix_2(integer, integer) RETURNS boolean LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.orders SET total_profit = total_profit; RETURN true; END $$;\n` +
      `CREATE OPERATOR <=> (PROCEDURE = public.operator_money_fix_2, LEFTARG = integer, RIGHTARG = integer);\n` +
      `CREATE FUNCTION public.operator_wrapper() RETURNS boolean LANGUAGE sql AS $$ SELECT 1 <=> 1 $$;\n` +
      `SELECT public.operator_wrapper();\n`,
  },
  {
    name: 'round-38: a custom cast invocation cannot hide its mutating backing routine',
    expect: 'violation',
    mustReport: 'cast_sink',
    sql:
      `CREATE TYPE public.cast_sink AS (v integer);\n` +
      `CREATE FUNCTION public.cast_money_fix(text) RETURNS public.cast_sink LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.orders SET total_profit = total_profit; RETURN ROW(1)::public.cast_sink; END $$;\n` +
      `CREATE CAST (text AS public.cast_sink) WITH FUNCTION public.cast_money_fix(text);\n` +
      `SELECT CAST('run'::text AS public.cast_sink);\n`,
  },
  {
    name: 'round-38 MUTANT: an uninvoked explicit custom cast definition remains deferred',
    expect: 'silent',
    sql:
      `CREATE TYPE public.cast_definition_only_sink AS (v integer);\n` +
      `CREATE FUNCTION public.cast_definition_only(text) RETURNS public.cast_definition_only_sink LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.orders SET total_profit = total_profit; RETURN ROW(1)::public.cast_definition_only_sink; END $$;\n` +
      `CREATE CAST (text AS public.cast_definition_only_sink) WITH FUNCTION public.cast_definition_only(text);\n`,
  },
  {
    name: 'round-38: a custom cast defined by an older migration is still recognized',
    expect: 'violation',
    mustReport: 'cast_sink',
    sql: `SELECT 'run'::text::public.cast_sink;\n`,
  },
  {
    name: 'round-38: a custom cast inside an invoked wrapper is followed transitively',
    expect: 'violation',
    mustReport: 'cast_wrapper',
    sql:
      `CREATE TYPE public.cast_sink_2 AS (v integer);\n` +
      `CREATE FUNCTION public.cast_money_fix_2(text) RETURNS public.cast_sink_2 LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.orders SET total_profit = total_profit; RETURN ROW(1)::public.cast_sink_2; END $$;\n` +
      `CREATE CAST (text AS public.cast_sink_2) WITH FUNCTION public.cast_money_fix_2(text);\n` +
      `CREATE FUNCTION public.cast_wrapper() RETURNS public.cast_sink_2 LANGUAGE sql ` +
      `AS $$ SELECT 'run'::text::public.cast_sink_2 $$;\n` +
      `SELECT public.cast_wrapper();\n`,
  },
  {
    name: 'round-45: domain coercion cannot hide a stored mutating CHECK expression',
    expect: 'violation',
    mustReport: 'money_checked_integer',
    sql:
      `CREATE FUNCTION public.domain_money_fix(integer) RETURNS boolean LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.orders SET total_profit = total_profit; RETURN true; END $$;\n` +
      `CREATE DOMAIN public.money_checked_integer AS integer CHECK (public.domain_money_fix(VALUE));\n` +
      `SELECT 1::public.money_checked_integer;\n`,
  },
  {
    name: 'round-45 MUTANT: an uninvoked domain definition remains deferred',
    expect: 'silent',
    sql:
      `CREATE FUNCTION public.domain_definition_only(integer) RETURNS boolean LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.orders SET total_profit = total_profit; RETURN true; END $$;\n` +
      `CREATE DOMAIN public.definition_only_domain AS integer CHECK (public.domain_definition_only(VALUE));\n`,
  },
  {
    name: 'round-45: a domain defined by another migration is still recognized',
    expect: 'violation',
    mustReport: 'money_checked_integer',
    sql: `SELECT CAST(1 AS public.money_checked_integer);\n`,
  },
  {
    name: 'round-53: ALTER DOMAIN ADD CHECK cannot hide an apply-time money mutator',
    expect: 'violation',
    mustReport: 'domain_alter_money_fix',
    sql:
      `CREATE FUNCTION public.domain_alter_money_fix(integer) RETURNS boolean LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.orders SET total_profit = total_profit; RETURN true; END $$;\n` +
      `ALTER DOMAIN public.existing_money_domain ADD CONSTRAINT current_money_ok ` +
      `CHECK (public.domain_alter_money_fix(VALUE));\n`,
  },
  {
    name: 'round-53 MUTANT: ALTER DOMAIN ADD CHECK NOT VALID remains deferred',
    expect: 'silent',
    sql:
      `CREATE FUNCTION public.domain_deferred_money_fix(integer) RETURNS boolean LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.orders SET total_profit = total_profit; RETURN true; END $$;\n` +
      `ALTER DOMAIN public.existing_money_domain ADD CONSTRAINT future_money_ok ` +
      `CHECK (public.domain_deferred_money_fix(VALUE)) NOT VALID;\n`,
  },
  {
    name: 'round-53: ALTER DOMAIN VALIDATE CONSTRAINT fails closed on its stored CHECK',
    expect: 'violation',
    sql: `ALTER DOMAIN public.existing_money_domain VALIDATE CONSTRAINT historical_money_ok;\n`,
  },
  {
    name: 'round-46: event-trigger DDL cannot hide a later database-wide money rewrite',
    expect: 'violation',
    mustReport: 'event-trigger DDL is unsupported',
    sql:
      `CREATE FUNCTION public.ddl_money_fix() RETURNS event_trigger LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.orders SET total_profit = total_profit; END $$;\n` +
      `CREATE EVENT TRIGGER ddl_money_replay ON ddl_command_end ` +
      `EXECUTE FUNCTION public.ddl_money_fix();\n` +
      `COMMENT ON TABLE public.order_items IS 'fires';\n`,
  },
  {
    name: 'round-46 MUTANT: an unattached event-trigger routine remains deferred',
    expect: 'silent',
    sql:
      `CREATE FUNCTION public.deferred_event_trigger_fn() RETURNS event_trigger LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.orders SET total_profit = total_profit; END $$;\n`,
  },
  {
    name: 'round-39: selecting a stored view cannot hide its resident mutating routine',
    expect: 'violation',
    mustReport: 'view_select_replay_bridge',
    sql:
      `CREATE VIEW public.replay_bridge AS SELECT public.existing_repair();\n` +
      `SELECT * FROM public.replay_bridge;\n`,
  },
  {
    name: 'round-39 MUTANT: defining but not selecting a view remains deferred',
    expect: 'silent',
    sql: `CREATE VIEW public.definition_only_bridge AS SELECT public.existing_repair();\n`,
  },
  {
    name: 'round-39: selecting a view defined by an older migration also fails closed',
    expect: 'violation',
    mustReport: 'view_select_replay_bridge',
    sql: `SELECT * FROM public.replay_bridge;\n`,
  },
  {
    name: 'round-65: CREATE TABLE AS TABLE cannot hide a stored-view money mutator',
    expect: 'violation',
    mustReport: 'view_select_round65_money_view',
    sql:
      `CREATE FUNCTION public.round65_ctas_fix() RETURNS integer LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.orders SET total_profit = total_profit; RETURN 1; END $$;\n` +
      `CREATE VIEW public.round65_money_view AS SELECT public.round65_ctas_fix() AS v;\n` +
      `CREATE TEMP TABLE round65_ctas_copy AS TABLE public.round65_money_view;\n`,
  },
  {
    name: 'round-65: INSERT DEFAULT VALUES cannot hide a stored column-default mutator',
    expect: 'violation',
    mustReport: 'round65_default_fix',
    sql:
      `CREATE FUNCTION public.round65_default_fix() RETURNS integer LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.orders SET total_profit = total_profit; RETURN 1; END $$;\n` +
      `CREATE TEMP TABLE round65_default_probe(` +
      `v integer DEFAULT public.round65_default_fix());\n` +
      `INSERT INTO round65_default_probe DEFAULT VALUES;\n`,
  },
  {
    name: 'round-65 MUTANT: defining a callable column default without inserting stays deferred',
    expect: 'silent',
    sql:
      `CREATE FUNCTION public.round65_deferred_default_fix() RETURNS integer LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.orders SET total_profit = total_profit; RETURN 1; END $$;\n` +
      `CREATE TEMP TABLE round65_deferred_default_probe(` +
      `v integer DEFAULT public.round65_deferred_default_fix());\n`,
  },
  {
    name: 'round-65: implicit assignment into a checked domain fails closed',
    expect: 'violation',
    sql:
      `CREATE FUNCTION public.round65_domain_fix(integer) RETURNS boolean LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.orders SET total_profit = total_profit; RETURN true; END $$;\n` +
      `CREATE DOMAIN public.round65_checked_integer AS integer ` +
      `CHECK (public.round65_domain_fix(VALUE));\n` +
      `CREATE TEMP TABLE round65_domain_probe(v public.round65_checked_integer);\n` +
      `INSERT INTO round65_domain_probe(v) VALUES (1);\n`,
  },
  {
    name: 'round-65 MUTANT: a checked-domain column without inserted rows stays deferred',
    expect: 'silent',
    sql:
      `CREATE FUNCTION public.round65_deferred_domain_fix(integer) RETURNS boolean LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.orders SET total_profit = total_profit; RETURN true; END $$;\n` +
      `CREATE DOMAIN public.round65_deferred_checked_integer AS integer ` +
      `CHECK (public.round65_deferred_domain_fix(VALUE));\n` +
      `CREATE TEMP TABLE round65_deferred_domain_probe(` +
      `v public.round65_deferred_checked_integer);\n`,
  },
  {
    name: 'round-66: a fired trigger WHEN expression cannot hide a money mutator',
    expect: 'violation',
    mustReport: 'round66_when_fix',
    sql:
      `CREATE FUNCTION public.round66_when_fix() RETURNS boolean LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.orders SET total_profit = total_profit; RETURN true; END $$;\n` +
      `CREATE FUNCTION public.round66_trigger_noop() RETURNS trigger LANGUAGE plpgsql AS $$\n` +
      `BEGIN RETURN NEW; END $$;\n` +
      `CREATE TEMP TABLE round66_scratch(id integer);\n` +
      `CREATE TRIGGER round66_fire AFTER INSERT ON round66_scratch FOR EACH ROW\n` +
      `WHEN (public.round66_when_fix()) ` +
      `EXECUTE FUNCTION public.round66_trigger_noop();\n` +
      `INSERT INTO round66_scratch(id) VALUES (1);\n`,
  },
  {
    name: 'round-66 MUTANT: an unfired trigger WHEN expression remains deferred',
    expect: 'silent',
    sql:
      `CREATE FUNCTION public.round66_deferred_when_fix() RETURNS boolean LANGUAGE plpgsql AS $$\n` +
      `BEGIN UPDATE public.orders SET total_profit = total_profit; RETURN true; END $$;\n` +
      `CREATE FUNCTION public.round66_deferred_noop() RETURNS trigger LANGUAGE plpgsql AS $$\n` +
      `BEGIN RETURN NEW; END $$;\n` +
      `CREATE TEMP TABLE round66_deferred_scratch(id integer);\n` +
      `CREATE TRIGGER round66_deferred AFTER INSERT ON round66_deferred_scratch FOR EACH ROW\n` +
      `WHEN (public.round66_deferred_when_fix()) ` +
      `EXECUTE FUNCTION public.round66_deferred_noop();\n`,
  },
  {
    name: 'round-67: an anonymous PL/V8 block cannot hide a money mutator',
    expect: 'violation',
    mustReport: 'Unsupported procedural-language body',
    sql:
      `CREATE EXTENSION IF NOT EXISTS plv8;\n` +
      `DO LANGUAGE plv8 $x$\n` +
      `plv8.execute('UP' + 'DATE public.order_items SET total_price = total_price');\n` +
      `$x$;\n`,
  },
  {
    name: 'round-67: invoking a PL/V8 routine cannot hide a money mutator',
    expect: 'violation',
    mustReport: 'Unsupported procedural-language body',
    sql:
      `CREATE FUNCTION public.round67_plv8_fix() RETURNS void LANGUAGE plv8 AS $x$\n` +
      `plv8.execute('UP' + 'DATE public.orders SET total_profit = total_profit');\n` +
      `$x$;\n` +
      `SELECT public.round67_plv8_fix();\n`,
  },
  {
    name: 'round-67 MUTANT: defining but not invoking a PL/V8 routine remains deferred',
    expect: 'silent',
    sql:
      `CREATE FUNCTION public.round67_deferred_plv8_fix() RETURNS void LANGUAGE plv8 AS $x$\n` +
      `plv8.execute('UP' + 'DATE public.orders SET total_profit = total_profit');\n` +
      `$x$;\n`,
  },
  {
    name: 'round-67: refreshing a materialized view fails closed on its stored query',
    expect: 'violation',
    mustReport: 'REFRESH MATERIALIZED VIEW executes a stored query',
    sql: `REFRESH MATERIALIZED VIEW public.repair_projection;\n`,
  },
  {
    name: 'round-55: FOREACH cannot replace the captured proof-variable population',
    expect: 'violation',
    mustReport: 'assigned or passed to a possibly OUT/INOUT procedure',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\n` +
      goodSetBlock().replace(
        `  UPDATE public.orders SET total_profit = 0 WHERE id = ANY(v_ids);`,
        `  FOREACH v_ids SLICE 1 IN ARRAY ARRAY[ARRAY['00000000-0000-0000-0000-000000000001'::uuid]] LOOP\n` +
          `    EXIT;\n  END LOOP;\n` +
          `  UPDATE public.orders SET total_profit = 0 WHERE id = ANY(v_ids);`,
      ) +
      `\n`,
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
 * A repair that satisfies every approved-set rule EXCEPT, possibly, the round-31
 * trigger fan-out one: captured id set, whole-row digest over those ids,
 * fail-closed comparison before the write, row-count assertion after it.
 *
 * The table is the only variable, which is what makes the fan-out cases
 * meaningful — a violation can then only be about what the triggers on that
 * table do, because nothing else about the fixture changed.
 *
 * @param {string} table the table being repaired
 * @param {string} col the column it assigns
 * @returns {string} the migration body
 */
function fanoutBlock(table, col) {
  return (
    `-- APPROVED_SET_DIGEST: ${HEX}\n` +
    `DO $$\nDECLARE v_ids uuid[]; actual text; n integer;\nBEGIN\n` +
    `  SELECT array_agg(s.id ORDER BY s.id) INTO v_ids\n` +
    `    FROM (SELECT id FROM public.${table} WHERE stale ORDER BY id FOR UPDATE) s;\n` +
    `  SELECT encode(digest(string_agg(o.id::text || ':' || to_jsonb(o.*)::text, ',' ORDER BY o.id), 'sha256'), 'hex')\n` +
    `    INTO actual FROM public.${table} o WHERE o.id = ANY(v_ids);\n` +
    `  IF actual IS DISTINCT FROM '${HEX}' THEN\n` +
    `    RAISE EXCEPTION 'APPROVED_SET_DRIFTED: %', actual;\n  END IF;\n` +
    `  UPDATE public.${table} SET ${col} = 0 WHERE id = ANY(v_ids);\n` +
    `  GET DIAGNOSTICS n = ROW_COUNT;\n` +
    `  IF n <> array_length(v_ids, 1) THEN\n` +
    `    RAISE EXCEPTION 'APPROVED_SET_COUNT: %', n;\n  END IF;\nEND $$;\n`
  );
}

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
  const res = runBash([SCRIPT, '--max-violations=999'], {
    cwd: dir,
    encoding: 'utf8',
    env: envWithoutGit(),
  });
  const out = `${res.stdout || ''}\n${res.stderr || ''}`;
  removeFixtureTree(dir);

  const got = classify(out, GRANDFATHERED);
  if (got === 'violation') return [];
  return [
    `  an edited grandfathered migration is back in force\n    expected violation, got ${got}`,
  ];
}

/**
 * ROUND 26 (Codex High). Both manifests the validator trusts — the approved-set
 * grandfather list and the sha256 audit exemptions — are ordinary tracked files
 * in the same repository as the migration being judged. On the changed-only
 * path, which runs with a ZERO violation baseline precisely so any finding is a
 * regression, that made them an unlocked door: add your own migration's
 * basename or hash and the scan waves it through. A gate the candidate can
 * widen is not a gate.
 *
 * Testing that directly is impossible from a fixture — the manifests resolve
 * from the SCRIPT's own directory, not the fixture's, so a test cannot write to
 * them without editing the real repo. It does not need to. The property under
 * test is that the changed-only scan ignores the manifest, and the real
 * manifest supplies a real entry: the same byte-exact grandfathered migration
 * that the full scan is required to stay silent about must be REPORTED when it
 * arrives as a change.
 *
 * The pairing is what makes this meaningful. Only the mode differs between the
 * two runs, so a regression in either direction fails: dropping the ignore
 * makes the changed-only run silent, and applying it too broadly makes the full
 * run violate.
 *
 * @returns {string[]} failure descriptions, empty when the guard behaved
 */
function runChangedOnlyIgnoresManifests() {
  const dir = mkdtempSync(join(tmpdir(), 'crx-approved-set-changed-'));
  const failures = [];
  // Never `git config --global` here, and never run git against the real
  // checkout: an earlier version of a sibling test set core.bare on the shared
  // repository and broke every session on the machine. Identity is passed per
  // invocation, and every path below is inside the temp directory.
  const git = (...args) =>
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: envWithoutGit(),
    });
  try {
    const migrations = join(dir, 'supabase', 'migrations');
    mkdirSync(migrations, { recursive: true });
    writeOneShotRegistry(dir, [GRANDFATHERED.replace(/\.sql$/, '')]);

    git('init');
    // An empty base commit, so the grandfathered migration below is entirely
    // new work on this branch — the exact shape of a candidate change.
    git('commit', '--allow-empty', '-m', 'base');
    const base = (git('rev-parse', 'HEAD').stdout || '').trim();
    if (!/^[0-9a-f]{7,}$/.test(base)) {
      return ['  changed-only manifest test could not create a git fixture — skipped nothing, FAILED'];
    }
    writeFileSync(join(migrations, GRANDFATHERED), GRANDFATHERED_BODY, 'utf8');

    const runScan = (extra) => {
      const res = runBash([SCRIPT, ...extra], { cwd: dir, encoding: 'utf8', env: envWithoutGit() });
      return `${res.stdout || ''}\n${res.stderr || ''}`;
    };

    // 1. Full scan: history is history, and the manifest silences it.
    const full = classify(runScan(['--max-violations=999']), GRANDFATHERED);
    if (full === 'violation') {
      failures.push(
        '  a grandfathered migration is still silent on a FULL scan\n' +
          `    expected no violation, got ${full}`,
      );
    }

    // 2. Changed-only scan: the same bytes, arriving as a change, are judged on
    //    their own merits. This is the assertion the round-26 fix exists for.
    const changedOut = runScan(['--changed-only', `--base=${base}`]);
    const changed = classify(changedOut, GRANDFATHERED);
    if (changed !== 'violation') {
      failures.push(
        '  round-26: a change may not exempt itself via the grandfather manifest\n' +
          `    expected violation on --changed-only, got ${changed}\n` +
          changedOut.split('\n').slice(0, 25).map((l) => `      | ${l}`).join('\n'),
      );
    }
    if (!changedOut.includes('changed-only scan ignores the grandfather')) {
      failures.push('  round-26: the changed-only scan does not say that it ignored the manifests');
    }

    // 3. And the fallback must NOT inherit the ignore. When the base ref is
    //    missing the flag stays set while the scan silently becomes a full one,
    //    and a full scan of all history without its baseline is thousands of
    //    unactionable violations — which is how a guard gets switched off.
    const fallback = runScan(['--changed-only', '--base=refs/heads/no-such-ref-here', '--max-violations=999']);
    if (!fallback.includes('running FULL scan instead')) {
      failures.push('  round-26: a missing base ref no longer falls back to a full scan');
    }
    if (fallback.includes('changed-only scan ignores the grandfather')) {
      failures.push('  round-26: the full-scan fallback wrongly dropped the manifests');
    }
    if (classify(fallback, GRANDFATHERED) === 'violation') {
      failures.push('  round-26: the full-scan fallback lost the grandfather manifest');
    }
  } finally {
    removeFixtureTree(dir);
  }
  return failures;
}

/**
 * ROUND 31 (Codex High), the half the cases above cannot reach: what the guard
 * does when the trigger fan-out manifest cannot answer.
 *
 * The manifest resolves from the SCRIPT's directory, so a fixture cannot vary
 * it — and must not try. A sibling test once wrote to shared state during a run
 * and left the machine broken; and a battery that dies mid-case would leave the
 * REAL manifest holding whatever the last mutation put in it, which is a
 * sabotaged guard that still looks green. So the script and the four files it
 * resolves beside itself are MIRRORED into a temp tree, and every mutation
 * happens to the copy. The repo is never written to.
 *
 * The property under test is that unknown means refused. A manifest that has
 * never heard of a table, one whose trigger body PostgreSQL stores parsed
 * rather than as source (BEGIN ATOMIC, so prosrc reads blank), a truncated
 * scan, and an unreadable file all mean the same thing: nobody can say what
 * fires on that table. Assuming "nothing" there is exactly the round-31 hole,
 * one level up.
 *
 * The last case is the mutant. With the fan-out emptied, the order_items attack
 * must SURVIVE — otherwise the four cases above prove nothing about this gate,
 * only that something somewhere objected.
 *
 * @returns {string[]} failure descriptions, empty when the guard behaved
 */
function runTriggerFanoutFailsClosed() {
  const root = mkdtempSync(join(tmpdir(), 'crx-fanout-manifest-'));
  const failures = [];
  try {
    const mirror = join(root, 'scripts');
    mkdirSync(mirror, { recursive: true });
    mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });
    for (const f of ['validate-sql-migrations.sh', 'check-trigger-fanout-staleness.mjs',
                     'find-unsupported-routine-identities.mjs',
                     'approved-set-grandfathered.txt',
                     'sql-audit-hash-exemptions.txt', 'trigger-fanout.json']) {
      copyFileSync(join(HERE, f), join(mirror, f));
    }
    copyFileSync(
      join(HERE, '..', '.claude', 'hooks', 'apply-time-dml-lib.mjs'),
      join(root, '.claude', 'hooks', 'apply-time-dml-lib.mjs'),
    );
    copyFileSync(
      join(HERE, '..', '.claude', 'schema-registry.json'),
      join(root, '.claude', 'schema-registry.json'),
    );
    const mirroredScript = join(mirror, 'validate-sql-migrations.sh');
    const manifestPath = join(mirror, 'trigger-fanout.json');
    const live = JSON.parse(readFileSync(manifestPath, 'utf8'));

    const runWith = (manifest, sql) => {
      const dir = mkdtempSync(join(tmpdir(), 'crx-fanout-case-'));
      try {
        mkdirSync(join(dir, 'supabase', 'migrations'), { recursive: true });
        const name = `${IN_FORCE}999999_fanout.sql`;
        writeFileSync(join(dir, 'supabase', 'migrations', name), sql, 'utf8');
        writeOneShotRegistry(dir, [name.replace(/\.sql$/, '')]);
        writeFileSync(manifestPath, manifest, 'utf8');
        const res = runBash([mirroredScript, '--max-violations=999'], {
          cwd: dir, encoding: 'utf8', env: envWithoutGit(),
        });
        return { out: `${res.stdout || ''}\n${res.stderr || ''}`, name };
      } finally {
        removeFixtureTree(dir);
      }
    };

    const expect = (label, manifest, sql, wanted) => {
      const { out, name } = runWith(manifest, sql);
      const got = classify(out, name);
      if (wanted === null) {
        if (got === 'violation') {
          failures.push(`  round-31 ${label}\n    expected no violation, got ${got}\n` +
            blockFor(out, name).split('\n').map((l) => `      | ${l}`).join('\n'));
        }
        return;
      }
      if (got !== 'violation' || !blockFor(out, name).includes(wanted)) {
        failures.push(`  round-31 ${label}\n    expected a violation saying ${JSON.stringify(wanted)}, got ${got}\n` +
          blockFor(out, name).split('\n').map((l) => `      | ${l}`).join('\n'));
      }
    };

    const json = (o) => `${JSON.stringify(o, null, 2)}\n`;
    const orders = fanoutBlock('orders', 'total_profit');

    const unsafeEvent = structuredClone(live);
    unsafeEvent.event_triggers = [{
      ...unsafeEvent.event_triggers[0],
      effect: {
        dynamic_write_count: 0,
        safe: false,
        session_catalog_required: false,
        tables: [],
        targets: [],
        unknown_calls: ['resident_unknown_effect'],
        unresolved: false,
        unsupported_routine_identity: false,
      },
      enabled: true,
      enabled_mode: 'O',
      name: 'resident_ddl_money_replay',
    }];
    const unsafeResult = runWith(json(unsafeEvent), "COMMENT ON TABLE public.orders IS 'fires';\n");
    if (!unsafeResult.out.includes('Enabled PostgreSQL event trigger(s) make migration DDL effects unbounded')) {
      failures.push('  round-46 enabled live event trigger without no-write proof was not globally refused');
    }

    const conditionalEvent = structuredClone(live);
    conditionalEvent.event_triggers = [{
      ...conditionalEvent.event_triggers[0],
      effect: {
        dynamic_write_count: 0,
        safe: false,
        session_catalog_required: true,
        tables: [],
        targets: [],
        unknown_calls: [],
        unresolved: false,
        unsupported_routine_identity: false,
      },
      enabled: true,
      enabled_mode: 'O',
      name: 'resident_unpinned_ddl_metadata_watch',
      routine_config: [],
    }];
    expect('a session-dependent event helper refuses search_path-changing DDL',
      json(conditionalEvent),
      "SET LOCAL search_path = public, pg_catalog; COMMENT ON TABLE public.orders IS 'fires';\n",
      'Session-dependent PostgreSQL event trigger helper');

    if (!live.fanout?.fields?.some((r) =>
      r.target === 'field_crop_history' && r.via === 'snapshot_field_crop_history')) {
      failures.push('  round-32 live fan-out is missing fields -> field_crop_history via snapshot_field_crop_history');
    }

    const visibleFields = structuredClone(live);
    visibleFields.opaque_on_tables = visibleFields.opaque_on_tables.filter((t) => t !== 'fields');
    expect('an UPSERT conflict arm in a fields trigger binds field_crop_history',
      json(visibleFields), fanoutBlock('fields', 'crop_type'), 'field_crop_history');

    const visibleOrderItems = structuredClone(live);
    visibleOrderItems.opaque_on_tables = visibleOrderItems.opaque_on_tables.filter((t) => t !== 'order_items');
    const orderItemInsert =
      `INSERT INTO public.order_items (id) VALUES ('00000000-0000-0000-0000-000000000001');\n`;
    expect('a plain order_items INSERT follows the checked-in trigger edge into orders',
      json(visibleOrderItems), orderItemInsert, 'trigger trg_recalc_order_totals on order_items');

    const insertFanoutMutant = structuredClone(visibleOrderItems);
    insertFanoutMutant.fanout.order_items = [];
    expect('MUTANT: removing the order_items live edge lets the plain INSERT survive',
      json(insertFanoutMutant), orderItemInsert, null);

    const unscanned = structuredClone(live);
    unscanned.tables_scanned = unscanned.tables_scanned.filter((t) => t !== 'orders');
    delete unscanned.fanout.order_items;
    expect('a table missing from the manifest is refused, not assumed clean',
      json(unscanned), orders, 'does not cover orders');

    const opaque = structuredClone(live);
    opaque.opaque_on_tables = ['orders'];
    expect('a trigger body PostgreSQL will not show us is refused',
      json(opaque), orders, 'does not cover orders');

    const truncated = structuredClone(live);
    truncated.tables_scanned = truncated.tables_scanned.slice(0, 20);
    expect('a truncated scan is rejected rather than trusted',
      json(truncated), orders, 'does not cover orders');

    expect('an unreadable manifest refuses every table',
      'not json at all\n', orders, 'does not cover orders');

    const persistedCheck = structuredClone(live);
    persistedCheck.opaque_on_tables = persistedCheck.opaque_on_tables.filter(
      (table) => table !== 'accounting_periods',
    );
    persistedCheck.check_constraints = [{
      oid: '99101',
      name: 'accounting_periods_custom_check',
      relation: 'accounting_periods',
      routine_oid: '99102',
      routine_schema: 'public',
      routine_name: 'accounting_periods_check_fn',
      definition_hash: 'c'.repeat(64),
    }];
    const checkInsert = 'INSERT INTO public.accounting_periods(id) VALUES (1);\n';
    expect('a persisted custom CHECK routine keeps its write relation opaque',
      json(persistedCheck), checkInsert, 'does not cover accounting_periods');

    persistedCheck.check_constraints = [];
    expect('MUTANT: removing the CHECK dependency lets the unrelated INSERT survive',
      json(persistedCheck), checkInsert, null);

    const gutted = structuredClone(live);
    // Keep every captured source identity (including auth.users) so the
    // manifest remains structurally valid; remove only its effects. Otherwise
    // the fail-closed provenance check, rather than the missing edge, wins.
    gutted.fanout = Object.fromEntries(
      Object.keys(live.fanout).map((source) => [source, []]),
    );
    gutted.opaque_on_tables = [];
    expect('MUTANT: with the fan-out emptied the order_items attack survives',
      json(gutted), fanoutBlock('order_items', 'total_price'), null);
  } finally {
    removeFixtureTree(root);
  }
  return failures;
}

/**
 * A trigger helper can change the live graph without changing its table count,
 * and an unrelated graph edit is not evidence for that helper. The changed-only
 * path must bind the changed routine to each exact source that transitively
 * depends on it.
 *
 * @returns {string[]} failure descriptions, empty when the guard behaved
 */
function runTriggerDefinitionRequiresFanoutRefresh() {
  const dir = mkdtempSync(join(tmpdir(), 'crx-trigger-staleness-'));
  const failures = [];
  try {
    mkdirSync(join(dir, 'supabase', 'migrations'), { recursive: true });
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'supabase', 'migrations', '20200101000000_base.sql'), '-- base\n', 'utf8');
    const manifestPath = join(dir, 'scripts', 'trigger-fanout.json');
    const baseManifest = JSON.parse(readFileSync(join(HERE, 'trigger-fanout.json'), 'utf8'));
    const noChanges = {
      changedRoutines: new Set(), changedRoutineIdentities: new Set(),
      changedTriggerRoutines: new Set(), triggerTables: new Set(),
      foreignKeyParents: new Set(), unparsedTriggerDefinition: false,
      eventTriggerChange: false, unparsedRoutineDefinition: false,
      unparsedForeignKeyDefinition: false,
    };
    const guttedInitial = structuredClone(baseManifest);
    guttedInitial.fanout = {};
    guttedInitial.opaque_on_tables = [];
    guttedInitial.reachable_routines = {};
    guttedInitial.routine_hashes = {};
    const initialStale = staleTriggerSources({}, guttedInitial, noChanges);
    if (!initialStale.length || !initialStale.includes(guttedInitial.tables_scanned[0])) {
      failures.push('  round-35 an incomplete first fan-out trust root was not rejected');
    }
    const opaqueInitial = structuredClone(guttedInitial);
    opaqueInitial.opaque_on_tables = [...opaqueInitial.tables_scanned];
    if (staleTriggerSources({}, opaqueInitial, noChanges).length) {
      failures.push('  round-35 an all-opaque first fan-out trust root did not fail closed cleanly');
    }
    const removedRule = structuredClone(baseManifest);
    removedRule.rules = removedRule.rules.slice(1);
    if (!staleTriggerSources(baseManifest, removedRule, noChanges)
      .includes('__rewrite_rule_state_changed__')) {
      failures.push('  round-57 removing captured rewrite-rule evidence was not rejected');
    }
    const checkBase = structuredClone(baseManifest);
    checkBase.check_constraints = [{
      oid: '99101',
      name: 'accounting_periods_custom_check',
      relation: 'accounting_periods',
      routine_oid: '99102',
      routine_schema: 'public',
      routine_name: 'accounting_periods_check_fn',
      definition_hash: 'c'.repeat(64),
    }];
    const removedCheck = structuredClone(checkBase);
    removedCheck.check_constraints = [];
    if (!staleTriggerSources(checkBase, removedCheck, noChanges)
      .includes('__check_constraint_state_changed__')) {
      failures.push('  round-61 removing captured CHECK-routine evidence was not rejected');
    }
    checkBase.opaque_on_tables = checkBase.opaque_on_tables.filter(
      (table) => table !== 'accounting_periods',
    );
    const changedCheckRoutine = {
      ...noChanges,
      changedRoutineIdentities: new Set(['public\0accounting_periods_check_fn']),
    };
    if (!staleTriggerSources(checkBase, checkBase, changedCheckRoutine)
      .includes('accounting_periods')) {
      failures.push('  round-61 changing a captured CHECK routine did not stale its relation');
    }
    // This fixture has a committed base manifest, so it is testing ordinary
    // post-bootstrap weakening/refresh behavior rather than the all-opaque
    // first-trust-root rule exercised immediately above.
    baseManifest.opaque_on_tables = [];
    baseManifest.reachable_routines.orders = [
      ...new Set([...(baseManifest.reachable_routines.orders || []), 'ordinary_helper']),
    ].sort();
    baseManifest.routine_hashes.ordinary_helper = 'a'.repeat(64);
    writeFileSync(manifestPath, `${JSON.stringify(baseManifest, null, 2)}\n`, 'utf8');

    const git = (args) => spawnSync('git', args, {
      cwd: dir, encoding: 'utf8', env: envWithoutGit(),
    });
    if (git(['init', '-q']).status !== 0 ||
        git(['config', 'user.email', 'test@example.com']).status !== 0 ||
        git(['config', 'user.name', 'test']).status !== 0 ||
        git(['add', '.']).status !== 0 ||
        git(['commit', '-qm', 'base']).status !== 0) {
      return ['  round-32 trigger staleness test could not create a git fixture'];
    }
    const base = git(['rev-parse', 'HEAD']).stdout.trim();
    writeFileSync(
      join(dir, 'supabase', 'migrations', '20200102000000_trigger.sql'),
      `CREATE OR REPLACE FUNCTION public."ordinary_helper"() RETURNS void LANGUAGE plpgsql AS $$ BEGIN NULL; END $$;\n` +
        `CREATE FUNCTION public.t32() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;\n` +
        `CREATE TRIGGER t32 BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.t32();\n`,
      'utf8',
    );
    const unrelated = JSON.parse(readFileSync(manifestPath, 'utf8'));
    (unrelated.fanout.customers ??= []).push({ target: 'orders', via: 'ordinary_helper' });
    unrelated.routine_hashes.ordinary_helper = 'b'.repeat(64);
    writeFileSync(manifestPath, `${JSON.stringify(unrelated, null, 2)}\n`, 'utf8');
    const stale = runBash([SCRIPT, '--changed-only', `--base=${base}`, '--max-violations=999'], {
      cwd: dir, encoding: 'utf8', env: envWithoutGit(),
    });
    const staleOut = `${stale.stdout || ''}\n${stale.stderr || ''}`;
    if (!staleOut.includes('Trigger fan-out evidence is stale for affected source(s): orders')) {
      const direct = spawnSync(process.execPath, [
        join(HERE, 'check-trigger-fanout-staleness.mjs'),
        base,
        'scripts/trigger-fanout.json',
        'supabase/migrations/20200102000000_trigger.sql',
      ], { cwd: dir, encoding: 'utf8', env: envWithoutGit() });
      failures.push(
        '  round-33 helper change with only an unrelated fan-out edit was not rejected\n' +
        `      direct helper: status=${direct.status} stdout=${JSON.stringify(direct.stdout)} stderr=${JSON.stringify(direct.stderr)}\n` +
        staleOut.split('\n').map((line) => `      | ${line}`).join('\n'),
      );
    }

    const refreshed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    refreshed.opaque_on_tables = [...new Set([...(refreshed.opaque_on_tables || []), 'orders'])].sort();
    writeFileSync(manifestPath, `${JSON.stringify(refreshed, null, 2)}\n`, 'utf8');
    const guarded = runBash([SCRIPT, '--changed-only', `--base=${base}`, '--max-violations=999'], {
      cwd: dir, encoding: 'utf8', env: envWithoutGit(),
    });
    const guardedOut = `${guarded.stdout || ''}\n${guarded.stderr || ''}`;
    if (guardedOut.includes('Trigger fan-out evidence is stale for affected source(s)')) {
      failures.push('  round-33 exact affected-source opacity was still classified as stale');
    }

    // An FK cascade is a graph input even when no trigger or routine changes.
    // The parent relation is the source whose DELETE/UPDATE can fan out.
    writeFileSync(
      join(dir, 'supabase', 'migrations', '20200102000000_trigger.sql'),
      'ALTER TABLE public.child_row ADD CONSTRAINT child_parent_fk ' +
        'FOREIGN KEY (parent_id) REFERENCES public."quoted_parent"(id) ON DELETE CASCADE;\n',
      'utf8',
    );
    const fkStale = runBash([SCRIPT, '--changed-only', `--base=${base}`], {
      cwd: dir, encoding: 'utf8', env: envWithoutGit(),
    });
    const fkOut = `${fkStale.stdout || ''}\n${fkStale.stderr || ''}`;
    if (!fkOut.includes('Trigger fan-out evidence is stale for affected source(s): quoted_parent')) {
      failures.push('  round-34 FK-only fan-out change did not refuse the affected parent source');
    }

    const fkGuarded = JSON.parse(readFileSync(manifestPath, 'utf8'));
    fkGuarded.opaque_on_tables = [
      ...new Set([...(fkGuarded.opaque_on_tables || []), 'quoted_parent']),
    ].sort();
    writeFileSync(manifestPath, `${JSON.stringify(fkGuarded, null, 2)}\n`, 'utf8');
    const fkSafe = runBash([SCRIPT, '--changed-only', `--base=${base}`], {
      cwd: dir, encoding: 'utf8', env: envWithoutGit(),
    });
    if (`${fkSafe.stdout || ''}\n${fkSafe.stderr || ''}`.includes(
      'Trigger fan-out evidence is stale for affected source(s): quoted_parent')) {
      failures.push('  round-34 FK parent opacity was still classified as stale');
    }

    // Event triggers have no source table. Any definition/change is a global
    // graph input and must remain stale even if every table source is opaque.
    writeFileSync(
      join(dir, 'supabase', 'migrations', '20200102000000_trigger.sql'),
      'CREATE EVENT TRIGGER ddl_probe ON ddl_command_end EXECUTE FUNCTION public.ddl_probe();\n',
      'utf8',
    );
    const eventStale = runBash([SCRIPT, '--changed-only', `--base=${base}`], {
      cwd: dir, encoding: 'utf8', env: envWithoutGit(),
    });
    const eventOut = `${eventStale.stdout || ''}\n${eventStale.stderr || ''}`;
    if (!eventOut.includes('Trigger fan-out evidence is stale for affected source(s): __event_trigger_change__')) {
      failures.push('  round-46 event-trigger DDL was not treated as a global stale graph input');
    }

    // Replacing the routine behind an existing enabled event trigger changes
    // database-wide behavior without spelling CREATE/ALTER EVENT TRIGGER. Bind
    // the changed schema/name against the captured OID/hash identity instead of
    // trusting the old body evidence.
    const extensionEvent = (baseManifest.event_triggers || []).find((trigger) =>
      trigger.enabled && trigger.routine_schema === 'extensions');
    if (!extensionEvent) {
      failures.push('  round-50 fixture has no enabled extensions event-trigger routine');
    } else {
      writeFileSync(
        join(dir, 'supabase', 'migrations', '20200102000000_trigger.sql'),
        `CREATE OR REPLACE FUNCTION "${extensionEvent.routine_schema}".` +
          `"${extensionEvent.routine_name}"() RETURNS event_trigger LANGUAGE plpgsql AS $$ ` +
          `BEGIN UPDATE public.orders SET total_profit = total_profit; END $$;\n`,
        'utf8',
      );
      const routineStale = runBash([SCRIPT, '--changed-only', `--base=${base}`], {
        cwd: dir, encoding: 'utf8', env: envWithoutGit(),
      });
      const routineOut = `${routineStale.stdout || ''}\n${routineStale.stderr || ''}`;
      if (!routineOut.includes(
        'Trigger fan-out evidence is stale for affected source(s): __event_trigger_routine_changed__')) {
        failures.push('  round-50 enabled extensions event-trigger routine replacement did not stale the bound capture');
      }

      writeFileSync(
        join(dir, 'supabase', 'migrations', '20200102000000_trigger.sql'),
        'CREATE OR REPLACE FUNCTION extensions.unrelated_helper() RETURNS void ' +
          'LANGUAGE plpgsql AS $$ BEGIN NULL; END $$;\n',
        'utf8',
      );
      const unrelatedEvent = runBash([SCRIPT, '--changed-only', `--base=${base}`], {
        cwd: dir, encoding: 'utf8', env: envWithoutGit(),
      });
      if (`${unrelatedEvent.stdout || ''}\n${unrelatedEvent.stderr || ''}`.includes(
        '__event_trigger_routine_changed__')) {
        failures.push('  round-50 unrelated extensions routine was confused with the captured event routine');
      }
    }

    // Candidate-authored evidence may add detail, but it may not silently erase
    // an edge captured in the base manifest. This must run even with no SQL graph
    // input in the changed migration.
    const weakened = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const removable = Object.entries(baseManifest.fanout || {}).find(
      ([source, edges]) => (edges || []).length > 0 && !(weakened.opaque_on_tables || []).includes(source),
    );
    if (!removable) {
      failures.push('  round-34 fixture had no non-opaque fan-out edge to remove');
    } else {
      const [source] = removable;
      weakened.fanout[source] = (weakened.fanout[source] || []).slice(1);
      writeFileSync(manifestPath, `${JSON.stringify(weakened, null, 2)}\n`, 'utf8');
      writeFileSync(
        join(dir, 'supabase', 'migrations', '20200102000000_trigger.sql'),
        '-- no trigger, routine, or FK input\n',
        'utf8',
      );
      const edgeStale = runBash([SCRIPT, '--changed-only', `--base=${base}`], {
        cwd: dir, encoding: 'utf8', env: envWithoutGit(),
      });
      const edgeOut = `${edgeStale.stdout || ''}\n${edgeStale.stderr || ''}`;
      if (!edgeOut.includes(`Trigger fan-out evidence is stale for affected source(s): ${source}`)) {
        failures.push(`  round-34 removing base fan-out edge for ${source} was not rejected`);
      }
    }

    // Reject unsafe filenames before the historical word-list loops can split
    // them into nonexistent paths and accidentally scan zero SQL.
    const unsafePath = join(dir, 'supabase', 'migrations', '20200103000000_bad name.sql');
    writeFileSync(unsafePath, 'UPDATE public.orders SET total_profit = 0;\n', 'utf8');
    const unsafe = runBash([SCRIPT, '--changed-only', `--base=${base}`], {
      cwd: dir, encoding: 'utf8', env: envWithoutGit(),
    });
    const unsafeOut = `${unsafe.stdout || ''}\n${unsafe.stderr || ''}`;
    if (unsafe.status === 0 || !unsafeOut.includes('Unsafe migration filename: whitespace is not allowed')) {
      failures.push('  round-34 whitespace migration filename was not rejected before scanning');
    }
    rmSync(unsafePath, { force: true });

    // Git C-quotes non-ASCII paths by default. Before the round-38 fix the
    // quoted display spelling failed `-f`, so changed-only validation scanned
    // zero SQL and an unsafe rewrite could consume aggregate-baseline headroom.
    // The strict ASCII migration convention must reject it before that skip.
    const cQuotedPath = join(dir, 'supabase', 'migrations', '20200104000000_bad-é.sql');
    writeFileSync(cQuotedPath, 'UPDATE public.orders SET total_profit = 0;\n', 'utf8');
    const cQuoted = runBash([SCRIPT, '--changed-only', `--base=${base}`], {
      cwd: dir, encoding: 'utf8', env: envWithoutGit(),
    });
    const cQuotedOut = `${cQuoted.stdout || ''}\n${cQuoted.stderr || ''}`;
    if (cQuoted.status === 0 || !cQuotedOut.includes('names must match <8-or-14-digit timestamp>')) {
      failures.push('  round-38 Git-C-quoted migration filename was not rejected before scanning');
    }
    rmSync(cQuotedPath, { force: true });
  } finally {
    removeFixtureTree(dir);
  }
  return failures;
}

/**
 * PR #364 introduces a bootstrap fan-out artifact that deliberately marks all
 * captured sources opaque until an independent attestation exists. Three
 * immutable migrations already present on origin/main and in the linked live
 * ledger therefore gain one new historical finding each. Their acknowledgments
 * must stay exact-byte pins: a valid pin restores the aggregate baseline, while
 * changing even one byte must immediately put that finding back in force.
 *
 * @returns {string[]} failure descriptions, empty when both properties hold
 */
function runBootstrapFanoutHashPins() {
  const root = mkdtempSync(join(tmpdir(), 'crx-bootstrap-fanout-pins-'));
  const failures = [];
  const files = [
    '20260812115236_quote_items_cost_at_quote_snapshot.sql',
    '20260812115237_enforce_below_cost_admin_approval.sql',
    '20260812115238_repair_historical_order_line_cents.sql',
  ];
  const supportFiles = [
    // Later definitions are part of the repository-wide routine identity for
    // the 20260812115237 call. Without them an isolated fixture would erase the
    // very ambiguity the full CI audit acknowledges.
    '20260816110000_draw_down_cutover_barrier.sql',
    '20260816120000_draw_down_split_order_lines_by_price_tier.sql',
  ];
  try {
    const scripts = join(root, 'scripts');
    const migrations = join(root, 'supabase', 'migrations');
    const baselines = join(root, 'supabase', 'baselines');
    mkdirSync(scripts, { recursive: true });
    mkdirSync(migrations, { recursive: true });
    mkdirSync(baselines, { recursive: true });
    mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });

    for (const file of [
      'validate-sql-migrations.sh',
      'check-trigger-fanout-staleness.mjs',
      'find-unsupported-routine-identities.mjs',
      'approved-set-grandfathered.txt',
      'sql-audit-hash-exemptions.txt',
      'trigger-fanout.json',
    ]) {
      copyFileSync(join(HERE, file), join(scripts, file));
    }
    copyFileSync(
      join(HERE, '..', '.claude', 'hooks', 'apply-time-dml-lib.mjs'),
      join(root, '.claude', 'hooks', 'apply-time-dml-lib.mjs'),
    );
    copyFileSync(
      join(HERE, '..', '.claude', 'schema-registry.json'),
      join(root, '.claude', 'schema-registry.json'),
    );
    copyFileSync(
      join(HERE, '..', 'supabase', 'baselines', 'one-shot-migrations.json'),
      join(baselines, 'one-shot-migrations.json'),
    );
    for (const file of [...files, ...supportFiles]) {
      copyFileSync(join(HERE, '..', 'supabase', 'migrations', file), join(migrations, file));
    }

    const isolatedScript = join(scripts, 'validate-sql-migrations.sh');
    const scan = () => {
      const result = runBash([isolatedScript, '--max-violations=0'], {
        cwd: root,
        encoding: 'utf8',
        env: envWithoutGit(),
      });
      return { result, out: `${result.stdout || ''}\n${result.stderr || ''}` };
    };

    const pinned = scan();
    if (pinned.result.status !== 0) {
      failures.push(
        '  bootstrap fan-out findings are not reconciled by exact hash pins\n' +
          pinned.out.split('\n').slice(-30).map((line) => `      | ${line}`).join('\n'),
      );
    }
    for (const file of files) {
      if (!pinned.out.includes(`above in ${file} are hash-pinned`)) {
        const related = pinned.out.split('\n').filter((line) => line.includes(file));
        failures.push(
          `  bootstrap fan-out pin was not consumed for ${file}\n` +
            related.map((line) => `      | ${line}`).join('\n'),
        );
      }
    }

    const mutated = join(migrations, files[0]);
    writeFileSync(mutated, `${readFileSync(mutated, 'utf8')}\n-- mutation voids the exact-byte pin\n`, 'utf8');
    const voided = scan();
    if (voided.result.status === 0 ||
        !voided.out.includes(`VIOLATION: supabase/migrations/${files[0]}`) ||
        !voided.out.includes('Violation count (1) exceeds baseline (0)')) {
      failures.push('  changing one byte did not void the bootstrap fan-out hash pin');
    }
  } finally {
    removeFixtureTree(root);
  }
  return failures;
}

function runPersistedRuleAcrossMigrations() {
  const dir = mkdtempSync(join(tmpdir(), 'crx-persisted-rule-'));
  const failures = [];
  const git = (...args) =>
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: envWithoutGit(),
    });
  try {
    const migrations = join(dir, 'supabase', 'migrations');
    mkdirSync(migrations, { recursive: true });
    writeFileSync(
      join(migrations, '29980101000000_install_rule.sql'),
      'CREATE TABLE public.persisted_rule_probe(id integer);\n' +
        'CREATE RULE persisted_repair AS ON UPDATE TO public.persisted_rule_probe ' +
        'DO ALSO SELECT public.existing_repair();\n',
    );
    git('init');
    git('add', '.');
    git('commit', '-m', 'base with persisted rule');
    const base = (git('rev-parse', 'HEAD').stdout || '').trim();
    const candidate = '29980101000001_fire_persisted_rule.sql';
    writeFileSync(
      join(migrations, candidate),
      'CREATE RULE local_repair AS ON UPDATE TO public.persisted_rule_probe DO ALSO SELECT 1;\n' +
        'UPDATE public.persisted_rule_probe SET id = id;\n',
    );
    const result = runBash([SCRIPT, '--changed-only', `--base=${base}`], {
      cwd: dir,
      encoding: 'utf8',
      env: envWithoutGit(),
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    const block = blockFor(output, candidate);
    if (classify(output, candidate) !== 'violation' ||
        !block.includes('rewrite rule installed by an earlier migration')) {
      failures.push(
        '  round-64: a local rule masked an earlier rule on the same relation/event\n' +
          block.split('\n').map((line) => `      | ${line}`).join('\n'),
      );
    }

    const manifest = JSON.parse(readFileSync(join(HERE, 'trigger-fanout.json'), 'utf8'));
    const liveSelectRule = (manifest.rules || []).find((rule) => rule.event === 'select');
    if (!liveSelectRule) {
      failures.push('  round-57: checked-in linked manifest contains no SELECT rule fixture');
    } else {
      const liveCandidate = '29980101000002_fire_live_rule.sql';
      const liveRelation = liveSelectRule.relation.includes('.')
        ? liveSelectRule.relation
        : `public.${liveSelectRule.relation}`;
      const liveBareRelation = liveSelectRule.relation.split('.').pop();
      writeFileSync(
        join(migrations, liveCandidate),
        `SELECT * FROM ${liveRelation};\n`,
      );
      const liveResult = runBash([SCRIPT, '--changed-only', `--base=${base}`], {
        cwd: dir,
        encoding: 'utf8',
        env: envWithoutGit(),
      });
      const liveOutput = `${liveResult.stdout || ''}\n${liveResult.stderr || ''}`;
      const liveBlock = blockFor(liveOutput, liveCandidate);
      if (classify(liveOutput, liveCandidate) !== 'violation' ||
          !liveBlock.includes(`rule_on_select_${liveBareRelation}`)) {
        failures.push(
          '  round-57: changed-only validation ignored a linked-live rewrite rule\n' +
            liveBlock.split('\n').map((line) => `      | ${line}`).join('\n'),
        );
      }
    }
  } finally {
    removeFixtureTree(dir);
  }
  return failures;
}

function run() {
  const dir = mkdtempSync(join(tmpdir(), 'crx-approved-set-'));
  const migrations = join(dir, 'supabase', 'migrations');
  mkdirSync(migrations, { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, '.claude', 'hooks'), { recursive: true });
  for (const file of ['validate-sql-migrations.sh', 'check-trigger-fanout-staleness.mjs',
                      'find-unsupported-routine-identities.mjs',
                      'approved-set-grandfathered.txt',
                      'sql-audit-hash-exemptions.txt']) {
    copyFileSync(join(HERE, file), join(dir, 'scripts', file));
  }
  copyFileSync(
    join(HERE, '..', '.claude', 'hooks', 'apply-time-dml-lib.mjs'),
    join(dir, '.claude', 'hooks', 'apply-time-dml-lib.mjs'),
  );
  copyFileSync(
    join(HERE, '..', '.claude', 'schema-registry.json'),
    join(dir, '.claude', 'schema-registry.json'),
  );
  // The main battery tests approved-set identity mechanics, not catalog fan-out.
  // Give it a complete, provenance-valid but no-cascade manifest so a newly
  // discovered live FK or opaque trigger cannot shadow the rule each case is
  // trying to mutate. Dedicated round-31/33 fixtures below attack fan-out itself.
  const isolatedManifest = JSON.parse(readFileSync(join(HERE, 'trigger-fanout.json'), 'utf8'));
  isolatedManifest.opaque_on_tables = [];
  isolatedManifest.fanout = {
    'auth.users': [
      { target: 'profiles', via: 'foreign_key_auth_users_profiles' },
    ],
    products: [
      { target: 'cost_history', via: 'write_product_pricing_history' },
      { target: 'product_cost_basis', via: 'guard_product_cost_basis_unit_change' },
      { target: 'product_cost_basis', via: 'sync_legacy_product_cost_basis' },
    ],
  };
  writeFileSync(
    join(dir, 'scripts', 'trigger-fanout.json'),
    `${JSON.stringify(isolatedManifest, null, 2)}\n`,
    'utf8',
  );
  const isolatedScript = join(dir, 'scripts', 'validate-sql-migrations.sh');

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

  const res = runBash([isolatedScript, '--max-violations=999'], {
    cwd: dir,
    encoding: 'utf8',
    env: envWithoutGit(),
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

  removeFixtureTree(dir);
  failures.push(...runEditedGrandfather());
  failures.push(...runChangedOnlyIgnoresManifests());
  failures.push(...runTriggerFanoutFailsClosed());
  failures.push(...runTriggerDefinitionRequiresFanoutRefresh());
  failures.push(...runBootstrapFanoutHashPins());
  failures.push(...runPersistedRuleAcrossMigrations());

  if (failures.length > 0) {
    console.error(`❌ approved-set guard: ${failures.length} case(s) behaved wrong\n`);
    console.error(failures.join('\n'));
    console.error('\n--- validator output ---\n');
    console.error(out);
    process.exit(1);
  }
  console.log(`✅ approved-set guard: ${CASES.length + 20} mutation cases behaved correctly`);
}

if (process.argv.includes('--bootstrap-pins-only')) {
  const failures = runBootstrapFanoutHashPins();
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log('✅ bootstrap fan-out hash-pin mutations behaved correctly');
} else if (process.argv.includes('--staleness-only')) {
  const failures = runTriggerDefinitionRequiresFanoutRefresh();
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log('✅ trigger fan-out staleness mutations behaved correctly');
} else if (process.argv.includes('--persisted-rule-only')) {
  const failures = runPersistedRuleAcrossMigrations();
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log('✅ persisted rewrite-rule cross-migration mutation behaved correctly');
} else {
  run();
}
