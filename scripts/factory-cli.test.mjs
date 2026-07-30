#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  appendFactoryEvent,
  canonicalMorningReviewQuestion,
  canonicalTicketApprovalQuestion,
  loadFactorySnapshot,
  mintFactoryCliPermit,
  resolveFactoryPaths,
} from "./factory-state-lib.mjs";
import { gitLocalEnvironmentNames } from "../.claude/hooks/git-test-env.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
for (const name of gitLocalEnvironmentNames()) delete process.env[name];
for (const name of Object.keys(process.env)) {
  if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) delete process.env[name];
}
const script = path.join(root, "scripts", "factory.mjs");
const stateDir = mkdtempSync(path.join(os.tmpdir(), "crx-factory-cli-"));
const fixtureDir = mkdtempSync(path.join(os.tmpdir(), "crx-factory-fixture-"));
const fixtureRepo = path.join(fixtureDir, "repo");
mkdirSync(fixtureRepo, { recursive: true });
writeFileSync(path.join(fixtureRepo, "package.json"), `${JSON.stringify({
  scripts: {
    "verify-deps": "node -e \"process.stdout.write('FACTORY_TEST_HARNESS_PASS')\"",
  },
}, null, 2)}\n`);
for (const args of [
  ["init", "-q", "-b", "main"],
  ["add", "package.json"],
  ["-c", "user.name=Factory Test", "-c", "user.email=factory@example.invalid", "commit", "-qm", "fixture"],
  ["update-ref", "refs/remotes/origin/main", "HEAD"],
]) {
  const result = spawnSync("git", args, { cwd: fixtureRepo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}
const env = {
  ...process.env,
  CRX_FACTORY_TEST_MODE: "1",
  CRX_FACTORY_TEST_STATE_DIR: stateDir,
  CRX_FACTORY_TEST_CLOSEOUT_DIR: path.join(fixtureRepo, "docs", "audits", "factory", "jobs"),
  CRX_FACTORY_TEST_REPO_DIR: fixtureRepo,
};
process.env.CRX_FACTORY_TEST_MODE = "1";
process.env.CRX_FACTORY_TEST_STATE_DIR = stateDir;
const paths = resolveFactoryPaths(fixtureRepo, env);
const sessionId = "cli-thread";
const jobId = "cli-integration-job";
let assertions = 0;

function run(args, identity = { sessionId, actorTool: "codex" }) {
  const readOnly = args[0] === "status";
  const permit = readOnly ? null : mintFactoryCliPermit(paths, {
    ...identity,
    expectedLastEventHash: loadFactorySnapshot(paths).lastEventHash,
  });
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: {
      ...env,
      ...(permit ? { CRX_FACTORY_PERMIT: permit.token } : {}),
    },
    encoding: "utf8",
  });
}

function gitHead(cwd) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function pass(result, message) {
  assertions++;
  assert.equal(result.status, 0, `${message}: ${result.stderr}`);
}

const ticketFile = path.join(fixtureDir, "ticket.json");
writeFileSync(ticketFile, JSON.stringify({
  id: jobId,
  title: "CLI integration proof",
  goal: "Exercise the supported factory mutation path.",
  definitionOfDone: ["Lane reaches morning review with attached proof."],
  mustNotChange: ["Production."],
  allowedPaths: ["feature.txt"],
  proofRequirements: ["Attached focused test output."],
  proofHarnesses: ["verify-deps"],
  deliveryGate: "Stop before commit.",
  riskAreas: [],
}));
const missingPermit = spawnSync(process.execPath, [script, "ticket", "draft", "--file", ticketFile], {
  cwd: root,
  env,
  encoding: "utf8",
});
assertions++;
assert.notEqual(missingPermit.status, 0, "mutating CLI refuses a direct invocation without a trusted hook permit");
const unsafeTestRepo = spawnSync(process.execPath, [script, "status", "--json"], {
  cwd: root,
  env: { ...env, CRX_FACTORY_TEST_REPO_DIR: root },
  encoding: "utf8",
});
assertions++;
assert.notEqual(unsafeTestRepo.status, 0, "test repository override cannot escape the temporary test boundary");
pass(run(["ticket", "draft", "--file", ticketFile]), "draft ticket");

