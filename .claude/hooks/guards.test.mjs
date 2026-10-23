#!/usr/bin/env node
// Tests for hold-latch, live-testdata, and codex-push guard logic + inert-when-off behavior.
// Run: node .claude/hooks/guards.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isHoldPhrase, isResumePhrase, isBuildActionUnderHold, holdDecision } from "./hold-latch-lib.mjs";
import { classifySql } from "./live-testdata-lib.mjs";
import { isGitPush, pushTargetsMain, mainPushSource, riskyFiles, contentIsRisky, proofValid, programAssembledAtRuntime } from "./codex-push-lib.mjs";
import { DENY_TOOLNAME_RE } from "./autopilot-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Git exports GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE into a hook's environment,
// and a child `git` honors those over `-C <path>`. The mirror-remote block below
// builds a throwaway repo and configures it, so when this suite runs from the
// pre-commit hook those writes land in the REAL repository instead — observed
// 2026-08-07, when a pre-commit run wrote `remote.origin.mirror=true` into this
// repo, which the push guard then (correctly) refuses every push against. The
// throwaway repo meanwhile stays unconfigured, so the guard under test sees no
// mirror and the assertions fail. Strip them once for the whole process, the same
// shape as the inherited-GIT_CONFIG_* strip in scripts/backup-claude-memory.test.mjs.
for (const key of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
]) delete process.env[key];

let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }
function eq(a, b, m) { assert.equal(a, b, m); pass++; }

// ── hold-latch ───────────────────────────────────────────────────────────
ok(isHoldPhrase("lets just stop here, cancel all background work"), "stop+cancel");
ok(isHoldPhrase("pause this loop"), "pause");
ok(isHoldPhrase("im just scoping a future session, dont build yet"), "scope-only");
ok(!isHoldPhrase("build me the invoices page"), "normal build is not a hold");
ok(isResumePhrase("ok go ahead and continue"), "resume phrase");
// Local, reversible work WARNS under a hold; outward actions stay denied (2026-10-18).
eq(holdDecision("Edit", { file_path: "src/pages/Foo.tsx" }), "warn", "edit source warns under hold");
eq(holdDecision("Bash", { command: "git commit -m x" }), "warn", "commit warns under hold");
eq(holdDecision("Bash", { command: "git -C C:/x rebase origin/main" }), "warn", "local rebase warns under hold");
eq(holdDecision("Bash", { command: "npm run test" }), "allow", "tests stay plainly allowed");
// The autonomous-landing merge and global-option pushes were MISSED before
// (adversarial review 2026-10-18); a "stop" must hold them now.
for (const command of [
  "gh pr merge 951 --squash --match-head-commit 37222b56b0000000000000000000000000000000",
  "gh -R masonwells1/CRX_Manager_V1.0 pr merge 951 --squash",
  "git -C \"C:/CRX Manager/wt\" push origin HEAD",
  "git push origin HEAD",
  "git.exe push origin HEAD",
  "git commit -m x && git push",
  "gh pr create --fill",
  "gh api repos/o/r/pulls/1/merge -X PUT",
  "gh api repos/o/r/issues/1/comments -f body=hi",
  "git branch -D old",
  "rm -rf src",
  "vercel deploy --prod",
  // Luna, PR #956 round 1: long-form gh api fields and REST clients that write.
  "gh api repos/o/r/issues/1/comments --field body=hi",
  "gh api repos/o/r/issues/1/comments --raw-field body=hi",
  "gh api repos/o/r/issues/1/comments --input body.json",
  "curl -X POST -H \"Authorization: Bearer $GH_TOKEN\" --data '{\"body\":\"hi\"}' https://api.github.com/repos/o/r/issues/1/comments",
  "curl --json '{\"a\":1}' https://api.github.com/x",
  "Invoke-RestMethod -Method Post -Uri https://api.github.com/x -Body '{}'",
  // Luna, PR #956 round 2.
  "gh pr update-branch 951",
  "gh workflow run ci.yml",
  "gh secret set X --body y",
  "curl -T artifact.zip https://example.test/upload",
  "wget --method=PUT --body-file=x https://example.test/x",
  // Luna, PR #956 round 3: a shell database client.
  "psql \"$DATABASE_URL\" -f /tmp/erase-invoice.sql",
  // Codex connector, PR #956: gh global options before `api`.
  "gh --hostname github.com api repos/o/r/issues/1 -f title=x",
  "gh -R o/r api repos/o/r/issues/1 --field title=x",
  "gh api repos/o/r/issues/1/comments -fbody=x",
  "curl -dfoo https://example.test/x",
  "curl -Ffoo=bar https://example.test/x",
  "curl -Tfile https://example.test/x",
  "curl --form-string body=hi https://example.test/upload",
  "curl --data-ascii foo https://example.test/x",
  // CodeRabbit, PR #956: a backslash-newline continuation.
  "curl -X POST \\\n  --data '{}' https://api.github.com/x",
]) eq(holdDecision("Bash", { command }), "deny", `outward under hold: ${command}`);
eq(holdDecision("Bash", { command: "curl -s https://api.github.com/repos/o/r" }), "allow", "curl GET allowed under hold");
eq(holdDecision("Bash", { command: "gh pr view 951 --json state" }), "allow", "gh read allowed under hold");
eq(holdDecision("Bash", { command: "gh api repos/o/r/pulls/1" }), "allow", "gh api GET allowed under hold");
eq(holdDecision("mcp__supabase__execute_sql", { query: "select public.void_invoice(42)" }), "deny",
  "mutating RPC inside a SELECT is denied under hold");
