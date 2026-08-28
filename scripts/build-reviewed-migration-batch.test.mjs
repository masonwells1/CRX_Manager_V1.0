import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { topLevelSkeleton } from "../.claude/hooks/migration-wrappability-lib.mjs";

import {
  buildAtomicMigrationSql,
  CRX_PRODUCTION_REF,
  LEDGER_GUARD_MIGRATION,
  LEDGER_GUARD_PROSRC,
  listRequiredEarlierMigrations,
  prepareBatch,
  readRegularMigrationBlob,
  transactionCompatibility,
} from "./build-reviewed-migration-batch.mjs";
import {
  collectAllPages,
  selectExactMergedPr,
  selectTrustedCodeRabbitApproval,
  validateNewMigrationGitBinding,
  validateReviewInputs,
  validateTrustedDispatch,
} from "./production-migration-review-lib.mjs";
import {
  acquireMainFreeze,
  assertExactFreezeRuleset,
  buildFreezeRuleset,
  freezeName,
  releaseMainFreeze,
  verifyMainFreeze,
} from "./production-main-freeze.mjs";

const MIGRATION = "20990101010101_test_safe_batch";
const PRIOR = "20980101010101_prior_safe_batch";
const REQUIRED_EARLIER = [{ version: "20980101010101", name: "prior_safe_batch", fullStem: PRIOR }];
const SQL = [
  "-- transaction words in comments are data: COMMIT",
  "COMMENT ON TABLE public.customers IS 'ROLLBACK is text';",
  "",
].join("\n");
const HASH = createHash("sha256").update(SQL).digest("hex");

const workflow = readFileSync(path.join(process.cwd(), ".github", "workflows", "production-migration.yml"), "utf8");
const runbook = readFileSync(path.join(process.cwd(), "docs", "reference", "production-migration-approval-gate.md"), "utf8");
const ledgerGuardMigration = readFileSync(path.join(process.cwd(), "supabase", "migrations", `${LEDGER_GUARD_MIGRATION}.sql`), "utf8").replace(/\r\n/g, "\n");
const ledgerGuardBody = /AS \$function\$([\s\S]*?)\$function\$;/.exec(ledgerGuardMigration);
assert.equal(ledgerGuardBody?.[1], LEDGER_GUARD_PROSRC,
  "the live ledger trigger body must stay byte-bound to the workflow invariant check");
assert.match(ledgerGuardMigration, /pg_advisory_xact_lock\(1129465937\)/);
assert.match(ledgerGuardMigration, /authored_version <= latest_version/);
assert.match(ledgerGuardMigration, /BEFORE INSERT ON supabase_migrations\.schema_migrations/);
assert.match(workflow, /^\s*environment: production-database\s*$/m,
  "the credential-bearing job must use the protected production-database environment");
assert.match(workflow, /test "\$GITHUB_REF" = "refs\/heads\/main"/,
  "workflow dispatch must fail unless GitHub runs the workflow definition from main");
assert.match(workflow, /^\s*deployments: read\s*$/m,
  "the workflow may inspect deployments before approval");
assert.doesNotMatch(workflow, /^\s*deployments: write\s*$/m,
  "the workflow token must never gain deployment approval capability");
assert.match(workflow, /actual_reviewers.*expected_reviewer/,
  "preflight must require Mason as the only configured reviewer");
assert.match(workflow, /can_admins_bypass.*!=\s*"false"/,
  "preflight must fail while administrators can bypass the approval");
assert.doesNotMatch(workflow, /prevent_self_review \/\/ true|can_admins_bypass \/\/ true/,
  "explicit false environment settings must not be replaced by jq's alternative operator");
assert.match(workflow, /protected_branches.*!=\s*"true"/,
  "preflight must require the environment to accept protected branches only");
assert.match(workflow, /Verify human-dispatched exact-commit migration review/,
  "preflight must bind Mason's manual dispatch to exact review evidence before approval");
assert.match(workflow, /verify-production-migration-review\.mjs/,
  "the durable review verifier must be invoked by a literal script path");
assert.doesNotMatch(workflow, /review_evidence|review_proof_sha256/i,
  "caller-supplied review claims must never satisfy the production gate");
