#!/usr/bin/env node

import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FACTORY_SCHEMA_VERSION = 1;
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
export const ACTIVE_STAGES = new Set(["building", "verifying", "in-review"]);
export const STALE_LOCK_MS = 5 * 60 * 1000;
export const FACTORY_HARNESS_ALLOWLIST = new Set([
  "test",
  "test:factory",
  "test:agent-workflows",
  "typecheck",
  "lint",
  "build",
  "verify-deps",
  "check-doc-drift",
]);
export const BOARD_STAGES = new Set([
  "needs-ticket-ok",
  "queued",
  "building",
  "verifying",
  "in-review",
  "awaiting-morning-review",
  "parked",
  "approved-to-land",
  "live",
  "rejected",
  "superseded",
]);

const HIGH_RISK_AREAS = new Set([
  "money",
  "inventory",
  "commission",
  "security",
  "lifecycle",
  "migration",
  "permissions",
]);

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function resolveRepoRoot(cwd = process.cwd()) {
  return path.resolve(git(["rev-parse", "--show-toplevel"], cwd));
}

export function resolveFactoryPaths(cwd = process.cwd(), env = process.env) {
  if (env.CRX_FACTORY_TEST_STATE_DIR) {
    if (env.CRX_FACTORY_TEST_MODE !== "1") {
      throw new Error("CRX_FACTORY_TEST_STATE_DIR is allowed only with CRX_FACTORY_TEST_MODE=1.");
    }
    const stateDir = path.resolve(env.CRX_FACTORY_TEST_STATE_DIR);
    return buildPaths(stateDir);
  }

  const repoRoot = resolveRepoRoot(cwd);
  const commonRaw = git(["rev-parse", "--git-common-dir"], repoRoot);
  const commonDir = path.isAbsolute(commonRaw)
    ? path.resolve(commonRaw)
    : path.resolve(repoRoot, commonRaw);
  return buildPaths(path.join(commonDir, "crx-factory"));
}

export function resolveHookFactoryPaths(cwd = process.cwd(), env = process.env) {
  const candidate = env.CRX_FACTORY_TEST_STATE_DIR ? path.resolve(env.CRX_FACTORY_TEST_STATE_DIR) : "";
  const isolatedNodeTest = Boolean(env.NODE_TEST_CONTEXT)
    && env.CRX_FACTORY_TEST_MODE === "1"
    && candidate
    && candidate.toLowerCase().startsWith(`${path.resolve(tmpdir()).toLowerCase()}${path.sep}`);
  if (isolatedNodeTest) return resolveFactoryPaths(cwd, env);
  const productionEnv = { ...env };
  delete productionEnv.CRX_FACTORY_TEST_MODE;
  delete productionEnv.CRX_FACTORY_TEST_STATE_DIR;
  return resolveFactoryPaths(cwd, productionEnv);
}

function buildPaths(stateDir) {
  return {
    stateDir,
    ticketsDir: path.join(stateDir, "tickets"),
    evidenceDir: path.join(stateDir, "evidence"),
    eventsPath: path.join(stateDir, "events.jsonl"),
    lockPath: path.join(stateDir, "events.lock"),
    emergencyHoldPath: path.join(stateDir, "EMERGENCY-HOLD.json"),
    recoveryDir: path.join(stateDir, "recovery"),
  };
}

export function ensureFactoryDirs(paths) {
  mkdirSync(paths.ticketsDir, { recursive: true });
  mkdirSync(paths.evidenceDir, { recursive: true });
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeOwnerQuestion(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

export function ticketBytes(ticket) {
  return `${canonicalJson(ticket)}\n`;
}

export function ticketHash(ticket) {
  return sha256(ticketBytes(ticket));
}

function requiredText(value, label, max = 10_000) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required.`);
  if (text.length > max) throw new Error(`${label} exceeds ${max} characters.`);
  return text;
}

function requiredStringArray(value, label, { min = 1, max = 30 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${label} must contain ${min}-${max} items.`);
  }
  return value.map((item, index) => requiredText(item, `${label}[${index}]`, 2_000));
}

