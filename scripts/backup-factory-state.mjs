#!/usr/bin/env node

// Deterministic, read-only snapshot/restore verifier for the shared CRX Factory
// ledger. The encrypted Personal DR scheduled task calls --stage, places the
// resulting directory inside its archive, expands that archive locally, and
// calls --verify before uploading through the encrypted Backblaze remote.

import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildFactorySnapshot,
  resolveFactoryPaths,
} from "./factory-state-lib.mjs";

export const FACTORY_BACKUP_KIND = "crx-factory-state-snapshot";
export const FACTORY_BACKUP_VERSION = 1;
export const FACTORY_BACKUP_MANIFEST = "manifest.json";
const STATE_DIR = "state";
const MAX_CAPTURE_ATTEMPTS = 5;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const LEDGER_WARNING_BYTES = Math.floor(MAX_FILE_BYTES * 0.75);

export function factoryBackupExitCode(manifest) {
  if (!manifest?.replay_ok) return 4;
  const ledgerBytes = manifest.files?.find((entry) => entry.path === "events.jsonl")?.bytes || 0;
  return ledgerBytes >= LEDGER_WARNING_BYTES ? 5 : 0;
}

// Durable recovery material. Active command permits, intent latches, harness
// single-flight markers, and coordination locks are deliberately excluded: a
// restored machine must never revive authority held by a dead process/session.
const ROOT_FILES = new Set(["events.jsonl", "EMERGENCY-HOLD.json"]);
const ROOT_DIRS = new Set([
  "tickets",
  "evidence",
  "managed-sessions",
  "emergency-hold-generations",
  "recovery",
]);
const PERMIT_FILES = new Set(["owner-receipt.key"]);
const PERMIT_DIRS = new Set(["owner-receipts"]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePathOrInside(candidate, root) {
  const child = comparablePath(candidate);
  const parent = comparablePath(root);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function canonicalRelative(value) {
  const normalized = String(value || "").replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))) return null;
  return parts.join("/");
}

function inspectRegularFile(file, label) {
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1) {
    throw new Error(`${label} is not an unlinked regular file.`);
  }
  if (before.size > MAX_FILE_BYTES) throw new Error(`${label} exceeds the ${MAX_FILE_BYTES}-byte safety limit.`);
  const bytes = readFileSync(file);
  const after = lstatSync(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
    throw new Error(`${label} changed while it was being read.`);
  }
  return bytes;
}

function walkRegularFiles(root, prefix, entries) {
  if (!existsSync(root)) return;
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${prefix} is not a real directory.`);
  for (const item of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = canonicalRelative(`${prefix}/${item.name}`);
    if (!relative) throw new Error(`Unsafe factory-state path under ${prefix}.`);
    const absolute = path.join(root, item.name);
    const itemInfo = lstatSync(absolute);
    if (itemInfo.isSymbolicLink()) throw new Error(`${relative} is a symbolic link.`);
    if (itemInfo.isDirectory()) walkRegularFiles(absolute, relative, entries);
    else if (itemInfo.isFile()) entries.push({ relative, absolute });
    else throw new Error(`${relative} is not a regular file or directory.`);
  }
}

function allSnapshotFiles(root, prefix = "", entries = []) {
  if (!existsSync(root)) return entries;
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${prefix || "state"} is not a real directory.`);
  for (const item of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = canonicalRelative(prefix ? `${prefix}/${item.name}` : item.name);
    if (!relative) throw new Error(`Unsafe path in restored factory snapshot.`);
    const absolute = path.join(root, item.name);
    const itemInfo = lstatSync(absolute);
    if (itemInfo.isSymbolicLink()) throw new Error(`${relative} is a symbolic link.`);
    if (itemInfo.isDirectory()) allSnapshotFiles(absolute, relative, entries);
    else if (itemInfo.isFile()) entries.push(relative);
    else throw new Error(`${relative} is not a regular file or directory.`);
  }
  return entries;
}

