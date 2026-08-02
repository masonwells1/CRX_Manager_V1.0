#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVAL_TTL_MS,
  FACTORY_GITHUB_REPOSITORY,
  FACTORY_PRODUCTION_URL,
  appendFactoryEvent,
  buildFactorySnapshot,
  canonicalMorningReviewQuestion,
  canonicalTicketApprovalQuestion,
  consumeFactoryCliPermit,
  currentOriginMain,
  loadFactorySnapshot,
  recoverFactoryState,
  refreshOriginMain,
  repositoryCommitFingerprint,
  rejectSecretBearingText,
  resolveFactoryPaths,
  runAndAttachHarnessEvidence,
  runIndependentReviewEvidence,
  sha256,
  validateLaneActor,
  validateLaneStart,
  validateCurrentIndependentReview,
  validateCurrentHarnessEvidence,
  validateStageChange,
  writeImmutableTicket,
} from "./factory-state-lib.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

function usage(message = "") {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write([
    "Agent-facing CRX Factory CLI. Mason never runs this command.",
    "",
    "Usage:",
    "  node scripts/factory.mjs ticket draft --ticket-base64 <base64-json>",
    "  node scripts/factory.mjs ticket present --job <id>",
    "  node scripts/factory.mjs lane start --job <id>",
    "  node scripts/factory.mjs review run --job <id>",
    "  node scripts/factory.mjs review present --job <id>",
    "  node scripts/factory.mjs stage --job <id> --stage <stage> [--summary-base64 <base64-text>] [--blocker-base64 <base64-text>]",
    "  node scripts/factory.mjs evidence run --job <id> --harness <npm-script> --label <text>",
    "  node scripts/factory.mjs closeout write --job <id> --landing-commit <sha>",
    "  node scripts/factory.mjs recover <unlock|torn-tail> --reason-base64 <base64-text>",
    "  node scripts/factory.mjs status [--json]",
  ].join("\n") + "\n");
  process.exit(2);
}

function parseArgs(argv) {
  const positionals = [];
  const flags = new Map();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (/^--(?:file|summary-file|blocker-file|reason-file)$/.test(arg)) {
      usage(`${arg} is disabled; factory commands do not read caller-selected files.`);
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--on" || arg === "--off" || arg === "--json") {
      flags.set(arg.slice(2), true);
      continue;
    }
    const next = argv[++index];
    if (!next || next.startsWith("--")) usage(`Missing value for ${arg}.`);
    flags.set(arg.slice(2), next);
  }
  return { positionals, flags };
}

function required(flags, name) {
  const value = flags.get(name);
  if (!value) usage(`--${name} is required.`);
  return value;
}

function actor(paths, flags, env, nowMs, { recovery = false } = {}) {
  const who = consumeFactoryCliPermit(paths, env.CRX_FACTORY_PERMIT, { nowMs });
  const claimedTool = String(flags.get("tool") || "").toLowerCase();
  const claimedSession = String(flags.get("session") || "");
  if (claimedTool && claimedTool !== who.actorTool) {
    throw new Error("--tool does not match the trusted PreToolUse identity.");
  }
  if (claimedSession && claimedSession !== who.sessionId) {
    throw new Error("--session does not match the trusted PreToolUse identity.");
  }
  if (!recovery) {
    const snapshot = loadFactorySnapshot(paths, { nowMs });
    if (snapshot.lastEventHash !== who.expectedLastEventHash) {
      throw new Error("Factory state changed after this command was authorized; retry from the current board state.");
    }
  }
  return who;
}

function stableSnapshot(paths, who, options) {
  const snapshot = loadFactorySnapshot(paths, options);
  if (snapshot.lastEventHash !== who.expectedLastEventHash) {
    throw new Error("Factory state changed after this command was authorized; retry from the current board state.");
  }
  return snapshot;
}

function appendAsActor(
  paths,
  event,
  who,
  expectedLastEventHash = who.expectedLastEventHash,
  { requireFactoryRunning = false } = {},
) {
  return appendFactoryEvent(paths, {
    ...event,
    sessionId: who.sessionId,
    actorTool: who.actorTool,
  }, { expectedLastEventHash, requireFactoryRunning });
}