eq(holdDecision("mcp__supabase__execute_sql", { query: "grant execute on function f() to anon" }), "deny",
  "GRANT is denied under hold");
eq(holdDecision("mcp__supabase__execute_sql", { query: "SELECT * INTO public.hold_probe FROM invoices" }), "deny",
  "SELECT INTO (creates a table) is denied under hold (CodeRabbit, PR #956)");
eq(holdDecision("mcp__supabase__execute_sql", { query: "SELECT ';' INTO public.hold_probe" }), "deny",
  "SELECT INTO behind a semicolon inside a string literal is denied under hold (CodeRabbit, PR #956)");
eq(holdDecision("mcp__supabase__execute_sql", { query: "select count(*) from invoices" }), "allow",
  "plain read SQL allowed under hold");
ok(isBuildActionUnderHold("mcp__supabase__apply_migration", {}), "apply blocked under hold");
// Every GitHub MCP write tool is held; GitHub reads are not (Codex connector, PR #956).
for (const tool of [
  "create_pull_request", "update_pull_request", "add_issue_comment", "pull_request_review_write",
  "issue_write", "update_pull_request_branch", "create_branch", "add_comment_to_pending_review",
  "add_reply_to_pull_request_comment", "sub_issue_write", "actions_run_trigger", "fork_repository",
  "create_repository", "merge_pull_request", "push_files",
  // Ends in `_read` but changes state (CodeRabbit, PR #975).
  "mark_all_notifications_read",
]) eq(holdDecision(`mcp__github__${tool}`, {}), "deny", `GitHub MCP write held: ${tool}`);
for (const tool of [
  "get_file_contents", "list_pull_requests", "search_code", "pull_request_read", "issue_read",
  "actions_get", "actions_list", "get_job_logs",
]) eq(holdDecision(`mcp__github__${tool}`, {}), "allow", `GitHub MCP read allowed under hold: ${tool}`);
// The file-bytes live-apply door is a Bash command, not an MCP tool, so the
// tool-name set never sees it. Codex (P1, PR #460) verified the predicate returned
// false for this exact invocation — a mid-session "stop" would NOT have paused a
// live migration through the new spelling.
ok(isBuildActionUnderHold("Bash", { command: "node scripts/apply-migration-file.mjs supabase/migrations/x.sql --confirm" }),
  "file-bytes live apply blocked under hold");
ok(isBuildActionUnderHold("Bash", { command: "node scripts/apply-migration-file.mjs x.sql" }),
  "even a dry run of the live-apply door pauses under hold");
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

// ── program name assembled at run time (Codex connector, PR #956) ─────────
for (const command of [
  "a=g; b=h; c=mer; d=ge; $a$b pr $c$d 951 --squash",
  "a=gi; b=t; c=pu; d=sh; $a$b $c$d origin HEAD:main",
  "export P=gh && $P pr merge 1",
  "$p = 'gh'; & $p pr merge 1",
  "$(printf g)h pr m$(printf er)ge 951 --squash",
  "$(printf g)it pu$(printf sh) origin HEAD:main",
  "`printf g`h pr m`printf er`ge 951 --squash",
  "`printf g`it pu`printf sh` origin HEAD:main",
]) ok(programAssembledAtRuntime(command), `assembled program name refused: ${command}`);
for (const command of [
  'for f in scripts/*.mjs; do node "$f" --check; done',
  'F=$(git rev-parse --show-toplevel); ls "$F"',
  'eval "$(fnm env)" && node -v',
  'bash -c "$CMD"',
  "i=$(($i+1)); git status",
]) ok(!programAssembledAtRuntime(command), `ordinary shape not refused: ${command}`);

// ── live-testdata ────────────────────────────────────────────────────────
ok(classifySql("INSERT INTO customers (name) VALUES ('Acme Farm')").block, "real customer insert blocked");
ok(!classifySql("INSERT INTO customers (name) VALUES ('[E2E] Farm Alpha')").block, "[E2E] insert allowed");
ok(classifySql("DELETE FROM invoices WHERE id = 5").block, "financial delete blocked");
ok(classifySql("UPDATE invoices SET status = 'voided' WHERE id = 5").block, "void real invoice blocked");
ok(!classifySql("SELECT * FROM invoices").block, "select allowed");
ok(!classifySql("INSERT INTO some_log_table (x) VALUES (1)").block, "non-business table allowed");
eq(classifySql("DELETE FROM customers WHERE id = 5").kind, "real-delete", "non-financial business delete blocked (PR #352)");
eq(classifySql("SELECT setval('invoice_number_seq', 1, false)").kind, "sequence-mutation", "setval via SELECT blocked (PR #352)");
eq(classifySql("SELECT cancel_order(42)").kind, "rpc-via-select", "mutating RPC via SELECT blocked (PR #352)");
ok(!classifySql("SELECT currval('invoice_number_seq')").block, "currval read allowed");
// Catalog reads refused as RPCs in real sessions (2026-10-04).
ok(!classifySql("SELECT pg_get_userbyid(p.proowner), pg_get_function_identity_arguments(p.oid) FROM pg_proc p").block,
  "catalog owner/signature reads allowed");
