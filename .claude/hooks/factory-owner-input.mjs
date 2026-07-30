#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMachineGenerated } from "./prompt-source-lib.mjs";
import {
  APPROVAL_TTL_MS,
  appendFactoryEvent,
  clearEmergencyFactoryHold,
  loadFactorySnapshot,
  normalizeOwnerQuestion,
  pendingTicketForSession,
  pendingReviewForSession,
  refreshOriginMain,
  resolveHookFactoryPaths,
  setEmergencyFactoryHold,
  sha256,
} from "../../scripts/factory-state-lib.mjs";

function emit(additionalContext = "") {
  if (additionalContext) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext,
      },
    }));
  }
  process.exit(0);
}

function contentText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string" || Array.isArray(value.content)) return contentText(value.content);
  if (value.message) return contentText(value.message);
  if (value.payload) return contentText(value.payload);
  return "";
}

export function lastAssistantText(transcriptPath) {
  if (!transcriptPath) return "";
  let lines;
  try {
    lines = readFileSync(transcriptPath, "utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    return "";
  }
  for (let index = lines.length - 1; index >= 0; index--) {
    let entry;
    try { entry = JSON.parse(lines[index]); } catch { continue; }
    const role = String(
      entry.role
      || entry.message?.role
      || entry.payload?.role
      || (entry.type === "assistant" ? "assistant" : ""),
    ).toLowerCase();
    if (role !== "assistant") continue;
    const text = contentText(entry.message?.content ?? entry.content ?? entry.payload?.content ?? entry.message ?? entry.payload);
    if (text.trim()) return normalizeOwnerQuestion(text);
  }
  return "";
}

export function classifyOwnerReply(prompt) {
  const text = String(prompt || "").trim();
  if (/^(?:yes(?:[,\s]+(?:please|ship it|go ahead|do it))?|approved|approve it|go ahead|do it)[.!]?$/i.test(text)) return "approve";
  if (/^(?:no|no thanks|reject|reject it|do not proceed|don't proceed|stop)[.!]?$/i.test(text)) return "reject";
  if (/\b(?:yes|approved|approve|go ahead|do it)\b/i.test(text)
      && /\b(?:but|except|unless|only if|change|instead|without|don'?t)\b/i.test(text)) {
    return "revise";
  }
  return "other";
}

function looksLikeDecisionReply(prompt) {
  return /\b(?:yes|no|approve|approved|reject|ship|proceed|okay|ok|looks?\s+good|sounds?\s+(?:good|reasonable))\b/i
    .test(String(prompt || ""));
}

function holdIntent(prompt) {
  const text = String(prompt || "").toLowerCase()
    .replace(/\bfactory\s+board(?:\s+server)?\b/g, "board");
  if (/\b(?:stop|pause|hold)\b.{0,30}\bfactory\b|\bfactory\b.{0,30}\b(?:stop|pause|hold)\b/.test(text)) return "hold";
  const resumeIntent = /\b(?:resume|restart)\b.{0,30}\bfactory\b|\bfactory\b.{0,30}\b(?:resume|restart)\b/.test(text);
  const negatedResume = /\b(?:do not|don'?t|never|not|can'?t|cannot|shouldn'?t|mustn'?t)\b.{0,30}\b(?:resume|restart)\b|\b(?:resume|restart)\b.{0,20}\b(?:not|never)\b/.test(text);
  if (resumeIntent && !negatedResume) return "resume";
  return "";
}

function intentClearIntent(prompt) {
  const text = String(prompt || "").toLowerCase();
  return [
    /\bnever\s*mind\b.{0,30}\bfactory\b/,
    /\b(?:cancel|leave|exit)\b.{0,30}\bfactory\b/,
    /\b(?:don'?t|do not)\s+use\b.{0,30}\bfactory\b/,
    /\b(?:use|switch to|go back to)\b.{0,20}\b(?:the\s+)?(?:normal|regular)\s+(?:guarded\s+)?workflow\b/,
  ].some((pattern) => pattern.test(text));
}

function custodyTransferIntent(prompt) {
  const text = String(prompt || "").toLowerCase();
  return /\b(?:transfer|move)\b.{0,40}\b(?:factory\s+)?(?:job|ticket|review)\b.{0,40}\b(?:here|this chat|this tool)\b/.test(text)
    || /\b(?:take over|re-present)\b.{0,40}\b(?:factory\s+)?(?:job|ticket|review|decision)\b/.test(text);
}

async function main() {
  let payload;
  try { payload = JSON.parse(readFileSync(0, "utf8")); } catch { emit(); }
  const prompt = String(payload?.prompt || "");
  if (!prompt || isMachineGenerated(prompt)) emit();

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const sessionId = String(payload?.session_id || payload?.thread_id || payload?.conversation_id || "").trim();
  const actorTool = String(process.env.CRX_AGENT_SURFACE || payload?.agent_type || payload?.tool_surface || "claude").toLowerCase().includes("codex")
    ? "codex"
    : "claude";
  const paths = resolveHookFactoryPaths(projectDir);

  if (custodyTransferIntent(prompt)) {
    if (!sessionId) {
      emit("CRX Factory could not bind this custody-transfer request to a chat session, so it changed nothing.");
    }
    const snapshot = loadFactorySnapshot(paths);
    const transferableStages = new Set(["needs-ticket-ok", "queued", "parked", "awaiting-morning-review"]);
    const candidates = snapshot.jobs.filter((job) =>
      transferableStages.has(job.stage)
      && job.sessionId !== sessionId
      && (!prompt.toLowerCase().includes(job.id.toLowerCase())
        ? !snapshot.jobs.some((candidate) =>
            candidate.id !== job.id
            && transferableStages.has(candidate.stage)
            && candidate.sessionId !== sessionId
            && prompt.toLowerCase().includes(candidate.id.toLowerCase()))
        : true),
    );
    if (candidates.length !== 1) {
      emit("CRX Factory recorded no custody transfer because the request did not identify exactly one transferable job. Name the job shown on the Factory Board and ask to move it to this chat.");
    }
    const job = candidates[0];
    appendFactoryEvent(paths, {
      type: "job-session-transferred",
      jobId: job.id,
      actorTool,
      sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        ownerReply: prompt.slice(0, 500),
        priorStage: job.stage,
      },
    }, { expectedLastEventHash: snapshot.lastEventHash });
    emit(job.stage === "awaiting-morning-review"
      ? `CRX Factory moved ${job.id}'s pending morning decision to this chat at Mason's explicit request. Revalidate proof and present the canonical morning question here; no build custody transferred.`
      : `CRX Factory moved ${job.id} to this chat at Mason's explicit request and revoked any prior ticket approval. Re-present the canonical ticket question here before work starts.`);
  }

  const requestedHold = holdIntent(prompt);
  if (requestedHold) {
    if (!sessionId) emit("CRX Factory could not bind this hold request to a chat session, so it changed nothing. Re-state the request in this chat.");
    try {
      appendFactoryEvent(paths, {
        type: requestedHold === "hold" ? "factory-held" : "factory-resumed",
        jobId: null,
        actorTool,
        sessionId,
        payload: {
          reason: prompt.slice(0, 500),
          ownerReply: prompt.slice(0, 500),
        },
      });
      if (requestedHold === "resume") clearEmergencyFactoryHold(paths);
    } catch (error) {
      if (requestedHold === "hold") {
        setEmergencyFactoryHold(paths, `Mason requested a factory pause but the ledger was unavailable: ${prompt.slice(0, 500)}`);
        emit("CRX Factory entered an emergency global pause because the normal ledger could not record Mason's request. Build writes are blocked until the ledger is recovered through the supported factory recovery command.");
      }
      throw error;
    }
    emit(`CRX Factory ${requestedHold === "hold" ? "is now globally paused" : "has resumed"}. Tell Mason in one plain-English sentence. Existing production and destructive-action gates remain unchanged.`);
  }

  if (intentClearIntent(prompt)) {
    if (!sessionId) emit("CRX Factory could not bind this request to leave factory mode to a chat session, so it changed nothing.");
    const snapshot = loadFactorySnapshot(paths);
    if (!snapshot.factoryIntentSessions.includes(sessionId)) emit();
    const hasStartedFactoryJob = snapshot.jobs.some((job) =>
      job.sessionId === sessionId || job.laneSessionId === sessionId,
    );
    if (hasStartedFactoryJob) {
      emit("CRX Factory did not clear governance because this chat already has a ticket or lane. Reject the pending ticket or park the job in chat instead.");
    }
    appendFactoryEvent(paths, {
      type: "factory-intent-cleared",
      jobId: null,
      actorTool,
      sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        reason: prompt.slice(0, 500),
        ownerReply: prompt.slice(0, 500),
      },
    }, { expectedLastEventHash: snapshot.lastEventHash });
    emit("CRX Factory recorded Mason's request to use the normal guarded workflow in this chat. No factory ticket or lane was started.");
  }

  const disposition = classifyOwnerReply(prompt);
  if (!sessionId) {
    if (disposition === "other") emit();
    emit("CRX Factory did not record an approval because this prompt has no verifiable session identity. Re-present the exact ticket in this chat; do not start a lane.");
  }

  const snapshot = loadFactorySnapshot(paths);
  const ticketDecisions = pendingTicketForSession(snapshot, sessionId)
    .map((job) => ({ kind: "ticket", job, questionHash: job.questionHash, questionText: job.questionText }));
  const reviewDecisions = pendingReviewForSession(snapshot, sessionId)
    .map((job) => ({ kind: "review", job, questionHash: job.reviewQuestionHash, questionText: job.reviewQuestionText }));
  const pending = [...ticketDecisions, ...reviewDecisions];
  if (disposition === "other") {
    if (pending.length === 1 && looksLikeDecisionReply(prompt)) {
      emit("CRX Factory recorded no decision because Mason's reply was not an unqualified yes or no. Re-present the exact stored question and ask for a plain-English yes, no, or revision.");
    }
    emit();
  }
  if (pending.length !== 1) {
    if (pending.length > 1) {
      emit("CRX Factory found multiple decisions pending in this chat and recorded no approval. Present exactly one question and wait.");
    }
    const elsewhere = snapshot.jobs.some((job) =>
      (job.stage === "needs-ticket-ok" && job.questionHash)
      || (job.stage === "awaiting-morning-review" && job.reviewQuestionHash),
    );
    if (elsewhere) {
      emit("CRX Factory recorded no approval because the pending decision belongs to another chat/tool. Re-present that exact decision here; Mason still answers in ordinary words.");
    }
    emit();
  }

  const decision = pending[0];
  const job = decision.job;
  const priorAssistant = lastAssistantText(payload?.transcript_path);
  if (!priorAssistant || sha256(priorAssistant) !== decision.questionHash || priorAssistant !== decision.questionText) {
    emit("CRX Factory recorded no approval because the immediately preceding assistant message was not the exact stored decision question. Re-present that question exactly and ask nothing else.");
  }

  if (decision.kind === "review") {
    let reviewBaseSha;
    try { reviewBaseSha = refreshOriginMain(projectDir); } catch {
      emit("CRX Factory could not verify current origin/main, so it recorded no morning decision. Refresh repository state and re-present the review.");
    }
    if (reviewBaseSha !== job.reviewBaseSha) {
      emit("CRX Factory recorded no morning decision because origin/main moved after the review was presented. Re-check the job and re-present it.");
    }
    if (!job.reviewExpiresAt || Date.parse(job.reviewExpiresAt) <= Date.now()) {
      emit("CRX Factory recorded no morning decision because the review question expired. Re-present it in this chat.");
    }
    const nextStage = disposition === "approve" ? "approved-to-land" : "parked";
    appendFactoryEvent(paths, {
      type: "job-stage",
      jobId: job.id,
      actorTool,
      sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        stage: nextStage,
        behaviorSummary: job.behaviorSummary,
        blocker: disposition === "approve" ? "" : prompt,
        ownerReply: prompt,
        ownerDecision: disposition,
        ticketHash: job.ticketHash,
        reviewQuestionHash: decision.questionHash,
      },
    }, { expectedLastEventHash: snapshot.lastEventHash });
    emit(disposition === "approve"
      ? `CRX Factory recorded Mason's morning acceptance for ${job.id}. The job is approved to enter the existing /ship landing gates; it is not yet live.`
      : `CRX Factory parked ${job.id} from Mason's morning response. Do not land it; revise only after a new approved ticket.`);
  }

  let baseSha;
  try { baseSha = refreshOriginMain(projectDir); } catch {
    emit("CRX Factory could not verify current origin/main, so it recorded no approval. Refresh repository state, then re-present the ticket.");
  }
  if (baseSha !== job.baseSha) {
    emit("CRX Factory recorded no approval because origin/main moved after the ticket was presented. Re-check the plan against current main and re-present it.");
  }

  const now = new Date();
  const common = {
    jobId: job.id,
    actorTool,
    sessionId,
    timestamp: now.toISOString(),
  };
  if (disposition === "approve") {
    appendFactoryEvent(paths, {
      type: "ticket-approved",
      ...common,
      payload: {
        ticketHash: job.ticketHash,
        questionHash: job.questionHash,
        ownerReply: prompt,
        baseSha,
        expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
      },
    }, { expectedLastEventHash: snapshot.lastEventHash });
    emit(`CRX Factory recorded Mason's exact approval for ticket ${job.id}, bound to this chat, ticket hash, and origin/main. Start the lane only through: node scripts/factory.mjs lane start --job ${job.id} --session ${sessionId} --tool ${actorTool}`);
  }

  appendFactoryEvent(paths, {
    type: disposition === "reject" ? "ticket-rejected" : "ticket-revision-requested",
    ...common,
    payload: {
      ticketHash: job.ticketHash,
      questionHash: job.questionHash,
      ownerReply: prompt,
      baseSha,
    },
  }, { expectedLastEventHash: snapshot.lastEventHash });
  emit(disposition === "reject"
    ? `CRX Factory recorded Mason's rejection for ticket ${job.id}. Do not start the lane.`
    : `CRX Factory recorded a revision request for ticket ${job.id}. Update the ticket, create a new hash, and re-present it before any build work.`);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    // Approval capture fails closed but must not block Mason's prompt.
    emit(`CRX Factory could not safely process this owner response: ${error.message}. It recorded no approval; re-present the ticket after fixing the state issue.`);
  });
}
