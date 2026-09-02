#!/usr/bin/env node
// UserPromptSubmit hook: when Mason asks for an unattended / overnight run (or
// complains that the loop "keeps asking for permission"), inject a directive to
// ACTUALLY arm autopilot — not just reassure him it's safe. Reassurance without
// writing the flag is the exact repeated failure.
//
// Advisory only (a false positive is harmless — the reminder says to ignore it if
// he isn't asking for a hands-free run).

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isMachineGenerated } from "./prompt-source-lib.mjs";

function emit(extra) {
  if (extra) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: extra } }));
  }
  process.exit(0);
}

let payload;
try { payload = globalThis.__CRX_ROUTED_HOOK_PAYLOAD ?? JSON.parse(readFileSync(0, "utf8")); } catch { emit(); }

// Machine-generated envelopes (<task-notification>, <system-reminder>, slash-command
// output) are not something Mason typed — never latch OVERNIGHT-INTENT or remind off
// a word like "overnight" inside an embedded report.
if (isMachineGenerated(payload?.prompt)) emit();

const prompt = String(payload?.prompt || "").toLowerCase();
if (!prompt) emit();

const triggers = [
  /keeps?\s+asking/,
  /non.?stop.*(permission|allow)/,
  /(full|more)\s+permission/,
  /never\s+ask/,
  /don'?t\s+ask\s+(me\s+)?(for\s+)?(permission|again)/,
  /going\s+to\s+bed/,
  /hands.?free/,
  /overnight/,
  /run\s+(it|this)\s+(all\s+)?night/,
  /while\s+i('?m| am)\s+(asleep|sleeping|away|gone)/,
  /without\s+(asking|stopping|me)/,
];

if (!triggers.some((re) => re.test(prompt))) emit();

// Strong, unambiguous hands-free signals additionally latch the deterministic
// handshake: unattended-autopilot.mjs blocks build tools until autopilot is
// actually armed (or the flag is deliberately cleared). Weak signals only remind.
//
// ADMISSION RULE: a pattern belongs here only if it is a phrase Mason can be
// USING but not NAMING. Every entry below is first-person or imperative, so it
// cannot appear in a question ABOUT autopilot. A bare topic word can, and the
// cost of that false positive is severe: the latch blocks Bash/Write/Edit for 45
// minutes, review-proof-guard.mjs refuses every command that would clear the
// flag, and the only unblocked path left is arming autopilot — exactly what this
// handshake exists to prevent. PR #548 built a sanctioned clear-the-flag script
// for this; two `gpt-5.6-sol` reviews returned BLOCKERS and Mason removed it,
// because the cure was a new way to execute code during the pause.
//
// A bare `/overnight/` was such a word and is deliberately gone (Mason,
// 2026-09-02). It froze one session twice inside ten minutes: once on "i think
// the overnight flag is getting worked on you might investigate", and again on
// the approval to make this very change. Same defect, same word, already judged
// once — the Governed Autonomous Software Factory was removed on 2026-08-07
// partly because "casual words like 'factory' or 'overnight' flipped governed
// state" (docs/manual/DECISION_LOG.md).
//
// It is REPLACED below rather than deleted, because "run this overnight" is a
// real hands-free request and latching it is a property worth keeping. The split
// is grammatical, not a list of banned phrasings: adverbial `overnight` says WHEN
// the work happens and is a request; attributive `overnight` modifies a noun and
// is naming a thing ("the overnight flag", "the overnight bug hunt", "the word
// overnight from the list").
//
// TWO independent signals, because CodeRabbit found a real hole on each side of a
// single one (PR #565). Both must agree before the session is frozen:
//
//   NOT-NAMED  — no determiner or quoting word immediately before it. This is
//                what makes "the word overnight FROM the list" safe even though
//                `from` is a perfectly good adverbial preposition, and it is the
//                closed half of the rule: English determiners are a fixed set,
//                nouns are not.
//   ADVERBIAL  — it ends the phrase, or the next word starts a new clause rather
//                than continuing a noun phrase. This is what makes a leading
//                "overnight flag is broken" safe, where nothing precedes it.
//
// Neither alone is enough. A single lookahead let `investigate the overnight:
// flag behavior` through, because `:` was read as a terminator when it was in
// fact introducing a noun. A single lookbehind lets `overnight flag is broken`
// through when the sentence opens with it. Each rule covers the other's gap,
// which is also why the follower set can afford to be generous: over-matching
// there is caught by the determiner rule.
//
// Where they still disagree, prefer MISSING a real request over freezing on a
// mention — a miss degrades to the arm-autopilot reminder that `triggers` still
// injects, while a false freeze can only be escaped by arming autopilot. Pinned
// in prompt-hooks.test.mjs and hook-router.test.mjs.
//
// `this`/`that` are deliberately NOT determiners here: "run this overnight" is
// the canonical request, and hook-router.test.mjs:53 pins it.
const OVERNIGHT_REQUEST =
  /(?<!\b(?:the|an?|its|their|our|your|any|each|every|word|term|about)\s+)\bovernight\b(?=\s*$|\s*[.!?]|\s*[,;:]?\s+(?:and|so|then|but|plus|also|too|while|if|unless|after|before|until|till|til|through|throughout|into|in|on|at|to|from|for|with|without|please|ok|okay|tonight|i|im|ill|ive|i'm|i'll|i've|we|you|my)\b)/;

const strong = [
  /going\s+to\s+bed/,
  /hands.?free/,
  /run\s+(it|this)\s+(all\s+)?night/,
  /while\s+i('?m| am)\s+(asleep|sleeping|away|gone)/,
  OVERNIGHT_REQUEST,
];
if (strong.some((re) => re.test(prompt))) {
  try {
    const dir = path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), ".claude", "session-state");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "OVERNIGHT-INTENT.flag"), JSON.stringify({
      created: new Date().toISOString(),
      source: "autopilot-intent-reminder",
    }));
  } catch { /* advisory hook — never fail the prompt */ }
}

emit([
  "CRX autopilot reminder:",
  "",
  "Mason is asking for an unattended / hands-free run. Do NOT just reassure him it's safe —",
  "ACTUALLY arm autopilot so the loop stops prompting him:",
  "  1. Run:  node .claude/hooks/autopilot-arm.mjs --hours <however long he'll be away>",
  "  2. Confirm in ONE plain-English line that the flag is set and until when.",
  "  3. Then start/continue the loop.",
  "",
  "Autopilot auto-approves ordinary tool calls but STILL blocks push / deploy / destructive",
  "deletes / secret writes — those keep needing his explicit OK. It auto-expires.",
  "Live migrations MAY apply during an armed run (Mason's settled 2026-07-13 policy) — but only",
  "through migration-apply-guard's same-session review proof + the Codex gate, and NEVER when the",
  "migration is destructive (DELETE/TRUNCATE of business rows, DROP of data-bearing tables/columns)",
  "— the guard hard-refuses those while armed; park them for Mason.",
  "Reassurance without running autopilot-arm.mjs is the exact thing he keeps having to repeat.",
  "(If this isn't a hands-free request, ignore this.)",
].join("\n"));