assert.doesNotMatch(workflow, /actions\/(?:upload|download)-artifact/,
  "the production gate must retrieve reviewer provenance from GitHub, not a caller-provided artifact");
assert.doesNotMatch(workflow, /uses:\s+[^\s]+@v\d+/,
  "production workflows must never trust mutable major-version action tags");
assert.match(workflow, /supabase link[\s\S]*git ls-remote origin refs\/heads\/main[\s\S]*git cat-file blob[\s\S]*supabase db query/,
  "current main and the exact migration blob must be rechecked immediately before SQL execution");
assert.match(workflow, /production-main-freeze\.mjs acquire[\s\S]*production-main-freeze\.mjs verify[\s\S]*supabase db query[\s\S]*if:\s*always\(\)[\s\S]*production-main-freeze\.mjs release/,
  "the workflow must freeze main before its final verification and release the exact freeze after SQL finishes");
assert.match(workflow, /PRODUCTION_BRANCH_FREEZE_TOKEN:\s*\$\{\{\s*secrets\.PRODUCTION_BRANCH_FREEZE_TOKEN\s*\}\}/,
  "the branch-freeze credential must come from the protected environment");
assert.equal((workflow.match(/PRODUCTION_BRANCH_FREEZE_TOKEN:\s*\$\{\{\s*secrets\.PRODUCTION_BRANCH_FREEZE_TOKEN\s*\}\}/g) || []).length, 3,
  "only the acquire, verify, and cleanup helper steps may receive the branch-freeze credential");
assert.match(workflow, /supabase\/setup-cli@46f7f98c7f948ad727d22c1e67fab04c223a0520/,
  "the credential-bearing job must pin the audited Supabase setup action release");
assert.match(workflow, /INSTALLED_VERSION[\s\S]*2\.109\.1/,
  "the installed CLI artifact version must be independently verified");
assert.match(runbook, /Actions:\s*\*\*read only\*\*/i,
  "the one-account Codex token must not be able to dispatch workflows");
assert.doesNotMatch(runbook, /Actions:\s*read and write/i,
  "the runbook must never grant the Codex token workflow-dispatch capability");

const canary = readFileSync(path.join(process.cwd(), ".github", "workflows", "production-approval-canary.yml"), "utf8");
assert.match(canary, /^\s*environment: production-database\s*$/m,
  "the harmless canary must exercise the real protected environment");
assert.doesNotMatch(canary, /SUPABASE|PRODUCTION_DB_PASSWORD|supabase\s/i,
  "the canary must not reference credentials, Supabase, or a production command");
assert.doesNotMatch(canary, /^\s*deployments: write\s*$/m,
  "the canary token must never gain deployment approval capability");
assert.doesNotMatch(canary, /prevent_self_review \/\/ true|can_admins_bypass \/\/ true/,
  "the canary must preserve explicit false environment settings");

const REVIEWED = "1".repeat(40);
const MERGED = "2".repeat(40);
const REVIEW_HASH = "a".repeat(64);
const reviewInput = {
  expectedCommit: MERGED,
  reviewedCommit: REVIEWED,
  migrationName: MIGRATION,
  queryHash: REVIEW_HASH,
};
assert.doesNotThrow(() => validateReviewInputs(reviewInput));
assert.throws(() => validateReviewInputs({
  ...reviewInput,
  migrationName: "99999999999999_alias_20260101000000_stale",
}), /non-replayable/);
assert.doesNotThrow(() => validateTrustedDispatch({
  actor: "masonwells1", owner: "masonwells1", eventName: "workflow_dispatch",
}));
assert.throws(() => validateTrustedDispatch({
  actor: "masonwells1", owner: "masonwells1", eventName: "push",
}), /manually dispatched/);
const mergedPr = {
  number: 500,
  state: "closed",
  merged_at: "2026-08-27T00:00:00Z",
  base: { ref: "main" },
  head: { sha: REVIEWED },
  merge_commit_sha: MERGED,
};
assert.equal(selectExactMergedPr([mergedPr], reviewInput), mergedPr);
assert.equal(selectExactMergedPr([{ ...mergedPr, merge_commit_sha: "3".repeat(40) }], reviewInput).merge_commit_sha, "3".repeat(40),
  "an unchanged migration may retain approval from its original merged PR after main advances");
