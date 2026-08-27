#!/usr/bin/env node
// UserPromptSubmit hook for CRX Manager.
// Detects requests for Claude and Codex to both review the same work.

import { readFileSync } from "node:fs";
import { isMachineGenerated, PUSH_POLICY } from "./prompt-source-lib.mjs";

function emit(extra) {
  if (extra) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: extra,
      },
    }));
  }
  process.exit(0);
}

let payload;
try {
  payload = globalThis.__CRX_ROUTED_HOOK_PAYLOAD ?? JSON.parse(readFileSync(0, "utf8"));
} catch {
  emit();
}

// Machine-generated envelopes (<task-notification>, <system-reminder>, slash-command
// output) are not something Mason typed — stay silent on them.
if (isMachineGenerated(payload?.prompt)) emit();

const prompt = String(payload?.prompt || "").toLowerCase();
if (!prompt) emit();

const triggerPatterns = [
  /\b(?:both|two|2)\s+(?:agents?|models?|reviewers?)\b[^.?!]*\b(?:review|check|compare|look|vet|audit)\b/,
  /\b(?:review|check|compare|look|vet|audit)\b[^.?!]*\b(?:both|two|2)\s+(?:agents?|models?|reviewers?)\b/,
  /\b(?:claude\s+and\s+codex|codex\s+and\s+claude)\b[^.?!]*\b(?:review|check|compare|look|vet|audit|notes?|disagree|challenge)\b/,
  /\b(?:review|check|compare|look|vet|audit|notes?|disagree|challenge)\b[^.?!]*\b(?:claude\s+and\s+codex|codex\s+and\s+claude)\b/,
  /\bpair\s+review\b/,
  /\btwo[-\s]?model\s+review\b/,
  /\bmake\s+(?:claude\s+and\s+codex|codex\s+and\s+claude)\s+disagree\b/,
  /\bcompare\s+notes\b[^.?!]*\b(?:claude|codex|agents?|models?)\b/,
];

if (!triggerPatterns.some((pattern) => pattern.test(prompt))) emit();

emit([
  "CRX Agent Pair Review reminder:",
  "",
  "Mason is asking for both Claude and Codex to review or compare the same work.",
  "",
  "Use the Agent Pair Review workflow automatically:",
  "- Read C:\\CRX_Manager\\.claude\\commands\\agent-pair-review.md as the source of truth.",
  "- Run the appropriate Codex review path and the direct Claude review path.",
  "- Reconcile findings into agree / disagree / needs-more-evidence.",
  "- Keep BLOCKER/HIGH disagreements visible for Mason instead of silently choosing one model.",
  "",
  PUSH_POLICY,
  "",
  "Source of truth: C:\\CRX_Manager\\.claude\\commands\\agent-pair-review.md",
].join("\n"));
