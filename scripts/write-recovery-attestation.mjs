#!/usr/bin/env node
// Mint and validate the local, ignored attestation used for one narrow class of
// adversarial push-proof review: recovering a migration file that an operator
// has independently confirmed already exists in the live Supabase ledger.
//
// This helper NEVER queries Supabase. The operator supplies the ledger version
// after a separate live read-only check. The helper only binds that assertion to
// the exact candidate commit, base commit, migration paths, and candidate bytes.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const RECOVERY_ATTESTATION_SCHEMA_VERSION = 1;
export const RECOVERY_ATTESTATION_KIND = "live-ledger-migration-recovery";
export const RECOVERY_ATTESTATION_TTL_MS = 30 * 60 * 1000;
export const RECOVERY_ATTESTATION_MAX_FILES = 64;
export const RECOVERY_ATTESTATION_FILENAME = "recovery-attestation.json";

const GUARDED_BASE = "origin/main";
const SHA_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const LEDGER_VERSION_RE = /^[0-9]{14}$/;
const MIGRATION_PATH_RE = /^supabase\/migrations\/[0-9]{14}_[a-z0-9_]+\.sql$/;
const TOP_LEVEL_KEYS = [
  "base_sha",
  "expires_at",
  "head_sha",
  "issued_at",
  "kind",
  "recoveries",
  "schema_version",
];
const RECOVERY_KEYS = ["ledger_version", "path", "sha256"];

function fixedGitExecutable(platform = process.platform) {
  const candidates = platform === "win32"
    ? ["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\bin\\git.exe"]
    : ["/usr/bin/git", "/usr/local/bin/git"];
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error("A fixed trusted Git executable is required to mint a recovery attestation.");
  return executable;
}

function gitOutput(args, { cwd, encoding = "utf8", allowFailure = false } = {}) {
  try {
    return execFileSync(fixedGitExecutable(), args, {
      cwd,
      encoding,
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (allowFailure) return encoding === null ? Buffer.alloc(0) : "";
    const detail = String(error?.stderr || error?.message || "unknown Git failure").trim();
    throw new Error(`Trusted Git inspection failed: ${detail}`);
  }
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalIso(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO-8601 timestamp.`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO-8601 timestamp.`);
  }
  return parsed;
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} has missing or unexpected fields.`);
  }
}

export function normalizeRecoveryPath(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  if (!MIGRATION_PATH_RE.test(normalized) || path.posix.normalize(normalized) !== normalized) {
    throw new Error(
      `Recovery path must be a repo-relative timestamped migration such as ` +
      `supabase/migrations/20260812123456_example.sql: ${value}`,
    );
  }
  return normalized;
}

export function recoveryAttestationPath(root) {
  return path.join(root, ".claude", "session-state", RECOVERY_ATTESTATION_FILENAME);
}

export function buildRecoveryAttestation({
  headSha,
  baseSha,
  recoveries,
  issuedAt = new Date().toISOString(),
} = {}) {
  const issuedMs = canonicalIso(issuedAt, "issued_at");
  return {
    schema_version: RECOVERY_ATTESTATION_SCHEMA_VERSION,
    kind: RECOVERY_ATTESTATION_KIND,
    head_sha: headSha,
    base_sha: baseSha,
    issued_at: issuedAt,
    expires_at: new Date(issuedMs + RECOVERY_ATTESTATION_TTL_MS).toISOString(),
    recoveries,
  };
}

function commitTreeEntry({ root, commitSha, repoPath }) {
  const output = String(gitOutput([
    "ls-tree",
    "-z",
    "--full-tree",
    commitSha,
    "--",
    repoPath,
  ], { cwd: root }));
  const records = output.split("\0").filter(Boolean);
  if (records.length === 0) return null;
  if (records.length !== 1) throw new Error(`Git returned multiple entries for ${repoPath}.`);
  const match = /^([0-7]{6}) blob ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(records[0]);
  if (!match || match[3] !== repoPath) throw new Error(`Git returned a malformed entry for ${repoPath}.`);
  return { gitMode: match[1], objectId: match[2], path: match[3] };
}

function candidateRecoveryFromGit({ root, baseSha, headSha, repoPath, ledgerVersion }) {
  const normalizedPath = normalizeRecoveryPath(repoPath);
  if (!LEDGER_VERSION_RE.test(String(ledgerVersion || ""))) {
    throw new Error(`Ledger version must be exactly 14 digits for ${normalizedPath}.`);
  }
  if (commitTreeEntry({ root, commitSha: baseSha, repoPath: normalizedPath })) {
    throw new Error(`Recovery file modifies an existing base path instead of adding a new file: ${normalizedPath}`);
  }
  const candidate = commitTreeEntry({ root, commitSha: headSha, repoPath: normalizedPath });
  if (!candidate) throw new Error(`Recovery file is missing from candidate HEAD: ${normalizedPath}`);
  if (candidate.gitMode !== "100644") {
    throw new Error(`Recovery file must be a regular non-executable file in candidate HEAD: ${normalizedPath}`);
  }
  const bytes = gitOutput(["cat-file", "blob", candidate.objectId], { cwd: root, encoding: null });
  return {
    path: normalizedPath,
    ledger_version: String(ledgerVersion),
    sha256: sha256Bytes(bytes),
  };
}

export function mintRecoveryAttestation({
  root = process.cwd(),
  specs,
  issuedAt = new Date().toISOString(),
} = {}) {
  const repoRoot = String(gitOutput(["rev-parse", "--show-toplevel"], { cwd: root })).trim();
  const outputPath = recoveryAttestationPath(repoRoot);
  if (existsSync(outputPath)) unlinkSync(outputPath);

  const status = String(gitOutput(["status", "--short"], { cwd: repoRoot })).trim();
  if (status) throw new Error("Recovery attestation requires a clean worktree bound to a committed candidate HEAD.");

  const headSha = String(gitOutput(["rev-parse", "HEAD^{commit}"], { cwd: repoRoot })).trim();
  const baseSha = String(gitOutput(["rev-parse", `${GUARDED_BASE}^{commit}`], { cwd: repoRoot })).trim();
  if (!SHA_RE.test(headSha) || !SHA_RE.test(baseSha)) {
    throw new Error("Could not bind recovery attestation to exact candidate and origin/main commits.");
  }
  if (!Array.isArray(specs) || specs.length === 0 || specs.length > RECOVERY_ATTESTATION_MAX_FILES) {
    throw new Error(`Supply between 1 and ${RECOVERY_ATTESTATION_MAX_FILES} recovery files.`);
  }

  const seenPaths = new Set();
  const seenLedgerVersions = new Set();
  const recoveries = specs.map(({ repoPath, ledgerVersion }) => {
    const recovery = candidateRecoveryFromGit({ root: repoRoot, baseSha, headSha, repoPath, ledgerVersion });
    if (seenPaths.has(recovery.path)) throw new Error(`Duplicate recovery path: ${recovery.path}`);
    if (seenLedgerVersions.has(recovery.ledger_version)) {
      throw new Error(`Duplicate live ledger version: ${recovery.ledger_version}`);
    }
    seenPaths.add(recovery.path);
    seenLedgerVersions.add(recovery.ledger_version);
    return recovery;
  });

  const attestation = buildRecoveryAttestation({ headSha, baseSha, recoveries, issuedAt });
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(attestation, null, 2)}\n`, "utf8");
  return { path: outputPath, attestation };
}