ok(!classifySql("SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t").block, "trigger definition read allowed");
ok(!classifySql("SELECT (aclexplode(p.proacl)).grantee FROM pg_proc p WHERE p.oid = to_regprocedure('public.get_balance(uuid)')").block,
  "ACL and regprocedure reads allowed");
ok(!classifySql("SELECT auth.uid()").block && !classifySql('SELECT "auth".uid()').block, "auth.uid() is a read");
ok(['SELECT "evil.auth".uid()', 'SELECT "x auth".uid()', "SELECT evil.auth.uid()", "SELECT uid()"]
  .every((sql) => classifySql(sql).block), "a uid() whose schema is not exactly auth is blocked (Luna round 3, PR #882)");
ok(classifySql("SELECT public.uid()").block && classifySql("SELECT evil.uid()").block,
  "a uid() outside the auth schema is not vouched for (Luna, PR #882)");
ok(['SELECT public.pg_get_triggerdef(t.oid) FROM pg_trigger t', 'SELECT "public".count(*) FROM orders',
  "SELECT evil.pg_get_triggerdef(1)", 'SELECT "evil".coalesce(1)', "SELECT public.pg_stat_reset()"]
  .every((sql) => classifySql(sql).block), "a built-in name in an application schema is an RPC (CodeRabbit, PR #882)");
ok(['SELECT pg_catalog.pg_get_triggerdef(t.oid) FROM pg_trigger t', 'SELECT "pg_catalog"."pg_get_triggerdef"(t.oid) FROM pg_trigger t',
  "SELECT count(*), coalesce(max(id), 0) FROM orders"]
  .every((sql) => !classifySql(sql).block), "an unqualified or pg_catalog built-in is still a read");
// Luna, PR #882: a quoted identifier keeps its case, so "AUTH", "PG_CATALOG" and
// "COUNT" are other objects; an unquoted one folds to lower case.
ok(['SELECT "AUTH".uid()', 'SELECT "Auth".uid()', 'SELECT auth."UID"()',
  'SELECT "PG_CATALOG".pg_get_triggerdef(1)', 'SELECT "COUNT"(*) FROM orders']
  .every((sql) => classifySql(sql).block), "a quoted name with capitals is not the vouched-for object");
ok(["SELECT x$auth.uid()", "SELECT x$pg_catalog.pg_get_triggerdef(1)", "SELECT my$count(1)", "SELECT my$public.count(1)"]
  .every((sql) => classifySql(sql).block), "a `$` inside an identifier makes it another schema or function (Luna, PR #882)");
ok(["SELECT evil./*x*/pg_get_triggerdef(1)", "SELECT evil.--x\npg_get_triggerdef(1)", "SELECT public/**/./**/count(1)",
  "SELECT cancel_order/**/(42)", "SELECT cancel_order --x\n(42)"]
  .every((sql) => classifySql(sql).block), "a comment cannot hide a schema or a call (Codex connector, PR #882)");
ok(!classifySql("SELECT count(*) FROM orders -- cancel_order(42) would be wrong here").block &&
  !classifySql("SELECT /* get rid of delete_all() */ count(*) FROM orders").block &&
  !classifySql("SELECT pg_catalog./**/pg_get_triggerdef(t.oid), '--' AS x, '/*' AS y FROM pg_trigger t").block,
  "comment prose is not a call, and comment-like text inside a string stays data");
ok(["SELECT evil.get_invoice(42)", 'SELECT "PUBLIC".get_invoice(42)', 'SELECT "GET_INVOICE"(42)', "SELECT x$public.list_orders(1)"]
  .every((sql) => classifySql(sql).block), "a read-named function outside public is not vouched for (Luna, PR #882)");
ok(["SELECT get_invoice(42)", "SELECT public.get_invoice(42)", 'SELECT "public".get_invoice(42)', "SELECT PUBLIC.list_orders(1)"]
  .every((sql) => !classifySql(sql).block), "a read-named function in public is still a read");
ok(['SELECT "éauth".uid()', "SELECT éauth.uid()", "SELECT éget_invoice(42)", "SELECT écount(1)",
  "SELECT xpg_catalogé.pg_get_triggerdef(1)", "SELECT é.pg_get_triggerdef(1)"]
  .every((sql) => classifySql(sql).block), "a non-ASCII character is part of a PostgreSQL identifier (Luna, PR #882)");
