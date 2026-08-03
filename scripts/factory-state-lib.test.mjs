#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  APPROVAL_TTL_MS,
  appendFactoryControlEvent,
  appendFactoryEvent,
  buildFactorySnapshot,
  buildFactoryReviewExecArgs,
  canonicalMorningReviewQuestion,
  canonicalTicketApprovalQuestion,
  canonicalJson,
  consumeFactoryCliPermit,
  FACTORY_AUTHORITY_MODEL,
  FACTORY_AUTHORITY_NOTICE,
  FACTORY_REVIEW_TOKEN,
  factoryChangeRequiresHighRiskControls,
  factoryIndependentReviewPrompt,
  factoryReviewVerdict,
  independentReviewerEnvironment,
  factoryHarnessDependencyHashForCommit,
  factoryHarnessSandboxArgs,
  loadFactorySnapshot,
  mintFactoryCliPermit,
  normalizeTicket,
  readTicket,
  readEventLog,
  recoverFactoryState,
  rejectSecretBearingText,
  repositoryCommitFingerprint,
  repositoryContentFingerprint,
  resolveFactoryPaths,
  resolveHookFactoryPaths,
  runAndAttachHarnessEvidence,
  runHarnessEvidence,
  setEmergencyFactoryHold,
  clearEmergencyFactoryHold,
  sha256,
  ticketHash,
  validateCurrentHarnessEvidence,
  validateCurrentIndependentReview,
  validateLaneStart,
  validateRepositoryScope,
  validateStageChange,
  writeImmutableTicket,
} from "./factory-state-lib.mjs";

import { gitLocalEnvironmentNames } from "../.claude/hooks/git-test-env.mjs";

const pendingFixtureCleanups = new Set();
process.on("exit", () => {
  for (const cleanup of pendingFixtureCleanups) {
    try {
      cleanup();
    } catch {
      // Best-effort cleanup must not hide the test failure that triggered exit.
    }
  }
});

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
  ok(!args.some((item) => item.includes("/git-common") || item.startsWith("GIT_DIR=") || item.startsWith("GIT_COMMON_DIR=")), "branch-controlled harness code cannot see the shared Git directory");
  ok(!args.some((item) => item.includes("type=volume") && item.includes("node_modules")), "production harness dependencies stay inside the immutable image layer");
  ok(!args.some((item) => /OPENAI|SUPABASE|VERCEL|GITHUB|TOKEN|KEY/i.test(item)), "production harness arguments do not forward credential-bearing environment names");
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "crx-factory-state-"));
  const previousTestMode = process.env.CRX_FACTORY_TEST_MODE;
  const previousStateDir = process.env.CRX_FACTORY_TEST_STATE_DIR;
  const env = { CRX_FACTORY_TEST_MODE: "1", CRX_FACTORY_TEST_STATE_DIR: path.join(root, "state") };
  process.env.CRX_FACTORY_TEST_MODE = "1";
  process.env.CRX_FACTORY_TEST_STATE_DIR = env.CRX_FACTORY_TEST_STATE_DIR;
  const paths = resolveFactoryPaths(root, env);
  let active = true;
  const cleanup = () => {
    if (!active) return;
    active = false;
    pendingFixtureCleanups.delete(cleanup);
    if (previousTestMode === undefined) delete process.env.CRX_FACTORY_TEST_MODE;
    else process.env.CRX_FACTORY_TEST_MODE = previousTestMode;
    if (previousStateDir === undefined) delete process.env.CRX_FACTORY_TEST_STATE_DIR;
    else process.env.CRX_FACTORY_TEST_STATE_DIR = previousStateDir;
    rmSync(root, { recursive: true, force: true });
  };
  pendingFixtureCleanups.add(cleanup);
  return { root, env, paths, cleanup };
}

function holdFactoryFence(target, delayMs = 500) {
  const child = spawn(process.execPath, [
    "-e",
    "const fs=require('node:fs');const target=process.argv[1];const delay=Number(process.argv[2]);const fd=fs.openSync(target,'wx');fs.writeSync(fd,JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()})+'\\n');fs.closeSync(fd);setTimeout(()=>fs.unlinkSync(target),delay);",
    target,
    String(delayMs),
  ], { stdio: "ignore" });
  const deadline = Date.now() + 5_000;
  while (!existsSync(target) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  ok(existsSync(target), "the test helper acquired the emergency-hold fence");
  return child;
}

function capturedChild(child) {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve) => child.once("close", (status) => resolve({ status, stdout, stderr })));
}

function waitForPath(target, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(target) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  ok(existsSync(target), label);
}

function ticket(id = "factory-test-1", overrides = {}) {
  return {
    id,
    version: 1,
    title: "Protect invoice totals",
    goal: "Show the correct business result.",
    definitionOfDone: ["The behavior runs and is observed."],
    mustNotChange: ["Inventory quantities stay unchanged."],
    allowedPaths: ["src/"],
    proofRequirements: ["Attach command output and a screenshot."],
    proofHarnesses: ["verify-deps"],
    deliveryGate: "Stop before commit.",
    riskAreas: ["money"],
    businessExample: "$500 split 50/50 shows $250 and $250.",
    forbiddenOutcome: "The split may not total more or less than $500.",
    ...overrides,
  };
}

