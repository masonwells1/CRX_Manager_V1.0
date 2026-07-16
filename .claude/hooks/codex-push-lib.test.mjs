#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";

import {
  claudeProofValid,
  contentIsRisky,
  gitPushCwd,
  mainPushIsForced,
  mainPushSource,
  pushIsForced,
  pushContextIsAmbiguous,
  pushUsesBulkMode,
  reviewProofPathMentioned,
  reviewStateDirectoryMentioned,
  extractPatchDestinations,
  proofValid,
  riskyFiles,
} from "./codex-push-lib.mjs";

const now = Date.parse("2026-07-13T18:00:00.000Z");
const sha = "a".repeat(40);

assert.equal(mainPushSource("git push origin HEAD:main", "feature"), "HEAD");
assert.equal(mainPushSource("git.exe push origin HEAD:main", "feature"), "HEAD");
assert.equal(mainPushSource('"C:\\Program Files\\Git\\cmd\\git.exe" push origin HEAD:main', "feature"), "HEAD");
assert.equal(mainPushSource("/usr/bin/git push origin HEAD:main", "feature"), "HEAD");
assert.equal(mainPushSource("git -C ../repo push origin release:main", "feature"), "release");
assert.equal(mainPushSource("git push origin :main", "feature"), "DELETE");
assert.equal(mainPushSource("git push origin feature", "feature"), null);
assert.equal(mainPushSource("git push --all origin", "feature"), "main");
assert.equal(mainPushSource("git push origin --branches", "feature"), "main");
assert.equal(mainPushSource("git push --mirror origin", "feature"), "main");

// Codex round-2 (2026-07-13): option-based deletion of main.
assert.equal(mainPushSource("git push origin --delete main", "feature"), "DELETE");
assert.equal(mainPushSource("git push origin -d main", "feature"), "DELETE");
assert.equal(mainPushSource("git push origin --del main", "feature"), "DELETE");
assert.equal(mainPushSource("git push --delete origin main", "feature"), "DELETE");
assert.equal(mainPushSource("git push origin --delete feature/test", "feature"), null);

assert.equal(mainPushIsForced("git push origin main --force", "feature"), true);
assert.equal(mainPushIsForced("git push origin main -f", "feature"), true);
assert.equal(mainPushIsForced("git push origin main --force-with-lease", "feature"), true);
assert.equal(mainPushIsForced("git push origin main --force-with-lease=refs/heads/main:abc", "feature"), true);
assert.equal(mainPushIsForced("git push origin +HEAD:main", "feature"), true);
assert.equal(mainPushIsForced("git push origin \"+HEAD:main\"", "feature"), true);
assert.equal(mainPushIsForced("git -C . push --force origin main", "feature"), true);
assert.equal(mainPushIsForced("git push -uf origin main", "feature"), true);
assert.equal(mainPushIsForced("git push origin feature --force", "feature"), false);
assert.equal(mainPushIsForced("git push origin HEAD:main", "feature"), false);
assert.equal(pushIsForced("git push origin feature --force", "feature"), true);
assert.equal(pushIsForced("git push --all origin --force", "feature"), true);
assert.equal(pushIsForced("git push origin --all -f", "feature"), true);
assert.equal(pushIsForced("git push origin +feature", "feature"), true);
assert.equal(pushIsForced("git push origin feature", "feature"), false);
assert.equal(pushUsesBulkMode("git push --all origin"), true);
assert.equal(pushUsesBulkMode("git push origin --branches"), true);
assert.equal(pushUsesBulkMode("git push origin --mirror"), true);
assert.equal(pushUsesBulkMode("git push origin --prune"), true);
assert.equal(pushUsesBulkMode("git push origin feature"), false);
assert.equal(pushContextIsAmbiguous("cd C:/other && git push origin main"), true);
assert.equal(pushContextIsAmbiguous("Set-Location C:/other; git.exe push origin main"), true);
assert.equal(pushContextIsAmbiguous("$env:GIT_DIR='C:/other/.git'; git push origin main"), true);
assert.equal(pushContextIsAmbiguous("GIT_WORK_TREE=/tmp/other git push origin main"), true);
assert.equal(pushContextIsAmbiguous("git -C C:/other push origin main"), false);
assert.equal(reviewProofPathMentioned(".claude/session-state/claude-review-push.json"), true);
assert.equal(reviewProofPathMentioned("C:\\repo\\.claude\\session-state\\codex-review-abc.json"), true);
assert.equal(reviewProofPathMentioned("printf {} > codex-review-forged.json"), true);
assert.equal(reviewProofPathMentioned("printf {} >claude-review-push.json"), true);
assert.equal(reviewProofPathMentioned("rm codex-review-x.json;ls"), true);
assert.equal(reviewProofPathMentioned("cat claude-review-push.json|more"), true);
assert.equal(reviewProofPathMentioned("rm codex-review-x.json)"), true);
assert.equal(reviewProofPathMentioned("Remove-Item a.json,claude-review-push.json"), true);
assert.equal(reviewProofPathMentioned("copy forged.json claude-review-push.json>nul"), true);
assert.equal(reviewProofPathMentioned("my-claude-review-push.json.bak"), false);
assert.equal(reviewProofPathMentioned(".claude/session-state/claude-review-latest.txt"), false);
assert.equal(reviewStateDirectoryMentioned("cd .claude/session-state"), true);
assert.equal(reviewStateDirectoryMentioned("cd .claude && cd session-state"), true);
assert.equal(reviewStateDirectoryMentioned("cd .claude"), true);
assert.equal(reviewStateDirectoryMentioned("C:\\repo\\.claude\\session-state"), true);

