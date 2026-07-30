#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  APPROVAL_TTL_MS,
  appendFactoryEvent,
  buildFactorySnapshot,
  canonicalJson,
  consumeFactoryCliPermit,
  loadFactorySnapshot,
  mintFactoryCliPermit,
  readEventLog,
  recoverFactoryState,
  repositoryContentFingerprint,
  resolveFactoryPaths,
  resolveHookFactoryPaths,
  setEmergencyFactoryHold,
  clearEmergencyFactoryHold,
  sha256,
  ticketHash,
  validateCurrentHarnessEvidence,
  validateLaneStart,
  writeImmutableTicket,
} from "./factory-state-lib.mjs";
import { gitLocalEnvironmentNames } from "../.claude/hooks/git-test-env.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
// Git hooks export repository-local GIT_* variables. Scrub them before any
// scratch `git init`; otherwise the fixture can rewrite the real shared config.
for (const name of gitLocalEnvironmentNames()) delete process.env[name];
for (const name of Object.keys(process.env)) {
  if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) delete process.env[name];
}
let pass = 0;
const ok = (value, message) => { assert.ok(value, message); pass++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); pass++; };
const throws = (fn, pattern, message) => { assert.throws(fn, pattern, message); pass++; };

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "crx-factory-state-"));
  const env = { CRX_FACTORY_TEST_MODE: "1", CRX_FACTORY_TEST_STATE_DIR: path.join(root, "state") };
  process.env.CRX_FACTORY_TEST_MODE = "1";
  process.env.CRX_FACTORY_TEST_STATE_DIR = env.CRX_FACTORY_TEST_STATE_DIR;
  const paths = resolveFactoryPaths(root, env);
  return { root, env, paths };
}

function ticket(id = "factory-test-1", overrides = {}) {
  return {
    id,
    version: 1,
    title: "Protect invoice totals",
    goal: "Show the correct business result.",
    definitionOfDone: ["The behavior runs and is observed."],
    mustNotChange: ["Inventory quantities stay unchanged."],
    proofRequirements: ["Attach command output and a screenshot."],
    proofHarnesses: ["verify-deps"],
    deliveryGate: "Stop before commit.",
    riskAreas: ["money"],
    businessExample: "$500 split 50/50 shows $250 and $250.",
    forbiddenOutcome: "The split may not total more or less than $500.",
    ...overrides,
  };
}

function append(paths, type, jobId, payload = {}, options = {}) {
  return appendFactoryEvent(paths, {
    type,
    jobId,
    actorTool: options.actorTool || "codex",
    sessionId: options.sessionId || "session-1",
    timestamp: options.timestamp || "2026-07-30T12:00:00.000Z",
    payload,
  });
}

{
  const { root, paths } = fixture();
  const issued = mintFactoryCliPermit(paths, {
    sessionId: "trusted-session",
    actorTool: "codex",
    nowMs: 1_000,
  });
  eq(
    consumeFactoryCliPermit(paths, issued.token, { nowMs: 2_000 }),
    { sessionId: "trusted-session", actorTool: "codex" },
    "one-time CLI permit returns hook-bound identity",
  );
  throws(
    () => consumeFactoryCliPermit(paths, issued.token, { nowMs: 2_001 }),
    /missing, expired, or already consumed/,
    "consumed CLI permit cannot be replayed",
  );
  const expired = mintFactoryCliPermit(paths, {
    sessionId: "trusted-session",
    actorTool: "codex",
    nowMs: 1_000,
  });
  throws(
    () => consumeFactoryCliPermit(paths, expired.token, { nowMs: 60_000 }),
    /expired before use/,
    "expired CLI permit is refused",
  );
  rmSync(root, { recursive: true, force: true });
}

