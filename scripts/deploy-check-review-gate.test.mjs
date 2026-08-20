#!/usr/bin/env node
// Regression tests for the deploy-check pre-merge review gate.
//
// The gate lives in prose (.claude/skills/deploy-check/SKILL.md) rather than in
// executable code, so these tests pin the exact query shapes that make it sound.
// Each assertion here corresponds to a hole that was live at some point on
// PR #441 and was closed by a reviewer finding. Weakening any of them silently
// restores a way for an unreviewed commit to reach production.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLAUDE_SKILL = path.join(ROOT, ".claude", "skills", "deploy-check", "SKILL.md");
const CODEX_SKILL = path.join(ROOT, ".agents", "skills", "deploy-check", "SKILL.md");

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

const claude = readFileSync(CLAUDE_SKILL, "utf8");
const codex = readFileSync(CODEX_SKILL, "utf8");

// The generated Codex mirror must carry the identical gate, or an agent reading
// the Codex copy follows a weaker procedure than one reading the Claude copy.
ok(codex.includes("CODERABBIT_COMPLETED_THIS_HEAD"), "the .agents mirror carries the hardened gate (run sync-agent-workflows.mjs --write)");

for (const [name, text] of [["claude", claude], ["codex", codex]]) {
  // ── Forged-comment defence (Codex BLOCKED, 2026-08-20) ────────────────────
  // chat.auto_reply is on and the repo is public, so ANY coderabbitai[bot]
  // comment is attacker-solicitable: a PR author can ask the bot to echo the
  // head SHA. Only the canonical walkthrough comment counts.
  ok(
    text.includes('select(.body | contains("<!-- This is an auto-generated comment: summarize by coderabbit.ai -->"))'),
    `${name}: comments query restricts to the canonical walkthrough comment`,
  );
  ok(
    text.includes('select((.body | contains("auto-generated reply by CodeRabbit")) | not)'),
    `${name}: comments query excludes conversational bot replies`,
  );
  // The bare, unfiltered form must never reappear.
  ok(
    !text.includes(`comments --jq '.[] | select(.user.login=="coderabbitai[bot]") | .body'`),
    `${name}: the unfiltered any-bot-comment query is absent (it is forgeable via chat)`,
  );

  // ── Completion bound to the exact SHA ─────────────────────────────────────
  // gh pr checks reports what is current for the PR, not what is true of the
  // commit being merged. Commit statuses are written by CodeRabbit under its
  // own credentials and bound by GitHub to one SHA.
  ok(
    text.includes("commits/<HEAD>/statuses"),
    `${name}: completion is proven from the head commit's own statuses`,
  );
  ok(
    !text.includes("gh pr checks <n> --repo masonwells1/CRX_Manager_V1.0 | grep -i coderabbit"),
    `${name}: the grep-for-the-word completion check is absent (it matches "pending" too)`,
  );

  // ── Review-object filters (both reviewers, 2026-08-20) ────────────────────
  // The reviews endpoint returns PENDING (submitted_at: null) and DISMISSED
  // reviews whose bodies still carry the range line.
  ok(
    text.includes('.submitted_at != null and .state != "DISMISSED"'),
    `${name}: reviews query rejects unsubmitted and dismissed reviews`,
  );

  // ── Merge binding ─────────────────────────────────────────────────────────
  ok(
    text.includes("--match-head-commit"),
    `${name}: the merge is bound to the reviewed SHA by GitHub, not by diligence`,
  );

  // ── No-op-merge fallback must assert, not print (CodeRabbit, 2026-08-20) ──
  ok(
    text.includes("PARENT1_IS_REVIEWED_COMMIT") && text.includes("MERGE_ADDED_NOTHING"),
    `${name}: tree-identity checks assert and fail closed`,
  );
  ok(
    text.includes("ANCESTOR_OF_BASE") && !text.includes("ANCESTOR_OF_MAIN"),
    `${name}: ancestry is bound to the PR's baseRefOid, not origin/main`,
  );
  // Filenames are PR-controlled; interpolating them into a shell command is a
  // command-injection vector on a public repo.
  ok(
    !text.includes("contents/<FILE>?ref="),
    `${name}: no PR-controlled filename is interpolated into a shell command`,
  );
}

console.log(`deploy-check-review-gate: ${pass} assertions passed`);
