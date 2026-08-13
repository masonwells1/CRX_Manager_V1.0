#!/usr/bin/env node
// Tests for apply-time-dml-lib.mjs — the module that answers "what does this
// migration WRITE when it applies?" for migration-apply-guard.mjs.
//
// Two failure directions matter and they are not symmetric:
//   - MISSING a write is a money incident: a repair replays unnoticed.
//   - INVENTING a write is one override prompt on a migration that did not
//     need it.
// So every "should find nothing" case here is about keeping the guard usable,
// and every "should find it" case is about keeping it honest. The honesty cases
// are the ones that must never be relaxed to quiet a false positive.

import assert from "node:assert";
import { applyTimeWriteTargets, applyTimeCode, overlappingTables } from "./apply-time-dml-lib.mjs";

let pass = 0;
function ok(c, m) { assert.ok(c, m); pass += 1; }
function eq(a, b, m) { assert.deepEqual(a, b, m); pass += 1; }

const T = (sql) => [...applyTimeWriteTargets(sql).targets].sort();
const has = (sql, t) => applyTimeWriteTargets(sql).targets.has(t);

// ---------------------------------------------------------------- the basics
eq(T("UPDATE order_items SET total_price = 1;"), ["order_items.total_price"],
  "a plain UPDATE names its table and column");
eq(T("DELETE FROM order_items WHERE id = 1;"), ["order_items.*"],
  "DELETE removes whole rows, so it covers every column");
eq(T("INSERT INTO order_items (id, total_price) VALUES (1, 2);"),
  ["order_items.id", "order_items.total_price"], "INSERT lists its columns");
eq(T("INSERT INTO order_items VALUES (1, 2);"), ["order_items.*"],
  "an INSERT with no column list writes all of them");
eq(T("MERGE INTO order_items t USING src ON t.id = src.id WHEN MATCHED THEN UPDATE SET total_price = 1;"),
  ["order_items.*"], "MERGE is treated as touching the whole row");

// -------------------------------------------------- ROUND 23: the actual bug
// `SET total_price = (total_price)` is the exact text that walked past the name,
// whole-body, and shared-statement checks. It must read identically here.
const REGISTERED = "UPDATE public.order_items SET total_price = total_price WHERE id = ANY(v_ids);";
const EVASIONS = [
  "UPDATE public.order_items SET total_price = (total_price) WHERE id = ANY(v_ids);",
  "UPDATE ONLY public.order_items SET total_price = ((total_price)) WHERE id = ANY(v_ids);",
  "UPDATE order_items oi SET total_price = total_price WHERE oi.id = ANY(v_ids);",
  "UPDATE order_items AS oi SET total_price = total_price::numeric WHERE oi.id = ANY(v_ids);",
  'UPDATE public."order_items" SET "total_price" = total_price WHERE id = ANY(v_ids);',
  "update\n  public.order_items\nset\n  total_price = total_price\nwhere id = any(v_ids);",
  "UPDATE public.order_items SET /* nothing to see */ total_price = total_price;",
  "WITH ids AS (SELECT 1) UPDATE public.order_items SET total_price = total_price;",
  "UPDATE public.order_items SET total_price = total_price, total_price = total_price;",
];
eq(T(REGISTERED), ["order_items.total_price"], "the registered repair reads as one target");
for (const e of EVASIONS) {
  eq(T(e), ["order_items.total_price"], `semantically identical rewrite still reads the same: ${e.slice(0, 46)}…`);
}

// ------------------------------------- deferred bodies are NOT apply-time
// 29 migrations define RPCs that write this column. If those counted, nearly
// every RPC change would demand an override and the guard would get disabled.
const FN_BODY = `
CREATE OR REPLACE FUNCTION public.recalc() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.order_items SET total_price = 5;
  DELETE FROM public.orders;
END;
$$;`;
eq(T(FN_BODY), [], "a routine body defines behavior and writes nothing at apply time");
ok(!has(FN_BODY, "order_items.total_price"), "the protected column inside a function body is not an apply-time write");

