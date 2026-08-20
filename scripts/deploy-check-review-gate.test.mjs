#!/usr/bin/env node
// Regression tests for the deploy-check pre-merge review gate.
//
// SCOPE — read this before trusting a green run. This is DOCUMENTATION-REGRESSION
// coverage, not runtime enforcement. It proves the documented procedure still says
// the right thing; it does NOT execute the review verification, and it cannot stop
// a merge that skips those steps. `.claude/hooks/pr-merge-guard.mjs` currently
// enforces neither the CodeRabbit artifacts nor `--match-head-commit`, so a green
// run here plus a careless merge is still a bad merge. Codex raised exactly this
// (CRX-SEC-002, Medium, PR #441) and the honest label is its own mitigation:
// converting these checks into the merge guard is tracked follow-up work, and
// until that lands nobody should cite this suite as the hard gate.
//
// The gate lives in prose (.claude/skills/deploy-check/SKILL.md) rather than in
// executable code, so these tests pin the exact query shapes that make it sound.
// Each assertion here corresponds to a hole that was live at some point on
// PR #441 and was closed by a reviewer finding. Weakening any of them silently
// restores a way for an unreviewed commit to reach production.
//
// IMPORTANT: assert against the extracted ```bash COMMANDS, never against the
// document text. The first version of this file used whole-file `includes()`,
// which the surrounding explanatory paragraphs satisfy on their own — so the
// suite would have stayed green while the real command regressed. CodeRabbit
// caught that on PR #441; it is the same "green signal for the wrong thing"
// failure the gate itself exists to prevent.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const SKILLS = [
  ["claude", path.join(ROOT, ".claude", "skills", "deploy-check", "SKILL.md")],
  ["codex", path.join(ROOT, ".agents", "skills", "deploy-check", "SKILL.md")],
];

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

// Extract the bodies of every ```bash fenced block, collapsed to one line each.
function bashCommands(markdown) {
  const blocks = [];
  const fence = /```bash\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(markdown)) !== null) {
    for (const line of m[1].split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) blocks.push(trimmed);
    }
  }
  return blocks;
}

// A command satisfies a rule only if it contains EVERY required fragment.
const hasCommandWithAll = (cmds, fragments) =>
  cmds.some((c) => fragments.every((f) => c.includes(f)));
const noCommandWithAll = (cmds, fragments) =>
  !cmds.some((c) => fragments.every((f) => c.includes(f)));
const noCommandMatching = (cmds, re) => !cmds.some((c) => re.test(c));

// Any shell expansion in a `contents/` path segment, not just the literal
// <FILE> placeholder the first draft used: a later rewrite to contents/$f,
// contents/${f}, contents/$(...), or contents/`...` would reintroduce the same
// injection vector while passing a literal-only check.
//
// Deliberately NOT matching a bare double quote. An earlier revision did, which
// false-positived on a perfectly safe literal such as
// `gh api "repos/o/r/contents/README.md?ref=abc"` — the closing quote alone is
// not an expansion. The quoted-expansion form `contents/"$f"` is still caught,
// because the `$` alternative matches it. A guard that blocks safe commands gets
// edited away, so precision here is what keeps it alive. (CodeRabbit, PR #441.)
const EXPANSION_AFTER_CONTENTS = /contents\/[^\s]*(?:<[A-Za-z_]+>|\$|`)/;