const questionFile = path.join(fixtureDir, "question.txt");
const draftedTicket = loadFactorySnapshot(paths).jobs[0].ticket;
writeFileSync(questionFile, canonicalTicketApprovalQuestion(draftedTicket));
const stalePermit = mintFactoryCliPermit(paths, {
  sessionId,
  actorTool: "codex",
  expectedLastEventHash: loadFactorySnapshot(paths).lastEventHash,
});
appendFactoryEvent(paths, {
  type: "factory-intent",
  jobId: null,
  actorTool: "codex",
  sessionId: "ledger-race-thread",
  payload: { prompt: "change the ledger after permit issuance" },
});
const staleInvocation = spawnSync(process.execPath, [script, "ticket", "present", "--job", jobId], {
  cwd: root,
  env: { ...env, CRX_FACTORY_PERMIT: stalePermit.token },
  encoding: "utf8",
});
assertions++;
assert.notEqual(staleInvocation.status, 0, "CLI refuses a permit minted against an older terminal ledger hash");
assertions++;
assert.match(staleInvocation.stderr, /state changed after this command was authorized/i, "stale permit failure explains the ledger race");
appendFactoryEvent(paths, {
  type: "factory-intent-cleared",
  jobId: null,
  actorTool: "codex",
  sessionId: "ledger-race-thread",
  payload: { reason: "test cleanup" },
});
const crossSessionPresentation = run(
  ["ticket", "present", "--job", jobId],
  { sessionId: "other-thread", actorTool: "claude" },
);
assertions++;
assert.notEqual(crossSessionPresentation.status, 0, "another chat cannot take ownership by re-presenting an existing ticket");
const spoofedIdentity = run([
  "ticket", "present",
  "--job", jobId,
  "--session", "forged-thread",
  "--tool", "claude",
]);
assertions++;
assert.notEqual(spoofedIdentity.status, 0, "caller-supplied session/tool flags cannot override the trusted permit identity");
const presented = run(["ticket", "present", "--job", jobId]);
pass(presented, "present ticket");
assertions++;
assert.equal(JSON.parse(presented.stdout).questionText, canonicalTicketApprovalQuestion(draftedTicket), "ticket presentation emits only the ticket-derived canonical question");
const queued = loadFactorySnapshot(paths);
appendFactoryEvent(paths, {
  type: "ticket-approved",
  jobId,
  actorTool: "codex",
  sessionId,
  payload: {
    ticketHash: queued.jobs[0].ticketHash,
    questionHash: queued.jobs[0].questionHash,
    ownerReply: "yes",
    baseSha: queued.jobs[0].baseSha,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  },
});
pass(run(["lane", "start", "--job", jobId]), "start lane");
const rewindActiveLane = run(["ticket", "present", "--job", jobId]);
assertions++;
assert.notEqual(rewindActiveLane.status, 0, "the owning chat cannot rewind an active lane through ticket presentation");