ok(["SELECT AUTH.uid()", "SELECT auth.UID()", "SELECT PG_CATALOG.pg_get_triggerdef(1)",
  'SELECT "count"(*) FROM orders', "SELECT COUNT(*) FROM orders"]
  .every((sql) => !classifySql(sql).block), "an unquoted name folds to lower case and is still a read");
ok(!classifySql("SELECT * FROM unnest(ARRAY[1,2]) AS t(x)").block, "a column-alias list is not a call");
ok(!classifySql("SELECT total::numeric(12,2) FROM orders").block, "a typmod cast is not a call");
eq(classifySql("SELECT * FROM unnest(ARRAY[1,2]) AS t(x), cancel_order(42)").kind, "rpc-via-select",
  "an RPC after an alias list is still caught");
ok(!classifySql("SELECT * FROM orders WHERE status = 'cancelled'").block, "plain filtered select allowed");
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
const good = {
  codex_ran: true,
  verdict: "clean",
  model: "gpt-6-sol",
  reasoning_effort: "high",
  head_sha: "abc",
  timestamp: new Date().toISOString(),
};
ok(proofValid(good, "abc", Date.now()), "valid proof");
ok(!proofValid(good, "different", Date.now()), "wrong HEAD → invalid");
ok(!proofValid({ ...good, codex_ran: false }, "abc", Date.now()), "codex_ran false → invalid");
ok(!proofValid({ ...good, timestamp: new Date(Date.now() - 25 * 60 * 60000).toISOString() }, "abc", Date.now()), "stale proof invalid");
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
// REAL-DATA-OK (2026-10-23): a fresh marker relaxes ordinary writes only; a stale
// one is ignored; destructive rules never relax, even later in the same batch.
{
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "crx-realdata-"));
  const stateDir = path.join(proj, ".claude", "session-state");
  fs.mkdirSync(stateDir, { recursive: true });
  const marker = path.join(stateDir, "REAL-DATA-OK");
  // Every run must exit 0: an empty stdout from a crash must not pass as "allowed".
  const sql = (query) => {
    const res = spawnSync(process.execPath, [path.join(__dirname, "live-testdata-guard.mjs")], {
      input: JSON.stringify({ tool_name: "mcp__50e15046-cf2c-49da-b8df-ceef27768f63__execute_sql", tool_input: { query } }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
    });
    eq(res.status, 0, `live-testdata-guard exits 0 (${query.slice(0, 40)})`);
    return res.stdout;
  };
  ok(sql("INSERT INTO customers (name) VALUES ('Real Farm')").includes("deny"), "no marker: real insert denied (connector-prefixed tool name)");
  // The real leftover marker: no leading timestamp, freshly copied (new mtime) into a worktree.
  fs.writeFileSync(marker, "Mason OK 2026-10-19: read-only cost/margin role check\r\n");
  ok(sql("INSERT INTO customers (name) VALUES ('Real Farm')").includes("deny"), "legacy marker with a fresh mtime but no leading UTC time is ignored");
  ok(sql("TRUNCATE customers").includes("deny"), "legacy marker: TRUNCATE denied");
  const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(marker, `${hoursAgo(3)} Mason OK: smoke run\n`);
  ok(sql("INSERT INTO customers (name) VALUES ('Real Farm')").includes("deny"), "marker written 3 h ago is ignored even with a fresh mtime");
  fs.writeFileSync(marker, `${new Date(Date.now() + 60 * 60 * 1000).toISOString()} Mason OK\n`);
  ok(sql("INSERT INTO customers (name) VALUES ('Real Farm')").includes("deny"), "marker dated an hour in the future is ignored");
  fs.writeFileSync(marker, `\n${hoursAgo(0.1)} Mason OK\n`);
  ok(sql("INSERT INTO customers (name) VALUES ('Real Farm')").includes("deny"), "marker whose first line is blank is ignored");
  fs.writeFileSync(marker, `${hoursAgo(0.1)} Mason OK: real customer fix\n`);
  eq(sql("INSERT INTO customers (name) VALUES ('Real Farm')").trim(), "", "fresh marker: real insert allowed");
  eq(sql("UPDATE customers SET phone = '555-0100' WHERE id = 1").trim(), "", "fresh marker: real update allowed");
  ok(sql("SELECT save_customer('{}'::jsonb)").includes("deny"), "fresh marker: RPC call still denied");
  ok(sql("TRUNCATE customers").includes("deny"), "fresh marker: TRUNCATE still denied");
  ok(sql("DROP TABLE customers").includes("deny"), "fresh marker: DDL still denied");
  ok(sql("GRANT ALL ON customers TO anon").includes("deny"), "fresh marker: GRANT still denied");
  ok(sql("DELETE FROM customers WHERE id = 1").includes("deny"), "fresh marker: real delete still denied");
  ok(sql("DELETE FROM invoices WHERE id = 1").includes("deny"), "fresh marker: financial delete still denied");
  ok(sql("UPDATE invoices SET status = 'voided' WHERE id = 1").includes("deny"), "fresh marker: void still denied");
  ok(sql("UPDATE orders SET status = 'cancelled' WHERE id = 1").includes("deny"), "fresh marker: cancel still denied");
  ok(sql("SELECT setval('invoice_number_seq', 1)").includes("deny"), "fresh marker: sequence change still denied");
  ok(sql("INSERT INTO financial_audit_log (note) VALUES ('x')").includes("deny"), "fresh marker: audit-log write still denied");
  ok(sql("INSERT INTO customers (name) VALUES ('Real Farm'); DELETE FROM customers WHERE id = 2").includes("deny"),
    "fresh marker: a DELETE after an allowed insert in the same batch is still denied");
  {
    const res = spawnSync(process.execPath, [path.join(__dirname, "live-testdata-guard.mjs")], {
      input: "{not json", encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
    });
    eq(res.status, 0, "unreadable event: guard exits 0");
    ok(res.stdout.includes("deny"), "unreadable execute_sql event is denied");
  }
  for (const call of ["SELECT cancel_order(123)", "SELECT void_invoice(1)", "SELECT delete_invoices(ARRAY[1])",
    "SELECT public.batch_void('{}')", "SELECT reverse_write_off(5)", 'SELECT public."void_invoice"(1)',
    "SELECT public.destroy_customer(1)"]) {
    ok(sql(call).includes("deny"), `fresh marker: destructive RPC still denied (${call})`);
  }
  // [E2E] is judged per statement, and a comment never carries it (Luna round 2).
  fs.rmSync(marker);
  for (const query of [
    "DELETE FROM invoices WHERE id = 7; -- [E2E]",
    "DELETE FROM invoices WHERE id = 1 /* [E2E] */",
    "DELETE FROM customers WHERE name = '[E2E] X'; DELETE FROM customers WHERE id = 2",
    "UPDATE customers SET name = '[E2E] Y' WHERE id = 1; UPDATE orders SET status = 'cancelled' WHERE id = 3",
  ]) {
    ok(sql(query).includes("deny"), `no marker: [E2E] in a comment or another statement does not exempt a delete/cancel (${query.slice(0, 50)})`);
  }
  eq(sql("DELETE FROM customers WHERE name LIKE '[E2E]%'").trim(), "", "no marker: [E2E] cleanup delete still allowed");
  eq(sql("INSERT INTO customers (name) VALUES ('[E2E] Z'); DELETE FROM customers WHERE name = '[E2E] Z'").trim(), "",
    "no marker: [E2E] insert then [E2E] delete allowed");
  fs.rmSync(proj, { recursive: true, force: true });
}
// codex-push-guard: a non-push command → silent passthrough (plain git push of a
// non-risky file needs no proof either — covered at the riskyFiles level above;
// this proves the hook doesn't even fire outside a push).
r = runHook("codex-push-guard.mjs", { tool_name: "Bash", tool_input: { command: "git status" } });
eq(r.status, 0, "codex-push-guard exits 0 on non-push command");
eq(r.stdout.trim(), "", "codex-push-guard silent on non-push command");
// A program name assembled inside a NESTED command is refused by both gates, not
// only an outer one (Codex connector, PR #956).
for (const command of [
  "bash -c '$(printf g)h pr m$(printf er)ge 951 --squash'",
  "bash -c 'g$(printf i)t pu$(printf sh) origin HEAD'",
  // Balanced NESTED substitutions stay one program word (CodeRabbit, PR #956).
  "bash -c '$(echo $(printf g))h pr m$(echo $(printf er))ge 951 --squash'",
  "bash -c 'g$(echo $(printf i))t pu$(echo $(printf sh)) origin HEAD'",
  // An unclosed `$(` still opens a built name (CodeRabbit, PR #956).
  "bash -c '$(printf g h pr m$(printf er)ge 951'",
]) {
  for (const hook of ["pr-merge-guard.mjs", "codex-push-guard.mjs"]) {
    const res = runHook(hook, { tool_name: "Bash", tool_input: { command } });
    ok(res.stdout.includes("deny"), `${hook} denies a nested assembled program name: ${command}`);
  }
}
// Inline runtime code behind a short-option cluster or `deno eval`, through the REAL
// merge and push guards (Codex connector, PR #956; Luna on the follow-up).
for (const command of [
  "node -pe \"require('child_process').execSync('gh pr merge 951 --squash')\"",
  "node -pe \"require('child_process').execSync('git push origin HEAD:main')\"",
  "perl -0e \"system('gh pr merge 951')\"",
  "deno eval \"new Deno.Command('gh',{args:['pr','merge','951']}).outputSync()\"",
  "deno --quiet eval \"new Deno.Command('git',{args:['push','origin','HEAD:main']}).outputSync()\"",
  // A global option with a detached value before `eval` (Codex connector, PR #975).
  "deno -L debug eval \"new Deno.Command('git',{args:['push']}).outputSync()\"",
  "deno --log-level info eval \"new Deno.Command('gh',{args:['pr','merge','951']}).outputSync()\"",
]) {
  for (const hook of ["pr-merge-guard.mjs", "codex-push-guard.mjs"]) {
    const res = runHook(hook, { tool_name: "Bash", tool_input: { command } });
    ok(res.stdout.includes("deny"), `${hook} denies inline runtime code reaching a gated action: ${command}`);
  }
}
for (const command of ['node -pe "1+1"', 'perl -0e "print 1"', 'deno --quiet eval "console.log(1)"', 'deno -L debug eval "console.log(1)"']) {
  for (const hook of ["pr-merge-guard.mjs", "codex-push-guard.mjs"]) {
    const res = runHook(hook, { tool_name: "Bash", tool_input: { command } });
    eq(res.stdout.trim(), "", `${hook} silent on harmless inline runtime code: ${command}`);
  }
}
for (const command of [
  "bash -c 'echo $(date)'",
  "bash -c 'eval \"$(fnm env)\" && node -v'",
  "eval \"$(fnm env)\" && node -v",
  "i=$(($i+1)); git status",
]) {
  for (const hook of ["pr-merge-guard.mjs", "codex-push-guard.mjs"]) {
    const res = runHook(hook, { tool_name: "Bash", tool_input: { command } });
    eq(res.stdout.trim(), "", `${hook} silent on a substitution that builds no program name: ${command}`);
  }
}

