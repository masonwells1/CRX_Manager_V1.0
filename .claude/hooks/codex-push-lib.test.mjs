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
  repoIsGuardedApp,
  urlIsGuardedApp,
  pushDestinationToken,
  destinationLooksLikeUrl,
  pushUsesInlineConfig,
  pushUsesConfigEnv,
  rewritesReachGuardedApp,
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

// 2026-07-29: the risky-file gate reasons about THIS app's migrations, RLS and
// money code, so it only applies to THIS repo. It used to run against any repo
// the session pushed to, and blocked a backup snapshot because a markdown note
// was named `project_policy-grantee-...` (the `/policy|grant/i` pattern is
// unanchored). Scope by remote URL; do NOT weaken the patterns.
assert.equal(repoIsGuardedApp("origin\tgit@github.com:masonwells1/CRX_Manager_V1.0.git (push)"), true);
assert.equal(repoIsGuardedApp("origin\thttps://github.com/masonwells1/CRX_Manager_V1.0 (push)"), true);
assert.equal(repoIsGuardedApp("origin\tgit@github.com:masonwells1/CRX_Backups.git (push)"), false);
assert.equal(repoIsGuardedApp("origin\tgit@github.com:masonwells1/FarmRx.git (push)"), false);
// A second remote pointing at the app repo still gates the push.
assert.equal(
  repoIsGuardedApp("backup\tgit@github.com:masonwells1/CRX_Backups.git (push)\norigin\tgit@github.com:masonwells1/CRX_Manager_V1.0.git (push)"),
  true,
);
// Fails CLOSED: an empty/unreadable remote list must gate, never wave through.
assert.equal(repoIsGuardedApp(""), true);
assert.equal(repoIsGuardedApp(null), true);
assert.equal(repoIsGuardedApp(undefined), true);
// A look-alike repo name must NOT be mistaken for the real one.
assert.equal(repoIsGuardedApp("origin\tgit@github.com:someoneelse/CRX_Manager_V1.0.git (push)"), false);
assert.equal(repoIsGuardedApp("origin\tgit@github.com:masonwells1/CRX_Manager_V1.0_fork.git (push)"), false);

// 2026-07-30 (Codex pre-push review): scoping by CONFIGURED remotes alone is a
// bypass — a push can name the app repo's URL directly from a checkout whose
// configured remote is something unrelated. The destination must be classified
// on its own, and it too fails CLOSED.
assert.equal(urlIsGuardedApp("git@github.com:masonwells1/CRX_Manager_V1.0.git"), true);
assert.equal(urlIsGuardedApp("https://github.com/masonwells1/CRX_Manager_V1.0"), true);
assert.equal(urlIsGuardedApp("https://github.com/masonwells1/CRX_Manager_V1.0/"), true, "trailing slash still matches");
assert.equal(urlIsGuardedApp("git@github.com:masonwells1/CRX_Backups.git"), false);
assert.equal(urlIsGuardedApp("git@github.com:someoneelse/CRX_Manager_V1.0.git"), false);
assert.equal(urlIsGuardedApp(""), true, "unresolvable destination gates");
assert.equal(urlIsGuardedApp(null), true);
assert.equal(urlIsGuardedApp(undefined), true);

// The destination token is the first non-option positional after `push`.
assert.equal(pushDestinationToken("git push origin main"), "origin");
assert.equal(pushDestinationToken("git -C /repo push origin HEAD:main"), "origin");
assert.equal(
  pushDestinationToken("git push git@github.com:masonwells1/CRX_Manager_V1.0.git HEAD:main"),
  "git@github.com:masonwells1/CRX_Manager_V1.0.git",
  "a direct URL destination is the one that matters",
);
assert.equal(pushDestinationToken("git push"), null, "no destination named — caller resolves git's default");
assert.equal(pushDestinationToken("git push -u origin main"), "origin");
// Options that consume the NEXT token must not be mistaken for the destination.
assert.equal(pushDestinationToken("git push -o ci.skip origin main"), "origin");
assert.equal(pushDestinationToken("git push --push-option=ci.skip origin main"), "origin");
assert.equal(pushDestinationToken("git push --receive-pack /usr/bin/rp origin main"), "origin");
// `--repo=<url>` names the destination even with a positional present.
assert.equal(pushDestinationToken("git push --repo=git@github.com:masonwells1/CRX_Manager_V1.0.git"), "git@github.com:masonwells1/CRX_Manager_V1.0.git");
assert.equal(pushDestinationToken("git push --repo git@github.com:masonwells1/CRX_Backups.git"), "git@github.com:masonwells1/CRX_Backups.git");

