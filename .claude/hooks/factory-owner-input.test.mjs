#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  appendFactoryEvent,
  buildFactorySnapshot,
  canonicalMorningReviewQuestion,
  hasFactoryIntentFailureLatch,
  resolveFactoryPaths,
  runHarnessEvidence,
  runIndependentReviewEvidence,
  sha256,
  writeImmutableTicket,
} from "../../scripts/factory-state-lib.mjs";
import { gitLocalEnvironmentNames } from "./git-test-env.mjs";

const GIT_REPOSITORY_ENVIRONMENT_NAMES = gitLocalEnvironmentNames();

function sanitizedFixtureGitEnvironment(source = process.env) {
  const env = { ...source };
  for (const name of GIT_REPOSITORY_ENVIRONMENT_NAMES) delete env[name];
  return env;
}

// Git hooks may export repository-local variables to their child processes.
// This test creates and inspects a second repository, so remove that context
// before even the first root/base lookup or any in-process library call.
for (const name of GIT_REPOSITORY_ENVIRONMENT_NAMES) delete process.env[name];

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const hook = path.join(root, ".claude", "hooks", "factory-owner-input.mjs");
const shipHook = path.join(root, ".claude", "hooks", "ship-intent-reminder.mjs");
const laneHook = path.join(root, ".claude", "hooks", "factory-lane-guard.mjs");
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

function addPresentedTicket(paths, sessionId, jobId) {
  const written = writeImmutableTicket(paths, {
    id: jobId,
    version: 1,
    title: "Prove chat approval",
    goal: "Prove exact transcript-bound approval.",
    definitionOfDone: ["Approval is recorded only for the exact question."],
    mustNotChange: ["Production state."],
    allowedPaths: ["src/"],
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
  return { jobId: written.ticket.id, question };
}

function makeState(sessionId = "codex-thread-1", explicitJobId = "") {
  const empty = makeEmptyState(sessionId);
  const { dir, paths } = empty;
  const presented = addPresentedTicket(paths, sessionId, explicitJobId || `job-${path.basename(dir)}`);
  return { dir, paths, ...presented, sessionId };
}

function runHook(state, payload) {
  const projectRoot = state.root || root;
  return spawnSync(process.execPath, [hook], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectRoot,
      CRX_AGENT_SURFACE: "codex",
      CRX_FACTORY_TEST_MODE: "1",
      CRX_FACTORY_TEST_STATE_DIR: state.dir,
      NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT || "factory-owner-input-test",
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
      NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT || "factory-owner-input-test",
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
  ok(
    result.stdout.includes("recorded Mason's exact approval"),
    `exact yes is recorded (stdout=${result.stdout.trim()} stderr=${result.stderr.trim()})`,
  );
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

function runLaneHook(state, payload) {
  return spawnSync(process.execPath, [laneHook], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: root,
      CRX_AGENT_SURFACE: "codex",
      CRX_FACTORY_TEST_MODE: "1",
      CRX_FACTORY_TEST_STATE_DIR: state.dir,
      NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT || "factory-owner-input-test",
    },
    input: JSON.stringify(payload),
  });
}

{
  const state = makeState("original-transfer-thread");
  const result = runHook(state, {
    prompt: `take over factory ticket ${state.jobId} in this chat`,
    thread_id: "new-transfer-thread",
  });
  ok(result.stdout.includes("moved") && result.stdout.includes("revoked"), "explicit owner language transfers a pending ticket through chat");
  const transferred = buildFactorySnapshot(state.paths).jobs[0];
  equal(transferred.sessionId, "new-transfer-thread", "owner-authorized transfer binds the job to the new chat");
  equal(transferred.stage, "needs-ticket-ok", "owner-authorized transfer requires a fresh ticket presentation and approval");
  equal(transferred.questionHash, "", "owner-authorized transfer invalidates the old decision fingerprint");
}

{
  const state = makeState("collision-owner-1", "job-1");
  addPresentedTicket(state.paths, "collision-owner-10", "job-10");
  const result = runHook(state, {
    prompt: "take over factory ticket job-10 in this chat",
    thread_id: "collision-new-thread",
  });
  ok(result.stdout.includes("moved job-10"), "custody transfer matches the complete job ID, not a substring");
  const jobs = buildFactorySnapshot(state.paths).jobs;
  equal(jobs.find((job) => job.id === "job-1").sessionId, "collision-owner-1", "job-1 custody is unchanged");
  equal(jobs.find((job) => job.id === "job-10").sessionId, "collision-new-thread", "job-10 moves to the requested chat");
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
    prompt: "don't pause the factory",
    thread_id: state.sessionId,
  });
  equal(result.stdout, "", "negated pause wording does not activate the factory hold");
  equal(buildFactorySnapshot(state.paths).held, false, "don't-pause leaves the factory running");
  result = runHook(state, {
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
    prompt: "do not resume the factory",
    thread_id: state.sessionId,
  });
  equal(result.stdout, "", "negated resume wording does not clear the factory hold");
  equal(buildFactorySnapshot(state.paths).held, true, "do-not-resume leaves the global hold active");
  result = runHook(state, {
    prompt: "I am not ready to restart the factory",
    thread_id: state.sessionId,
  });
  equal(result.stdout, "", "not-ready-to-restart wording does not clear the factory hold");
  equal(buildFactorySnapshot(state.paths).held, true, "negated restart leaves the global hold active");
  for (const [prompt, label] of [
    ["under no circumstances resume the factory", "no-circumstances"],
    ["I have no plans to resume the factory", "no-plans"],
    ["anything but resume the factory", "anything-but"],
  ]) {
    result = runHook(state, {
      prompt,
      thread_id: state.sessionId,
    });
    ok(!result.stdout.includes("has resumed"), `${label} wording does not report a factory resume`);
    equal(buildFactorySnapshot(state.paths).held, true, `${label} wording leaves the global hold active`);
  }
  result = runHook(state, {
    prompt: "please resume the factory now",
    thread_id: state.sessionId,
  });
  ok(result.stdout.includes("has resumed"), "owner's tightly affirmative plain-English resume is captured");
  equal(buildFactorySnapshot(state.paths).held, false, "only the owner prompt clears the global hold");
}

