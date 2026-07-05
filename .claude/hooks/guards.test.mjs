#!/usr/bin/env node
// Tests for hold-latch, live-testdata, and codex-push guard logic + inert-when-off behavior.
// Run: node .claude/hooks/guards.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isHoldPhrase, isResumePhrase, isBuildActionUnderHold } from "./hold-latch-lib.mjs";
import { classifySql } from "./live-testdata-lib.mjs";
import { isGitPush, pushTargetsMain, mainPushSource, riskyFiles, proofValid } from "./codex-push-lib.mjs";

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
ok(!classifySql("UPDATE invoices SET notes = 'call back' WHERE total_cents = 500").block, "money col only in WHERE clause allowed");

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
eq(riskyFiles(["src/App.tsx", "supabase/migrations/x.sql"]).length, 1, "migration is risky");
eq(riskyFiles(["src/App.tsx", "README.md"]).length, 0, "no risky files");
ok(riskyFiles(["supabase/functions/send-email/index.ts"]).length === 1, "edge fn is risky");
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

console.log(`guards: ${pass} assertions passed`);