// A remote NAME can contain neither `:` nor a path separator, so anything that
// does is a URL/path and must be classified directly rather than looked up.
assert.equal(destinationLooksLikeUrl("origin"), false);
assert.equal(destinationLooksLikeUrl("backup-remote"), false);
assert.equal(destinationLooksLikeUrl("git@github.com:masonwells1/CRX_Manager_V1.0.git"), true);
assert.equal(destinationLooksLikeUrl("https://github.com/masonwells1/CRX_Manager_V1.0"), true);
assert.equal(destinationLooksLikeUrl("../sibling-repo"), true);
assert.equal(destinationLooksLikeUrl("C:\\repos\\CRX_Manager_V1.0"), true);
assert.equal(destinationLooksLikeUrl(""), false);
assert.equal(destinationLooksLikeUrl(null), false);

// 2026-07-30 (Codex pre-push review, round 2): inline config is a second bypass.
// The guard resolves the destination with its OWN git calls, which never see a
// `-c` override, so `-c remote.origin.pushurl=<app repo>` sends the push to
// production while every lookup still describes the unrelated checkout.
assert.equal(
  pushUsesInlineConfig("git -c remote.origin.pushurl=git@github.com:masonwells1/CRX_Manager_V1.0.git push origin HEAD:main"),
  true,
);
assert.equal(pushUsesInlineConfig("git -c http.sslVerify=false push origin main"), true);
assert.equal(pushUsesInlineConfig("git --config-env=remote.origin.pushurl=VAR push origin main"), true);
// `-C` (directory) differs from `-c` (config) only in case. Matching it would
// deny every legitimate push this repo makes, so the check must stay case-sensitive.
assert.equal(pushUsesInlineConfig("git -C /repo push origin main"), false, "-C is the directory flag, not config");
assert.equal(pushUsesInlineConfig("git -C C:/CRX_Manager push -u origin feature"), false);
assert.equal(pushUsesInlineConfig("git push origin main"), false);
// A `-c` that is not part of a push command must not trip the check.
assert.equal(pushUsesInlineConfig("git -c user.name=x commit -m nope"), false, "not a push");

// A URL rewrite reaches production under an alias: `git push crx: main` looks
// unguarded on its own, but resolves to the app repo.
assert.equal(
  rewritesReachGuardedApp("url.git@github.com:masonwells1/CRX_Manager_V1.0.git.pushinsteadof crx:"),
  true,
);
assert.equal(
  rewritesReachGuardedApp("url.https://github.com/masonwells1/CRX_Manager_V1.0.insteadof crx:"),
  true,
);
assert.equal(
  rewritesReachGuardedApp("url.git@github.com:masonwells1/CRX_Backups.git.pushinsteadof bk:"),
  false,
  "a rewrite pointing somewhere else is not this gate's business",
);
assert.equal(rewritesReachGuardedApp(""), false, "no rewrites configured is not a risk");
assert.equal(rewritesReachGuardedApp(null), false);
// One app-repo rewrite among several still gates.
assert.equal(
  rewritesReachGuardedApp(
    "url.git@github.com:masonwells1/CRX_Backups.git.insteadof bk:\nurl.git@github.com:masonwells1/CRX_Manager_V1.0.git.pushinsteadof crx:",
  ),
  true,
);
// A malformed line yields an empty base, which fails CLOSED.
assert.equal(rewritesReachGuardedApp("garbage"), true, "unparseable rewrite config gates");

const base = "c".repeat(40);
const codexProof = { codex_ran: true, verdict: "clean", head_sha: sha, base_sha: base, timestamp: new Date(now).toISOString() };
assert.equal(proofValid(codexProof, sha, now), true);
assert.equal(proofValid({ ...codexProof, timestamp: new Date(now - 30 * 60 * 1000).toISOString() }, sha, now), true);
assert.equal(proofValid({ ...codexProof, timestamp: new Date(now - 30 * 60 * 1000 - 1).toISOString() }, sha, now), false);
assert.equal(proofValid({ ...codexProof, timestamp: new Date(now + 1).toISOString() }, sha, now), false);
assert.equal(proofValid({ ...codexProof, head_sha: "" }, sha, now), false);
assert.equal(
  proofValid({ ...codexProof, verdict: "blockers-fixed" }, sha, now),
  false,
  "obsolete blockers-fixed Codex proof is rejected",
);

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