export function durableFactoryFiles(stateDir) {
  const root = path.resolve(stateDir);
  const entries = [];
  for (const name of [...ROOT_FILES].sort()) {
    const absolute = path.join(root, name);
    if (existsSync(absolute)) entries.push({ relative: name, absolute });
  }
  for (const name of [...ROOT_DIRS].sort()) walkRegularFiles(path.join(root, name), name, entries);
  const permits = path.join(root, "permits");
  for (const name of [...PERMIT_FILES].sort()) {
    const absolute = path.join(permits, name);
    if (existsSync(absolute)) entries.push({ relative: `permits/${name}`, absolute });
  }
  for (const name of [...PERMIT_DIRS].sort()) {
    walkRegularFiles(path.join(permits, name), `permits/${name}`, entries);
  }
  return entries.sort((left, right) => left.relative.localeCompare(right.relative));
}

function captureFactoryState(stateDir) {
  const files = [];
  let totalBytes = 0;
  for (const item of durableFactoryFiles(stateDir)) {
    const bytes = inspectRegularFile(item.absolute, item.relative);
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Factory snapshot exceeds the ${MAX_TOTAL_BYTES}-byte safety limit.`);
    files.push({ path: item.relative, bytes: bytes.length, sha256: sha256(bytes), contents: bytes });
  }
  if (!files.some((item) => item.path === "events.jsonl")) {
    throw new Error("Factory events.jsonl is missing; refusing to publish an incomplete recovery snapshot.");
  }
  return files;
}

function captureIdentity(files) {
  return sha256(Buffer.from(JSON.stringify(files.map(({ path: filePath, bytes, sha256: digest }) => ({
    path: filePath,
    bytes,
    sha256: digest,
  })))));
}

export function captureStableFactoryState(stateDir) {
  let previous = captureFactoryState(stateDir);
  for (let attempt = 1; attempt <= MAX_CAPTURE_ATTEMPTS; attempt += 1) {
    const current = captureFactoryState(stateDir);
    if (captureIdentity(previous) === captureIdentity(current)) return current;
    previous = current;
  }
  throw new Error("Factory state kept changing during backup; no point-in-time snapshot was published.");
}

function assertUnusedDestination(destination) {
  if (existsSync(destination)) throw new Error("Backup destination must not already exist; refusing to overwrite or follow staged paths.");
}

function writeExclusive(file, bytes) {
  mkdirSync(path.dirname(file), { recursive: true });
  const fd = openSync(file, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}

function removeCreatedSnapshotTree(root) {
  if (!existsSync(root)) return;
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink()) return;
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, item.name);
    const itemInfo = lstatSync(target);
    if (itemInfo.isDirectory() && !itemInfo.isSymbolicLink()) removeCreatedSnapshotTree(target);
    else if (itemInfo.isFile() && !itemInfo.isSymbolicLink()) unlinkSync(target);
    else return; // fail closed: never follow/delete an entry an attacker replaced
  }
  if (readdirSync(root).length === 0) rmdirSync(root);
}

export function stageFactoryBackup(destination, source = null, { now = () => new Date() } = {}) {
  const target = path.resolve(destination);
  const paths = source
    ? { stateDir: path.resolve(source) }
    : resolveFactoryPaths(process.cwd(), process.env);
  const stateRoot = path.resolve(paths.stateDir);
  const stateInfo = lstatSync(stateRoot);
  if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink()) throw new Error("Live factory state is not a real directory.");
  if (!samePathOrInside(target, tmpdir())) {
    throw new Error(`Backup staging is allowed only under the operating-system temporary directory (${path.resolve(tmpdir())}).`);
  }
  if (samePathOrInside(target, stateRoot) || samePathOrInside(stateRoot, target)) {
    throw new Error("Backup destination and live factory state must not contain one another.");
  }
  assertUnusedDestination(target);
  const files = captureStableFactoryState(stateRoot);
  const capturedAt = now().toISOString();
  try {
    mkdirSync(path.join(target, STATE_DIR), { recursive: true });
    for (const item of files) writeExclusive(path.join(target, STATE_DIR, ...item.path.split("/")), item.contents);
    // Replay the frozen copy, never the live directory: another valid append may
    // occur after capture without changing the bytes this manifest describes.
    const replay = inspectFactoryReplay(path.join(target, STATE_DIR), capturedAt);
    const manifest = {
      kind: FACTORY_BACKUP_KIND,
      version: FACTORY_BACKUP_VERSION,
      captured_at: capturedAt,
      file_count: files.length,
      total_bytes: files.reduce((sum, item) => sum + item.bytes, 0),
      ledger_sha256: files.find((item) => item.path === "events.jsonl").sha256,
      replay_ok: replay.ok,
      replay_warning: replay.warning,
      ledger_warning_bytes: LEDGER_WARNING_BYTES,
      ledger_limit_bytes: MAX_FILE_BYTES,
      files: files.map(({ path: filePath, bytes, sha256: digest }) => ({ path: filePath, bytes, sha256: digest })),
    };
    writeExclusive(path.join(target, FACTORY_BACKUP_MANIFEST), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    const result = verifyFactoryBackup(target);
    if (!result.ok) throw new Error(result.problems.join("; "));
    return manifest;
  } catch (error) {
    try {
      removeCreatedSnapshotTree(target);
    } catch (cleanupError) {
      process.stderr.write(`FACTORY BACKUP CLEANUP FAILED: ${cleanupError?.message || cleanupError}\n`);
    }
    throw error;
  }
}

function manifestProblem(manifest) {
  if (manifest?.kind !== FACTORY_BACKUP_KIND || manifest?.version !== FACTORY_BACKUP_VERSION) return "Manifest kind/version is unsupported.";
  if (!Array.isArray(manifest.files) || manifest.files.length < 1) return "Manifest has no files.";
  if (typeof manifest.replay_ok !== "boolean" || typeof manifest.replay_warning !== "string") return "Manifest replay status is invalid.";
  if (manifest.replay_ok && manifest.replay_warning) return "Manifest marks a clean replay with a warning.";
  if (!manifest.replay_ok && !manifest.replay_warning) return "Manifest marks a degraded replay without a warning.";
  if (manifest.file_count !== manifest.files.length) return "Manifest file count is inconsistent.";
  const seen = new Set();
  for (const entry of manifest.files) {
    const safe = canonicalRelative(entry?.path);
    if (!safe || safe !== entry.path) return `Manifest contains an unsafe path: ${JSON.stringify(entry?.path)}.`;
    const key = safe.toLowerCase();
    if (seen.has(key)) return `Manifest repeats ${safe}.`;
    seen.add(key);
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(entry.sha256 || "")) {
      return `Manifest metadata is invalid for ${safe}.`;
    }
  }
  const ledger = manifest.files.find((entry) => entry.path === "events.jsonl");
  if (!ledger) return "Manifest does not include events.jsonl.";
  if (manifest.total_bytes !== manifest.files.reduce((sum, entry) => sum + entry.bytes, 0)) return "Manifest byte total is inconsistent.";
  if (manifest.ledger_sha256 !== ledger.sha256) return "Manifest ledger hash is inconsistent.";
  return null;
}

function snapshotRootInventoryMatches(root) {
  const entries = readdirSync(root, { withFileTypes: true })
    .map((entry) => `${entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other"}:${entry.name}`)
    .sort();
  return JSON.stringify(entries)
    === JSON.stringify([`dir:${STATE_DIR}`, `file:${FACTORY_BACKUP_MANIFEST}`].sort());
}

export function verifyFactoryBackup(destination) {
  const root = path.resolve(destination);
  const problems = [];
  let manifest;
  try {
    const manifestPath = path.join(root, FACTORY_BACKUP_MANIFEST);
    const manifestInfo = lstatSync(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.nlink > 1) {
      throw new Error("manifest.json is not an unlinked regular file");
    }
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return { ok: false, problems: [`Manifest cannot be read: ${error.message}`] };
  }
  const badManifest = manifestProblem(manifest);
  if (badManifest) return { ok: false, problems: [badManifest] };
  const stateRoot = path.join(root, STATE_DIR);
  try {
    if (!snapshotRootInventoryMatches(root)) {
      problems.push("Snapshot root must contain exactly manifest.json and state/.");
    }
  } catch (error) {
    problems.push(`Snapshot root cannot be inventoried: ${error.message}`);
  }
  let actual;
  try {
    actual = allSnapshotFiles(stateRoot).sort((left, right) => left.localeCompare(right));
  } catch (error) {
    return { ok: false, problems: [error.message] };
  }
  const expected = manifest.files.map((entry) => entry.path);
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort((a, b) => a.localeCompare(b)))) {
    problems.push("Snapshot file inventory differs from the manifest.");
  }
  for (const entry of manifest.files) {
    const file = path.join(stateRoot, ...entry.path.split("/"));
    try {
      const bytes = inspectRegularFile(file, entry.path);
      if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) problems.push(`Bytes differ for ${entry.path}.`);
    } catch (error) {
      problems.push(`${entry.path}: ${error.message}`);
    }
  }
  if (problems.length === 0) {
    const replay = inspectFactoryReplay(stateRoot, manifest.captured_at);
    if (replay.ok !== manifest.replay_ok) {
      problems.push(`Factory replay status differs from the manifest (manifest=${manifest.replay_ok}, actual=${replay.ok}).`);
    } else if (!replay.ok && replay.warning !== manifest.replay_warning) {
      problems.push("Factory replay warning differs from the manifest.");
    }
  }
  return { ok: problems.length === 0, replayOk: Boolean(manifest.replay_ok), problems, manifest };
}

