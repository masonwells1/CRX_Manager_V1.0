#!/usr/bin/env node
// Mint and validate the local, ignored attestation used for one narrow class of
// adversarial push-proof review: recovering a migration file that an operator
// has independently confirmed already exists in the live Supabase ledger.
//
// The ledger evidence (row name, apply-stamp version, and a SHA-256 digest of
// the row's applied statements) is captured ONLY by this helper's own
// --capture-evidence mode: a fixed read-only query against the pinned
// production project, built entirely from the live response. Caller-supplied
// rows are never accepted through any channel, so an actor cannot fabricate
// evidence for SQL that was never applied. Minting then refuses unless each
// candidate file's bytes hash-match that live row byte-for-byte, and the
// attestation binds the assertion to the exact candidate commit, base commit,
// migration paths, candidate bytes, and the evidence file's own digest.

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

export const RECOVERY_ATTESTATION_SCHEMA_VERSION = 2;
export const RECOVERY_ATTESTATION_KIND = "live-ledger-migration-recovery";
export const RECOVERY_ATTESTATION_TTL_MS = 30 * 60 * 1000;
export const RECOVERY_ATTESTATION_MAX_FILES = 64;
export const RECOVERY_ATTESTATION_FILENAME = "recovery-attestation.json";
export const RECOVERY_LEDGER_EVIDENCE_SCHEMA_VERSION = 1;
export const RECOVERY_LEDGER_EVIDENCE_KIND = "live-ledger-evidence";
export const RECOVERY_LEDGER_EVIDENCE_FILENAME = "recovery-ledger-evidence.json";
// Pinned to the one production project this exception can ever describe. The
// project id is already public in AGENTS.md; pinning it here refuses evidence
// captured from any other database.
export const RECOVERY_LEDGER_EVIDENCE_PROJECT_ID = "rhyzpcqhnizqbxphqdkr";
export const RECOVERY_LEDGER_EVIDENCE_MAX_ROWS = 512;
// Fixed management-API endpoint for the pinned project. The host is a constant
// and the project ref is pinned above, so a token for any other project (or a
// redirected host) cannot produce acceptable evidence.
export const RECOVERY_LEDGER_QUERY_URL =
  `https://api.supabase.com/v1/projects/${RECOVERY_LEDGER_EVIDENCE_PROJECT_ID}/database/query`;
// Hard deadline for the live ledger query. The push-proof wrapper awaits this
// query before its own Codex timeout starts, so an unbounded request could
// stall the whole proof workflow; a stalled query aborts and fails closed.
export const RECOVERY_LEDGER_QUERY_TIMEOUT_MS = 30_000;

const GUARDED_BASE = "origin/main";
const SHA_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const LEDGER_VERSION_RE = /^[0-9]{14}$/;
const LEDGER_NAME_RE = /^[0-9]{14}_[a-z0-9_]+$/;
const MIGRATION_PATH_RE = /^supabase\/migrations\/[0-9]{14}_[a-z0-9_]+\.sql$/;
const TOP_LEVEL_KEYS = [
  "base_sha",
  "expires_at",
  "head_sha",
  "issued_at",
  "kind",
  "ledger_evidence_sha256",
  "recoveries",
  "schema_version",
];
const RECOVERY_KEYS = ["ledger_name", "ledger_version", "path", "sha256"];
const EVIDENCE_TOP_KEYS = ["fetched_at", "kind", "project_id", "rows", "schema_version"];
const EVIDENCE_ROW_KEYS = ["name", "statements_sha256", "version"];

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

export function recoveryLedgerEvidencePath(root) {
  return path.join(root, ".claude", "session-state", RECOVERY_LEDGER_EVIDENCE_FILENAME);
}