{
  const normalizedTicket = normalizeTicket(ticket());
  eq(FACTORY_AUTHORITY_MODEL, "coordination-only-v1", "factory authority model is explicit and versioned");
  ok(
    canonicalTicketApprovalQuestion(normalizedTicket).includes(FACTORY_AUTHORITY_NOTICE),
    "ticket approval states that coordination never grants new authority",
  );
  ok(
    canonicalMorningReviewQuestion({
      id: normalizedTicket.id,
      title: normalizedTicket.title,
      ticket: normalizedTicket,
      ticketHash: ticketHash(normalizedTicket),
      behaviorSummary: "The proved behavior matches the ticket.",
      evidence: [{ verified: true, kind: "harness", label: "Harness", scriptName: "verify-deps", sha256: "a".repeat(64) }],
      reviews: [{ verdict: "clean", reviewer: "codex", model: "gpt-5.6-sol", reasoningEffort: "high", sha256: "b".repeat(64), repositoryContentHash: "c".repeat(64), repositoryFileCount: 1 }],
    }).includes(FACTORY_AUTHORITY_NOTICE),
    "morning acceptance states that coordination never grants new authority",
  );
  const reviewPrompt = factoryIndependentReviewPrompt({
    id: normalizedTicket.id,
    title: normalizedTicket.title,
    ticketHash: ticketHash(normalizedTicket),
    ticket: normalizedTicket,
    baseSha: "b".repeat(40),
  });
  ok(reviewPrompt.includes(canonicalJson(normalizedTicket)), "independent reviewer receives the complete canonical approved ticket unchanged");
  ok(reviewPrompt.includes(ticketHash(normalizedTicket)), "independent reviewer receives the exact approved ticket hash");
  ok(reviewPrompt.includes("Do not trust the ticket's riskAreas as complete"), "independent reviewer enforces CRX red lines independently of ticket labels");
  ok(
    factoryChangeRequiresHighRiskControls(
      ["src/components/Feature.tsx"],
      "await supabase.from('profiles').update({ role: 'admin' })",
    ),
    "content-level permission writes are automatically high-risk even under an ordinary path",
  );
  eq(
    factoryChangeRequiresHighRiskControls(["src/components/EmptyState.tsx"], "render an empty state"),
    false,
    "ordinary UI prose is not automatically high-risk",
  );
  ok(
    factoryChangeRequiresHighRiskControls([".gitattributes"], "*.ts binary"),
    "Git attribute changes cannot hide content from automatic risk classification",
  );
  const reviewerEnv = independentReviewerEnvironment({
    ...process.env,
    OPENAI_API_KEY: "must-not-pass",
    SUPABASE_SERVICE_ROLE_KEY: "must-not-pass",
    GITHUB_TOKEN: "must-not-pass",
  });
  eq(reviewerEnv.OPENAI_API_KEY, undefined, "independent reviewer does not inherit OpenAI API keys");
  eq(reviewerEnv.SUPABASE_SERVICE_ROLE_KEY, undefined, "independent reviewer does not inherit Supabase credentials");
  eq(reviewerEnv.GITHUB_TOKEN, undefined, "independent reviewer does not inherit GitHub tokens");
  const reviewArgs = buildFactoryReviewExecArgs({
    root: repoRoot,
    prompt: reviewPrompt,
  });
  ok(reviewArgs.includes("--ephemeral"), "independent reviewer leaves no Codex session transcript");
  ok(reviewArgs.includes("--ignore-user-config"), "independent reviewer does not load credentialed plugins or MCP configuration");
  ok(reviewArgs.includes("gpt-5.6-sol"), "isolated independent reviewer keeps the explicitly recorded model");
  ok(reviewArgs.includes('model_reasoning_effort="high"'), "all factory adversarial review runs Sol at explicit high effort");
  assert.equal(reviewArgs[reviewArgs.indexOf("--disable") + 1], "hooks", "independent reviewer cannot load branch-controlled project hooks");
  throws(
    () => normalizeTicket(ticket("escaping-ticket", { allowedPaths: ["../outside"] })),
    /literal repository-relative/,
    "ticket path scope rejects traversal",
  );
  throws(
    () => normalizeTicket(ticket("underclassified-migration", {
      allowedPaths: ["supabase/migrations/"],
      riskAreas: [],
      businessExample: "",
      forbiddenOutcome: "",
    })),
    /riskAreas must declare/i,
    "high-risk allowed paths cannot be approved under a self-declared low-risk ticket",
  );
}

throws(
  () => normalizeTicket(ticket("secret-ticket", {
    goal: "Use eyJabcdefghijk.abcdefghijklmnop.abcdefghijklmnop",
  })),
  /credential or secret/,
  "secret-shaped ticket fields are rejected before ticket persistence",
);

{
  const { root, paths, cleanup } = fixture();
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
  cleanup();
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
  const { root, paths, cleanup } = fixture();
  const issued = mintFactoryCliPermit(paths, {
    sessionId: "trusted-session",
    actorTool: "codex",
    expectedLastEventHash: "0".repeat(64),
    nowMs: 1_000,
  });
  eq(
    consumeFactoryCliPermit(paths, issued.token, { nowMs: 2_000 }),
    { sessionId: "trusted-session", actorTool: "codex", expectedLastEventHash: "0".repeat(64) },
    "one-time CLI permit returns hook-bound identity and ledger checkpoint",
  );
  throws(
    () => consumeFactoryCliPermit(paths, issued.token, { nowMs: 2_001 }),
    /missing, expired, or already consumed/,
    "consumed CLI permit cannot be replayed",
  );
  const expired = mintFactoryCliPermit(paths, {
    sessionId: "trusted-session",
    actorTool: "codex",
    expectedLastEventHash: "0".repeat(64),
    nowMs: 1_000,
  });
  throws(
    () => consumeFactoryCliPermit(paths, expired.token, { nowMs: 60_000 }),
    /expired before use/,
    "expired CLI permit is refused",
  );
  cleanup();
}

{
  const { root, paths, cleanup } = fixture();
  const written = writeImmutableTicket(paths, ticket("custody-replay"));
  append(paths, "ticket-drafted", written.ticket.id, {
    ticketFile: written.filename,
    ticketHash: written.hash,
    ticketVersion: 1,
    title: written.ticket.title,
  }, { sessionId: "owning-session" });
  append(paths, "ticket-presented", written.ticket.id, {
    ticketHash: written.hash,
    questionText: "Approve?",
    questionHash: "a".repeat(64),
    baseSha: "b".repeat(40),
  }, { sessionId: "other-session" });
  throws(
    () => loadFactorySnapshot(paths),
    /crossed factory session custody/,
    "ledger replay rejects cross-session ticket takeover even if a forged event reaches disk",
  );
  cleanup();
}

{
  const { root, paths, cleanup } = fixture();
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
  cleanup();
}

