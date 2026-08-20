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

// ------------------------------------------- ROUND 28: a trigger is a caller
// The round-24 rule above — "CREATE TRIGGER ... EXECUTE FUNCTION f() is not an
// invocation" — is true of the CREATE statement and false of the migration.
// Attaching a mutating function to a scratch table costs nothing; the very next
// INSERT into that table runs the body against real rows. Both facts have to
// hold at once, so the reproducer and the attach-only case are tested together.
{
  const FIX = "CREATE FUNCTION public.tmp_fix() RETURNS trigger LANGUAGE plpgsql " +
    "SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN " +
    "UPDATE public.order_items SET profit = (profit); RETURN NEW; END $$;";
  const ATTACH = "CREATE TEMP TABLE scratch(id integer);\n" +
    "CREATE TRIGGER run_fix AFTER INSERT ON scratch FOR EACH ROW " +
    "EXECUTE FUNCTION public.tmp_fix();";

  // The exact SQL the round-28 review submitted. Before the fix the analyzer
  // reported scratch.id alone, with unresolved false and no unknown calls.
  const repro = applyTimeWriteTargets(`${FIX}\n${ATTACH}\nINSERT INTO scratch(id) VALUES (1);`);
  ok(repro.targets.has("order_items.profit"),
    "round-28: firing an attached trigger charges the function's writes");
  ok(repro.targets.has("scratch.id"), "round-28: the INSERT itself is still reported");
  eq([...repro.firedTriggers], ["scratch.tmp_fix"],
    "round-28: the fired attachment is named, so the refusal can explain itself");

  // The false-positive boundary the review stated in the same breath. Creating
  // a trigger is not a write; if this ever turns red, every migration that adds
  // an updated_at trigger starts demanding an override.
  const attachOnly = applyTimeWriteTargets(`${FIX}\n${ATTACH}`);
  eq(T(`${FIX}\n${ATTACH}`), [], "round-28: attaching a trigger and never firing it writes nothing");
  eq([...attachOnly.firedTriggers], [], "round-28: an unfired attachment is not a firing");

  // Ordinary shape, and the one that decides whether this rule is usable: a
  // trigger on a real table fires only when this file also writes that table.
  const BUMP = "CREATE FUNCTION public.touch_row() RETURNS trigger LANGUAGE plpgsql AS $$ " +
    "BEGIN NEW.updated_at = now(); RETURN NEW; END $$;\n" +
    "CREATE TRIGGER t_touch BEFORE UPDATE ON public.customers FOR EACH ROW " +
    "EXECUTE FUNCTION public.touch_row();";
  eq(T(`${BUMP}\nUPDATE public.customers SET note = 'x';`), ["customers.note"],
    "round-28: a trigger body that writes nothing adds nothing");

  // Every DML form that reaches rows has to fire, not just INSERT.
  const fired = (dml) => applyTimeWriteTargets(`${FIX}\nCREATE TABLE scratch(id integer);\n` +
    "CREATE TRIGGER run_fix AFTER INSERT OR UPDATE OR DELETE ON scratch FOR EACH ROW " +
    `EXECUTE FUNCTION public.tmp_fix();\n${dml}`).targets.has("order_items.profit");
  ok(fired("UPDATE scratch SET id = 2;"), "round-28: UPDATE fires the attachment");
  ok(fired("DELETE FROM scratch;"), "round-28: DELETE fires the attachment");
  ok(fired("INSERT INTO scratch(id) SELECT 1;"), "round-28: INSERT ... SELECT fires it");

  // Chained: A is attached to scratch, B to the table A writes. Firing A fires
  // B. The fixpoint loop has to re-check attachments after every fold-in.
  const chain = applyTimeWriteTargets([
    "CREATE FUNCTION public.step_a() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN " +
      "UPDATE public.customers SET note = 'a'; RETURN NEW; END $$;",
    "CREATE FUNCTION public.step_b() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN " +
      "UPDATE public.order_items SET profit = (profit); RETURN NEW; END $$;",
    "CREATE TEMP TABLE scratch(id integer);",
    "CREATE TRIGGER a1 AFTER INSERT ON scratch FOR EACH ROW EXECUTE FUNCTION public.step_a();",
    "CREATE TRIGGER b1 AFTER UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION public.step_b();",
    "INSERT INTO scratch(id) VALUES (1);",
  ].join("\n"));
  ok(chain.targets.has("order_items.profit"),
    "round-28: a trigger fired by another trigger's write is charged too");

  // A trigger function that lives in the database rather than this file cannot
  // be read, so it is reported instead of assumed harmless.
  const resident = applyTimeWriteTargets(
    "CREATE TEMP TABLE scratch(id integer);\n" +
    "CREATE TRIGGER run_fix AFTER INSERT ON scratch FOR EACH ROW " +
    "EXECUTE FUNCTION public.existing_repair();\nINSERT INTO scratch(id) VALUES (1);");
  ok(resident.unknownCalls.includes("existing_repair"),
    "round-28: an unreadable trigger function fails closed");
}