assert.throws(() => selectExactMergedPr([{ ...mergedPr, merge_commit_sha: "not-a-commit" }], reviewInput), /one merged PR into main/);
const reviewedEntry = `100644 blob ${"4".repeat(40)}\tsupabase/migrations/${MIGRATION}.sql`;
assert.equal(validateNewMigrationGitBinding({ baseEntry: "", reviewedEntry, mergedEntry: reviewedEntry, currentEntry: reviewedEntry }), "4".repeat(40));
assert.throws(() => validateNewMigrationGitBinding({ baseEntry: reviewedEntry, reviewedEntry, mergedEntry: reviewedEntry, currentEntry: reviewedEntry }), /newly added by the exact reviewed PR/);
assert.throws(() => validateNewMigrationGitBinding({ baseEntry: "", reviewedEntry, mergedEntry: reviewedEntry, currentEntry: reviewedEntry.replace("4".repeat(40), "5".repeat(40)) }), /reviewed PR head, reviewed merge, and current main/);
assert.throws(() => validateNewMigrationGitBinding({ baseEntry: "", reviewedEntry, mergedEntry: reviewedEntry.replace("4".repeat(40), "5".repeat(40)), currentEntry: reviewedEntry }), /reviewed PR head, reviewed merge, and current main/);
assert.throws(() => validateNewMigrationGitBinding({ baseEntry: "", reviewedEntry: reviewedEntry.replace("100644", "120000"), mergedEntry: reviewedEntry, currentEntry: reviewedEntry }), /regular 100644 Git blob/);

const codeRabbitApproval = {
  id: 10,
  user: { login: "coderabbitai[bot]", type: "Bot" },
  state: "APPROVED",
  commit_id: REVIEWED,
  submitted_at: "2026-08-27T00:00:00Z",
};
assert.equal(selectTrustedCodeRabbitApproval([codeRabbitApproval], reviewInput), codeRabbitApproval);
assert.throws(() => selectTrustedCodeRabbitApproval([{ ...codeRabbitApproval, user: { login: "masonwells1", type: "User" } }], reviewInput), /authenticated CodeRabbit approval/);
assert.throws(() => selectTrustedCodeRabbitApproval([{ ...codeRabbitApproval, commit_id: "3".repeat(40) }], reviewInput), /authenticated CodeRabbit approval/);
assert.throws(() => selectTrustedCodeRabbitApproval([{ ...codeRabbitApproval, state: "CHANGES_REQUESTED" }], reviewInput), /authenticated CodeRabbit approval/);