export function normalizeTicket(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Ticket must be a JSON object.");
  }
  const riskAreas = Array.isArray(input.riskAreas)
    ? [...new Set(input.riskAreas.map((item) => String(item).trim().toLowerCase()).filter(Boolean))]
    : [];
  const highRisk = riskAreas.some((area) => HIGH_RISK_AREAS.has(area));
  const businessExample = String(input.businessExample || "").trim();
  const forbiddenOutcome = String(input.forbiddenOutcome || "").trim();
  if (highRisk && !businessExample) {
    throw new Error("businessExample is required for money, inventory, commission, security, lifecycle, migration, or permission work.");
  }
  if (highRisk && !forbiddenOutcome) {
    throw new Error("forbiddenOutcome is required for high-risk work.");
  }

  return {
    schemaVersion: FACTORY_SCHEMA_VERSION,
    id: requiredText(input.id, "id", 100),
    version: Number.isInteger(input.version) && input.version > 0 ? input.version : 1,
    title: requiredText(input.title, "title", 180),
    goal: requiredText(input.goal, "goal"),
    definitionOfDone: requiredStringArray(input.definitionOfDone, "definitionOfDone"),
    mustNotChange: requiredStringArray(input.mustNotChange, "mustNotChange"),
    proofRequirements: requiredStringArray(input.proofRequirements, "proofRequirements"),
    proofHarnesses: requiredStringArray(input.proofHarnesses, "proofHarnesses")
      .map((item) => {
        if (!FACTORY_HARNESS_ALLOWLIST.has(item)) {
          throw new Error(`proofHarnesses contains unsupported repository harness: ${item}`);
        }
        return item;
      }),
    deliveryGate: requiredText(input.deliveryGate, "deliveryGate", 2_000),
    riskAreas,
    businessExample,
    forbiddenOutcome,
  };
}

export function writeImmutableTicket(paths, input) {
  ensureFactoryDirs(paths);
  const ticket = normalizeTicket(input);
  const bytes = ticketBytes(ticket);
  const hash = sha256(bytes);
  const filename = `${safeId(ticket.id)}-v${ticket.version}-${hash.slice(0, 12)}.json`;
  const fullPath = path.join(paths.ticketsDir, filename);
  if (existsSync(fullPath)) {
    if (readFileSync(fullPath, "utf8") !== bytes) {
      throw new Error(`Immutable ticket collision at ${filename}.`);
    }
  } else {
    writeFileSync(fullPath, bytes, { encoding: "utf8", flag: "wx" });
  }
  return { ticket, hash, filename, fullPath };
}

export function safeId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id)) {
    throw new Error(`Unsafe identifier: ${id || "(empty)"}`);
  }
  return id;
}

export function readTicket(paths, filename) {
  const safe = path.basename(filename);
  if (safe !== filename || !safe.endsWith(".json")) throw new Error("Unsafe ticket filename.");
  const fullPath = path.join(paths.ticketsDir, safe);
  const bytes = readFileSync(fullPath, "utf8");
  const ticket = normalizeTicket(JSON.parse(bytes));
  if (ticketBytes(ticket) !== bytes.replace(/\r\n/g, "\n")) {
    throw new Error(`Ticket ${safe} is not canonically serialized.`);
  }
  return { ticket, hash: sha256(bytes), filename: safe, fullPath };
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(paths, timeoutMs = 5_000) {
  ensureFactoryDirs(paths);
  const start = Date.now();
  while (true) {
    try {
      const fd = openSync(paths.lockPath, "wx");
      writeSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      return fd;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() - start >= timeoutMs) {
        throw new Error(`Factory ledger lock timed out after ${timeoutMs}ms.`);
      }
      sleepMs(25);
    }
  }
}