const PROC_BODY = `
CREATE PROCEDURE public.p() LANGUAGE plpgsql AS $body$
BEGIN UPDATE public.order_items SET total_price = 5; END;
$body$;`;
eq(T(PROC_BODY), [], "a procedure body is deferred too");

// A DO block runs the moment the migration applies, so it IS apply-time.
const DO_BLOCK = `
DO $$
BEGIN
  UPDATE public.order_items SET total_price = total_price WHERE id = ANY(ARRAY[1,2]);
END $$;`;
eq(T(DO_BLOCK), ["order_items.total_price"], "a DO block executes on apply, so its writes count");

// A function DEFINED inside a DO block is still deferred.
const DO_WITH_FN = `
DO $outer$
BEGIN
  EXECUTE 'SELECT 1';
  UPDATE public.orders SET status = 'x';
END $outer$;
CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $inner$
BEGIN UPDATE public.order_items SET total_price = 1; END;
$inner$;`;
eq(T(DO_WITH_FN), ["orders.status"], "the DO block's write counts; the function body's does not");

// ------------------------------- keywords that only LOOK like a relation
eq(T("GRANT UPDATE ON public.order_items TO authenticated;"), [],
  "granting UPDATE is a privilege change, not a write");
eq(T("REVOKE UPDATE ON public.order_items FROM anon;"), [], "revoking UPDATE writes nothing");
eq(T("CREATE TRIGGER t AFTER UPDATE OF total_price ON public.order_items FOR EACH ROW EXECUTE FUNCTION f();"),
  [], "a trigger definition is not a write");
eq(T("CREATE POLICY p ON public.order_items FOR UPDATE USING (true);"), [],
  "a policy definition is not a write");
eq(T("SELECT id FROM public.order_items FOR UPDATE;"), [],
  "SELECT ... FOR UPDATE locks rows, it does not write columns");
eq(T("CREATE TRIGGER t BEFORE INSERT OR UPDATE ON public.order_items EXECUTE FUNCTION f();"),
  [], "INSERT OR UPDATE in a trigger clause is not a write");

// ------------------------------------------- ON CONFLICT DO UPDATE (upsert)
// The word after this UPDATE is SET, so the relation has to come from the
// INSERT. Getting this wrong loses a real write to the protected column.
eq(T("INSERT INTO public.order_items (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET total_price = 9;"),
  ["order_items.id", "order_items.total_price"],
  "an upsert's DO UPDATE SET is attributed to the INSERT's table");
ok(has("INSERT INTO order_items (id) VALUES (1) ON CONFLICT DO UPDATE SET total_price = excluded.total_price;",
  "order_items.total_price"), "the upsert path finds the protected column even when it is not in the INSERT list");
eq(T("INSERT INTO public.orders (id) VALUES (1) ON CONFLICT (id) DO NOTHING;"), ["orders.id"],
  "DO NOTHING adds no extra target");

// ------------------------------------------------------ tuple assignment
eq(T("UPDATE order_items SET (total_price, net_margin) = (1, 2) WHERE id = 1;"),
  ["order_items.net_margin", "order_items.total_price"],
  "the tuple form of SET names every column in the group");

// --------------------------------------------------------- dynamic SQL
const DYN_LITERAL = `DO $$ BEGIN EXECUTE 'UPDATE public.order_items SET total_price = 0'; END $$;`;
{
  const r = applyTimeWriteTargets(DYN_LITERAL);
  eq(r.dynamicWrites.length, 1, "a dynamic write in apply-time position is reported");
  ok(r.dynamicWrites[0].toLowerCase().includes("order_items"),
    "the dynamic statement's text is handed back so its relation can be checked");
  eq(r.unresolved, false, "a dynamic statement naming its table literally is resolvable");
}
{
  const r = applyTimeWriteTargets(
    `DO $$ BEGIN EXECUTE format('UPDATE %I SET total_price = 0', v_table); END $$;`);
  eq(r.unresolved, true, "a relation chosen at runtime cannot be ruled out statically");
}
{
  // The same dynamic SQL inside a function body is deferred, so it is not an
  // apply-time write and must not be reported.
  const r = applyTimeWriteTargets(
    `CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE format('UPDATE %I SET x = 1', t); END; $$;`);
  eq(r.dynamicWrites.length, 0, "dynamic SQL inside a routine body is deferred, not apply-time");
  eq(r.unresolved, false, "and it does not mark the migration unresolvable");
}

