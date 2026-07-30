#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  appendFactoryEvent,
  buildFactorySnapshot,
  resolveFactoryPaths,
  sha256,
  writeImmutableTicket,
} from "../../scripts/factory-state-lib.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const hook = path.join(root, ".claude", "hooks", "factory-owner-input.mjs");
const shipHook = path.join(root, ".claude", "hooks", "ship-intent-reminder.mjs");
const baseSha = spawnSync("git", ["rev-parse", "origin/main"], { cwd: root, encoding: "utf8" }).stdout.trim();
let assertions = 0;

function ok(value, message) {
  assertions++;
  assert.ok(value, message);
}

function equal(actual, expected, message) {
  assertions++;
  assert.equal(actual, expected, message);
}

function makeEmptyState(sessionId = "codex-thread-1") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "crx-factory-owner-"));
  process.env.CRX_FACTORY_TEST_MODE = "1";
  process.env.CRX_FACTORY_TEST_STATE_DIR = dir;
  const paths = resolveFactoryPaths(root, {
    CRX_FACTORY_TEST_MODE: "1",
    CRX_FACTORY_TEST_STATE_DIR: dir,
  });
  return { dir, paths, sessionId };
}

function makeState(sessionId = "codex-thread-1") {
  const empty = makeEmptyState(sessionId);
  const { dir, paths } = empty;
  const written = writeImmutableTicket(paths, {
    id: `job-${path.basename(dir)}`,
    version: 1,
    title: "Prove chat approval",
    goal: "Prove exact transcript-bound approval.",
    definitionOfDone: ["Approval is recorded only for the exact question."],
    mustNotChange: ["Production state."],
    proofRequirements: ["Read the verified event log."],
    proofHarnesses: ["verify-deps"],
    deliveryGate: "Stop before commit.",
    riskAreas: [],
  });
  appendFactoryEvent(paths, {
    type: "ticket-drafted",
    jobId: written.ticket.id,
    actorTool: "codex",
    sessionId,
    payload: {
      ticketFile: written.filename,
      ticketHash: written.hash,
      ticketVersion: 1,
      title: written.ticket.title,
    },
  });
  const question = `Approve ticket ${written.ticket.id}?`;
  appendFactoryEvent(paths, {
    type: "ticket-presented",
    jobId: written.ticket.id,
    actorTool: "codex",
    sessionId,
    payload: {
      ticketHash: written.hash,
      questionText: question,
      questionHash: sha256(question),
      baseSha,
    },
  });
  return { dir, paths, jobId: written.ticket.id, question, sessionId };
}

function runHook(state, payload) {
  return spawnSync(process.execPath, [hook], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: root,
      CRX_AGENT_SURFACE: "codex",
      CRX_FACTORY_TEST_MODE: "1",
      CRX_FACTORY_TEST_STATE_DIR: state.dir,
    },
    input: JSON.stringify(payload),
  });
}

function runShipHook(state, payload) {
  return spawnSync(process.execPath, [shipHook], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: root,
      CRX_AGENT_SURFACE: "codex",
      CRX_FACTORY_TEST_MODE: "1",
      CRX_FACTORY_TEST_STATE_DIR: state.dir,
    },
    input: JSON.stringify(payload),
  });
}