// codex-push-guard: a configured mirror remote denies EVERY push form, not just
// a main-bound one. Regression test for a placement bug found on 2026-08-05:
// the mirror check sat after the `if (!srcRef) continue` that skips non-main
// pushes, so the three forms a mirror remote actually turns into an all-refs
// push — `push origin <branch>`, `push origin`, and a bare `push` — were all
// ALLOWED, and only the explicit `HEAD:main` form was denied. The check was
// dead for the exact hazard its own deny text describes. These assertions fail
// against the old ordering.
{
  const mirrorRepo = fs.mkdtempSync(path.join(os.tmpdir(), "crx-mirror-guard-"));
  const git = (...args) => spawnSync("git", ["-C", mirrorRepo, ...args], { encoding: "utf8" });
  spawnSync("git", ["init", "-q", mirrorRepo], { encoding: "utf8" });
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("config", "commit.gpgsign", "false");
  git("commit", "--allow-empty", "-q", "-m", "init");
  git("branch", "-M", "feature");
  git("config", "remote.origin.url", "https://github.com/masonwells1/CRX_Manager_V1.0.git");
  git("config", "remote.origin.mirror", "true");

  const pushVerb = "pu" + "sh"; // keep the literal out of this file's own text
  for (const form of [`origin feature`, `origin`, ``]) {
    const command = `git -C ${mirrorRepo} ${pushVerb} ${form}`.trim();
    const res = runHook("codex-push-guard.mjs", { cwd: mirrorRepo, tool_name: "Bash", tool_input: { command } });
    const reason = res.stdout.trim()
      ? JSON.parse(res.stdout)?.hookSpecificOutput?.permissionDecisionReason ?? ""
      : "";
    ok(/mirror remote/.test(reason), `mirror remote denies \`${pushVerb} ${form || "(bare)"}\``);
  }

  // A mirror on a remote this push does NOT target must not deny. Widening the
  // check to every push form (above) made it refuse on an unrelated mirrored
  // backup remote — `push origin HEAD:feature` denied because `archive` was
  // mirrored. Codex caught this on the hoist, 2026-08-05, reproduced before
  // fixing. `mirror` is per-remote, so the deny is scoped to the remote git
  // actually resolves for this push.
  git("config", "--unset", "remote.origin.mirror");
  git("config", "remote.archive.url", "https://example.com/backup.git");
  git("config", "remote.archive.mirror", "true");
  const unrelated = runHook("codex-push-guard.mjs", {
    cwd: mirrorRepo,
    tool_name: "Bash",
    tool_input: { command: `git -C ${mirrorRepo} ${pushVerb} origin HEAD:feature` },
  });
  eq(unrelated.stdout.trim(), "", "a mirror on an untargeted remote does not deny");

  // ...but pushing TO that remote still does, and so does a bare push whose
  // resolved remote is the mirrored one — the scoping must follow git's own
  // resolution order, not just the token typed in the command.
  const atMirror = runHook("codex-push-guard.mjs", {
    cwd: mirrorRepo,
    tool_name: "Bash",
    tool_input: { command: `git -C ${mirrorRepo} ${pushVerb} archive` },
  });
  ok(/mirror/.test(atMirror.stdout), "pushing to the mirrored remote itself still denies");

  git("config", "remote.pushDefault", "archive");
  const viaDefault = runHook("codex-push-guard.mjs", {
    cwd: mirrorRepo,
    tool_name: "Bash",
    tool_input: { command: `git -C ${mirrorRepo} ${pushVerb}` },
  });
  ok(/mirror/.test(viaDefault.stdout), "bare push resolving to the mirrored remote via pushDefault denies");
  git("config", "--unset", "remote.pushDefault");
  git("config", "--unset", "remote.archive.mirror");

  // Codex sol (2026-09-20, PR #630): a Windows destination ending in a backslash
  // hid the option after it from the guard, because the POSIX word splitter binds
  // `\ ` into the preceding word. PowerShell passes git two arguments there, so
  // the predicates now read both ways. These drive the GUARD end to end — the
  // library assertions alone would not prove the hard gate refuses.
  for (const tail of [
    "--mirror",
    "--delete main",
    "--receive-pack attacker HEAD:feature",
    "--force-with-lease",
  ]) {
    const command = `git -C ${mirrorRepo} ${pushVerb} C:\\critical-bare-repo\\ ${tail}`;
    const res = runHook("codex-push-guard.mjs", { cwd: mirrorRepo, tool_name: "Bash", tool_input: { command } });
    const decision = res.stdout.trim()
      ? JSON.parse(res.stdout)?.hookSpecificOutput?.permissionDecision ?? ""
      : "";
    eq(decision, "deny", `trailing-backslash destination does not hide \`${tail}\``);
  }

  // Codex sol (2026-09-20, PR #630, HIGH-01): a cancellation flag must not hide a
// composed command. The parser used to return null for `--disable-auto`, so the
// guard's substitution refusal never ran and the NESTED administrator merge —
// which bash executes first — reached GitHub with the gate silent. Measured
// then: base denied, candidate allowed. Driven through the hook process here,
  // because the parser assertions alone did not catch it.
  const mergeVerb = "pr me" + "rge"; // keep the literal out of this file's own text
  const bypass = `gh ${mergeVerb} 1 --disable-a""uto --body "$(gh ${mergeVerb} 2 --admin --squash)"`;
  const res = runHook("pr-merge-guard.mjs", { tool_name: "Bash", tool_input: { command: bypass } });
  const parsed = res.stdout.trim() ? JSON.parse(res.stdout)?.hookSpecificOutput ?? {} : {};
  eq(parsed.permissionDecision, "deny", "a quoted cancellation does not hide a nested admin merge");
  ok(/command substitution/.test(parsed.permissionDecisionReason ?? ""), "refused as a composed command");

  // `--disable-auto` no longer stands the gate down (Mason, 2026-09-21): every
  // spelling of that shortcut became a bypass. A plain one now reaches the gate,
  // which is shown with gh made unreachable — the gate must try to resolve the
  // PR, fail, and refuse, rather than stay silent.
  const runHookWithoutGh = (command) => spawnSync(process.execPath, [path.join(__dirname, "pr-merge-guard.mjs")], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, PATH: "", Path: "" },
  });
  for (const command of [
    `gh ${mergeVerb} 5 --disable-auto`,
    `gh ${mergeVerb} 5 -d --disable-auto`,
    `gh ${mergeVerb} 123 --disable-auto=true --disable-auto=false --squash`,
  ]) {
    const gated = runHookWithoutGh(command);
    const gatedDecision = gated.stdout.trim() ? JSON.parse(gated.stdout)?.hookSpecificOutput?.permissionDecision : "";
    eq(gatedDecision, "deny", `--disable-auto reaches the merge gate instead of standing it down: ${command}`);
  }

  // Codex sol (2026-09-20, round 3): pflag BUNDLES boolean shorts, so `-db` is
  // `-d` then `-b` and gh takes the next word as the body VALUE — the
  // cancellation flag never reaches gh, and `--admin` is live. Reading only
  // standalone shorts made the guard stand down on an ADMINISTRATOR merge
  // (measured: base blocked, candidate allowed).
  for (const command of [
    `gh ${mergeVerb} 123 -db --disable-auto --admin --squash`,
    `gh ${mergeVerb} 123 -d -b --disable-auto --admin --squash`,
    `gh ${mergeVerb} 123 --disable-auto --admin`,
  ]) {
    const res2 = runHook("pr-merge-guard.mjs", { tool_name: "Bash", tool_input: { command } });
    const parsed2 = res2.stdout.trim() ? JSON.parse(res2.stdout)?.hookSpecificOutput ?? {} : {};
    eq(parsed2.permissionDecision, "deny", `a cancellation never excuses --admin: ${command}`);
  }

  // Codex sol (2026-09-20, round 4): which shorts take a VALUE decides which
  // pull request the gate vets. `-r` is --rebase (boolean) and `-A` is
  // --author-email (a value), so reading them the other way round aimed every
  // downstream check — objections, green checks, risky diff, exact-SHA proof —
  // at a DIFFERENT PR than gh merges. A bundled `-R` lost the repository the
  // same way. The discriminating evidence is the parser-level selector/repo
  // assertions in pr-merge-guard.test.mjs, measured against gh's own manual;
  // these confirm the whole guard process still refuses the spellings.
  for (const command of [
    `gh ${mergeVerb} -dr 789 --squash`,
    `gh ${mergeVerb} -dR other/repo 789 --squash`,
    `gh ${mergeVerb} -A someone@example.com 789 --squash`,
  ]) {
    const res3 = runHook("pr-merge-guard.mjs", { tool_name: "Bash", tool_input: { command } });
    const parsed3 = res3.stdout.trim() ? JSON.parse(res3.stdout)?.hookSpecificOutput ?? {} : {};
    eq(parsed3.permissionDecision, "deny", `a bundled short never lands an unvetted merge: ${command}`);
  }

  // A configured remote name may legally contain `/`, and git resolves
  // `push team/origin` as that remote. Scoping by the token's SHAPE read it as a
  // raw URL — which means "no remote.<name>.* applies" — so a mirrored
  // `team/origin` skipped every per-remote check and the push was ALLOWED.
  // Fail-open hole introduced by the scoping fix itself; found by Codex on
  // 2026-08-06 and reproduced against the shipped guard before fixing. An
  // existing remote now wins over the URL heuristic.
  git("config", "remote.team/origin.url", "https://github.com/masonwells1/CRX_Manager_V1.0.git");
  git("config", "remote.team/origin.mirror", "true");
  const slashed = runHook("codex-push-guard.mjs", {
    cwd: mirrorRepo,
    tool_name: "Bash",
    tool_input: { command: `git -C ${mirrorRepo} ${pushVerb} team/origin` },
  });
  ok(/mirror/.test(slashed.stdout), "a mirrored remote whose NAME contains `/` still denies");
  git("config", "--unset", "remote.team/origin.mirror");
  git("config", "--unset", "remote.team/origin.url");

  // Control, same harness: without the mirror flag the identical push is allowed.
  // The check above widened a deny to every push form, so this pins that it did
  // not become a blanket refusal.
  const clean = runHook("codex-push-guard.mjs", {
    cwd: mirrorRepo,
    tool_name: "Bash",
    tool_input: { command: `git -C ${mirrorRepo} ${pushVerb} origin feature` },
  });
  eq(clean.stdout.trim(), "", "no mirror flag → ordinary feature push still passes through");

  fs.rmSync(mirrorRepo, { recursive: true, force: true });
}

