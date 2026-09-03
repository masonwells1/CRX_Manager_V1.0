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
// USING but not NAMING. Every entry below is a first-person or imperative USAGE,
// never the feature's name, so none of them appears in an ordinary question about
// autopilot. A bare topic word does, and the cost of that false positive is
// severe: the latch blocks Bash/Write/Edit for 45 minutes, review-proof-guard.mjs
// refuses every command that would clear the flag, and the only unblocked path
// left is arming autopilot — exactly what this handshake exists to prevent.
// PR #548 built a sanctioned clear-the-flag script for this; two `gpt-5.6-sol`
// reviews returned BLOCKERS and Mason removed it, because the cure was a new way
// to execute code during the pause.
//
// STATED HONESTLY, because an earlier version of this comment claimed more than
// the code delivers: "does not appear in an ordinary question" is NOT "cannot
// appear in any prompt that is not a request". These are plain substring
// patterns with no notion of quoting or negation, so a prompt that QUOTES one
// while discussing this guard — `does saying "going to bed" arm autopilot?` —
// still latches. That residual is pinned as a known non-goal in
// prompt-hooks.test.mjs rather than narrowed away: four attempts to narrow
// `overnight` by grammar were each defeated by a phrasing the round before had
// not considered, and the settled answer is that a pattern is either a usage
// phrase or it is removed. Meta-discussion of the guard is the one place these
// misfire, and the escape is the same as any false latch: arm, or wait it out.
//
// `hands.?free` was REMOVED from this list on 2026-09-03 (Mason's call) for
// failing the admission rule outright: it is the feature's NAME, so it matched
// `what does hands-free mode do?` and even the negation `do not run this
// hands-free`. Seven of seven question/negation probes latched. Same defect as
// the bare `overnight`, same remedy — it stays in `triggers`, so a genuine
// `run this hands-free` still reminds without freezing the session.
//
// `overnight` is deliberately ABSENT from this list, in any form (Mason,
// 2026-09-02, after five review rounds). Do not add it back.
//
// It began as a bare `/overnight/` and froze one session twice inside ten
// minutes: once on "i think the overnight flag is getting worked on you might
// investigate", and again on the approval to remove it. Three successive
// attempts to keep it as a NARROWED pattern — adverbial-only, then plus a
// determiner lookbehind, then with the preposition followers stripped — were
// each defeated by a phrasing the previous round had not considered:
//
//   round 1  the word alone                 "the overnight flag is ..."
//   round 2  any punctuation as terminator  "investigate the overnight: flag ..."
//   round 3  general prepositions           "overnight in the documentation ..."
//   round 4  nominal use at a sentence end  "what is overnight?"
//            possessive followers           "overnight, my report is wrong"
//
// Round 4's `what is overnight?` is the ORIGINAL defect, not a marginal case:
// asking a question about the feature still froze the session. The pattern was
// not converging, so it is gone rather than narrowed a fourth time.
//
// This is the same judgement recorded for the Governed Autonomous Software
// Factory, removed on 2026-08-07 partly because "casual words like 'factory' or
// 'overnight' flipped governed state" (docs/manual/DECISION_LOG.md), and the
// same shape as the `git clean` carve-out that closed after six rounds: a guard
// written as a text pattern over free-form input does not converge.
//
// WHAT IS LOST, stated plainly: "run this overnight" on its own no longer
// latches the deterministic handshake. `triggers` above still matches the bare
// word, so such a prompt still injects the arm-autopilot reminder — the pre-latch
// behaviour, not a silent loss. The four patterns below still latch, and they
// cover the phrasings that accompany a real unattended run. The trade was made
// knowingly: a missed latch costs a reminder, while a false latch costs a
// 45-minute lockout whose only exit is arming autopilot — precisely what this
// handshake exists to prevent.

const strong = [
  /going\s+to\s+bed/,
  /run\s+(it|this)\s+(all\s+)?night/,
  /while\s+i('?m| am)\s+(asleep|sleeping|away|gone)/,
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
