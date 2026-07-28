#!/usr/bin/env node
// Tests for hold-latch, live-testdata, and codex-push guard logic + inert-when-off behavior.
// Run: node .claude/hooks/guards.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isHoldPhrase, isResumePhrase, isBuildActionUnderHold } from "./hold-latch-lib.mjs";
import { classifySql } from "./live-testdata-lib.mjs";
import { isGitPush, pushTargetsMain, mainPushSource, riskyFiles, contentIsRisky, proofValid } from "./codex-push-lib.mjs";
import { DENY_TOOLNAME_RE } from "./autopilot-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }
function eq(a, b, m) { assert.equal(a, b, m); pass++; }

// ── hold-latch ───────────────────────────────────────────────────────────
ok(isHoldPhrase("lets just stop here, cancel all background work"), "stop+cancel");
ok(isHoldPhrase("pause this loop"), "pause");
ok(isHoldPhrase("im just scoping a future session, dont build yet"), "scope-only");
ok(!isHoldPhrase("build me the invoices page"), "normal build is not a hold");
ok(isResumePhrase("ok go ahead and continue"), "resume phrase");
ok(isBuildActionUnderHold("Edit", { file_path: "src/pages/Foo.tsx" }), "edit source blocked under hold");
ok(isBuildActionUnderHold("Bash", { command: "git commit -m x" }), "commit blocked under hold");
ok(isBuildActionUnderHold("mcp__supabase__apply_migration", {}), "apply blocked under hold");
ok(!isBuildActionUnderHold("Write", { file_path: ".claude/session-state/hold.json" }), "session-state write allowed");
ok(!isBuildActionUnderHold("Write", { file_path: "docs/SCOPE.md" }), "SCOPE.md allowed under hold");
ok(!isBuildActionUnderHold("Bash", { command: "npm run test" }), "tests allowed under hold");
ok(!isBuildActionUnderHold("Read", { file_path: "x" }), "read allowed under hold");

// ── hold-latch tool coverage (FIX 3, 2026-07-13) ─────────────────────────
// hold-latch's mutate-tool set must be a SUPERSET of autopilot's deny set —
// import the LIVE autopilot deny regex and assert every one of its alternatives
// is also caught by hold-latch, so the two lists can never silently drift apart.
{
  const denyAlts = DENY_TOOLNAME_RE.source.replace(/^\(|\)$/g, "").split("|");
  ok(denyAlts.length > 5, "sanity: parsed several deny alternatives out of autopilot-lib");
  for (const name of denyAlts) {
    ok(isBuildActionUnderHold(name, {}), `hold-latch covers autopilot deny-set tool: ${name}`);
  }
}
// hold-latch-only additions beyond autopilot's deny set (autopilot deliberately
// allows these unattended; a mid-session "stop" should still pause them).
ok(isBuildActionUnderHold("mcp__x__create_directory", {}), "create_directory blocked under hold");
ok(isBuildActionUnderHold("mcp__Desktop_Commander__kill_process", {}), "kill_process blocked under hold");
// Desktop Commander mutating tools specifically (2026-07-13 audit blind spot)
ok(isBuildActionUnderHold("mcp__Desktop_Commander__start_process", {}), "DC start_process blocked under hold");
ok(isBuildActionUnderHold("mcp__Desktop_Commander__interact_with_process", {}), "DC interact_with_process blocked under hold");
ok(isBuildActionUnderHold("mcp__Desktop_Commander__write_file", {}), "DC write_file blocked under hold");
ok(isBuildActionUnderHold("mcp__Desktop_Commander__edit_block", {}), "DC edit_block blocked under hold");
ok(isBuildActionUnderHold("mcp__Desktop_Commander__move_file", {}), "DC move_file blocked under hold");
ok(isBuildActionUnderHold("mcp__github__push_files", {}), "GitHub push_files blocked under hold");
ok(isBuildActionUnderHold("mcp__github__create_or_update_file", {}), "GitHub create_or_update_file blocked under hold");
ok(isBuildActionUnderHold("mcp__github__delete_file", {}), "GitHub delete_file blocked under hold");
ok(isBuildActionUnderHold("mcp__github__merge_pull_request", {}), "GitHub merge_pull_request blocked under hold");
ok(isBuildActionUnderHold("mcp__supabase__delete_branch", {}), "delete_branch blocked under hold");
ok(isBuildActionUnderHold("mcp__supabase__rebase_branch", {}), "rebase_branch blocked under hold");