const expectedMain = "9".repeat(40);
const exactFreezeName = freezeName("12345", "2");
const exactFreeze = { id: 77, ...buildFreezeRuleset(exactFreezeName) };
assert.equal(assertExactFreezeRuleset(exactFreeze, exactFreezeName), 77);
assert.throws(() => assertExactFreezeRuleset({ ...exactFreeze, bypass_actors: [{ actor_id: 5 }] }, exactFreezeName), /fail-closed ruleset/);
let liveMain = expectedMain;
let rulesets = [];
const freezeCalls = [];
const freezeRequest = async (apiPath, options = {}) => {
  freezeCalls.push([apiPath, options.method || "GET"]);
  if (apiPath.endsWith("/git/ref/heads/main")) return { body: { object: { sha: liveMain } }, link: "" };
  if (apiPath.includes("/rulesets?") && (options.method || "GET") === "GET") return { body: rulesets, link: "" };
  if (apiPath.endsWith("/rulesets") && options.method === "POST") {
    rulesets = [{ id: 77, ...options.body }];
    return { body: rulesets[0], link: "" };
  }
  if (apiPath.endsWith("/rulesets/77") && (options.method || "GET") === "GET" && !options.allow404) {
    return { body: rulesets[0], link: "" };
  }
  if (apiPath.endsWith("/rulesets/77") && options.method === "DELETE") {
    rulesets = [];
    return { status: 204, body: null, link: "" };
  }
  if (apiPath.endsWith("/rulesets/77") && options.allow404) return { status: 404, body: null, link: "" };
  throw new Error(`unexpected freeze request ${apiPath}`);
};
const createdState = [];
assert.deepEqual(await acquireMainFreeze({
  repository: "masonwells1/CRX_Manager_V1.0",
  expectedCommit: expectedMain,
  name: exactFreezeName,
  request: freezeRequest,
  onCreated: (state) => createdState.push(state),
}), { id: 77, name: exactFreezeName });
assert.deepEqual(createdState, [{ id: 77, name: exactFreezeName }], "freeze state must be durable immediately after creation");
await verifyMainFreeze({ repository: "masonwells1/CRX_Manager_V1.0", expectedCommit: expectedMain, name: exactFreezeName, request: freezeRequest });
assert.deepEqual(await releaseMainFreeze({ repository: "masonwells1/CRX_Manager_V1.0", name: exactFreezeName, request: freezeRequest }), { released: true, id: 77 });
assert.equal(rulesets.length, 0);
assert.ok(freezeCalls.some(([apiPath, method]) => apiPath.endsWith("/rulesets") && method === "POST"));
rulesets = [{ id: 88, ...buildFreezeRuleset(`${exactFreezeName}-stale`) }];
await assert.rejects(() => acquireMainFreeze({
  repository: "masonwells1/CRX_Manager_V1.0",
  expectedCommit: expectedMain,
  name: exactFreezeName,
  request: freezeRequest,
}), /existing production migration freeze/);
rulesets = [];
let movingMainChecks = 0;
const raceState = [];
const movingMainRequest = async (apiPath, options = {}) => {
  if (apiPath.endsWith("/git/ref/heads/main")) {
    movingMainChecks += 1;
    return { body: { object: { sha: movingMainChecks === 1 ? expectedMain : "8".repeat(40) } }, link: "" };
  }
  if (apiPath.includes("/rulesets?")) return { body: [], link: "" };
  if (apiPath.endsWith("/rulesets") && options.method === "POST") return { body: exactFreeze, link: "" };
  throw new Error(`unexpected moving-main request ${apiPath}`);
};
await assert.rejects(() => acquireMainFreeze({
  repository: "masonwells1/CRX_Manager_V1.0",
  expectedCommit: expectedMain,
  name: exactFreezeName,
  request: movingMainRequest,
  onCreated: (state) => raceState.push(state),
}), /main moved while the production freeze was being acquired/);
assert.deepEqual(raceState, [{ id: 77, name: exactFreezeName }],
  "a freeze created during a main race must be recorded for the always-run cleanup step");
assert.throws(() => selectTrustedCodeRabbitApproval([
  codeRabbitApproval,
  { ...codeRabbitApproval, id: 11, state: "CHANGES_REQUESTED", submitted_at: "2026-08-27T00:01:00Z" },
], reviewInput), /authenticated CodeRabbit approval/,
"a later exact-commit changes-requested review must supersede an earlier approval");
const pagedReviews = await collectAllPages(async (page) => page === 1
  ? Array.from({ length: 100 }, (_, index) => ({ ...codeRabbitApproval, id: index + 1 }))
  : [{ ...codeRabbitApproval, id: 101, state: "CHANGES_REQUESTED", submitted_at: "2026-08-27T00:01:00Z" }]);
assert.equal(pagedReviews.length, 101);
assert.throws(() => selectTrustedCodeRabbitApproval(pagedReviews, reviewInput), /authenticated CodeRabbit approval/,
  "a changes-requested review beyond the first API page must remain visible");
await assert.rejects(() => collectAllPages(async () => Array.from({ length: 100 }, () => ({})), 100, 2),
  /fail-closed page limit/,
  "pagination must fail closed rather than silently truncate an unexpectedly large review history");


assert.deepEqual(transactionCompatibility(SQL), { ok: true });
const bareCrExploit = "CREATE DOMAIN public.crx_probe AS text; -- review-only comment\rDELETE FROM public.customers;";
assert.match(transactionCompatibility(bareCrExploit).reason, /bare carriage return/,
  "a lone carriage return must be refused before PostgreSQL can end the line comment");
assert.match(topLevelSkeleton(bareCrExploit), /DELETE FROM public\.customers/i,
  "the shared top-level scanner must terminate a line comment on a lone carriage return");

