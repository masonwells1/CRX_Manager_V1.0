import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildAtomicMigrationSql,
  CRX_PRODUCTION_REF,
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

const MIGRATION = "20990101010101_test_safe_batch";
const SQL = [
  "-- transaction words in comments are data: COMMIT",
  "CREATE TABLE public.safe_batch_probe (note text DEFAULT 'END');",
  "CREATE FUNCTION public.safe_batch_probe_fn() RETURNS void LANGUAGE plpgsql AS $body$",
  "BEGIN",
  "  RAISE NOTICE 'ROLLBACK';",
  "END",
  "$body$;",
  "",
].join("\n");
const HASH = createHash("sha256").update(SQL).digest("hex");

const workflow = readFileSync(path.join(process.cwd(), ".github", "workflows", "production-migration.yml"), "utf8");
const runbook = readFileSync(path.join(process.cwd(), "docs", "reference", "production-migration-approval-gate.md"), "utf8");
assert.match(workflow, /^\s*environment: production-database\s*$/m,
  "the credential-bearing job must use the protected production-database environment");
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
assert.throws(() => selectExactMergedPr([{ ...mergedPr, merge_commit_sha: "3".repeat(40) }], reviewInput), /current main/);
const reviewedEntry = `100644 blob ${"4".repeat(40)}\tsupabase/migrations/${MIGRATION}.sql`;
assert.equal(validateNewMigrationGitBinding({ baseEntry: "", reviewedEntry, currentEntry: reviewedEntry }), "4".repeat(40));
assert.throws(() => validateNewMigrationGitBinding({ baseEntry: reviewedEntry, reviewedEntry, currentEntry: reviewedEntry }), /newly added by the exact reviewed PR/);
assert.throws(() => validateNewMigrationGitBinding({ baseEntry: "", reviewedEntry, currentEntry: reviewedEntry.replace("4".repeat(40), "5".repeat(40)) }), /changed after its exact reviewed PR head/);
assert.throws(() => validateNewMigrationGitBinding({ baseEntry: "", reviewedEntry: reviewedEntry.replace("100644", "120000"), currentEntry: reviewedEntry }), /regular 100644 Git blob/);

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

const batch = buildAtomicMigrationSql({ migrationName: MIGRATION, query: SQL, queryHash: HASH });
assert.ok(batch.startsWith("BEGIN;\n"));
assert.ok(batch.endsWith("COMMIT;\n"));
assert.match(batch, /^SET LOCAL standard_conforming_strings = on;$/m);
assert.match(batch, /^SELECT pg_advisory_xact_lock\(1129465937\);$/m);
assert.match(batch, /^LOCK TABLE supabase_migrations\.schema_migrations IN SHARE ROW EXCLUSIVE MODE;$/m);
assert.ok(batch.includes("SELECT max(effective_version) INTO latest_version"));
assert.ok(batch.includes("latest_version >= '20990101010101'"));
assert.ok(batch.includes("CRX migration is not newer than the live ledger"));
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
  mkdirSync(migrations, { recursive: true });
  writeFileSync(path.join(migrations, `${MIGRATION}.sql`), SQL);
  const runGit = (args, input) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", input, shell: false, windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return (result.stdout || "").trim();
  };
  runGit(["init", "-q"]);
  runGit(["config", "user.email", "gate-test@example.invalid"]);
  runGit(["config", "user.name", "Gate Test"]);
  runGit(["add", "supabase/migrations"]);
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