// ── live-testdata ────────────────────────────────────────────────────────
ok(classifySql("INSERT INTO customers (name) VALUES ('Acme Farm')").block, "real customer insert blocked");
ok(!classifySql("INSERT INTO customers (name) VALUES ('[E2E] Farm Alpha')").block, "[E2E] insert allowed");
ok(classifySql("DELETE FROM invoices WHERE id = 5").block, "financial delete blocked");
ok(classifySql("UPDATE invoices SET status = 'voided' WHERE id = 5").block, "void real invoice blocked");
ok(!classifySql("SELECT * FROM invoices").block, "select allowed");
ok(!classifySql("INSERT INTO some_log_table (x) VALUES (1)").block, "non-business table allowed");
eq(classifySql("INSERT INTO orders (x) VALUES (1)").kind, "real-insert", "kind reported");

// ── live-testdata side-door closures (2026-07-04) ────────────────────────
ok(classifySql("CREATE OR REPLACE FUNCTION public.f() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql;").block, "raw CREATE FUNCTION blocked");
eq(classifySql("ALTER TABLE invoices ADD COLUMN x text;").kind, "raw-ddl", "raw ALTER TABLE blocked as raw-ddl");
ok(classifySql("DROP POLICY IF EXISTS p ON public.orders;").block, "raw DROP POLICY blocked");
ok(classifySql("GRANT EXECUTE ON FUNCTION public.f() TO anon;").block, "raw GRANT blocked");
ok(classifySql("REVOKE EXECUTE ON FUNCTION public.f() FROM anon;").block, "raw REVOKE blocked");
ok(!classifySql("BEGIN; CREATE TABLE t (id int); ROLLBACK;").block, "rolled-back smoke DDL allowed");
ok(classifySql("BEGIN; CREATE TABLE t (id int); COMMIT;").block, "committed DDL blocked");
ok(!classifySql("DO $$ BEGIN PERFORM 1; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;").block, "SMOKE_PASS_ROLLBACK force-rollback pattern allowed");
// Codex 2026-07-05 P1: textual rollback markers must NOT qualify — only structural ones
ok(classifySql("CREATE TABLE public.x(id int); SELECT 'SMOKE_PASS_ROLLBACK';").block, "string-literal SMOKE_PASS_ROLLBACK does not exempt DDL");
ok(classifySql("CREATE TABLE public.x(id int); SELECT 'please rollback later';").block, "the word rollback in a literal does not exempt DDL");
ok(classifySql("ALTER TABLE invoices ADD COLUMN x text; ROLLBACK;").block, "ROLLBACK without a BEGIN-first wrapper does not exempt DDL");
ok(!classifySql("BEGIN; ALTER TABLE invoices ADD COLUMN x text; SELECT 1; ROLLBACK;").block, "real BEGIN-first/ROLLBACK-last wrapper still allowed");
ok(!classifySql("INSERT INTO customers (name) VALUES ('[E2E] Grant Farms')").block, "[E2E] data mentioning 'Grant' not misread as DDL");
ok(!classifySql("CREATE TEMP TABLE scratch AS SELECT 1;").block, "temp table allowed");
ok(!classifySql("SELECT * FROM pg_proc WHERE prosrc LIKE '%create table%'").block, "select mentioning DDL text allowed");
eq(classifySql("TRUNCATE public.orders;").kind, "truncate", "truncate blocked");
eq(classifySql("UPDATE financial_audit_log SET description='x' WHERE id=1").kind, "audit-log-write", "audit log update blocked");
ok(classifySql("DELETE FROM financial_audit_log WHERE note LIKE '%[E2E]%'").block, "audit log delete blocked even with [E2E]");
eq(classifySql("UPDATE invoices SET total_cents = 100 WHERE id=1").kind, "financial-amount-update", "money column update blocked");
// FIX 5 (2026-07-13, "live-testdata UPDATE gap"): a plain UPDATE on a real
// (non-[E2E]) business table is now blocked too, matching INSERT's treatment —
// even when the SET clause never touches a money column. Before this fix, this
// exact statement was allowed (see the old test name below) — that was the gap.
eq(classifySql("UPDATE invoices SET notes = 'call back' WHERE total_cents = 500").kind, "real-update", "money col only in WHERE clause no longer exempts the UPDATE (generic real-update catch-all, FIX 5)");