// -------------------------------------- ROUND 29: literal SQL is still SQL
// A readable EXECUTE operand used to end the analysis: the literal was scanned
// for a bare DML verb and nothing else. A call is not a DML verb, so
// `EXECUTE 'SELECT tmp_fix()'` reported no targets, no unknown calls and
// unresolved=false while PostgreSQL rewrote money rows. So did a type change,
// which rewrites every row of the table without naming a DML verb either.
{
  const FIX = "CREATE FUNCTION public.tmp_fix() RETURNS void LANGUAGE plpgsql " +
    "SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN " +
    "UPDATE public.order_items SET profit = (profit); END $$;";
  const exec = (stmt) => `DO $do$ BEGIN EXECUTE ${stmt}; END $do$;`;

  // The reproducer the round-29 review submitted.
  const repro = applyTimeWriteTargets(`${FIX}\n${exec("'SELECT public.tmp_fix()'")}`);
  ok(repro.targets.has("order_items.profit"),
    "round-29: a routine called from literal SQL is charged with its writes");
  ok(repro.invokedRoutines.includes("tmp_fix"),
    "round-29: the call is named, so the refusal can explain itself");

  // The same call to a body that lives in the database, which cannot be read.
  const resident = applyTimeWriteTargets(exec("'SELECT public.existing_repair()'"));
  ok(resident.unknownCalls.includes("existing_repair"),
    "round-29: a database-resident routine called from literal SQL fails closed");

  // A type change rewrites every row; the USING expression is evaluated per row
  // and what it returns is what gets stored.
  const retype = applyTimeWriteTargets(exec(
    "'ALTER TABLE public.orders ALTER COLUMN total_profit TYPE numeric(12,2) " +
    "USING round(total_profit, 2)'"));
  ok(retype.targets.has("orders.*"),
    "round-29: a column retype inside literal SQL is a whole-table rewrite");

  // Direct DML in a literal was reported as a dynamic write with no target;
  // now it resolves to the column, which is what a one-shot compares against.
  eq(T(exec("'UPDATE public.order_items SET profit = 0'")), ["order_items.profit"],
    "round-29: literal DML resolves to its column, not just to a dynamic write");

  // Literal SQL can define a routine and attach it, and the round-28 rule has to
  // reach through the literal to see the firing.
  const defines = applyTimeWriteTargets([
    exec("$q$ CREATE FUNCTION public.t_fix() RETURNS trigger LANGUAGE plpgsql AS $b$ " +
      "BEGIN UPDATE public.order_items SET profit = (profit); RETURN NEW; END $b$ $q$"),
    "CREATE TEMP TABLE scratch(id integer);",
    "CREATE TRIGGER run_fix AFTER INSERT ON scratch FOR EACH ROW " +
      "EXECUTE FUNCTION public.t_fix();",
    "INSERT INTO scratch(id) VALUES (1);",
  ].join("\n"));
  ok(defines.targets.has("order_items.profit"),
    "round-29: a routine defined inside literal SQL is still readable when fired");

  // THE BOUNDARY THAT MAKES THIS AFFORDABLE. A migration that runs no dynamic
  // SQL is untouched, however its literals read — a comment, a RAISE message and
  // a column default are text, not statements. If either of these turns red,
  // every migration in the repository starts demanding an override.
  eq(T("COMMENT ON TABLE public.orders IS 'update public.order_items set profit = 0';"), [],
    "round-29: a literal in a file that executes nothing is not a statement");
  eq(T("ALTER TABLE public.orders ADD COLUMN note text DEFAULT 'select public.tmp_fix()';"), [],
    "round-29: a column default is not executed at apply time");
  eq(T(`DO $do$ BEGIN EXECUTE 'SELECT 1'; RAISE NOTICE 'finished with order_items'; END $do$;`), [],
    "round-29: prose alongside dynamic SQL is still prose");

  // THE OVER-REPORT, STATED RATHER THAN HIDDEN. Once a file runs dynamic SQL,
  // every literal in it is judged by how it reads, because which literal reached
  // the EXECUTE cannot be recovered — a deferred body emits an empty literal
  // placeholder and a nested body renumbers its own. So a RAISE message that
  // happens to begin with a DML verb and a table name is charged as a write.
  // It over-reports, which is the direction every module here takes, and it
  // costs an override prompt only in a file that already does dynamic SQL.
  // Measured over all 882 migrations in this tree: 3 change classification, all
  // 3 were already unresolved (so already refused against every registered
  // one-shot), and none is registered — the real cost is zero prompts.
  eq(T(`DO $do$ BEGIN EXECUTE 'SELECT 1'; RAISE NOTICE 'update public.order_items'; END $do$;`),
    ["order_items.*"],
    "round-29: a literal that reads as a statement is charged, even as prose");

  // An operand that cannot be read still refuses, exactly as before — reading
  // literals is an addition to that rule, never a replacement for it.
  ok(applyTimeWriteTargets("DO $do$ BEGIN EXECUTE v_sql; END $do$;").unresolved,
    "round-29: an unreadable EXECUTE operand still fails closed");
  ok(applyTimeWriteTargets(
    "DO $do$ BEGIN EXECUTE format('UPDATE %I SET profit = 0', v_t); END $do$;").unresolved,
    "round-29: format() is still not readable");
}