const arbitraryEvidence = run([
  "evidence", "attach",
  "--job", jobId,
  "--file", path.join(fixtureDir, "proof.txt"),
  "--label", "Untrusted local file",
]);
assertions++;
assert.notEqual(arbitraryEvidence.status, 0, "factory CLI exposes no arbitrary-file evidence attachment route");
const crossSessionEvidence = run(
  ["evidence", "run", "--job", jobId, "--harness", "verify-deps", "--label", "Wrong session"],
  { sessionId: "other-thread", actorTool: "claude" },
);
assertions++;
assert.notEqual(crossSessionEvidence.status, 0, "another session cannot attach lane proof");
const inventedHarness = run(["evidence", "run", "--job", jobId, "--harness", "check:agent-guidance", "--label", "Invented proof"]);
assertions++;
assert.notEqual(inventedHarness.status, 0, "non-ticket/non-allowlisted harness is refused");
const summaryFile = path.join(fixtureDir, "summary.txt");
writeFileSync(summaryFile, "The supported CLI completed the governed flow.");
pass(run(["stage", "--job", jobId, "--stage", "verifying"]), "advance to verification");
pass(run(["stage", "--job", jobId, "--stage", "in-review"]), "advance to review");
writeFileSync(path.join(fixtureRepo, "feature.txt"), "real governed implementation change\n");
const unverifiedProof = run(["stage", "--job", jobId, "--stage", "awaiting-morning-review", "--summary-file", summaryFile]);
assertions++;
assert.notEqual(unverifiedProof.status, 0, "self-labeled attached file is not enough for morning review");
pass(run(["evidence", "run", "--job", jobId, "--harness", "verify-deps", "--label", "Dependency harness"]), "run repository harness");
const noIndependentReview = run(["stage", "--job", jobId, "--stage", "awaiting-morning-review", "--summary-file", summaryFile]);
assertions++;
assert.notEqual(noIndependentReview.status, 0, "a passing branch harness cannot self-certify morning review");
pass(run(["review", "run", "--job", jobId]), "run independent Codex review");
const reviewReceipt = loadFactorySnapshot(paths).jobs[0].reviews[0];
const reviewArtifact = JSON.parse(readFileSync(path.join(paths.evidenceDir, jobId, reviewReceipt.filename), "utf8"));
assertions++;
assert.equal("stdout" in reviewArtifact || "stderr" in reviewArtifact, false, "review receipt does not persist unrestricted process output");
assertions++;
assert.match(reviewArtifact.reportSummary, /CLEAN/, "review receipt persists only a bounded verdict summary");
pass(run(["stage", "--job", jobId, "--stage", "awaiting-morning-review", "--summary-file", summaryFile]), "advance to morning review");

const reviewQuestion = path.join(fixtureDir, "review-question.txt");
writeFileSync(reviewQuestion, canonicalMorningReviewQuestion(loadFactorySnapshot(paths).jobs[0]));
const approvedBase = loadFactorySnapshot(paths).jobs[0].baseSha;
const fixtureTree = spawnSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: fixtureRepo, encoding: "utf8" }).stdout.trim();
const movedBaseResult = spawnSync("git", [
  "-c", "user.name=Factory Test",
  "-c", "user.email=factory@example.invalid",
  "commit-tree", fixtureTree, "-p", approvedBase, "-m", "moved main fixture",
], { cwd: fixtureRepo, encoding: "utf8" });
assert.equal(movedBaseResult.status, 0, movedBaseResult.stderr);
let refResult = spawnSync("git", ["update-ref", "refs/remotes/origin/main", movedBaseResult.stdout.trim()], {
  cwd: fixtureRepo,
  encoding: "utf8",
});
assert.equal(refResult.status, 0, refResult.stderr);
const staleMorning = run(["review", "present", "--job", jobId]);
assertions++;
assert.notEqual(staleMorning.status, 0, "morning presentation refuses proof after origin/main moves");
refResult = spawnSync("git", ["update-ref", "refs/remotes/origin/main", approvedBase], {
  cwd: fixtureRepo,
  encoding: "utf8",
});
assert.equal(refResult.status, 0, refResult.stderr);
const morningPresented = run(["review", "present", "--job", jobId]);
pass(morningPresented, "present morning decision");
assertions++;
assert.equal(JSON.parse(morningPresented.stdout).questionText, readFileSync(reviewQuestion, "utf8"), "morning presentation emits only the result-and-proof-derived canonical question");

