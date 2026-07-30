#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  appendFactoryEvent,
  currentOriginMain,
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
const env = {
  ...process.env,
  CRX_FACTORY_TEST_MODE: "1",
  CRX_FACTORY_TEST_STATE_DIR: stateDir,
  CRX_FACTORY_TEST_CLOSEOUT_DIR: path.join(fixtureDir, "closeout"),
};
process.env.CRX_FACTORY_TEST_MODE = "1";
process.env.CRX_FACTORY_TEST_STATE_DIR = stateDir;
const paths = resolveFactoryPaths(root, env);
const sessionId = "cli-thread";
const jobId = "cli-integration-job";
let assertions = 0;

function run(args, identity = { sessionId, actorTool: "codex" }) {
  const readOnly = args[0] === "status";
  const permit = readOnly ? null : mintFactoryCliPermit(paths, identity);
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: {
      ...env,
      ...(permit ? { CRX_FACTORY_PERMIT: permit.token } : {}),
    },
    encoding: "utf8",
  });
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
pass(run(["ticket", "draft", "--file", ticketFile]), "draft ticket");

const questionFile = path.join(fixtureDir, "question.txt");
writeFileSync(questionFile, `Approve ticket ${jobId}?`);
const spoofedIdentity = run([
  "ticket", "present",
  "--job", jobId,
  "--question-file", questionFile,
  "--session", "forged-thread",
  "--tool", "claude",
]);
assertions++;
assert.notEqual(spoofedIdentity.status, 0, "caller-supplied session/tool flags cannot override the trusted permit identity");
const presented = run(["ticket", "present", "--job", jobId, "--question-file", questionFile]);
pass(presented, "present ticket");
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

const proofFile = path.join(fixtureDir, "proof.txt");
writeFileSync(proofFile, "FACTORY_CLI_PROOF_PASS\n");
pass(run(["evidence", "attach", "--job", jobId, "--file", proofFile, "--label", "CLI proof", "--kind", "test"]), "attach evidence");
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
const unverifiedProof = run(["stage", "--job", jobId, "--stage", "awaiting-morning-review", "--summary-file", summaryFile]);
assertions++;
assert.notEqual(unverifiedProof.status, 0, "self-labeled attached file is not enough for morning review");
pass(run(["evidence", "run", "--job", jobId, "--harness", "verify-deps", "--label", "Dependency harness"]), "run repository harness");
pass(run(["stage", "--job", jobId, "--stage", "awaiting-morning-review", "--summary-file", summaryFile]), "advance to morning review");

const reviewQuestion = path.join(fixtureDir, "review-question.txt");
writeFileSync(reviewQuestion, `Accept completed job ${jobId} for the existing ship gates?`);
pass(run(["review", "present", "--job", jobId, "--question-file", reviewQuestion]), "present morning decision");

const snapshot = loadFactorySnapshot(paths);
assertions++;
assert.equal(snapshot.jobs[0].stage, "awaiting-morning-review");
assertions++;
assert.equal(snapshot.jobs[0].evidence.length, 2);
assertions++;
assert.equal(snapshot.jobs[0].evidence.filter((item) => item.verified).length, 1);
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
const productionProof = path.join(fixtureDir, "production-proof.txt");
writeFileSync(productionProof, "Production behavior verified after landing.\n");
const closeoutArgs = [
  "closeout", "write",
  "--job", jobId,
  "--landing-commit", currentOriginMain(root),
  "--production-proof-file", productionProof,
];
writeFileSync(paths.lockPath, `${JSON.stringify({
  pid: process.pid,
  createdAt: new Date().toISOString(),
})}\n`);
const interruptedCloseout = run(closeoutArgs);
assertions++;
assert.notEqual(interruptedCloseout.status, 0, "ledger lock can interrupt closeout after packet creation");
const expectedPacket = path.join(env.CRX_FACTORY_TEST_CLOSEOUT_DIR, `${jobId}.md`);
assertions++;
assert.equal(existsSync(expectedPacket), true, "interrupted closeout leaves its deterministic packet for retry");
rmSync(paths.lockPath);
const closed = run(closeoutArgs);
pass(closed, "write post-landing closeout");
const live = loadFactorySnapshot(paths);
assertions++;
assert.equal(live.jobs[0].stage, "live", "successful closeout is the only path to live");
assertions++;
assert.equal(existsSync(JSON.parse(closed.stdout).closeoutPacket), true, "closeout writes a durable packet");
const repeatedCloseout = run(closeoutArgs);
pass(repeatedCloseout, "repeat an already successful closeout");
assertions++;
assert.equal(JSON.parse(repeatedCloseout.stdout).alreadyClosed, true, "successful closeout retry is idempotent");
const forgedProof = path.join(fixtureDir, "different-production-proof.txt");
writeFileSync(forgedProof, "Different proof must not replace the ledger record.\n");
const conflictingCloseout = run(closeoutArgs.map((value) => value === productionProof ? forgedProof : value));
assertions++;
assert.notEqual(conflictingCloseout.status, 0, "idempotent closeout refuses conflicting proof");

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