// ------------------- ROUND 30: a routine runs wherever a statement runs it
// The bypass the round-30 review submitted, reproduced exactly:
//
//   Migration A defines a mutator and a thin wrapper around it.
//   Migration B runs `INSERT INTO scratch VALUES (public.wrapper());`
//
// Migration B was reported as `targets=["scratch.*"], unknownCalls=[]` — the
// wrapper was invisible, so no override and no approved-set digest was asked
// for while PostgreSQL performed the protected rewrite.
//
// TWO separate defects produced it, and only fixing both closes the hole:
//
//   1. The statement had to BEGIN with a verb that runs (SELECT/CALL/PERFORM/
//      WITH). An INSERT was discarded whole, operands included. But a routine
//      runs wherever a statement runs it, not only where the statement starts.
//   2. The call-name pattern CONSUMED the character in front of the name. In
//      `VALUES (public.wrapper())` the match on `values (` ate the open paren,
//      so `public.wrapper(` had no separator left to match against. A call
//      sitting immediately inside another call's parentheses — which is
//      precisely where an ARGUMENT sits — was unreadable even once the
//      statement was scanned.
//
// The wrapper is deliberately NOT defined in the analysed SQL here. A resident
// routine is the whole point: its body is in the database, this file cannot
// read it, and the only safe answer is to refuse.
{
  const SCRATCH = "CREATE TABLE public.scratch(v int);\n";
  const refuses = (sql) => {
    const r = applyTimeWriteTargets(sql);
    // `unknownCalls` is an ARRAY. Asking it for `.size` yields undefined, which
    // reads as false and quietly passes every one of these.
    return r.unresolved || r.unknownCalls.length > 0;
  };

  // Each of these executes a database-resident routine as it applies.
  for (const [label, sql] of [
    ["INSERT ... VALUES", `${SCRATCH}INSERT INTO public.scratch VALUES (public.wrapper());`],
    ["INSERT (cols) VALUES", `${SCRATCH}INSERT INTO public.scratch (v) VALUES (public.wrapper());`],
    ["INSERT ... SELECT", `${SCRATCH}INSERT INTO public.scratch SELECT public.wrapper();`],
    ["INSERT ... ON CONFLICT DO UPDATE",
      `${SCRATCH}INSERT INTO public.scratch VALUES (1) ON CONFLICT (v) DO UPDATE SET v = public.wrapper();`],
    ["UPDATE ... SET", `${SCRATCH}UPDATE public.scratch SET v = public.wrapper();`],
    ["UPDATE ... WHERE", `${SCRATCH}UPDATE public.scratch SET v = 1 WHERE public.wrapper() > 0;`],
    ["DELETE ... WHERE", `${SCRATCH}DELETE FROM public.scratch WHERE v = public.wrapper();`],
    ["MERGE ... UPDATE SET",
      `${SCRATCH}MERGE INTO public.scratch t USING (SELECT 1 x) s ON t.v = s.x WHEN MATCHED THEN UPDATE SET v = public.wrapper();`],
    ["bare VALUES", "VALUES (public.wrapper());"],
    ["CREATE TABLE AS", "CREATE TABLE public.t2 AS SELECT public.wrapper() AS v;"],
    ["CREATE MATERIALIZED VIEW", "CREATE MATERIALIZED VIEW public.mv AS SELECT public.wrapper() AS v;"],
    ["ALTER TABLE ... USING", `${SCRATCH}ALTER TABLE public.scratch ALTER COLUMN v TYPE bigint USING public.wrapper();`],
    ["CREATE INDEX on an expression", `${SCRATCH}CREATE INDEX ix ON public.scratch (public.wrapper());`],
    ["CREATE INDEX ... USING btree (expr)", `${SCRATCH}CREATE INDEX ix ON public.scratch USING btree (public.wrapper(v));`],
    ["SELECT (the shape that always worked)", "SELECT public.wrapper();"],
  ]) {
    ok(refuses(sql), `round-30: a resident routine run by ${label} fails closed`);
  }

  // The reproducer verbatim, checked in full: the scratch write is still
  // reported AND the wrapper is now named, so the refusal can explain itself.
  const repro = applyTimeWriteTargets(`${SCRATCH}INSERT INTO public.scratch VALUES (public.wrapper());`);
  ok(repro.targets.has("scratch.*"), "round-30: the INSERT's own write is still reported");
  ok(repro.unknownCalls.includes("wrapper"),
    "round-30: the resident routine is named in unknownCalls");

  // THE OTHER DIRECTION, AND THE REASON THIS IS AFFORDABLE. Reading operands
  // reaches expressions no scan touched before, so the quiet cases matter as
  // much as the loud ones: if any of these turns red, ordinary schema work
  // starts demanding overrides and the guard gets switched off. Measured over
  // all 884 migrations in this tree, the widening changed exactly one file's
  // classification, and that one was a genuine apply-time reach.
  for (const [label, sql] of [
    ["a plain CREATE TABLE", "CREATE TABLE public.t3 (v numeric(12,2), w varchar(20));"],
    ["a view definition", "CREATE VIEW public.v1 AS SELECT public.wrapper() AS v;"],
    ["a policy predicate", "CREATE POLICY p ON public.scratch USING (public.wrapper());"],
    ["a column DEFAULT", "CREATE TABLE public.t4 (v int DEFAULT public.wrapper());"],
    ["a plain index", `${SCRATCH}CREATE INDEX ix2 ON public.scratch (v);`],
    ["a plain btree index", `${SCRATCH}CREATE INDEX ix3 ON public.scratch USING btree (v);`],
    ["an index over a builtin", `${SCRATCH}CREATE INDEX ix4 ON public.scratch (lower(v::text));`],
    ["ADD CONSTRAINT ... CHECK", `${SCRATCH}ALTER TABLE public.scratch ADD CONSTRAINT c CHECK (v > 0);`],
    ["SET DEFAULT", `${SCRATCH}ALTER TABLE public.scratch ALTER COLUMN v SET DEFAULT 0;`],
    ["a foreign key", `${SCRATCH}ALTER TABLE public.scratch ADD CONSTRAINT fk FOREIGN KEY (v) REFERENCES public.other(id);`],
    ["an INSERT of literals", `${SCRATCH}INSERT INTO public.scratch (v) VALUES (1), (2);`],
    ["an UPDATE using only builtins", `${SCRATCH}UPDATE public.scratch SET v = round(v, 2) WHERE v IS NOT NULL;`],
  ]) {
    ok(!refuses(sql), `round-30: ${label} asks for nothing`);
  }

  // A view and a policy are stored, not run — but writing THROUGH the view at
  // apply time still runs whatever the view's expression calls.
  ok(refuses("CREATE VIEW public.v2 AS SELECT public.wrapper() AS v;\nINSERT INTO public.v2 VALUES (public.wrapper());"),
    "round-30: storing an expression is quiet; executing it is not");
}