for (const [sql, reasonPattern] of [
  ["BEGIN; SELECT 1; COMMIT;", /top-level (?:BEGIN|COMMIT)/],
  ["COMMIT AND CHAIN;", /top-level COMMIT/],
  ["COMMIT WORK AND NO CHAIN;", /top-level COMMIT/],
  ["ROLLBACK AND CHAIN;", /top-level ROLLBACK/],
  ["ABORT TRANSACTION AND NO CHAIN;", /top-level ROLLBACK/],
  ["END;", /top-level END/],
  ["END WORK AND CHAIN;", /top-level END/],
  ["START TRANSACTION;", /START TRANSACTION/],
  ["SAVEPOINT before_change;", /SAVEPOINT/],
  ["SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;", /SET TRANSACTION/],
  ["VACUUM public.widgets;", /VACUUM/],
  ["ALTER SYSTEM SET work_mem = '1GB';", /ALTER SYSTEM/],
  ["CREATE UNIQUE INDEX CONCURRENTLY idx_x ON x(id);", /CREATE INDEX CONCURRENTLY/],
  ["DROP INDEX CONCURRENTLY idx_x;", /DROP INDEX CONCURRENTLY/],
  ["CREATE DATABASE shadow_copy;", /CREATE DATABASE/],
  ["CLUSTER public.widgets;", /CLUSTER/],
  ["CALL public.maybe_commits();", /^CALL$/],
  ["SELECT public.close_accounting_period();", /top-level SELECT/],
  ["COMMENT ON TABLE public.safe_batch_probe IS E'escaped\\' quote'; DELETE FROM public.customers;", /destructive migration: top-level DELETE/],
  ["CREATE FUNCTION public.crx_review_bypass() RETURNS integer LANGUAGE plpgsql AS $body$ BEGIN DELETE FROM public.customers; RETURN 1; END $body$; VALUES (public.crx_review_bypass());", /outside the audited DDL allowlist/],
  ["CREATE TABLE public.crx_review_copy AS SELECT public.close_accounting_period();", /outside the audited DDL allowlist/],
  ["COPY (SELECT public.close_accounting_period()) TO STDOUT;", /outside the audited DDL allowlist/],
  ["CREATE MATERIALIZED VIEW public.crx_review_mv AS SELECT public.close_accounting_period();", /outside the audited DDL allowlist/],
  ["WITH changed AS (UPDATE public.customers SET active = false RETURNING id) SELECT count(*) FROM changed;", /outside the audited DDL allowlist/],
  ["INSERT INTO public.customers (name) VALUES ('unsafe');", /outside the audited DDL allowlist/],
  ["CREATE TABLE public.unprotected_probe (id bigint);", /outside the audited DDL allowlist/],
  ["CREATE TABLE public.rls_probe (id bigint); ALTER TABLE public.rls_probe ENABLE ROW LEVEL SECURITY;", /outside the audited DDL allowlist/],
  ["CREATE FUNCTION public.insecure_mutator() RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $body$ BEGIN UPDATE public.customers SET active = false; END $body$;", /outside the audited DDL allowlist/],
  ["CREATE FUNCTION public.no_idempotency_key(p_customer_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $body$ BEGIN UPDATE public.customers SET active = false WHERE id = p_customer_id; END $body$;", /outside the audited DDL allowlist/],
  ["CREATE PROCEDURE public.insecure_procedure() LANGUAGE plpgsql AS $body$ BEGIN UPDATE public.customers SET active = false; END $body$;", /outside the audited DDL allowlist/],
  ["CREATE POLICY permissive_probe ON public.customers FOR ALL TO authenticated USING (true) WITH CHECK (true);", /outside the audited DDL allowlist/],
  ["SET LOCAL statement_timeout = 0;", /outside the audited DDL allowlist/],
  ["SET LOCAL lock_timeout = 0;", /outside the audited DDL allowlist/],
  ["SET LOCAL search_path = attacker, public;", /outside the audited DDL allowlist/],
  ["SET LOCAL check_function_bodies = off;", /outside the audited DDL allowlist/],
  ["CREATE TYPE public.unreviewed_status AS ENUM ('ready');", /outside the audited DDL allowlist/],
  ["CREATE DOMAIN public.unreviewed_text AS text CHECK (public.some_function(VALUE));", /outside the audited DDL allowlist/],
  ["CREATE SEQUENCE public.unreviewed_number_seq;", /outside the audited DDL allowlist/],
  ["ALTER SEQUENCE public.invoice_number_seq RESTART WITH 1;", /outside the audited DDL allowlist/],
  ["ALTER SEQUENCE public.invoice_number_seq CYCLE;", /outside the audited DDL allowlist/],
  ["ALTER SEQUENCE public.invoice_number_seq MAXVALUE 10;", /outside the audited DDL allowlist/],
  ["ALTER TYPE public.email_type RENAME VALUE 'pre_application_notice' TO 'post_application_notice';", /outside the audited DDL allowlist/],
  ["ALTER TYPE public.email_type ADD VALUE 'unreviewed_lifecycle';", /outside the audited DDL allowlist/],
  ["DROP VIEW public.customer_statement_view;", /outside the audited DDL allowlist/],
  ["DROP INDEX public.invoice_number_idx;", /outside the audited DDL allowlist/],
  ["GRANT SELECT ON TABLE public.customers TO authenticated;", /outside the audited DDL allowlist/],
  ["GRANT EXECUTE ON FUNCTION public.safe_batch_probe_fn() TO authenticated, service_role;", /outside the audited DDL allowlist/],
  ["REVOKE ALL ON FUNCTION public.safe_batch_probe_fn() FROM PUBLIC, anon;", /outside the audited DDL allowlist/],
  ["GRANT EXECUTE ON FUNCTION public.safe_batch_probe_fn() TO PUBLIC;", /outside the audited DDL allowlist/],
  ["GRANT USAGE ON SCHEMA \"supabase_migrations\" TO PUBLIC; GRANT INSERT, UPDATE, DELETE ON TABLE \"supabase_migrations\".\"schema_migrations\" TO PUBLIC;", /protected migration ledger reference/],
  ["CREATE FUNCTION public.crx_unicode_ledger_bypass() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$ BEGIN DELETE FROM U&\"supabase\\005fmigrations\".schema_migrations; END $body$; GRANT EXECUTE ON FUNCTION public.crx_unicode_ledger_bypass() TO authenticated;", /Unicode-escaped SQL syntax/],
  ["CREATE SCHEMA crx_gate_probe GRANT ALL ON TABLE public.customers TO anon;", /outside the audited DDL allowlist/],
  ["CREATE SCHEMA crx_gate_probe CREATE TRIGGER crx_probe BEFORE INSERT ON public.customers FOR EACH ROW EXECUTE FUNCTION public.crx_review_bypass();", /outside the audited DDL allowlist/],
  ["CREATE VIEW public.crx_auth_exposure AS SELECT * FROM auth.users;", /outside the audited DDL allowlist/],
  ["CREATE VIEW public.crx_customer_exposure AS SELECT * FROM public.customers;", /outside the audited DDL allowlist/],
  ["CREATE VIEW public.crx_unicode_exposure AS SELECT * FROM U&\"\\0061uth\".users;", /Unicode-escaped SQL syntax/],
  ["CREATE TRIGGER crx_review_bypass BEFORE INSERT ON public.customers FOR EACH ROW EXECUTE FUNCTION public.crx_review_bypass();", /outside the audited DDL allowlist/],
  ["CREATE FUNCTION public.crx_review_bypass() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN DELETE FROM public.customers; RETURN NEW; END $body$; CREATE TRIGGER crx_review_bypass BEFORE INSERT ON supabase_migrations.schema_migrations FOR EACH ROW EXECUTE FUNCTION public.crx_review_bypass();", /protected migration ledger reference/],
  ["DO $safe$ BEGIN IF EXISTS (SELECT 1) THEN NULL; END IF; END $safe$;", /top-level DO/],
  ["DO $unsafe$ BEGIN DELETE/**/FROM public.customers; END $unsafe$;", /top-level DO/],
  ["DO $unsafe$ BEGIN PERFORM public.close_accounting_period(); END $unsafe$;", /top-level DO/],
  ["DO $unsafe$ BEGIN EXECUTE 'DEL' || 'ETE FROM public.customers'; END $unsafe$;", /top-level DO/],
  ["DELETE FROM public.customers;", /destructive migration: top-level DELETE/],
  ["TRUNCATE public.inventory_transactions;", /destructive migration: TRUNCATE/],
  ["DROP TABLE public.customers;", /destructive migration: DROP TABLE/],
  ["ALTER TABLE public.customers DROP COLUMN legacy_code;", /destructive migration: ALTER TABLE/],
  ["MERGE INTO public.customers USING public.duplicates ON false WHEN MATCHED THEN DELETE;", /destructive migration: MERGE INTO/],
  ["DROP SCHEMA archive CASCADE;", /destructive migration: DROP SCHEMA/],
  ["DROP TYPE public.old_status CASCADE;", /destructive migration: DROP SCHEMA/],
  ["SET standard_conforming_strings = off;", /^standard_conforming_strings override$/],
  ["SELECT 'unterminated", /could not be tokenized/],
  ["\\copy public.x from 'x.csv'", /^client meta-command$/],
  ["CREATE TABLE public.x(id bigint); \\! env", /^client meta-command$/],
  ["CREATE TABLE public.x(id bigint); \\copy public.x from 'x.csv'", /^client meta-command$/],
]) {
  const result = transactionCompatibility(sql);
  assert.equal(result.ok, false, `${reasonPattern} must be rejected`);
  assert.match(result.reason, reasonPattern);
}
assert.equal(transactionCompatibility("SELECT '\\'; COMMIT;").ok, false,
  "standard-string quoting cannot hide a following COMMIT");