export function cleanupFactoryBackupProofWorkspace(destination) {
  const target = path.resolve(destination);
  const name = path.basename(target);
  if (!samePathOrInside(target, tmpdir())
      || !/^(?:crx-factory-live-backup|crx-factory-offsite-proof)-[a-f0-9]+$/i.test(name)
      || comparablePath(target) === comparablePath(tmpdir())) {
    throw new Error("Cleanup is limited to a named CRX factory backup proof workspace under the operating-system temporary directory.");
  }
  removeCreatedSnapshotTree(target);
  if (existsSync(target)) throw new Error("Cleanup stopped because the proof workspace contained an unsafe or changing entry.");
}

export function cleanupFactoryStagedSnapshot(destination) {
  const target = path.resolve(destination);
  if (!samePathOrInside(target, tmpdir()) || comparablePath(target) === comparablePath(tmpdir())) {
    throw new Error("Snapshot cleanup is limited to a factory snapshot under the operating-system temporary directory.");
  }
  const manifestPath = path.join(target, FACTORY_BACKUP_MANIFEST);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error("Snapshot cleanup requires a readable factory backup manifest.");
  }
  if (manifest?.kind !== FACTORY_BACKUP_KIND || manifest?.version !== FACTORY_BACKUP_VERSION) {
    throw new Error("Snapshot cleanup requires a supported factory backup manifest.");
  }
  if (!snapshotRootInventoryMatches(target)) {
    throw new Error("Snapshot cleanup refused unexpected root entries.");
  }
  removeCreatedSnapshotTree(target);
  if (existsSync(target)) throw new Error("Snapshot cleanup stopped because an entry was unsafe or changed.");
}

