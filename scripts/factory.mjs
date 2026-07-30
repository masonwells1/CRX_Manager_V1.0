#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVAL_TTL_MS,
  appendFactoryEvent,
  buildFactorySnapshot,
  consumeFactoryCliPermit,
  currentOriginMain,
  loadFactorySnapshot,
  normalizeOwnerQuestion,
  recoverFactoryState,
  rejectSecretBearingText,
  repositoryCommitFingerprint,
  resolveFactoryPaths,
  runHarnessEvidence,
  sha256,
  validateLaneActor,
  validateLaneStart,
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
    "  node scripts/factory.mjs ticket present --job <id> --question-file <text>",
    "  node scripts/factory.mjs lane start --job <id>",
    "  node scripts/factory.mjs review present --job <id> --question-file <text>",
    "  node scripts/factory.mjs stage --job <id> --stage <stage> [--summary-file <text>] [--blocker-file <text>]",
    "  node scripts/factory.mjs evidence run --job <id> --harness <npm-script> --label <text>",
    "  node scripts/factory.mjs closeout write --job <id> --landing-commit <sha> --production-proof <text>",
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

function productionProofText(value) {
  const proof = String(value || "").trim();
  if (!proof || proof.length > 4_000) {
    throw new Error("Production verification text must be between 1 and 4,000 characters.");
  }
  if (/[\0\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(proof)) {
    throw new Error("Production verification text contains unsupported control characters.");
  }
  return rejectSecretBearingText(proof, "Production verification text");
}

function markdownCell(value) {
  return String(value || "").replaceAll("|", "\\|").replace(/\r?\n/g, " ");
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
    const questionText = normalizeOwnerQuestion(readTextFile(required(flags, "question-file")));
    if (!questionText.endsWith("?")) throw new Error("Ticket approval question must end with a question mark.");
    const snapshot = loadFactorySnapshot(paths);
    const job = snapshot.jobs.find((candidate) => candidate.id === jobId);
    if (!job?.ticketHash) throw new Error(`Draft ticket ${jobId} before presenting it.`);
    const baseSha = currentOriginMain(cwd);
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
      baseSha,
      instruction: "Send the exact question text as the final assistant message. Ask no other question until Mason replies.",
    })}\n`);
    return 0;
  }

  if (group === "lane" && action === "start") {
    const who = actor(paths, flags, env, now().getTime());
    const jobId = required(flags, "job");
    const snapshot = loadFactorySnapshot(paths, { nowMs: now().getTime() });
    const baseSha = currentOriginMain(cwd);
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
    const questionText = normalizeOwnerQuestion(readTextFile(required(flags, "question-file")));
    if (!questionText.endsWith("?")) throw new Error("Morning review question must end with a question mark.");
    const snapshot = loadFactorySnapshot(paths, { nowMs: now().getTime() });
    const job = snapshot.jobs.find((candidate) => candidate.id === jobId);
    if (!job || job.stage !== "awaiting-morning-review") {
      throw new Error(`Job ${jobId} must be awaiting morning review before its decision question is presented.`);
    }
    appendFactoryEvent(paths, {
      type: "review-presented",
      jobId,
      ...who,
      timestamp: now().toISOString(),
      payload: {
        ticketHash: job.ticketHash,
        questionText,
        questionHash: sha256(questionText),
        baseSha: currentOriginMain(cwd),
        expiresAt: new Date(now().getTime() + APPROVAL_TTL_MS).toISOString(),
      },
    });
    process.stdout.write(`${JSON.stringify({
      jobId,
      questionHash: sha256(questionText),
      instruction: "Send the exact review question as the final assistant message. Ask no other question until Mason replies.",
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
    if (job.baseSha !== currentOriginMain(cwd)) {
      throw new Error("origin/main moved after ticket approval; park and re-present the job before minting proof.");
    }
    const harness = required(flags, "harness");
    if (!job.ticket?.proofHarnesses?.includes(harness)) {
      throw new Error(`Harness ${harness} was not approved in mission ticket ${jobId}.`);
    }
    const evidence = runHarnessEvidence(paths, {
      jobId,
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
    const landingCommit = required(flags, "landing-commit");
    const productionProof = productionProofText(required(flags, "production-proof"));
    const snapshot = loadFactorySnapshot(paths, { nowMs: now().getTime() });
    const job = snapshot.jobs.find((candidate) => candidate.id === jobId);
    if (!job) {
      throw new Error(`Job ${jobId} must have Mason's morning acceptance before closeout.`);
    }
    if (job.sessionId !== who.sessionId) {
      throw new Error(`Job ${jobId} morning acceptance is bound to another chat session.`);
    }
    if (job.stage === "live") {
      if (job.landingCommit !== landingCommit || job.productionProof !== productionProof) {
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
        alreadyClosed: true,
      })}\n`);
      return 0;
    }
    if (job.stage !== "approved-to-land") {
      throw new Error(`Job ${jobId} must have Mason's morning acceptance before closeout.`);
    }
    git(["cat-file", "-e", `${landingCommit}^{commit}`], cwd);
    if (!isIsolatedFactoryTest(paths, env)) {
      try {
        git(["merge-base", "--is-ancestor", landingCommit, "origin/main"], cwd);
      } catch {
        throw new Error("Landing commit is not contained in the current origin/main.");
      }
    }
    if (!productionProof) throw new Error("Production verification text is required.");
    const acceptedEvidence = validateCurrentHarnessEvidence(job, cwd, { requireCurrentBase: false });
    const landing = repositoryCommitFingerprint(cwd, landingCommit);
    if (acceptedEvidence.repositoryContentHash !== landing.repositoryContentHash
        || Number(acceptedEvidence.repositoryFileCount) !== landing.repositoryFileCount) {
      throw new Error("Landing commit does not contain the exact repository content bound to the accepted harness proof.");
    }

    const rows = job.evidence.map((item) =>
      `| ${markdownCell(item.label)} | ${markdownCell(item.kind)} | \`${item.sha256}\` |`,
    ).join("\n");
    const body = [
      `# Factory Job Closeout — ${job.title}`,
      "",
      `- Job: \`${job.id}\``,
      `- Ticket hash: \`${job.ticketHash}\``,
      `- Approval reply: ${markdownCell(job.approvalReply)}`,
      `- Behavior result: ${markdownCell(job.behaviorSummary)}`,
      `- Landing commit: \`${landingCommit}\``,
      "- Landing ancestry: verified contained in `origin/main` before this packet was recorded",
      "",
      "## Production verification",
      "",
      productionProof,
      "",
      "## Proof manifest",
      "",
      "| Proof | Kind | SHA-256 |",
      "|---|---|---|",
      rows,
      "",
      "This packet records evidence; it does not replace the existing `/ship` review, PR, deployment, migration, or destructive-action gates.",
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
      type: "job-stage",
      jobId,
      ...who,
      timestamp: now().toISOString(),
      payload: {
        stage: "live",
        behaviorSummary: job.behaviorSummary,
        blocker: "",
        landingCommit,
        productionProof,
        closeoutPacket: path.relative(cwd, outputPath).replace(/\\/g, "/"),
        closeoutPacketHash: packetHash,
      },
    });
    process.stdout.write(`${JSON.stringify({ jobId, closeoutPacket: outputPath, closeoutPacketHash: packetHash })}\n`);
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