{
  const { root, paths, cleanup } = fixture();
  const written = writeImmutableTicket(paths, ticket());
  eq(written.hash, ticketHash(written.ticket), "ticket hash binds canonical bytes");
  ok(readFileSync(written.fullPath, "utf8").endsWith("\n"), "immutable ticket is newline-terminated");
  writeFileSync(written.fullPath, readFileSync(written.fullPath, "utf8").replace(/\n/g, "\r\n"));
  eq(readTicket(paths, written.filename).hash, written.hash, "ticket verification hashes canonical LF bytes on every platform");
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
  append(paths, "lane-started", written.ticket.id, {
    ticketHash: written.hash,
    baseSha: "a".repeat(40),
    worktree: root,
  });
  append(paths, "evidence-attached", written.ticket.id, {
    label: "old proof",
    kind: "harness",
    filename: "old-proof.json",
    sha256: "1".repeat(64),
    verified: true,
    ticketHash: written.hash,
  });
  append(paths, "job-stage", written.ticket.id, {
    stage: "in-review",
    behaviorSummary: "",
    blocker: "",
  });
  append(paths, "independent-review-attached", written.ticket.id, {
    reviewer: "codex",
    model: "gpt-5.6-sol",
    verdict: "clean",
    filename: "old-review.json",
    sha256: "2".repeat(64),
    ticketHash: written.hash,
  });
  append(paths, "job-stage", written.ticket.id, {
    stage: "parked",
    behaviorSummary: "",
    blocker: "Mason requested a changed scope.",
  });
  append(paths, "job-stage", written.ticket.id, {
    stage: "parked",
    behaviorSummary: "A legacy duplicate terminal event must not replace the first parked summary.",
    blocker: "Legacy duplicate terminal event.",
  });
  const parkedSnapshot = loadFactorySnapshot(paths);
  eq(parkedSnapshot.jobs[0].stage, "parked", "a same-lane duplicate terminal parking event replays as a metadata refresh");
  eq(parkedSnapshot.jobs[0].blocker, "Legacy duplicate terminal event.", "a same-lane terminal metadata refresh preserves the latest blocker");
  eq(
    validateStageChange(parkedSnapshot, written.ticket.id, "parked", {
      sessionId: "session-1",
      behaviorSummary: "The completed investigation is preserved for follow-up.",
      blocker: "The reviewed design needs a new mission ticket before implementation.",
    }).id,
    written.ticket.id,
    "the original lane session may refresh parked Board metadata without reopening the job",
  );
  throws(
    () => validateStageChange(parkedSnapshot, written.ticket.id, "parked", {
      sessionId: "other-session",
      behaviorSummary: "Untrusted replacement summary.",
      blocker: "Untrusted replacement blocker.",
    }),
    /another build session/,
    "another session cannot rewrite parked Board metadata",
  );
  throws(
    () => validateStageChange(parkedSnapshot, written.ticket.id, "parked", {
      sessionId: "session-1",
      behaviorSummary: "",
      blocker: "A blocker without a result summary.",
    }),
    /behavior summary is required/i,
    "parked metadata refresh requires a nonempty behavior result",
  );
  append(paths, "job-stage", written.ticket.id, {
    stage: "parked",
    behaviorSummary: "The completed investigation is preserved for follow-up.",
    blocker: "The reviewed design needs a new mission ticket before implementation.",
  });
  const refreshedParked = loadFactorySnapshot(paths).jobs[0];
  eq(refreshedParked.stage, "parked", "parked metadata refresh cannot reopen or advance a job");
  eq(
    refreshedParked.behaviorSummary,
    "The completed investigation is preserved for follow-up.",
    "parked metadata refresh updates the owner-facing behavior result",
  );
  eq(
    refreshedParked.blocker,
    "The reviewed design needs a new mission ticket before implementation.",
    "parked metadata refresh updates the owner-facing blocker",
  );
  const revisionQuestion = "Approve this exact factory ticket after parking?";
  append(paths, "ticket-presented", written.ticket.id, {
    ticketHash: written.hash,
    questionText: revisionQuestion,
    questionHash: sha256(revisionQuestion),
    baseSha: "a".repeat(40),
  });
  append(paths, "ticket-revision-requested", written.ticket.id, {
    ticketHash: written.hash,
    questionHash: sha256(revisionQuestion),
    ownerReply: "Change the scope.",
    baseSha: "a".repeat(40),
  });
  const revised = writeImmutableTicket(paths, ticket(written.ticket.id, {
    version: 2,
    goal: "Prove a materially revised governed lane.",
  }));
  append(paths, "ticket-drafted", revised.ticket.id, {
    ticketFile: revised.filename,
    ticketHash: revised.hash,
    ticketVersion: 2,
    title: revised.ticket.title,
  });
  const revisedSnapshot = loadFactorySnapshot(paths);
  eq(revisedSnapshot.jobs[0].evidence.length, 0, "a revised ticket cannot inherit earlier harness receipts");
  eq(revisedSnapshot.jobs[0].reviews.length, 0, "a revised ticket cannot inherit an earlier CLEAN review");
  eq(revisedSnapshot.jobs[0].baseSha, "", "a revised ticket requires a fresh base-bound presentation");
  cleanup();
}

{
  const { root, paths, cleanup } = fixture();
  const written = writeImmutableTicket(paths, ticket("receipt-backed-approval"));
  append(paths, "ticket-drafted", written.ticket.id, {
    ticketFile: written.filename,
    ticketHash: written.hash,
    ticketVersion: 1,
    title: written.ticket.title,
  });
  const question = "Approve the receipt-backed ticket?";
  append(paths, "ticket-presented", written.ticket.id, {
    ticketHash: written.hash,
    questionText: question,
    questionHash: sha256(question),
    baseSha: "a".repeat(40),
  });
  append(paths, "ticket-approved", written.ticket.id, {
    ticketHash: written.hash,
    questionHash: sha256(question),
    ownerReply: "yes",
    baseSha: "a".repeat(40),
    expiresAt: new Date(Date.parse("2026-07-30T12:00:00.000Z") + APPROVAL_TTL_MS).toISOString(),
  });
  const approval = readEventLog(paths).events.at(-1);
  ok(Boolean(approval.payload.ownerReceiptId), "owner approval receives an internally minted decision receipt");
  ok(/^[a-f0-9]{64}$/i.test(approval.payload.ownerReceiptMac), "owner approval records a keyed authentication code");
  const ownerKey = readFileSync(paths.ownerReceiptKeyPath);
  rmSync(paths.ownerReceiptKeyPath);
  throws(
    () => loadFactorySnapshot(paths, { nowMs: Date.parse("2026-07-30T13:00:00.000Z") }),
    /hook-origin receipt key is missing/i,
    "a pre-seeded approval ledger and receipt without the hook-origin integrity key fail closed",
  );
  writeFileSync(paths.ownerReceiptKeyPath, ownerKey, { flag: "wx" });
  rmSync(path.join(paths.ownerReceiptsDir, `${approval.payload.ownerReceiptId}.json`));
  throws(
    () => loadFactorySnapshot(paths, { nowMs: Date.parse("2026-07-30T13:00:00.000Z") }),
    /ENOENT|receipt/i,
    "a pre-seeded approval ledger without its hook-origin receipt fails closed during replay",
  );
  cleanup();
}

