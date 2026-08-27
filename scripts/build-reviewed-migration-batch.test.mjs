import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildAtomicMigrationSql,
  CRX_PRODUCTION_REF,
  prepareBatch,
  transactionCompatibility,
} from "./build-reviewed-migration-batch.mjs";
import {
  expectedAttestationBody,
  selectExactMergedPr,
  validateReviewComment,
  validateReviewInputs,
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
assert.match(workflow, /protected_branches.*!=\s*"true"/,
  "preflight must require the environment to accept protected branches only");
assert.match(workflow, /Verify durable exact-commit migration review/,
  "preflight must verify durable review evidence before approval");
assert.match(workflow, /verify-production-migration-review\.mjs/,
  "the durable review verifier must be invoked by a literal script path");
assert.doesNotMatch(workflow, /uses:\s+[^\s]+@v\d+/,
  "production workflows must never trust mutable major-version action tags");
assert.match(workflow, /supabase\/setup-cli@46f7f98c7f948ad727d22c1e67fab04c223a0520/,
  "the credential-bearing job must pin the audited Supabase setup action release");
assert.match(workflow, /INSTALLED_VERSION[\s\S]*2\.109\.1/,
  "the installed CLI artifact version must be independently verified");

const canary = readFileSync(path.join(process.cwd(), ".github", "workflows", "production-approval-canary.yml"), "utf8");
assert.match(canary, /^\s*environment: production-database\s*$/m,
  "the harmless canary must exercise the real protected environment");
assert.doesNotMatch(canary, /SUPABASE|PRODUCTION_DB_PASSWORD|supabase\s/i,
  "the canary must not reference credentials, Supabase, or a production command");
assert.doesNotMatch(canary, /^\s*deployments: write\s*$/m,
  "the canary token must never gain deployment approval capability");

const REVIEWED = "1".repeat(40);
const MERGED = "2".repeat(40);
const REVIEW_HASH = "a".repeat(64);
const reviewInput = {
  expectedCommit: MERGED,
  reviewedCommit: REVIEWED,
  migrationName: MIGRATION,
  queryHash: REVIEW_HASH,
  commentId: "12345",
};
assert.doesNotThrow(() => validateReviewInputs(reviewInput));
assert.throws(() => validateReviewInputs({
  ...reviewInput,
  migrationName: "99999999999999_alias_20260101000000_stale",
}), /non-replayable/);
const attestationBody = expectedAttestationBody(reviewInput);
assert.match(attestationBody, new RegExp("reviewed_commit=" + REVIEWED));
assert.match(attestationBody, /model=gpt-5\.6-sol\nreasoning_effort=high\nverdict=clean/);
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
assert.doesNotThrow(() => validateReviewComment({
  user: { login: "masonwells1" },
  author_association: "OWNER",
  body: attestationBody,
  issue_url: "https://api.github.com/repos/masonwells1/CRX_Manager_V1.0/issues/500",
}, { owner: "masonwells1", prNumber: 500, body: attestationBody }));
assert.throws(() => validateReviewComment({
  user: { login: "masonwells1" }, author_association: "OWNER", body: attestationBody + " ",
  issue_url: "https://api.github.com/repos/masonwells1/CRX_Manager_V1.0/issues/500",
}, { owner: "masonwells1", prNumber: 500, body: attestationBody }), /exact canonical/);

assert.deepEqual(transactionCompatibility(SQL), { ok: true });
assert.deepEqual(transactionCompatibility("SELECT CASE WHEN true THEN 1 ELSE 0 END;"), { ok: true });

for (const [sql, reasonPattern] of [
  ["BEGIN; SELECT 1; COMMIT;", /top-level (?:BEGIN|COMMIT)/],
  ["END;", /top-level END/],
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
  ["SET standard_conforming_strings = off;", /^standard_conforming_strings override$/],
  ["SELECT 'unterminated", /could not be tokenized/],
  ["\\copy public.x from 'x.csv'", /^client meta-command$/],
]) {
  const result = transactionCompatibility(sql);
  assert.equal(result.ok, false, `${reasonPattern} must be rejected`);
  assert.match(result.reason, reasonPattern);
}
assert.equal(transactionCompatibility("SELECT '\\'; COMMIT;").ok, false,
  "standard-string quoting cannot hide a following COMMIT");

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
  const output = path.join(root, "batch.sql");

  assert.throws(
    () => prepareBatch({ repoRoot: root, projectId: "wrong", migrationName: MIGRATION, queryHash: HASH, output }),
    /fixed CRX production project/,
  );
  assert.throws(
    () => prepareBatch({ repoRoot: root, projectId: CRX_PRODUCTION_REF, migrationName: `${MIGRATION}.sql`, queryHash: HASH, output }),
    /exact file stem/,
  );
  assert.throws(
    () => prepareBatch({
      repoRoot: root,
      projectId: CRX_PRODUCTION_REF,
      migrationName: "99999999999999_alias_20260101000000_old_migration",
      queryHash: HASH,
      output,
    }),
    /exact file stem/,
    "a second embedded timestamp must never be accepted as a fresh migration identity",
  );
  assert.throws(
    () => prepareBatch({ repoRoot: root, projectId: CRX_PRODUCTION_REF, migrationName: "20990101010102_missing", queryHash: HASH, output }),
    /does not exist/,
  );
  assert.throws(
    () => prepareBatch({ repoRoot: root, projectId: CRX_PRODUCTION_REF, migrationName: MIGRATION, queryHash: "0".repeat(64), output }),
    /hash mismatch/,
  );
  assert.equal(existsSync(output), false, "invalid inputs must not create a batch");

  const result = prepareBatch({ repoRoot: root, projectId: CRX_PRODUCTION_REF, migrationName: MIGRATION, queryHash: HASH, output });
  assert.deepEqual(result, { migrationName: MIGRATION, queryHash: HASH, output });
  assert.equal(readFileSync(output, "utf8"), batch);
  assert.throws(
    () => prepareBatch({ repoRoot: root, projectId: CRX_PRODUCTION_REF, migrationName: MIGRATION, queryHash: HASH, output }),
    /EEXIST/,
    "batch output may not be overwritten",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("build-reviewed-migration-batch: all assertions passed; no network or live database used");