assert.equal(transactionCompatibility("SELECT E'escaped\\' quote'; COMMIT AND CHAIN;").ok, false,
  "escape-string quoting cannot hide a following transaction-ending statement");
assert.match(transactionCompatibility("SELECT E'COMMIT\\' is text'; SELECT 1;").reason, /top-level SELECT/,
  "even read-looking top-level SELECT statements stay outside the production migration path");

const batch = buildAtomicMigrationSql({ migrationName: MIGRATION, query: SQL, queryHash: HASH, requiredEarlierMigrations: REQUIRED_EARLIER });
assert.ok(batch.startsWith("BEGIN;\n"));
assert.ok(batch.endsWith("COMMIT;\n"));
assert.match(batch, /^SET LOCAL standard_conforming_strings = on;$/m);
assert.match(batch, /^SELECT pg_advisory_xact_lock\(1129465937\);$/m);
assert.match(batch, /^LOCK TABLE supabase_migrations\.schema_migrations IN SHARE ROW EXCLUSIVE MODE;$/m);
assert.ok(batch.indexOf("LOCK TABLE") < batch.indexOf("SELECT pg_advisory_xact_lock"),
  "the ledger table lock must precede the advisory lock to match ordinary INSERT lock order");
assert.ok(batch.includes("SELECT max(effective_version) INTO latest_version"));
assert.ok(batch.includes("latest_version >= '20990101010101'"));
assert.ok(batch.includes("CRX migration is not newer than the live ledger"));
assert.ok(batch.includes(PRIOR));
assert.ok(batch.includes("CRX older repository migration is not recorded live"));
assert.ok(batch.indexOf("CRX older repository migration is not recorded live") < batch.indexOf(SQL.trimEnd()));
assert.equal((batch.match(/CRX global migration ledger ordering guard/g) || []).length, 2,
  "the exact global ledger guard must be checked before candidate SQL and immediately before ledger insert");