{
  const { root, paths, cleanup } = fixture();
  throws(
    () => append(paths, "forged-future-event", null, {}),
    /Unsupported factory event type/,
    "unknown ledger event types fail closed before they can affect replay",
  );
  throws(
    () => appendFactoryEvent(paths, {
      type: "factory-intent",
      jobId: null,
      actorTool: "untrusted-tool",
      sessionId: "session-1",
      payload: { ownerRequest: "forge actor" },
    }),
    /trusted Claude or Codex owner surface/,
    "ledger events cannot claim an unknown actor surface",
  );
  cleanup();
}

{
  const { root, paths, cleanup } = fixture();
  setEmergencyFactoryHold(paths, "Mason requested a pause while the ledger was unavailable.");
  eq(buildFactorySnapshot(paths).held, true, "emergency hold blocks work without a ledger append");
  setEmergencyFactoryHold(paths, "OPENAI_API_KEY=sk-emergency-reason-must-not-persist");
  const sanitizedHold = buildFactorySnapshot(paths);
  ok(!sanitizedHold.holdReason.includes("sk-emergency-reason-must-not-persist"), "emergency hold storage sanitizes secret-bearing reasons");
  ok(/Reason SHA-256: [a-f0-9]{64}/.test(sanitizedHold.holdReason), "sanitized emergency holds retain only a reason hash");
  throws(
    () => appendFactoryEvent(paths, {
      type: "factory-intent",
      jobId: null,
      actorTool: "codex",
      sessionId: "session-1",
      payload: { ownerRequest: "must not append across the hold" },
    }, {
      expectedLastEventHash: sanitizedHold.lastEventHash,
      requireFactoryRunning: true,
    }),
    /paused before evidence attachment/,
    "the ledger lock makes the final running-state check atomic with its conditional append",
  );
  eq(buildFactorySnapshot(paths).lastEventHash, sanitizedHold.lastEventHash, "the atomic held-state refusal appends no event");
  clearEmergencyFactoryHold(paths);
  eq(buildFactorySnapshot(paths).held, false, "canonical recovery can clear the emergency hold");

  holdFactoryFence(paths.emergencyHoldFencePath);
  const fencedPauseStartedAt = Date.now();
  setEmergencyFactoryHold(paths, "A pause waits for the in-flight attachment fence.", { ledgerUnavailable: true });
  ok(Date.now() - fencedPauseStartedAt >= 250, "emergency-pause persistence honors the shared attachment fence");
  clearEmergencyFactoryHold(paths);

  holdFactoryFence(paths.emergencyHoldFencePath);
  const fencedAppendStartedAt = Date.now();
  appendFactoryEvent(paths, {
    type: "factory-intent",
    jobId: null,
    actorTool: "codex",
    sessionId: "session-1",
    payload: { ownerRequest: "prove conditional append fencing" },
  }, { requireFactoryRunning: true });
  ok(Date.now() - fencedAppendStartedAt >= 250, "conditional evidence-style append honors the shared emergency-hold fence");

  writeFileSync(paths.emergencyHoldFencePath, `${JSON.stringify({
    pid: 99999999,
    createdAt: new Date(Date.now() - 10_000).toISOString(),
  })}\n`);
  setEmergencyFactoryHold(paths, "A dead fence owner cannot strand an emergency pause.", { ledgerUnavailable: true });
  ok(
    readdirSync(paths.recoveryDir).some((entry) => entry.startsWith("stale-emergency-hold-fence-")),
    "a stale emergency-hold fence is archived before pause persistence continues",
  );
  clearEmergencyFactoryHold(paths);

  writeFileSync(paths.lockPath, `${JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
  })}\n`);
  setEmergencyFactoryHold(paths, "A contended ledger must not drop this pause.", { lockTimeoutMs: 25 });
  eq(buildFactorySnapshot(paths).held, true, "ledger-lock contention falls back to a fail-safe emergency hold");
  rmSync(paths.lockPath);
  clearEmergencyFactoryHold(paths);

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
  cleanup();
}

{
  const { root, paths, cleanup } = fixture();
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
  cleanup();
}

{
  const { paths, cleanup } = fixture();
  append(paths, "factory-held", null, { reason: "initial pause", ownerReply: "pause factory" });
  const heldHash = loadFactorySnapshot(paths).lastEventHash;
  holdFactoryFence(paths.emergencyHoldFencePath);
  const fencedControlStartedAt = Date.now();
  const repeatedHold = appendFactoryControlEvent(paths, {
    type: "factory-held",
    jobId: null,
    actorTool: "codex",
    sessionId: "session-1",
    payload: { reason: "repeat pause", ownerReply: "pause factory" },
  });
  ok(Date.now() - fencedControlStartedAt >= 250, "owner hold/resume transitions honor the shared emergency-hold fence");
  eq(repeatedHold.changed, false, "atomic control transition treats a repeated pause as a no-op");
  eq(loadFactorySnapshot(paths).lastEventHash, heldHash, "atomic repeated pause leaves the ledger hash unchanged");
  const resumed = appendFactoryControlEvent(paths, {
    type: "factory-resumed",
    jobId: null,
    actorTool: "codex",
    sessionId: "session-1",
    payload: { reason: "resume", ownerReply: "resume factory" },
  });
  eq(resumed.changed, true, "atomic control transition records a real resume");
  const pausedAgain = appendFactoryControlEvent(paths, {
    type: "factory-held",
    jobId: null,
    actorTool: "codex",
    sessionId: "session-1",
    payload: { reason: "newer pause", ownerReply: "pause factory" },
  });
  eq(pausedAgain.changed, true, "a pause serialized after a resume is not lost as a stale no-op");
  eq(loadFactorySnapshot(paths).held, true, "the last serialized owner control determines the final hold state");
  cleanup();
}