export function buildRecoveryAttestation({
  headSha,
  baseSha,
  recoveries,
  ledgerEvidenceSha256,
  issuedAt = new Date().toISOString(),
} = {}) {
  const issuedMs = canonicalIso(issuedAt, "issued_at");
  return {
    schema_version: RECOVERY_ATTESTATION_SCHEMA_VERSION,
    kind: RECOVERY_ATTESTATION_KIND,
    head_sha: headSha,
    base_sha: baseSha,
    ledger_evidence_sha256: ledgerEvidenceSha256,
    issued_at: issuedAt,
    expires_at: new Date(issuedMs + RECOVERY_ATTESTATION_TTL_MS).toISOString(),
    recoveries,
  };
}

// Reads and shape-validates the operator-captured live ledger evidence file.
// Returns the file's own digest (so the attestation can pin the exact evidence
// bytes) plus a by-name row index for the content checks.
export function readRecoveryLedgerEvidence(evidencePath) {
  const label = "Live ledger evidence";
  const stat = lstatSync(evidencePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file, not a link.`);
  if (stat.size > 256 * 1024) throw new Error(`${label} is unexpectedly large.`);
  const bytes = readFileSync(evidencePath);
  const text = bytes.toString("utf8");
  if (text.charCodeAt(0) === 0xFEFF) throw new Error(`${label} must be UTF-8 without a BOM.`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  assertExactKeys(data, EVIDENCE_TOP_KEYS, label);
  if (data.schema_version !== RECOVERY_LEDGER_EVIDENCE_SCHEMA_VERSION
      || data.kind !== RECOVERY_LEDGER_EVIDENCE_KIND) {
    throw new Error(`${label} has an unsupported schema or kind.`);
  }
  if (data.project_id !== RECOVERY_LEDGER_EVIDENCE_PROJECT_ID) {
    throw new Error(`${label} was not captured from the pinned production project.`);
  }
  const fetchedMs = canonicalIso(data.fetched_at, `${label} fetched_at`);
  if (!Array.isArray(data.rows)
      || data.rows.length === 0
      || data.rows.length > RECOVERY_LEDGER_EVIDENCE_MAX_ROWS) {
    throw new Error(`${label} must contain a bounded, non-empty rows array.`);
  }
  const rowsByName = new Map();
  const seenVersions = new Set();
  for (const [index, row] of data.rows.entries()) {
    assertExactKeys(row, EVIDENCE_ROW_KEYS, `${label} row ${index + 1}`);
    if (!LEDGER_VERSION_RE.test(String(row.version || ""))) {
      throw new Error(`${label} row ${index + 1} version must be exactly 14 digits.`);
    }
    if (!LEDGER_NAME_RE.test(String(row.name || ""))) {
      throw new Error(`${label} row ${index + 1} name must be a timestamped migration slug.`);
    }
    if (!SHA256_RE.test(String(row.statements_sha256 || ""))) {
      throw new Error(`${label} row ${index + 1} statements digest is malformed.`);
    }
    if (rowsByName.has(row.name)) throw new Error(`${label} repeats ledger name ${row.name}.`);
    if (seenVersions.has(row.version)) throw new Error(`${label} repeats ledger version ${row.version}.`);
    rowsByName.set(row.name, row);
    seenVersions.add(row.version);
  }
  return { sha256: sha256Bytes(bytes), fetchedMs, rowsByName };
}

// Matches one candidate recovery against the live ledger evidence: the row is
// found by the file's own slug, must carry the operator-supplied apply-stamp
// version, and the candidate bytes must hash-match the row's applied statements
// byte-for-byte. A redacted or otherwise altered recovery can never attest.
function bindRecoveryToLedgerEvidence({ recovery, ledgerVersion, evidence }) {
  const ledgerName = path.posix.basename(recovery.path, ".sql");
  const row = evidence.rowsByName.get(ledgerName);
  if (!row) {
    throw new Error(`Live ledger evidence has no row named ${ledgerName}; cannot attest ${recovery.path}.`);
  }
  if (row.version !== String(ledgerVersion)) {
    throw new Error(
      `Live ledger evidence binds ${ledgerName} to version ${row.version}, ` +
      `not the supplied ${ledgerVersion}.`,
    );
  }
  if (row.statements_sha256 !== recovery.sha256) {
    throw new Error(
      `Candidate bytes for ${recovery.path} do not match the live ledger row's ` +
      `applied statements digest; only a byte-verbatim recovery can attest.`,
    );
  }
  return { ...recovery, ledger_name: ledgerName };
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

  const evidencePath = recoveryLedgerEvidencePath(repoRoot);
  if (!existsSync(evidencePath)) {
    throw new Error(
      `Live ledger evidence is required first: write ${RECOVERY_LEDGER_EVIDENCE_FILENAME} under ` +
      `.claude/session-state/ from a read-only live ledger query, then re-run.`,
    );
  }
  const evidence = readRecoveryLedgerEvidence(evidencePath);
  const issuedMs = canonicalIso(issuedAt, "issued_at");
  if (issuedMs < evidence.fetchedMs || issuedMs - evidence.fetchedMs > RECOVERY_ATTESTATION_TTL_MS) {
    throw new Error("Live ledger evidence is stale or from the future; re-run the read-only ledger query.");
  }

  const seenPaths = new Set();
  const seenLedgerVersions = new Set();
  const recoveries = specs.map(({ repoPath, ledgerVersion }) => {
    const candidate = candidateRecoveryFromGit({ root: repoRoot, baseSha, headSha, repoPath, ledgerVersion });
    const recovery = bindRecoveryToLedgerEvidence({ recovery: candidate, ledgerVersion, evidence });
    if (seenPaths.has(recovery.path)) throw new Error(`Duplicate recovery path: ${recovery.path}`);
    if (seenLedgerVersions.has(recovery.ledger_version)) {
      throw new Error(`Duplicate live ledger version: ${recovery.ledger_version}`);
    }
    seenPaths.add(recovery.path);
    seenLedgerVersions.add(recovery.ledger_version);
    return recovery;
  });

  const attestation = buildRecoveryAttestation({
    headSha,
    baseSha,
    recoveries,
    ledgerEvidenceSha256: evidence.sha256,
    issuedAt,
  });
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
  if (!SHA256_RE.test(String(data.ledger_evidence_sha256 || ""))) {
    throw new Error(`${label} ledger evidence digest is malformed.`);
  }

  // The wrapper cannot query the live database, so it independently re-reads
  // the SAME evidence file the mint bound and refuses if a single byte moved.
  const evidencePath = recoveryLedgerEvidencePath(root);
  if (!existsSync(evidencePath)) {
    throw new Error(`${label} is present but its live ledger evidence file is missing.`);
  }
  const evidence = readRecoveryLedgerEvidence(evidencePath);
  if (evidence.sha256 !== data.ledger_evidence_sha256) {
    throw new Error(`${label} ledger evidence digest does not match the evidence file on disk.`);
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
    if (recovery.ledger_name !== path.posix.basename(repoPath, ".sql")) {
      throw new Error(`${label} ledger name does not match the recovery file's own slug: ${repoPath}`);
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

    const row = evidence.rowsByName.get(recovery.ledger_name);
    if (!row) {
      throw new Error(`${label} names ${recovery.ledger_name} but the ledger evidence has no such row.`);
    }
    if (row.version !== recovery.ledger_version) {
      throw new Error(`${label} ledger version does not match the evidence row for ${recovery.ledger_name}.`);
    }
    if (row.statements_sha256 !== recovery.sha256) {
      throw new Error(
        `${label} candidate bytes do not match the live ledger row's applied statements digest: ${repoPath}`,
      );
    }
    return {
      path: repoPath,
      ledger_name: recovery.ledger_name,
      ledger_version: recovery.ledger_version,
      sha256: recovery.sha256,
    };
  });
}

