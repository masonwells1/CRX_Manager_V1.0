#!/usr/bin/env node
// Regression tests for the deploy-check pre-merge review gate.
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
  ok(
    hasCommandWithAll(cmds, [
      "pulls/<n>/reviews",
      'select(.user.login=="coderabbitai[bot]"',
      ".submitted_at != null",
      '.state != "DISMISSED"',
    ]),
    `${name}: the reviews query filters bot identity, unsubmitted, and dismissed together`,
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
    ]),
    `${name}: the comments query keeps only the canonical walkthrough and drops chat replies`,
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
    noCommandWithAll(cmds, ["contents/<FILE>"]),
    `${name}: no PR-controlled filename is interpolated into a shell command`,
  );
}

console.log(`deploy-check-review-gate: ${pass} assertions passed`);