const FACTORY_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const FACTORY_ROOT = path.resolve(FACTORY_MODULE_DIR, "..");
const ALLOWED_WRITERS = new Set([
  path.join(FACTORY_ROOT, "scripts", "factory.mjs"),
  path.join(FACTORY_ROOT, ".claude", "hooks", "factory-owner-input.mjs"),
  path.join(FACTORY_ROOT, ".claude", "hooks", "ship-intent-reminder.mjs"),
].map((value) => path.resolve(value).toLowerCase()));

function authorizedFactoryWriter(paths) {
  const invoked = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : "";
  const stack = String(new Error().stack || "").toLowerCase().replaceAll("/", "\\");
  const allowed = [...ALLOWED_WRITERS].find((candidate) =>
    invoked === candidate && stack.includes(candidate.replaceAll("/", "\\")),
  );
  if (allowed && process.execArgv.length === 0) return;

  const testDir = process.env.CRX_FACTORY_TEST_STATE_DIR
    ? path.resolve(process.env.CRX_FACTORY_TEST_STATE_DIR)
    : "";
  const isIsolatedTest = process.env.CRX_FACTORY_TEST_MODE === "1"
    && testDir
    && path.resolve(paths.stateDir) === testDir
    && testDir.toLowerCase().startsWith(`${path.resolve(tmpdir()).toLowerCase()}${path.sep}`)
    && /\.test\.mjs$/i.test(invoked)
    && stack.includes(invoked.replaceAll("/", "\\"));
  if (isIsolatedTest) return;
  throw new Error("Factory state mutation is restricted to the canonical CLI and owner hooks.");
}

function releaseLock(paths, fd) {
  try { closeSync(fd); } finally {
    try { unlinkSync(paths.lockPath); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function eventBody(event) {
  const { eventHash: _eventHash, ...body } = event;
  return body;
}

export function validateEventShape(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Event must be an object.");
  if (event.schemaVersion !== FACTORY_SCHEMA_VERSION) throw new Error("Unsupported factory event schema.");
  safeId(event.eventId);
  requiredText(event.type, "event.type", 100);
  requiredText(event.timestamp, "event.timestamp", 100);
  if (event.jobId !== null) safeId(event.jobId);
  requiredText(event.actorTool, "event.actorTool", 40);
  requiredText(event.sessionId, "event.sessionId", 200);
  if (!/^[a-f0-9]{64}$/.test(event.previousHash)) throw new Error("event.previousHash must be SHA-256.");
  if (!/^[a-f0-9]{64}$/.test(event.eventHash)) throw new Error("event.eventHash must be SHA-256.");
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    throw new Error("event.payload must be an object.");
  }
  const expected = sha256(canonicalJson(eventBody(event)));
  if (expected !== event.eventHash) throw new Error(`Event hash mismatch for ${event.eventId}.`);
  return event;
}

export function readEventLog(paths) {
  if (!existsSync(paths.eventsPath)) return { events: [], degraded: false, warning: "" };
  const raw = readFileSync(paths.eventsPath, "utf8");
  if (!raw) return { events: [], degraded: false, warning: "" };
  const endsWithNewline = raw.endsWith("\n");
  const lines = raw.split("\n");
  if (endsWithNewline) lines.pop();

  const events = [];
  let degraded = false;
  let warning = "";
  const ids = new Set();
  let previousHash = "0".repeat(64);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) throw new Error(`Blank interior factory event line at ${index + 1}.`);
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      if (!endsWithNewline && index === lines.length - 1) {
        degraded = true;
        warning = "The final factory event was interrupted before it finished writing. Earlier verified events remain visible; no job advanced from the incomplete line.";
        break;
      }
      throw new Error(`Malformed factory event line ${index + 1}: ${error.message}`);
    }
    const event = validateEventShape(parsed);
    if (event.previousHash !== previousHash) {
      throw new Error(`Broken factory event chain at ${event.eventId}.`);
    }
    if (ids.has(event.eventId)) throw new Error(`Duplicate factory event ID ${event.eventId}.`);
    ids.add(event.eventId);
    events.push(event);
    previousHash = event.eventHash;
  }
  return { events, degraded, warning };
}