// Codex round-4 (2026-07-13): abbreviated bulk options count as bulk mode.
assert.equal(pushUsesBulkMode("git push origin --mirr"), true);
assert.equal(pushUsesBulkMode("git push origin --al"), true);
assert.equal(pushUsesBulkMode("git push origin --pru"), true);
assert.equal(pushUsesBulkMode("git push origin --bran"), true);
assert.equal(pushUsesBulkMode("git push origin --tags"), false, "--tags is not a bulk-ref mode");
assert.equal(pushUsesBulkMode("git push origin feature"), false);

// Codex round-2 (2026-07-13): unambiguous long-option abbreviations count as force.
assert.equal(mainPushIsForced("git push origin main --force-w", "feature"), true);
assert.equal(mainPushIsForced("git push origin main --force-with", "feature"), true);
assert.equal(mainPushIsForced("git push origin main --force-if", "feature"), true);
assert.equal(mainPushIsForced("git push origin main --follow-tags", "feature"), false, "--follow-tags is not force intent");

assert.equal(gitPushCwd("git -C ../repo push origin HEAD:main", "C:/work/current"), path.resolve("C:/work/repo"));
assert.equal(gitPushCwd("git -C .. -C sibling push origin HEAD:main", "C:/work/current"), path.resolve("C:/work/sibling"));

assert.deepEqual(riskyFiles(["src/pages/Home.tsx", "supabase/migrations/1.sql"]), ["supabase/migrations/1.sql"]);
// Codex round-7 (PR #142): reviewer charters + the proof-minting wrapper are
// gate machinery — editing them must itself require the second-model verdict.
assert.deepEqual(riskyFiles([".claude/agents/rls-security-reviewer.md"]), [".claude/agents/rls-security-reviewer.md"]);
assert.deepEqual(riskyFiles(["scripts/write-apply-proofs.mjs"]), ["scripts/write-apply-proofs.mjs"]);
// Codex round-8 (PR #142): the hook-registration surfaces — a PR that
// de-registers a guard by editing only these must still require the verdict.
assert.deepEqual(riskyFiles([".claude/settings.json"]), [".claude/settings.json"]);
assert.deepEqual(riskyFiles([".codex/hooks.json"]), [".codex/hooks.json"]);
assert.deepEqual(
  riskyFiles([
    "src/pages/Home.tsx",
    ".claude/hooks/codex-push-lib.mjs",
    ".codex/hooks/production-action-guard.mjs",
    ".github/workflows/ci.yml",
    ".husky/pre-push",
    "scripts/run-claude-review.mjs",
    "scripts/write-codex-push-proof.mjs",
  ]),
  [
    ".claude/hooks/codex-push-lib.mjs",
    ".codex/hooks/production-action-guard.mjs",
    ".github/workflows/ci.yml",
    ".husky/pre-push",
    "scripts/run-claude-review.mjs",
    "scripts/write-codex-push-proof.mjs",
  ],
  "guardrail and CI self-modifications always require second-model review",
);
// The sole Codex-proof producer must itself be risky: a later edit to it cannot
// slip to main without an independent second-model review of that edit.
assert.deepEqual(riskyFiles(["scripts/write-codex-push-proof.mjs"]), ["scripts/write-codex-push-proof.mjs"]);
assert.equal(contentIsRisky("+ const total_cents = 100"), true);
assert.equal(contentIsRisky("+ const title = 'ordinary'"), false);