{
  const { paths, cleanup } = fixture();
  mkdirSync(path.dirname(paths.emergencyHoldFencePath), { recursive: true });
  writeFileSync(paths.emergencyHoldFencePath, `${JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
  })}\n`);
  const startedAt = Date.now();
  const paused = appendFactoryControlEvent(paths, {
    type: "factory-held",
    jobId: null,
    actorTool: "codex",
    sessionId: "session-1",
    payload: { reason: "stuck fence pause", ownerReply: "pause factory" },
  }, { lockTimeoutMs: 25, emergencyFallbackReason: "Stuck-fence fallback test." });
  ok(Date.now() - startedAt < 500, "a live but stuck fence has a bounded wait");
  eq(paused.emergencyFallback, true, "a timed-out pause uses the fail-closed emergency marker");
  eq(buildFactorySnapshot(paths).held, true, "the emergency marker keeps the factory paused after fence timeout");
  throws(
    () => appendFactoryControlEvent(paths, {
      type: "factory-resumed",
      jobId: null,
      actorTool: "codex",
      sessionId: "session-1",
      payload: { reason: "unsafe stuck-fence resume", ownerReply: "resume factory" },
    }, { lockTimeoutMs: 25 }),
    /emergency-hold fence timed out/,
    "a resume cannot clear the fail-closed marker while the coordination fence is stuck",
  );
  rmSync(paths.emergencyHoldFencePath);
  clearEmergencyFactoryHold(paths);
  cleanup();
}