// Internal validating writer for the ledger-evidence file. Module-private:
// only the trusted capture path below reaches it, and the local evidence file
// is a freshness/binding record only — final trust comes from the push-proof
// wrapper's own live re-query (verifyRecoveriesAgainstLiveLedger), so even a
// fabricated local file cannot survive validation. The evidence is fully
// re-validated (shape, kind, pinned project, row grammar) before it is kept;
// an invalid payload leaves no file.
function writeRecoveryLedgerEvidenceFile({ root, text }) {
  const evidencePath = recoveryLedgerEvidencePath(root);
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, text);
  try {
    const evidence = readRecoveryLedgerEvidence(evidencePath);
    return { path: evidencePath, sha256: evidence.sha256, rowCount: evidence.rowsByName.size };
  } catch (error) {
    try { unlinkSync(evidencePath); } catch { /* keep the original error */ }
    throw error;
  }
}

// Builds the one fixed read-only ledger query. Callers may only choose WHICH
// ledger rows to fetch, by slug name; every name is validated against the
// strict slug grammar before being embedded as a quoted literal, so no other
// SQL can be expressed through this channel.
export function buildLedgerEvidenceQuery(names) {
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error("--capture-evidence requires at least one --name <ledger-slug>.");
  }
  if (names.length > RECOVERY_LEDGER_EVIDENCE_MAX_ROWS) {
    throw new Error(`--capture-evidence accepts at most ${RECOVERY_LEDGER_EVIDENCE_MAX_ROWS} names.`);
  }
  const seen = new Set();
  for (const name of names) {
    if (typeof name !== "string" || !LEDGER_NAME_RE.test(name)) {
      throw new Error(`--name must be a timestamped migration slug such as 20260812123456_example: ${name}`);
    }
    if (seen.has(name)) throw new Error(`--name repeats ledger slug ${name}.`);
    seen.add(name);
  }
  return [
    "select version, name,",
    "  encode(sha256(convert_to(array_to_string(statements, E'\\n'), 'UTF8')), 'hex') as statements_sha256",
    "from supabase_migrations.schema_migrations",
    `where name in (${names.map((name) => `'${name}'`).join(", ")})`,
    "order by version",
  ].join("\n");
}