const base = "c".repeat(40);
const codexProof = { codex_ran: true, verdict: "clean", head_sha: sha, base_sha: base, timestamp: new Date(now).toISOString() };
assert.equal(proofValid(codexProof, sha, now), true);
assert.equal(proofValid({ ...codexProof, timestamp: new Date(now - 30 * 60 * 1000).toISOString() }, sha, now), true);
assert.equal(proofValid({ ...codexProof, timestamp: new Date(now - 30 * 60 * 1000 - 1).toISOString() }, sha, now), false);
assert.equal(proofValid({ ...codexProof, timestamp: new Date(now + 1).toISOString() }, sha, now), false);
assert.equal(proofValid({ ...codexProof, head_sha: "" }, sha, now), false);

// Base-SHA binding (2026-07-14): when the guard supplies the origin/main it is
// gating against, the proof's base_sha must match. A moved base — origin/main
// advanced by a sibling merge fetched locally, without touching HEAD or the
// worktree — must invalidate a proof that would otherwise still look fresh.
assert.equal(proofValid(codexProof, sha, now, base), true, "matching base_sha passes");
assert.equal(proofValid(codexProof, sha, now, "d".repeat(40)), false, "moved base (base_sha mismatch) → invalid");
assert.equal(
  proofValid({ ...codexProof, base_sha: undefined }, sha, now, base),
  false,
  "pre-hardening proof with no base_sha fails closed once a base is required",
);
// Backward-compat: with no base expectation supplied the base check is skipped,
// mirroring how the head_sha check is gated on a supplied headSha.
assert.equal(proofValid({ ...codexProof, base_sha: undefined }, sha, now), true, "base check is skipped when no base is expected");

const claudeProof = { claude_ran: true, verdict: "blockers-fixed", head_sha: sha, base_sha: base, timestamp: new Date(now).toISOString() };
assert.equal(claudeProofValid(claudeProof, sha, now), true);
assert.equal(claudeProofValid({ ...claudeProof, claude_ran: false }, sha, now), false);
assert.equal(claudeProofValid({ ...claudeProof, verdict: "ship" }, sha, now), false);
assert.equal(claudeProofValid({ ...claudeProof, head_sha: "b".repeat(40) }, sha, now), false);
assert.equal(claudeProofValid({ ...claudeProof, timestamp: new Date(now + 60_000).toISOString() }, sha, now), false);
assert.equal(claudeProofValid(claudeProof, sha, now, base), true, "matching base_sha passes (Claude proof)");
assert.equal(claudeProofValid(claudeProof, sha, now, "d".repeat(40)), false, "moved base → invalid (Claude proof)");
assert.equal(claudeProofValid({ ...claudeProof, base_sha: undefined }, sha, now, base), false, "no base_sha fails closed when a base is required (Claude proof)");

// Codex round-5 (2026-07-13): patch DESTINATIONS, not whole-body mentions.
assert.deepEqual(
  extractPatchDestinations("*** Add File: .claude/session-state/claude-review-push.json\n+{}"),
  [".claude/session-state/claude-review-push.json"],
);
assert.deepEqual(
  extractPatchDestinations("*** Update File: docs/reference/agent-guardrails.md\n+guard lives at .codex/hooks/production-action-guard.mjs"),
  ["docs/reference/agent-guardrails.md"],
  "prose mentions inside the patch body are NOT destinations",
);
assert.deepEqual(
  extractPatchDestinations("--- a/src/a.ts\n+++ b/src/b.ts\n+// mentions .claude/session-state/claude-review-push.json"),
  ["src/a.ts", "src/b.ts"],
  "unified-diff headers are destinations; body mentions are not",
);

console.log("OK - codex push shared library checks passed.");
