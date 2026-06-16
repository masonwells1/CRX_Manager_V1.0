#!/usr/bin/env node
// UserPromptSubmit hook for CRX Manager.
// Mason (zero coding experience) should never have to type a slash command. When he
// expresses intent to BUILD / FIX / SHIP / PUSH / "go live" / "do it", this hook
// deterministically reminds Claude to drive the work through the /ship pipeline —
// the "hard scaffolding" version of the CLAUDE.md auto-trigger, so it fires reliably.
//
// SAFETY: this NEVER authorizes a prod action. /ship does everything and STOPS before
// any git push / Vercel deploy / live-migration apply for Mason's explicit OK. The
// reminder restates that gate so "push" can't be misread as "deploy to prod now."
//
// It only injects context (additionalContext) — it cannot force a tool call, and a
// false-positive is harmless (the reminder itself says: if this is a question or a
// trivial one-liner, ignore it).

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

// Intent to get real work done / ship it / push it. Broad on purpose — Mason talks in
// plain English and the injected reminder tells Claude to ignore it for questions.
const triggerPatterns = [
  /\bship\b/,                                            // ship, ship it, /ship
  /\bpush(?:es|ed|ing|\s+it|\s+this|\s+that)?\b/,        // push / push it / push this
  /\bgo\s+live\b/,
  /\bdeploy(?:s|ed|ing|ment)?\b/,
  /\bmake\s+(?:it|this|that)\s+(?:live|happen)\b/,
  /\bgo\s+ahead\s+and\b/,
  /\b(?:get|getting)\s+(?:it|this|these|them)\s+done\b/,
  /\bsend\s+it\b/,
  /\bfinish\s+(?:it|this|up|the)\b/,
  /\bdo\s+(?:it|this|that|everything|all|the)\b/,        // "do it", "do everything", "do all phases"
  /\bready\s+to\s+(?:ship|go|push|deploy)\b/,
  /\b(?:build|implement|create|add|fix|wire(?:\s+up)?|set\s+up)\b/, // substantive coding verbs
];

if (!triggerPatterns.some((pattern) => pattern.test(prompt))) emit();

emit([
  "CRX Ship-It reminder:",
  "",
  "Mason rarely types slash commands — this message looks like an intent to build / fix / ship / push / \"go live\" / \"do it.\"",
  "",
  "IF this is a substantive coding job (a feature, page, RPC, migration, or a fix beyond a one-line tweak) OR a request to ship/push existing work, drive it through the /ship pipeline automatically (read .claude/commands/ship.md):",
  "  Step 0.5 size it + write a plain-English plan for Mason's OK on real (multi-file / SQL / money / RLS) changes",
  "  -> implement -> Step 2.5 prove it actually RUNS (not just 'tests pass') -> scoped review fan-out + fix (hard cap 3 rounds) -> migration/Codex gates.",
  "Tell Mason in ONE line you're running it through /ship; do NOT make him type the command.",
  "",
  "SAFETY (non-negotiable): the word \"push\" does NOT authorize a production deploy. /ship does the whole job and then STOPS at Step 8 for Mason's explicit one-click approval before ANY git push to main, Vercel deploy, or live-migration apply. Never cross those gates without his OK in this conversation.",
  "",
  "If this message is just a question, a discussion, or a genuinely trivial one-line change, IGNORE this reminder (don't spin up the heavy pipeline).",
].join("\n"));