function decodeBase64Text(flags, name, { maxBytes = 20_000, rejectSecrets = true } = {}) {
  const encoded = required(flags, name);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error(`--${name} must be canonical base64.`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length > maxBytes || bytes.toString("base64") !== encoded) {
    throw new Error(`--${name} is empty, non-canonical, or exceeds ${maxBytes} bytes.`);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  if (!text) throw new Error(`--${name} decodes to empty text.`);
  if (rejectSecrets) rejectSecretBearingText(text, `--${name}`);
  return text;
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function closeoutDirectory(cwd, env) {
  if (env.CRX_FACTORY_TEST_CLOSEOUT_DIR) {
    if (env.CRX_FACTORY_TEST_MODE !== "1") {
      throw new Error("CRX_FACTORY_TEST_CLOSEOUT_DIR is allowed only with CRX_FACTORY_TEST_MODE=1.");
    }
    return path.resolve(env.CRX_FACTORY_TEST_CLOSEOUT_DIR);
  }
  return path.join(path.resolve(cwd), "docs", "audits", "factory", "jobs");
}

function isIsolatedFactoryTest(paths, env) {
  const tempRoot = `${path.resolve(tmpdir()).toLowerCase()}${path.sep}`;
  const closeout = env.CRX_FACTORY_TEST_CLOSEOUT_DIR
    ? path.resolve(env.CRX_FACTORY_TEST_CLOSEOUT_DIR).toLowerCase()
    : "";
  return env.CRX_FACTORY_TEST_MODE === "1"
    && path.resolve(paths.stateDir).toLowerCase().startsWith(tempRoot)
    && closeout.startsWith(tempRoot);
}

function markdownCell(value) {
  return String(value || "").replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

function fixedGitHubExecutable() {
  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files\\GitHub CLI\\gh.exe",
        path.join(homedir(), "AppData", "Local", "Programs", "GitHub CLI", "gh.exe"),
      ]
    : ["/usr/bin/gh", "/usr/local/bin/gh"];
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (!resolved) {
    throw new Error("Trusted GitHub CLI executable was not found in a fixed installation location.");
  }
  return resolved;
}

function fixedVercelCliInvocation() {
  const candidates = process.platform === "win32"
    ? [
        path.join(homedir(), "AppData", "Roaming", "npm", "node_modules", "vercel", "dist", "index.js"),
      ]
    : [
        "/usr/local/lib/node_modules/vercel/dist/index.js",
        "/usr/lib/node_modules/vercel/dist/index.js",
      ];
  const script = candidates.find((candidate) => existsSync(candidate));
  if (!script) {
    throw new Error("Trusted Vercel CLI was not found in a fixed installation location.");
  }
  return { executable: process.execPath, prefixArgs: [script] };
}

function runVercelJson(args, { cwd, failureMessage }) {
  const invocation = fixedVercelCliInvocation();
  try {
    return JSON.parse(execFileSync(invocation.executable, [
      ...invocation.prefixArgs,
      ...args,
    ], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    }));
  } catch {
    throw new Error(failureMessage);
  }
}

function newestFirst(left, right) {
  const leftTime = Date.parse(String(left?.created_at || left?.updated_at || "")) || 0;
  const rightTime = Date.parse(String(right?.created_at || right?.updated_at || "")) || 0;
  return rightTime - leftTime || Number(right?.id || 0) - Number(left?.id || 0);
}

export function selectCurrentVercelAliasDeployment(inspection, deployment) {
  const productionHost = new URL(FACTORY_PRODUCTION_URL).hostname.toLowerCase();
  const aliases = Array.isArray(inspection?.aliases)
    ? inspection.aliases.map((item) => String(item).toLowerCase())
    : [];
  const deploymentAliases = Array.isArray(deployment?.alias)
    ? deployment.alias.map((item) => String(item).toLowerCase())
    : [];
  const [expectedOwner, expectedRepo] = FACTORY_GITHUB_REPOSITORY.split("/");
  const sha = String(deployment?.gitSource?.sha || "");
  if (!/^dpl_[A-Za-z0-9]+$/.test(String(inspection?.id || ""))
      || inspection.id !== deployment?.id
      || String(inspection?.target || "").toLowerCase() !== "production"
      || String(inspection?.readyState || "").toUpperCase() !== "READY"
      || !aliases.includes(productionHost)
      || String(deployment?.target || "").toLowerCase() !== "production"
      || String(deployment?.readyState || "").toUpperCase() !== "READY"
      || !deploymentAliases.includes(productionHost)
      || String(deployment?.gitSource?.type || "").toLowerCase() !== "github"
      || String(deployment?.gitSource?.ref || "") !== "main"
      || !/^[a-f0-9]{40}$/i.test(sha)
      || String(deployment?.meta?.githubCommitSha || "") !== sha
      || String(deployment?.meta?.githubCommitOrg || "") !== expectedOwner
      || String(deployment?.meta?.githubCommitRepo || "") !== expectedRepo) {
    throw new Error("The canonical production alias is not bound to a READY main-branch deployment from the governed GitHub repository.");
  }
  return {
    deploymentId: inspection.id,
    deployedCommit: sha,
    deploymentUrl: String(inspection.url || ""),
  };
}

export function selectCurrentProductionDeployment(deployments, statuses, deployedCommit) {
  const deployment = currentProductionDeployment(deployments, deployedCommit);
  return successfulProductionDeployment(deployment, statuses);
}

function successfulProductionDeployment(deployment, statuses) {
  const latestStatus = Array.isArray(statuses) ? [...statuses].sort(newestFirst)[0] : null;
  if (!latestStatus || String(latestStatus.state || "").toLowerCase() !== "success") {
    throw new Error("The newest Production deployment is not currently successful.");
  }
  return { deployment, status: latestStatus };
}

export function currentProductionDeployment(deployments, deployedCommit) {
  if (!/^[a-f0-9]{40}$/i.test(String(deployedCommit || ""))) {
    throw new Error("The Vercel production alias did not identify an exact deployed commit.");
  }
  const deployment = Array.isArray(deployments)
    ? deployments.filter((item) =>
      /^[a-f0-9]{40}$/i.test(String(item?.sha || ""))
      && String(item?.environment || "").toLowerCase() === "production"
      && String(item.sha).toLowerCase() === String(deployedCommit).toLowerCase())
      .sort(newestFirst)[0]
    : null;
  if (!deployment) {
    throw new Error("GitHub has no successful Production deployment record for the commit currently attached to the Vercel production alias.");
  }
  return deployment;
}

export function productionComparisonAccepts(status) {
  return String(status || "").toLowerCase() === "identical";
}

async function verifyProductionLanding({
  cwd,
  landingCommit,
  expectedDeploymentCommit = landingCommit,
  paths,
  env,
}) {
  if (!/^[a-f0-9]{40}$/i.test(String(expectedDeploymentCommit || ""))) {
    throw new Error("Production verification requires the exact commit expected at the canonical alias.");
  }
  if (isIsolatedFactoryTest(paths, env)) {
    return {
      repository: FACTORY_GITHUB_REPOSITORY,
      landingCommit,
      deployedCommit: expectedDeploymentCommit,
      deploymentId: 1,
      deploymentStatusId: 1,
      deploymentState: "success",
      deploymentEnvironment: "Production",
      deploymentUrl: "https://factory-test.example.invalid/deployment",
      vercelDeploymentId: "dpl_factory_test",
      productionUrl: FACTORY_PRODUCTION_URL,
      httpStatus: 200,
    };
  }
  const productionHost = new URL(FACTORY_PRODUCTION_URL).hostname;
  const vercelInspection = runVercelJson([
    "inspect",
    productionHost,
    "--json",
  ], {
    cwd,
    failureMessage: "Could not resolve the deployment currently attached to the canonical Vercel production alias.",
  });
  const vercelDeployment = runVercelJson([
    "api",
    `/v13/deployments/${vercelInspection.id}`,
  ], {
    cwd,
    failureMessage: "Could not read the current canonical Vercel deployment metadata.",
  });
  const currentAlias = selectCurrentVercelAliasDeployment(vercelInspection, vercelDeployment);
  let deployments;
  try {
    deployments = JSON.parse(execFileSync(fixedGitHubExecutable(), [
      "api",
      `repos/${FACTORY_GITHUB_REPOSITORY}/deployments?environment=Production&per_page=50`,
    ], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
    }));
  } catch {
    throw new Error("Could not read current GitHub Production deployment records.");
  }
  const currentProduction = currentProductionDeployment(deployments, currentAlias.deployedCommit);
  if (!currentProduction?.id) {
    throw new Error("GitHub has no Production deployment record for the commit currently attached to the Vercel production alias.");
  }
  let statuses;
  try {
    statuses = JSON.parse(execFileSync(fixedGitHubExecutable(), [
      "api",
      `repos/${FACTORY_GITHUB_REPOSITORY}/deployments/${currentProduction.id}/statuses?per_page=20`,
    ], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
    }));
  } catch {
    throw new Error("Could not read the current Production deployment status.");
  }
  const accepted = successfulProductionDeployment(currentProduction, statuses);
  let comparison;
  try {
    comparison = JSON.parse(execFileSync(fixedGitHubExecutable(), [
      "api",
      `repos/${FACTORY_GITHUB_REPOSITORY}/compare/${expectedDeploymentCommit}...${accepted.deployment.sha}`,
    ], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
    }));
  } catch {
    throw new Error("Could not compare the canonical production deployment to the exact expected commit.");
  }
  if (!productionComparisonAccepts(comparison?.status)) {
    throw new Error("The canonical production alias is not serving the exact expected commit; descendants and reverts do not qualify.");
  }
  let response;
  try {
    response = await fetch(FACTORY_PRODUCTION_URL, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("The canonical production URL could not be reached.");
  }
  if (response.status !== 200) {
    throw new Error(`The canonical production URL returned HTTP ${response.status}, not 200.`);
  }
  return {
    repository: FACTORY_GITHUB_REPOSITORY,
    landingCommit,
    deployedCommit: String(accepted.deployment.sha),
    deploymentId: Number(accepted.deployment.id),
    deploymentStatusId: Number(accepted.status.id),
    deploymentState: "success",
    deploymentEnvironment: String(accepted.deployment.environment),
    deploymentUrl: currentAlias.deploymentUrl
      || String(accepted.status.environment_url || accepted.status.log_url || ""),
    vercelDeploymentId: currentAlias.deploymentId,
    productionUrl: FACTORY_PRODUCTION_URL,
    httpStatus: response.status,
  };
}