{
  const { root, paths } = fixture();
  const written = writeImmutableTicket(paths, ticket());
  eq(written.hash, ticketHash(written.ticket), "ticket hash binds canonical bytes");
  ok(readFileSync(written.fullPath, "utf8").endsWith("\n"), "immutable ticket is newline-terminated");
  throws(
    () => writeImmutableTicket(paths, ticket("bad-example", { businessExample: "" })),
    /businessExample is required/,
    "high-risk ticket requires a worked example",
  );
  throws(
    () => writeImmutableTicket(paths, ticket("bad-harness", { proofHarnesses: ["check:lane-proof"] })),
    /unsupported repository harness/,
    "ticket cannot approve a self-invented harness name",
  );

  append(paths, "ticket-drafted", written.ticket.id, {
    ticketFile: written.filename,
    ticketHash: written.hash,
    ticketVersion: 1,
    title: written.ticket.title,
  });
  append(paths, "ticket-presented", written.ticket.id, {
    ticketHash: written.hash,
    questionText: "Approve this exact factory ticket?",
    questionHash: sha256("Approve this exact factory ticket?"),
    baseSha: "a".repeat(40),
  });
  append(paths, "ticket-approved", written.ticket.id, {
    ticketHash: written.hash,
    questionHash: sha256("Approve this exact factory ticket?"),
    ownerReply: "yes",
    baseSha: "a".repeat(40),
    expiresAt: new Date(Date.parse("2026-07-30T12:00:00.000Z") + APPROVAL_TTL_MS).toISOString(),
  });
  const snapshot = loadFactorySnapshot(paths, { nowMs: Date.parse("2026-07-30T13:00:00.000Z") });
  eq(snapshot.jobs[0].stage, "queued", "approved ticket becomes queued");
  eq(snapshot.jobs[0].approvalReply, "yes", "exact owner reply is retained");
  eq(
    validateLaneStart({
      snapshot,
      jobId: written.ticket.id,
      sessionId: "session-1",
      currentBaseSha: "a".repeat(40),
      nowMs: Date.parse("2026-07-30T13:00:00.000Z"),
    }).id,
    written.ticket.id,
    "lane starts only with matching session, base, expiry, and ticket bytes",
  );
  throws(
    () => validateLaneStart({
      snapshot,
      jobId: written.ticket.id,
      sessionId: "other-session",
      currentBaseSha: "a".repeat(40),
      nowMs: Date.parse("2026-07-30T13:00:00.000Z"),
    }),
    /another chat session/,
    "cross-session approval is refused",
  );
  throws(
    () => validateLaneStart({
      snapshot,
      jobId: written.ticket.id,
      sessionId: "session-1",
      currentBaseSha: "b".repeat(40),
      nowMs: Date.parse("2026-07-30T13:00:00.000Z"),
    }),
    /origin\/main moved/,
    "moved base invalidates approval",
  );
  rmSync(root, { recursive: true, force: true });
}

{
  const { root, paths } = fixture();
  setEmergencyFactoryHold(paths, "Mason requested a pause while the ledger was unavailable.");
  eq(buildFactorySnapshot(paths).held, true, "emergency hold blocks work without a ledger append");
  clearEmergencyFactoryHold(paths);
  eq(buildFactorySnapshot(paths).held, false, "canonical recovery can clear the emergency hold");

  writeFileSync(paths.lockPath, `${JSON.stringify({
    pid: 99999999,
    createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  })}\n`);
  const unlocked = recoverFactoryState(paths, {
    mode: "unlock",
    reason: "The recorded writer is gone and the lock is older than five minutes.",
  });
  ok(unlocked.backup.includes("stale-lock"), "stale lock recovery preserves a backup");

  append(paths, "factory-intent", null, { ownerRequest: "factory work" });
  appendFileSync(paths.eventsPath, "{\"incomplete\":");
  eq(readEventLog(paths).degraded, true, "fixture has a torn ledger tail");
  const repaired = recoverFactoryState(paths, {
    mode: "torn-tail",
    reason: "Archive the torn tail and restore the last verified newline.",
  });
  ok(repaired.backup.includes("torn-events"), "torn-tail recovery preserves the original bytes");
  eq(readEventLog(paths).degraded, false, "torn-tail recovery restores a readable chain");
  rmSync(root, { recursive: true, force: true });
}

{
  const { root, paths } = fixture();
  append(paths, "factory-intent", null, { ownerRequest: "run factory overnight" });
  append(paths, "factory-held", null, { reason: "Mason paused it." });
  let snapshot = buildFactorySnapshot(paths);
  eq(snapshot.factoryIntentSessions, ["session-1"], "factory intent is shared state");
  eq(snapshot.held, true, "global hold is derived");
  append(paths, "factory-resumed", null, { reason: "Mason resumed it." });
  append(paths, "factory-intent-cleared", null, { reason: "lane started" });
  snapshot = buildFactorySnapshot(paths);
  eq(snapshot.factoryIntentSessions, [], "factory intent can be cleared");
  eq(snapshot.held, false, "global resume clears hold");
  rmSync(root, { recursive: true, force: true });
}

{
  const { root, paths } = fixture();
  append(paths, "factory-intent", null, { ownerRequest: "x" });
  const original = readFileSync(paths.eventsPath, "utf8");
  const event = JSON.parse(original.trim());
  event.payload.ownerRequest = "tampered";
  writeFileSync(paths.eventsPath, `${canonicalJson(event)}\n`, "utf8");
  throws(() => readEventLog(paths), /Event hash mismatch/, "tampered event is rejected");
  rmSync(root, { recursive: true, force: true });
}

