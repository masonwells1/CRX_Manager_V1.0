#!/usr/bin/env node
// Tests for actor-binding-check.mjs — the write-time half of the actor-forgery
// sweeps (predicates/actor-forgery.sql, predicates/actor-forgery-fin-audit.sql).
// Spawns the real hook with crafted Write-tool stdin payloads.
// Run: node .claude/hooks/actor-binding-check.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }
function eq(a, b, m) { assert.equal(a, b, m); pass++; }

function runToolInput(toolInput) {
  const payload = { tool_input: toolInput };
  return spawnSync(process.execPath, [path.join(__dirname, "actor-binding-check.mjs")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
}
function runHook(content, filePath = "supabase/migrations/20260807000000_test.sql") {
  return runToolInput({ file_path: filePath, content });
}
function isDeny(r) { return r.stdout.includes('"permissionDecision":"deny"'); }

// fn(body, params, security) — `security` goes in the attribute region between
// the closing paren and AS, exactly where SECURITY DEFINER really sits.
function fn(body, params = "p_performed_by uuid", security = "SECURITY DEFINER") {
  return `CREATE OR REPLACE FUNCTION public.test_fn(${params}) RETURNS jsonb LANGUAGE plpgsql ${security} SET search_path TO 'public', 'pg_temp' AS $function$\n${body}\n$function$;`;
}

const MUTATION = "INSERT INTO financial_audit_log (actor_user_id) VALUES (p_performed_by);";
const BOUND = `
  v_actor := auth.uid();
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must equal auth.uid()';
  END IF;
  INSERT INTO financial_audit_log (actor_user_id) VALUES (v_actor);
`;

// ── scope: only migration .sql files ───────────────────────────────────────
let r = runHook(fn(MUTATION), "src/pages/Foo.tsx");
eq(r.status, 0, "non-migration file exits 0");
ok(!isDeny(r), "non-.sql file never denied (allowed)");

r = runHook(fn(MUTATION), "supabase/functions/send-email/index.sql");
ok(!isDeny(r), ".sql outside supabase/migrations/ is out of scope (allowed)");

r = runHook("");
ok(!isDeny(r), "empty content allowed");

// ── POSITIVE: the bug class this hook exists for ───────────────────────────
r = runHook(fn(MUTATION));
ok(isDeny(r), "SECDEF + mutation + p_performed_by with no ACTOR_MISMATCH is BLOCKED");
ok(r.stdout.includes("ACTOR BINDING VIOLATION"), "block message is labelled");
ok(r.stdout.includes("p_performed_by"), "block message names the forgeable parameter");
ok(r.stdout.includes("20260617171500"), "block message cites the link_blend_ticket_to_order fix");

// the other two actor-parameter shapes the live predicates key on
r = runHook(fn("UPDATE invoices SET paid_amount_cents = 0 WHERE created_by = p_actor_id;", "p_actor_id uuid"));
ok(isDeny(r), "p_actor* shaped parameter is blocked");

r = runHook(fn("DELETE FROM payments WHERE created_by = p_user_id;", "p_user_id uuid"));
ok(isDeny(r), "p_user* shaped parameter is blocked");

r = runHook(fn(MUTATION, "p_created_by uuid"));
ok(isDeny(r), "p_<anything>by shaped parameter is blocked");

// actor param buried among others, with a parenthesised type in the list
r = runHook(fn(MUTATION, "p_invoice_id uuid, p_amount numeric(12,2), p_performed_by uuid DEFAULT NULL::uuid"));
ok(isDeny(r), "actor param found among multiple params incl. a parenthesised type");

// IN mode keyword before the name must not hide the parameter
r = runHook(fn(MUTATION, "IN p_performed_by uuid"));
ok(isDeny(r), "leading IN mode keyword does not hide the actor parameter");

// two functions in one migration: the second one is the offender
r = runHook(
  fn(BOUND, "p_performed_by uuid").replace("test_fn", "good_fn") +
  "\n" +
  fn(MUTATION, "p_performed_by uuid").replace("test_fn", "bad_fn"),
);
ok(isDeny(r), "a later offending function in the same file is still caught");
ok(r.stdout.includes("bad_fn"), "the offending function is the one named");

// ── NEGATIVE: correctly bound / out of scope / exempt ──────────────────────
r = runHook(fn(BOUND));
ok(!isDeny(r), "body raising ACTOR_MISMATCH is allowed");

r = runHook(fn(MUTATION, "p_performed_by uuid", "SECURITY INVOKER"));
ok(!isDeny(r), "SECURITY INVOKER function is out of scope (RLS still applies)");

r = runHook(fn(MUTATION, "p_performed_by uuid", ""));
ok(!isDeny(r), "function with no SECURITY clause (invoker default) is out of scope");

r = runHook(fn("SELECT * FROM invoices WHERE created_by = p_performed_by;"));
ok(!isDeny(r), "non-mutating SECDEF function is allowed even with an actor param");

r = runHook(fn(MUTATION, "p_invoice_id uuid, p_amount_cents bigint"));
ok(!isDeny(r), "SECDEF mutator with NO actor-shaped parameter is allowed");

r = runHook("-- actor-binding-check: exempt\n" + fn(MUTATION));
ok(!isDeny(r), "file-level exempt marker skips the check entirely");

// Edit-tool payloads use new_string rather than content
r = spawnSync(process.execPath, [path.join(__dirname, "actor-binding-check.mjs")], {
  input: JSON.stringify({ tool_input: { file_path: "supabase/migrations/20260807000000_test.sql", new_string: fn(MUTATION) } }),
  encoding: "utf8",
});
ok(isDeny(r), "Edit-tool new_string payload is checked the same as Write content");

// A real Edit carries only the changed body fragment. Reconstruct the full
// on-disk migration so the existing function header, parameters, and SECURITY
// DEFINER attribute remain visible to the unchanged actor-binding analysis.
const editFixtureRoot = mkdtempSync(path.join(tmpdir(), "crx-actor-binding-edit-"));
try {
  const editFixtureDir = path.join(editFixtureRoot, "supabase", "migrations");
  mkdirSync(editFixtureDir, { recursive: true });
  const editFixturePath = path.join(editFixtureDir, "20260904000000_partial_edit.sql");
  const harmlessBody = "PERFORM 1;";
  writeFileSync(editFixturePath, fn(harmlessBody).replace(/\n/g, "\r\n"));

  r = runToolInput({
    file_path: editFixturePath,
    old_string: harmlessBody,
    new_string: MUTATION,
  });
  ok(isDeny(r), "partial Edit is reconstructed and blocks an unsafe actor write");

  r = runToolInput({
    file_path: editFixturePath,
    edits: [{ old_string: harmlessBody, new_string: MUTATION }],
  });
  ok(isDeny(r), "MultiEdit is reconstructed and blocks an unsafe actor write");

  r = runToolInput({
    file_path: editFixturePath,
    old_string: harmlessBody,
    new_string: "PERFORM 2;",
  });
  ok(!isDeny(r), "benign partial Edit remains allowed");

  writeFileSync(editFixturePath, `-- actor-binding-check: exempt\r\n${fn(harmlessBody).replace(/\n/g, "\r\n")}`);
  r = runToolInput({
    file_path: editFixturePath,
    old_string: harmlessBody,
    new_string: MUTATION,
  });
  ok(!isDeny(r), "existing file-level exemption remains visible during a partial Edit");
} finally {
  rmSync(editFixtureRoot, { recursive: true, force: true });
}

// malformed JSON on stdin must fail OPEN, not crash the session
r = spawnSync(process.execPath, [path.join(__dirname, "actor-binding-check.mjs")], { input: "not json", encoding: "utf8" });
eq(r.status, 0, "malformed stdin exits 0 (fail-open)");
ok(!isDeny(r), "malformed stdin is allowed, never denied");

console.log(`actor-binding-check: ${pass} assertions passed`);
