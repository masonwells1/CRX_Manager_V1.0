#!/usr/bin/env node
// UserPromptSubmit hook for CRX Manager.
// Detects plain-English requests for Claude to review or continue Codex work.
// Direct review is preferred; durable handoff stays available for continuation.

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

const reviewVerbs = String.raw`(?:review|check|double[-\s]?check|look(?:\s+at|\s+over)?|challenge|audit|vet|verify|take\s+a\s+second\s+look)`;

const triggerPatterns = [
  // Claude explicitly asked to review/challenge/check Codex work.
  new RegExp(String.raw`\b(?:let|have|ask|get|can|could|should|would)\s+claude\s+(?:to\s+)?${reviewVerbs}\b`),
  new RegExp(String.raw`\b(?:i\s+want|want|need)\s+claude\s+(?:to\s+)?${reviewVerbs}\b`),
  new RegExp(String.raw`\bclaude\s+(?:should|can|could|needs?\s+to|has\s+to|must)\s+${reviewVerbs}\b`),
  /\bclaude\s+(?:review|check|double[-\s]?check|challenge|audit|vet|verify)\b/,

  // Handoff / continuation language.
  /\b(?:send|hand|pass)\s+(?:this|it|the\s+(?:work|context|findings?|review|audit|handoff))\s+(?:over\s+)?to\s+claude\b/,
  /\b(?:make|create|write|draft)\s+(?:a\s+)?claude\s+handoff\b/,
  /\b(?:claude|codex[-\s]?to[-\s]?claude)\s+handoff\b/,
  /\bgive\s+claude\s+(?:the\s+)?context\b/,
  /\bset\s+this\s+up\s+so\s+claude\s+can\s+(?:continue|review|check|take\s+over)\b/,
  /\bclaude\s+can\s+(?:continue|take\s+over|pick\s+this\s+up)\b/,
];

if (!triggerPatterns.some((pattern) => pattern.test(prompt))) emit();

emit([
  "CRX Codex-to-Claude Handoff/Review reminder:",
  "",
  "Mason should not need to remember command names. This prompt is asking for Claude to review, challenge, or continue Codex work.",
  "",
  "Default path:",
  "- For direct review, read C:\\CRX_Manager\\.claude\\commands\\claude-review.md and run node scripts/run-claude-review.mjs.",
  "- Reconcile Claude's findings as agree / disagree / needs more evidence.",
  "",
  "Fallback / continuation path:",
  "- If the Claude CLI is unavailable, Mason wants a separate Claude session to continue, or a durable packet is the deliverable, read C:\\CRX_Manager\\.claude\\commands\\codex-to-claude-handoff.md.",
  "- Create a packet at docs/audits/<YYYY-MM-DD>-codex-to-claude-<slug>-handoff.md.",
  "- Tell Mason exactly: Open Claude in C:\\CRX_Manager and say: \"Read <handoff-path> and follow it.\"",
  "",
  PUSH_POLICY,
  "",
  "Sources of truth: C:\\CRX_Manager\\.claude\\commands\\claude-review.md and C:\\CRX_Manager\\.claude\\commands\\codex-to-claude-handoff.md",
].join("\n"));