export function appendFactoryEvent(paths, {
  type,
  jobId = null,
  actorTool,
  sessionId,
  payload = {},
  timestamp = new Date().toISOString(),
  eventId = randomUUID(),
}, {
  expectedLastEventHash = "",
} = {}) {
  authorizedFactoryWriter(paths);
  const lockFd = acquireLock(paths);
  try {
    const current = readEventLog(paths);
    if (current.degraded) {
      throw new Error("Factory ledger has an incomplete trailing event; repair or archive it before appending.");
    }
    const previousHash = current.events.at(-1)?.eventHash || "0".repeat(64);
    if (expectedLastEventHash && previousHash !== expectedLastEventHash) {
      throw new Error("Factory state changed after this decision was presented; re-read and re-present it.");
    }
    const body = canonicalize({
      schemaVersion: FACTORY_SCHEMA_VERSION,
      eventId: safeId(eventId),
      type: requiredText(type, "type", 100),
      timestamp: requiredText(timestamp, "timestamp", 100),
      jobId: jobId === null ? null : safeId(jobId),
      actorTool: requiredText(actorTool, "actorTool", 40),
      sessionId: requiredText(sessionId, "sessionId", 200),
      previousHash,
      payload,
    });
    const event = { ...body, eventHash: sha256(canonicalJson(body)) };
    validateEventShape(event);
    appendFileSync(paths.eventsPath, `${canonicalJson(event)}\n`, "utf8");
    return event;
  } finally {
    releaseLock(paths, lockFd);
  }
}

export function currentOriginMain(cwd = process.cwd()) {
  return git(["rev-parse", "--verify", "origin/main"], cwd);
}

