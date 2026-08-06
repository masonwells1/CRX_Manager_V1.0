#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  durableFactoryFiles,
  factoryBackupExitCode,
  cleanupFactoryBackupProofWorkspace,
  cleanupFactoryStagedSnapshot,
  runFactoryBackupCli,
  stageFactoryBackup,
  verifyFactoryBackup,
} from "./backup-factory-state.mjs";

let assertions = 0;
const root = mkdtempSync(path.join(tmpdir(), "crx-factory-backup-test-"));
const source = path.join(root, "source");
const destination = path.join(root, "snapshot");
mkdirSync(path.join(source, "permits", "owner-receipts"), { recursive: true });
mkdirSync(path.join(source, "tickets"), { recursive: true });
mkdirSync(path.join(source, "recovery"), { recursive: true });
mkdirSync(path.join(source, "intent-latches"), { recursive: true });
mkdirSync(path.join(source, "harness-runs"), { recursive: true });
mkdirSync(path.join(source, "evidence", "factory-durability"), { recursive: true });
mkdirSync(path.join(source, "evidence", "factory-durability-ergonomics"), { recursive: true });
writeFileSync(path.join(source, "events.jsonl"), "");
writeFileSync(path.join(source, "tickets", "job.json"), "{}\n");
writeFileSync(path.join(source, "recovery", "ledger-copy.jsonl"), "backup\n");
writeFileSync(path.join(source, "permits", "owner-receipt.key"), "test-key\n");
writeFileSync(path.join(source, "permits", "owner-receipts", "receipt.json"), "{}\n");
writeFileSync(path.join(source, "permits", "active-cli-permit.json"), "must-not-restore\n");
writeFileSync(path.join(source, "events.lock"), "must-not-restore\n");
writeFileSync(path.join(source, "intent-latches", "session.json"), "must-not-restore\n");
writeFileSync(path.join(source, "harness-runs", "job.json"), "must-not-restore\n");
writeFileSync(path.join(source, "evidence", "factory-durability", "proof.json"), "{}\n");
writeFileSync(path.join(source, "evidence", "factory-durability-ergonomics", "proof.json"), "{}\n");

const durable = durableFactoryFiles(source).map((item) => item.relative);
assert.ok(durable.includes("events.jsonl")); assertions++;
assert.ok(durable.includes("permits/owner-receipt.key")); assertions++;
assert.ok(durable.includes("permits/owner-receipts/receipt.json")); assertions++;
assert.ok(!durable.some((name) => /active-cli-permit|events\.lock|intent-latches|harness-runs/.test(name))); assertions++;

const manifest = stageFactoryBackup(destination, source, { now: () => new Date("2026-08-06T12:00:00.000Z") });
assert.equal(manifest.file_count, 7); assertions++;
assert.equal(verifyFactoryBackup(destination).ok, true); assertions++;
assert.equal(readFileSync(path.join(destination, "state", "permits", "owner-receipt.key"), "utf8"), "test-key\n"); assertions++;
assert.throws(() => stageFactoryBackup(destination, source), /must not already exist/i); assertions++;
assert.equal(factoryBackupExitCode(manifest), 0); assertions++;
assert.equal(factoryBackupExitCode({ ...manifest, replay_ok: false }), 4); assertions++;
assert.equal(factoryBackupExitCode({
  ...manifest,
  files: manifest.files.map((entry) => entry.path === "events.jsonl" ? { ...entry, bytes: manifest.ledger_warning_bytes } : entry),
}), 5); assertions++;

writeFileSync(path.join(destination, "state", "tickets", "job.json"), "changed\n");
const changed = verifyFactoryBackup(destination);
assert.equal(changed.ok, false); assertions++;
assert.match(changed.problems.join(" "), /bytes differ/i); assertions++;

writeFileSync(path.join(destination, "state", "unexpected-secret.env"), "SECRET=not-real\n");
const unexpected = verifyFactoryBackup(destination);
assert.equal(unexpected.ok, false); assertions++;
assert.match(unexpected.problems.join(" "), /inventory differs/i); assertions++;

const rootInventoryDestination = path.join(root, "root-inventory-snapshot");
stageFactoryBackup(rootInventoryDestination, source);
writeFileSync(path.join(rootInventoryDestination, "unexpected-root.txt"), "not manifested\n");
const unexpectedRoot = verifyFactoryBackup(rootInventoryDestination);
assert.equal(unexpectedRoot.ok, false); assertions++;
assert.match(unexpectedRoot.problems.join(" "), /root must contain exactly/i); assertions++;

function verifyTamperedManifest(name, mutate) {
  const target = path.join(root, name);
  stageFactoryBackup(target, source);
  const manifestPath = path.join(target, "manifest.json");
  const value = JSON.parse(readFileSync(manifestPath, "utf8"));
  mutate(value);
  writeFileSync(manifestPath, `${JSON.stringify(value, null, 2)}\n`);
  return verifyFactoryBackup(target);
}

const unsafeManifest = verifyTamperedManifest("unsafe-manifest-snapshot", (value) => {
  value.files[0].path = "../escape.txt";
});
assert.equal(unsafeManifest.ok, false); assertions++;
assert.match(unsafeManifest.problems.join(" "), /unsafe path/i); assertions++;

const caseVariantManifest = verifyTamperedManifest("case-variant-manifest-snapshot", (value) => {
  value.files.find((entry) => entry.path === "events.jsonl").path = "Events.jsonl";
});
assert.equal(caseVariantManifest.ok, false); assertions++;
assert.match(caseVariantManifest.problems.join(" "), /does not include events\.jsonl/i); assertions++;

