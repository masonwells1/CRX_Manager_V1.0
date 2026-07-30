#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
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
  FACTORY_REVIEW_TOKEN,
  factoryReviewVerdict,
  factoryHarnessDependencyHashForCommit,
  factoryHarnessSandboxArgs,
  loadFactorySnapshot,
  mintFactoryCliPermit,
  normalizeTicket,
  readEventLog,
  recoverFactoryState,
  rejectSecretBearingText,
  repositoryCommitFingerprint,
  repositoryContentFingerprint,
  resolveFactoryPaths,
  resolveHookFactoryPaths,
  runHarnessEvidence,
  setEmergencyFactoryHold,
  clearEmergencyFactoryHold,
  sha256,
  ticketHash,
  validateCurrentHarnessEvidence,
  validateCurrentIndependentReview,
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

eq(rejectSecretBearingText("HTTP 200; behavior verified.", "proof"), "HTTP 200; behavior verified.", "ordinary proof text is accepted");
throws(
  () => rejectSecretBearingText("OPENAI_API_KEY=sk-this-must-not-persist", "proof"),
  /credential or secret/,
  "secret-shaped proof text is rejected before persistence",
);
throws(
  () => rejectSecretBearingText("eyJabcdefghijk.abcdefghijklmnop.abcdefghijklmnop", "proof"),
  /credential or secret/,
  "raw JWT-shaped credentials are rejected before persistence",
);
eq(
  factoryReviewVerdict({ status: 0, stdout: `Review complete.\n${FACTORY_REVIEW_TOKEN}: CLEAN\n` }),
  "clean",
  "one terminal independent-review CLEAN token is accepted",
);
eq(
  factoryReviewVerdict({ status: 0, stdout: `${FACTORY_REVIEW_TOKEN}: CLEAN\ntext after verdict\n` }),
  null,
  "independent-review prose after the token fails closed",
);
eq(
  factoryReviewVerdict({ status: 0, stdout: `${FACTORY_REVIEW_TOKEN}: CLEAN\n${FACTORY_REVIEW_TOKEN}: CLEAN\n` }),
  null,
  "duplicate independent-review tokens fail closed",
);
eq(
  factoryReviewVerdict({ status: 0, stdout: `${FACTORY_REVIEW_TOKEN}: BLOCKERS\n` }),
  null,
  "independent-review blockers fail closed",
);

if (process.env.CRX_FACTORY_SANDBOX !== "1") {
  const args = factoryHarnessSandboxArgs({
    cwd: repoRoot,
    scriptName: "verify-deps",
    imageId: `sha256:${"1".repeat(64)}`,
    workspaceVolume: `crx-factory-workspace-${"2".repeat(32)}`,
    containerName: `crx-factory-workspace-${"2".repeat(32)}-run`,
  });
  ok(args.includes("none") && args.includes("--network"), "production harness sandbox disables network access");
  ok(args.includes("--read-only") && args.includes("ALL"), "production harness sandbox removes root writes and Linux capabilities");
  ok(args.some((item) => item.includes(`source=crx-factory-workspace-${"2".repeat(32)},target=/workspace`)), "production harness runs from a disposable workspace volume");
  ok(!args.some((item) => item.includes("type=volume") && item.includes("node_modules")), "production harness dependencies stay inside the immutable image layer");
  ok(!args.some((item) => /OPENAI|SUPABASE|VERCEL|GITHUB|TOKEN|KEY/i.test(item)), "production harness arguments do not forward credential-bearing environment names");
}

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

throws(
  () => normalizeTicket(ticket("secret-ticket", {
    goal: "Use eyJabcdefghijk.abcdefghijklmnop.abcdefghijklmnop",
  })),
  /credential or secret/,
  "secret-shaped ticket fields are rejected before ticket persistence",
);