// ------------------- ROUND 31: a control structure still runs its statements
{
  const refuses = (sql) => {
    const r = applyTimeWriteTargets(sql);
    return r.unresolved || r.unknownCalls.length > 0;
  };

  // Peeling block keywords off the FRONT of a fragment only reaches a statement
  // that begins it. `IF <cond> THEN <stmt>` puts a condition in between, so the
  // executing statement was never read and the resident routine it calls was
  // reported as never called.
  for (const [label, sql] of [
    ["IF ... THEN SELECT", "DO $$ BEGIN IF true THEN SELECT public.wrapper(); END IF; END $$;"],
    ["IF ... THEN INSERT", "DO $$ BEGIN IF true THEN INSERT INTO public.scratch VALUES (public.wrapper()); END IF; END $$;"],
    ["ELSE arm", "DO $$ BEGIN IF false THEN NULL; ELSE SELECT public.wrapper(); END IF; END $$;"],
    ["ELSIF arm", "DO $$ BEGIN IF false THEN NULL; ELSIF true THEN SELECT public.wrapper(); END IF; END $$;"],
    ["WHILE ... LOOP body", "DO $$ BEGIN WHILE true LOOP SELECT public.wrapper(); END LOOP; END $$;"],
    ["FOR ... IN <query>", "DO $$ DECLARE r record; BEGIN FOR r IN SELECT public.wrapper() LOOP NULL; END LOOP; END $$;"],
    ["EXCEPTION ... THEN", "DO $$ BEGIN NULL; EXCEPTION WHEN others THEN SELECT public.wrapper(); END $$;"],
    ["CASE ... THEN in a running statement", "DO $$ BEGIN SELECT CASE WHEN true THEN public.wrapper() END; END $$;"],
  ]) {
    ok(refuses(sql), `round-31: a resident routine run from ${label} fails closed`);
  }

  // The definition branches return their own executing tail and never fall
  // through to the control-structure scan, so an expression that is STORED by a
  // definition — a CHECK's CASE, a policy's USING, a column DEFAULT — must stay
  // quiet exactly as it did before.
  for (const [label, sql] of [
    ["a CHECK holding a CASE", "CREATE TABLE public.t5 (v int, CONSTRAINT c CHECK (CASE WHEN v > 0 THEN public.wrapper() ELSE 0 END > 0));"],
    ["a policy predicate with a CASE", "CREATE POLICY p2 ON public.scratch USING (CASE WHEN true THEN public.wrapper() ELSE false END);"],
    ["a view body with a CASE", "CREATE VIEW public.v3 AS SELECT CASE WHEN true THEN public.wrapper() END AS v;"],
    ["a column DEFAULT with a CASE", "CREATE TABLE public.t6 (v int DEFAULT (CASE WHEN true THEN public.wrapper() ELSE 0 END));"],
  ]) {
    ok(!refuses(sql), `round-31: ${label} is stored, not run`);
  }

  // A routine body may legally be a single-quoted string instead of `$$`.
  // Deploying it runs nothing, so it must not be charged as a dynamic write —
  // which is what demanded a one-shot money-repair override for an ordinary
  // function deployment.
  const quoted = applyTimeWriteTargets(
    "CREATE FUNCTION public.f31() RETURNS void LANGUAGE sql AS 'UPDATE public.order_items SET total_price = 0';");
  eq(quoted.dynamicWrites.length, 0, "round-31: a single-quoted routine body is not an apply-time write");
  ok(!quoted.unresolved, "round-31: defining a routine from a quoted body resolves");
  eq([...quoted.targets].length, 0, "round-31: defining a routine writes nothing");

  // ...but calling it in the same migration folds the body back in, exactly as
  // the `$$` path does.
  const called = applyTimeWriteTargets(
    "CREATE FUNCTION public.f31() RETURNS void LANGUAGE sql AS 'UPDATE public.order_items SET total_price = 0';\n" +
    "SELECT public.f31();");
  ok([...called.targets].some((t) => t.startsWith("order_items.")),
    "round-31: calling the quoted-body routine reports its write");

  // A quote that is NOT a body must keep its old handling.
  const comment = applyTimeWriteTargets(
    "COMMENT ON FUNCTION public.f31() IS 'this used to UPDATE public.order_items';");
  eq([...comment.targets].length, 0, "round-31: a COMMENT's text writes nothing");
}