// Assembles the evidence document from the live API response. Rows are copied
// field-by-field (never trusted wholesale) and every requested name must be
// present, so a partial response cannot silently attest fewer files than asked.
export function buildLedgerEvidenceText({ names, rows, fetchedAt }) {
  if (!Array.isArray(rows)) throw new Error("Live ledger query returned an unexpected response shape.");
  const returnedNames = new Set(rows.map((row) => String(row?.name ?? "")));
  const missing = names.filter((name) => !returnedNames.has(name));
  if (missing.length > 0) {
    throw new Error(`The live ledger has no row named: ${missing.join(", ")}.`);
  }
  const evidence = {
    schema_version: RECOVERY_LEDGER_EVIDENCE_SCHEMA_VERSION,
    kind: RECOVERY_LEDGER_EVIDENCE_KIND,
    project_id: RECOVERY_LEDGER_EVIDENCE_PROJECT_ID,
    fetched_at: fetchedAt,
    rows: rows.map((row) => ({
      version: String(row?.version ?? ""),
      name: String(row?.name ?? ""),
      statements_sha256: String(row?.statements_sha256 ?? ""),
    })),
  };
  return `${JSON.stringify(evidence, null, 2)}\n`;
}

// The trusted transport relies on this process's own globalThis.fetch, which a
// Node preload module (--require/--import/--loader, directly or via
// NODE_OPTIONS) could replace before this module ever loads. A preloaded fake
// fetch could answer the live re-query with candidate-derived rows, so any
// preload option present at query time refuses the query outright.
const NODE_PRELOAD_OPTION_RE =
  /(^|\s)(--require(=|\s|$)|-r(\s|$)|--import(=|\s|$)|--loader(=|\s|$)|--experimental-loader(=|\s|$))/;

export function assertNoModulePreload({ execArgv = process.execArgv, env = process.env } = {}) {
  const joinedExecArgv = (execArgv || []).join(" ");
  for (const [label, value] of [["Node exec arguments", joinedExecArgv], ["NODE_OPTIONS", env?.NODE_OPTIONS || ""]]) {
    if (NODE_PRELOAD_OPTION_RE.test(String(value))) {
      throw new Error(
        `Live ledger queries refuse to run with Node module preloads (${label}: ${String(value).trim()}); ` +
        `re-run without --require/--import/--loader and with NODE_OPTIONS unset.`,
      );
    }
  }
}

