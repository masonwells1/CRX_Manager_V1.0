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
assert.equal(reviewProofPathMentioned(".claude/session-state/claude-review-latest.txt"), false);
assert.equal(reviewStateDirectoryMentioned("cd .claude/session-state"), true);
assert.equal(reviewStateDirectoryMentioned("C:\\repo\\.claude\\session-state"), true);

// Codex round-2 (2026-07-13): unambiguous long-option abbreviations count as force.
assert.equal(mainPushIsForced("git push origin main --force-w", "feature"), true);
assert.equal(mainPushIsForced("git push origin main --force-with", "feature"), true);
assert.equal(mainPushIsForced("git push origin main --force-if", "feature"), true);
assert.equal(mainPushIsForced("git push origin main --follow-tags", "feature"), false, "--follow-tags is not force intent");

assert.equal(gitPushCwd("git -C ../repo push origin HEAD:main", "C:/work/current"), path.resolve("C:/work/repo"));
assert.equal(gitPushCwd("git -C .. -C sibling push origin HEAD:main", "C:/work/current"), path.resolve("C:/work/sibling"));

assert.deepEqual(riskyFiles(["src/pages/Home.tsx", "supabase/migrations/1.sql"]), ["supabase/migrations/1.sql"]);
assert.equal(contentIsRisky("+ const total_cents = 100"), true);
assert.equal(contentIsRisky("+ const title = 'ordinary'"), false);

const codexProof = { codex_ran: true, verdict: "clean", head_sha: sha, timestamp: new Date(now).toISOString() };
assert.equal(proofValid(codexProof, sha, now), true);
assert.equal(proofValid({ ...codexProof, timestamp: new Date(now - 30 * 60 * 1000).toISOString() }, sha, now), true);
assert.equal(proofValid({ ...codexProof, timestamp: new Date(now - 30 * 60 * 1000 - 1).toISOString() }, sha, now), false);
assert.equal(proofValid({ ...codexProof, timestamp: new Date(now + 1).toISOString() }, sha, now), false);
assert.equal(proofValid({ ...codexProof, head_sha: "" }, sha, now), false);

const claudeProof = { claude_ran: true, verdict: "blockers-fixed", head_sha: sha, timestamp: new Date(now).toISOString() };
assert.equal(claudeProofValid(claudeProof, sha, now), true);
assert.equal(claudeProofValid({ ...claudeProof, claude_ran: false }, sha, now), false);
assert.equal(claudeProofValid({ ...claudeProof, verdict: "ship" }, sha, now), false);
assert.equal(claudeProofValid({ ...claudeProof, head_sha: "b".repeat(40) }, sha, now), false);
assert.equal(claudeProofValid({ ...claudeProof, timestamp: new Date(now + 60_000).toISOString() }, sha, now), false);

console.log("OK - codex push shared library checks passed.");