{
  const state = makeState("secret-hold-thread");
  const secretPrompt = "pause the factory OPENAI_API_KEY=sk-must-never-persist";
  let result = runHook(state, {
    prompt: secretPrompt,
    thread_id: state.sessionId,
  });
  ok(result.stdout.includes("emergency global pause"), "a secret-bearing pause still fails safe into a global hold");
  let snapshot = buildFactorySnapshot(state.paths);
  equal(snapshot.held, true, "secret-bearing pause activates the emergency hold");
  equal(snapshot.holdReason.includes("sk-must-never-persist"), false, "emergency hold reason omits secret text");
  ok(snapshot.holdReason.includes(sha256(secretPrompt)), "emergency hold keeps only the prompt hash for correlation");
  const persisted = [
    readFileSync(state.paths.eventsPath, "utf8"),
    readFileSync(state.paths.emergencyHoldPath, "utf8"),
  ].join("\n");
  equal(persisted.includes("sk-must-never-persist"), false, "neither ledger nor emergency state persists the secret");
  result = runHook(state, {
    prompt: "resume the factory OPENAI_API_KEY=sk-resume-secret",
    thread_id: state.sessionId,
  });
  ok(result.stdout.includes("did not resume"), "a secret-bearing resume changes no factory state");
  snapshot = buildFactorySnapshot(state.paths);
  equal(snapshot.held, true, "secret-bearing resume leaves the emergency hold active");
  equal(JSON.stringify(snapshot).includes("sk-resume-secret"), false, "secret-bearing resume text is not exposed through board state");
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
  const state = makeEmptyState("secret-factory-thread");
  const secretPrompt = "run the factory overnight OPENAI_API_KEY=sk-must-not-persist";
  const rejected = runShipHook(state, {
    prompt: secretPrompt,
    thread_id: state.sessionId,
  });
  equal(rejected.status, 0, "secret-bearing factory intent fails closed without crashing prompt routing");
  ok(hasFactoryIntentFailureLatch(state.paths, state.sessionId), "secret-bearing intent leaves a non-secret fail-closed latch");
  const latchFiles = readdirSync(state.paths.intentLatchesDir);
  equal(latchFiles.length, 1, "secret-bearing intent creates exactly one session latch");
  const latchBytes = readFileSync(path.join(state.paths.intentLatchesDir, latchFiles[0]), "utf8");
  equal(latchBytes.includes("sk-must-not-persist"), false, "failure latch never persists the owner prompt or credential");
  ok(latchBytes.includes(sha256(secretPrompt)), "failure latch stores only the prompt SHA-256 for correlation");
  equal(buildFactorySnapshot(state.paths).factoryIntentSessions.length, 0, "rejected secret text never enters the shared factory ledger");
}