function printStatus(snapshot, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: snapshot.schemaVersion,
      held: snapshot.held,
      holdReason: snapshot.holdReason,
      degraded: snapshot.degraded,
      warning: snapshot.warning,
      jobs: snapshot.jobs.map((job) => ({
        id: job.id,
        title: job.title,
        stage: job.stage,
        behaviorSummary: job.behaviorSummary,
        blocker: job.blocker,
        lastActivity: job.lastActivity,
        evidence: job.evidence.map((item) => ({
          label: item.label,
          kind: item.kind,
          sha256: item.sha256,
          verified: item.verified,
          sourceCommand: item.sourceCommand,
        })),
      })),
    }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`CRX Factory: ${snapshot.held ? "PAUSED" : "READY"} · ${snapshot.jobs.length} job(s)\n`);
  if (snapshot.warning) process.stdout.write(`Warning: ${snapshot.warning}\n`);
  for (const job of snapshot.jobs) {
    process.stdout.write(`- ${job.title} [${job.stage}] · ${job.lastActivity}\n`);
    if (job.blocker) process.stdout.write(`  Needs attention: ${job.blocker}\n`);
  }
}

export function resolveRecordedCloseoutPacket(cwd, recordedValue) {
  const raw = String(recordedValue || "").trim();
  const normalized = raw.replace(/\\/g, "/");
  if (path.isAbsolute(raw)
      || !/^docs\/audits\/factory\/jobs\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.md$/.test(normalized)) {
    throw new Error("The ledger-recorded closeout packet path is outside the supported factory closeout directory.");
  }
  const absolute = path.resolve(cwd, normalized);
  const relative = path.relative(cwd, absolute).replace(/\\/g, "/");
  if (relative !== normalized) {
    throw new Error("The ledger-recorded closeout packet path escapes the governed repository.");
  }
  return { absolute, relative };
}