{
  const { root, paths } = fixture();
  throws(
    () => appendFactoryEvent(paths, {
      type: "factory-intent",
      jobId: null,
      actorTool: "codex",
      sessionId: "secret-event-test",
      payload: { ownerRequest: "eyJabcdefghijk.abcdefghijklmnop.abcdefghijklmnop" },
    }),
    /credential or secret/,
    "secret-shaped arbitrary event fields are rejected before ledger persistence",
  );
  rmSync(root, { recursive: true, force: true });
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
  const staleSnapshot = loadFactorySnapshot(paths);
  appendFactoryEvent(paths, {
    type: "factory-intent",
    jobId: null,
    actorTool: "codex",
    sessionId: "lane-race-winner",
    payload: { ownerRequest: "start one lane" },
  }, { expectedLastEventHash: staleSnapshot.lastEventHash });
  throws(
    () => appendFactoryEvent(paths, {
      type: "factory-intent",
      jobId: null,
      actorTool: "codex",
      sessionId: "lane-race-loser",
      payload: { ownerRequest: "start another lane" },
    }, { expectedLastEventHash: staleSnapshot.lastEventHash }),
    /changed after this decision/,
    "stale lifecycle compare-and-swap refuses a second concurrent writer",
  );
  eq(loadFactorySnapshot(paths).factoryIntentSessions, ["lane-race-winner"], "only the compare-and-swap winner reaches the ledger");
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
  mkdirSync(path.join(fingerprintRepo, ".agents"), { recursive: true });
  writeFileSync(path.join(fingerprintRepo, ".agents", "README.md"), "readme\n");
  writeFileSync(path.join(fingerprintRepo, ".agents", "generated-manifest.json"), "{}\n");
  writeFileSync(path.join(fingerprintRepo, "README.md"), "root readme\n");
  writeFileSync(path.join(fingerprintRepo, "source.txt"), "before\n");
  execFileSync("git", ["add", "."], { cwd: fingerprintRepo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Factory Test", "-c", "user.email=factory@example.invalid", "commit", "-m", "init"], {
    cwd: fingerprintRepo,
    stdio: "ignore",
  });
  const before = repositoryContentFingerprint(fingerprintRepo);
  const initialCommit = repositoryCommitFingerprint(fingerprintRepo, "HEAD");
  eq(initialCommit.repositoryContentHash, before.repositoryContentHash, "commit fingerprint matches identical working-tree bytes");
  writeFileSync(path.join(fingerprintRepo, "source.txt"), "after\n");
  const changed = repositoryContentFingerprint(fingerprintRepo);
  ok(before.repositoryContentHash !== changed.repositoryContentHash, "repository proof hash changes after source bytes change");
  ok(initialCommit.repositoryContentHash !== changed.repositoryContentHash, "unlanded source bytes do not match the old landing commit");
  execFileSync("git", ["add", "source.txt"], { cwd: fingerprintRepo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Factory Test", "-c", "user.email=factory@example.invalid", "commit", "-m", "after"], {
    cwd: fingerprintRepo,
    stdio: "ignore",
  });
  const committed = repositoryContentFingerprint(fingerprintRepo);
  const landed = repositoryCommitFingerprint(fingerprintRepo, "HEAD");
  eq(committed.repositoryContentHash, changed.repositoryContentHash, "repository proof hash survives committing identical content");
  eq(landed.repositoryContentHash, changed.repositoryContentHash, "landing commit fingerprint binds the exact proven content");
  rmSync(fingerprintRepo, { recursive: true, force: true });
}

{
  const { root, paths } = fixture();
  const harnessRepo = mkdtempSync(path.join(tmpdir(), "crx-factory-harness-state-"));
  writeFileSync(path.join(harnessRepo, "package.json"), `${JSON.stringify({
    scripts: {
      "verify-deps": "node -e \"require('node:fs').writeFileSync(process.env.FACTORY_MUTATE_TARGET,'forged')\"",
    },
  })}\n`);
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "package.json"],
    ["-c", "user.name=Factory Test", "-c", "user.email=factory@example.invalid", "commit", "-qm", "fixture"],
    ["update-ref", "refs/remotes/origin/main", "HEAD"],
  ]) {
    execFileSync("git", args, { cwd: harnessRepo, stdio: "ignore" });
  }
  mkdirSync(paths.stateDir, { recursive: true });
  process.env.FACTORY_MUTATE_TARGET = path.join(paths.stateDir, "forged.txt");
  throws(
    () => runHarnessEvidence(paths, {
      jobId: "state-mutation-proof",
      label: "must fail",
      scriptName: "verify-deps",
      cwd: harnessRepo,
    }),
    /factory is held for review/,
    "trusted harness broker detects indirect mutation of factory state",
  );
  ok(existsSync(paths.emergencyHoldPath), "indirect harness mutation creates an emergency hold");
  delete process.env.FACTORY_MUTATE_TARGET;
  rmSync(harnessRepo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}