{
  const state = makeEmptyState("latched-factory-thread");
  writeFileSync(state.paths.lockPath, "{\"pid\":999999,\"createdAt\":\"2026-07-30T00:00:00.000Z\"}\n");
  const failed = runShipHook(state, {
    prompt: "run the factory overnight",
    thread_id: state.sessionId,
  });
  equal(failed.status, 0, "ledger contention leaves a durable latch without crashing prompt routing");
  ok(hasFactoryIntentFailureLatch(state.paths, state.sessionId), "failed ledger append leaves a per-session intent latch");
  equal(buildFactorySnapshot(state.paths).factoryIntentSessions.length, 0, "failed append does not invent a ledger intent");
  const deniedWrite = runLaneHook(state, {
    thread_id: state.sessionId,
    tool_name: "Write",
    tool_input: { file_path: path.join(root, "src", "example.ts"), content: "blocked" },
  });
  ok(deniedWrite.stdout.includes("ledger intent could not be recorded"), "intent latch blocks build writes even without a ledger event");
  const deniedFactoryCommand = runLaneHook(state, {
    thread_id: state.sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "node scripts/factory.mjs hold set --reason latched" },
  });
  ok(deniedFactoryCommand.stdout.includes("intent was not recorded"), "intent latch blocks mutating factory commands until recovery and re-submit");
  rmSync(state.paths.lockPath);
  runShipHook(state, {
    prompt: "run the factory overnight",
    thread_id: state.sessionId,
  });
  equal(hasFactoryIntentFailureLatch(state.paths, state.sessionId), false, "successful re-submit clears the failure latch");
  equal(buildFactorySnapshot(state.paths).factoryIntentSessions[0], state.sessionId, "successful re-submit records the governed intent");
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
  const state = makeEmptyState("morning-thread");
  const fixtureRepo = path.join(state.dir, "repo");
  mkdirSync(path.join(fixtureRepo, "src"), { recursive: true });
  writeFileSync(path.join(fixtureRepo, "package.json"), `${JSON.stringify({
    scripts: {
      "verify-deps": "node -e \"process.stdout.write('OWNER_ACCEPTANCE_HARNESS_PASS')\"",
    },
  }, null, 2)}\n`);
  writeFileSync(path.join(fixtureRepo, "src", "result.txt"), "base result\n");
  const fixtureGitEnv = sanitizedFixtureGitEnvironment({
    ...process.env,
    // Reproduce the repository-local variables Git may expose to a pre-commit
    // hook. Fixture commands must never inherit them and mutate the real repo.
    GIT_DIR: path.join(root, ".git"),
    GIT_INDEX_FILE: path.join(root, ".git", "index"),
    GIT_WORK_TREE: root,
  });
  equal(fixtureGitEnv.GIT_DIR, undefined, "fixture Git environment removes inherited repository context");
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "package.json", "src/result.txt"],
    ["-c", "user.name=Factory Test", "-c", "user.email=factory@example.invalid", "commit", "-qm", "base"],
    ["update-ref", "refs/remotes/origin/main", "HEAD"],
  ]) {
    const gitResult = spawnSync("git", args, {
      cwd: fixtureRepo,
      encoding: "utf8",
      env: fixtureGitEnv,
    });
    equal(gitResult.status, 0, gitResult.stderr);
  }
  const fixtureBase = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: fixtureRepo,
    encoding: "utf8",
    env: fixtureGitEnv,
  }).stdout.trim();
  const written = writeImmutableTicket(state.paths, {
    id: "morning-acceptance-job",
    version: 1,
    title: "Bind exact morning result",
    goal: "Keep accepted repository bytes immutable through landing.",
    definitionOfDone: ["Morning acceptance records the exact reviewed repository fingerprint."],
    mustNotChange: ["Anything outside src/result.txt."],
    allowedPaths: ["src/result.txt"],
    proofRequirements: ["Contained harness and independent Sol review."],
    proofHarnesses: ["verify-deps"],
    deliveryGate: "Use existing ship gates.",
    riskAreas: [],
  });
  const ticketQuestion = "Approve exact morning fixture?";
  for (const event of [
    {
      type: "ticket-drafted",
      payload: {
        ticketFile: written.filename,
        ticketHash: written.hash,
        ticketVersion: 1,
        title: written.ticket.title,
      },
    },
    {
      type: "ticket-presented",
      payload: {
        ticketHash: written.hash,
        questionText: ticketQuestion,
        questionHash: sha256(ticketQuestion),
        baseSha: fixtureBase,
      },
    },
    {
      type: "ticket-approved",
      payload: {
        ticketHash: written.hash,
        questionHash: sha256(ticketQuestion),
        ownerReply: "yes",
        baseSha: fixtureBase,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
    {
      type: "lane-started",
      payload: { ticketHash: written.hash, baseSha: fixtureBase, worktree: fixtureRepo },
    },
  ]) {
    appendFactoryEvent(state.paths, {
      ...event,
      jobId: written.ticket.id,
      actorTool: "codex",
      sessionId: state.sessionId,
    });
  }
  writeFileSync(path.join(fixtureRepo, "src", "result.txt"), "reviewed result\n");
  const harness = runHarnessEvidence(state.paths, {
    jobId: written.ticket.id,
    ticketHash: written.hash,
    label: "Owner acceptance harness",
    scriptName: "verify-deps",
    cwd: fixtureRepo,
  });
  appendFactoryEvent(state.paths, {
    type: "evidence-attached",
    jobId: written.ticket.id,
    actorTool: "codex",
    sessionId: state.sessionId,
    payload: harness,
  });
  appendFactoryEvent(state.paths, {
    type: "job-stage",
    jobId: written.ticket.id,
    actorTool: "codex",
    sessionId: state.sessionId,
    payload: { stage: "in-review", behaviorSummary: "", blocker: "" },
  });
  const review = runIndependentReviewEvidence(state.paths, {
    job: buildFactorySnapshot(state.paths).jobs[0],
    cwd: fixtureRepo,
    env: {
      ...process.env,
      CRX_FACTORY_TEST_MODE: "1",
      CRX_FACTORY_TEST_STATE_DIR: state.dir,
    },
  });
  appendFactoryEvent(state.paths, {
    type: "independent-review-attached",
    jobId: written.ticket.id,
    actorTool: "codex",
    sessionId: state.sessionId,
    payload: review,
  });
  appendFactoryEvent(state.paths, {
    type: "job-stage",
    jobId: written.ticket.id,
    actorTool: "codex",
    sessionId: state.sessionId,
    payload: { stage: "awaiting-morning-review", behaviorSummary: "The exact reviewed result is ready.", blocker: "" },
  });
  const reviewedJob = buildFactorySnapshot(state.paths).jobs[0];
  const reviewQuestion = canonicalMorningReviewQuestion(reviewedJob);
  appendFactoryEvent(state.paths, {
    type: "review-presented",
    jobId: written.ticket.id,
    actorTool: "codex",
    sessionId: state.sessionId,
    payload: {
      ticketHash: written.hash,
      questionText: reviewQuestion,
      questionHash: sha256(reviewQuestion),
      baseSha: fixtureBase,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  const transcript = path.join(state.dir, "morning.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ role: "assistant", content: reviewQuestion })}\n`);
  state.root = fixtureRepo;
  const result = runHook(state, {
    prompt: "approved",
    thread_id: state.sessionId,
    transcript_path: transcript,
  });
  ok(result.stdout.includes("approved to enter the existing /ship landing gates"), "morning acceptance is captured in chat");
  const accepted = buildFactorySnapshot(state.paths).jobs[0];
  equal(accepted.stage, "approved-to-land", "morning acceptance does not self-label the job live");
  equal(accepted.acceptedRepositoryContentHash, review.repositoryContentHash, "morning acceptance binds the exact independently reviewed repository hash");
  equal(accepted.acceptedRepositoryFileCount, review.repositoryFileCount, "morning acceptance binds the exact reviewed file count");
}

console.log(`factory-owner-input: ${assertions} assertions passed`);
