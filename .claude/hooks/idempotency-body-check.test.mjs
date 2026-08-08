#!/usr/bin/env node
// Tests for idempotency-body-check.mjs, including FIX 6 (2026-07-13 audit —
// "idempotency unscoped-lookup variant" / restore_quote_version bug class).
// Spawns the real hook with crafted Write-tool stdin payloads.
// Run: node .claude/hooks/idempotency-body-check.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }
function eq(a, b, m) { assert.equal(a, b, m); pass++; }

function runHook(content, filePath = "supabase/migrations/20260713000000_test.sql") {
  const payload = { tool_input: { file_path: filePath, content } };
  return spawnSync(process.execPath, [path.join(__dirname, "idempotency-body-check.mjs")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
}
function isDeny(r) { return r.stdout.includes('"permissionDecision":"deny"'); }

function fn(body, params = "p_idempotency_key text DEFAULT NULL::text") {
  return `CREATE OR REPLACE FUNCTION public.test_fn(${params}) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$\n${body}\n$function$;`;
}

// ── pre-existing behavior: not a migration file / no content / exempt marker ──
let r = runHook("whatever", "src/pages/Foo.tsx");
eq(r.status, 0, "non-migration file exits 0");
ok(!isDeny(r), "non-.sql file never denied (allowed)");

r = runHook("-- idempotency-body-check: exempt\n" + fn("INSERT INTO idempotency_keys (idempotency_key) VALUES (p_idempotency_key);"));
ok(!isDeny(r), "file-level exempt marker skips the check entirely");

// ── existing half-wired behavior (unchanged) ───────────────────────────────
r = runHook(fn(`
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result FROM check_idempotency(p_idempotency_key, 'test_fn');
  END IF;
  INSERT INTO customers (name) VALUES ('x');
`));
ok(isDeny(r), "half-wired (check but no save helper) still blocked");

r = runHook(fn(`
  INSERT INTO customers (name) VALUES ('x');
  PERFORM save_idempotency(p_idempotency_key, 'test_fn', '{}'::jsonb);
`));
ok(isDeny(r), "half-wired (save but no check helper) still blocked");

r = runHook(fn(`
  UPDATE customers SET name = 'x' WHERE id = 1;
`));
ok(isDeny(r), "declares p_idempotency_key, mutates, but never touches idempotency_keys at all — still blocked");

// non-mutating function with the param declared: allowed (existing behavior)
r = runHook(fn(`SELECT p_idempotency_key;`));
ok(!isDeny(r), "no mutation in body — allowed regardless of idempotency wiring");

// ── FIX 6: direct pattern, UNSCOPED lookup (restore_quote_version bug class) ──
r = runHook(fn(`
  DECLARE v_existing text;
  BEGIN
  SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key;
  INSERT INTO customers (name) VALUES ('x');
  INSERT INTO idempotency_keys (idempotency_key, operation, result) VALUES (p_idempotency_key, 'test_fn', '{}');
  END;
`));
ok(isDeny(r), "direct lookup with NO operation filter is blocked (FIX 6)");
ok(r.stdout.includes("restore_quote_version"), "block message cites the restore_quote_version bug class");

// ── FIX 6: direct pattern, SCOPED lookup — allowed ──────────────────────────
r = runHook(fn(`
  DECLARE v_existing text;
  BEGIN
  SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key AND operation = 'test_fn';
  INSERT INTO customers (name) VALUES ('x');
  INSERT INTO idempotency_keys (idempotency_key, operation, result) VALUES (p_idempotency_key, 'test_fn', '{}');
  END;
`));
ok(!isDeny(r), "direct lookup WITH an operation filter is allowed");

// ── FIX 6: helper pattern, check_idempotency() called with NO operation arg ──
r = runHook(fn(`
  DECLARE v_existing jsonb;
  BEGIN
  SELECT result INTO v_existing FROM (SELECT check_idempotency(p_idempotency_key) AS result) x;
  INSERT INTO customers (name) VALUES ('x');
  PERFORM save_idempotency(p_idempotency_key, 'test_fn', '{}'::jsonb);
  END;
`));
ok(isDeny(r), "check_idempotency() called with only 1 arg (no operation) is blocked (FIX 6)");
ok(r.stdout.includes("restore_quote_version"), "helper-pattern block message also cites restore_quote_version");

// ── FIX 6: helper pattern, check_idempotency() called WITH operation arg ────
r = runHook(fn(`
  DECLARE v_existing jsonb;
  BEGIN
  SELECT check_idempotency(p_idempotency_key, 'test_fn') INTO v_existing;
  INSERT INTO customers (name) VALUES ('x');
  PERFORM save_idempotency(p_idempotency_key, 'test_fn', '{}'::jsonb);
  END;
`));
ok(!isDeny(r), "check_idempotency() called with an operation literal is allowed");

// operation-bearing PARAMETER (not a literal) also satisfies the scoping check
r = runHook(fn(`
  DECLARE v_existing jsonb;
  BEGIN
  SELECT check_idempotency(p_idempotency_key, v_operation_name) INTO v_existing;
  INSERT INTO customers (name) VALUES ('x');
  PERFORM save_idempotency(p_idempotency_key, v_operation_name, '{}'::jsonb);
  END;
`));
ok(!isDeny(r), "check_idempotency() called with an operation-bearing parameter is allowed");

// ── Codex P1 2026-07-13: mismatched check/save operation LITERALS — the saved
//    result is never found on retry, so the mutation replays every time ───────
r = runHook(fn(`
  DECLARE v_existing jsonb;
  BEGIN
  SELECT check_idempotency(p_idempotency_key, 'wrong_op') INTO v_existing;
  INSERT INTO customers (name) VALUES ('x');
  PERFORM save_idempotency(p_idempotency_key, 'test_fn', '{}'::jsonb);
  END;
`));
ok(isDeny(r), "mismatched check/save operation literals are blocked");
ok(r.stdout.includes("mismatched") || r.stdout.includes("NEVER found"), "mismatch block message explains the replay consequence");

// mixed literal + parameter: conservative, allowed (reviewers own non-literal cases)
r = runHook(fn(`
  DECLARE v_existing jsonb;
  BEGIN
  SELECT check_idempotency(p_idempotency_key, 'test_fn') INTO v_existing;
  INSERT INTO customers (name) VALUES ('x');
  PERFORM save_idempotency(p_idempotency_key, v_operation_name, '{}'::jsonb);
  END;
`));
ok(!isDeny(r), "literal check + parameterized save is left to reviewers (allowed)");

// Codex P2 round 3: EVERY pairing must close — a shared literal is not enough.
r = runHook(fn(`
  DECLARE v_existing jsonb;
  BEGIN
  SELECT check_idempotency(p_idempotency_key, 'op_a') INTO v_existing;
  SELECT check_idempotency(p_idempotency_key, 'op_b') INTO v_existing;
  INSERT INTO customers (name) VALUES ('x');
  PERFORM save_idempotency(p_idempotency_key, 'op_a', '{}'::jsonb);
  PERFORM save_idempotency(p_idempotency_key, 'op_c', '{}'::jsonb);
  END;
`));
ok(isDeny(r), "partial intersection (op_b unchecked-save op_c) is still blocked");

r = runHook(fn(`
  DECLARE v_existing jsonb;
  BEGIN
  SELECT check_idempotency(p_idempotency_key, 'op_a') INTO v_existing;
  SELECT check_idempotency(p_idempotency_key, 'op_b') INTO v_existing;
  INSERT INTO customers (name) VALUES ('x');
  PERFORM save_idempotency(p_idempotency_key, 'op_a', '{}'::jsonb);
  PERFORM save_idempotency(p_idempotency_key, 'op_b', '{}'::jsonb);
  END;
`));
ok(!isDeny(r), "two fully-closed operation pairings are allowed");

// ── balanced-paren regression: a parenthesised type (numeric(12,2)) BEFORE
//    p_idempotency_key must not truncate the parameter list. The old [^)]*?
//    capture stopped at numeric(12,2)'s inner ')', so the guard never saw
//    p_idempotency_key and silently allowed an unwired mutating function. ──────
r = runHook(fn(`
  UPDATE customers SET credit_cents = p_amount WHERE id = 1;
`, "p_amount numeric(12,2), p_idempotency_key text DEFAULT NULL::text"));
ok(isDeny(r), "numeric(12,2) before p_idempotency_key: unwired mutation is still blocked (balanced-paren scan)");

// same parameter shape, correctly helper-wired: allowed
r = runHook(fn(`
  DECLARE v_existing jsonb;
  BEGIN
  SELECT check_idempotency(p_idempotency_key, 'test_fn') INTO v_existing;
  UPDATE customers SET credit_cents = p_amount WHERE id = 1;
  PERFORM save_idempotency(p_idempotency_key, 'test_fn', '{}'::jsonb);
  END;
`, "p_amount numeric(12,2), p_idempotency_key text DEFAULT NULL::text"));
ok(!isDeny(r), "numeric(12,2) before p_idempotency_key: correctly wired function is allowed");

// ── Codex P2 (PR #335): an SQL comment inside the parameter list containing an
//    unmatched '(' must not desync the depth count — the scan would never close,
//    parse would fail, and the unwired function would be silently ALLOWED. ─────
r = runHook(fn(`
  UPDATE customers SET name = 'x' WHERE id = 1;
`, "p_amount numeric, -- retained for normalization (\n  p_idempotency_key text DEFAULT NULL::text"));
ok(isDeny(r), "unmatched '(' in a -- parameter comment: unwired mutation is still blocked");

r = runHook(fn(`
  UPDATE customers SET name = 'x' WHERE id = 1;
`, "p_amount numeric, /* legacy (see #335 */ p_idempotency_key text DEFAULT NULL::text"));
ok(isDeny(r), "unmatched '(' in a /* */ parameter comment: unwired mutation is still blocked");

// nested block comment (PostgreSQL nests /* /* */ */) with an unmatched '(' —
// a non-nesting skip stops at the inner */ and desyncs the depth count
r = runHook(fn(`
  UPDATE customers SET name = 'x' WHERE id = 1;
`, "p_amount numeric, /* outer /* inner */ unmatched ( */ p_idempotency_key text DEFAULT NULL::text"));
ok(isDeny(r), "unmatched '(' in a NESTED block comment: unwired mutation is still blocked");

// dollar-quoted DEFAULT literal containing '(' before p_idempotency_key
r = runHook(fn(`
  UPDATE customers SET name = 'x' WHERE id = 1;
`, "p_note text DEFAULT $d$normalize ($d$, p_idempotency_key text DEFAULT NULL::text"));
ok(isDeny(r), "unmatched '(' inside a dollar-quoted default: unwired mutation is still blocked");

// E-string default with a backslash-escaped quote and an unmatched '(' —
// closing string state at the escaped quote counts the data '(' as syntax
r = runHook(fn(`
  UPDATE customers SET name = 'x' WHERE id = 1;
`, "p_note text DEFAULT E'can\\'t (', p_idempotency_key text DEFAULT NULL::text"));
ok(isDeny(r), "unmatched '(' after an escaped quote in an E-string default: unwired mutation is still blocked");

// fail-CLOSED backstop: a parameter list the lexer cannot close (here, an
// unterminated dollar-quote) blocks instead of silently skipping the function
r = runHook(fn(`
  UPDATE customers SET name = 'x' WHERE id = 1;
`, "p_note text DEFAULT $broken$never closed, p_idempotency_key text DEFAULT NULL::text"));
ok(isDeny(r), "unparseable parameter list fails CLOSED, not silently allowed");
ok(r.stdout.includes("could not parse"), "fail-closed message explains the parse failure");

// ── Codex P2 round 4a: a COMMENTED-OUT function header must not be scanned as
//    live DDL — its unmatched '(' tripped the fail-closed deny on a VALID file ─
r = runHook("-- legacy: CREATE FUNCTION public.old_rpc(\n" + fn(`
  DECLARE v_existing jsonb;
  BEGIN
  SELECT check_idempotency(p_idempotency_key, 'test_fn') INTO v_existing;
  INSERT INTO customers (name) VALUES ('x');
  PERFORM save_idempotency(p_idempotency_key, 'test_fn', '{}'::jsonb);
  END;
`));
ok(!isDeny(r), "commented-out CREATE FUNCTION header does not false-positive the fail-closed path");

// ── Codex P2 round 4b: E-string with a DOUBLED quote then a backslash-escaped
//    quote — closing on the doubled pair cleared escape mode and desynced ──────
r = runHook(fn(`
  DECLARE v_existing jsonb;
  BEGIN
  SELECT check_idempotency(p_idempotency_key, 'test_fn') INTO v_existing;
  UPDATE customers SET name = 'x' WHERE id = 1;
  PERFORM save_idempotency(p_idempotency_key, 'test_fn', '{}'::jsonb);
  END;
`, "p_note text DEFAULT E'it''s \\'open (', p_idempotency_key text DEFAULT NULL::text"));
ok(!isDeny(r), "E-string mixing doubled and backslash-escaped quotes: wired function is allowed (no parse false-positive)");

// ── CodeRabbit Major (PR #335): "AS $fake$...$fake$" inside a comment between
//    the parameter list and the real body must not be read as the body — the old
//    unbounded regex latched onto it and could skip a later REAL function ──────
r = runHook(fn(`
  UPDATE customers SET name = 'x' WHERE id = 1;
`).replace(
  "SECURITY DEFINER",
  "SECURITY DEFINER /* legacy shim: AS $fake$ SELECT 1; $fake$ */"
));
ok(isDeny(r), "fake AS $tag$ inside a comment is ignored — the REAL unwired body is still blocked");

// ── Codex P2 round 5a: a 63+-char dollar-quote tag overflowed the bounded
//    64-char match window, the body reader returned null, and the unwired
//    function was silently ALLOWED ─────────────────────────────────────────────
const longTag = "$" + "t".repeat(70) + "$";
r = runHook(fn(`
  UPDATE customers SET name = 'x' WHERE id = 1;
`).replaceAll("$function$", longTag));
ok(isDeny(r), "70-char dollar-quote tag: unwired mutation is still blocked (no tag-length cap)");

// ── Codex P2 round 5b: '$' is valid INSIDE a PostgreSQL identifier — foo$bar$
//    must not be lexed as a dollar-quote opener (it denied the whole file) ─────
r = runHook(fn(`
  DECLARE v_existing jsonb;
  BEGIN
  SELECT check_idempotency(p_idempotency_key, 'test_fn') INTO v_existing;
  UPDATE customers SET name = 'x' WHERE id = 1;
  PERFORM save_idempotency(p_idempotency_key, 'test_fn', '{}'::jsonb);
  END;
`) + "\nCREATE INDEX idx_foo$bar$ ON customers (name);\n");
ok(!isDeny(r), "top-level identifier containing dollar signs (idx_foo$bar$) does not false-positive the lexer");

// ── Codex P2 round 6: "CREATE FUNCTION foo(" inside a STRING literal must not
//    be scanned as live DDL — it tripped the fail-closed deny on valid files ───
const wiredFn = fn(`
  DECLARE v_existing jsonb;
  BEGIN
  SELECT check_idempotency(p_idempotency_key, 'test_fn') INTO v_existing;
  UPDATE customers SET name = 'x' WHERE id = 1;
  PERFORM save_idempotency(p_idempotency_key, 'test_fn', '{}'::jsonb);
  END;
`);
r = runHook("SELECT 'legacy CREATE FUNCTION public.old_rpc(';\n" + wiredFn);
ok(!isDeny(r), "CREATE FUNCTION text inside a top-level string literal is not scanned as DDL");

r = runHook("DO $do$ BEGIN RAISE NOTICE 'legacy CREATE FUNCTION public.old_rpc('; END $do$;\n" + wiredFn);
ok(!isDeny(r), "CREATE FUNCTION text inside a RAISE NOTICE string in a DO block is not scanned as DDL");

// masking must NOT hide the operation literals the FIX 6 checks read — a
// mismatched check/save pair is still caught after the masking rework
r = runHook(fn(`
  DECLARE v_existing jsonb;
  BEGIN
  SELECT check_idempotency(p_idempotency_key, 'wrong_op') INTO v_existing;
  INSERT INTO customers (name) VALUES ('x');
  PERFORM save_idempotency(p_idempotency_key, 'test_fn', '{}'::jsonb);
  END;
`));
ok(isDeny(r), "operation literals inside the body survive masking (mismatch still blocked)");

// ── Codex P2 round 7: an ordinary dollar-quoted LITERAL is opaque data — lexing
//    its payload as SQL saw $q$can't$q$'s quote as unterminated and denied the
//    whole valid migration. Only AS/DO bodies are recursed now. ────────────────
r = runHook("SELECT $q$can't$q$;\n" + wiredFn);
ok(!isDeny(r), "dollar-quoted literal payload with a lone quote is opaque (no false deny)");

r = runHook("SELECT $q$/* not a comment$q$;\n" + wiredFn);
ok(!isDeny(r), "dollar-quoted literal payload with a lone /* is opaque (no false deny)");

// the AS/DO carve-out must NOT hide nested DDL: an unwired function created
// INSIDE a DO block is still scanned and blocked
r = runHook(`DO $do$
BEGIN
  CREATE OR REPLACE FUNCTION public.nested_fn(p_idempotency_key text DEFAULT NULL::text)
  RETURNS void LANGUAGE plpgsql AS $inner$
  BEGIN
    UPDATE customers SET name = 'x' WHERE id = 1;
  END;
  $inner$;
END;
$do$;`);
ok(isDeny(r), "unwired CREATE FUNCTION nested inside a DO block is still scanned and blocked");

// ── Codex P2 round 8: dynamic DDL — EXECUTE $ddl$CREATE FUNCTION...$ddl$ — was
//    masked as opaque data, hiding an unwired dynamically created RPC ──────────
r = runHook(`DO $do$
BEGIN
  EXECUTE $ddl$
    CREATE OR REPLACE FUNCTION public.dyn_fn(p_idempotency_key text DEFAULT NULL::text)
    RETURNS void LANGUAGE plpgsql AS $inner$
    BEGIN
      UPDATE customers SET name = 'x' WHERE id = 1;
    END;
    $inner$;
  $ddl$;
END;
$do$;`);
ok(isDeny(r), "unwired CREATE FUNCTION inside EXECUTE dollar-quoted DDL is still scanned and blocked");

// format()-built DDL: the payload is not EXECUTE-adjacent but contains a
// CREATE FUNCTION header — the content trigger must still recurse into it
r = runHook(`DO $do$
BEGIN
  EXECUTE format($fmt$
    CREATE OR REPLACE FUNCTION public.dyn_fn(p_idempotency_key text DEFAULT NULL::text)
    RETURNS void LANGUAGE plpgsql AS $inner$
    BEGIN
      UPDATE customers SET name = 'x' WHERE id = 1;
    END;
    $inner$;
  $fmt$);
END;
$do$;`);
ok(isDeny(r), "unwired CREATE FUNCTION inside EXECUTE format() dollar-quoted DDL is still scanned and blocked");

// ── Codex P2 round 9: dynamic DDL in ORDINARY string form — EXECUTE 'CREATE
//    FUNCTION...' never reached the dollar-payload carve-out, so the header
//    stayed masked and an unwired dynamically created RPC slipped through ─────
r = runHook(`DO $do$ BEGIN
  EXECUTE 'CREATE OR REPLACE FUNCTION public.dyn_sq(p_customer uuid, p_idempotency_key text DEFAULT NULL::text) RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN UPDATE invoices SET total_cents = 0 WHERE customer_id = p_customer; END $fn$;';
END $do$;`);
ok(isDeny(r), "unwired CREATE FUNCTION inside EXECUTE '...' single-quoted DDL is still scanned and blocked");

// EXECUTE of dynamic non-DDL stays allowed — recursion must not turn ordinary
// dynamic SQL into a false positive
r = runHook(`DO $do$ BEGIN EXECUTE 'UPDATE settings SET v = 1'; END $do$;`);
ok(!isDeny(r), "EXECUTE of single-quoted dynamic SQL without a CREATE FUNCTION stays allowed");



// ── Codex P2 round 10 (a): dynamic DDL whose literal is not DIRECTLY after
//    EXECUTE / EXECUTE format( — a parenthesised EXECUTE argument, or any
//    non-first format() argument — was opaque data, so an unwired dynamically
//    created RPC was invisible (fail-open) ───────────────────────────────────
const UNWIRED_DDL = "CREATE OR REPLACE FUNCTION public.dyn_r10(p_idempotency_key text DEFAULT NULL::text) " +
  "RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN UPDATE invoices SET total_cents = 0; END $fn$;";

r = runHook(`DO $do$ BEGIN EXECUTE ('${UNWIRED_DDL}'); END $do$;`);
ok(isDeny(r), "unwired CREATE FUNCTION inside a parenthesised EXECUTE ('...') is scanned and blocked");

r = runHook(`DO $do$ BEGIN EXECUTE format('%s', '${UNWIRED_DDL}'); END $do$;`);
ok(isDeny(r), "unwired CREATE FUNCTION in a NON-first format() argument is scanned and blocked");

r = runHook(`DO $do$ BEGIN EXECUTE format('%s', $ddl$${UNWIRED_DDL}$ddl$); END $do$;`);
ok(isDeny(r), "unwired CREATE FUNCTION in a non-first format() dollar-quoted argument is scanned and blocked");

// ── Codex P2 round 10 (b): opaque DATA must not be lexed as SQL. A literal
//    that merely MENTIONS "CREATE FUNCTION" and contains an apostrophe read as
//    an unterminated string and denied the whole migration (false-deny) ──────
r = runHook(`DO $do$ BEGIN
  INSERT INTO notes (body) VALUES ($q$you can't CREATE FUNCTION here$q$);
END $do$;`);
ok(!isDeny(r), "dollar-quoted DATA mentioning CREATE FUNCTION with an apostrophe is opaque, not a parse failure");

r = runHook(`DO $do$ BEGIN
  INSERT INTO notes (body) VALUES ($q$CREATE FUNCTION docs say don't do this$q$);
  UPDATE settings SET v = 1;
END $do$;`);
ok(!isDeny(r), "prose payload without p_idempotency_key is never treated as live DDL");

r = runHook(`DO $do$ BEGIN EXECUTE 'UPDATE settings SET note = ''don''''t'''; END $do$;`);
ok(!isDeny(r), "doubled quotes inside an EXECUTE literal do not read as an unterminated string");

// the fail-CLOSED behavior at the OUTER level is unchanged by the inner fallback
r = runHook(`CREATE OR REPLACE FUNCTION public.broken(p_idempotency_key text DEFAULT NULL::text)
RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN UPDATE customers SET name = 'x; END $fn$;`);
ok(isDeny(r), "a genuinely unterminated string at the top level still fails CLOSED");

// a correctly wired function created dynamically is still allowed
r = runHook(`DO $do$ BEGIN EXECUTE ('CREATE OR REPLACE FUNCTION public.dyn_ok(p_idempotency_key text DEFAULT NULL::text) ` +
  `RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN PERFORM check_idempotency(p_idempotency_key, ''dyn_ok''); ` +
  `UPDATE invoices SET total_cents = 0; PERFORM save_idempotency(p_idempotency_key, ''dyn_ok'', ''{}''::jsonb); END $fn$;'); END $do$;`);
ok(!isDeny(r), "correctly wired dynamically created function stays allowed");


// isolates the p_idempotency_key narrowing: a doc literal that merely mentions
// CREATE FUNCTION and has an unbalanced paren must stay opaque, not be lexed as
// a header the paren-scanner then fails (and fail-closed) on
r = runHook(`DO $do$ BEGIN
  INSERT INTO docs (body) VALUES ($doc$See CREATE FUNCTION public.foo( -- args vary by version
$doc$);
END $do$;`);
ok(!isDeny(r), "doc literal mentioning CREATE FUNCTION without p_idempotency_key is never lexed as DDL");

// isolates the doubled-quote unescape: without it the DDL payload reads as an
// unterminated string and the unwired function goes UNDETECTED (fail-open)
r = runHook(`DO $do$ BEGIN EXECUTE 'CREATE OR REPLACE FUNCTION public.dyn_q(p_idempotency_key text DEFAULT NULL::text) RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN RAISE NOTICE ''starting''; UPDATE invoices SET total_cents = 0; END $fn$;'; END $do$;`);
ok(isDeny(r), "unwired dynamic DDL containing doubled-quote literals is still detected");

// isolates the STRING-branch content gate: a money literal like $5$ inside
// dynamic SQL looks like a dollar-quote opener with no closer. The literal
// carries no CREATE FUNCTION header, so it is never lexed as SQL at all.
r = runHook(`EXECUTE 'INSERT INTO docs (body) VALUES (''costs $5$ each'')';`);
ok(!isDeny(r), "a dynamic string payload with no CREATE FUNCTION header is masked opaque, never lexed");

// isolates the DOLLAR-branch content gate: prose that mentions both
// CREATE FUNCTION and p_idempotency_key, apostrophe and all, is not a header
r = runHook(`INSERT INTO docs (body) VALUES ($doc$Always pass p_idempotency_key when you CREATE FUNCTION — don't skip it$doc$);`);
ok(!isDeny(r), "prose mentioning CREATE FUNCTION is not a header and is never lexed as DDL");

// --- Round 11 (Codex review of the merged round-10 commit) -----------------

// P2-1 fail-open: an EXECUTE payload the lexer cannot read used to be blanked,
// which ERASED real DDL and let an unwired mutating function through.
r = runHook(`DO $do$ BEGIN EXECUTE 'CREATE OR REPLACE FUNCTION public.dyn_fo(p_idempotency_key text DEFAULT NULL::text, p_note text DEFAULT ''costs $5$ each'') RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN UPDATE invoices SET total_cents = 0; END $fn$;'; END $do$;`);
ok(isDeny(r), "an executable EXECUTE payload the lexer cannot read fails CLOSED, never masked away");

// P2-1 counterpart: the same fail-closed rule must not fire on a payload that
// is data — the content gate keeps it out of the lexer entirely.
r = runHook(`DO $do$ BEGIN EXECUTE format('INSERT INTO docs (body) VALUES (%L)', 'a note about $5$ prices'); END $do$;`);
ok(!isDeny(r), "a data argument in an EXECUTE statement is not lexed and cannot fail closed");

// P2-3 false-deny: a %L data argument that happens to contain function-shaped
// prose must not be scanned as executable SQL.
r = runHook(`DO $do$ BEGIN EXECUTE format('INSERT INTO docs (body) VALUES (%L)', 'we don''t allow that'); END $do$;`);
ok(!isDeny(r), "an apostrophe in an EXECUTE data argument does not deny the migration");

// P2-2 fail-open: DDL glued together from fragments is unlexable by
// construction — no fragment holds a complete parameter list — so it must be
// refused rather than silently skipped.
r = runHook(`DO $do$
DECLARE v_ddl text;
BEGIN
  v_ddl := $a$CREATE OR REPLACE FUNCTION public.dyn_cat(p_amount_cents integer$a$ || $b$, p_idempotency_key text DEFAULT NULL::text) RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN UPDATE invoices SET total_cents = 0; END $fn$;$b$;
  EXECUTE v_ddl;
END $do$;`);
ok(isDeny(r), "CREATE FUNCTION assembled by concatenating literals is refused, not silently skipped");

// the concat guard is statement-scoped and header-shaped: ordinary string
// building in a migration must stay allowed.
r = runHook(`DO $do$ DECLARE v_msg text; BEGIN v_msg := 'total: ' || 'ok'; EXECUTE 'ANALYZE invoices'; END $do$;`);
ok(!isDeny(r), "ordinary || string building near an EXECUTE is not treated as assembled DDL");

// --- Round 11b (Codex push-proof gate BLOCKED the first round-11 attempt) ---

// PostgreSQL concatenates two literals separated by nothing but a newline, so
// a ||-only check was bypassed by simply deleting the operator.
r = runHook(`DO $do$
DECLARE v_ddl text;
BEGIN
  v_ddl := $a$CREATE OR REPLACE FUNCTION public.dyn_adj(p_amount_cents integer$a$
$b$, p_idempotency_key text DEFAULT NULL::text) RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN UPDATE invoices SET total_cents = 0; END $fn$;$b$;
  EXECUTE v_ddl;
END $do$;`);
ok(isDeny(r), "DDL split across ADJACENT literals (no ||) is refused, not just the || form");

// payload content alone must not make a literal executable: a plain INSERT of
// documentation is not a dynamic-SQL context, whatever the text looks like
r = runHook(`INSERT INTO docs (body) VALUES ($doc$CREATE OR REPLACE FUNCTION public.example(p_idempotency_key text) — priced at $5$ per call$doc$);`);
ok(!isDeny(r), "a function-shaped example in a plain INSERT is data, not executable SQL");

// --- Round 11c (Codex push-proof gate blocked round-11b) -------------------

// the same split trick, with the fragments as separate format() ARGUMENTS —
// a comma between them, so the whitespace/|| adjacency rule missed it
r = runHook(`DO $do$ BEGIN
  EXECUTE format('%s%s', 'CREATE OR REPLACE FUNCTION public.probe(', 'p_idempotency_key text DEFAULT NULL::text) RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN UPDATE invoices SET total_cents = 0; END $fn$;');
END $do$;`);
ok(isDeny(r), "DDL split across separate format() arguments is refused");

// ...but a COMPLETE signature in one format() argument is still lexed normally
// and judged on its wiring, not refused as assembled
r = runHook(`DO $do$ BEGIN
  EXECUTE format('%s', 'CREATE OR REPLACE FUNCTION public.wired_fmt(p_idempotency_key text DEFAULT NULL::text) RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN PERFORM check_idempotency(p_idempotency_key, ''wired_fmt''); UPDATE invoices SET total_cents = 0; PERFORM save_idempotency(p_idempotency_key, ''wired_fmt'', NULL); END $fn$;');
END $do$;`);
ok(!isDeny(r), "a complete, correctly wired signature in one format() argument is still allowed");

// --- Round 12 (Codex push-proof gate blocked round-11c) --------------------

// H1: `:=` is not the only assignment form. SELECT ... INTO builds dynamic DDL
// just as well, and an unwired mutating RPC written that way slipped through.
r = runHook(`DO $do$
DECLARE v_ddl text;
BEGIN
  SELECT $ddl$CREATE OR REPLACE FUNCTION public.dyn_into(p_idempotency_key text DEFAULT NULL::text) RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN UPDATE invoices SET total_cents = 0; END $fn$;$ddl$ INTO v_ddl;
  EXECUTE v_ddl;
END $do$;`);
ok(isDeny(r), "an unwired RPC assembled via SELECT ... INTO is refused, not masked as data");

// H1, second form: plain `=` assignment (PL/pgSQL accepts it alongside `:=`)
r = runHook(`DO $do$
DECLARE v_ddl text;
BEGIN
  v_ddl = $ddl$CREATE OR REPLACE FUNCTION public.dyn_eq(p_idempotency_key text DEFAULT NULL::text) RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN UPDATE invoices SET total_cents = 0; END $fn$;$ddl$;
  EXECUTE v_ddl;
END $do$;`);
ok(isDeny(r), "an unwired RPC assigned with plain = is refused, not masked as data");

// ...and the same shape, correctly wired, must still be allowed
r = runHook(`DO $do$
DECLARE v_ddl text;
BEGIN
  SELECT $ddl$CREATE OR REPLACE FUNCTION public.wired_into(p_idempotency_key text DEFAULT NULL::text) RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN PERFORM check_idempotency(p_idempotency_key, 'wired_into'); UPDATE invoices SET total_cents = 0; PERFORM save_idempotency(p_idempotency_key, 'wired_into', NULL); END $fn$;$ddl$ INTO v_ddl;
  EXECUTE v_ddl;
END $do$;`);
ok(!isDeny(r), "a correctly wired RPC built via SELECT ... INTO is still allowed");

// H2: the split can fall INSIDE the header itself, so the fragments must be
// concatenated before classification — the raw source slice keeps the quotes
// and the || and never matched.
r = runHook(`DO $do$ BEGIN
  EXECUTE 'CREATE OR REPLACE ' || 'FUNCTION public.split_header(' || 'p_idempotency_key text DEFAULT NULL::text) RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN UPDATE invoices SET total_cents = 0; END $fn$;';
END $do$;`);
ok(isDeny(r), "DDL split INSIDE the CREATE FUNCTION header is refused");

// M1: a %L argument is data that Postgres quotes — never code. Lexing it as SQL
// hit its `$5$` and denied a perfectly valid migration.
r = runHook(`DO $do$ BEGIN
  EXECUTE format('INSERT INTO docs (body) VALUES (%L)', 'CREATE OR REPLACE FUNCTION public.example(p_idempotency_key text) priced at $5$ per call');
END $do$;`);
ok(!isDeny(r), "a %L data argument is never lexed as SQL, even when function-shaped");

console.log(`idempotency-body-check: ${pass} assertions passed`);