function inspectFactoryReplay(stateRoot, capturedAt) {
  try {
    const replayPaths = resolveFactoryPaths(stateRoot, {
      CRX_FACTORY_TEST_MODE: "1",
      CRX_FACTORY_TEST_STATE_DIR: stateRoot,
    });
    const snapshot = buildFactorySnapshot(replayPaths, { nowMs: Date.parse(capturedAt) || Date.now() });
    if (snapshot.degraded || snapshot.warning) {
      return { ok: false, warning: snapshot.warning || "Factory ledger replay is degraded." };
    }
    return { ok: true, warning: "" };
  } catch (error) {
    return { ok: false, warning: `Factory ledger replay failed: ${error.message}` };
  }
}

function usage(message = "") {
  if (message) process.stderr.write(`USAGE ERROR: ${message}\n`);
  process.stderr.write(
    "Usage:\n"
    + "  node scripts/backup-factory-state.mjs --stage <empty-dir> [--source <factory-state-dir>]\n"
    + "  node scripts/backup-factory-state.mjs --verify <snapshot-dir>\n"
    + "  node scripts/backup-factory-state.mjs --cleanup-snapshot-temp <snapshot-dir>\n"
    + "  node scripts/backup-factory-state.mjs --cleanup-proof-temp <proof-workspace>\n",
  );
  return 2;
}

