import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REVIEWERS = ["rls-security-reviewer", "migration-drift-reviewer"];
const STEM_RE = /^(\d{14})_((?![A-Za-z0-9_-]*\d{14})[A-Za-z0-9][A-Za-z0-9_-]*)$/;

function git(args, encoding = "utf8") {
  const result = spawnSync("git", args, { cwd: process.cwd(), encoding, shell: false, windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout;
}

export function extractCapturedReview(text, reviewer) {
  const source = String(text).replace(/\r\n/g, "\n");
  const header = /^exit=(\d+)\n\nSTDOUT\n/;
  const match = header.exec(source);
  const stderrMarker = "\n\nSTDERR\n";
  const stderrAt = source.indexOf(stderrMarker, match?.[0]?.length || 0);
  if (!match || Number(match[1]) !== 0 || stderrAt < 0) throw new Error(`${reviewer} capture did not record a successful reviewer process`);
  const stdout = source.slice(match[0].length, stderrAt);
  const tokens = stdout.match(/^CODEX_PROOF_VERDICT:\s*CLEAN\s*$/gm) || [];
  if (tokens.length !== 1 || stdout.trimEnd().split("\n").at(-1) !== "CODEX_PROOF_VERDICT: CLEAN") {
    throw new Error(`${reviewer} capture does not contain exactly one terminal clean verdict`);
  }
  return { reviewer, exitCode: 0, stdout };
}

export function committedMigrationIdentity(migrationName) {
  if (!STEM_RE.test(String(migrationName))) throw new Error("migration name must be an exact non-replayable timestamped stem");
  const reviewedCommit = String(git(["rev-parse", "HEAD"])).trim();
  const relativePath = `supabase/migrations/${migrationName}.sql`;
  const entry = String(git(["ls-tree", reviewedCommit, "--", relativePath])).trim().split(/\s+/);
  if (entry[0] !== "100644" || entry[1] !== "blob") throw new Error("reviewed migration must be a committed regular 100644 Git blob");
  const bytes = git(["cat-file", "blob", `${reviewedCommit}:${relativePath}`], null);
  const query = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n/g, "\n");
  const querySha256 = createHash("sha256").update(query).digest("hex");
  return { reviewedCommit, querySha256 };
}

export function buildEvidence({ migrationName, reviewedCommit, querySha256, rlsCapture, driftCapture, generatedAt }) {
  return {
    schemaVersion: 1,
    migrationName,
    reviewedCommit,
    querySha256,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    generatedAt,
    reviews: [
      extractCapturedReview(rlsCapture, REVIEWERS[0]),
      extractCapturedReview(driftCapture, REVIEWERS[1]),
    ],
  };
}

function readFreshNamedCaptures(migrationName) {
  const safe = migrationName.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
  const stateDir = path.join(process.cwd(), ".claude", "session-state");
  const captures = REVIEWERS.map((reviewer) => {
    const capturePath = path.join(stateDir, `codex-review-mig-${safe}-${reviewer}-capture.txt`);
    const modified = statSync(capturePath).mtimeMs;
    if (modified > Date.now() + 5_000 || Date.now() - modified > 30 * 60 * 1000) {
      throw new Error(`${reviewer} capture is outside the 30-minute packaging window`);
    }
    return { modified, text: readFileSync(capturePath, "utf8") };
  });
  return {
    rlsCapture: captures[0].text,
    driftCapture: captures[1].text,
    generatedAt: new Date(Math.max(...captures.map((capture) => capture.modified))).toISOString(),
  };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null || values.has(key)) throw new Error("arguments must be unique --key value pairs");
    values.set(key, value);
  }
  const expected = ["--migration", "--output", "--base64-output"];
  if ([...values.keys()].some((key) => !expected.includes(key)) || expected.some((key) => !values.get(key))) {
    throw new Error("required arguments: --migration --output --base64-output");
  }
  return values;
}

function main() {
  const values = parseArgs(process.argv.slice(2));
  const migrationName = values.get("--migration");
  const identityBefore = committedMigrationIdentity(migrationName);
  const captures = readFreshNamedCaptures(migrationName);
  const evidence = buildEvidence({
    migrationName,
    ...identityBefore,
    ...captures,
  });
  const identityAfter = committedMigrationIdentity(migrationName);
  if (JSON.stringify(identityAfter) !== JSON.stringify(identityBefore)) throw new Error("HEAD or migration blob changed while evidence was packaged");
  const bytes = Buffer.from(JSON.stringify(evidence));
  writeFileSync(path.resolve(values.get("--output")), bytes, { flag: "wx" });
  writeFileSync(path.resolve(values.get("--base64-output")), bytes.toString("base64"), { encoding: "ascii", flag: "wx" });
  process.stdout.write(JSON.stringify({
    reviewedCommit: identityBefore.reviewedCommit,
    querySha256: identityBefore.querySha256,
    evidenceSha256: createHash("sha256").update(bytes).digest("hex"),
  }) + "\n");
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  try { main(); }
  catch (error) { process.stderr.write(`${error?.message || error}\n`); process.exitCode = 1; }
}
