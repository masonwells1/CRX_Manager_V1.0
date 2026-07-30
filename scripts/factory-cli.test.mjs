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
  resolveFactoryPaths,
} from "./factory-state-lib.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
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

function run(args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env,
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
pass(run(["ticket", "draft", "--file", ticketFile, "--session", sessionId, "--tool", "codex"]), "draft ticket");

const questionFile = path.join(fixtureDir, "question.txt");
writeFileSync(questionFile, `Approve ticket ${jobId}?`);
const presented = run(["ticket", "present", "--job", jobId, "--question-file", questionFile, "--session", sessionId, "--tool", "codex"]);
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
pass(run(["lane", "start", "--job", jobId, "--session", sessionId, "--tool", "codex"]), "start lane");

const proofFile = path.join(fixtureDir, "proof.txt");
writeFileSync(proofFile, "FACTORY_CLI_PROOF_PASS\n");
pass(run(["evidence", "attach", "--job", jobId, "--file", proofFile, "--label", "CLI proof", "--kind", "test", "--session", sessionId, "--tool", "codex"]), "attach evidence");
const crossSessionEvidence = run(["evidence", "run", "--job", jobId, "--harness", "verify-deps", "--label", "Wrong session", "--session", "other-thread", "--tool", "claude"]);
assertions++;
assert.notEqual(crossSessionEvidence.status, 0, "another session cannot attach lane proof");
const inventedHarness = run(["evidence", "run", "--job", jobId, "--harness", "check:agent-guidance", "--label", "Invented proof", "--session", sessionId, "--tool", "codex"]);
assertions++;
assert.notEqual(inventedHarness.status, 0, "non-ticket/non-allowlisted harness is refused");
const summaryFile = path.join(fixtureDir, "summary.txt");
writeFileSync(summaryFile, "The supported CLI completed the governed flow.");
pass(run(["stage", "--job", jobId, "--stage", "verifying", "--session", sessionId, "--tool", "codex"]), "advance to verification");
pass(run(["stage", "--job", jobId, "--stage", "in-review", "--session", sessionId, "--tool", "codex"]), "advance to review");
const unverifiedProof = run(["stage", "--job", jobId, "--stage", "awaiting-morning-review", "--summary-file", summaryFile, "--session", sessionId, "--tool", "codex"]);
assertions++;
assert.notEqual(unverifiedProof.status, 0, "self-labeled attached file is not enough for morning review");
pass(run(["evidence", "run", "--job", jobId, "--harness", "verify-deps", "--label", "Dependency harness", "--session", sessionId, "--tool", "codex"]), "run repository harness");
pass(run(["stage", "--job", jobId, "--stage", "awaiting-morning-review", "--summary-file", summaryFile, "--session", sessionId, "--tool", "codex"]), "advance to morning review");

const reviewQuestion = path.join(fixtureDir, "review-question.txt");
writeFileSync(reviewQuestion, `Accept completed job ${jobId} for the existing ship gates?`);
pass(run(["review", "present", "--job", jobId, "--question-file", reviewQuestion, "--session", sessionId, "--tool", "codex"]), "present morning decision");

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
assert.equal(snapshot.jobs[0].behaviorSummary, "The supported CLI completed the governed flow.");
assertions++;
assert.match(snapshot.jobs[0].reviewQuestionHash, /^[a-f0-9]{64}$/);
const illegalLive = run(["stage", "--job", jobId, "--stage", "live", "--session", sessionId, "--tool", "codex"]);
assertions++;
assert.notEqual(illegalLive.status, 0, "agent stage command cannot self-label a job live");
const status = run(["status", "--json"]);
pass(status, "read status");
assertions++;
assert.equal(JSON.parse(status.stdout).jobs[0].id, jobId);

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
  "--session", sessionId,
  "--tool", "codex",
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
const agentIntentClear = run(["intent", "clear", "--session", sessionId, "--tool", "codex"]);
assertions++;
assert.notEqual(agentIntentClear.status, 0, "factory CLI exposes no agent-runnable intent-clear command");
assertions++;
assert.deepEqual(loadFactorySnapshot(paths).factoryIntentSessions, [sessionId], "agent cannot opt its own chat out of governance");
const agentResume = run(["hold", "--off", "--session", sessionId, "--tool", "codex"]);
assertions++;
assert.notEqual(agentResume.status, 0, "factory CLI exposes no agent-runnable resume command");

console.log(`factory-cli: ${assertions} assertions passed`);