function readJsonFile(filePath, label) {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file, not a link.`);
  if (stat.size > 64 * 1024) throw new Error(`${label} is unexpectedly large.`);
  const text = readFileSync(filePath, "utf8");
  if (text.charCodeAt(0) === 0xFEFF) throw new Error(`${label} must be UTF-8 without a BOM.`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function readPacketManifest(reviewRoot, filename) {
  const manifest = readJsonFile(path.join(reviewRoot, filename), filename);
  if (!Array.isArray(manifest.entries)) throw new Error(`${filename} is missing its entries array.`);
  return manifest;
}

export function validateRecoveryAttestation({
  root,
  reviewRoot,
  headSha,
  baseSha,
  nowMs = Date.now(),
} = {}) {
  const attestationPath = recoveryAttestationPath(root);
  if (!existsSync(attestationPath)) return [];

  const label = "Recovery attestation";
  const data = readJsonFile(attestationPath, label);
  assertExactKeys(data, TOP_LEVEL_KEYS, label);
  if (data.schema_version !== RECOVERY_ATTESTATION_SCHEMA_VERSION || data.kind !== RECOVERY_ATTESTATION_KIND) {
    throw new Error(`${label} has an unsupported schema or kind.`);
  }
  if (!SHA_RE.test(String(data.head_sha || "")) || data.head_sha !== headSha) {
    throw new Error(`${label} HEAD does not match the candidate HEAD.`);
  }
  if (!SHA_RE.test(String(data.base_sha || "")) || data.base_sha !== baseSha) {
    throw new Error(`${label} base does not match the guarded origin/main commit.`);
  }
  const issuedMs = canonicalIso(data.issued_at, "Recovery attestation issued_at");
  const expiresMs = canonicalIso(data.expires_at, "Recovery attestation expires_at");
  if (expiresMs - issuedMs !== RECOVERY_ATTESTATION_TTL_MS) {
    throw new Error(`${label} expiry must be exactly 30 minutes after issuance.`);
  }
  if (!Number.isFinite(nowMs) || nowMs < issuedMs || nowMs >= expiresMs) {
    throw new Error(`${label} is expired or not yet valid.`);
  }
  if (!Array.isArray(data.recoveries)
      || data.recoveries.length === 0
      || data.recoveries.length > RECOVERY_ATTESTATION_MAX_FILES) {
    throw new Error(`${label} must name a bounded, non-empty recovery list.`);
  }

  const baseManifest = readPacketManifest(reviewRoot, "BASE_TREE_MANIFEST.json");
  const candidateManifest = readPacketManifest(reviewRoot, "CANDIDATE_TREE_MANIFEST.json");
  const baseEntries = new Map(baseManifest.entries.map((entry) => [entry.path, entry]));
  const candidateEntries = new Map(candidateManifest.entries.map((entry) => [entry.path, entry]));
  const seenPaths = new Set();
  const seenLedgerVersions = new Set();

  return data.recoveries.map((recovery, index) => {
    assertExactKeys(recovery, RECOVERY_KEYS, `${label} recovery ${index + 1}`);
    const repoPath = normalizeRecoveryPath(recovery.path);
    if (!LEDGER_VERSION_RE.test(String(recovery.ledger_version || ""))) {
      throw new Error(`${label} ledger version must be exactly 14 digits for ${repoPath}.`);
    }
    if (!SHA256_RE.test(String(recovery.sha256 || ""))) {
      throw new Error(`${label} SHA-256 is malformed for ${repoPath}.`);
    }
    if (seenPaths.has(repoPath)) throw new Error(`${label} repeats recovery path ${repoPath}.`);
    if (seenLedgerVersions.has(recovery.ledger_version)) {
      throw new Error(`${label} repeats live ledger version ${recovery.ledger_version}.`);
    }
    seenPaths.add(repoPath);
    seenLedgerVersions.add(recovery.ledger_version);

    if (baseEntries.has(repoPath)) {
      throw new Error(`${label} lists a file that modifies an existing base path: ${repoPath}`);
    }
    const candidateEntry = candidateEntries.get(repoPath);
    if (!candidateEntry) throw new Error(`${label} lists a file missing from the candidate snapshot: ${repoPath}`);
    if (candidateEntry.gitMode !== "100644") {
      throw new Error(`${label} lists a candidate that is not a regular non-executable file: ${repoPath}`);
    }
    const candidatePath = path.join(reviewRoot, "CANDIDATE_SNAPSHOT", ...repoPath.split("/"));
    const candidateStat = lstatSync(candidatePath);
    if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) {
      throw new Error(`${label} candidate is not a regular snapshot file: ${repoPath}`);
    }
    const actualSha = sha256Bytes(readFileSync(candidatePath));
    if (actualSha !== recovery.sha256
        || candidateEntry.blobSha256 !== recovery.sha256
        || candidateEntry.snapshotSha256 !== recovery.sha256) {
      throw new Error(`${label} SHA-256 does not match the candidate snapshot: ${repoPath}`);
    }
    return {
      path: repoPath,
      ledger_version: recovery.ledger_version,
      sha256: recovery.sha256,
    };
  });
}

export function parseRecoveryArgs(argv) {
  const parsed = { help: false, specs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--migration") {
      const value = argv[++index];
      const separator = String(value || "").lastIndexOf("=");
      if (separator <= 0) throw new Error("--migration requires <repo-path>=<live-ledger-version>.");
      parsed.specs.push({
        repoPath: normalizeRecoveryPath(value.slice(0, separator)),
        ledgerVersion: value.slice(separator + 1),
      });
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function usage() {
  return [
    "Usage: node scripts/write-recovery-attestation.mjs --migration <repo-path>=<live-ledger-version> [--migration ...]",
    "",
    "Run only after an operator has verified each version in the live Supabase migration ledger",
    "through a read-only query. This helper never queries the database. It requires a clean",
    "committed candidate, verifies every path is new versus origin/main, computes each candidate",
    "SHA-256, and writes an ignored attestation bound to HEAD and origin/main for 30 minutes.",
  ].join("\n");
}

export function run(argv = process.argv.slice(2)) {
  const options = parseRecoveryArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  try {
    const result = mintRecoveryAttestation({ root: process.cwd(), specs: options.specs });
    process.stdout.write(
      `Recovery attestation written to ${result.path} for ${result.attestation.recoveries.length} ` +
      `ledger-verified migration file(s); expires ${result.attestation.expires_at}.\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(`Recovery attestation refused: ${error.message}\n`);
    return 1;
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isMainModule()) process.exit(run());