const snapshot = loadFactorySnapshot(paths);
assertions++;
assert.equal(snapshot.jobs[0].stage, "awaiting-morning-review");
assertions++;
assert.equal(snapshot.jobs[0].evidence.length, 1);
assertions++;
assert.equal(snapshot.jobs[0].evidence.filter((item) => item.verified).length, 1);
assertions++;
assert.equal(snapshot.jobs[0].reviews.filter((item) => item.verdict === "clean").length, 1);
assertions++;
assert.equal(snapshot.jobs[0].evidence.find((item) => item.verified).scriptBodyHash.length, 64);
assertions++;
assert.equal(snapshot.jobs[0].evidence.find((item) => item.verified).repositoryContentHash.length, 64);
assertions++;
assert.equal(snapshot.jobs[0].behaviorSummary, "The supported CLI completed the governed flow.");
assertions++;
assert.match(snapshot.jobs[0].reviewQuestionHash, /^[a-f0-9]{64}$/);
const illegalLive = run(["stage", "--job", jobId, "--stage", "live"]);
assertions++;
assert.notEqual(illegalLive.status, 0, "agent stage command cannot self-label a job live");
const status = run(["status", "--json"]);
pass(status, "read status");
assertions++;
assert.equal(JSON.parse(status.stdout).jobs[0].id, jobId);
assertions++;
assert.equal(status.stdout.includes(sessionId), false, "status JSON does not expose owner or lane session identity");
assertions++;
assert.equal(status.stdout.includes(snapshot.jobs[0].ticketHash), false, "status JSON does not expose ticket hashes");