export function buildFactorySnapshot(paths, { nowMs = Date.now() } = {}) {
  const log = readEventLog(paths);
  const jobs = new Map();
  const factoryIntents = new Map();
  let held = false;
  let holdReason = "";

  for (const event of log.events) {
    if (event.type === "factory-intent") {
      factoryIntents.set(event.sessionId, event.timestamp);
      continue;
    }
    if (event.type === "factory-intent-cleared") {
      factoryIntents.delete(event.sessionId);
      continue;
    }
    if (event.type === "factory-held") {
      held = true;
      holdReason = String(event.payload.reason || "Factory paused by Mason.");
      continue;
    }
    if (event.type === "factory-resumed") {
      held = false;
      holdReason = "";
      continue;
    }
    if (!event.jobId) continue;
    const job = jobs.get(event.jobId) || {
      id: event.jobId,
      title: event.jobId,
      stage: "needs-ticket-ok",
      ticketHash: "",
      ticketFile: "",
      ticket: null,
      sessionId: "",
      laneSessionId: "",
      actorTool: "",
      baseSha: "",
      approvalExpiresAt: "",
      approvalReply: "",
      questionHash: "",
      questionText: "",
      reviewQuestionHash: "",
      reviewQuestionText: "",
      reviewBaseSha: "",
      reviewExpiresAt: "",
      behaviorSummary: "",
      blocker: "",
      landingCommit: "",
      productionProof: "",
      closeoutPacket: "",
      closeoutPacketHash: "",
      evidence: [],
      lastActivity: event.timestamp,
      terminalLedgerHash: event.eventHash,
    };
    job.lastActivity = event.timestamp;
    job.terminalLedgerHash = event.eventHash;

    switch (event.type) {
      case "ticket-drafted": {
        job.stage = "needs-ticket-ok";
        job.ticketHash = String(event.payload.ticketHash || "");
        job.ticketFile = String(event.payload.ticketFile || "");
        const loaded = readTicket(paths, job.ticketFile);
        if (loaded.hash !== job.ticketHash) throw new Error(`Ticket hash drift for ${job.id}.`);
        job.ticket = loaded.ticket;
        job.title = loaded.ticket.title;
        break;
      }
      case "ticket-presented":
        job.stage = "needs-ticket-ok";
        job.sessionId = event.sessionId;
        job.actorTool = event.actorTool;
        job.questionHash = String(event.payload.questionHash || "");
        job.questionText = String(event.payload.questionText || "");
        job.baseSha = String(event.payload.baseSha || "");
        break;
      case "ticket-approved":
        job.stage = "queued";
        job.approvalReply = String(event.payload.ownerReply || "");
        job.approvalExpiresAt = String(event.payload.expiresAt || "");
        job.baseSha = String(event.payload.baseSha || job.baseSha);
        break;
      case "ticket-rejected":
      case "ticket-revision-requested":
        job.stage = "rejected";
        job.blocker = String(event.payload.ownerReply || "Owner requested changes.");
        break;
      case "lane-started":
        job.stage = "building";
        job.laneSessionId = event.sessionId;
        break;
      case "review-presented":
        job.sessionId = event.sessionId;
        job.actorTool = event.actorTool;
        job.reviewQuestionHash = String(event.payload.questionHash || "");
        job.reviewQuestionText = String(event.payload.questionText || "");
        job.reviewBaseSha = String(event.payload.baseSha || "");
        job.reviewExpiresAt = String(event.payload.expiresAt || "");
        break;
      case "job-stage":
        if (!BOARD_STAGES.has(event.payload.stage)) throw new Error(`Unknown board stage ${event.payload.stage}.`);
        job.stage = event.payload.stage;
        job.behaviorSummary = String(event.payload.behaviorSummary || job.behaviorSummary);
        job.blocker = String(event.payload.blocker || "");
        if (event.payload.stage === "live") {
          job.landingCommit = String(event.payload.landingCommit || "");
          job.productionProof = String(event.payload.productionProof || "");
          job.closeoutPacket = String(event.payload.closeoutPacket || "");
          job.closeoutPacketHash = String(event.payload.closeoutPacketHash || "");
        }
        break;
      case "evidence-attached":
        job.evidence.push({
          label: String(event.payload.label || "Evidence"),
          kind: String(event.payload.kind || "file"),
          filename: String(event.payload.filename || ""),
          sha256: String(event.payload.sha256 || ""),
          verified: event.payload.verified === true,
          sourceCommand: String(event.payload.sourceCommand || ""),
          scriptName: String(event.payload.scriptName || ""),
          scriptBodyHash: String(event.payload.scriptBodyHash || ""),
          baseScriptBodyHash: String(event.payload.baseScriptBodyHash || ""),
          baseSha: String(event.payload.baseSha || ""),
          packageJsonHash: String(event.payload.packageJsonHash || ""),
        });
        break;
      default:
        break;
    }
    jobs.set(event.jobId, job);
  }

  if (existsSync(paths.emergencyHoldPath)) {
    held = true;
    try {
      const emergency = JSON.parse(readFileSync(paths.emergencyHoldPath, "utf8"));
      holdReason = String(emergency.reason || "Emergency hold: the factory ledger could not record Mason's pause.");
    } catch {
      holdReason = "Emergency hold: the factory ledger could not record Mason's pause.";
    }
  }

  for (const job of jobs.values()) {
    if (job.stage === "queued" && Date.parse(job.approvalExpiresAt) <= nowMs) {
      job.stage = "needs-ticket-ok";
      job.blocker = "Ticket approval expired and must be re-presented in chat.";
    }
  }

  return {
    schemaVersion: FACTORY_SCHEMA_VERSION,
    held,
    holdReason,
    degraded: log.degraded,
    warning: log.warning,
    lastEventHash: log.events.at(-1)?.eventHash || "0".repeat(64),
    factoryIntentSessions: [...factoryIntents.keys()].sort(),
    jobs: [...jobs.values()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)),
  };
}

export function pendingTicketForSession(snapshot, sessionId) {
  return snapshot.jobs.filter((job) =>
    job.stage === "needs-ticket-ok"
    && job.sessionId === sessionId
    && job.questionHash,
  );
}

export function pendingReviewForSession(snapshot, sessionId) {
  return snapshot.jobs.filter((job) =>
    job.stage === "awaiting-morning-review"
    && job.sessionId === sessionId
    && job.reviewQuestionHash,
  );
}