// ── live-testdata UPDATE gap (FIX 5, 2026-07-13) ─────────────────────────
ok(classifySql("UPDATE customers SET phone = '555-0100' WHERE id = 1").block, "real customer UPDATE without [E2E] blocked");
eq(classifySql("UPDATE customers SET phone = '555-0100' WHERE id = 1").kind, "real-update", "kind reported for generic business-table UPDATE");
ok(!classifySql("UPDATE customers SET phone = '555-0100' WHERE id = 1 -- [E2E]").block, "[E2E]-marked UPDATE allowed");
ok(!classifySql("UPDATE some_log_table SET x = 1 WHERE id = 1").block, "UPDATE on a non-business table allowed");
// Codex P1 2026-07-13: AP/prepay/inventory tables were missing from the lists.
ok(classifySql("UPDATE vendor_bills SET notes = 'x' WHERE id = 1").block, "raw UPDATE of vendor_bills (AP side) blocked");
ok(classifySql("UPDATE prepay_credits SET memo = 'x' WHERE id = 1").block, "raw UPDATE of prepay_credits blocked");
ok(classifySql("UPDATE inventory_transactions SET notes = 'x' WHERE id = 1").block, "raw UPDATE of inventory_transactions blocked");
ok(!classifySql("UPDATE vendor_bills SET notes = '[E2E] test' WHERE id = 1").block, "[E2E]-marked vendor_bills UPDATE stays allowed");
ok(classifySql("DELETE FROM vendor_payments WHERE id = 1").block, "DELETE from vendor_payments (now financial) blocked");
// Codex P1 round 3: fully quoted schema qualification must not evade the classifier.
ok(classifySql('UPDATE "public"."customers" SET phone = \'555\' WHERE id = 1').block, 'UPDATE "public"."customers" (quoted qualification) blocked');
ok(classifySql('INSERT INTO "public"."invoices" (id) VALUES (1)').block, 'INSERT INTO "public"."invoices" (quoted qualification) blocked');
ok(classifySql('UPDATE public . "orders" SET notes = \'x\' WHERE id = 1').block, "spaced qualification still blocked");
// Codex P1 round 4: live stock tables were missing from the lists.
ok(classifySql("UPDATE inventory SET quantity = 0 WHERE id = 1").block, "raw UPDATE of inventory (live stock) blocked");
ok(classifySql("UPDATE inventory_holds SET quantity = 0 WHERE id = 1").block, "raw UPDATE of inventory_holds blocked");
ok(classifySql("DELETE FROM inventory_transactions WHERE id = 1").block, "DELETE from inventory_transactions blocked");
ok(!classifySql("SELECT * FROM customers WHERE id = 1").block, "SELECT still allowed (not an UPDATE)");
// More specific classifications still win over the generic catch-all:
eq(classifySql("UPDATE invoices SET status = 'voided' WHERE id = 5").kind, "financial-cancel", "cancel/void still classified specifically, not as generic real-update");
eq(classifySql("DELETE FROM invoices WHERE id = 5").kind, "financial-delete", "financial delete still classified specifically");

