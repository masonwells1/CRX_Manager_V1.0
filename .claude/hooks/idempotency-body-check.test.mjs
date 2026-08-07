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

console.log(`idempotency-body-check: ${pass} assertions passed`);