export async function runFactoryCli(argv = process.argv.slice(2), {
  cwd = ROOT,
  env = process.env,
  now = () => new Date(),
} = {}) {
  const { positionals, flags } = parseArgs(argv);
  const [group, action] = positionals;
  const paths = resolveFactoryPaths(cwd, env);

  if (group === "ticket" && action === "draft") {
    const who = actor(paths, flags, env, now().getTime());
    const source = JSON.parse(decodeBase64Text(flags, "ticket-base64", { maxBytes: 100_000, rejectSecrets: false }));
    const snapshot = stableSnapshot(paths, who, { nowMs: now().getTime() });
    const existing = snapshot.jobs.find((candidate) => candidate.id === String(source?.id || ""));
    if (existing) {
      if (existing.sessionId !== who.sessionId || (existing.laneSessionId && existing.laneSessionId !== who.sessionId)) {
        throw new Error(`Factory job ${existing.id} belongs to another chat session.`);
      }
      if (!new Set(["needs-ticket-ok", "rejected", "parked"]).has(existing.stage)) {
        throw new Error(`Factory job ${existing.id} cannot be revised while it is ${existing.stage}.`);
      }
    }
    const written = writeImmutableTicket(paths, source);
    appendAsActor(paths, {
      type: "ticket-drafted",
      jobId: written.ticket.id,
      timestamp: now().toISOString(),
      payload: {
        ticketFile: written.filename,
        ticketHash: written.hash,
        ticketVersion: written.ticket.version,
        title: written.ticket.title,
      },
    }, who);
    process.stdout.write(`${JSON.stringify({
      jobId: written.ticket.id,
      ticketHash: written.hash,
      ticketFile: written.filename,
    })}\n`);
    return 0;
  }

  if (group === "ticket" && action === "present") {
    const who = actor(paths, flags, env, now().getTime());
    const jobId = required(flags, "job");
    const snapshot = stableSnapshot(paths, who);
    const job = snapshot.jobs.find((candidate) => candidate.id === jobId);
    if (!job?.ticketHash) throw new Error(`Draft ticket ${jobId} before presenting it.`);
    if (job.sessionId !== who.sessionId || (job.laneSessionId && job.laneSessionId !== who.sessionId)) {
      throw new Error(`Factory job ${jobId} belongs to another chat session.`);
    }
    if (!new Set(["needs-ticket-ok", "queued", "parked"]).has(job.stage)) {
      throw new Error(`Factory job ${jobId} cannot be presented while it is ${job.stage}.`);
    }
    const questionText = canonicalTicketApprovalQuestion(job.ticket);
    const baseSha = refreshOriginMain(cwd, env);
    const event = appendAsActor(paths, {
      type: "ticket-presented",
      jobId,
      timestamp: now().toISOString(),
      payload: {
        ticketHash: job.ticketHash,
        questionText,
        questionHash: sha256(questionText),
        baseSha,
      },
    }, who);
    process.stdout.write(`${JSON.stringify({
      jobId,
      questionHash: event.payload.questionHash,
      questionText,
      baseSha,
      instruction: "Send the exact question text as the final assistant message. Ask no other question until Mason replies.",
    })}\n`);
    return 0;
  }

  if (group === "lane" && action === "start") {
    const who = actor(paths, flags, env, now().getTime());
    const jobId = required(flags, "job");
    const snapshot = stableSnapshot(paths, who, { nowMs: now().getTime() });
    const baseSha = refreshOriginMain(cwd, env);
    const job = validateLaneStart({
      snapshot,
      jobId,
      sessionId: who.sessionId,
      currentBaseSha: baseSha,
      cwd,
      nowMs: now().getTime(),
    });
    const laneEvent = appendAsActor(paths, {
      type: "lane-started",
      jobId,
      timestamp: now().toISOString(),
      payload: {
        ticketHash: job.ticketHash,
        baseSha,
        worktree: path.resolve(cwd),
      },
    }, who, snapshot.lastEventHash);
    appendAsActor(paths, {
      type: "factory-intent-cleared",
      jobId: null,
      timestamp: now().toISOString(),
      payload: { reason: `Lane ${jobId} started.` },
    }, who, laneEvent.eventHash);
    process.stdout.write(`FACTORY LANE STARTED — ${job.title}\n`);
    return 0;
  }

  if (group === "review" && action === "present") {
    const who = actor(paths, flags, env, now().getTime());
    const jobId = required(flags, "job");
    const snapshot = stableSnapshot(paths, who, { nowMs: now().getTime() });
    const job = snapshot.jobs.find((candidate) => candidate.id === jobId);
    if (!job || job.stage !== "awaiting-morning-review") {
      throw new Error(`Job ${jobId} must be awaiting morning review before its decision question is presented.`);
    }
    if (job.sessionId !== who.sessionId) {
      throw new Error(`Factory job ${jobId} belongs to another chat session.`);
    }
    const questionText = canonicalMorningReviewQuestion(job);
    const baseSha = refreshOriginMain(cwd, env);
    if (baseSha !== job.baseSha) {
      throw new Error("origin/main moved after ticket approval; park and re-present the ticket before morning review.");
    }
    validateCurrentHarnessEvidence(job, cwd, { paths });
    validateCurrentIndependentReview(job, cwd, { paths });
    const presentedAt = now();
    appendAsActor(paths, {
      type: "review-presented",
      jobId,
      timestamp: presentedAt.toISOString(),
      payload: {
        ticketHash: job.ticketHash,
        questionText,
        questionHash: sha256(questionText),
        baseSha,
        expiresAt: new Date(presentedAt.getTime() + APPROVAL_TTL_MS).toISOString(),
      },
    }, who);
    process.stdout.write(`${JSON.stringify({
      jobId,
      questionHash: sha256(questionText),
      questionText,
      instruction: "Send the exact review question as the final assistant message. Ask no other question until Mason replies.",
    })}\n`);
    return 0;
  }

  if (group === "review" && action === "run") {
    const who = actor(paths, flags, env, now().getTime());
    const jobId = required(flags, "job");
    const snapshot = stableSnapshot(paths, who, { nowMs: now().getTime() });
    const job = validateLaneActor(snapshot, jobId, who.sessionId, {
      allowedStages: new Set(["in-review"]),
    });
    const review = runIndependentReviewEvidence(paths, { job, cwd, env });
    try {
      appendAsActor(paths, {
        type: "independent-review-attached",
        jobId,
        timestamp: now().toISOString(),
        payload: review,
      }, who, who.expectedLastEventHash, { requireFactoryRunning: true });
    } catch (error) {
      try { unlinkSync(path.join(paths.evidenceDir, jobId, review.filename)); } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") {
          process.stderr.write(`Factory cleanup warning: could not remove unattached independent-review evidence (${cleanupError?.message || cleanupError}).\n`);
        }
      }
      throw error;
    }
    process.stdout.write(`${JSON.stringify({
      jobId,
      reviewer: review.reviewer,
      model: review.model,
      reasoningEffort: review.reasoningEffort,
      verdict: review.verdict,
      sha256: review.sha256,
    })}\n`);
    return 0;
  }

  if (group === "stage" && !action) {
    const who = actor(paths, flags, env, now().getTime());
    const jobId = required(flags, "job");
    const stage = required(flags, "stage");
    const behaviorSummary = flags.get("summary-base64") ? decodeBase64Text(flags, "summary-base64") : "";
    const blocker = flags.get("blocker-base64") ? decodeBase64Text(flags, "blocker-base64") : "";
    const snapshot = stableSnapshot(paths, who, { nowMs: now().getTime() });
    if (stage === "awaiting-morning-review") refreshOriginMain(cwd, env);
    validateStageChange(snapshot, jobId, stage, { sessionId: who.sessionId, cwd, behaviorSummary, blocker });
    appendAsActor(paths, {
      type: "job-stage",
      jobId,
      timestamp: now().toISOString(),
      payload: {
        stage,
        behaviorSummary,
        blocker,
      },
    }, who);
    process.stdout.write(`FACTORY STAGE — ${jobId}: ${stage}\n`);
    return 0;
  }

  if (group === "evidence" && action === "run") {
    const who = actor(paths, flags, env, now().getTime());
    const jobId = required(flags, "job");
    const harness = required(flags, "harness");
    const evidence = runAndAttachHarnessEvidence(paths, {
      jobId,
      label: required(flags, "label"),
      scriptName: harness,
      sessionId: who.sessionId,
      actorTool: who.actorTool,
      expectedLastEventHash: who.expectedLastEventHash,
      currentBaseSha: refreshOriginMain(cwd, env),
      cwd,
      now,
    });
    process.stdout.write(`${JSON.stringify({
      jobId,
      label: evidence.label,
      filename: evidence.filename,
      sha256: evidence.sha256,
      sourceCommand: evidence.sourceCommand,
    })}\n`);
    return 0;
  }

  if (group === "closeout" && action === "write") {
    const who = actor(paths, flags, env, now().getTime());
    const jobId = required(flags, "job");
    const requestedLandingCommit = required(flags, "landing-commit");
    git(["cat-file", "-e", `${requestedLandingCommit}^{commit}`], cwd);
    const landingCommit = git(["rev-parse", `${requestedLandingCommit}^{commit}`], cwd);
    const snapshot = stableSnapshot(paths, who, { nowMs: now().getTime() });
    const job = snapshot.jobs.find((candidate) => candidate.id === jobId);
    if (!job) {
      throw new Error(`Job ${jobId} must have Mason's morning acceptance before closeout.`);
    }
    if (job.sessionId !== who.sessionId) {
      throw new Error(`Job ${jobId} morning acceptance is bound to another chat session.`);
    }
    if (job.stage === "live") {
      if (job.landingCommit !== landingCommit) {
        throw new Error(`Job ${jobId} is already live with a different closeout record.`);
      }
      const { absolute: recordedPath } = resolveRecordedCloseoutPacket(cwd, job.closeoutPacket);
      if (!existsSync(recordedPath)) {
        throw new Error(`Job ${jobId} is live but its recorded closeout packet is missing.`);
      }
      const recordedHash = sha256(readFileSync(recordedPath));
      if (recordedHash !== job.closeoutPacketHash) {
        throw new Error(`Job ${jobId} closeout packet hash no longer matches the ledger.`);
      }
      process.stdout.write(`${JSON.stringify({
        jobId,
        closeoutPacket: recordedPath,
        closeoutPacketHash: recordedHash,
        closeoutCommit: job.closeoutCommit,
        alreadyClosed: true,
      })}\n`);
      return 0;
    }
    if (job.stage !== "approved-to-land") {
      throw new Error(`Job ${jobId} must have Mason's morning acceptance before closeout.`);
    }
    if (!isIsolatedFactoryTest(paths, env)) {
      refreshOriginMain(cwd, env);
      try {
        git(["merge-base", "--is-ancestor", landingCommit, "origin/main"], cwd);
      } catch {
        throw new Error("Landing commit is not contained in the current origin/main.");
      }
    }
    const landing = repositoryCommitFingerprint(cwd, landingCommit);
    const acceptedEvidence = validateCurrentHarnessEvidence(job, cwd, {
      requireCurrentBase: false,
      paths,
      repositoryFingerprint: landing,
    });
    const acceptedReview = validateCurrentIndependentReview(job, cwd, {
      paths,
      repositoryFingerprint: landing,
    });
    if (acceptedEvidence.some((item) =>
      item.repositoryContentHash !== landing.repositoryContentHash
      || Number(item.repositoryFileCount) !== landing.repositoryFileCount)) {
      throw new Error("Landing commit does not contain the exact repository content bound to the accepted harness proof.");
    }

    if (job.closeoutPacketHash) {
      if (job.landingCommit !== landingCommit) {
        throw new Error(`Job ${jobId} has a closeout packet for a different landing commit.`);
      }
      const { absolute: recordedPath, relative: relativePacket } = resolveRecordedCloseoutPacket(cwd, job.closeoutPacket);
      if (!existsSync(recordedPath) || sha256(readFileSync(recordedPath)) !== job.closeoutPacketHash) {
        throw new Error(`Job ${jobId} closeout packet is missing or no longer matches the ledger.`);
      }
      let landedPacket;
      try {
        landedPacket = execFileSync("git", ["show", `origin/main:${relativePacket}`], {
          cwd,
          encoding: "buffer",
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        throw new Error("The exact closeout packet must be committed and contained in origin/main before live.");
      }
      if (sha256(landedPacket) !== job.closeoutPacketHash) {
        throw new Error("The closeout packet in origin/main does not match the ledger-bound packet bytes.");
      }
      const closeoutCommit = git(["log", "-1", "--format=%H", "origin/main", "--", relativePacket], cwd);
      if (!closeoutCommit) {
        throw new Error("Could not resolve the origin/main commit containing the closeout packet.");
      }
      const productionVerification = await verifyProductionLanding({
        cwd,
        landingCommit,
        expectedDeploymentCommit: closeoutCommit,
        paths,
        env,
      });
      appendAsActor(paths, {
        type: "job-stage",
        jobId,
        timestamp: now().toISOString(),
        payload: {
          stage: "live",
          behaviorSummary: job.behaviorSummary,
          blocker: "",
          landingCommit,
          productionVerification,
          closeoutPacket: relativePacket,
          closeoutPacketHash: job.closeoutPacketHash,
          closeoutCommit,
        },
      }, who, snapshot.lastEventHash);
      process.stdout.write(`${JSON.stringify({
        jobId,
        closeoutPacket: recordedPath,
        closeoutPacketHash: job.closeoutPacketHash,
        closeoutCommit,
        live: true,
      })}\n`);
      return 0;
    }

    const productionVerification = await verifyProductionLanding({
      cwd,
      landingCommit,
      paths,
      env,
    });
    const rows = job.evidence.map((item) =>
      `| ${markdownCell(item.label)} | ${markdownCell(item.kind)} | \`${item.sha256}\` |`,
    ).join("\n");
    const reviewRows = job.reviews.map((item) =>
      `| ${markdownCell(item.reviewer)} | ${markdownCell(item.model)} | ${markdownCell(item.verdict)} | \`${item.sha256}\` |`,
    ).join("\n");
    const body = [
      `# Factory Job Closeout — ${job.title}`,
      "",
      `- Job: \`${job.id}\``,
      `- Ticket hash: \`${job.ticketHash}\``,
      `- Approval reply: ${markdownCell(job.approvalReply)}`,
      `- Approved base: \`${job.baseSha}\``,
      `- Behavior result: ${markdownCell(job.behaviorSummary)}`,
      `- Landing commit: \`${landingCommit}\``,
      "- Landing ancestry: verified contained in `origin/main` before this packet was prepared",
      `- Pre-closeout ledger checkpoint: \`${snapshot.lastEventHash}\``,
      "",
      "## Production verification",
      "",
      `- GitHub repository: \`${productionVerification.repository}\``,
      `- Vercel deployment currently attached to the canonical alias: \`${productionVerification.vercelDeploymentId}\``,
      `- Matching GitHub Production deployment: \`${productionVerification.deploymentId}\``,
      `- Alias-bound deployed commit: \`${productionVerification.deployedCommit}\` (exact expected commit for this closeout phase)`,
      `- Deployment status: \`${productionVerification.deploymentState}\` (status \`${productionVerification.deploymentStatusId}\`)`,
      `- Canonical URL: ${productionVerification.productionUrl}`,
      `- Canonical URL response: HTTP ${productionVerification.httpStatus}`,
      "",
      "## Proof manifest",
      "",
      "| Proof | Kind | SHA-256 |",
      "|---|---|---|",
      rows,
      "",
      "## Independent review manifest",
      "",
      "| Reviewer | Model | Verdict | SHA-256 |",
      "|---|---|---|---|",
      reviewRows,
      "",
      "This packet records evidence; it does not replace the existing `/ship` review, PR, deployment, migration, or destructive-action gates.",
      "The job remains `approved-to-land` until these exact packet bytes are committed into `origin/main` and production is rechecked.",
      "",
    ].join("\n");
    const outputDir = closeoutDirectory(cwd, env);
    mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `${job.id}.md`);
    const packetHash = sha256(body);
    if (existsSync(outputPath)) {
      const existing = readFileSync(outputPath, "utf8");
      if (existing !== body) {
        throw new Error(`A different closeout packet already exists for job ${jobId}.`);
      }
    } else {
      writeFileSync(outputPath, body, { encoding: "utf8", flag: "wx" });
    }
    appendAsActor(paths, {
      type: "closeout-prepared",
      jobId,
      timestamp: now().toISOString(),
      payload: {
        landingCommit,
        productionVerification,
        closeoutPacket: path.relative(cwd, outputPath).replace(/\\/g, "/"),
        closeoutPacketHash: packetHash,
        ledgerCheckpointHash: snapshot.lastEventHash,
        independentReviewHash: acceptedReview.sha256,
      },
    }, who, snapshot.lastEventHash);
    process.stdout.write(`${JSON.stringify({
      jobId,
      closeoutPacket: outputPath,
      closeoutPacketHash: packetHash,
      prepared: true,
      live: false,
    })}\n`);
    return 0;
  }

  if (group === "recover" && ["unlock", "torn-tail"].includes(action)) {
    const who = actor(paths, flags, env, now().getTime(), { recovery: true });
    const reason = decodeBase64Text(flags, "reason-base64");
    const recovered = recoverFactoryState(paths, { mode: action, reason, nowMs: now().getTime() });
    const recoveredSnapshot = loadFactorySnapshot(paths, { nowMs: now().getTime() });
    appendAsActor(paths, {
      type: "factory-recovered",
      jobId: null,
      timestamp: now().toISOString(),
      payload: {
        mode: recovered.mode,
        reason,
        backup: path.basename(recovered.backup),
      },
    }, who, recoveredSnapshot.lastEventHash);
    process.stdout.write(`FACTORY RECOVERED — ${action}; backup ${recovered.backup}\n`);
    return 0;
  }

  if (group === "status" && !action) {
    printStatus(buildFactorySnapshot(paths, { nowMs: now().getTime() }), flags.get("json") === true);
    return 0;
  }

  usage();
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === path.resolve(fileURLToPath(import.meta.url))) {
  Promise.resolve().then(() => {
    let directCwd = ROOT;
    if (process.env.CRX_FACTORY_TEST_REPO_DIR) {
      const candidate = path.resolve(process.env.CRX_FACTORY_TEST_REPO_DIR);
      const tempRoot = `${path.resolve(tmpdir()).toLowerCase()}${path.sep}`;
      if (process.env.CRX_FACTORY_TEST_MODE !== "1"
          || !candidate.toLowerCase().startsWith(tempRoot)) {
        throw new Error("CRX_FACTORY_TEST_REPO_DIR is restricted to isolated temporary test repositories.");
      }
      directCwd = candidate;
    }
    return runFactoryCli(process.argv.slice(2), { cwd: directCwd, env: process.env });
  }).catch((error) => {
    process.stderr.write(`FACTORY BLOCKED: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export { APPROVAL_TTL_MS };