// ── dollar-quoted machine content (2026-07-11) ───────────────────────────
// Function bodies re-emitted by a BEGIN;...;ROLLBACK; migration smoke are
// machine content — only top-level hand-written statements may classify.
eq(classifySql("INSERT INTO financial_audit_log (action) VALUES ('x')").kind, "audit-log-write", "bare audit-log insert still blocked");
ok(!classifySql("SELECT $function$ INSERT INTO financial_audit_log (action) VALUES ('x'); $function$::text").block, "audit-log insert inside $function$ body is machine content, allowed");
const moneyRpcSmoke = [
  "BEGIN;",
  "CREATE OR REPLACE FUNCTION public.record_vendor_payment(p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $function$",
  "BEGIN",
  "  INSERT INTO financial_audit_log (action, details) VALUES ('vendor_payment', '{}');",
  "  UPDATE invoices SET status = 'voided', total_cents = 0 WHERE id = p_id;",
  "  DELETE FROM payments WHERE invoice_id = p_id;",
  "  RETURN '{}'::jsonb;",
  "END;",
  "$function$;",
  "ROLLBACK;",
].join("\n");
ok(!classifySql(moneyRpcSmoke).block, "BEGIN;<money-RPC re-emit>;ROLLBACK; smoke allowed");
eq(classifySql("CREATE OR REPLACE FUNCTION public.f() RETURNS void LANGUAGE sql AS $function$ INSERT INTO financial_audit_log (a) VALUES (1); $function$;").kind, "raw-ddl", "un-rolled-back re-emit still blocked, but as raw-ddl not audit-log-write");
// DO bodies EXECUTE immediately — stripping must not hide them.
eq(classifySql("DO $$ BEGIN INSERT INTO financial_audit_log (a) VALUES (1); END $$;").kind, "audit-log-write", "audit-log insert inside a DO body still blocked");
ok(!classifySql("DO $$ BEGIN PERFORM public.record_vendor_payment('00000000-0000-0000-0000-000000000000'); RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;").block, "DO-block smoke calling a money RPC still allowed");
// A $$ inside a plain string literal must not open a quote span that swallows real SQL.
eq(classifySql("SELECT 'a$$b'; INSERT INTO financial_audit_log (a) VALUES (1); SELECT 'c$$d';").kind, "audit-log-write", "$$ inside string literals cannot hide a real audit-log write");
// COMMIT inside a DO body can really commit — it must still disqualify a "rolled-back" batch.
ok(classifySql("BEGIN; CREATE TABLE t (id int); DO $$ BEGIN PERFORM 1; COMMIT; END $$; ROLLBACK;").block, "COMMIT inside a DO body still disqualifies the smoke wrapper");

