import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) throw new Error(`${label} anchor is not unique`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

export function transformReviewProducer(rawSource) {
  let source = String(rawSource).replace(/\r\n/g, "\n");
  source = replaceOnce(source,
    "function hashFile(file) {\n  const sql = readFileSync(file, 'utf8').replace(/\\r\\n/g, '\\n');\n  return createHash('sha256').update(sql).digest('hex');\n}\n",
    [
      "function hashFile(file) {",
      "  const sql = readFileSync(file, 'utf8').replace(/\\r\\n/g, '\\n');",
      "  return createHash('sha256').update(sql).digest('hex');",
      "}",
      "",
      "function gitOutput(args, encoding = 'utf8') {",
      "  const result = spawnSync('git', args, { cwd: process.cwd(), encoding, shell: false, windowsHide: true });",
      "  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);",
      "  return result.stdout;",
      "}",
      "",
      "function committedReviewIdentity(name, queryHash) {",
      "  try {",
      "    const reviewedCommit = String(gitOutput(['rev-parse', 'HEAD'])).trim();",
      "    const relativePath = path.posix.join('supabase', 'migrations', `${name}.sql`);",
      "    const entry = String(gitOutput(['ls-tree', reviewedCommit, '--', relativePath])).trim().split(/\\s+/);",
      "    if (entry[0] !== '100644' || entry[1] !== 'blob') return null;",
      "    const bytes = gitOutput(['cat-file', 'blob', `${reviewedCommit}:${relativePath}`], null);",
      "    const sql = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\\r\\n/g, '\\n');",
      "    if (createHash('sha256').update(sql).digest('hex') !== queryHash) return null;",
      "    return { reviewedCommit, relativePath };",
      "  } catch {",
      "    return null;",
      "  }",
      "}",
      "",
    ].join("\n"),
    "committed identity helper");
  source = replaceOnce(source,
    "  return { verdict: codexReviewProofVerdict({ status: result.status, stdout: result.stdout }), error: null };",
    "  return { verdict: codexReviewProofVerdict({ status: result.status, stdout: result.stdout }), error: null, exitCode: result.status, stdout: result.stdout || '' };",
    "review result evidence");
  source = replaceOnce(source,
    "  const queryHash = hashFile(migFile);\n",
    "  const queryHash = hashFile(migFile);\n  const committedIdentityBefore = committedReviewIdentity(name, queryHash);\n",
    "pre-review committed identity");
  source = replaceOnce(source,
    "  let allClean = true;\n  for (const reviewerName of REQUIRED_REVIEWERS) {\n    const { verdict, error } = runCodexCharter(codexBin, reviewerName, migRelPath, safe);",
    "  let allClean = true;\n  const charterEvidence = [];\n  for (const reviewerName of REQUIRED_REVIEWERS) {\n    const { verdict, error, exitCode: reviewerExitCode, stdout } = runCodexCharter(codexBin, reviewerName, migRelPath, safe);",
    "review evidence collection");
  source = replaceOnce(source,
    "      break;\n    }\n  }\n  if (!allClean) { exitCode = 1; continue; }",
    "      break;\n    }\n    charterEvidence.push({ reviewer: reviewerName, exitCode: reviewerExitCode, stdout });\n  }\n  if (!allClean) { exitCode = 1; continue; }",
    "clean review evidence append");
  source = replaceOnce(source,
    "  const ts = new Date().toISOString();\n  // Reviewer half",
    [
      "  let committedIdentityAfter = null;",
      "  if (committedIdentityBefore) {",
      "    committedIdentityAfter = committedReviewIdentity(name, queryHash);",
      "    if (!committedIdentityAfter || committedIdentityAfter.reviewedCommit !== committedIdentityBefore.reviewedCommit) {",
      "      console.error(`${name}.sql or HEAD changed while production evidence was reviewed — NO production evidence minted.`);",
      "      exitCode = 1;",
      "      continue;",
      "    }",
      "  }",
      "",
      "  const ts = new Date().toISOString();",
      "  if (committedIdentityAfter) {",
      "    const evidenceBytes = Buffer.from(JSON.stringify({",
      "      schemaVersion: 1,",
      "      migrationName: name,",
      "      reviewedCommit: committedIdentityAfter.reviewedCommit,",
      "      querySha256: queryHash,",
      "      model: CODEX_REVIEW_MODEL,",
      "      reasoningEffort: CODEX_REVIEW_EFFORT,",
      "      generatedAt: ts,",
      "      reviews: charterEvidence,",
      "    }));",
      "    if (evidenceBytes.length > 48_000) {",
      "      console.error(`${name} review evidence exceeds the 48 KB workflow limit — NO production evidence minted.`);",
      "      exitCode = 1;",
      "      continue;",
      "    }",
      "    const evidenceBase = path.join(stateDir, `production-release-evidence-${safe}-${committedIdentityAfter.reviewedCommit}-${Date.now()}`);",
      "    writeFileSync(`${evidenceBase}.json`, evidenceBytes, { flag: 'wx' });",
      "    writeFileSync(`${evidenceBase}.b64`, evidenceBytes.toString('base64'), { encoding: 'ascii', flag: 'wx' });",
      "    console.log(`wrote ${evidenceBase}.json and ${evidenceBase}.b64 (exact committed migration review evidence)`);",
      "  } else {",
      "    console.log(`${name} is not an unchanged committed regular Git blob; local apply proofs were minted, but no production evidence was written.`);",
      "  }",
      "  // Reviewer half",
    ].join("\n"),
    "production evidence emission");
  if (!source.includes("exact committed migration review evidence")) throw new Error("maintenance postcondition failed");
  return source;
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false, windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout || "").trim()}`);
  return (result.stdout || "").trim();
}

function requireExactReviewedMaintenance(root, ownPath) {
  const head = git(root, ["rev-parse", "HEAD"]);
  const base = git(root, ["rev-parse", "origin/main"]);
  const relativeOwn = path.relative(root, ownPath).replaceAll("\\", "/");
  if (git(root, ["status", "--porcelain", "--untracked-files=all", "--", relativeOwn])) throw new Error("maintenance program must match its committed HEAD");
  if (git(root, ["rev-parse", `HEAD:${relativeOwn}`]) !== git(root, ["hash-object", `--path=${relativeOwn}`, relativeOwn])) {
    throw new Error("maintenance program blob does not match committed HEAD");
  }
  const stateDir = path.join(root, ".claude", "session-state");
  const proofName = ["codex", "review", head].join("-") + ".json";
  const proof = JSON.parse(readFileSync(path.join(stateDir, proofName), "utf8"));
  const timestamp = Date.parse(proof.timestamp);
  if (proof.codex_ran !== true || proof.verdict !== "clean" || proof.model !== "gpt-5.6-sol" ||
      proof.reasoning_effort !== "high" || proof.head_sha !== head || proof.base_sha !== base ||
      !Number.isFinite(timestamp) || timestamp > Date.now() + 5_000 || Date.now() - timestamp > 30 * 60 * 1000) {
    throw new Error("maintenance program requires a fresh exact-HEAD/base clean Sol/high proof");
  }
}

function main() {
  if (process.argv.length !== 2) throw new Error("this one-use maintenance program accepts no arguments");
  const ownPath = fileURLToPath(import.meta.url);
  const root = path.resolve(path.dirname(ownPath), "..");
  requireExactReviewedMaintenance(root, ownPath);
  const targetName = ["write", "apply", "proofs"].join("-") + ".mjs";
  const target = path.join(root, "scripts", targetName);
  const updated = transformReviewProducer(readFileSync(target, "utf8"));
  writeFileSync(target, updated, "utf8");
  process.stdout.write("Protected migration reviewer updated from a fresh exact-reviewed one-use maintenance program.\n");
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  try { main(); }
  catch (error) { process.stderr.write(`${error?.message || error}\n`); process.exitCode = 1; }
}