const ledgerHashManifest = verifyTamperedManifest("ledger-hash-manifest-snapshot", (value) => {
  value.ledger_sha256 = "0".repeat(64);
});
assert.equal(ledgerHashManifest.ok, false); assertions++;
assert.match(ledgerHashManifest.problems.join(" "), /ledger hash is inconsistent/i); assertions++;

const byteTotalManifest = verifyTamperedManifest("byte-total-manifest-snapshot", (value) => {
  value.total_bytes += 1;
});
assert.equal(byteTotalManifest.ok, false); assertions++;
assert.match(byteTotalManifest.problems.join(" "), /byte total is inconsistent/i); assertions++;

const unsafeSource = path.join(root, "unsafe-source");
mkdirSync(unsafeSource, { recursive: true });
writeFileSync(path.join(unsafeSource, "events.jsonl"), "");
let symlinkSupported = true;
try {
  symlinkSync(path.join(unsafeSource, "events.jsonl"), path.join(unsafeSource, "EMERGENCY-HOLD.json"));
} catch {
  symlinkSupported = false;
}
if (symlinkSupported) {
  assert.throws(() => stageFactoryBackup(path.join(root, "unsafe-snapshot"), unsafeSource), /unlinked regular file|symbolic link/i);
  assertions++;
}

const tornSource = path.join(root, "torn-source");
mkdirSync(tornSource, { recursive: true });
writeFileSync(path.join(tornSource, "events.jsonl"), '{"schemaVersion":1');
const tornDestination = path.join(root, "torn-snapshot");
const tornManifest = stageFactoryBackup(tornDestination, tornSource);
assert.equal(tornManifest.replay_ok, false); assertions++;
assert.match(tornManifest.replay_warning, /incomplete|interrupted|degraded/i); assertions++;
const tornVerification = verifyFactoryBackup(tornDestination);
assert.equal(tornVerification.ok, true); assertions++;
assert.equal(tornVerification.replayOk, false); assertions++;
assert.equal(runFactoryBackupCli(["--verify", tornDestination]), 4); assertions++;
const tornCliDestination = path.join(root, "torn-cli-snapshot");
assert.equal(runFactoryBackupCli(["--stage", tornCliDestination, "--source", tornSource]), 4); assertions++;
assert.equal(verifyFactoryBackup(tornCliDestination).replayOk, false); assertions++;

const outsideTemp = path.resolve(process.cwd(), "factory-backup-must-not-write");
assert.throws(() => stageFactoryBackup(outsideTemp, source), /only under.*temporary directory/i); assertions++;

assert.equal(runFactoryBackupCli([]), 2); assertions++;
assert.equal(runFactoryBackupCli(["--verify", destination]), 1); assertions++;

const cleanupRoot = path.join(root, `crx-factory-offsite-proof-${"a".repeat(32)}`);
mkdirSync(cleanupRoot, { recursive: true });
writeFileSync(path.join(cleanupRoot, "temporary-secret.bin"), "temporary\n");
cleanupFactoryBackupProofWorkspace(cleanupRoot);
assert.equal(existsSync(cleanupRoot), false); assertions++;
assert.throws(
  () => cleanupFactoryBackupProofWorkspace(path.join(root, "not-an-approved-name")),
  /cleanup is limited/i,
); assertions++;

const stagedCleanup = path.join(root, "staged-cleanup-snapshot");
stageFactoryBackup(stagedCleanup, source);
cleanupFactoryStagedSnapshot(stagedCleanup);
assert.equal(existsSync(stagedCleanup), false); assertions++;

if (process.platform === "win32") {
  const runnerDestination = path.join(root, "runner-snapshot");
  const runner = path.join(process.cwd(), "scripts", "windows", "stage-factory-state-for-personal-dr.ps1");
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", runner,
    "-Destination", runnerDestination,
    "-Source", source,
    "-ParentCleanupGuaranteed",
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 120_000 });
  assert.equal(result.status, 0, `tracked Personal DR runner stages through the real helper: ${result.stderr}`); assertions++;
  assert.equal(verifyFactoryBackup(runnerDestination).ok, true); assertions++;
  cleanupFactoryStagedSnapshot(runnerDestination);

  const selfTestDestination = path.join(root, "runner-self-test-snapshot");
  const selfTest = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", runner,
    "-Destination", selfTestDestination,
    "-Source", source,
    "-SelfTest",
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 120_000 });
  assert.equal(selfTest.status, 0, `tracked runner self-test succeeds: ${selfTest.stderr}`); assertions++;
  assert.equal(existsSync(selfTestDestination), false, "tracked runner self-test removes plaintext staging"); assertions++;

  const degradedSelfTestDestination = path.join(root, "runner-degraded-self-test-snapshot");
  const degradedSelfTest = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", runner,
    "-Destination", degradedSelfTestDestination,
    "-Source", tornSource,
    "-SelfTest",
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 120_000 });
  assert.equal(degradedSelfTest.status, 4, `tracked runner preserves and reports degraded state: ${degradedSelfTest.stderr}`); assertions++;
  assert.equal(existsSync(degradedSelfTestDestination), false, "degraded runner self-test removes plaintext staging"); assertions++;
}

rmSync(root, { recursive: true, force: true });
console.log(`backup-factory-state: ${assertions} assertions passed`);