// ------------------------------------- ROUND 33: rules and quoted routines
{
  const quoted = applyTimeWriteTargets(
    'CREATE FUNCTION public."--now"() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ' +
    'UPDATE public.order_items SET total_price = total_price; END $$; ' +
    'SELECT public."--now"();',
  );
  ok(quoted.targets.has("order_items.total_price"),
    "round-33: comment markers inside a quoted routine name cannot erase its body or call");

  const rule = applyTimeWriteTargets(
    "CREATE TEMP TABLE scratch_probe(id integer); " +
    "CREATE RULE fire_repair AS ON INSERT TO scratch_probe " +
    "DO ALSO SELECT public.existing_repair(); " +
    "INSERT INTO scratch_probe(id) VALUES (1);",
  );
  ok(rule.unresolved, "round-33: firing a PostgreSQL rule fails closed");
  eq([...rule.firedRules], ["scratch_probe"],
    "round-33: the fired rule relation is named");

  const attachOnly = applyTimeWriteTargets(
    "CREATE TEMP TABLE scratch_probe(id integer); " +
    "CREATE RULE fire_repair AS ON INSERT TO scratch_probe DO ALSO SELECT 1;",
  );
  ok(!attachOnly.unresolved, "round-33: defining but not firing a rule remains deferred");
}