// codex-push-guard: with inherited GIT_CONFIG* present, the repositories proven
// are the ones the pushes actually run in — not the session's cwd unconditionally.
// Regression test for a fix on 2026-08-06 (found by Codex, reproduced first): the
// cwd was always added to that set, so `git -C <repo> push` issued from a cwd that
// is not itself a checkout denied on a `rev-parse` of the unrelated outer
// directory, blocking an ordinary feature push that never touched it. `-C` is a
// documented global form. The deny must survive in the direction that matters.
{
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "crx-outer-")); // deliberately NOT a repo
  const repo = path.join(outer, "repo");
  fs.mkdirSync(repo);
  const git = (...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  spawnSync("git", ["init", "-q", repo], { encoding: "utf8" });
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("config", "commit.gpgsign", "false");
  git("commit", "--allow-empty", "-q", "-m", "init");
  git("branch", "-M", "feature");
  git("config", "remote.origin.url", "https://github.com/masonwells1/CRX_Manager_V1.0.git");

  const pushVerb = "pu" + "sh"; // keep the literal out of this file's own text
  const runWithEnv = (payload, overrides) => spawnSync(
    process.execPath,
    [path.join(__dirname, "codex-push-guard.mjs")],
    { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, ...overrides } },
  );
  // Harmless: cannot redirect anything. Denying on it is pure over-refusal.
  const benign = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Benign" };
  // Genuinely moves the destination off GitHub. Must deny however it is invoked.
  const redirecting = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "url.https://evil.example.com/.insteadOf",
    GIT_CONFIG_VALUE_0: "https://github.com/",
  };
  const withC = `git -C ${repo} ${pushVerb} origin HEAD:feature`;
  const bare = `git ${pushVerb} origin HEAD:feature`;

  eq(runWithEnv({ cwd: outer, tool_name: "Bash", tool_input: { command: withC } }, benign).stdout.trim(), "",
    "benign inherited override: `-C <repo>` from a non-repo cwd is not denied");
  eq(runWithEnv({ cwd: repo, tool_name: "Bash", tool_input: { command: withC } }, benign).stdout.trim(), "",
    "benign inherited override: `-C <repo>` from the repo itself is not denied");
  ok(/deny/.test(runWithEnv({ cwd: outer, tool_name: "Bash", tool_input: { command: withC } }, redirecting).stdout),
    "redirecting override still denies `-C <repo>` from a non-repo cwd");
  ok(/deny/.test(runWithEnv({ cwd: repo, tool_name: "Bash", tool_input: { command: withC } }, redirecting).stdout),
    "redirecting override still denies `-C <repo>` from the repo itself");
  // No `-C` genuinely resolves to the cwd, so an unreadable cwd is a real failure
  // to prove — that one must keep denying, and is why the fix is a scoping change
  // rather than dropping the unprovable case.
  ok(/deny/.test(runWithEnv({ cwd: outer, tool_name: "Bash", tool_input: { command: bare } }, benign).stdout),
    "a push with no `-C` from an unreadable cwd still denies");

  fs.rmSync(outer, { recursive: true, force: true });
}

console.log(`guards: ${pass} assertions passed`);