for (const [name, file] of SKILLS) {
  const cmds = bashCommands(readFileSync(file, "utf8"));
  ok(cmds.length > 0, `${name}: bash commands were extracted from the skill`);

  // ── Completion bound to the exact head COMMIT ─────────────────────────────
  // gh pr checks answers "what is current for the PR", not "what is true of the
  // commit I am merging". Commit statuses are written by CodeRabbit under its
  // own credentials and bound by GitHub to one SHA; a PR author cannot post one.
  ok(
    hasCommandWithAll(cmds, ["commits/<HEAD>/statuses", 'select(.context=="CodeRabbit")', '= "success"']),
    `${name}: one command asserts a CodeRabbit success status on the head commit itself`,
  );
  ok(
    noCommandWithAll(cmds, ["gh pr checks", "grep -i coderabbit"]),
    `${name}: no command greps the PR check list for the word "coderabbit" (it matches "pending" too)`,
  );

  // ── Review objects: reject unsubmitted and dismissed ──────────────────────
  // The endpoint returns PENDING (submitted_at: null) and DISMISSED reviews
  // whose bodies still carry the range line.
  // The `and <HEAD>` grep is the part that binds the result to the commit being
  // merged. Without it in the SAME command, the query proves only that some
  // submitted review exists — which is true of every PR that was ever reviewed.
  ok(
    hasCommandWithAll(cmds, [
      "pulls/<n>/reviews",
      'select(.user.login=="coderabbitai[bot]"',
      ".submitted_at != null",
      '.state != "DISMISSED"',
      'grep -oE "and <HEAD>"',
    ]),
    `${name}: the reviews query filters bot identity, unsubmitted, and dismissed AND binds to the head SHA`,
  );

  // ── Forged-comment defence (Codex BLOCKED, 2026-08-20) ────────────────────
  // chat.auto_reply is on and the repo is public, so ANY coderabbitai[bot]
  // comment is attacker-solicitable: a PR author can ask the bot to echo the
  // head SHA. Only the canonical walkthrough comment counts.
  ok(
    hasCommandWithAll(cmds, [
      "issues/<n>/comments",
      'select(.user.login=="coderabbitai[bot]")',
      'contains("<!-- This is an auto-generated comment: summarize by coderabbit.ai -->")',
      'select((.body | contains("auto-generated reply by CodeRabbit")) | not)',
      'grep -oE "and <HEAD>"',
    ]),
    `${name}: the comments query keeps only the canonical walkthrough, drops chat replies, AND binds to the head SHA`,
  );
  ok(
    noCommandWithAll(cmds, [
      "issues/<n>/comments",
      'select(.user.login=="coderabbitai[bot]") | .body',
    ]) || hasCommandWithAll(cmds, ['contains("<!-- This is an auto-generated comment: summarize by coderabbit.ai -->")']),
    `${name}: no unfiltered any-bot-comment query survives (it is forgeable via chat)`,
  );

  // ── Merge binding ─────────────────────────────────────────────────────────
  ok(
    hasCommandWithAll(cmds, ["gh pr merge", "--match-head-commit"]),
    `${name}: the merge command binds GitHub to the reviewed SHA`,
  );

  // ── No-op-merge fallback must assert, not print ───────────────────────────
  ok(
    hasCommandWithAll(cmds, ["git rev-parse <HEAD>^1", "<REVIEWED_SHA>", "PARENT1_IS_REVIEWED_COMMIT"]),
    `${name}: parent-1 identity is asserted against the reviewed SHA, not printed`,
  );
  ok(
    hasCommandWithAll(cmds, ["git merge-tree --write-tree", "<HEAD>^{tree}", "MERGE_ADDED_NOTHING"]),
    `${name}: tree identity is asserted, not printed`,
  );
  ok(
    hasCommandWithAll(cmds, ["git merge-base --is-ancestor <HEAD>^2 <BASE_SHA>", "ANCESTOR_OF_BASE"]),
    `${name}: ancestry is bound to the PR's baseRefOid`,
  );
  ok(
    noCommandWithAll(cmds, ["git merge-base --is-ancestor", "origin/main"]),
    `${name}: ancestry is not checked against the origin/main tracking ref`,
  );

  // ── No PR-controlled text in a shell command ──────────────────────────────
  // Filenames come from the PR and may contain quotes, semicolons, or $().
  ok(
    noCommandMatching(cmds, EXPANSION_AFTER_CONTENTS),
    `${name}: no PR-controlled filename is interpolated into a shell command, in any expansion form`,
  );
}

console.log(`deploy-check-review-gate: ${pass} assertions passed`);
