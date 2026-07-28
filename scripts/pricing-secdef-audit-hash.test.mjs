#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = "supabase/migrations/20260728182141_secdef_pricing_reads_office_only.sql";
const auditPath = "docs/audits/2026-07-28-pricing-secdef-caller-analysis.md";

function readIndex(relativePath) {
  const result = spawnSync("git", ["show", `:${relativePath}`], {
    cwd: repoRoot,
    encoding: null,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `git index read failed for ${relativePath}: ${result.stderr}`);
  return result.stdout;
}

const migration = readIndex(migrationPath);
const audit = readIndex(auditPath).toString("utf8");
const expectedBlob = audit.match(/Git blob: `([0-9a-f]{40})`/i)?.[1]?.toLowerCase();
const expectedSha256 = audit.match(/SHA-256: `([0-9a-f]{64})`/i)?.[1]?.toLowerCase();
assert.ok(expectedBlob, "caller-analysis audit must declare the migration git blob");
assert.ok(expectedSha256, "caller-analysis audit must declare the migration SHA-256");

const actualBlob = createHash("sha1")
  .update(Buffer.from(`blob ${migration.length}\0`))
  .update(migration)
  .digest("hex");
const actualSha256 = createHash("sha256").update(migration).digest("hex");
assert.equal(actualBlob, expectedBlob, "caller-analysis audit git blob no longer matches the applied migration");
assert.equal(actualSha256, expectedSha256, "caller-analysis audit SHA-256 no longer matches the applied migration");
assert.match(audit, /caller-analysis: compute_application_service_fee ::/);
assert.match(audit, /caller-analysis: get_program_completion ::/);

console.log("pricing-secdef-audit-hash: applied migration and caller analysis are hash-bound");