{
  const packageBytes = readFileSync(path.join(repoRoot, "package.json"));
  const packageJson = JSON.parse(packageBytes);
  const scriptBody = packageJson.scripts["verify-deps"];
  const repository = repositoryContentFingerprint(repoRoot);
  const proofBaseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const proofDependencyHash = factoryHarnessDependencyHashForCommit(repoRoot, proofBaseSha);
  const proofRoot = mkdtempSync(path.join(tmpdir(), "crx-factory-artifact-proof-"));
  const proofPaths = resolveFactoryPaths(repoRoot, {
    CRX_FACTORY_TEST_MODE: "1",
    CRX_FACTORY_TEST_STATE_DIR: path.join(proofRoot, "state"),
  });
  const proofPayload = {
    scriptName: "verify-deps",
    baseSha: proofBaseSha,
    repositoryContentHash: repository.repositoryContentHash,
    repositoryFileCount: repository.repositoryFileCount,
  };
  const proofBytes = `${canonicalJson(proofPayload)}\n`;
  const proofFilename = `${sha256(proofBytes).slice(0, 12)}-verify-deps.json`;
  mkdirSync(path.join(proofPaths.evidenceDir, "landed-job"), { recursive: true });
  writeFileSync(path.join(proofPaths.evidenceDir, "landed-job", proofFilename), proofBytes);
  const landedJob = {
    id: "landed-job",
    baseSha: proofBaseSha,
    ticket: { proofHarnesses: ["verify-deps"] },
    evidence: [{
      verified: true,
      kind: "harness",
      scriptName: "verify-deps",
      baseSha: proofBaseSha,
      scriptBodyHash: sha256(scriptBody),
      baseScriptBodyHash: sha256(scriptBody),
      packageJsonHash: sha256(packageBytes),
      filename: proofFilename,
      sha256: sha256(proofBytes),
      repositoryContentHash: repository.repositoryContentHash,
      repositoryFileCount: repository.repositoryFileCount,
      sandbox: {
        mode: "docker",
        network: "none",
        repositoryMount: "disposable-volume",
        sourceExposure: "bootstrap-only",
        dependencyMount: "immutable-image-layer",
        inheritedEnvironment: false,
        imageId: `sha256:${"1".repeat(64)}`,
        imageTag: `crx-factory-harness:${proofDependencyHash.slice(0, 24)}`,
        dependencyHash: proofDependencyHash,
      },
    }],
  };
  throws(
    () => validateCurrentHarnessEvidence(landedJob, repoRoot, { paths: proofPaths }),
    /every ticket-required/,
    "morning review rejects proof when origin/main moved",
  );
  ok(
    validateCurrentHarnessEvidence(landedJob, repoRoot, { requireCurrentBase: false, paths: proofPaths }),
    "post-landing closeout accepts proof bound to the job's immutable original base",
  );
  landedJob.ticket.proofHarnesses = ["verify-deps", "build"];
  throws(
    () => validateCurrentHarnessEvidence(landedJob, repoRoot, { requireCurrentBase: false, paths: proofPaths }),
    /every ticket-required/,
    "one passing harness cannot satisfy a ticket that requires multiple harnesses",
  );
  landedJob.ticket.proofHarnesses = ["verify-deps"];
  landedJob.evidence[0].repositoryContentHash = "0".repeat(64);
  throws(
    () => validateCurrentHarnessEvidence(landedJob, repoRoot, { requireCurrentBase: false, paths: proofPaths }),
    /every ticket-required/,
    "source changes invalidate previously verified harness evidence",
  );
  landedJob.evidence[0].repositoryContentHash = repository.repositoryContentHash;
  writeFileSync(path.join(proofPaths.evidenceDir, "landed-job", proofFilename), `${proofBytes}tampered`);
  throws(
    () => validateCurrentHarnessEvidence(landedJob, repoRoot, { requireCurrentBase: false, paths: proofPaths }),
    /no longer match the ledger SHA-256/,
    "morning and closeout validation re-hash saved harness proof bytes",
  );

  const reviewPayload = {
    reviewer: "codex",
    verdict: "clean",
    baseSha: proofBaseSha,
    headSha: repository.headSha,
    headTreeSha: repository.headTreeSha,
    repositoryContentHash: repository.repositoryContentHash,
    repositoryFileCount: repository.repositoryFileCount,
  };
  const reviewBytes = `${canonicalJson(reviewPayload)}\n`;
  const reviewFilename = `${sha256(reviewBytes).slice(0, 12)}-independent-codex-review.json`;
  writeFileSync(path.join(proofPaths.evidenceDir, "landed-job", reviewFilename), reviewBytes);
  landedJob.reviews = [{
    ...reviewPayload,
    model: "test-reviewer",
    filename: reviewFilename,
    sha256: sha256(reviewBytes),
  }];
  ok(
    validateCurrentIndependentReview(landedJob, repoRoot, { paths: proofPaths }),
    "independent review validation reopens the ledger-bound review artifact",
  );
  writeFileSync(path.join(proofPaths.evidenceDir, "landed-job", reviewFilename), `${reviewBytes}tampered`);
  throws(
    () => validateCurrentIndependentReview(landedJob, repoRoot, { paths: proofPaths }),
    /no longer match the ledger SHA-256/,
    "independent review validation rejects changed artifact bytes",
  );
  rmSync(proofRoot, { recursive: true, force: true });
}

console.log(`factory-state-lib: ${pass} assertions passed`);