const claudeProof = { claude_ran: true, verdict: "clean", head_sha: sha, base_sha: base, timestamp: new Date(now).toISOString() };
assert.equal(claudeProofValid(claudeProof, sha, now), true);
assert.equal(claudeProofValid({ ...claudeProof, claude_ran: false }, sha, now), false);
assert.equal(
  claudeProofValid({ ...claudeProof, verdict: "blockers-fixed" }, sha, now),
  false,
  "obsolete blockers-fixed Claude proof is rejected",
);
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

// --- GIT_CONFIG* environment overrides (Codex 2026-07-30, round 3) ------------
// Proven live: with `origin` pointing elsewhere, GIT_CONFIG_KEY_0=
// remote.origin.pushurl redirected the push to a different repository.
const CRX_URL = "git@github.com:masonwells1/CRX_Manager_V1.0.git";
assert.equal(
  pushUsesConfigEnv(`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.pushurl GIT_CONFIG_VALUE_0=${CRX_URL} git -C /repo push origin main`),
  true,
);
assert.equal(pushUsesConfigEnv("GIT_CONFIG_COUNT=2 git push origin main"), true);
// The assignment can sit in its own command segment. The guard therefore checks
// this against the WHOLE command rather than the per-push segments it splits out
// — the per-segment version passed every other case here and still let this one
// through when probed end-to-end.
assert.equal(pushUsesConfigEnv("GIT_CONFIG_COUNT=1 && git push origin main"), true, "chained with &&");
assert.equal(pushUsesConfigEnv("GIT_CONFIG_KEY_0=remote.origin.pushurl\ngit push origin main"), true, "chained with a newline");
assert.equal(pushUsesConfigEnv("export GIT_CONFIG_KEY_0=remote.origin.pushurl; git push origin main"), true);
assert.equal(pushUsesConfigEnv("GIT_CONFIG_GLOBAL=/tmp/evil git push origin main"), true);
assert.equal(pushUsesConfigEnv("GIT_CONFIG_SYSTEM=/tmp/evil git push origin main"), true);
assert.equal(pushUsesConfigEnv("GIT_CONFIG=/tmp/evil git push origin main"), true, "bare GIT_CONFIG redirects config too");
assert.equal(pushUsesConfigEnv('$env:GIT_CONFIG_COUNT = "1"; git push origin main'), true, "PowerShell env form");
// Must not fire on ordinary pushes, or on the documented keepalive workaround.
assert.equal(pushUsesConfigEnv("git -C C:/CRX_Manager push origin feature"), false);
assert.equal(pushUsesConfigEnv('GIT_SSH_COMMAND="ssh -o ServerAliveInterval=20" git -C /repo push origin feature'), false, "transport env is not a destination override");
assert.equal(pushUsesConfigEnv("GIT_CONFIG_COUNT=1 git commit -m x"), false, "not a push");
assert.equal(pushUsesConfigEnv(""), false);
assert.equal(pushUsesConfigEnv(null), false);
// A variable that merely ENDS in the name is not an override.
assert.equal(pushUsesConfigEnv("MY_GIT_CONFIG_COUNT=1 git push origin main"), false);

// --- `--repo` vs a positional destination -------------------------------------
// git-push: "if both are specified, the command-line argument takes precedence".
// Verified against git 2.54 on 2026-07-30.
assert.equal(
  pushDestinationToken(`git push --repo=https://example.invalid/harmless.git ${CRX_URL} HEAD:main`),
  CRX_URL,
  "a positional destination overrides --repo, exactly as git does",
);
assert.equal(pushDestinationToken(`git push --repo=${CRX_URL}`), CRX_URL, "--repo still names the destination when there is no positional");
assert.equal(pushDestinationToken(`git push --repo ${CRX_URL}`), CRX_URL, "separate-argument --repo form");
assert.equal(pushDestinationToken(`git push --repo=${CRX_URL} -- origin main`), "origin", "after `--` the positional still wins");
assert.equal(pushDestinationToken("git push origin main"), "origin");
assert.equal(pushDestinationToken("git push"), null);

console.log("OK - codex push shared library checks passed.");
