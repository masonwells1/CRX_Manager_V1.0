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
import {
  applyTimeWriteTargets,
  applyTimeCode,
  overlappingTables,
  ruleAttachmentIdentity,
  routineIdentityChanges,
} from "./apply-time-dml-lib.mjs";

let pass = 0;
function ok(c, m) { assert.ok(c, m); pass += 1; }
function eq(a, b, m) { assert.deepEqual(a, b, m); pass += 1; }

const T = (sql) => [...applyTimeWriteTargets(sql).targets].sort();
const has = (sql, t) => applyTimeWriteTargets(sql).targets.has(t);
const firedRuleIds = (result) => result.firedRules.map(ruleAttachmentIdentity).sort();

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
{
  // ROUND 48. COMMENT names a FUNCTION but does not define it. The broad
  // dollar-body test used to register the harmless comment as money_fix's
  // implementation, so the following resident call looked fully resolved and
  // effect-free instead of failing closed.
  const commentedCall = applyTimeWriteTargets(
    "COMMENT ON FUNCTION public.money_fix() IS $note$harmless$note$; " +
    "SELECT public.money_fix();",
  );
  ok(!commentedCall.definedRoutines.includes("public.money_fix"),
    "round-48: a dollar-quoted COMMENT does not define the named routine");
  ok(commentedCall.unknownCalls.includes("public.money_fix"),
    "round-48: the later resident routine call remains visible and unknown");
  const commentOnly = applyTimeWriteTargets(
    "COMMENT ON FUNCTION public.money_fix() IS $note$harmless$note$;",
  );
  ok(commentOnly.targets.size === 0 && !commentOnly.unresolved,
    "round-48 control: harmless routine metadata alone remains effect-free");
}

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

  const twoCalls =
    `CREATE FUNCTION public.first_fix() RETURNS void LANGUAGE plpgsql AS $$ BEGIN UPDATE public.orders SET total_profit = 1; END; $$;\n` +
    `CREATE FUNCTION public.second_fix() RETURNS void LANGUAGE plpgsql AS $$ BEGIN UPDATE public.order_items SET total_price = 1; END; $$;\n` +
    `SELECT public.first_fix();\nSELECT public.second_fix();`;
  ok(has(twoCalls, "orders.total_profit"),
    "round-24: the first of two separately invoked helpers is charged");
  ok(has(twoCalls, "order_items.total_price"),
    "round-24: a helper invoked by a later statement is charged too");

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
  eq([...r.unknownCalls], ["public.do_the_repair"], "round-24: a CALL of an undefined routine is reported");
  ok(r.targets.size === 0, "round-24: an unreadable call invents no specific target");

  const q = applyTimeWriteTargets("DO $$ BEGIN PERFORM public.some_helper(1); END $$;");
  eq([...q.unknownCalls], ["public.some_helper"], "round-24: PERFORM of an undefined routine is reported");

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
  eq([...repro.firedTriggers], ["scratch.public.tmp_fix"],
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
  ok(resident.unknownCalls.includes("public.existing_repair"),
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
  ok(repro.invokedRoutines.includes("public.tmp_fix"),
    "round-29: the call is named, so the refusal can explain itself");

  // The same call to a body that lives in the database, which cannot be read.
  const resident = applyTimeWriteTargets(exec("'SELECT public.existing_repair()'"));
  ok(resident.unknownCalls.includes("public.existing_repair"),
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
  ok(repro.unknownCalls.includes("public.wrapper"),
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
    ["an index over an explicit catalog builtin", `${SCRATCH}CREATE INDEX ix4 ON public.scratch (pg_catalog.lower(v::text));`],
    ["ADD CONSTRAINT ... CHECK", `${SCRATCH}ALTER TABLE public.scratch ADD CONSTRAINT c CHECK (v > 0);`],
    ["SET DEFAULT", `${SCRATCH}ALTER TABLE public.scratch ALTER COLUMN v SET DEFAULT 0;`],
    ["a foreign key", `${SCRATCH}ALTER TABLE public.scratch ADD CONSTRAINT fk FOREIGN KEY (v) REFERENCES public.other(id);`],
    ["an INSERT of literals", `${SCRATCH}INSERT INTO public.scratch (v) VALUES (1), (2);`],
    ["an UPDATE using only explicit catalog builtins", `${SCRATCH}UPDATE public.scratch SET v = pg_catalog.round(v, 2) WHERE v IS NOT NULL;`],
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

// -------- ROUND 59: escape-string routine bodies are opaque when invoked
{
  const escaped = applyTimeWriteTargets(
    "CREATE FUNCTION public.round59_escape() RETURNS void LANGUAGE plpgsql AS " +
    "E'BEGIN\\nUPD\\101TE public.order_items SET total_price = total_price;\\nEND'; " +
    "SELECT public.round59_escape();",
  );
  ok(escaped.unresolved,
    "round-59: an invoked E-string routine body fails closed instead of trusting raw escapes");

  const unicode = applyTimeWriteTargets(
    "CREATE FUNCTION public.round59_unicode() RETURNS void LANGUAGE plpgsql AS " +
    "U&'BEGIN UPD\\0041TE public.order_items SET total_price = total_price; END'; " +
    "SELECT public.round59_unicode();",
  );
  ok(unicode.unresolved,
    "round-59: an invoked U&-string routine body fails closed instead of trusting Unicode escapes");

  const definitionsOnly = applyTimeWriteTargets(
    "CREATE FUNCTION public.round59_deferred_e() RETURNS void LANGUAGE plpgsql AS E'BEGIN NULL; END'; " +
    "CREATE FUNCTION public.round59_deferred_u() RETURNS void LANGUAGE plpgsql AS U&'BEGIN NULL; END';",
  );
  ok(!definitionsOnly.unresolved,
    "round-59 MUTANT: defining an escape-string routine without invoking it remains deferred");
}

// ---- ROUND 60: string mode and parameter defaults cannot confuse body trust
{
  const escapedPlain = applyTimeWriteTargets(
    "SET standard_conforming_strings = off; " +
    "CREATE FUNCTION public.round60_plain() RETURNS void LANGUAGE plpgsql AS " +
    "'BEGIN UPD\\101TE public.order_items SET total_price = total_price; END'; " +
    "SELECT public.round60_plain();",
  );
  ok(escapedPlain.unresolved,
    "round-60: disabling standard strings makes an invoked plain-quoted body fail closed");

  const escapedDefinitionOnly = applyTimeWriteTargets(
    "SET LOCAL standard_conforming_strings TO 'off'; " +
    "CREATE FUNCTION public.round60_deferred() RETURNS void LANGUAGE plpgsql AS " +
    "'BEGIN UPD\\101TE public.order_items SET total_price = total_price; END';",
  );
  ok(!escapedDefinitionOnly.unresolved,
    "round-60 MUTANT: the same plain-quoted body remains deferred until invocation");

  for (const setting of ["E'off'", "U&'off'"]) {
    const prefixedSetting = applyTimeWriteTargets(
      `SET standard_conforming_strings = ${setting}; ` +
      "CREATE FUNCTION public.round60_prefixed_setting() RETURNS void LANGUAGE plpgsql AS " +
      "'BEGIN UPD\\101TE public.orders SET total_profit = total_profit; END'; " +
      "SELECT public.round60_prefixed_setting();",
    );
    ok(prefixedSetting.unresolved,
      `round-60: ${setting} also disables plain-body string trust`);
  }

  const continuedBody = applyTimeWriteTargets(
    "CREATE FUNCTION public.round60_continued() RETURNS void LANGUAGE plpgsql AS " +
    "'BEGIN UPD'\n'ATE public.orders SET total_profit = total_profit; END'; " +
    "SELECT public.round60_continued();",
  );
  ok(continuedBody.unresolved,
    "round-60: an invoked newline-continued routine body fails closed");

  const continuedDefinitionOnly = applyTimeWriteTargets(
    "CREATE FUNCTION public.round60_deferred_continued() RETURNS void LANGUAGE plpgsql AS " +
    "'BEGIN UPD'\n'ATE public.orders SET total_profit = total_profit; END';",
  );
  ok(!continuedDefinitionOnly.unresolved,
    "round-60 MUTANT: a continued body remains deferred until invocation");

  for (const [label, defaultSql] of [
    ["escape-string", "E'plain'"],
    ["dollar-quoted", "$q$plain$q$"],
  ]) {
    const name = `round60_${label.replace('-', '_')}`;
    const result = applyTimeWriteTargets(
      `CREATE FUNCTION public.${name}(p text DEFAULT ${defaultSql}) RETURNS void LANGUAGE plpgsql AS $$ ` +
      "BEGIN UPDATE public.orders SET total_profit = total_profit; END $$; " +
      `SELECT public.${name}();`,
    );
    ok(result.targets.has("orders.total_profit") && !result.unresolved,
      `round-60: a ${label} parameter default is not misclassified as the routine body`);
  }
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
  eq(firedRuleIds(rule), ["public\0scratch_probe\0insert\0fire_repair"],
    "round-33: the fired rule's complete attachment identity is named");

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
  ok(addedDefault.unknownCalls.includes('public.repair_orders'),
    'round-35: ADD COLUMN DEFAULT names a resident routine evaluated for existing rows');

  const addedCheck = applyTimeWriteTargets(
    'CREATE TEMP TABLE scratch(v int); INSERT INTO scratch(v) VALUES (1); ' +
    'ALTER TABLE scratch ADD CONSTRAINT c CHECK (public.repair_orders());',
  );
  ok(addedCheck.unknownCalls.includes('public.repair_orders'),
    'round-35: an immediately validated CHECK names its resident routine');

  const generated = applyTimeWriteTargets(
    'CREATE TEMP TABLE scratch(v int); INSERT INTO scratch(v) VALUES (1); ' +
    'ALTER TABLE scratch ADD COLUMN probe int GENERATED ALWAYS AS (public.repair_orders()) STORED;',
  );
  ok(generated.unknownCalls.includes('public.repair_orders'),
    'round-35: a stored generated column names its resident routine');

  ok(applyTimeWriteTargets(
    'ALTER TABLE public.orders VALIDATE CONSTRAINT orders_stored_check;',
  ).unresolved, 'round-35: validating an unreadable stored CHECK fails closed');

  const deferred = applyTimeWriteTargets(
    'ALTER TABLE public.orders ADD CONSTRAINT c CHECK (public.repair_orders()) NOT VALID;',
  );
  ok(!deferred.unknownCalls.includes('public.repair_orders') && !deferred.unresolved,
    'round-35: a NOT VALID CHECK remains deferred');

  const setDefault = applyTimeWriteTargets(
    'ALTER TABLE public.orders ALTER COLUMN total_profit SET DEFAULT public.repair_orders();',
  );
  ok(!setDefault.unknownCalls.includes('public.repair_orders') && !setDefault.unresolved,
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

  const tagShapedDollar = applyTimeWriteTargets(
    'CREATE FUNCTION public.repair$x$() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ' +
    'UPDATE public.orders SET total_profit = total_profit; END $$; ' +
    'SELECT public.repair$x$();',
  );
  ok(tagShapedDollar.targets.has('orders.total_profit'),
    'round-41: a tag-shaped $x$ run inside an identifier is not a dollar quote');
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
    ["ELSEIF condition", "DO $$ BEGIN IF false THEN NULL; ELSEIF public.wrapper() THEN NULL; END IF; END $$;"],
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

  const branchRepair = (keyword) =>
    "CREATE FUNCTION public.branch_money() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN " +
    "UPDATE public.order_items SET total_price = total_price; RETURN false; END $$; " +
    `DO $$ BEGIN IF false THEN NULL; ${keyword} public.branch_money() THEN NULL; END IF; END $$;`;
  const elsifTargets = T(branchRepair("ELSIF"));
  eq(elsifTargets, ["order_items.total_price"],
    "round-56: ELSIF evaluates its condition and follows the invoked money writer");
  eq(T(branchRepair("ELSEIF")), elsifTargets,
    "round-56: PostgreSQL ELSEIF has the same apply-time write identity as ELSIF");

  const conditionBeforePerform = applyTimeWriteTargets(
    "CREATE FUNCTION public.condition_money_fix() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN " +
    "UPDATE public.order_items SET total_price = total_price; RETURN true; END $$; " +
    "DO $$ BEGIN IF public.condition_money_fix() THEN PERFORM 1; END IF; END $$;",
  );
  ok(conditionBeforePerform.targets.has("order_items.total_price"),
    "round-59: a later PERFORM cannot hide the money writer evaluated by an IF condition");
  ok(conditionBeforePerform.invokedRoutines.includes("public.condition_money_fix"),
    "round-59 MUTANT: the condition call remains named when its arm starts with PERFORM");
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
  ok(invoked.invokedRoutines.includes('public.operator_money_fix'),
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
  ok(resident.unknownCalls.includes('public.resident_operator_fix'),
    'round-37: an invoked operator with a database-resident backing routine fails closed');
}

// ---------------- ROUND 38: custom casts dispatch to routines too
{
  const definition =
    'CREATE TYPE public.cast_sink AS (v integer); ' +
    'CREATE FUNCTION public.cast_money_fix(text) RETURNS public.cast_sink ' +
    'LANGUAGE plpgsql AS $$ BEGIN UPDATE public.order_items SET total_price = total_price; ' +
    'RETURN ROW(1)::public.cast_sink; END $$; ' +
    'CREATE CAST (text AS public.cast_sink) WITH FUNCTION public.cast_money_fix(text); ';

  const invoked = applyTimeWriteTargets(
    `${definition} SELECT CAST('run'::text AS public.cast_sink);`,
  );
  ok(invoked.targets.has('order_items.total_price'),
    'round-38: invoking a custom cast folds in its mutating backing routine');
  ok(invoked.invokedRoutines.includes('public.cast_money_fix'),
    'round-38: the cast-backed routine joins the ordinary transitive call graph');

  const definitionOnly = applyTimeWriteTargets(definition);
  ok(!definitionOnly.targets.has('order_items.total_price'),
    'round-38 MUTANT: defining but not invoking an explicit cast remains deferred');

  const wrapped = applyTimeWriteTargets(
    `${definition} CREATE FUNCTION public.cast_wrapper() RETURNS public.cast_sink ` +
    `LANGUAGE sql AS $$ SELECT 'run'::text::public.cast_sink $$; ` +
    'SELECT public.cast_wrapper();',
  );
  ok(wrapped.targets.has('order_items.total_price'),
    'round-38: a custom cast inside an invoked wrapper is followed transitively');

  const resident = applyTimeWriteTargets(
    `SELECT CAST('run'::text AS public.resident_sink);`,
    { knownCasts: [{ source: 'text', target: 'public.resident_sink', fn: 'public.resident_cast_fix', context: 'explicit' }] },
  );
  ok(resident.unknownCalls.includes('public.resident_cast_fix'),
    'round-38: an invoked catalog-resident cast backing routine fails closed');

  const implicit = applyTimeWriteTargets(
    'CREATE CAST (text AS public.implicit_sink) WITH FUNCTION public.resident_implicit_fix(text) AS IMPLICIT; ' +
    `SELECT 'expression whose live types need catalog resolution';`,
  );
  ok(implicit.unknownCalls.includes('public.resident_implicit_fix'),
    'round-38: implicit custom casts conservatively fail closed on executable expressions');
}

// ---------------- ROUND 39: selecting a stored view executes its query
{
  const resident = applyTimeWriteTargets(
    'CREATE VIEW public.replay_bridge AS SELECT public.existing_repair(); ' +
    'SELECT * FROM public.replay_bridge;',
  );
  ok(resident.unknownCalls.includes('public.existing_repair'),
    'round-39: selecting a same-file view follows its stored resident routine call');

  const definitionOnly = applyTimeWriteTargets(
    'CREATE VIEW public.replay_bridge AS SELECT public.existing_repair();',
  );
  ok(!definitionOnly.unknownCalls.includes('public.existing_repair'),
    'round-39 MUTANT: defining but not selecting the view remains deferred');

  const sameFile = applyTimeWriteTargets(
    'CREATE FUNCTION public.view_money_fix() RETURNS integer LANGUAGE plpgsql AS $$ ' +
    'BEGIN UPDATE public.order_items SET total_price = total_price; RETURN 1; END $$; ' +
    'CREATE VIEW public.money_bridge AS SELECT public.view_money_fix(); ' +
    'SELECT * FROM public.money_bridge;',
  );
  ok(sameFile.targets.has('order_items.total_price'),
    'round-39: a selected view folds in its same-file mutating routine body');

  const catalog = applyTimeWriteTargets(
    'SELECT * FROM public.catalog_bridge;',
    { knownViews: [{ name: 'catalog_bridge', query: 'select public.catalog_view_fix()' }] },
  );
  ok(catalog.unknownCalls.includes('public.catalog_view_fix'),
    'round-39: a cataloged older view follows its stored resident routine call');

  const nested = applyTimeWriteTargets(
    'CREATE VIEW public.inner_bridge AS SELECT public.nested_view_fix(); ' +
    'CREATE VIEW public.outer_bridge AS SELECT * FROM public.inner_bridge; ' +
    'SELECT * FROM public.outer_bridge;',
  );
  ok(nested.unknownCalls.includes('public.nested_view_fix'),
    'round-39: selected views are followed transitively through nested views');
}

// ---------------- ROUND 40: anonymous blocks must have readable bodies
{
  const plainDml = applyTimeWriteTargets(
    "DO 'BEGIN UPDATE public.orders SET total_profit = total_profit; END';",
  );
  ok(plainDml.unresolved,
    'round-40: a plain-string DO body with direct DML fails closed');

  const escapedCall = applyTimeWriteTargets(
    "DO E'BEGIN PERFORM public.existing_repair(); END';",
  );
  ok(escapedCall.unresolved,
    'round-40: an escape-string DO body with a resident routine call fails closed');

  const unicodeCall = applyTimeWriteTargets(
    "DO U&'BEGIN PERFORM public.existing_repair(); END';",
  );
  ok(unicodeCall.unresolved,
    'round-40: a Unicode-string DO body fails closed too');

  const splitLanguageCall = applyTimeWriteTargets(
    'DO LANGUAGE "plpgsql"\n' +
    "U&'BEGIN PERFORM public.existing_repair(); END';",
  );
  ok(splitLanguageCall.unresolved,
    'round-40: a split, quoted LANGUAGE clause cannot hide a Unicode-string DO body');

  const readableDml = applyTimeWriteTargets(
    'DO $$ BEGIN UPDATE public.orders SET total_profit = total_profit; END $$;',
  );
  ok(readableDml.targets.has('orders.total_profit') && !readableDml.unresolved,
    'round-40 control: a dollar-quoted DO body remains readable as direct DML');

  const readableCall = applyTimeWriteTargets(
    'DO $$ BEGIN PERFORM public.existing_repair(); END $$;',
  );
  ok(readableCall.unknownCalls.includes('public.existing_repair') && !readableCall.unresolved,
    'round-40 control: a dollar-quoted DO body still exposes resident routine calls');
}

// ---------------- ROUND 41: resource caps and builtin trust fail closed
{
  const padding = [
    "EXECUTE 'SELECT 0'",
    ...Array.from(
      { length: 499 },
      (_, index) => "PERFORM 'SELECT " + String(index + 1) + "'",
    ),
  ].join('; ');
  const capped = applyTimeWriteTargets(
    "DO $$ BEGIN " + padding +
    "; EXECUTE 'SELECT public.existing_repair()'; END $$;",
  );
  ok(capped.unresolved,
    'round-41: exceeding the 500-literal analysis cap fails closed');

  const belowCap = applyTimeWriteTargets(
    "DO $$ BEGIN " + padding + "; END $$;",
  );
  ok(!belowCap.unresolved && belowCap.unknownCalls.length === 0,
    'round-41 MUTANT: exactly 500 harmless executable literals remain analyzable');

  const publicAuthOverload = applyTimeWriteTargets('SELECT public.is_admin(1);');
  ok(publicAuthOverload.unknownCalls.includes('public.is_admin'),
    'round-41: public.is_admin overload does not inherit a bare-name exemption');

  const publicBuiltinOverload = applyTimeWriteTargets('SELECT public.round(1);');
  ok(publicBuiltinOverload.unknownCalls.includes('public.round'),
    'round-41: a public overload of a PostgreSQL builtin fails closed');

  const catalogBuiltin = applyTimeWriteTargets('SELECT pg_catalog.round(1.2);');
  ok(!catalogBuiltin.unknownCalls.includes('round'),
    'round-41 control: explicit pg_catalog builtin identity stays trusted');

  const authHelper = applyTimeWriteTargets('SELECT auth.uid();');
  ok(!authHelper.unknownCalls.includes('uid'),
    'round-41 control: the fixed auth.uid identity stays trusted');

  const bareBuiltin = applyTimeWriteTargets('SELECT round(1.2);');
  ok(bareBuiltin.unknownCalls.includes('round'),
    'round-42: an unqualified builtin-looking call fails closed because public can overload it');

  const shortResident = applyTimeWriteTargets('SELECT t();');
  ok(shortResident.unknownCalls.includes('t'),
    'round-42: a short routine name is not mistaken for a harmless table alias');

  const quotedLowerDefinition = applyTimeWriteTargets(
    'CREATE FUNCTION public."round"(jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN ' +
    'UPDATE public.order_items SET total_price = total_price; RETURN $1; END $$; ' +
    "SELECT round('{}'::jsonb);",
  );
  ok(quotedLowerDefinition.targets.has('order_items.total_price'),
    'round-42: quoted lowercase definition and unquoted call share one PostgreSQL identity');
  ok(quotedLowerDefinition.definedRoutines.includes('public.round') &&
      quotedLowerDefinition.invokedRoutines.includes('public.round'),
  'round-42: the coalesced identity participates in the ordinary transitive call graph');

  const quotedMixedCase = applyTimeWriteTargets(
    'CREATE FUNCTION public."Round"(jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN ' +
    'UPDATE public.order_items SET total_price = total_price; RETURN $1; END $$; ' +
    "SELECT round('{}'::jsonb);",
  );
  ok(!quotedMixedCase.targets.has('order_items.total_price') &&
      quotedMixedCase.unknownCalls.includes('round'),
  'round-42 control: genuinely distinct quoted mixed-case identity does not coalesce');
}

// ---------------- ROUND 43: cursor execution cannot hide routine effects
{
  const sameFile = applyTimeWriteTargets(
    'CREATE FUNCTION public.cursor_money_fix() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN ' +
    'UPDATE public.orders SET total_profit = total_profit; RETURN 1; END $$; ' +
    'DO $$ DECLARE c CURSOR FOR SELECT public.cursor_money_fix(); v integer; ' +
    'BEGIN OPEN c; FETCH c INTO v; CLOSE c; END $$;',
  );
  ok(sameFile.targets.has('orders.total_profit') || sameFile.unresolved,
    'round-43: opening/fetching a cursor cannot hide a same-file mutating routine');

  const resident = applyTimeWriteTargets(
    'DO $$ DECLARE c CURSOR FOR SELECT public.resident_cursor_money_fix(); v integer; ' +
    'BEGIN OPEN c; FETCH c INTO v; CLOSE c; END $$;',
  );
  ok(resident.unknownCalls.includes('public.resident_cursor_money_fix') || resident.unresolved,
    'round-43: opening/fetching a cursor over a database-resident routine fails closed');

  const quotedCursor = applyTimeWriteTargets(
    'DO $$ DECLARE "Money Cursor" refcursor; v integer; BEGIN ' +
    'OPEN "Money Cursor" FOR SELECT public.resident_cursor_money_fix(); ' +
    'FETCH "Money Cursor" INTO v; CLOSE "Money Cursor"; END $$;',
  );
  ok(quotedCursor.unresolved,
    'round-43: a quoted unbound cursor opened over a callable query fails closed');

  const definitionOnly = applyTimeWriteTargets(
    'CREATE FUNCTION public.deferred_cursor_wrapper() RETURNS void LANGUAGE plpgsql AS $$ ' +
    'DECLARE c CURSOR FOR SELECT public.resident_cursor_money_fix(); v integer; ' +
    'BEGIN OPEN c; FETCH c INTO v; CLOSE c; END $$;',
  );
  ok(!definitionOnly.unresolved && definitionOnly.unknownCalls.length === 0,
    'round-43 MUTANT: defining but not invoking a cursor-using routine remains deferred');
}

// ---------------- ROUND 44: non-ASCII routine identities fail closed
{
  const unicodeProcedure = applyTimeWriteTargets(
    'CREATE PROCEDURE public.修復() LANGUAGE plpgsql AS $$ BEGIN ' +
    'UPDATE public.order_items SET profit = profit; END $$; ' +
    'CALL public.修復(); DROP PROCEDURE public.修復();',
  );
  ok(unicodeProcedure.unresolved && unicodeProcedure.unsupportedRoutineIdentity,
    'round-44: define/call/drop of a Unicode procedure cannot disappear from analysis');

  const resident = applyTimeWriteTargets('SELECT public.修復();');
  ok(resident.unresolved && resident.unsupportedRoutineIdentity,
    'round-44: a database-resident Unicode routine call fails closed');

  const unicodeData = applyTimeWriteTargets("SELECT '修復 is prose';");
  ok(!unicodeData.unresolved,
    'round-44 MUTANT: non-ASCII data inside a string is not a routine identity');
}

// ---------------- ROUND 45: domain coercion executes stored CHECK expressions
{
  const definition =
    'CREATE FUNCTION public.domain_money_fix(integer) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN ' +
    'UPDATE public.order_items SET total_price = total_price; RETURN true; END $$; ' +
    'CREATE DOMAIN public.money_checked_integer AS integer ' +
    'CHECK (public.domain_money_fix(VALUE)); ';

  const invoked = applyTimeWriteTargets(
    `${definition} SELECT 1::public.money_checked_integer;`,
  );
  ok(invoked.unresolved && invoked.invokedCasts.some((entry) => entry.includes('money_checked_integer')),
    'round-45: casting to a same-file domain fails closed because its stored CHECK executes');

  const definitionOnly = applyTimeWriteTargets(definition);
  ok(!definitionOnly.unresolved,
    'round-45 MUTANT: defining but not coercing through a domain remains deferred');

  const resident = applyTimeWriteTargets(
    'SELECT CAST(1 AS public.resident_money_domain);',
    { knownCasts: [{ source: '', target: 'public.resident_money_domain', fn: '', context: 'domain' }] },
  );
  ok(resident.unresolved && resident.invokedCasts.some((entry) => entry.includes('resident_money_domain')),
    'round-45: coercion through a checked-in resident domain fails closed');

  const altered = applyTimeWriteTargets(
    'CREATE FUNCTION public.domain_alter_money_fix(integer) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN ' +
    'UPDATE public.order_items SET total_price = total_price; RETURN true; END $$; ' +
    'ALTER DOMAIN public.existing_money_domain ADD CONSTRAINT current_money_ok ' +
    'CHECK (public.domain_alter_money_fix(VALUE));',
  );
  ok(altered.targets.has('order_items.total_price') &&
      altered.invokedRoutines.includes('public.domain_alter_money_fix'),
    'round-53: ALTER DOMAIN ADD CHECK executes its readable validation routine over existing values');

  const deferredAlter = applyTimeWriteTargets(
    'CREATE FUNCTION public.domain_deferred_fix(integer) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN ' +
    'UPDATE public.order_items SET total_price = total_price; RETURN true; END $$; ' +
    'ALTER DOMAIN public.existing_money_domain ADD CONSTRAINT future_money_ok ' +
    'CHECK (public.domain_deferred_fix(VALUE)) NOT VALID;',
  );
  ok(!deferredAlter.unresolved && deferredAlter.targets.size === 0 &&
      !deferredAlter.invokedRoutines.includes('public.domain_deferred_fix'),
    'round-53 MUTANT: ALTER DOMAIN ADD CHECK NOT VALID remains deferred');

  const opaqueValidation = applyTimeWriteTargets(
    'ALTER DOMAIN public.existing_money_domain VALIDATE CONSTRAINT historical_money_ok;',
  );
  ok(opaqueValidation.unresolved && opaqueValidation.domainConstraintValidation,
    'round-53: ALTER DOMAIN VALIDATE CONSTRAINT fails closed because its stored CHECK is absent');
}

// ---------------- ROUND 46: database-wide event triggers fail closed
{
  const eventTriggerAttack = applyTimeWriteTargets(
    'CREATE FUNCTION public.ddl_money_fix() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN ' +
    'UPDATE public.order_items SET total_price = total_price; END $$; ' +
    'CREATE EVENT TRIGGER ddl_money_replay ON ddl_command_end EXECUTE FUNCTION public.ddl_money_fix(); ' +
    "COMMENT ON TABLE public.orders IS 'fires';",
  );
  ok(eventTriggerAttack.unresolved && eventTriggerAttack.eventTriggerChange,
    'round-46: an event-trigger money rewrite activated by later DDL fails closed');

  const routineOnly = applyTimeWriteTargets(
    'CREATE FUNCTION public.deferred_event_trigger_fn() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN ' +
    'UPDATE public.order_items SET total_price = total_price; END $$;',
  );
  ok(!routineOnly.unresolved && !routineOnly.eventTriggerChange,
    'round-46 MUTANT: an unattached event-trigger routine definition remains deferred');
}

// ---------------- ROUND 47: catalog-first event metadata helpers
{
  const unproven = applyTimeWriteTargets(
    'SELECT * FROM pg_event_trigger_ddl_commands();',
  );
  ok(unproven.unknownCalls.includes('pg_event_trigger_ddl_commands'),
    'round-47: an unqualified event helper remains unknown without search-path proof');

  const catalogFirst = applyTimeWriteTargets(
    'SELECT * FROM pg_event_trigger_ddl_commands();',
    { trustedUnqualifiedRoutines: ['pg_event_trigger_ddl_commands'] },
  );
  ok(!catalogFirst.unresolved && catalogFirst.unknownCalls.length === 0,
    'round-47: an exact event metadata helper is trusted after catalog-first proof');

  const publicOverload = applyTimeWriteTargets(
    'SELECT * FROM public.pg_event_trigger_ddl_commands();',
    { trustedUnqualifiedRoutines: ['pg_event_trigger_ddl_commands'] },
  );
  ok(publicOverload.unknownCalls.includes('public.pg_event_trigger_ddl_commands'),
    'round-47 MUTANT: explicit public overloads never inherit catalog-helper trust');

  const directPath = applyTimeWriteTargets(
    "SET LOCAL search_path = public, pg_catalog; COMMENT ON TABLE public.orders IS 'fires';",
  );
  ok(directPath.searchPathChange,
    'round-47: a direct search_path mutation is exposed to event-trigger consumers');

  const configuredPath = applyTimeWriteTargets(
    "DO $$ BEGIN PERFORM set_config('search_path', 'public, pg_catalog', true); END $$;",
  );
  ok(configuredPath.searchPathChange,
    'round-47: set_config inside executable code is exposed conservatively');

  const deferredPath = applyTimeWriteTargets(
    "CREATE FUNCTION public.later_path() RETURNS void LANGUAGE plpgsql AS $$ BEGIN " +
    "PERFORM set_config('search_path', 'public, pg_catalog', true); END $$;",
  );
  ok(!deferredPath.searchPathChange,
    'round-47 MUTANT: an uninvoked routine search_path change remains deferred');

  const deferredConfig = applyTimeWriteTargets(
    'CREATE FUNCTION public.catalog_bound() RETURNS void LANGUAGE plpgsql ' +
    'SET search_path = pg_catalog, public AS $$ BEGIN NULL; END $$;',
  );
  ok(!deferredConfig.searchPathChange,
    'round-47 MUTANT: CREATE FUNCTION search_path config does not change the applying session');

  const noticeOnly = applyTimeWriteTargets(
    "DO $$ BEGIN RAISE NOTICE 'about to update orders and delete from invoices'; END $$;",
  );
  ok(!noticeOnly.searchPathChange && !noticeOnly.unresolved,
    'round-47 MUTANT: write words inside NOTICE data are not an event catalog risk');
}

// ---------------- ROUND 49: current-database-qualified routine calls
{
  const body = 'UPDATE public.order_items SET total_price = total_price;';
  const cases = [
    [
      'SELECT',
      `CREATE FUNCTION public.dbq_select_fix() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ${body} END $$; ` +
        'SELECT postgres.public.dbq_select_fix();',
    ],
    [
      'CALL',
      `CREATE PROCEDURE public.dbq_call_fix() LANGUAGE plpgsql AS $$ BEGIN ${body} END $$; ` +
        'CALL postgres.public.dbq_call_fix();',
    ],
    [
      'PERFORM',
      `CREATE FUNCTION public.dbq_perform_fix() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ${body} END $$; ` +
        'DO $$ BEGIN PERFORM postgres.public.dbq_perform_fix(); END $$;',
    ],
  ];
  for (const [verb, sql] of cases) {
    ok(has(sql, 'order_items.total_price'),
      `round-49: ${verb} with database.schema qualification follows a same-file mutator`);
  }

  const resident = applyTimeWriteTargets('SELECT postgres.public.resident_money_repair();');
  ok(resident.unknownCalls.includes('public.resident_money_repair') || resident.unresolved,
    'round-49: a database-qualified resident routine fails closed');

  const definitionOnly =
    `CREATE FUNCTION public.dbq_metadata_only() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ${body} END $$; ` +
    'DROP FUNCTION postgres.public.dbq_metadata_only();';
  ok(!has(definitionOnly, 'order_items.total_price'),
    'round-49 MUTANT: database-qualified routine metadata remains deferred');
}

// ---------------- ROUND 50: bound event-trigger routine catalog changes
{
  const parsed = routineIdentityChanges(
    'CREATE OR REPLACE FUNCTION extensions.grant_pg_cron_access() RETURNS event_trigger ' +
      'LANGUAGE plpgsql AS $$ BEGIN NULL; END $$; ' +
      'ALTER FUNCTION "extensions"."grant_pg_cron_access"() SET search_path = pg_catalog; ' +
      'DROP PROCEDURE postgres.extensions.other_event_proc();',
  );
  eq(parsed.changes, [
    { schema: 'extensions', name: 'grant_pg_cron_access' },
    { schema: 'extensions', name: 'grant_pg_cron_access' },
    { schema: 'extensions', name: 'other_event_proc' },
  ], 'round-50: routine catalog changes retain the final schema/name across quoted and database-qualified forms');

  const metadata = routineIdentityChanges(
    "COMMENT ON FUNCTION extensions.grant_pg_cron_access() IS 'DROP FUNCTION extensions.grant_pg_cron_access()';",
  );
  eq(metadata.changes, [],
    'round-50 MUTANT: routine names in metadata strings are not catalog changes');
}

// ----- ROUND 61: executable nested SQL preserves routine catalog mutations
{
  const dynamicReplacement = applyTimeWriteTargets(
    'CREATE FUNCTION public.round61_money_fix() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ' +
    'UPDATE public.orders SET total_profit = total_profit; END $$; ' +
    'DO $do$ BEGIN EXECUTE \'CREATE OR REPLACE FUNCTION extensions.grant_pg_cron_access() ' +
    'RETURNS event_trigger LANGUAGE plpgsql AS $fn$ BEGIN PERFORM public.round61_money_fix(); ' +
    'END $fn$\'; END $do$; COMMENT ON TABLE public.orders IS \'fires\';',
  );
  ok(dynamicReplacement.routineCatalog.changes.some((change) =>
    change.schema === 'extensions' && change.name === 'grant_pg_cron_access'),
  'round-61: dynamic SQL exposes the captured event-trigger routine identity it replaces');

  const invokedInstaller = applyTimeWriteTargets(
    'CREATE PROCEDURE public.round61_install() LANGUAGE plpgsql AS $outer$ BEGIN ' +
    'CREATE OR REPLACE FUNCTION extensions.grant_pg_cron_access() RETURNS event_trigger ' +
    'LANGUAGE plpgsql AS $inner$ BEGIN NULL; END $inner$; END $outer$; ' +
    'CALL public.round61_install();',
  );
  ok(invokedInstaller.routineCatalog.changes.some((change) =>
    change.schema === 'extensions' && change.name === 'grant_pg_cron_access'),
  'round-61: routine DDL inside an invoked installer remains an apply-time catalog change');
}

// ---------------- ROUND 51: persistent sequence mutations
{
  const cases = [
    "SELECT pg_catalog.nextval('public.invoice_number_seq');",
    "DO $$ BEGIN PERFORM setval('public.invoice_number_seq', 1, false); END $$;",
    'ALTER SEQUENCE public.invoice_number_seq RESTART WITH 1;',
    'TRUNCATE public.sequence_scratch RESTART IDENTITY;',
    'ALTER TABLE public.sequence_scratch ALTER COLUMN id RESTART WITH 1;',
  ];
  for (const sql of cases) {
    const result = applyTimeWriteTargets(sql);
    ok(result.unresolved && result.sequenceMutation,
      `round-51: persistent sequence mutation fails closed: ${sql}`);
  }

  const deferred = [
    "CREATE TABLE public.later_seq (id bigint DEFAULT nextval('public.invoice_number_seq'));",
    "ALTER TABLE public.later_seq ALTER COLUMN id SET DEFAULT nextval('public.invoice_number_seq');",
    "CREATE VIEW public.later_seq_view AS SELECT nextval('public.invoice_number_seq');",
    "CREATE FUNCTION public.later_seq_fn() RETURNS bigint LANGUAGE sql AS $$ SELECT nextval('public.invoice_number_seq') $$;",
    "SELECT currval('public.invoice_number_seq');",
  ];
  for (const sql of deferred) {
    const result = applyTimeWriteTargets(sql);
    ok(!result.sequenceMutation,
      `round-51 MUTANT: deferred/read-only sequence expression stays non-mutating: ${sql}`);
  }
}

// ---------------- ROUND 52: ON SELECT rules execute when their relation is read
{
  const definition =
    'CREATE FUNCTION public.rule_money_fix() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN ' +
    'UPDATE public.order_items SET total_price = total_price; RETURN 1; END $$; ' +
    'CREATE TABLE public.scratch_probe(id integer); ' +
    'CREATE RULE "_RETURN" AS ON SELECT TO public.scratch_probe ' +
    'DO INSTEAD SELECT public.rule_money_fix() AS id;';

  const selected = applyTimeWriteTargets(`${definition} SELECT * FROM public.scratch_probe;`);
  ok(selected.unresolved,
    'round-52: selecting a relation with an ON SELECT rule fails closed');
  eq(firedRuleIds(selected), ['public\0scratch_probe\0select\0_return'],
    'round-52: the fired ON SELECT rule attachment is named');

  const definitionOnly = applyTimeWriteTargets(definition);
  ok(!definitionOnly.unresolved,
    'round-52 MUTANT: defining an ON SELECT rule without reading it remains deferred');
  eq(definitionOnly.firedRules, [],
    'round-52 MUTANT: an unread ON SELECT rule is not reported as fired');
}

// ---------------- ROUND 57: persisted rules survive migration boundaries
{
  const selected = applyTimeWriteTargets(
    'SELECT * FROM public.persisted_rule_probe;',
    { knownRules: [{ name: 'persisted_select', table: 'persisted_rule_probe', event: 'select' }] },
  );
  ok(selected.unresolved,
    'round-57: selecting a relation with a catalog-known ON SELECT rule fails closed');
  eq(firedRuleIds(selected), ['public\0persisted_rule_probe\0select\0persisted_select'],
    'round-57: the persisted fired rule attachment is named');

  const notSelected = applyTimeWriteTargets(
    'SELECT 1;',
    { knownRules: [{ name: 'persisted_select', table: 'persisted_rule_probe', event: 'select' }] },
  );
  ok(!notSelected.unresolved && notSelected.firedRules.length === 0,
    'round-57 MUTANT: a persisted rule that is not fired does not block unrelated SQL');

  const crossSchema = applyTimeWriteTargets(
    'SELECT * FROM auth.persisted_rule_probe;',
    { knownRules: [{ name: 'auth_select', table: 'auth.persisted_rule_probe', event: 'select' }] },
  );
  ok(crossSchema.unresolved &&
      firedRuleIds(crossSchema).includes('auth\0persisted_rule_probe\0select\0auth_select'),
    'round-57: a catalog-known rule retains its non-public schema identity');
  const unqualified = applyTimeWriteTargets(
    'SELECT * FROM persisted_rule_probe;',
    { knownRules: [{ name: 'auth_select', table: 'auth.persisted_rule_probe', event: 'select' }] },
  );
  ok(unqualified.unresolved &&
      firedRuleIds(unqualified).includes('auth\0persisted_rule_probe\0select\0auth_select'),
    'round-57: an unqualified relation may resolve through search_path to the auth rule');

  const sameEventRules = applyTimeWriteTargets(
    'CREATE RULE local_repair AS ON UPDATE TO public.persisted_rule_probe DO ALSO SELECT 1; ' +
      'UPDATE public.persisted_rule_probe SET id = id;',
    { knownRules: [{ name: 'inherited_repair', table: 'persisted_rule_probe', event: 'update' }] },
  );
  eq(firedRuleIds(sameEventRules), [
    'public\0persisted_rule_probe\0update\0inherited_repair',
    'public\0persisted_rule_probe\0update\0local_repair',
  ], 'round-64: inherited and local rules on one relation/event retain distinct identities');
}

// ---------------- ROUND 54: routine schemas are part of call identity
{
  const collision = applyTimeWriteTargets(
    'CREATE FUNCTION scratch.repair_money() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$; ' +
    'SELECT public.repair_money();',
  );
  ok(collision.definedRoutines.includes('scratch.repair_money') &&
      !collision.invokedRoutines.includes('scratch.repair_money'),
    'round-54 MUTANT: a same-bare-name definition in another schema does not satisfy the call');
  ok(collision.unknownCalls.includes('public.repair_money'),
    'round-54: the exact qualified database-resident routine remains unknown');

  const exact = applyTimeWriteTargets(
    'CREATE FUNCTION scratch.repair_money() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$; ' +
    'CREATE FUNCTION public.repair_money() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ' +
    'UPDATE public.orders SET total_profit = total_profit; END $$; ' +
    'SELECT public.repair_money();',
  );
  ok(exact.targets.has('orders.total_profit') &&
      exact.invokedRoutines.includes('public.repair_money') &&
      !exact.invokedRoutines.includes('scratch.repair_money'),
    'round-54: a qualified call folds only the exact schema-qualified same-file body');

  const unqualified = applyTimeWriteTargets(
    'CREATE FUNCTION public.search_path_money() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ' +
    'UPDATE public.orders SET total_profit = total_profit; END $$; SELECT search_path_money();',
  );
  ok(unqualified.targets.has('orders.total_profit') &&
      unqualified.unknownCalls.includes('search_path_money'),
    'round-54: unqualified resolution folds possible bodies but remains fail-closed without search-path proof');
}

// ---------------- ROUND 55: executable DDL and tolerant qualified identities
{
  const spacedDollar = applyTimeWriteTargets(
    'CREATE FUNCTION public . spaced_money() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ' +
    'UPDATE public.orders SET total_profit = total_profit; END $$; SELECT public.spaced_money();',
  );
  ok(spacedDollar.targets.has('orders.total_profit') &&
      spacedDollar.invokedRoutines.includes('public.spaced_money'),
    'round-55: whitespace around a routine schema separator preserves dollar-body identity');

  const spacedString = applyTimeWriteTargets(
    "CREATE FUNCTION public . spaced_string_money() RETURNS void LANGUAGE plpgsql AS 'BEGIN " +
    "UPDATE public.order_items SET profit = profit; END'; SELECT public.spaced_string_money();",
  );
  ok(spacedString.targets.has('order_items.profit'),
    'round-55: whitespace around a routine schema separator preserves string-body identity');

  const installedTrigger = applyTimeWriteTargets(
    'CREATE TABLE public.round55_scratch(id integer); ' +
    'CREATE FUNCTION public.round55_sink() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ' +
    'UPDATE public.orders SET total_profit = total_profit; RETURN NEW; END $$; ' +
    'CREATE PROCEDURE public.round55_install() LANGUAGE plpgsql AS $$ BEGIN ' +
    'CREATE TRIGGER round55_t AFTER INSERT ON public.round55_scratch FOR EACH ROW ' +
    'EXECUTE FUNCTION public.round55_sink(); END $$; ' +
    'CALL public.round55_install(); INSERT INTO public.round55_scratch VALUES (1);',
  );
  ok(installedTrigger.targets.has('orders.total_profit'),
    'round-55: a trigger attached by an invoked routine contributes its fired body');

  const installedRule = applyTimeWriteTargets(
    'CREATE TABLE public.round55_rule_source(id integer); ' +
    'CREATE PROCEDURE public.round55_rule_install() LANGUAGE plpgsql AS $$ BEGIN ' +
    'CREATE RULE round55_r AS ON SELECT TO public.round55_rule_source DO INSTEAD SELECT 1 AS id; ' +
    'END $$; CALL public.round55_rule_install(); SELECT * FROM public.round55_rule_source;',
  );
  ok(installedRule.unresolved &&
      firedRuleIds(installedRule).includes('public\0round55_rule_source\0select\0round55_r'),
    'round-55: a rule attached by an invoked routine fails closed when its relation is read');

  const usingRule = applyTimeWriteTargets(
    'CREATE TABLE public.round55_using_source(id integer); ' +
    'CREATE RULE round55_using AS ON SELECT TO public.round55_using_source ' +
    'DO INSTEAD SELECT 1 AS id; DELETE FROM public.round55_sink_table ' +
    'USING public.round55_using_source WHERE true;',
  );
  ok(usingRule.unresolved &&
      firedRuleIds(usingRule).includes('public\0round55_using_source\0select\0round55_using'),
    'round-55: DELETE or MERGE USING reads can fire standing SELECT rules');
}

// ---------------- ROUND 56: invoked defaults and recursion caps fail closed
{
  const sameFileDefault = applyTimeWriteTargets(
    'CREATE FUNCTION public.default_money_fix() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN ' +
    'UPDATE public.order_items SET profit = profit; RETURN 1; END $$; ' +
    'CREATE FUNCTION public.default_wrapper(p integer DEFAULT public.default_money_fix()) ' +
    'RETURNS integer LANGUAGE sql AS $$ SELECT p $$; SELECT public.default_wrapper();',
  );
  ok(sameFileDefault.unresolved,
    'round-56: invoking a routine with a same-file callable default fails closed');

  const residentDefault = applyTimeWriteTargets(
    'CREATE FUNCTION public.resident_default_wrapper(' +
    'p integer DEFAULT public.resident_money_fix()) RETURNS integer LANGUAGE sql AS $$ ' +
    'SELECT p $$; SELECT public.resident_default_wrapper();',
  );
  ok(residentDefault.unresolved,
    'round-56: invoking a routine with a database-resident callable default fails closed');

  const equalsDefault = applyTimeWriteTargets(
    'CREATE FUNCTION public.equals_default_wrapper(' +
    'p integer = public.resident_money_fix()) RETURNS integer LANGUAGE sql AS $$ ' +
    'SELECT p $$; SELECT public.equals_default_wrapper();',
  );
  ok(equalsDefault.unresolved,
    'round-56: PostgreSQL equals-syntax callable defaults also fail closed');

  const definitionOnly = applyTimeWriteTargets(
    'CREATE FUNCTION public.deferred_default_wrapper(' +
    'p integer DEFAULT public.resident_money_fix()) RETURNS integer LANGUAGE sql AS $$ SELECT p $$;',
  );
  ok(!definitionOnly.unresolved,
    'round-56 MUTANT: defining but not invoking a callable default remains deferred');

  const constantDefault = applyTimeWriteTargets(
    'CREATE FUNCTION public.constant_default_wrapper(p integer DEFAULT 1) ' +
    'RETURNS integer LANGUAGE sql AS $$ SELECT p $$; SELECT public.constant_default_wrapper();',
  );
  ok(!constantDefault.unresolved,
    'round-56 MUTANT: an invoked constant default remains statically analyzable');

  eq(applyTimeCode('SELECT 1;', 9).unsupportedDoBody, true,
    'round-56: crossing the nested-body cap returns explicit unresolved evidence');

  let nestedBody = 'SELECT 1;';
  for (let depth = 0; depth < 10; depth += 1) {
    nestedBody = `DO $d${depth}$ BEGIN ${nestedBody} END $d${depth}$;`;
  }
  ok(applyTimeWriteTargets(nestedBody).unresolved,
    'round-56: nested-body cap evidence propagates to the final apply-time result');
}

// -------- ROUND 57: invoked defaults use the ordinary coercion graph too
{
  const castDefault = applyTimeWriteTargets(
    'CREATE FUNCTION public.round57_castfix(integer) RETURNS public.round57_money_box ' +
    'LANGUAGE plpgsql AS $$ BEGIN UPDATE public.orders SET total_profit = total_profit; ' +
    'RETURN NULL; END $$; ' +
    'CREATE CAST (integer AS public.round57_money_box) ' +
    'WITH FUNCTION public.round57_castfix(integer); ' +
    'CREATE FUNCTION public.round57_wrapper(' +
    'p public.round57_money_box DEFAULT 1::public.round57_money_box) ' +
    'RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$; SELECT public.round57_wrapper();',
  );
  ok(castDefault.targets.has('orders.total_profit'),
    'round-57: an invoked explicit-cast default follows its same-file mutating backing routine');

  const definitionOnly = applyTimeWriteTargets(
    'CREATE FUNCTION public.round57_deferred_castfix(integer) RETURNS public.round57_deferred_box ' +
    'LANGUAGE plpgsql AS $$ BEGIN UPDATE public.orders SET total_profit = total_profit; ' +
    'RETURN NULL; END $$; ' +
    'CREATE CAST (integer AS public.round57_deferred_box) ' +
    'WITH FUNCTION public.round57_deferred_castfix(integer); ' +
    'CREATE FUNCTION public.round57_deferred_wrapper(' +
    'p public.round57_deferred_box DEFAULT 1::public.round57_deferred_box) ' +
    'RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;',
  );
  ok(!definitionOnly.targets.has('orders.total_profit') && !definitionOnly.unresolved,
    'round-57 MUTANT: defining but not invoking a cast-bearing default remains deferred');

  const builtinCast = applyTimeWriteTargets(
    'CREATE FUNCTION public.round57_builtin_default(p bigint DEFAULT 1::bigint) ' +
    'RETURNS bigint LANGUAGE sql AS $$ SELECT p $$; SELECT public.round57_builtin_default();',
  );
  ok(!builtinCast.unresolved && builtinCast.targets.size === 0,
    'round-57 MUTANT: an invoked builtin cast default remains statically analyzable');
}

// ------- ROUND 58: commas inside array defaults are not parameter separators
{
  const arrayDefault = applyTimeWriteTargets(
    'CREATE FUNCTION public.round58_array_fix() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN ' +
    'UPDATE public.orders SET total_profit = total_profit; RETURN 2; END $$; ' +
    'CREATE FUNCTION public.round58_array_wrapper(' +
    "p integer[] DEFAULT ARRAY[1, public.round58_array_fix()]) " +
    'RETURNS integer LANGUAGE sql AS $$ SELECT p[1] $$; ' +
    'SELECT public.round58_array_wrapper();',
  );
  ok(arrayDefault.unresolved,
    'round-58: a callable expression after an array-default comma fails closed');

  for (const [label, expression] of [
    ["single-quoted", "'a,b' || public.resident_money_fix()::text"],
    ["dollar-quoted", "$q$a,b$q$ || public.resident_money_fix()::text"],
    ["block-commented", "1 /* comma, stays inert */ + public.resident_money_fix()"],
  ]) {
    const routineName = `round58_${label.replace('-', '_')}_wrapper`;
    const result = applyTimeWriteTargets(
      `CREATE FUNCTION public.${routineName}(p text DEFAULT ${expression}) ` +
      'RETURNS text LANGUAGE sql AS $$ SELECT p $$; ' +
      `SELECT public.${routineName}();`,
    );
    ok(result.unresolved,
      `round-58: a ${label} comma cannot split away the callable remainder of a default`);
  }

  const definitionOnly = applyTimeWriteTargets(
    'CREATE FUNCTION public.round58_deferred_array_wrapper(' +
    "p text[] DEFAULT ARRAY['a,b', public.resident_money_fix()]) " +
    'RETURNS text LANGUAGE sql AS $$ SELECT p[1] $$;',
  );
  ok(!definitionOnly.unresolved && definitionOnly.targets.size === 0,
    'round-58 MUTANT: a quoted comma and callable array default remain deferred until invocation');
}

// ---------------- ROUND 60: routine moves/renames preserve executable bodies
{
  const relocated = applyTimeWriteTargets(
    'CREATE FUNCTION public.pg_sleep() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN ' +
    'UPDATE public.order_items SET total_price = total_price; RETURN true; END $$; ' +
    'ALTER FUNCTION public.pg_sleep() SET SCHEMA pg_catalog; ' +
    'SELECT pg_catalog.pg_sleep();',
  );
  ok(relocated.targets.has('order_items.total_price'),
    'round-60: moving a same-file mutator into a trusted schema preserves its writes');
  ok(relocated.definedRoutines.includes('pg_catalog.pg_sleep') &&
      relocated.invokedRoutines.includes('pg_catalog.pg_sleep'),
    'round-60 MUTANT: the relocated complete identity owns and invokes the preserved body');

  const renamed = applyTimeWriteTargets(
    'CREATE FUNCTION public.before_name() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ' +
    'UPDATE public.orders SET total_profit = total_profit; END $$; ' +
    'ALTER FUNCTION public.before_name() RENAME TO after_name; ' +
    'SELECT public.after_name();',
  );
  ok(renamed.targets.has('orders.total_profit') &&
      renamed.definedRoutines.includes('public.after_name'),
    'round-60: renaming a same-file mutator re-keys its body under the destination');

  const chained = applyTimeWriteTargets(
    'CREATE FUNCTION public.chain_name() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ' +
    'UPDATE public.orders SET total_profit = total_profit; END $$; ' +
    'ALTER FUNCTION public.chain_name() SET SCHEMA scratch; ' +
    'ALTER FUNCTION scratch.chain_name() RENAME TO final_name; ' +
    'SELECT scratch.final_name();',
  );
  ok(chained.targets.has('orders.total_profit') &&
      chained.definedRoutines.includes('scratch.final_name'),
    'round-60: ordered SET SCHEMA plus RENAME transitions preserve the final body identity');

  const residentRelocation = applyTimeWriteTargets(
    'ALTER FUNCTION public.pg_sleep() SET SCHEMA pg_catalog; ' +
    'SELECT pg_catalog.pg_sleep();',
  );
  ok(residentRelocation.unknownCalls.includes('pg_catalog.pg_sleep') || residentRelocation.unresolved,
    'round-60: a relocated resident routine cannot inherit pg_catalog trust by spelling');

  const residentUnqualifiedRelocation = applyTimeWriteTargets(
    'ALTER FUNCTION public.round(numeric) SET SCHEMA pg_catalog; SELECT round(1.2);',
  );
  ok(residentUnqualifiedRelocation.unknownCalls.includes('round') ||
      residentUnqualifiedRelocation.unresolved,
    'round-60: an unqualified relocated resident routine cannot inherit implicit pg_catalog trust');

  const unreadable = applyTimeWriteTargets(
    'ALTER FUNCTION public.before_name SET SCHEMA pg_catalog; SELECT pg_catalog.before_name();',
  );
  ok(unreadable.unresolved,
    'round-60: an identity transition without a complete signature fails closed');

  const changedCatalog = routineIdentityChanges(
    'ALTER FUNCTION public.before_name(integer, text[]) SET SCHEMA scratch;',
  );
  ok(changedCatalog.changes.some((change) =>
      change.schema === 'scratch' && change.name === 'before_name'),
    'round-60: catalog-change evidence includes the parsed destination identity');
}

console.log(`apply-time-dml-lib: ${pass} assertions passed`);