// ---------------------------------------------------- comments and strings
ok(!has("-- UPDATE order_items SET total_price = 1;\nSELECT 1;", "order_items.total_price"),
  "a commented-out write is not a write");
ok(!has("/* UPDATE order_items SET total_price = 1; */ SELECT 1;", "order_items.total_price"),
  "a block-commented write is not a write");
eq(T("SELECT 'UPDATE order_items SET total_price = 1';"), [],
  "a write verb inside a plain string literal is data, not a statement");
eq(applyTimeCode("SELECT 'a''b';").literals, ["a'b"],
  "a doubled quote inside a literal is one escaped quote, not a terminator");
eq(T("/* outer /* inner */ UPDATE order_items SET total_price = 1; */ SELECT 1;"), [],
  "nested block comments close at the right place");

// -------------------------------------------------------- overlap semantics
// Round 27 moved this from column-level to table-level. The reason is a trigger:
// the registered repair writes order_items.total_price, and the canonical profit
// trigger fires BEFORE UPDATE OF total_price, profit, cost_per_unit,
// total_units_needed — so `SET profit = profit` re-runs the identical money
// correction while sharing no column with the registration. A column list cannot
// express that closure without tracking every trigger on every registered table
// and staying correct as triggers change; a silently stale list there is a
// replayed money repair. The table is the honest unit.
ok(overlappingTables(new Set(["order_items.total_price"]), new Set(["order_items.total_price"])).length === 1,
  "an exact pair overlaps");
ok(overlappingTables(new Set(["order_items.profit"]), new Set(["order_items.total_price"])).length === 1,
  "a sibling column of the same table overlaps — a trigger can recompute the registered money from it");
ok(overlappingTables(new Set(["order_items.*"]), new Set(["order_items.total_price"])).length === 1,
  "a whole-row write covers the protected column");
ok(overlappingTables(new Set(["order_items.total_price"]), new Set(["order_items.*"])).length === 1,
  "a whole-row registration is covered by any column write");
ok(overlappingTables(new Set(["orders.total_price"]), new Set(["order_items.total_price"])).length === 0,
  "the same column name on a different table does not overlap");
eq(overlappingTables(new Set(["order_items.profit", "orders.status"]), new Set(["order_items.total_price"])),
  ["order_items.profit"],
  "only the submitted targets on a registered table are returned, and they keep their column for the message");

// -------------------------------------------------------------- robustness
eq(T(""), [], "empty input yields nothing");
eq(T(null), [], "a null body does not throw");
{
  // An unterminated dollar quote must not swallow the rest of the file into a
  // deferred body and hide a later write. It runs to end-of-input, which is the
  // over-reporting direction only if the quote opened a DO block.
  const r = applyTimeWriteTargets("DO $$ BEGIN UPDATE order_items SET total_price = 1;");
  ok(r.targets.has("order_items.total_price"), "an unterminated DO body still reports its write");
}