// ── codex-push ───────────────────────────────────────────────────────────
ok(isGitPush("git push origin main"), "detects push");
ok(!isGitPush("git status"), "non-push");
// refspec bypass closures (2026-07-04)
ok(pushTargetsMain("git push origin HEAD:main", "feature/x"), "HEAD:main from feature branch targets main");
ok(pushTargetsMain("git push origin feature/x:main", "feature/x"), "feature:main targets main");
ok(pushTargetsMain("git push origin HEAD:refs/heads/main", "feature/x"), "refs/heads/main refspec targets main");
ok(pushTargetsMain("git push origin main", "feature/x"), "bare main refspec targets main from any branch");
ok(pushTargetsMain("git push", "main"), "plain push while on main targets main");
ok(pushTargetsMain("git push origin HEAD", "main"), "push HEAD while on main targets main");
ok(!pushTargetsMain("git push origin HEAD", "feature/x"), "push HEAD from feature branch does not target main");
ok(!pushTargetsMain("git push", "feature/x"), "plain push from feature branch does not target main");
ok(!pushTargetsMain("git push -u origin claude/some-branch", "claude/some-branch"), "feature branch push does not target main");
// Codex 2026-07-05 P1: the guard must diff/proof the ref actually pushed to main
eq(mainPushSource("git push origin release:main", "feature/x"), "release", "release:main resolves source ref release");
eq(mainPushSource("git push origin HEAD:main", "feature/x"), "HEAD", "HEAD:main resolves source HEAD");
eq(mainPushSource("git push origin main", "feature/x"), "main", "bare main refspec resolves local main");
eq(mainPushSource("git push", "main"), "HEAD", "plain push on main resolves HEAD");
eq(mainPushSource("git push origin :main", "x"), "DELETE", "push :main detected as branch deletion");
eq(mainPushSource("git push origin feature/x", "feature/x"), null, "feature push resolves null");
// git GLOBAL options between `git` and `push` must not bypass the gate (2026-07-10)
ok(isGitPush("git -C C:/CRX_Manager push origin main"), "git -C <dir> push detected");
ok(isGitPush('git -C "C:/My Repo" push origin main'), "git -C quoted dir push detected");
ok(isGitPush("git --git-dir=.git push origin main"), "git --git-dir push detected");
ok(isGitPush("git -c core.editor=true push origin main"), "git -c k=v push detected");
ok(!isGitPush("git -C C:/CRX_Manager status"), "git -C status is not a push");
eq(mainPushSource("git -C C:/CRX_Manager push origin main", "feature/x"), "main", "git -C push origin main targets main");
eq(mainPushSource("git -C C:/CRX_Manager push origin HEAD:main", "feature/x"), "HEAD", "git -C HEAD:main resolves HEAD");
eq(mainPushSource("git -C C:/CRX_Manager push origin feature/x", "feature/x"), null, "git -C feature push resolves null");
eq(riskyFiles(["src/App.tsx", "supabase/migrations/x.sql"]).length, 1, "migration is risky");
eq(riskyFiles(["src/App.tsx", "README.md"]).length, 0, "no risky files");
ok(riskyFiles(["supabase/functions/send-email/index.ts"]).length === 1, "edge fn is risky");
// FIX 4 (2026-07-13): single-choke-point files are risky by PATH too.
ok(riskyFiles(["src/lib/db.ts"]).length === 1, "src/lib/db.ts is risky");
ok(riskyFiles(["src/lib/sentry.ts"]).length === 1, "src/lib/sentry.ts is risky");
eq(riskyFiles(["src/lib/other.ts"]).length, 0, "an unrelated src/lib file is not risky by path");
// FIX 4: content-level risk check (fires even when no PATH pattern matches).
ok(contentIsRisky("+  const total_cents = a + b;"), "diff touching _cents flagged risky by content");
ok(contentIsRisky("+  await allocate_payment(x, y);"), "diff calling allocate_payment flagged risky by content");
ok(contentIsRisky("+  insert into financial_audit_log (...) values (...);"), "diff touching financial_audit_log flagged risky by content");
ok(contentIsRisky("+  apply_prepay(customer_id, amount);"), "diff calling apply_prepay flagged risky by content");
ok(!contentIsRisky("+  const label = 'hello world';"), "an ordinary diff is not flagged risky by content");
const good = { codex_ran: true, verdict: "clean", head_sha: "abc", timestamp: new Date().toISOString() };
ok(proofValid(good, "abc", Date.now()), "valid proof");
ok(!proofValid(good, "different", Date.now()), "wrong HEAD → invalid");
ok(!proofValid({ ...good, codex_ran: false }, "abc", Date.now()), "codex_ran false → invalid");
ok(!proofValid({ ...good, timestamp: new Date(Date.now() - 40 * 60000).toISOString() }, "abc", Date.now()), "stale proof invalid");
ok(!proofValid({ ...good, verdict: "has-blockers" }, "abc", Date.now()), "non-clean verdict invalid");