{
  const { root, paths } = fixture();
  append(paths, "factory-intent", null, { ownerRequest: "x" });
  appendFileSync(paths.eventsPath, '{"schemaVersion":1', "utf8");
  const log = readEventLog(paths);
  eq(log.events.length, 1, "verified events survive a torn final line");
  eq(log.degraded, true, "torn final line is reported as degraded");
  throws(
    () => append(paths, "factory-resumed", null, {}),
    /incomplete trailing event/,
    "no new event appends while torn tail exists",
  );
  rmSync(root, { recursive: true, force: true });
}

{
  const root = mkdtempSync(path.join(tmpdir(), "crx-factory-env-"));
  throws(
    () => resolveFactoryPaths(root, { CRX_FACTORY_TEST_STATE_DIR: path.join(root, "state") }),
    /allowed only/,
    "test state override fails closed outside explicit test mode",
  );
  rmSync(root, { recursive: true, force: true });
}

{
  const redirected = path.join(tmpdir(), "crx-factory-hook-redirect");
  const resolved = resolveHookFactoryPaths(process.cwd(), {
    ...process.env,
    NODE_TEST_CONTEXT: "",
    CRX_FACTORY_TEST_MODE: "1",
    CRX_FACTORY_TEST_STATE_DIR: redirected,
  });
  ok(path.resolve(resolved.stateDir) !== path.resolve(redirected), "production hooks ignore test-state environment overrides");
}

{
  const fingerprintRepo = mkdtempSync(path.join(tmpdir(), "crx-factory-fingerprint-"));
  execFileSync("git", ["init"], { cwd: fingerprintRepo, stdio: "ignore" });
  writeFileSync(path.join(fingerprintRepo, "source.txt"), "before\n");
  execFileSync("git", ["add", "source.txt"], { cwd: fingerprintRepo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Factory Test", "-c", "user.email=factory@example.invalid", "commit", "-m", "init"], {
    cwd: fingerprintRepo,
    stdio: "ignore",
  });
  const before = repositoryContentFingerprint(fingerprintRepo);
  writeFileSync(path.join(fingerprintRepo, "source.txt"), "after\n");
  const changed = repositoryContentFingerprint(fingerprintRepo);
  ok(before.repositoryContentHash !== changed.repositoryContentHash, "repository proof hash changes after source bytes change");
  execFileSync("git", ["add", "source.txt"], { cwd: fingerprintRepo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Factory Test", "-c", "user.email=factory@example.invalid", "commit", "-m", "after"], {
    cwd: fingerprintRepo,
    stdio: "ignore",
  });
  const committed = repositoryContentFingerprint(fingerprintRepo);
  eq(committed.repositoryContentHash, changed.repositoryContentHash, "repository proof hash survives committing identical content");
  rmSync(fingerprintRepo, { recursive: true, force: true });
}

{
  const packageBytes = readFileSync(path.join(repoRoot, "package.json"));
  const packageJson = JSON.parse(packageBytes);
  const scriptBody = packageJson.scripts["verify-deps"];
  const repository = repositoryContentFingerprint(repoRoot);
  const landedJob = {
    baseSha: "1111111111111111111111111111111111111111",
    ticket: { proofHarnesses: ["verify-deps"] },
    evidence: [{
      verified: true,
      kind: "harness",
      scriptName: "verify-deps",
      baseSha: "1111111111111111111111111111111111111111",
      scriptBodyHash: sha256(scriptBody),
      baseScriptBodyHash: sha256(scriptBody),
      packageJsonHash: sha256(packageBytes),
      repositoryContentHash: repository.repositoryContentHash,
      repositoryFileCount: repository.repositoryFileCount,
    }],
  };
  throws(
    () => validateCurrentHarnessEvidence(landedJob, repoRoot),
    /current, ticket-approved/,
    "morning review rejects proof when origin/main moved",
  );
  ok(
    validateCurrentHarnessEvidence(landedJob, repoRoot, { requireCurrentBase: false }),
    "post-landing closeout accepts proof bound to the job's immutable original base",
  );
  landedJob.evidence[0].repositoryContentHash = "0".repeat(64);
  throws(
    () => validateCurrentHarnessEvidence(landedJob, repoRoot, { requireCurrentBase: false }),
    /current, ticket-approved/,
    "source changes invalidate previously verified harness evidence",
  );
}

console.log(`factory-state-lib: ${pass} assertions passed`);