{
  const state = makeState();
  const transcript = path.join(state.dir, "codex-transcript.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "assistant", content: state.question })}\n`);
  const result = runHook(state, {
    prompt: "yes",
    thread_id: state.sessionId,
    transcript_path: transcript,
  });
  equal(result.status, 0, "Codex-shaped payload exits cleanly");
  ok(result.stdout.includes("recorded Mason's exact approval"), "exact yes is recorded");
  const snapshot = buildFactorySnapshot(state.paths);
  equal(snapshot.jobs[0].stage, "queued", "approved ticket enters queue");
  equal(snapshot.jobs[0].approvalReply, "yes", "verbatim owner reply is retained");
  const events = readFileSync(state.paths.eventsPath, "utf8");
  ok(events.includes('"actorTool":"codex"'), "Codex surface provenance is retained");
}

{
  const state = makeState("compound-yes-thread");
  const transcript = path.join(state.dir, "compound-yes.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "assistant", content: state.question })}\n`);
  const result = runHook(state, {
    prompt: "yes, ship it",
    thread_id: state.sessionId,
    transcript_path: transcript,
  });
  ok(result.stdout.includes("recorded Mason's exact approval"), "natural compound yes is recorded");
  equal(buildFactorySnapshot(state.paths).jobs[0].approvalReply, "yes, ship it", "compound approval remains verbatim");
}

{
  const state = makeState("unclear-reply-thread");
  const transcript = path.join(state.dir, "unclear-reply.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "assistant", content: state.question })}\n`);
  const result = runHook(state, {
    prompt: "sounds reasonable",
    thread_id: state.sessionId,
    transcript_path: transcript,
  });
  ok(result.stdout.includes("not an unqualified yes or no"), "unclear decision reply explains why it did not bind");
  equal(buildFactorySnapshot(state.paths).jobs[0].stage, "needs-ticket-ok", "unclear decision reply remains fail-closed");
}

{
  const state = makeState("side-question-thread");
  const transcript = path.join(state.dir, "side-question.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ role: "assistant", content: "Should I also update the docs?" })}\n`);
  const result = runHook(state, {
    prompt: "yes",
    session_id: state.sessionId,
    transcript_path: transcript,
  });
  ok(result.stdout.includes("immediately preceding assistant message"), "yes to a side question is refused");
  equal(buildFactorySnapshot(state.paths).jobs[0].stage, "needs-ticket-ok", "side-question yes does not advance");
}

{
  const state = makeState("original-thread");
  const transcript = path.join(state.dir, "other-thread.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ role: "assistant", content: state.question })}\n`);
  const result = runHook(state, {
    prompt: "approved",
    thread_id: "different-thread",
    transcript_path: transcript,
  });
  ok(result.stdout.includes("belongs to another chat/tool"), "cross-session approval asks for re-presentation");
  equal(buildFactorySnapshot(state.paths).jobs[0].stage, "needs-ticket-ok", "cross-session reply does not advance");
}

{
  const state = makeState("qualified-thread");
  const transcript = path.join(state.dir, "qualified.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ role: "assistant", content: state.question })}\n`);
  const result = runHook(state, {
    prompt: "yes, but don't touch billing",
    session_id: state.sessionId,
    transcript_path: transcript,
  });
  ok(result.stdout.includes("revision request"), "qualified yes becomes a revision request");
  equal(buildFactorySnapshot(state.paths).jobs[0].stage, "rejected", "qualified yes never becomes approval");
}

{
  const state = makeState("missing-transcript");
  const result = runHook(state, {
    prompt: "yes",
    thread_id: state.sessionId,
  });
  ok(result.stdout.includes("immediately preceding assistant message"), "missing transcript fails closed");
  equal(buildFactorySnapshot(state.paths).jobs[0].stage, "needs-ticket-ok", "missing transcript does not advance");
}

{
  const state = makeState("machine-thread");
  const result = runHook(state, {
    prompt: "<task-notification>yes</task-notification>",
    thread_id: state.sessionId,
  });
  equal(result.stdout, "", "machine-generated prompt stays silent");
  equal(buildFactorySnapshot(state.paths).jobs[0].stage, "needs-ticket-ok", "machine prompt does not advance");
}

{
  const state = makeState("hold-thread");
  let result = runHook(state, {
    prompt: "pause the factory",
    thread_id: state.sessionId,
  });
  ok(result.stdout.includes("globally paused"), "plain-English global hold is captured");
  equal(buildFactorySnapshot(state.paths).held, true, "hold latch is active");
  result = runHook(state, {
    prompt: "restart the factory board",
    thread_id: state.sessionId,
  });
  equal(result.stdout, "", "restarting only the board does not resume the factory");
  equal(buildFactorySnapshot(state.paths).held, true, "board wording leaves the global hold active");
  result = runHook(state, {
    prompt: "let's continue the factory work tomorrow",
    thread_id: state.sessionId,
  });
  equal(result.stdout, "", "future factory work does not count as an immediate resume command");
  equal(buildFactorySnapshot(state.paths).held, true, "ambiguous continue wording leaves the global hold active");
  result = runHook(state, {
    prompt: "resume the factory",
    thread_id: state.sessionId,
  });
  ok(result.stdout.includes("has resumed"), "owner's plain-English resume is captured");
  equal(buildFactorySnapshot(state.paths).held, false, "only the owner prompt clears the global hold");
}

{
  const state = makeEmptyState("natural-factory-thread");
  const result = runShipHook(state, {
    prompt: "run the factory overnight on these jobs",
    thread_id: state.sessionId,
  });
  ok(result.stdout.includes("FACTORY-MANAGED REQUEST"), "natural factory request injects governed routing");
  equal(buildFactorySnapshot(state.paths).factoryIntentSessions.length, 1, "natural factory request records one shared intent");
  equal(buildFactorySnapshot(state.paths).factoryIntentSessions[0], state.sessionId, "natural factory request binds intent to the owner chat");
  const cleared = runHook(state, {
    prompt: "never mind the factory, use the normal workflow instead",
    thread_id: state.sessionId,
  });
  ok(cleared.stdout.includes("recorded Mason's request"), "owner chat can leave factory mode before a ticket exists");
  equal(buildFactorySnapshot(state.paths).factoryIntentSessions.length, 0, "owner-bound intent clear restores the normal workflow");
}

{
  const state = makeEmptyState("factory-question-thread");
  const result = runShipHook(state, {
    prompt: "explain an autonomous factory to me",
    thread_id: state.sessionId,
  });
  equal(result.stdout, "", "factory discussion without execution intent stays advisory-free");
  equal(buildFactorySnapshot(state.paths).factoryIntentSessions.length, 0, "factory discussion does not govern the chat");
}

{
  const state = makeState("morning-thread");
  appendFactoryEvent(state.paths, {
    type: "ticket-approved",
    jobId: state.jobId,
    actorTool: "codex",
    sessionId: state.sessionId,
    payload: {
      ticketHash: buildFactorySnapshot(state.paths).jobs[0].ticketHash,
      questionHash: sha256(state.question),
      ownerReply: "yes",
      baseSha,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  appendFactoryEvent(state.paths, {
    type: "lane-started",
    jobId: state.jobId,
    actorTool: "codex",
    sessionId: state.sessionId,
    payload: { ticketHash: buildFactorySnapshot(state.paths).jobs[0].ticketHash, baseSha, worktree: root },
  });
  appendFactoryEvent(state.paths, {
    type: "job-stage",
    jobId: state.jobId,
    actorTool: "codex",
    sessionId: state.sessionId,
    payload: { stage: "awaiting-morning-review", behaviorSummary: "The behavior proof passed.", blocker: "" },
  });
  const reviewQuestion = `Accept completed job ${state.jobId} for the existing ship gates?`;
  appendFactoryEvent(state.paths, {
    type: "review-presented",
    jobId: state.jobId,
    actorTool: "codex",
    sessionId: state.sessionId,
    payload: {
      questionText: reviewQuestion,
      questionHash: sha256(reviewQuestion),
      baseSha,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  const transcript = path.join(state.dir, "morning.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ role: "assistant", content: reviewQuestion })}\n`);
  const result = runHook(state, {
    prompt: "approved",
    thread_id: state.sessionId,
    transcript_path: transcript,
  });
  ok(result.stdout.includes("approved to enter the existing /ship landing gates"), "morning acceptance is captured in chat");
  equal(buildFactorySnapshot(state.paths).jobs[0].stage, "approved-to-land", "morning acceptance does not self-label the job live");
}

console.log(`factory-owner-input: ${assertions} assertions passed`);