// ---------------------------- ROUND 34: quoted keywords remain identifiers
{
  const direct = applyTimeWriteTargets('UPDATE public."on" SET amount = 0;');
  ok(direct.targets.has('on.amount'),
    'round-34: a quoted keyword relation is retained as a write target');
  ok(direct.unresolved,
    'round-34: an ambiguous quoted keyword relation fails closed');

  const view = applyTimeWriteTargets(
    'CREATE VIEW public."on" AS SELECT * FROM public.order_items; ' +
    'UPDATE public."on" SET total_price = 0;',
  );
  ok(view.unresolved,
    'round-34: an automatically updatable view with a quoted keyword name fails closed');

  const fired = applyTimeWriteTargets(
    'CREATE TEMP TABLE scratch_probe(id integer); ' +
    'CREATE FUNCTION public.money_repair() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ' +
    'UPDATE public.order_items SET total_price = 0; RETURN NEW; END $$; ' +
    'CREATE TRIGGER "on" AFTER INSERT ON scratch_probe FOR EACH ROW ' +
    'EXECUTE FUNCTION public.money_repair(); ' +
    'INSERT INTO scratch_probe(id) VALUES (1);',
  );
  ok(fired.targets.has('order_items.total_price'),
    'round-34: a quoted keyword trigger name cannot hide its fired protected write');
}