const reviewed = loadFactorySnapshot(paths);
appendFactoryEvent(paths, {
  type: "job-stage",
  jobId,
  actorTool: "codex",
  sessionId,
  payload: {
    stage: "approved-to-land",
    behaviorSummary: reviewed.jobs[0].behaviorSummary,
    blocker: "",
    ownerReply: "approved",
    ownerDecision: "approve",
    ticketHash: reviewed.jobs[0].ticketHash,
    reviewQuestionHash: reviewed.jobs[0].reviewQuestionHash,
  },
});
let gitResult = spawnSync("git", ["add", "feature.txt"], { cwd: fixtureRepo, encoding: "utf8" });
assert.equal(gitResult.status, 0, gitResult.stderr);
gitResult = spawnSync("git", [
  "-c", "user.name=Factory Test",
  "-c", "user.email=factory@example.invalid",
  "commit", "-qm", "land real governed change",
], { cwd: fixtureRepo, encoding: "utf8" });
assert.equal(gitResult.status, 0, gitResult.stderr);
gitResult = spawnSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: fixtureRepo, encoding: "utf8" });
assert.equal(gitResult.status, 0, gitResult.stderr);
const closeoutArgs = [
  "closeout", "write",
  "--job", jobId,
  "--landing-commit", gitHead(fixtureRepo),
];
writeFileSync(path.join(fixtureRepo, "old.txt"), "old landing content\n");
gitResult = spawnSync("git", ["add", "old.txt"], { cwd: fixtureRepo, encoding: "utf8" });
assert.equal(gitResult.status, 0, gitResult.stderr);
gitResult = spawnSync("git", ["-c", "user.name=Factory Test", "-c", "user.email=factory@example.invalid", "commit", "-qm", "different ancestor"], {
  cwd: fixtureRepo,
  encoding: "utf8",
});
assert.equal(gitResult.status, 0, gitResult.stderr);
const differentAncestor = gitHead(fixtureRepo);
gitResult = spawnSync("git", ["reset", "--soft", "HEAD^"], { cwd: fixtureRepo, encoding: "utf8" });
assert.equal(gitResult.status, 0, gitResult.stderr);
gitResult = spawnSync("git", ["reset"], { cwd: fixtureRepo, encoding: "utf8" });
assert.equal(gitResult.status, 0, gitResult.stderr);
rmSync(path.join(fixtureRepo, "old.txt"));
const wrongLanding = run(closeoutArgs.map((value) => value === gitHead(fixtureRepo) ? differentAncestor : value));
assertions++;
assert.notEqual(wrongLanding.status, 0, "closeout refuses an origin/main ancestor whose content differs from the proven bytes");
writeFileSync(paths.lockPath, `${JSON.stringify({
  pid: process.pid,
  createdAt: new Date().toISOString(),
})}\n`);
const interruptedCloseout = run(closeoutArgs);
assertions++;
assert.notEqual(interruptedCloseout.status, 0, "ledger lock can interrupt closeout after packet creation");
const expectedPacket = path.join(env.CRX_FACTORY_TEST_CLOSEOUT_DIR, `${jobId}.md`);
assertions++;
assert.equal(existsSync(expectedPacket), true, `interrupted closeout leaves its deterministic packet for retry: ${interruptedCloseout.stderr}`);
rmSync(paths.lockPath);
const prepared = run(closeoutArgs);
pass(prepared, "prepare post-landing closeout");
assertions++;
assert.equal(JSON.parse(prepared.stdout).prepared, true, "first closeout pass prepares the durable packet");
const packetText = readFileSync(expectedPacket, "utf8");
for (const requiredPacketText of [
  `Approved base: \`${approvedBase}\``,
  "Pre-closeout ledger checkpoint:",
  "## Independent review manifest",
  "Exact-SHA Production deployment:",
]) {
  assertions++;
  assert.equal(packetText.includes(requiredPacketText), true, `closeout packet records ${requiredPacketText}`);
}
assertions++;
assert.equal(loadFactorySnapshot(paths).jobs[0].stage, "approved-to-land", "packet preparation cannot self-label the job live");
const prematureCloseout = run(closeoutArgs);
assertions++;
assert.notEqual(prematureCloseout.status, 0, "closeout refuses live until the exact packet is contained in origin/main");
gitResult = spawnSync("git", ["add", "docs/audits/factory/jobs"], { cwd: fixtureRepo, encoding: "utf8" });
assert.equal(gitResult.status, 0, gitResult.stderr);
gitResult = spawnSync("git", [
  "-c", "user.name=Factory Test",
  "-c", "user.email=factory@example.invalid",
  "commit", "-qm", "land closeout packet",
], { cwd: fixtureRepo, encoding: "utf8" });
assert.equal(gitResult.status, 0, gitResult.stderr);
gitResult = spawnSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: fixtureRepo, encoding: "utf8" });
assert.equal(gitResult.status, 0, gitResult.stderr);
const closed = run(closeoutArgs);
pass(closed, "finalize landed closeout packet");
const live = loadFactorySnapshot(paths);
assertions++;
assert.equal(live.jobs[0].stage, "live", "successful closeout is the only path to live");
assertions++;
assert.equal(existsSync(JSON.parse(closed.stdout).closeoutPacket), true, "closeout writes a durable packet");
assertions++;
assert.match(live.jobs[0].closeoutCommit, /^[a-f0-9]{40}$/, "live state records the commit containing the closeout packet");
const repeatedCloseout = run(closeoutArgs);
pass(repeatedCloseout, "repeat an already successful closeout");
assertions++;
assert.equal(JSON.parse(repeatedCloseout.stdout).alreadyClosed, true, "successful closeout retry is idempotent");
const conflictingCloseout = run(closeoutArgs.map((value, index) => index === 4 ? differentAncestor : value));
assertions++;
assert.notEqual(conflictingCloseout.status, 0, "idempotent closeout refuses a conflicting landing commit");

appendFactoryEvent(paths, {
  type: "factory-intent",
  jobId: null,
  actorTool: "codex",
  sessionId,
  payload: { ownerRequest: "use the factory" },
});
assertions++;
assert.deepEqual(loadFactorySnapshot(paths).factoryIntentSessions, [sessionId]);
const agentIntentClear = run(["intent", "clear"]);
assertions++;
assert.notEqual(agentIntentClear.status, 0, "factory CLI exposes no agent-runnable intent-clear command");
assertions++;
assert.deepEqual(loadFactorySnapshot(paths).factoryIntentSessions, [sessionId], "agent cannot opt its own chat out of governance");
const agentResume = run(["hold", "--off"]);
assertions++;
assert.notEqual(agentResume.status, 0, "factory CLI exposes no agent-runnable resume command");

console.log(`factory-cli: ${assertions} assertions passed`);