// ------------------------------------------- round 24: define-and-call
// Dropping routine bodies was the right call for a migration that only DEFINES
// behavior — and it opened a door for one that defines behavior and then runs
// it. These four spellings all rewrite the column while the file, read
// naively, contains no apply-time UPDATE at all.
{
  const body = "UPDATE public.order_items SET total_price = (total_price) WHERE id = ANY(v_ids);";
  const CALLED = [
    ["a bare SELECT of the helper",
     `CREATE FUNCTION public.tmp_fix() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ${body} END; $$;\nSELECT public.tmp_fix();`],
    ["CALL of a procedure",
     `CREATE PROCEDURE public.tmp_fix() LANGUAGE plpgsql AS $$ BEGIN ${body} END; $$;\nCALL public.tmp_fix();`],
    ["PERFORM inside a DO block",
     `CREATE FUNCTION public.h() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ${body} END; $$;\nDO $$ BEGIN PERFORM public.h(); END $$;`],
    ["a helper that calls a helper",
     `CREATE FUNCTION public.i() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ${body} END; $$;\n` +
     `CREATE FUNCTION public.o() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM public.i(); END; $$;\nSELECT public.o();`],
    ["the call written before the definition",
     `DO $$ BEGIN PERFORM public.later(); END $$;\n` +
     `CREATE FUNCTION public.later() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ${body} END; $$;`],
  ];
  for (const [label, sql] of CALLED) {
    ok(has(sql, "order_items.total_price"), `round-24: ${label} is an apply-time write`);
  }

  // A routine that calls itself must not spin the fixpoint forever.
  const recursive =
    `CREATE FUNCTION public.loopy(n int) RETURNS void LANGUAGE plpgsql AS $$ BEGIN\n` +
    `  IF n > 0 THEN PERFORM public.loopy(n - 1); END IF; ${body} END; $$;\nSELECT public.loopy(3);`;
  ok(has(recursive, "order_items.total_price"), "round-24: a self-recursive helper terminates and still reports its write");
}

// PRECISION. Defining a routine is free, and so is every DDL form that merely
// NAMES it. If these were charged for their bodies, almost every RPC migration
// in the repository would demand an override — which is how a guard gets
// switched off rather than fixed.
{
  const decl = "CREATE OR REPLACE FUNCTION public.recalc() RETURNS void LANGUAGE plpgsql AS $$ BEGIN UPDATE order_items SET total_price = 1; END; $$;";
  eq(T(decl), [], "round-24: defining a routine writes nothing");
  eq(T(`${decl}\nGRANT EXECUTE ON FUNCTION public.recalc() TO authenticated;`), [],
     "round-24: granting EXECUTE is not calling it");
  eq(T(`${decl}\nREVOKE EXECUTE ON FUNCTION public.recalc() FROM anon;`), [],
     "round-24: revoking EXECUTE is not calling it");
  eq(T(`${decl}\nALTER FUNCTION public.recalc() SET search_path = public, pg_temp;`), [],
     "round-24: ALTER FUNCTION is not calling it");
  eq(T(`${decl}\nCOMMENT ON FUNCTION public.recalc() IS 'x';`), [],
     "round-24: COMMENT ON FUNCTION is not calling it");
  eq(T(`DROP FUNCTION IF EXISTS public.recalc();\n${decl}`), [],
     "round-24: drop-and-redefine — the commonest shape here — is not calling it");
  eq(T(`DROP FUNCTION public.recalc();\n${decl}`), [],
     "round-24: an unconditional DROP FUNCTION is not calling it");
}

// A routine this file does not define cannot be read, so it is reported rather
// than assumed harmless. CALL and PERFORM run something for its effect; that is
// the narrow case worth flagging, and it measured at 16 of 881 migrations.
{
  const r = applyTimeWriteTargets("CALL public.do_the_repair();");
  eq([...r.unknownCalls], ["do_the_repair"], "round-24: a CALL of an undefined routine is reported");
  ok(r.targets.size === 0, "round-24: an unreadable call invents no specific target");

  const q = applyTimeWriteTargets("DO $$ BEGIN PERFORM public.some_helper(1); END $$;");
  eq([...q.unknownCalls], ["some_helper"], "round-24: PERFORM of an undefined routine is reported");

  const own = applyTimeWriteTargets(
    "CREATE FUNCTION public.mine() RETURNS void LANGUAGE plpgsql AS $$ BEGIN NULL; END; $$;\nCALL public.mine();");
  eq([...own.unknownCalls], [], "round-24: calling a routine this file defines is not unknown");
}

console.log(`apply-time-dml-lib: ${pass} assertions passed`);