assert.ok(batch.indexOf("guard changed during candidate SQL") < batch.indexOf("INSERT INTO supabase_migrations.schema_migrations"));
assert.ok(batch.includes(`  '${MIGRATION}',`), "the ledger row must retain the authored timestamped migration name");
assert.ok(batch.includes(`OR idempotency_key = '${HASH}'`),
  "the live ledger must reject exact SQL replay under a renamed migration");
assert.ok(batch.indexOf("LOCK TABLE") < batch.indexOf("SELECT max(effective_version)"));
assert.ok(batch.indexOf("SELECT max(effective_version)") < batch.indexOf(SQL.trimEnd()));
assert.ok(batch.indexOf(SQL.trimEnd()) < batch.indexOf("INSERT INTO supabase_migrations.schema_migrations"));
assert.ok(batch.indexOf("INSERT INTO supabase_migrations.schema_migrations") < batch.indexOf("content-bound migration ledger verification"));
assert.ok(batch.indexOf("content-bound migration ledger verification") < batch.lastIndexOf("COMMIT;"));
assert.ok(batch.includes(HASH));

const root = mkdtempSync(path.join(tmpdir(), "crx-reviewed-batch-"));
try {
  const migrations = path.join(root, "supabase", "migrations");
  const baselines = path.join(root, "supabase", "baselines");
  mkdirSync(migrations, { recursive: true });
  mkdirSync(baselines, { recursive: true });
  writeFileSync(path.join(baselines, "manifest.json"), JSON.stringify({ migrations_high_water: "20970101010101" }));
  writeFileSync(path.join(migrations, `${PRIOR}.sql`), "CREATE TABLE public.prior_safe_batch_probe (id bigint);\n");
  writeFileSync(path.join(migrations, `${MIGRATION}.sql`), SQL);
  const runGit = (args, input) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", input, shell: false, windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return (result.stdout || "").trim();
  };
  runGit(["init", "-q"]);
  runGit(["config", "user.email", "gate-test@example.invalid"]);
  runGit(["config", "user.name", "Gate Test"]);
  runGit(["add", "supabase"]);
  runGit(["commit", "-q", "-m", "fixture"]);
  const expectedCommit = runGit(["rev-parse", "HEAD"]);
  const output = path.join(root, "batch.sql");

  assert.throws(
    () => prepareBatch({ repoRoot: root, projectId: "wrong", expectedCommit, migrationName: MIGRATION, queryHash: HASH, output }),
    /fixed CRX production project/,
  );
  assert.throws(
    () => prepareBatch({ repoRoot: root, projectId: CRX_PRODUCTION_REF, expectedCommit, migrationName: `${MIGRATION}.sql`, queryHash: HASH, output }),
    /exact file stem/,
  );
  assert.throws(
    () => prepareBatch({
      repoRoot: root,
      projectId: CRX_PRODUCTION_REF,
      expectedCommit,
      migrationName: "99999999999999_alias_20260101000000_old_migration",
      queryHash: HASH,
      output,
    }),
    /exact file stem/,
    "a second embedded timestamp must never be accepted as a fresh migration identity",
  );
  assert.throws(
    () => prepareBatch({ repoRoot: root, projectId: CRX_PRODUCTION_REF, expectedCommit, migrationName: "20990101010102_missing", queryHash: HASH, output }),
    /regular 100644 Git blob/,
  );
  assert.throws(
    () => prepareBatch({ repoRoot: root, projectId: CRX_PRODUCTION_REF, expectedCommit, migrationName: MIGRATION, queryHash: "0".repeat(64), output }),
    /hash mismatch/,
  );
  assert.equal(existsSync(output), false, "invalid inputs must not create a batch");

  assert.equal(readRegularMigrationBlob({ repoRoot: root, expectedCommit, migrationName: MIGRATION }), SQL);
  assert.deepEqual(listRequiredEarlierMigrations({ repoRoot: root, expectedCommit, migrationName: MIGRATION }), REQUIRED_EARLIER);
  const result = prepareBatch({ repoRoot: root, projectId: CRX_PRODUCTION_REF, expectedCommit, migrationName: MIGRATION, queryHash: HASH, output });
  assert.deepEqual(result, { migrationName: MIGRATION, queryHash: HASH, output });
  assert.equal(readFileSync(output, "utf8"), batch);
  assert.throws(
    () => prepareBatch({ repoRoot: root, projectId: CRX_PRODUCTION_REF, expectedCommit, migrationName: MIGRATION, queryHash: HASH, output }),
    /EEXIST/,
    "batch output may not be overwritten",
  );
  const linkBlob = runGit(["hash-object", "-w", "--stdin"], "elsewhere.sql");
  runGit(["update-index", "--add", "--cacheinfo", `120000,${linkBlob},supabase/migrations/${MIGRATION}.sql`]);
  runGit(["commit", "-q", "-m", "symlink fixture"]);
  const symlinkCommit = runGit(["rev-parse", "HEAD"]);
  assert.throws(
    () => prepareBatch({
      repoRoot: root,
      projectId: CRX_PRODUCTION_REF,
      expectedCommit: symlinkCommit,
      migrationName: MIGRATION,
      queryHash: HASH,
      output: path.join(root, "symlink-batch.sql"),
    }),
    /regular 100644 Git blob/,
    "a committed symlink must never redirect the SQL bytes executed by the builder",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("build-reviewed-migration-batch: all assertions passed; no network or live database used");