// The one trusted transport to the live ledger. Deliberately accepts NO
// injectable fetch implementation, token, or clock: it always uses this
// process's own globalThis.fetch and SUPABASE_ACCESS_TOKEN, so a local script
// cannot hand it a fake transport, and it refuses to run at all in a process
// launched with module preloads that could have replaced that global fetch.
async function fetchLedgerRows(names) {
  assertNoModulePreload();
  if (!process.env.SUPABASE_ACCESS_TOKEN) {
    throw new Error("SUPABASE_ACCESS_TOKEN is required to query the live ledger.");
  }
  const query = buildLedgerEvidenceQuery(names);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), RECOVERY_LEDGER_QUERY_TIMEOUT_MS);
  let response;
  try {
    response = await globalThis.fetch(RECOVERY_LEDGER_QUERY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Live ledger query timed out after ${RECOVERY_LEDGER_QUERY_TIMEOUT_MS / 1000}s.`);
    }
    throw error;
  } finally {
    clearTimeout(deadline);
  }
  if (!response.ok) {
    throw new Error(`Live ledger query failed: HTTP ${response.status}.`);
  }
  const parsed = await response.json();
  const rows = Array.isArray(parsed) ? parsed : parsed?.result ?? parsed?.rows;
  if (!Array.isArray(rows)) throw new Error("Live ledger query returned an unexpected response shape.");
  return rows;
}

// The trusted capture channel: this process performs the fixed read-only
// production query itself and builds the evidence exclusively from the live
// response, so it cannot be invoked with caller-fabricated rows.
export async function captureRecoveryLedgerEvidence({ root = process.cwd(), names } = {}) {
  const rows = await fetchLedgerRows(names);
  const text = buildLedgerEvidenceText({ names, rows, fetchedAt: new Date().toISOString() });
  return writeRecoveryLedgerEvidenceFile({ root, text });
}

// Pure comparison used by the validation-time live re-check: every attested
// recovery must have a live row whose name, version, and statements digest all
// match exactly. Fails closed on any missing row or mismatch.
export function assertRecoveriesMatchLiveRows(recoveries, rows) {
  if (!Array.isArray(rows)) throw new Error("Live ledger query returned an unexpected response shape.");
  const rowsByName = new Map(rows.map((row) => [String(row?.name ?? ""), row]));
  for (const recovery of recoveries) {
    const row = rowsByName.get(recovery.ledger_name);
    if (!row) {
      throw new Error(`The live ledger has no row named: ${recovery.ledger_name}.`);
    }
    if (String(row?.version ?? "") !== recovery.ledger_version) {
      throw new Error(
        `Live ledger row ${recovery.ledger_name} has version ${String(row?.version ?? "")}, ` +
        `not the attested ${recovery.ledger_version}.`,
      );
    }
    if (String(row?.statements_sha256 ?? "") !== recovery.sha256) {
      throw new Error(
        `Live ledger row ${recovery.ledger_name} does not match the attested recovery digest; ` +
        `the recovered file is not byte-verbatim with the live ledger.`,
      );
    }
  }
}

// Validation-time independent live re-check (Sol adversarial finding, round 2):
// the local evidence file is only a freshness/binding record, never the trust
// root. Before a recovery attestation can excuse anything, the push-proof
// wrapper calls this to re-query the pinned live ledger itself — through the
// non-injectable transport above — and refuses unless every attested recovery
// matches the live rows. A locally forged evidence file therefore cannot
// bypass the gate: the forged digests will not exist in the real ledger.
export async function verifyRecoveriesAgainstLiveLedger(recoveries) {
  if (!Array.isArray(recoveries) || recoveries.length === 0) return;
  const rows = await fetchLedgerRows([...new Set(recoveries.map((recovery) => recovery.ledger_name))]);
  assertRecoveriesMatchLiveRows(recoveries, rows);
}

// Wrapper-owned discard path for a stale or superseded attestation. Both
// guards deliberately deny direct tool deletion of the two session-state JSON
// files, and validation is unconditional whenever the attestation exists — so
// without this mode, one expired attestation would block every later ordinary
// proof. Clearing only removes local, ignored records; it can never mint.
export function clearRecoveryAttestation({ root = process.cwd() } = {}) {
  const repoRoot = String(gitOutput(["rev-parse", "--show-toplevel"], { cwd: root })).trim();
  const removed = [];
  for (const filePath of [recoveryAttestationPath(repoRoot), recoveryLedgerEvidencePath(repoRoot)]) {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      removed.push(filePath);
    }
  }
  return removed;
}

export function parseRecoveryArgs(argv) {
  const parsed = { help: false, captureEvidence: false, clearAttestation: false, names: [], specs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--capture-evidence") {
      parsed.captureEvidence = true;
    } else if (arg === "--clear-attestation") {
      parsed.clearAttestation = true;
    } else if (arg === "--name") {
      const value = argv[++index];
      if (!value) throw new Error("--name requires a ledger slug value.");
      parsed.names.push(value);
    } else if (arg === "--migration") {
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
    "       node scripts/write-recovery-attestation.mjs --capture-evidence --name <ledger-slug> [--name ...]",
    "       node scripts/write-recovery-attestation.mjs --clear-attestation",
    "",
    "--clear-attestation removes the local attestation and ledger-evidence files (the supported way",
    "to discard a stale or superseded attestation so later ordinary proofs are not blocked).",
    "",
    "Capture live ledger evidence first with --capture-evidence: this helper itself runs the one",
    "fixed read-only ledger query against the pinned production project (management API; requires",
    "SUPABASE_ACCESS_TOKEN) and builds the evidence entirely from the live response — callers may",
    "only choose which rows to fetch, never supply row contents. The result is written to",
    `.claude/session-state/${RECOVERY_LEDGER_EVIDENCE_FILENAME} (kind "${RECOVERY_LEDGER_EVIDENCE_KIND}";`,
    "rows of {version, name, statements_sha256} where the digest is",
    "encode(sha256(convert_to(array_to_string(statements, E'\\n'), 'UTF8')), 'hex')); both JSON",
    "files are guard-protected against direct tool writes.",
    "Minting requires a clean committed candidate, verifies every path is new versus origin/main,",
    "requires each candidate's bytes to hash-match its live ledger row byte-for-byte, and writes an",
    "ignored attestation bound to HEAD, origin/main, and the evidence digest for 30 minutes.",
  ].join("\n");
}

export async function run(argv = process.argv.slice(2)) {
  try {
    const options = parseRecoveryArgs(argv);
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (options.clearAttestation) {
      if (options.captureEvidence || options.specs.length || options.names.length) {
        throw new Error("--clear-attestation cannot be combined with other options.");
      }
      const removed = clearRecoveryAttestation({ root: process.cwd() });
      process.stdout.write(
        removed.length
          ? `Recovery attestation cleared: removed ${removed.join(", ")}.\n`
          : "Recovery attestation cleared: nothing to remove.\n",
      );
      return 0;
    }
    if (options.captureEvidence) {
      if (options.specs.length) {
        throw new Error("--capture-evidence cannot be combined with --migration; capture evidence first, then mint.");
      }
      const result = await captureRecoveryLedgerEvidence({
        root: process.cwd(),
        names: options.names,
      });
      process.stdout.write(
        `Ledger evidence captured from the live ledger to ${result.path} ` +
        `(${result.rowCount} row(s), sha256 ${result.sha256}).\n`,
      );
      return 0;
    }
    if (options.names.length) {
      throw new Error("--name is only valid with --capture-evidence.");
    }
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

if (isMainModule()) run().then((code) => process.exit(code));