{
  const { root, env, paths, cleanup } = fixture();
  append(paths, "factory-intent", null, { ownerRequest: "prove atomic pause fallback" });
  const checkpoint = loadFactorySnapshot(paths).lastEventHash;
  writeFileSync(paths.lockPath, `${JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
  })}\n`);
  const moduleUrl = new URL("./factory-state-lib.mjs", import.meta.url).href;
  const controlScript = path.join(root, "control-fallback.test.mjs");
  const attachmentScript = path.join(root, "waiting-attachment.test.mjs");
  const attachmentReady = path.join(root, "attachment-ready.txt");
  writeFileSync(controlScript, [
    "const lib = await import(process.argv[2]);",
    "const paths = lib.resolveFactoryPaths(process.argv[3], process.env);",
    "const result = lib.appendFactoryControlEvent(paths, {",
    "  type: 'factory-held', jobId: null, actorTool: 'codex', sessionId: 'session-1',",
    "  payload: { reason: 'contended pause', ownerReply: 'pause factory' },",
    "}, { lockTimeoutMs: 1000, emergencyFallbackReason: 'Atomic fallback contention test.' });",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n"));
  writeFileSync(attachmentScript, [
    "const fs = await import('node:fs');",
    "const lib = await import(process.argv[2]);",
    "const paths = lib.resolveFactoryPaths(process.argv[3], process.env);",
    "fs.writeFileSync(process.argv[4], 'ready');",
    "try {",
    "  lib.appendFactoryEvent(paths, { type: 'factory-intent', jobId: null, actorTool: 'codex', sessionId: 'session-2', payload: { ownerRequest: 'must wait behind pause' } }, { expectedLastEventHash: process.argv[5], requireFactoryRunning: true });",
    "  process.stdout.write('ATTACHED');",
    "} catch (error) { process.stdout.write(`REFUSED:${error.message}`); }",
  ].join("\n"));
  const childEnv = { ...process.env, ...env };
  const controlChild = spawn(process.execPath, [controlScript, moduleUrl, root], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const controlResultPromise = capturedChild(controlChild);
  waitForPath(paths.emergencyHoldFencePath, "the contended owner pause acquires the shared hold fence");
  const attachmentChild = spawn(process.execPath, [attachmentScript, moduleUrl, root, attachmentReady, checkpoint], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const attachmentResultPromise = capturedChild(attachmentChild);
  waitForPath(attachmentReady, "the conditional attachment starts while the owner pause owns the fence");
  waitForPath(paths.emergencyHoldPath, "the failed ledger pause writes its emergency marker before releasing the fence");
  rmSync(paths.lockPath);
  const [controlResult, attachmentResult] = await Promise.all([controlResultPromise, attachmentResultPromise]);
  eq(controlResult.status, 0, `the contended pause falls back successfully: ${controlResult.stderr}`);
  eq(JSON.parse(controlResult.stdout).emergencyFallback, true, "the control transition reports its in-fence emergency fallback");
  eq(attachmentResult.status, 0, `the waiting attachment process exits cleanly: ${attachmentResult.stderr}`);
  ok(/REFUSED:.*paused before evidence attachment/i.test(attachmentResult.stdout), "a waiting attachment observes the marker and cannot cross the failed pause");
  eq(loadFactorySnapshot(paths).lastEventHash, checkpoint, "the failed pause and refused attachment append no ledger event");
  cleanup();
}

{
  const { paths, cleanup } = fixture();
  append(paths, "factory-held", null, { reason: "protect receipt", ownerReply: "pause factory" });
  const hold = readEventLog(paths).events.at(-1);
  rmSync(path.join(paths.ownerReceiptsDir, `${hold.payload.ownerReceiptId}.json`));
  throws(
    () => appendFactoryControlEvent(paths, {
      type: "factory-resumed",
      jobId: null,
      actorTool: "codex",
      sessionId: "session-1",
      payload: { reason: "must fail closed", ownerReply: "resume factory" },
    }),
    /ENOENT|receipt/i,
    "the lock-held control evaluator refuses a hold event whose hook-origin receipt is missing",
  );
  cleanup();
}

{
  const { root, paths, cleanup } = fixture();
  append(paths, "factory-intent", null, { ownerRequest: "x" });
  const original = readFileSync(paths.eventsPath, "utf8");
  const event = JSON.parse(original.trim());
  event.payload.ownerRequest = "tampered";
  writeFileSync(paths.eventsPath, `${canonicalJson(event)}\n`, "utf8");
  throws(() => readEventLog(paths), /Event hash mismatch/, "tampered event is rejected");
  cleanup();
}

{
  const { root, paths, cleanup } = fixture();
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
  cleanup();
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
  const scopedJob = {
    baseSha: initialCommit.commitSha,
    ticket: { allowedPaths: ["source.txt"] },
  };
  eq(
    validateRepositoryScope(scopedJob, fingerprintRepo, { requireCleanBase: true }).length,
    0,
    "factory lane starts only from a clean checkout at the approved base",
  );
  eq(initialCommit.repositoryContentHash, before.repositoryContentHash, "commit fingerprint matches identical working-tree bytes");
  try {
    symlinkSync("missing-target.txt", path.join(fingerprintRepo, "dangling-link.txt"));
    const dangling = repositoryContentFingerprint(fingerprintRepo);
    ok(dangling.repositoryContentHash !== before.repositoryContentHash, "working-tree proof includes dangling symlink target text");
    rmSync(path.join(fingerprintRepo, "dangling-link.txt"));
  } catch (error) {
    if (!new Set(["EPERM", "EACCES", "UNKNOWN"]).has(error?.code)) throw error;
  }
  writeFileSync(path.join(fingerprintRepo, "source.txt"), "after\n");
  eq(
    validateRepositoryScope(scopedJob, fingerprintRepo).join(","),
    "source.txt",
    "current changes inside the approved ticket scope are accepted",
  );
  throws(
    () => validateRepositoryScope(scopedJob, fingerprintRepo, { requireCleanBase: true }),
    /clean checkout exactly at the approved/i,
    "lane start rejects a dirty checkout even when the dirty path would be in scope",
  );
  writeFileSync(path.join(fingerprintRepo, "unrelated.txt"), "unrelated\n");
  throws(
    () => validateRepositoryScope(scopedJob, fingerprintRepo),
    /outside the approved ticket paths.*unrelated\.txt/i,
    "review rejects pre-existing or untracked changes outside the ticket scope",
  );
  rmSync(path.join(fingerprintRepo, "unrelated.txt"));
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
  execFileSync("git", ["update-index", "--chmod=+x", "source.txt"], { cwd: fingerprintRepo, stdio: "ignore" });
  const executableWorkingTree = repositoryContentFingerprint(fingerprintRepo);
  ok(
    executableWorkingTree.repositoryContentHash !== committed.repositoryContentHash,
    "working-tree proof changes when the Git executable mode changes without content changes",
  );
  execFileSync("git", ["-c", "user.name=Factory Test", "-c", "user.email=factory@example.invalid", "commit", "-m", "mode-only"], {
    cwd: fingerprintRepo,
    stdio: "ignore",
  });
  const executableCommit = repositoryCommitFingerprint(fingerprintRepo, "HEAD");
  eq(
    executableCommit.repositoryContentHash,
    executableWorkingTree.repositoryContentHash,
    "landing commit and working-tree fingerprints bind the same mode plus blob identity",
  );
  ok(
    executableCommit.repositoryContentHash !== landed.repositoryContentHash,
    "mode-only landing changes cannot reuse a prior exact-content proof",
  );
  rmSync(fingerprintRepo, { recursive: true, force: true });
}

{
  const { root, paths, cleanup } = fixture();
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
  mkdirSync(paths.permitsDir, { recursive: true });
  process.env.FACTORY_MUTATE_TARGET = path.join(paths.permitsDir, "forged.txt");
  throws(
    () => runHarnessEvidence(paths, {
      jobId: "state-mutation-proof",
      ticketHash: "a".repeat(64),
      label: "must fail",
      scriptName: "verify-deps",
      cwd: harnessRepo,
    }),
    /factory is held for review/,
    "trusted harness broker detects an unexpected file inside the mutable permits directory",
  );
  ok(existsSync(paths.emergencyHoldPath), "indirect harness mutation creates an emergency hold");
  clearEmergencyFactoryHold(paths);
  append(paths, "factory-held", null, { reason: "create the owner receipt key", ownerReply: "pause factory" });
  process.env.FACTORY_MUTATE_TARGET = paths.ownerReceiptKeyPath;
  throws(
    () => runHarnessEvidence(paths, {
      jobId: "owner-key-mutation-proof",
      ticketHash: "b".repeat(64),
      label: "must protect owner key",
      scriptName: "verify-deps",
      cwd: harnessRepo,
    }),
    /factory is held for review/,
    "trusted harness broker detects replacement of the owner receipt authentication key",
  );
  ok(existsSync(paths.emergencyHoldPath), "owner receipt key mutation creates an emergency hold");
  delete process.env.FACTORY_MUTATE_TARGET;
  rmSync(harnessRepo, { recursive: true, force: true });
  cleanup();
}

{
  const { paths, cleanup } = fixture();
  const harnessRepo = mkdtempSync(path.join(tmpdir(), "crx-factory-harness-content-addressed-"));
  writeFileSync(path.join(harnessRepo, "package.json"), `${JSON.stringify({
    scripts: {
      "verify-deps": "node -e \"process.stdout.write('ORPHAN_RECOVERY_PASS')\"",
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
  const evidenceArgs = {
    jobId: "orphan-recovery-proof",
    ticketHash: "b".repeat(64),
    label: "content-addressed retry",
    scriptName: "verify-deps",
    cwd: harnessRepo,
    capturedAt: "2026-08-02T15:00:00.000Z",
  };
  const first = runHarnessEvidence(paths, evidenceArgs);
  const repeated = runHarnessEvidence(paths, evidenceArgs);
  eq(first.createdArtifact, true, "the first harness persistence creates its content-addressed artifact");
  eq(repeated.createdArtifact, false, "an exact byte-identical artifact write is idempotent");
  eq(repeated.sha256, first.sha256, "content-addressed idempotence requires the same complete byte identity");
  eq(repeated.filename, first.filename, "byte-identical persistence preserves the deterministic artifact name");
  writeFileSync(first.fullPath, readFileSync(first.fullPath, "utf8").replace(/\n/g, "\r\n"));
  throws(
    () => runHarnessEvidence(paths, evidenceArgs),
    /does not match its content-derived identity/,
    "newline-transformed artifact bytes cannot impersonate the content-addressed receipt",
  );
  rmSync(harnessRepo, { recursive: true, force: true });
  cleanup();
}

{
  const { root, paths, cleanup } = fixture();
  const harnessRepo = mkdtempSync(path.join(tmpdir(), "crx-factory-harness-concurrent-hold-"));
  writeFileSync(path.join(harnessRepo, "package.json"), `${JSON.stringify({
    scripts: {
      "verify-deps": "node -e \"require('fs').writeFileSync(process.env.CRX_FACTORY_TEST_STATE_DIR + '/EMERGENCY-HOLD.json', JSON.stringify({reason:'test concurrent hold'}));process.stdout.write('HOLD_CREATED')\"",
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
  const baseSha = execFileSync("git", ["rev-parse", "origin/main"], { cwd: harnessRepo, encoding: "utf8" }).trim();
  const written = writeImmutableTicket(paths, ticket("pause-during-harness"));
  append(paths, "ticket-drafted", written.ticket.id, {
    ticketFile: written.filename,
    ticketHash: written.hash,
    ticketVersion: 1,
    title: written.ticket.title,
  });
  const question = "Approve the concurrent-hold harness test?";
  append(paths, "ticket-presented", written.ticket.id, {
    ticketHash: written.hash,
    questionText: question,
    questionHash: sha256(question),
    baseSha,
  });
  append(paths, "ticket-approved", written.ticket.id, {
    ticketHash: written.hash,
    questionHash: sha256(question),
    ownerReply: "yes",
    baseSha,
    expiresAt: new Date(Date.parse("2026-07-30T12:00:00.000Z") + APPROVAL_TTL_MS).toISOString(),
  });
  append(paths, "lane-started", written.ticket.id, {
    ticketHash: written.hash,
    baseSha,
    worktree: harnessRepo,
  });
  const beforeRun = loadFactorySnapshot(paths);
  throws(
    () => runAndAttachHarnessEvidence(paths, {
      jobId: written.ticket.id,
      label: "GITHUB_TOKEN=secret-shaped-value",
      scriptName: "verify-deps",
      sessionId: "session-1",
      actorTool: "codex",
      expectedLastEventHash: beforeRun.lastEventHash,
      currentBaseSha: baseSha,
      cwd: harnessRepo,
    }),
    /evidence label appears to contain a credential or secret/i,
    "a secret-shaped evidence label is refused before the harness executes",
  );
  eq(existsSync(paths.emergencyHoldPath), false, "a secret-shaped evidence label cannot trigger harness side effects");
  throws(
    () => runAndAttachHarnessEvidence(paths, {
      jobId: written.ticket.id,
      label: "",
      scriptName: "verify-deps",
      sessionId: "session-1",
      actorTool: "codex",
      expectedLastEventHash: beforeRun.lastEventHash,
      currentBaseSha: baseSha,
      cwd: harnessRepo,
    }),
    /evidence label is required/,
    "an invalid evidence label is refused before the harness executes",
  );
  eq(existsSync(paths.emergencyHoldPath), false, "invalid evidence metadata cannot trigger harness side effects");
  const preRunEvidenceDir = path.join(paths.evidenceDir, written.ticket.id);
  eq(existsSync(preRunEvidenceDir) ? readdirSync(preRunEvidenceDir).length : 0, 0, "invalid evidence metadata creates no artifact");
  throws(
    () => runAndAttachHarnessEvidence(paths, {
      jobId: written.ticket.id,
      label: "must remain unattached",
      scriptName: "verify-deps",
      sessionId: "session-1",
      actorTool: "codex",
      expectedLastEventHash: beforeRun.lastEventHash,
      currentBaseSha: baseSha,
      cwd: harnessRepo,
    }),
    /paused while harness verify-deps ran/,
    "an emergency hold created during a harness prevents evidence attachment",
  );
  const afterRun = loadFactorySnapshot(paths);
  eq(afterRun.held, true, "a concurrent emergency hold remains authoritative");
  eq(afterRun.jobs[0].evidence.length, 0, "no evidence attaches after the factory is paused");
  const jobEvidenceDir = path.join(paths.evidenceDir, written.ticket.id);
  eq(existsSync(jobEvidenceDir) ? readdirSync(jobEvidenceDir).length : 0, 0, "the unattached evidence artifact is cleaned up");
  rmSync(harnessRepo, { recursive: true, force: true });
  cleanup();
}

{
  const proofRepo = mkdtempSync(path.join(tmpdir(), "crx-factory-artifact-repo-"));
  const cleanupProofRepo = () => {
    rmSync(proofRepo, { recursive: true, force: true });
    pendingFixtureCleanups.delete(cleanupProofRepo);
  };
  pendingFixtureCleanups.add(cleanupProofRepo);
  writeFileSync(path.join(proofRepo, "package.json"), execFileSync("git", ["show", "HEAD:package.json"], { cwd: repoRoot }));
  writeFileSync(path.join(proofRepo, "package-lock.json"), execFileSync("git", ["show", "HEAD:package-lock.json"], { cwd: repoRoot }));
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "package.json", "package-lock.json"],
    ["-c", "user.name=Factory Test", "-c", "user.email=factory@example.invalid", "commit", "-qm", "proof base"],
  ]) {
    execFileSync("git", args, { cwd: proofRepo, stdio: "ignore" });
  }
  const proofBaseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: proofRepo, encoding: "utf8" }).trim();
  mkdirSync(path.join(proofRepo, "docs"));
  writeFileSync(path.join(proofRepo, "docs", "main-moved.txt"), "new main\n");
  for (const args of [
    ["add", "docs/main-moved.txt"],
    ["-c", "user.name=Factory Test", "-c", "user.email=factory@example.invalid", "commit", "-qm", "move main"],
    ["update-ref", "refs/remotes/origin/main", "HEAD"],
  ]) {
    execFileSync("git", args, { cwd: proofRepo, stdio: "ignore" });
  }
  const currentBaseSha = execFileSync("git", ["rev-parse", "origin/main"], { cwd: proofRepo, encoding: "utf8" }).trim();
  ok(proofBaseSha !== currentBaseSha, "harness proof fixture uses a base older than current origin/main");
  const committedRepository = repositoryCommitFingerprint(proofRepo, proofBaseSha);
  const packageBytes = execFileSync("git", ["show", `${proofBaseSha}:package.json`], { cwd: proofRepo });
  const packageJson = JSON.parse(packageBytes);
  const scriptBody = packageJson.scripts["verify-deps"];
  const repository = {
    headSha: committedRepository.commitSha,
    headTreeSha: committedRepository.treeSha,
    repositoryContentHash: committedRepository.repositoryContentHash,
    repositoryFileCount: committedRepository.repositoryFileCount,
  };
  const proofDependencyHash = factoryHarnessDependencyHashForCommit(proofRepo, proofBaseSha);
  const proofTicketHash = "f".repeat(64);
  const proofRoot = mkdtempSync(path.join(tmpdir(), "crx-factory-artifact-proof-"));
  const proofPaths = resolveFactoryPaths(proofRepo, {
    CRX_FACTORY_TEST_MODE: "1",
    CRX_FACTORY_TEST_STATE_DIR: path.join(proofRoot, "state"),
  });
  const proofPayload = {
    scriptName: "verify-deps",
    baseSha: proofBaseSha,
    ticketHash: proofTicketHash,
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
    ticketHash: proofTicketHash,
    ticket: {
      proofHarnesses: ["verify-deps"],
      allowedPaths: [".claude/", "docs/", "scripts/"],
    },
    evidence: [{
      verified: true,
      kind: "harness",
      scriptName: "verify-deps",
      baseSha: proofBaseSha,
      ticketHash: proofTicketHash,
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
        gitMetadataExposure: "sanitized-workspace-only",
        inheritedEnvironment: false,
        imageId: `sha256:${"1".repeat(64)}`,
        imageTag: `crx-factory-harness:${proofDependencyHash.slice(0, 24)}`,
        dependencyHash: proofDependencyHash,
      },
    }],
  };
  throws(
    () => validateCurrentHarnessEvidence(landedJob, proofRepo, {
      paths: proofPaths,
      repositoryFingerprint: committedRepository,
    }),
    /every ticket-required/,
    "morning review rejects proof when origin/main moved",
  );
  ok(
    validateCurrentHarnessEvidence(landedJob, proofRepo, {
      requireCurrentBase: false,
      paths: proofPaths,
      repositoryFingerprint: committedRepository,
    }),
    "post-landing closeout accepts proof bound to the job's immutable original base",
  );
  landedJob.ticketHash = "e".repeat(64);
  throws(
    () => validateCurrentHarnessEvidence(landedJob, proofRepo, {
      requireCurrentBase: false,
      paths: proofPaths,
      repositoryFingerprint: committedRepository,
    }),
    /every ticket-required/,
    "a revised ticket hash invalidates previous harness evidence",
  );
  landedJob.ticketHash = proofTicketHash;
  landedJob.ticket.proofHarnesses = ["verify-deps", "build"];
  throws(
    () => validateCurrentHarnessEvidence(landedJob, proofRepo, {
      requireCurrentBase: false,
      paths: proofPaths,
      repositoryFingerprint: committedRepository,
    }),
    /every ticket-required/,
    "one passing harness cannot satisfy a ticket that requires multiple harnesses",
  );
  landedJob.ticket.proofHarnesses = ["verify-deps"];
  landedJob.evidence[0].repositoryContentHash = "0".repeat(64);
  throws(
    () => validateCurrentHarnessEvidence(landedJob, proofRepo, {
      requireCurrentBase: false,
      paths: proofPaths,
      repositoryFingerprint: committedRepository,
    }),
    /every ticket-required/,
    "source changes invalidate previously verified harness evidence",
  );
  landedJob.evidence[0].repositoryContentHash = repository.repositoryContentHash;
  writeFileSync(path.join(proofPaths.evidenceDir, "landed-job", proofFilename), `${proofBytes}tampered`);
  throws(
    () => validateCurrentHarnessEvidence(landedJob, proofRepo, {
      requireCurrentBase: false,
      paths: proofPaths,
      repositoryFingerprint: committedRepository,
    }),
    /no longer match the ledger SHA-256/,
    "morning and closeout validation re-hash saved harness proof bytes",
  );

  const reviewPayload = {
    reviewer: "codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    verdict: "clean",
    baseSha: proofBaseSha,
    ticketHash: proofTicketHash,
    headSha: repository.headSha,
    headTreeSha: repository.headTreeSha,
    repositoryContentHash: repository.repositoryContentHash,
    repositoryFileCount: repository.repositoryFileCount,
    reportSummary: `Independent Codex review returned ${FACTORY_REVIEW_TOKEN}: CLEAN.`,
    stdoutSha256: sha256("fixture review"),
    stdoutBytes: Buffer.byteLength("fixture review"),
    stderrSha256: sha256(""),
    stderrBytes: 0,
  };
  const reviewBytes = `${canonicalJson(reviewPayload)}\n`;
  const reviewFilename = `${sha256(reviewBytes).slice(0, 12)}-independent-codex-review.json`;
  writeFileSync(path.join(proofPaths.evidenceDir, "landed-job", reviewFilename), reviewBytes);
  landedJob.reviews = [{
    ...reviewPayload,
    filename: reviewFilename,
    sha256: sha256(reviewBytes),
  }];
  ok(
    validateCurrentIndependentReview(landedJob, proofRepo, {
      paths: proofPaths,
      repositoryFingerprint: committedRepository,
    }),
    "independent review validation reopens the ledger-bound review artifact",
  );
  landedJob.ticketHash = "e".repeat(64);
  throws(
    () => validateCurrentIndependentReview(landedJob, proofRepo, {
      paths: proofPaths,
      repositoryFingerprint: committedRepository,
    }),
    /exact repository bytes/,
    "a revised ticket hash invalidates the previous independent review receipt",
  );
  landedJob.ticketHash = proofTicketHash;
  writeFileSync(path.join(proofPaths.evidenceDir, "landed-job", reviewFilename), `${reviewBytes}tampered`);
  throws(
    () => validateCurrentIndependentReview(landedJob, proofRepo, {
      paths: proofPaths,
      repositoryFingerprint: committedRepository,
    }),
    /no longer match the ledger SHA-256/,
    "independent review validation rejects changed artifact bytes",
  );
  rmSync(proofRoot, { recursive: true, force: true });
  cleanupProofRepo();
}

console.log(`factory-state-lib: ${pass} assertions passed`);