export function activeJobs(snapshot) {
  return snapshot.jobs.filter((job) => ACTIVE_STAGES.has(job.stage));
}

export function validateLaneActor(snapshot, jobId, sessionId, {
  allowedStages = ACTIVE_STAGES,
} = {}) {
  const job = snapshot.jobs.find((candidate) => candidate.id === jobId);
  if (!job) throw new Error(`Unknown factory job ${jobId}.`);
  if (!sessionId || job.laneSessionId !== sessionId) {
    throw new Error(`Factory job ${jobId} is bound to another build session.`);
  }
  if (!allowedStages.has(job.stage)) {
    throw new Error(`Factory job ${jobId} is ${job.stage}, not in an allowed lane stage.`);
  }
  return job;
}

const ALLOWED_AGENT_STAGE_CHANGES = new Map([
  ["building", new Set(["verifying", "in-review", "parked"])],
  ["verifying", new Set(["in-review", "parked"])],
  ["in-review", new Set(["awaiting-morning-review", "parked"])],
  ["approved-to-land", new Set(["parked"])],
]);

export function validateStageChange(snapshot, jobId, nextStage, {
  sessionId = "",
  cwd = FACTORY_ROOT,
  behaviorSummary = "",
  blocker = "",
} = {}) {
  if (!BOARD_STAGES.has(nextStage)) throw new Error(`Unknown board stage ${nextStage}.`);
  const job = snapshot.jobs.find((candidate) => candidate.id === jobId);
  if (!job) throw new Error(`Unknown factory job ${jobId}.`);
  if (!sessionId || job.laneSessionId !== sessionId) {
    throw new Error(`Factory job ${jobId} is bound to another build session.`);
  }
  const allowed = ALLOWED_AGENT_STAGE_CHANGES.get(job.stage);
  if (!allowed?.has(nextStage)) {
    throw new Error(`Factory job ${jobId} cannot move from ${job.stage} to ${nextStage} through the agent stage command.`);
  }
  if (nextStage === "awaiting-morning-review") {
    if (!String(behaviorSummary || "").trim()) {
      throw new Error("A plain-English behavior summary is required before morning review.");
    }
    validateCurrentHarnessEvidence(job, cwd);
  }
  if (nextStage === "parked" && !String(blocker || "").trim()) {
    throw new Error("A plain-English blocker is required when parking a job.");
  }
  return job;
}

export function validateLaneStart({
  snapshot,
  jobId,
  sessionId,
  currentBaseSha,
  nowMs = Date.now(),
}) {
  if (snapshot.held) throw new Error(`Factory is paused: ${snapshot.holdReason || "no reason recorded"}`);
  const job = snapshot.jobs.find((candidate) => candidate.id === jobId);
  if (!job) throw new Error(`Unknown factory job ${jobId}.`);
  if (job.stage !== "queued") throw new Error(`Job ${jobId} is ${job.stage}, not approved and queued.`);
  if (job.sessionId !== sessionId) throw new Error("Ticket approval is bound to another chat session; re-present it here.");
  if (!job.approvalExpiresAt || Date.parse(job.approvalExpiresAt) <= nowMs) {
    throw new Error("Ticket approval expired; re-present it in chat.");
  }
  if (job.baseSha !== currentBaseSha) {
    throw new Error("origin/main moved after ticket approval; re-check the ticket and re-present it.");
  }
  const loaded = readTicket(resolvePathsFromSnapshot(snapshot), job.ticketFile);
  if (loaded.hash !== job.ticketHash) throw new Error("Ticket bytes changed after approval.");
  const active = activeJobs(snapshot).filter((candidate) => candidate.id !== jobId);
  if (active.length > 0) throw new Error(`Pilot allows one active lane; ${active[0].id} is still ${active[0].stage}.`);
  return job;
}

// Snapshot validation needs the paths only for immutable ticket re-read. Keep the
// pointer non-enumerable so JSON/board output never leaks a local filesystem path.
export function attachSnapshotPaths(snapshot, paths) {
  Object.defineProperty(snapshot, "_factoryPaths", { value: paths, enumerable: false });
  return snapshot;
}