export function runFactoryBackupCli(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--stage", "--source", "--verify", "--cleanup-snapshot-temp", "--cleanup-proof-temp"].includes(flag)) return usage(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) return usage(`${flag} needs a directory`);
    if (values.has(flag)) return usage(`${flag} was repeated`);
    values.set(flag, value);
    index += 1;
  }
  const stageDir = values.get("--stage");
  const verifyDir = values.get("--verify");
  const cleanupSnapshotDir = values.get("--cleanup-snapshot-temp");
  const cleanupDir = values.get("--cleanup-proof-temp");
  if ([stageDir, verifyDir, cleanupSnapshotDir, cleanupDir].filter(Boolean).length !== 1) return usage("choose exactly one operation");
  if (values.has("--source") && !stageDir) return usage("--source is valid only with --stage");
  if (stageDir) {
    const manifest = stageFactoryBackup(stageDir, values.get("--source"));
    const ledgerBytes = manifest.files.find((entry) => entry.path === "events.jsonl")?.bytes || 0;
    if (ledgerBytes >= LEDGER_WARNING_BYTES) {
      process.stderr.write(`FACTORY BACKUP WARNING: events.jsonl is ${ledgerBytes} bytes, above 75% of the ${MAX_FILE_BYTES}-byte per-file limit; plan a reviewed ledger archival strategy before backups reach the limit.\n`);
    }
    const status = factoryBackupExitCode(manifest);
    if (status === 4) {
      process.stderr.write(`FACTORY BACKUP PRESERVED DEGRADED: ${manifest.replay_warning}\n`);
      process.stdout.write(`FACTORY BACKUP PRESERVED: ${manifest.file_count} durable files, ${manifest.total_bytes} bytes, ledger ${manifest.ledger_sha256}.\n`);
      return 4;
    }
    process.stdout.write(`FACTORY BACKUP READY: ${manifest.file_count} durable files, ${manifest.total_bytes} bytes, ledger ${manifest.ledger_sha256}.\n`);
    return status;
  }
  if (cleanupDir) {
    cleanupFactoryBackupProofWorkspace(cleanupDir);
    process.stdout.write(`FACTORY BACKUP PROOF TEMP CLEANED: ${path.resolve(cleanupDir)}\n`);
    return 0;
  }
  if (cleanupSnapshotDir) {
    cleanupFactoryStagedSnapshot(cleanupSnapshotDir);
    process.stdout.write(`FACTORY BACKUP SNAPSHOT TEMP CLEANED: ${path.resolve(cleanupSnapshotDir)}\n`);
    return 0;
  }
  const result = verifyFactoryBackup(verifyDir);
  if (!result.ok) {
    process.stderr.write(`FACTORY BACKUP INVALID: ${result.problems.join(" | ")}\n`);
    return 1;
  }
  if (!result.replayOk) {
    process.stderr.write(`FACTORY BACKUP PRESERVED DEGRADED: ${result.manifest.replay_warning}\n`);
    return 4;
  }
  const ledgerBytes = result.manifest.files.find((entry) => entry.path === "events.jsonl")?.bytes || 0;
  if (factoryBackupExitCode(result.manifest) === 5) {
    process.stderr.write(`FACTORY BACKUP WARNING: events.jsonl is ${ledgerBytes} bytes, above 75% of the ${MAX_FILE_BYTES}-byte per-file limit; plan a reviewed ledger archival strategy before backups reach the limit.\n`);
    process.stdout.write(`FACTORY BACKUP VERIFIED: ${result.manifest.file_count} files replay cleanly.\n`);
    return 5;
  }
  process.stdout.write(`FACTORY BACKUP VERIFIED: ${result.manifest.file_count} files replay cleanly.\n`);
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exitCode = runFactoryBackupCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`FACTORY BACKUP FAILED: ${error?.message || error}\n`);
    process.exitCode = 3;
  }
}