// ----------------------- ROUND 35: ALTER expressions can execute over rows
{
  const addedDefault = applyTimeWriteTargets(
    'CREATE TEMP TABLE scratch(v int); INSERT INTO scratch(v) VALUES (1); ' +
    'ALTER TABLE scratch ADD COLUMN probe int DEFAULT public.repair_orders();',
  );
  ok(addedDefault.unknownCalls.includes('repair_orders'),
    'round-35: ADD COLUMN DEFAULT names a resident routine evaluated for existing rows');

  const addedCheck = applyTimeWriteTargets(
    'CREATE TEMP TABLE scratch(v int); INSERT INTO scratch(v) VALUES (1); ' +
    'ALTER TABLE scratch ADD CONSTRAINT c CHECK (public.repair_orders());',
  );
  ok(addedCheck.unknownCalls.includes('repair_orders'),
    'round-35: an immediately validated CHECK names its resident routine');

  const generated = applyTimeWriteTargets(
    'CREATE TEMP TABLE scratch(v int); INSERT INTO scratch(v) VALUES (1); ' +
    'ALTER TABLE scratch ADD COLUMN probe int GENERATED ALWAYS AS (public.repair_orders()) STORED;',
  );
  ok(generated.unknownCalls.includes('repair_orders'),
    'round-35: a stored generated column names its resident routine');

  ok(applyTimeWriteTargets(
    'ALTER TABLE public.orders VALIDATE CONSTRAINT orders_stored_check;',
  ).unresolved, 'round-35: validating an unreadable stored CHECK fails closed');

  const deferred = applyTimeWriteTargets(
    'ALTER TABLE public.orders ADD CONSTRAINT c CHECK (public.repair_orders()) NOT VALID;',
  );
  ok(!deferred.unknownCalls.includes('repair_orders') && !deferred.unresolved,
    'round-35: a NOT VALID CHECK remains deferred');

  const setDefault = applyTimeWriteTargets(
    'ALTER TABLE public.orders ALTER COLUMN total_profit SET DEFAULT public.repair_orders();',
  );
  ok(!setDefault.unknownCalls.includes('repair_orders') && !setDefault.unresolved,
    'round-35: SET DEFAULT changes future rows but does not evaluate existing rows');
}

// ------------------------- ROUND 36: dollar signs belong to identifiers too
{
  const quotedDollar = applyTimeWriteTargets(
    'CREATE FUNCTION public."$count"() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN ' +
    'UPDATE public.order_items SET total_price = total_price; END $body$; ' +
    'SELECT public."$count"(); DROP FUNCTION public."$count"();',
  );
  ok(quotedDollar.targets.has('order_items.total_price'),
    'round-36: quoted $ routine identity pairs its definition with its call');
  ok(!quotedDollar.unresolved,
    'round-36: a losslessly paired quoted $ routine does not become ambiguous');

  const unquotedDollar = applyTimeWriteTargets(
    'CREATE FUNCTION public.repair$orders() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ' +
    'UPDATE public.orders SET total_profit = total_profit; END $$; ' +
    'SELECT public.repair$orders();',
  );
  ok(unquotedDollar.targets.has('orders.total_profit'),
    'round-36: unquoted embedded $ routine identity pairs definition and call');
}