function resolvePathsFromSnapshot(snapshot) {
  if (!snapshot?._factoryPaths) throw new Error("Factory snapshot is missing its canonical path binding.");
  return snapshot._factoryPaths;
}

export function loadFactorySnapshot(paths, options) {
  return attachSnapshotPaths(buildFactorySnapshot(paths, options), paths);
}

export function copyEvidence(paths, jobId, sourceFile, label, kind = "file") {
  authorizedFactoryWriter(paths);
  const safeJob = safeId(jobId);
  const source = path.resolve(sourceFile);
  if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`Evidence file not found: ${source}`);
  const jobDir = path.join(paths.evidenceDir, safeJob);
  mkdirSync(jobDir, { recursive: true });
  const bytes = readFileSync(source);
  const hash = sha256(bytes);
  const filename = `${hash.slice(0, 12)}-${path.basename(source).replace(/[^A-Za-z0-9._-]/g, "_")}`;
  const target = path.join(jobDir, filename);
  if (!existsSync(target)) copyFileSync(source, target);
  return {
    label: requiredText(label, "evidence label", 200),
    kind,
    filename,
    sha256: hash,
    fullPath: target,
    verified: false,
    sourceCommand: "",
  };
}

export function runHarnessEvidence(paths, {
  jobId,
  label,
  scriptName,
  cwd = FACTORY_ROOT,
}) {
  authorizedFactoryWriter(paths);
  const packageJson = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));
  if (!packageJson.scripts?.[scriptName]) throw new Error(`Unknown repository harness npm script: ${scriptName}`);
  if (!FACTORY_HARNESS_ALLOWLIST.has(scriptName)) {
    throw new Error(`Harness ${scriptName} is not in the fixed factory allowlist.`);
  }
  const basePackageJson = JSON.parse(git(["show", "origin/main:package.json"], cwd));
  if (basePackageJson.scripts?.[scriptName] !== packageJson.scripts[scriptName]) {
    throw new Error(`Harness ${scriptName} differs from its reviewed origin/main script body.`);
  }
  const executable = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npm";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", `npm run ${scriptName}`]
    : ["run", scriptName];
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    timeout: 15 * 60 * 1000,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Repository harness npm run ${scriptName} failed with exit ${result.status}.`);
  }
  const payload = {
    schemaVersion: FACTORY_SCHEMA_VERSION,
    command: `npm run ${scriptName}`,
    scriptName,
    scriptBody: String(packageJson.scripts[scriptName]),
    scriptBodyHash: sha256(String(packageJson.scripts[scriptName])),
    baseScriptBodyHash: sha256(String(basePackageJson.scripts[scriptName])),
    baseSha: currentOriginMain(cwd),
    packageJsonHash: sha256(readFileSync(path.join(cwd, "package.json"))),
    exitCode: result.status,
    capturedAt: new Date().toISOString(),
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
  };
  const bytes = `${canonicalJson(payload)}\n`;
  const hash = sha256(bytes);
  const safeJob = safeId(jobId);
  const jobDir = path.join(paths.evidenceDir, safeJob);
  mkdirSync(jobDir, { recursive: true });
  const filename = `${hash.slice(0, 12)}-${safeId(scriptName.replaceAll(":", "-"))}.json`;
  const target = path.join(jobDir, filename);
  writeFileSync(target, bytes, { encoding: "utf8", flag: "wx" });
  return {
    label: requiredText(label, "evidence label", 200),
    kind: "harness",
    filename,
    sha256: hash,
    fullPath: target,
    verified: true,
    sourceCommand: payload.command,
    scriptName,
    scriptBodyHash: payload.scriptBodyHash,
    baseScriptBodyHash: payload.baseScriptBodyHash,
    baseSha: payload.baseSha,
    packageJsonHash: payload.packageJsonHash,
  };
}

export function validateCurrentHarnessEvidence(job, cwd = FACTORY_ROOT, {
  requireCurrentBase = true,
} = {}) {
  const packageBytes = readFileSync(path.join(cwd, "package.json"));
  const packageJson = JSON.parse(packageBytes);
  const currentBaseSha = requireCurrentBase ? currentOriginMain(cwd) : "";
  const accepted = job.evidence.find((item) => {
    if (item.verified !== true || item.kind !== "harness") return false;
    if (!FACTORY_HARNESS_ALLOWLIST.has(item.scriptName)) return false;
    if (!job.ticket?.proofHarnesses?.includes(item.scriptName)) return false;
    if (item.baseSha !== job.baseSha) return false;
    if (requireCurrentBase && item.baseSha !== currentBaseSha) return false;
    const currentBody = packageJson.scripts?.[item.scriptName];
    return typeof currentBody === "string"
      && sha256(currentBody) === item.scriptBodyHash
      && item.baseScriptBodyHash === item.scriptBodyHash
      && sha256(packageBytes) === item.packageJsonHash;
  });
  if (!accepted) {
    throw new Error("A current, ticket-approved, allowlisted repository harness proof is required.");
  }
  return accepted;
}

export function setEmergencyFactoryHold(paths, reason) {
  authorizedFactoryWriter(paths);
  ensureFactoryDirs(paths);
  const payload = {
    schemaVersion: FACTORY_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    reason: requiredText(reason, "emergency hold reason", 1_000),
  };
  writeFileSync(paths.emergencyHoldPath, `${canonicalJson(payload)}\n`, { encoding: "utf8", flag: "w" });
}

export function clearEmergencyFactoryHold(paths) {
  authorizedFactoryWriter(paths);
  try { unlinkSync(paths.emergencyHoldPath); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function recoverFactoryState(paths, {
  mode,
  reason,
  nowMs = Date.now(),
}) {
  authorizedFactoryWriter(paths);
  ensureFactoryDirs(paths);
  mkdirSync(paths.recoveryDir, { recursive: true });
  if (mode === "unlock") {
    if (!existsSync(paths.lockPath)) throw new Error("Factory ledger lock does not exist.");
    let metadata = {};
    try { metadata = JSON.parse(readFileSync(paths.lockPath, "utf8")); } catch {}
    const ageMs = nowMs - (Date.parse(metadata.createdAt) || statSync(paths.lockPath).mtimeMs);
    if (ageMs < STALE_LOCK_MS) throw new Error("Factory ledger lock is not old enough to recover.");
    if (processIsAlive(Number(metadata.pid))) throw new Error(`Factory ledger writer PID ${metadata.pid} is still running.`);
    const backup = path.join(paths.recoveryDir, `stale-lock-${nowMs}.json`);
    copyFileSync(paths.lockPath, backup);
    unlinkSync(paths.lockPath);
    return { mode, backup, reason: requiredText(reason, "recovery reason", 1_000) };
  }
  if (mode === "torn-tail") {
    if (existsSync(paths.lockPath)) {
      throw new Error("Factory ledger is locked; recover a stale lock before repairing a torn tail.");
    }
    const log = readEventLog(paths);
    if (!log.degraded) throw new Error("Factory ledger has no incomplete trailing event.");
    const raw = readFileSync(paths.eventsPath, "utf8");
    const lastNewline = raw.lastIndexOf("\n");
    const repaired = lastNewline >= 0 ? raw.slice(0, lastNewline + 1) : "";
    const backup = path.join(paths.recoveryDir, `torn-events-${nowMs}-${sha256(raw).slice(0, 12)}.jsonl`);
    writeFileSync(backup, raw, { encoding: "utf8", flag: "wx" });
    writeFileSync(paths.eventsPath, repaired, { encoding: "utf8", flag: "w" });
    return { mode, backup, reason: requiredText(reason, "recovery reason", 1_000) };
  }
  throw new Error("Recovery mode must be unlock or torn-tail.");
}

export function listTicketFiles(paths) {
  if (!existsSync(paths.ticketsDir)) return [];
  return readdirSync(paths.ticketsDir).filter((name) => name.endsWith(".json")).sort();
}