// ── LIVE inert checks: guards emit NOTHING when their state files are absent ─
function runHook(file, payload) {
  return spawnSync(process.execPath, [path.join(__dirname, file)], { input: JSON.stringify(payload), encoding: "utf8" });
}
// hold-latch-guard: no hold.json → nothing (assumes none latched; safe if a real repo has one, so only assert exit 0)
let r = runHook("hold-latch-guard.mjs", { tool_name: "Edit", tool_input: { file_path: "src/x.tsx" } });
eq(r.status, 0, "hold-latch-guard exits 0");
// active-area-guard: no active-areas.json in a scratch payload → passthrough (nothing)
r = runHook("active-area-guard.mjs", { tool_name: "Bash", tool_input: { command: "ls" } });
eq(r.status, 0, "active-area-guard exits 0 on benign cmd");
eq(r.stdout.trim(), "", "active-area-guard silent on benign cmd");
// live-testdata-guard: a [E2E] insert → silent (allowed)
r = runHook("live-testdata-guard.mjs", { tool_name: "mcp__supabase__execute_sql", tool_input: { query: "INSERT INTO customers (name) VALUES ('[E2E] X')" } });
eq(r.status, 0, "live-testdata-guard exits 0");
eq(r.stdout.trim(), "", "live-testdata-guard silent on [E2E] insert");
// live-testdata-guard: a REAL insert → deny
r = runHook("live-testdata-guard.mjs", { tool_name: "mcp__supabase__execute_sql", tool_input: { query: "INSERT INTO customers (name) VALUES ('Real Farm')" } });
ok(r.stdout.includes("deny"), "live-testdata-guard denies real insert");
// live-testdata-guard: a REAL update on a business table (no [E2E]) → deny (FIX 5)
r = runHook("live-testdata-guard.mjs", { tool_name: "mcp__supabase__execute_sql", tool_input: { query: "UPDATE customers SET phone = '555-0100' WHERE id = 1" } });
ok(r.stdout.includes("deny"), "live-testdata-guard denies real business-table update (FIX 5)");
// codex-push-guard: a non-push command → silent passthrough (plain git push of a
// non-risky file needs no proof either — covered at the riskyFiles level above;
// this proves the hook doesn't even fire outside a push).
r = runHook("codex-push-guard.mjs", { tool_name: "Bash", tool_input: { command: "git status" } });
eq(r.status, 0, "codex-push-guard exits 0 on non-push command");
eq(r.stdout.trim(), "", "codex-push-guard silent on non-push command");

// grant-change-guard: Codex patch tools must not bypass caller analysis.
const grantPatchPath = "supabase/migrations/20990101000000_grant_guard_fixture.sql";
const grantPatch = (marker = "") => `*** Begin Patch
*** Add File: ${grantPatchPath}
+${marker}
+REVOKE EXECUTE ON FUNCTION public.get_program_completion(integer) FROM authenticated, anon, PUBLIC;
*** End Patch`;
for (const patchToolName of ["apply_patch", "mcp__codex__apply_patch"]) {
  r = runHook("grant-change-guard.mjs", {
    tool_name: patchToolName,
    tool_input: { input: grantPatch() },
  });
  ok(r.stdout.includes('"permissionDecision":"deny"'), `grant-change-guard denies unreviewed REVOKE through ${patchToolName}`);
  ok(r.stdout.includes("get_program_completion"), `${patchToolName} denial names the caller-bearing function`);
  r = runHook("grant-change-guard.mjs", {
    tool_name: patchToolName,
    tool_input: {
      input: grantPatch("-- caller-analysis: get_program_completion :: browser callers remain supported by authenticated EXECUTE"),
    },
  });
  ok(r.stdout.includes('"permissionDecision":"allow"'), `grant-change-guard accepts reviewed ${patchToolName} marker`);
}
const multiMigrationPatch = `*** Begin Patch
*** Add File: supabase/migrations/20990101000001_grant_guard_a.sql
+-- caller-analysis: get_program_completion :: reviewed in migration A
+REVOKE EXECUTE ON FUNCTION public.get_program_completion(integer) FROM authenticated;
*** Add File: supabase/migrations/20990101000002_grant_guard_b.sql
+REVOKE EXECUTE ON FUNCTION public.transfer_job_to_invoice(uuid, uuid, text) FROM authenticated;
*** End Patch`;
r = runHook("grant-change-guard.mjs", {
  tool_name: "mcp__codex__apply_patch",
  tool_input: { input: multiMigrationPatch },
});
ok(r.stdout.includes('"permissionDecision":"deny"'), "grant-change-guard rejects multi-migration patch payloads");
ok(r.stdout.includes("one patch per file"), "multi-migration denial explains the safe split");

console.log(`guards: ${pass} assertions passed`);