// -------- ROUND 32: PL/pgSQL conditions and assignments are executable too
{
  const refuses = (sql) => {
    const r = applyTimeWriteTargets(sql);
    return r.unresolved || r.unknownCalls.length > 0;
  };

  for (const [label, sql] of [
    ["IF condition", "DO $$ BEGIN IF public.wrapper() THEN NULL; END IF; END $$;"],
    ["ELSIF condition", "DO $$ BEGIN IF false THEN NULL; ELSIF public.wrapper() THEN NULL; END IF; END $$;"],
    ["WHILE condition", "DO $$ BEGIN WHILE public.wrapper() LOOP EXIT; END LOOP; END $$;"],
    ["assignment RHS", "DO $$ DECLARE v boolean; BEGIN v := public.wrapper(); END $$;"],
    ["declaration initializer", "DO $$ DECLARE v boolean := public.wrapper(); BEGIN NULL; END $$;"],
    ["array declaration initializer", "DO $$ DECLARE v uuid[] := public.wrapper(); BEGIN NULL; END $$;"],
    ["rowtype declaration initializer", "DO $$ DECLARE v public.orders%ROWTYPE := public.wrapper(); BEGIN NULL; END $$;"],
    ["RETURN expression", "CREATE FUNCTION public.f32() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN RETURN public.wrapper(); END $$; SELECT public.f32();"],
  ]) {
    ok(refuses(sql), `round-32: a resident routine in ${label} fails closed`);
  }

  for (const [label, sql] of [
    ["stored CHECK condition", "CREATE TABLE public.t32 (v int CHECK (public.wrapper()));"],
    ["stored policy condition", "CREATE POLICY p32 ON public.scratch USING (public.wrapper());"],
    ["stored view expression", "CREATE VIEW public.v32 AS SELECT public.wrapper();"],
  ]) {
    ok(!refuses(sql), `round-32: ${label} remains deferred`);
  }
}

// ---------------- ROUND 37: custom operators dispatch to routines too
{
  const definition =
    'CREATE FUNCTION public.operator_money_fix(integer, integer) RETURNS boolean ' +
    'LANGUAGE plpgsql AS $$ BEGIN UPDATE public.order_items SET total_price = total_price; ' +
    'RETURN true; END $$; ' +
    'CREATE OPERATOR === (PROCEDURE = public.operator_money_fix, ' +
    'LEFTARG = integer, RIGHTARG = integer); ';

  const invoked = applyTimeWriteTargets(`${definition} SELECT 1 === 1;`);
  ok(invoked.targets.has('order_items.total_price'),
    'round-37: invoking a custom operator folds in its mutating backing routine');
  ok(invoked.invokedRoutines.includes('operator_money_fix'),
    'round-37: the operator-backed routine joins the ordinary transitive call graph');

  const definitionOnly = applyTimeWriteTargets(definition);
  ok(!definitionOnly.targets.has('order_items.total_price'),
    'round-37 MUTANT: defining but not invoking the operator remains deferred');

  const wrapped = applyTimeWriteTargets(
    `${definition} CREATE FUNCTION public.operator_wrapper() RETURNS boolean ` +
    'LANGUAGE sql AS $$ SELECT 1 === 1 $$; SELECT public.operator_wrapper();',
  );
  ok(wrapped.targets.has('order_items.total_price'),
    'round-37: an operator invocation inside an invoked wrapper is followed transitively');

  const resident = applyTimeWriteTargets(
    'CREATE OPERATOR === (PROCEDURE = public.resident_operator_fix, ' +
    'LEFTARG = integer, RIGHTARG = integer); SELECT 1 === 1;',
  );
  ok(resident.unknownCalls.includes('resident_operator_fix'),
    'round-37: an invoked operator with a database-resident backing routine fails closed');
}

console.log(`apply-time-dml-lib: ${pass} assertions passed`);
