#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  resolveFactoryPaths,
  runHarnessEvidence,
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
    "  node scripts/factory.mjs ticket draft --file <ticket.json>",
    "  node scripts/factory.mjs ticket present --job <id>",
    "  node scripts/factory.mjs lane start --job <id>",
    "  node scripts/factory.mjs review run --job <id>",
    "  node scripts/factory.mjs review present --job <id>",
    "  node scripts/factory.mjs stage --job <id> --stage <stage> [--summary-file <text>] [--blocker-file <text>]",
    "  node scripts/factory.mjs evidence run --job <id> --harness <npm-script> --label <text>",
    "  node scripts/factory.mjs closeout write --job <id> --landing-commit <sha>",
    "  node scripts/factory.mjs recover <unlock|torn-tail> --reason-file <text>",
    "  node scripts/factory.mjs status [--json]",
  ].join("\n") + "\n");
  process.exit(2);
}

function parseArgs(argv) {
  const positionals = [];
  const flags = new Map();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
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

function actor(paths, flags, env, nowMs) {
  const who = consumeFactoryCliPermit(paths, env.CRX_FACTORY_PERMIT, { nowMs });
  const claimedTool = String(flags.get("tool") || "").toLowerCase();
  const claimedSession = String(flags.get("session") || "");
  if (claimedTool && claimedTool !== who.actorTool) {
    throw new Error("--tool does not match the trusted PreToolUse identity.");
  }
  if (claimedSession && claimedSession !== who.sessionId) {
    throw new Error("--session does not match the trusted PreToolUse identity.");
  }
  return who;
}

function readTextFile(filename) {
  return readFileSync(path.resolve(filename), "utf8").trim();
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

async function verifyProductionLanding({ cwd, landingCommit, paths, env }) {
  if (isIsolatedFactoryTest(paths, env)) {
    return {
      repository: FACTORY_GITHUB_REPOSITORY,
      landingCommit,
      deploymentId: 1,
      deploymentStatusId: 1,
      deploymentState: "success",
      deploymentEnvironment: "Production",
      deploymentUrl: "https://factory-test.example.invalid/deployment",
      productionUrl: FACTORY_PRODUCTION_URL,
      httpStatus: 200,
    };
  }
  let deployments;
  try {
    deployments = JSON.parse(execFileSync(fixedGitHubExecutable(), [
      "api",
      `repos/${FACTORY_GITHUB_REPOSITORY}/deployments?sha=${landingCommit}&per_page=20`,
    ], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
    }));
  } catch {
    throw new Error("Could not read GitHub deployment records for the exact landing commit.");
  }
  const productionDeployments = Array.isArray(deployments)
    ? deployments.filter((item) =>
      item?.sha === landingCommit
      && String(item?.environment || "").toLowerCase() === "production")
    : [];
  let accepted = null;
  for (const deployment of productionDeployments) {
    let statuses;
    try {
      statuses = JSON.parse(execFileSync(fixedGitHubExecutable(), [
        "api",
        `repos/${FACTORY_GITHUB_REPOSITORY}/deployments/${deployment.id}/statuses?per_page=20`,
      ], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 30_000,
      }));
    } catch {
      continue;
    }
    const success = Array.isArray(statuses)
      ? statuses.find((status) => String(status?.state || "").toLowerCase() === "success")
      : null;
    if (success) {
      accepted = { deployment, status: success };
      break;
    }
  }
  if (!accepted) {
    throw new Error("The exact landing commit has no successful GitHub Production deployment.");
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
    deploymentId: Number(accepted.deployment.id),
    deploymentStatusId: Number(accepted.status.id),
    deploymentState: "success",
    deploymentEnvironment: String(accepted.deployment.environment),
    deploymentUrl: String(accepted.status.environment_url || accepted.status.log_url || ""),
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
    const source = JSON.parse(readFileSync(path.resolve(required(flags, "file")), "utf8"));
    const written = writeImmutableTicket(paths, source);
    appendFactoryEvent(paths, {
      type: "ticket-drafted",
      jobId: written.ticket.id,
      ...who,
      timestamp: now().toISOString(),
      payload: {
        ticketFile: written.filename,
        ticketHash: written.hash,
        ticketVersion: written.ticket.version,
        title: written.ticket.title,
      },
    });
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
    const snapshot = loadFactorySnapshot(paths);
    const job = snapshot.jobs.find((candidate) => candidate.id === jobId);
    if (!job?.ticketHash) throw new Error(`Draft ticket ${jobId} before presenting it.`);
    const questionText = canonicalTicketApprovalQuestion(job.ticket);
    const baseSha = refreshOriginMain(cwd, env);
    const event = appendFactoryEvent(paths, {
      type: "ticket-presented",
      jobId,
      ...who,
      timestamp: now().toISOString(),
      payload: {
        ticketHash: job.ticketHash,
        questionText,
        questionHash: sha256(questionText),
        baseSha,
      },
    });
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
    const snapshot = loadFactorySnapshot(paths, { nowMs: now().getTime() });
    const baseSha = refreshOriginMain(cwd, env);
    const job = validateLaneStart({
      snapshot,
      jobId,
      sessionId: who.sessionId,
      currentBaseSha: baseSha,
      nowMs: now().getTime(),
    });
    appendFactoryEvent(paths, {
      type: "lane-started",
      jobId,
      ...who,
      timestamp: now().toISOString(),
      payload: {
        ticketHash: job.ticketHash,
        baseSha,
        worktree: path.resolve(cwd),
      },
    }, { expectedLastEventHash: snapshot.lastEventHash });
    appendFactoryEvent(paths, {
      type: "factory-intent-cleared",
      jobId: null,
      ...who,
      timestamp: now().toISOString(),
      payload: { reason: `Lane ${jobId} started.` },
    });
    process.stdout.write(`FACTORY LANE STARTED — ${job.title}\n`);
    return 0;
  }

  if (group === "review" && action === "present") {
    const who = actor(paths, flags, env, now().getTime());
    const jobId = required(flags, "job");
    const snapshot = loadFactorySnapshot(paths, { nowMs: now().getTime() });
    const job = snapshot.jobs.find((candidate) => candidate.id === jobId);
    if (!job || job.stage !== "awaiting-morning-review") {
      throw new Error(`Job ${jobId} must be awaiting morning review before its decision question is presented.`);
    }
    const questionText = canonicalMorningReviewQuestion(job);
    const baseSha = refreshOriginMain(cwd, env);
    if (baseSha !== job.baseSha) {
      throw new Error("origin/main moved after ticket approval; park and re-present the ticket before morning review.");
    }
    validateCurrentHarnessEvidence(job, cwd, { paths });
    validateCurrentIndependentReview(job, cwd, { paths });
    appendFactoryEvent(paths, {
      type: "review-presented",
      jobId,
      ...who,
      timestamp: now().toISOString(),
      payload: {
        ticketHash: job.ticketHash,
        questionText,
        questionHash: sha256(questionText),
        baseSha,
        expiresAt: new Date(now().getTime() + APPROVAL_TTL_MS).toISOString(),
      },
    });
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
    const snapshot = loadFactorySnapshot(paths, { nowMs: now().getTime() });
    const job = validateLaneActor(snapshot, jobId, who.sessionId, {
      allowedStages: new Set(["in-review"]),
    });
    const review = runIndependentReviewEvidence(paths, { job, cwd, env });
    appendFactoryEvent(paths, {
      type: "independent-review-attached",
      jobId,
      ...who,
      timestamp: now().toISOString(),
      payload: review,
    });
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
    const behaviorSummary = flags.get("summary-file") ? readTextFile(flags.get("summary-file")) : "";
    const blocker = flags.get("blocker-file") ? readTextFile(flags.get("blocker-file")) : "";
    const snapshot = loadFactorySnapshot(paths, { nowMs: now().getTime() });
    if (stage === "awaiting-morning-review") refreshOriginMain(cwd, env);
    validateStageChange(snapshot, jobId, stage, { sessionId: who.sessionId, cwd, behaviorSummary, blocker });
    appendFactoryEvent(paths, {
      type: "job-stage",
      jobId,
      ...who,
      timestamp: now().toISOString(),
      payload: {
        stage,
        behaviorSummary,
        blocker,
      },
    });
    process.stdout.write(`FACTORY STAGE — ${jobId}: ${stage}\n`);
    return 0;
  }

  if (group === "evidence" && action === "run") {
    const who = actor(paths, flags, env, now().getTime());
    const jobId = required(flags, "job");
    const snapshot = loadFactorySnapshot(paths, { nowMs: now().getTime() });
    const job = validateLaneActor(snapshot, jobId, who.sessionId);
    if (job.baseSha !== refreshOriginMain(cwd, env)) {
      throw new Error("origin/main moved after ticket approval; park and re-present the job before minting proof.");
    }
    const harness = required(flags, "harness");
    if (!job.ticket?.proofHarnesses?.includes(harness)) {
      throw new Error(`Harness ${harness} was not approved in mission ticket ${jobId}.`);
    }
    const evidence = runHarnessEvidence(paths, {
      jobId,
      ticketHash: job.ticketHash,
      label: required(flags, "label"),
      scriptName: harness,
      cwd,
    });
    appendFactoryEvent(paths, {
      type: "evidence-attached",
      jobId,
      ...who,
      timestamp: now().toISOString(),
      payload: {
        label: evidence.label,
        kind: evidence.kind,
        filename: evidence.filename,
        sha256: evidence.sha256,
        verified: true,
        sourceCommand: evidence.sourceCommand,
        scriptName: evidence.scriptName,
        scriptBodyHash: evidence.scriptBodyHash,
        baseScriptBodyHash: evidence.baseScriptBodyHash,
        baseSha: evidence.baseSha,
        packageJsonHash: evidence.packageJsonHash,
        headSha: evidence.headSha,
        headTreeSha: evidence.headTreeSha,
        repositoryContentHash: evidence.repositoryContentHash,
        repositoryFileCount: evidence.repositoryFileCount,
        ticketHash: evidence.ticketHash,
        sandbox: evidence.sandbox,
      },
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
    const snapshot = loadFactorySnapshot(paths, { nowMs: now().getTime() });
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
      const recordedPath = path.resolve(cwd, job.closeoutPacket);
      if (!job.closeoutPacket || !existsSync(recordedPath)) {
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
      const recordedPath = path.resolve(cwd, job.closeoutPacket);
      if (!existsSync(recordedPath) || sha256(readFileSync(recordedPath)) !== job.closeoutPacketHash) {
        throw new Error(`Job ${jobId} closeout packet is missing or no longer matches the ledger.`);
      }
      const relativePacket = path.relative(cwd, recordedPath).replace(/\\/g, "/");
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
        paths,
        env,
      });
      appendFactoryEvent(paths, {
        type: "job-stage",
        jobId,
        ...who,
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
      });
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
      `- Exact-SHA Production deployment: \`${productionVerification.deploymentId}\``,
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
    appendFactoryEvent(paths, {
      type: "closeout-prepared",
      jobId,
      ...who,
      timestamp: now().toISOString(),
      payload: {
        landingCommit,
        productionVerification,
        closeoutPacket: path.relative(cwd, outputPath).replace(/\\/g, "/"),
        closeoutPacketHash: packetHash,
        ledgerCheckpointHash: snapshot.lastEventHash,
        independentReviewHash: acceptedReview.sha256,
      },
    });
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
    const who = actor(paths, flags, env, now().getTime());
    const reason = readTextFile(required(flags, "reason-file"));
    const recovered = recoverFactoryState(paths, { mode: action, reason, nowMs: now().getTime() });
    appendFactoryEvent(paths, {
      type: "factory-recovered",
      jobId: null,
      ...who,
      timestamp: now().toISOString(),
      payload: {
        mode: recovered.mode,
        reason,
        backup: path.basename(recovered.backup),
      },
    });
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
