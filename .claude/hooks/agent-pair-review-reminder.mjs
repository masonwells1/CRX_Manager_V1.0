#!/usr/bin/env node
// UserPromptSubmit hook for CRX Manager.
// Detects requests for Claude and Codex to both review the same work.

import { readFileSync } from "node:fs";

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
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  emit();
}

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
  "Hard gates remain in force: Do not push, deploy, apply live migrations, delete data, or commit without Mason's explicit approval in the current conversation.",
  "",
  "Source of truth: C:\\CRX_Manager\\.claude\\commands\\agent-pair-review.md",
].join("\n"));
