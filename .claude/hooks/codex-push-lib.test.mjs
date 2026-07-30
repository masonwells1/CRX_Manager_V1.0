#!/usr/bin/env node

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { scratchHookEnvironment } from "./git-test-env.mjs";
import {
  claudeProofValid,
  contentIsRisky,
  gitPushCwd,
  mainPushIsForced,
  mainPushSource,
  pushIsForced,
  isGitPush,
  executableTransportSettings,
  urlUsesUnknownTransport,
  environmentSelectsDifferentRepo,
  eachPush,
  pushNamesRemoteProgram,
  pushHiddenByShellComposition,
  pushContextIsAmbiguous,
  pushUsesBulkMode,
  reviewProofPathMentioned,
  reviewStateDirectoryMentioned,
  extractPatchDestinations,
  proofValid,
  repoIsGuardedApp,
  urlIsGuardedApp,
  pushUsesTransportEnv,
  environmentCarriesTransportOverride,
  pushDestinationToken,
  destinationLooksLikeUrl,
  pushUsesInlineConfig,
  pushUsesConfigEnv,
  pushUsesConfigRootEnv,
  pushSetsInlineEnv,
  shellSegments,
  unknownPushOptions,
  environmentCarriesConfigOverride,
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

// Round 9: repository IDENTITY, not string shape. Every form below is the
// production repo as far as git and any URL parser are concerned; the old suffix
// match saw an unrelated repo and skipped the gate.
assert.equal(
  urlIsGuardedApp("https://github.com/masonwells1/./CRX_Manager_V1.0.git"), true,
  "a `.` segment still resolves to the app repo",
);
assert.equal(
  urlIsGuardedApp("https://github.com/masonwells1/other/../CRX_Manager_V1.0.git"), true,
  "a `..` segment still resolves to the app repo",
);
assert.equal(
  urlIsGuardedApp("https://github.com//masonwells1//CRX_Manager_V1.0.git"), true,
  "doubled separators still resolve to the app repo",
);
assert.equal(
  urlIsGuardedApp("https://GitHub.com/MasonWells1/crx_manager_v1.0.git"), true,
  "host, owner and repo compare case-insensitively",
);
assert.equal(
  urlIsGuardedApp("https://token@github.com/masonwells1/CRX_Manager_V1.0.git"), true,
  "embedded credentials do not change which repo it is",
);
assert.equal(
  urlIsGuardedApp("ssh://git@github.com/masonwells1/CRX_Manager_V1.0.git"), true,
  "the ssh:// spelling is the same repo",
);
// Round 11: GitHub's documented port-443 SSH endpoint, for networks that block
// port 22. Same repository, different hostname — on host name alone it read as
// somewhere unrelated and the proof gate was skipped.
assert.equal(
  urlIsGuardedApp("ssh://git@ssh.github.com:443/masonwells1/CRX_Manager_V1.0.git"), true,
  "the port-443 ssh endpoint is the same repo",
);
assert.equal(
  urlIsGuardedApp("git@ssh.github.com:masonwells1/CRX_Manager_V1.0.git"), true,
  "and its scp-like spelling",
);
assert.equal(
  urlIsGuardedApp("https://www.github.com/masonwells1/CRX_Manager_V1.0.git"), true,
  "so is the www host",
);
assert.equal(
  urlIsGuardedApp("ssh://git@ssh.github.com:443/masonwells1/CRX_Backups.git"), false,
  "the alias does not make every repo on that host the app repo",
);
assert.equal(
  urlIsGuardedApp("https://github.com/masonwells1/CRX_Manager_V1.0.wiki.git"), false,
  "a different repo whose name merely starts the same is not the app repo",
);
// SUPERSEDED BY ROUND 16 (2026-07-30). This used to assert false, on the premise
// that the host name identifies the repository. Round 16 showed the premise is
// wrong: `github-crx:masonwells1/CRX_Manager_V1.0.git` is an ssh_config Host alias
// that git resolves to github.com, and an alias can be spelled with a dot as
// easily as without, so no host name can be trusted and no list of them can be
// complete. The guard now decides on the owner/repo path alone. The cost of that
// is this case — a hypothetical foreign host serving the same owner/repo path
// gets reviewed too. One extra review is the cheap side of the trade; the other
// side is an ungated push to the production app.
assert.equal(
  urlIsGuardedApp("https://example.com/masonwells1/CRX_Manager_V1.0.git"), true,
  "the app repo's owner/repo path is gated on any host, because a host name can be an alias",
);
assert.equal(
  urlIsGuardedApp("https://example.com/someoneelse/CRX_Manager_V1.0.git"), false,
  "but the gate is still scoped to this owner's repo, not to the name anywhere",
);
assert.equal(
  urlIsGuardedApp("https://[not-a-url"), true,
  "a destination that names a host but cannot be parsed fails CLOSED",
);
assert.equal(urlIsGuardedApp("origin"), false, "a bare remote name is resolved elsewhere");
assert.equal(
  urlIsGuardedApp("C:/Users/mason/scratch/dest.git"), false,
  "a local filesystem destination names no host",
);
assert.equal(
  repoIsGuardedApp("origin\thttps://github.com/masonwells1/./CRX_Manager_V1.0.git (push)"), true,
  "the checkout's remotes are canonicalized the same way",
);

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
// Percent-escapes are decoded before identity is decided — the server decodes
// them, so `%43RX_Manager_V1.0` IS the production repository.
assert.equal(
  urlIsGuardedApp("https://github.com/masonwells1/%43RX_Manager_V1.0.git"), true,
  "a percent-encoded repo name is still the app repo",
);
assert.equal(
  urlIsGuardedApp("git@github.com:masonwells1%2FCRX_Manager_V1.0.git"), true,
  "an encoded separator does not hide the owner segment",
);
assert.equal(
  urlIsGuardedApp("https://github.com/masonwells1/CRX%ZZ.git"), true,
  "a malformed escape is undecodable and fails CLOSED",
);
assert.equal(
  urlIsGuardedApp("https://github.com/masonwells1/%43RX_Backups.git"), false,
  "decoding does not turn an unrelated repo into this one",
);
// ── round 16: a `~/.ssh/config` Host alias is still github.com ───────────────
// `github-crx` is local text that resolves to github.com on the pushing machine,
// so no list of host names can be complete. Identity is the owner/repo path.
assert.equal(
  urlIsGuardedApp("github-crx:masonwells1/CRX_Manager_V1.0.git"), true,
  "an ssh Host alias does not hide the production repo",
);
assert.equal(
  urlIsGuardedApp("ssh://git@github-crx/masonwells1/CRX_Manager_V1.0.git"), true,
  "nor does the ssh:// spelling of the same alias",
);
assert.equal(
  urlIsGuardedApp("github-crx:masonwells1/CRX_Backups.git"), false,
  "and the alias rule does not start policing the private backup repo",
);

// ── round 21: the same instruction, stored instead of typed ──────────────────
// Round 17 denied `--receive-pack` on the command line. Git stores it too, and
// `core.sshCommand` replaces the SSH binary outright — neither appears in the
// push text, so no parser sees them.
{
  const list = [
    "core.sshcommand=ssh -i /tmp/relay",
    "remote.backup.receivepack=/tmp/relay",
    "remote.origin.url=git@github.com:masonwells1/CRX_Backups.git",
    "user.name=Mason",
  ].join("\n");
  const found = executableTransportSettings(list);
  assert.ok(found.includes("core.sshcommand"), "core.sshCommand is named");
  assert.ok(found.includes("remote.backup.receivepack"), "a stored receivepack is named");
  assert.equal(found.length, 2, "and nothing innocent is swept up with them");
}
assert.deepEqual(
  executableTransportSettings("user.name=Mason\nremote.origin.url=git@github.com:x/y.git"), [],
  "an ordinary configuration names no programs",
);
assert.deepEqual(executableTransportSettings(""), [], "and an empty config is empty");
assert.ok(
  executableTransportSettings("CORE.SSHCOMMAND=ssh").includes("core.sshcommand"),
  "git config keys are case-insensitive, so the check is too",
);
assert.ok(
  executableTransportSettings("remote.b.uploadpack /tmp/relay").includes("remote.b.uploadpack"),
  "and --get-regexp's space-separated output reads the same as --list's",
);
assert.ok(
  executableTransportSettings("protocol.ext.command=/tmp/relay").includes("protocol.ext.command"),
  "the transport-helper command setting is named too",
);

// ── round 22: an unknown scheme names a program, not a place ─────────────────
// Git dispatches any scheme it does not implement to `git-remote-<scheme>`, which
// is free to ignore the address. Unlike `ext::`, these PARSE — so canonicalRepoId
// hands back a tidy repository id and the URL reads as a perfectly ordinary,
// perfectly unrelated destination unless the scheme itself is checked first.
for (const ordinary of [
  "https://github.com/someone/else.git",
  "http://example.invalid/x.git",
  "ssh://git@github.com/masonwells1/CRX_Manager_V1.0.git",
  "git://example.invalid/x.git",
  "file:///c/repos/bare.git",
  "git@github.com:someone/else.git",
  "origin",
  "../scratch/bare.git",
]) {
  assert.equal(urlUsesUnknownTransport(ordinary), false, `${ordinary} uses a transport git implements itself`);
}
for (const courier of ["relay://example.invalid/harmless.git", "RELAY://example.invalid/x.git", "ftp://example.invalid/x.git"]) {
  assert.equal(urlUsesUnknownTransport(courier), true, `${courier} hands delivery to a helper program`);
}
assert.equal(
  urlIsGuardedApp("relay://example.invalid/harmless.git"), true,
  "an unknown scheme gates even when the address it names is unrelated",
);
assert.equal(
  urlIsGuardedApp("relay://github.com/masonwells1/CRX_Backups.git"), true,
  "and even when it canonicalizes to a repository that would otherwise be allowed",
);
assert.equal(
  urlIsGuardedApp("https://github.com/someone/else.git"), false,
  "while an ordinary https destination is still classified on its repository",
);

// ── round 22: a repository selector inherited from the shell ─────────────────
// GIT_INDEX_FILE and GIT_PREFIX are deliberately NOT selectors here: git sets
// them itself when it runs a hook, and neither can move a push's destination.
assert.deepEqual(environmentSelectsDifferentRepo({ PATH: "/usr/bin" }), [], "an ordinary environment selects nothing");
assert.deepEqual(environmentSelectsDifferentRepo({ GIT_DIR: "/tmp/other/.git" }), ["GIT_DIR"], "GIT_DIR is a selection");
assert.deepEqual(environmentSelectsDifferentRepo({ GIT_WORK_TREE: "/tmp/other" }), ["GIT_WORK_TREE"], "so is GIT_WORK_TREE");
assert.deepEqual(environmentSelectsDifferentRepo({ GIT_NAMESPACE: "x" }), ["GIT_NAMESPACE"], "so is a namespace");
assert.deepEqual(environmentSelectsDifferentRepo({ GIT_DIR: "  " }), [], "an empty value selects nothing");
assert.deepEqual(
  environmentSelectsDifferentRepo({ GIT_INDEX_FILE: "/tmp/i", GIT_PREFIX: "sub/" }), [],
  "and the variables git itself exports into hooks are not selections",
);

// ── round 20: a command can start right after a separator, with no space ─────
// `npm test&&git push …` is an ordinary shell line. Requiring whitespace before
// `git` meant the hook saw NO push and exited before every check it exists for.
// Codex probed all three separators and got zero detected pushes.
for (const cmd of [
  "npm test&&git push origin HEAD:main",
  "echo ok;git push origin HEAD:main",
  "echo ok|git push origin HEAD:main",
]) {
  assert.equal(isGitPush(cmd), true, `a push right after a separator is seen: ${cmd}`);
  assert.equal(eachPush(cmd).length, 1, `and is enumerated for per-push checks: ${cmd}`);
}
assert.equal(
  isGitPush("npm test && git push origin HEAD:main"), true,
  "the spaced spelling still works",
);
assert.equal(
  isGitPush("echo notagit push"), false,
  "and a word merely ENDING in git does not become a push",
);
// `(` stays out of the boundary class on purpose: a substitution must keep
// failing this test so the round-19 check refuses it rather than inspecting text
// the shell rewrites.
assert.equal(
  isGitPush("$(git push origin HEAD:main)"), false,
  "a command substitution is still not read as an ordinary push",
);
assert.equal(
  pushHiddenByShellComposition("$(git push origin HEAD:main)"), true,
  "so the substitution check is still the thing that catches it",
);

// ── round 19: the shell runs something other than the text we matched ────────
// Three spellings Codex probed straight past every check in the file. The rule
// is not "recognise these three" — it is that a command which only becomes a
// push after the shell rewrites it is refused instead of analysed.
assert.equal(
  pushHiddenByShellComposition(`git p"us"h origin HEAD:main`), true,
  "quote splicing that the shell concatenates back into `push` is caught",
);
assert.equal(
  pushHiddenByShellComposition(`git p'us'h origin HEAD:main`), true,
  "including the single-quote spelling",
);
assert.equal(
  pushHiddenByShellComposition("$(git push origin HEAD:main)"), true,
  "a command substitution that runs a push is caught",
);
assert.equal(
  pushHiddenByShellComposition("`git push origin HEAD:main`"), true,
  "and the backtick spelling of the same thing",
);
assert.equal(
  pushHiddenByShellComposition("git -C /repo push origin HEAD:main"), false,
  "an ordinary push is NOT flagged — it takes the normal inspected path",
);
assert.equal(
  pushHiddenByShellComposition("npm run build"), false,
  "and a command with no push in any reading is left alone",
);

// ── round 18: a destination that names a PROGRAM, not an address ─────────────
// `ext::<command>` is git's remote-helper syntax: delivery is handed to an
// arbitrary program, so the address written on the command means nothing. Codex
// probed exactly this and got `guarded: false` for the production app repo. The
// last-resort rule is inverted rather than extended — only a plain remote name
// or a plain filesystem path may still be judged by pattern; a leftover colon
// means unresolvable, and unresolvable fails CLOSED.
assert.equal(
  urlIsGuardedApp("ext::ssh git@github.com %S masonwells1/CRX_Manager_V1.0.git"), true,
  "a remote-helper destination naming the production repo is guarded",
);
assert.equal(
  urlIsGuardedApp("ext::ssh relay-host %S someone/anything.git"), true,
  "and one naming anything else is too — the helper decides where it lands",
);
assert.equal(
  urlIsGuardedApp("transport::whatever"), true,
  "the rule is the syntax, not the `ext` spelling of it",
);
assert.equal(
  urlIsGuardedApp("upstream-2"), false,
  "a plain remote name is still resolved elsewhere",
);
assert.equal(
  urlIsGuardedApp("../scratch/bare.git"), false,
  "and so is a relative filesystem path",
);
assert.equal(
  urlIsGuardedApp("C:\\repos\\bare.git"), false,
  "a Windows drive letter is a path, not a host — the drive colon does not gate",
);
// The inverted last-resort rule itself: a destination that did not canonicalize
// and still carries a colon names something this guard cannot resolve. It is not
// enough that the `::` check above caught the helper spelling — the point of
// inverting the rule is that unrecognised shapes gate WITHOUT being enumerated.
assert.equal(
  urlIsGuardedApp("a:b"), true,
  "an uncanonicalizable colon destination fails CLOSED rather than reading as unrelated",
);
assert.equal(
  urlIsGuardedApp("weird-host:"), true,
  "including one with nothing after the colon",
);
assert.equal(
  repoIsGuardedApp("origin\tgithub-crx:masonwells1/CRX_Manager_V1.0.git (push)"), true,
  "a checkout whose only remote is an aliased app-repo URL is the app repo",
);
assert.equal(
  rewritesReachGuardedApp("url.github-crx:masonwells1/.insteadof ghm:"),
  true,
  "an aliased owner-level prefix rewrite reaches production too",
);
// insteadOf is a PREFIX substitution: `ghm:CRX_Manager_V1.0.git` expands to the
// production repo even though the base names no repository on its own.
assert.equal(
  rewritesReachGuardedApp("url.git@github.com:masonwells1/.insteadof ghm:"),
  true,
  "an owner-level prefix rewrite reaches production",
);
assert.equal(
  rewritesReachGuardedApp("url.https://github.com/masonwells1/.pushinsteadof ghm:"),
  true,
  "the https spelling of the same prefix too",
);
assert.equal(
  rewritesReachGuardedApp("url.https://github.com/.insteadof gh:"),
  true,
  "a base naming only a host resolves nowhere and fails CLOSED",
);
assert.equal(
  rewritesReachGuardedApp("url.git@github.com:someoneelse/.insteadof other:"),
  false,
  "a prefix under a different owner cannot complete to the app repo",
);

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
// ── round 12: transport variables, wherever they are written ────────────────
assert.deepEqual(
  pushUsesTransportEnv(`export GIT_SSH_COMMAND="sh -c evil"; git push origin HEAD:main`),
  ["GIT_SSH_COMMAND"], "a prior-segment export is in scope",
);
assert.deepEqual(
  pushUsesTransportEnv(`GIT_SSH_COMMAND="ssh -o ServerAliveInterval=20" git push origin HEAD:main`),
  [], "the documented keepalive value is allowed wherever it appears",
);
assert.deepEqual(
  pushUsesTransportEnv(`export GIT_SSH_COMMAND='ssh -o BatchMode=yes'; git push origin main`),
  [], "single-quoted keepalive too",
);
assert.deepEqual(
  pushUsesTransportEnv(`echo $GIT_SSH_COMMAND && git push origin main`),
  ["GIT_SSH_COMMAND"], "a mention the guard cannot verify fails CLOSED",
);
assert.deepEqual(pushUsesTransportEnv(`git push origin main`), [], "an ordinary push names none");
assert.deepEqual(pushUsesTransportEnv(`export GIT_SSH_COMMAND=evil; echo hi`), [], "not a push at all");
assert.deepEqual(
  environmentCarriesTransportOverride({ GIT_SSH_COMMAND: "sh -c evil", PATH: "/usr/bin" }),
  ["GIT_SSH_COMMAND"], "an inherited arbitrary value is reported",
);
assert.deepEqual(
  environmentCarriesTransportOverride({ GIT_SSH_COMMAND: "ssh -o ServerAliveInterval=20", GIT_TERMINAL_PROMPT: "0" }),
  [], "inherited values in the sanctioned shapes are not",
);
assert.deepEqual(
  environmentCarriesTransportOverride({ GIT_ASKPASS: "/tmp/x", GIT_PROXY_COMMAND: "/tmp/y" }).sort(),
  ["GIT_ASKPASS", "GIT_PROXY_COMMAND"], "every offending name is listed, not just the first",
);
// Git exports GIT_EXEC_PATH into every hook it runs, so an inherited one says
// nothing about intent. Treating it as an offender denied ordinary pushes.
assert.deepEqual(
  environmentCarriesTransportOverride({ GIT_EXEC_PATH: "C:/Program Files/Git/mingw64/libexec/git-core" }),
  [], "an inherited GIT_EXEC_PATH is git's own export, not a finding",
);
assert.deepEqual(
  pushUsesTransportEnv(`GIT_EXEC_PATH=/tmp/evil git push origin main`),
  ["GIT_EXEC_PATH"], "writing it into the command is still a deliberate act",
);

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
// Quoted assignments. The shell strips the quotes and Git still applies the
// variable, so a detector that demands whitespace before the name is open.
// Codex round-4 (2026-07-30) probed exactly this and got `false`.
assert.equal(pushUsesConfigEnv(`env 'GIT_CONFIG_COUNT=1' 'GIT_CONFIG_KEY_0=remote.origin.pushurl' 'GIT_CONFIG_VALUE_0=${CRX_URL}' git -C /repo push origin main`), true, "single-quoted env assignment");
assert.equal(pushUsesConfigEnv(`env "GIT_CONFIG_COUNT=1" git -C /repo push origin main`), true, "double-quoted env assignment");
assert.equal(pushUsesConfigEnv("env 'GIT_CONFIG_GLOBAL=/tmp/evil' git push origin main"), true, "quoted GIT_CONFIG_GLOBAL");
assert.equal(pushUsesConfigEnv("GIT_CONFIG_COUNT='1' git push origin main"), true, "quoted VALUE, unquoted name");
assert.equal(pushUsesConfigEnv("env 'MY_GIT_CONFIG_COUNT=1' git push origin main"), false, "quoting does not turn an unrelated variable into an override");
// Round 5 (Codex, 2026-07-30): the detector listed variable names one by one and
// GIT_CONFIG_PARAMETERS was not on the list. Git honours it — verified against
// git 2.54 that it sets remote.origin.pushurl in a checkout that has none — so
// the whole `GIT_CONFIG*` namespace is denied rather than an enumerated subset.
assert.equal(
  pushUsesConfigEnv(`GIT_CONFIG_PARAMETERS="'remote.origin.pushurl=${CRX_URL}'" git -C /repo push origin main`),
  true,
  "GIT_CONFIG_PARAMETERS is a destination override",
);
assert.equal(pushUsesConfigEnv("env 'GIT_CONFIG_PARAMETERS=x' git push origin main"), true, "quoted GIT_CONFIG_PARAMETERS");
assert.equal(pushUsesConfigEnv('$env:GIT_CONFIG_PARAMETERS = "x"; git push origin main'), true, "PowerShell GIT_CONFIG_PARAMETERS");
// A name the namespace has not invented yet must be denied too — that is the
// point of matching the prefix instead of a list.
assert.equal(pushUsesConfigEnv("GIT_CONFIG_SOMETHING_NEW=x git push origin main"), true, "any future GIT_CONFIG_* variable is denied");
assert.equal(pushUsesConfigEnv("MY_GIT_CONFIG_PARAMETERS=x git push origin main"), false, "the prefix match is still anchored at a boundary");
// Round 6 (Codex, 2026-07-30): the detector still described the ASSIGNMENT
// syntax, and PowerShell has several. All four of these returned `false` before
// the rule became "mentions the namespace at all".
assert.equal(pushUsesConfigEnv("Set-Item Env:GIT_CONFIG_COUNT 1; git push origin HEAD:main"), true, "PowerShell Set-Item form");
assert.equal(pushUsesConfigEnv("${env:GIT_CONFIG_COUNT} = '1'; git push origin HEAD:main"), true, "PowerShell ${env:…} form");
assert.equal(pushUsesConfigEnv("New-Item -Path Env:GIT_CONFIG_KEY_0 -Value remote.origin.pushurl; git push origin main"), true, "PowerShell New-Item form");
// Not named by the round-6 review — found while probing it. A detector that
// enumerates syntax would have missed this one next.
assert.equal(pushUsesConfigEnv("[Environment]::SetEnvironmentVariable('GIT_CONFIG_COUNT','1'); git push origin main"), true, ".NET SetEnvironmentVariable form");
// Controls: the broadened rule must not start denying ordinary pushes.
assert.equal(pushUsesConfigEnv("git -C C:/CRX_Manager push origin feature"), false, "an ordinary push does not name the namespace");
assert.equal(pushUsesConfigEnv('GIT_SSH_COMMAND="ssh -o ServerAliveInterval=20" git -C /repo push origin feature'), false, "the keepalive workaround still passes");
assert.equal(pushUsesConfigEnv("Set-Item Env:GIT_CONFIG_COUNT 1"), false, "still only applies to push commands");

// --- a GIT_CONFIG* variable set by an EARLIER command (Codex 2026-07-30, round 6)
// The push command text is innocent; the variable is live in the environment the
// push inherits. The hook inherits the same one, so it checks directly.
assert.deepEqual(environmentCarriesConfigOverride({ PATH: "/usr/bin", GIT_EDITOR: "vi" }), [], "an ordinary environment is clean");
assert.deepEqual(environmentCarriesConfigOverride({ GIT_CONFIG_COUNT: "1" }), ["GIT_CONFIG_COUNT"]);
assert.deepEqual(environmentCarriesConfigOverride({ GIT_CONFIG_PARAMETERS: "x" }), ["GIT_CONFIG_PARAMETERS"]);
assert.deepEqual(environmentCarriesConfigOverride({ GIT_CONFIG: "/tmp/evil" }), ["GIT_CONFIG"]);
assert.deepEqual(environmentCarriesConfigOverride({ MY_GIT_CONFIG_COUNT: "1" }), [], "an unrelated variable is not an override");
assert.deepEqual(environmentCarriesConfigOverride({ GIT_SSH_COMMAND: "ssh" }), [], "transport variables are not destination overrides");
assert.deepEqual(environmentCarriesConfigOverride(null), [], "a missing environment is not a crash");

// --- config ROOT overrides (Codex 2026-07-30, round 7) -------------------------
// GIT_CONFIG* names a config file; HOME/XDG_CONFIG_HOME name the directory git
// searches for the global one. Proven against git 2.54 the same day: with HOME
// pointed at a scratch dir holding a .gitconfig with url.<real>.pushInsteadOf,
// `git push origin HEAD:main` landed in <real> while `git config --get-regexp
// '^url\..*insteadof$'` in the guard's own environment returned nothing.
assert.equal(pushUsesConfigRootEnv(`HOME=/tmp/evil git -C /repo push origin main`), true, "inline HOME override");
assert.equal(pushUsesConfigRootEnv(`XDG_CONFIG_HOME=/tmp/evil git push origin main`), true, "inline XDG_CONFIG_HOME override");
assert.equal(pushUsesConfigRootEnv(`env 'HOME=/tmp/evil' git push origin main`), true, "quoted HOME override");
assert.equal(pushUsesConfigRootEnv(`$env:HOME = "/tmp/evil"; git push origin main`), true, "PowerShell HOME override");
assert.equal(pushUsesConfigRootEnv(`Set-Item Env:USERPROFILE C:/evil; git push origin main`), true, "PowerShell USERPROFILE override");
assert.equal(pushUsesConfigRootEnv(`GIT_OBJECT_DIRECTORY=/tmp/o git push origin main`), true, "object-directory override");
assert.equal(pushUsesConfigRootEnv("git -C C:/CRX_Manager push origin feature"), false, "an ordinary push names none of them");
assert.equal(pushUsesConfigRootEnv("HOME=/tmp/evil git status"), false, "still only applies to push commands");
assert.equal(pushUsesConfigRootEnv("git push origin chore/HOMEPAGE-copy"), false, "a branch name containing HOMEPAGE is not an override");

// The general rule behind both: the guard resolves the destination in ITS
// environment, so a push carrying ANY variable the guard does not is a push the
// guard cannot vouch for. Allowlist, not denylist — naming variables one at a
// time failed rounds four, five, six and seven.
assert.deepEqual(pushSetsInlineEnv(`SOME_NEW_GIT_VAR=x git -C /repo push origin main`), ["SOME_NEW_GIT_VAR"], "an unheard-of variable is still denied");
assert.deepEqual(pushSetsInlineEnv(`env 'HOME=/tmp/evil' git push origin main`), ["HOME"], "the `env` form is seen too");
assert.deepEqual(pushSetsInlineEnv(`A=1 B=2 git push origin main`), ["A", "B"], "every assignment is reported");
assert.deepEqual(pushSetsInlineEnv(`GIT_SSH_COMMAND="ssh -o ServerAliveInterval=20" git -C /repo push origin feature`), [], "the sanctioned transport prefix is allowed");
assert.deepEqual(pushSetsInlineEnv("git -C C:/CRX_Manager push origin feature"), [], "an ordinary push sets nothing");
assert.deepEqual(pushSetsInlineEnv(`FOO=1 npm run build && git -C /repo push origin main`), [], "an assignment on an EARLIER chained command is not this push's prefix");
assert.deepEqual(pushSetsInlineEnv("HOME=/tmp/evil git status"), [], "still only applies to push commands");

// Round 9: GIT_SSH_COMMAND is an arbitrary command line git executes, not a
// transport setting. It can ignore the destination git hands it and run
// git-receive-pack against production while the guard reads only the innocent
// nominal destination. So the allowlist is by name AND value: the documented
// keepalive shape, and nothing else.
assert.deepEqual(
  pushSetsInlineEnv(`GIT_SSH_COMMAND="ssh -o ProxyCommand=nc evil 22" git push origin feature`),
  ["GIT_SSH_COMMAND"], "an unapproved ssh option is denied",
);
assert.deepEqual(
  pushSetsInlineEnv(`GIT_SSH_COMMAND="sh -c 'ssh prod git-receive-pack repo.git'" git push origin feature`),
  ["GIT_SSH_COMMAND"], "a shell command disguised as the transport is denied",
);
assert.deepEqual(
  pushSetsInlineEnv(`GIT_SSH_COMMAND="ssh evil-host" git push origin feature`),
  ["GIT_SSH_COMMAND"], "an ssh value naming a host is denied",
);
assert.deepEqual(
  pushSetsInlineEnv(`GIT_SSH_COMMAND="ssh -o ServerAliveInterval=20 && curl evil" git push origin feature`),
  ["GIT_SSH_COMMAND"], "the keepalive shape with anything appended is denied",
);
assert.deepEqual(
  pushSetsInlineEnv(`GIT_SSH_COMMAND="ssh -o ServerAliveInterval=20 -o ServerAliveCountMax=5" git push origin feature`),
  [], "the full documented keepalive form is still allowed",
);
assert.deepEqual(
  pushSetsInlineEnv(`GIT_SSH_COMMAND=ssh git push origin feature`), [], "plain ssh is still allowed",
);
assert.deepEqual(
  pushSetsInlineEnv(`GIT_TERMINAL_PROMPT=0 git push origin feature`), [], "the documented prompt value is allowed",
);
assert.deepEqual(
  pushSetsInlineEnv(`GIT_TERMINAL_PROMPT="$(curl evil)" git push origin feature`),
  ["GIT_TERMINAL_PROMPT"], "anything but 0 or 1 is denied",
);

// --- the splitter is escape-aware (Codex 2026-07-30, round 10) -----------------
// `\"` inside double quotes is an escaped quote, so the string ends at the FINAL
// quote. Tracking quotes without escapes reopened one there and swallowed every
// separator after it — the whole line became a single segment and a main-bound
// push at the end was never classified.
{
  const segments = shellSegments(`echo "a\\"b" && git push origin feature && git push origin HEAD:main`);
  assert.equal(segments.length, 3, "an escaped quote does not merge the whole line into one segment");
  assert.match(segments[2], /git push origin HEAD:main\s*$/, "the last segment is the main-bound push, on its own");
}
// A backslash is literal inside SINGLE quotes, so the quote closes at the next
// one and the separator after it is real.
assert.equal(
  shellSegments(`echo 'a\\' && git push origin main`).length, 2,
  "a backslash inside single quotes is literal, so the following separator still splits",
);
// A separator that is itself escaped is not a separator. (`\;` is a literal
// semicolon to bash, so this is one command, not two.)
assert.equal(
  shellSegments(`echo a\\; git push origin main`).length, 1,
  "an escaped separator does not split",
);
// Line continuations join, they do not split.
assert.equal(
  shellSegments("git push \\\norigin main").length, 1,
  "a line continuation keeps one command together",
);
// The escape handling must not have re-broken the round-9 case.
assert.deepEqual(
  pushSetsInlineEnv(`GIT_SSH_COMMAND="ssh -o ServerAliveInterval=20 && curl evil" git push origin feature`),
  ["GIT_SSH_COMMAND"], "quoted separators are still part of the value",
);

// --- options the argv walk does not understand (Codex 2026-07-30, round 7) -----
// `--recurse-submodules` takes a SEPARATE value. Verified against git 2.54 on
// 2026-07-30: with a remote literally named `no`, `git push --recurse-submodules
// no <urlA> HEAD:main` pushed to urlA — git ate `no` as the option's value while
// the guard read it as the destination and classified the push as unguarded.
assert.equal(
  pushDestinationToken(`git push --recurse-submodules no ${CRX_URL} HEAD:main`),
  CRX_URL,
  "--recurse-submodules consumes its value, so the URL is the destination",
);
assert.equal(
  pushDestinationToken(`git push --recurse-submodules=no ${CRX_URL} HEAD:main`),
  CRX_URL,
  "the attached form consumes nothing extra",
);
assert.equal(
  pushDestinationToken(`git push -uo ci.skip ${CRX_URL} HEAD:main`),
  CRX_URL,
  "a bundled short form hiding -o still consumes its value",
);
// And the backstop: the option list is no longer trusted to be complete, so
// anything unrecognised makes the walk — and therefore the destination — void.
assert.deepEqual(unknownPushOptions("git push --some-future-option x origin main"), ["--some-future-option"]);
assert.deepEqual(unknownPushOptions("git push --some-future-option=x origin main"), ["--some-future-option"]);
assert.deepEqual(unknownPushOptions("git push -Z origin main"), ["-Z"], "an unknown short option counts too");
assert.deepEqual(unknownPushOptions("git push --recurse-submodules no origin main"), [], "the newly-taught option is known");
assert.deepEqual(unknownPushOptions("git push --force-with-lease --follow-tags --atomic -u origin main"), [], "ordinary options are all known");
assert.deepEqual(unknownPushOptions("git push --no-verify origin main"), [], "a --no- negation resolves to its base option");
assert.deepEqual(unknownPushOptions("git push -fu origin main"), [], "a bundle of known short options is fine");
assert.deepEqual(unknownPushOptions("git push origin main -- --not-an-option"), [], "everything after -- is a refspec");
assert.deepEqual(unknownPushOptions("git status --weird"), [], "non-pushes are not scanned");

// --- the receive-pack program (Codex 2026-07-30, round 17)
// Not a parsing question: the argv walk skips these values correctly. The option
// names the program that RECEIVES the objects, and that program decides where
// they actually go — so the destination every other check classifies stops being
// the destination. Denied outright; nothing here ever needs it.
assert.equal(pushNamesRemoteProgram("git push --receive-pack=/tmp/relay origin main"), true);
assert.equal(pushNamesRemoteProgram("git push --receive-pack /tmp/relay origin main"), true, "separate-value spelling");
assert.equal(pushNamesRemoteProgram("git push --exec=/tmp/relay origin main"), true, "the --exec alias");
assert.equal(pushNamesRemoteProgram("git push --exec /tmp/relay origin main"), true);
assert.equal(
  pushNamesRemoteProgram(`git push origin feature && git push --exec=/tmp/relay ${CRX_URL} HEAD:main`),
  true,
  "a later push in the same command is scanned too",
);
assert.equal(pushNamesRemoteProgram("git push origin main"), false, "an ordinary push is untouched");
assert.equal(
  pushNamesRemoteProgram("git push origin main -- --receive-pack=/tmp/relay"),
  false,
  "after `--` it is a refspec, not an option",
);
assert.equal(pushNamesRemoteProgram("git commit -m 'exec --receive-pack'"), false, "non-pushes are not scanned");

// --- a harmless FIRST push must not hide a second one (Codex 2026-07-30, round 8)
// A whole-command scan that stopped at the first match saw neither the abbreviated
// option nor the inline variable on the second push. git accepts unambiguous
// abbreviations of long options, so `--recurse-submodule` is a real command.
assert.deepEqual(
  unknownPushOptions(`git push origin feature && git push --recurse-submodule no ${CRX_URL} HEAD:main`),
  ["--recurse-submodule"],
  "a later push's unknown option is found",
);
assert.deepEqual(
  unknownPushOptions(`git push origin feature; git push -Z origin main`),
  ["-Z"],
  "the scan crosses a `;` separator too",
);
assert.deepEqual(
  pushSetsInlineEnv(`git push origin feature && HOME=/tmp/evil git push origin main`),
  ["HOME"],
  "a later push's inline variable is found",
);
assert.deepEqual(
  pushSetsInlineEnv(`GIT_SSH_COMMAND="ssh" git push origin feature && git push origin main`),
  [],
  "a chained pair of clean pushes stays clean",
);

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

// ── full-hook end-to-end: the guard itself, driven over stdin ────────────────
// Codex round-4 (2026-07-30) asked for these specifically, and it was right to:
// the helper assertions above were all green while an earlier version of this
// same check sat in the wrong place in the hook and let the chained form
// through. Exercising the HOOK is the only thing that proves the gate closed.
{
  const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "codex-push-guard.mjs");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "codex-push-guard-env-"));
  const work = path.join(tmp, "work");
  const dest = path.join(tmp, "dest.git");
  const git = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8", env: scratchHookEnvironment(cwd, process.env) });

  const runHook = (command, extraEnv = {}) => {
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ cwd: work, tool_input: { command } }),
      encoding: "utf8",
      env: { ...scratchHookEnvironment(work, process.env), ...extraEnv },
    });
    assert.equal(res.status, 0, `guard exited ${res.status}: ${res.stderr}`);
    const out = (res.stdout || "").trim();
    if (!out) return { decision: "allow", reason: "" };
    const hook = JSON.parse(out).hookSpecificOutput;
    return { decision: hook.permissionDecision, reason: hook.permissionDecisionReason };
  };

  try {
    mkdirSync(work, { recursive: true });
    const init = git(["init", "-q", "--bare", dest], tmp);
    assert.equal(init.status, 0, `bare init failed: ${init.stderr}`);
    git(["init", "-q", "-b", "main"], work);
    git(["config", "user.email", "test@example.com"], work);
    git(["config", "user.name", "test"], work);
    writeFileSync(path.join(work, "seed.txt"), "seed\n");
    git(["add", "seed.txt"], work);
    const seeded = git(["commit", "-qm", "seed"], work);
    assert.equal(seeded.status, 0, `scratch commit failed: ${seeded.stderr}`);
    // `origin` deliberately points at a local bare repo, NOT the app repo, so the
    // control case below reaches the end of the guard and is genuinely allowed.
    git(["remote", "add", "origin", dest], work);

    const push = `git -C ${work} push origin main`;
    const deniedBecause = (command, pattern, message) => {
      const result = runHook(command);
      assert.equal(result.decision, "deny", `${message} — got ${result.decision}`);
      assert.match(result.reason, pattern, `${message} — denial should explain itself`);
    };
    const denied = (command, message) => deniedBecause(command, /GIT_CONFIG/, message);

    denied(`env 'GIT_CONFIG_COUNT=1' 'GIT_CONFIG_KEY_0=remote.origin.pushurl' 'GIT_CONFIG_VALUE_0=${CRX_URL}' ${push}`, "single-quoted env assignments");
    denied(`env "GIT_CONFIG_COUNT=1" "GIT_CONFIG_KEY_0=remote.origin.pushurl" ${push}`, "double-quoted env assignments");
    denied(`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.pushurl GIT_CONFIG_VALUE_0=${CRX_URL} ${push}`, "bare env assignments");
    denied(`export GIT_CONFIG_KEY_0=remote.origin.pushurl; ${push}`, "assignment in its own command segment");
    denied(`$env:GIT_CONFIG_COUNT = "1"; ${push}`, "PowerShell env form");
    // The round-5 form, end-to-end against a checkout whose configured `origin`
    // is an unrelated local repo: this is exactly the shape that would have
    // redirected the push to production while every lookup the guard makes
    // still described the harmless remote.
    denied(`GIT_CONFIG_PARAMETERS="'remote.origin.pushurl=${CRX_URL}'" ${push}`, "GIT_CONFIG_PARAMETERS redirect");
    denied(`env 'GIT_CONFIG_PARAMETERS=remote.origin.pushurl=${CRX_URL}' ${push}`, "quoted GIT_CONFIG_PARAMETERS redirect");
    // Round-6 forms: PowerShell has more than one way to set a variable, and the
    // detector used to describe the syntax rather than the namespace.
    denied(`Set-Item Env:GIT_CONFIG_COUNT 1; ${push}`, "PowerShell Set-Item");
    denied(`\${env:GIT_CONFIG_COUNT} = '1'; ${push}`, "PowerShell \${env:…}");
    denied(`New-Item -Path Env:GIT_CONFIG_KEY_0 -Value remote.origin.pushurl; ${push}`, "PowerShell New-Item");
    denied(`[Environment]::SetEnvironmentVariable('GIT_CONFIG_COUNT','1'); ${push}`, ".NET SetEnvironmentVariable");

    // The other half of round 6: the push command is innocent, but a variable
    // set by an EARLIER command is still live in the environment the push
    // inherits. The hook inherits it too, so it denies on what it can see.
    {
      const result = runHook(push, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "remote.origin.pushurl", GIT_CONFIG_VALUE_0: CRX_URL });
      assert.equal(result.decision, "deny", "an innocent push command inheriting GIT_CONFIG* is denied");
      assert.match(result.reason, /GIT_CONFIG_COUNT/, "the denial names the variable that is set");
    }
    assert.equal(
      runHook(push, { GIT_SSH_COMMAND: "ssh -o ServerAliveInterval=20" }).decision,
      "allow",
      "an inherited transport variable is not a destination override",
    );

    // Round 7: config ROOT overrides, arbitrary inline variables, and an option
    // the argv walk cannot account for.
    deniedBecause(`HOME=/tmp/evil ${push}`, /HOME/, "inline HOME override");
    deniedBecause(`XDG_CONFIG_HOME=/tmp/evil ${push}`, /XDG_CONFIG_HOME/, "inline XDG_CONFIG_HOME override");
    deniedBecause(`$env:HOME = "/tmp/evil"; ${push}`, /HOME/, "PowerShell HOME override");
    deniedBecause(`SOME_NEW_GIT_VAR=x ${push}`, /SOME_NEW_GIT_VAR/, "any inline assignment the allowlist does not name");
    deniedBecause(`git -C ${work} push --recurse-submodules no ${CRX_URL} HEAD:main`, /codex/i, "--recurse-submodules hiding the real destination");
    deniedBecause(`git -C ${work} push --some-future-option x origin main`, /--some-future-option/, "an option the guard cannot account for");
    // Round 9, end-to-end: an arbitrary GIT_SSH_COMMAND, and a production URL
    // spelled so a raw suffix match misses it.
    deniedBecause(
      `GIT_SSH_COMMAND="sh -c 'ssh prod git-receive-pack repo.git'" ${push}`,
      /GIT_SSH_COMMAND/, "an arbitrary command in GIT_SSH_COMMAND",
    );
    deniedBecause(
      `GIT_SSH_COMMAND="ssh -o ServerAliveInterval=20 && curl evil" ${push}`,
      /GIT_SSH_COMMAND/, "a separator inside the quoted value does not hide the assignment",
    );
    deniedBecause(
      `git -C ${work} push https://github.com/masonwells1/./CRX_Manager_V1.0.git HEAD:main`,
      /codex/i, "a `.` segment does not disguise the production destination",
    );
    assert.equal(
      runHook(`GIT_SSH_COMMAND="ssh -o ServerAliveInterval=20" ${push}`).decision,
      "allow",
      "the documented keepalive prefix still works",
    );

    // Round 10, end-to-end: `\"` is an escaped quote, not a delimiter. A tracker
    // blind to escapes reopened the quote at that point and swallowed every later
    // separator, so the whole line read as ONE segment and the main-bound push at
    // the end was never classified. Codex's probe returned exactly that.
    deniedBecause(
      `echo "a\\"b" && git -C ${work} push origin feature && git -C ${work} push ${CRX_URL} HEAD:main`,
      /codex/i,
      "an escaped quote cannot hide a later main-bound push",
    );
    // Found while building the case above: a command substitution is not separated
    // by `;`/`&&`/`|` at all, so no splitter of any kind sees the push hidden
    // inside it. The inner command runs first — straight to production — while the
    // guard classifies the harmless outer push. Denied outright now.
    deniedBecause(
      `git -C ${work} push origin feature \`git push ${CRX_URL} HEAD:main\``,
      /substitution/i,
      "a push carrying a backtick substitution is refused",
    );
    deniedBecause(
      `git -C ${work} push origin $(git push ${CRX_URL} HEAD:main)`,
      /substitution/i,
      "and the $(...) spelling too",
    );

    // Round 11, end-to-end: GitHub's port-443 SSH endpoint reaches the production
    // repo from a checkout with no CRX remote at all, and on hostname alone it read
    // as somewhere unrelated — so the risky-diff proof gate was skipped entirely.
    deniedBecause(
      `git -C ${work} push ssh://git@ssh.github.com:443/masonwells1/CRX_Manager_V1.0.git HEAD:main`,
      /codex/i,
      "the port-443 ssh endpoint does not disguise the production destination",
    );

    // Round 16, end-to-end: an ssh_config Host alias. `github-crx` is local text
    // that resolves to github.com on the pushing machine, so from a checkout with
    // no CRX remote at all this pushed straight to production while the guard
    // classified the destination as an unrelated host and skipped the proof gate.
    deniedBecause(
      `git -C ${work} push github-crx:masonwells1/CRX_Manager_V1.0.git HEAD:main`,
      /codex/i,
      "an ssh Host alias does not disguise the production destination",
    );
    deniedBecause(
      `git -C ${work} push ssh://git@github-crx/masonwells1/CRX_Manager_V1.0.git HEAD:main`,
      /codex/i,
      "nor does the ssh:// spelling of the same alias",
    );

    // Round 19, end-to-end: the hook itself must refuse a command that only
    // becomes a push after the shell rewrites it. Analysing text the shell will
    // not execute proves nothing about where the objects land.
    deniedBecause(
      `git p"us"h origin HEAD:main`,
      /quoting or command substitution/i,
      "quote-spliced `push` is refused by the hook, not analysed",
    );
    deniedBecause(
      `$(git push origin HEAD:main)`,
      /quoting or command substitution/i,
      "and so is a command substitution that runs a push",
    );
    deniedBecause(
      "`git push origin HEAD:main`",
      /quoting or command substitution/i,
      "and the backtick spelling of it",
    );

    // Round 18, end-to-end: git's remote-helper syntax hands delivery to an
    // arbitrary program, so `ext::…` names the production repo while every
    // destination classifier answered "unrelated" (Codex's own probe). The rule
    // is inverted rather than extended — a leftover colon in a destination that
    // did not canonicalize means the guard cannot resolve it, so it gates.
    deniedBecause(
      `git -C ${work} push "ext::ssh git@github.com %S masonwells1/CRX_Manager_V1.0.git" HEAD:main`,
      /codex/i,
      "a remote-helper destination naming the production repo is gated, not waved through",
    );
    deniedBecause(
      `git -C ${work} push "ext::ssh relay-host %S someone/anything.git" HEAD:main`,
      /codex/i,
      "and so is one naming anything else, because an opaque transport is unresolvable",
    );
    deniedBecause(
      `git -C ${work} push "transport::whatever" HEAD:main`,
      /codex/i,
      "any helper transport, not just the ext:: spelling",
    );

    // Round 17, end-to-end: `--receive-pack`/`--exec` name the program that
    // INGESTS the push on the far side, so the destination the guard classifies
    // is not necessarily where the objects end up. Codex's probe confirmed such
    // a command parsed cleanly, targeted `main`, and made every guarded-repo
    // classifier answer "unrelated" — the proof gate skipped entirely.
    deniedBecause(
      `git -C ${work} push --receive-pack=/tmp/relay origin HEAD:main`,
      /receive-pack/i,
      "a custom receive-pack program is denied before the destination is even classified",
    );
    deniedBecause(
      `git -C ${work} push --receive-pack /tmp/relay origin HEAD:main`,
      /receive-pack/i,
      "including the separate-value spelling",
    );
    deniedBecause(
      `git -C ${work} push --exec=/tmp/relay origin HEAD:main`,
      /receive-pack/i,
      "and its `--exec` alias",
    );
    // The option list still fails closed on an abbreviation, so `--receive-p`
    // does not slip past the exact-match check above.
    deniedBecause(
      `git -C ${work} push --receive-p /tmp/relay origin HEAD:main`,
      /--receive-p/,
      "an abbreviated spelling is refused as an unknown option",
    );

    // Round 12, end-to-end: a transport variable set in a segment of its OWN.
    // Every per-push-prefix detector reported clean while the push ran whatever
    // that variable names — Codex's own probe demonstrated it.
    deniedBecause(
      `export GIT_SSH_COMMAND="sh -c 'ssh prod git-receive-pack repo.git'"; ${push}`,
      /GIT_SSH_COMMAND/,
      "a transport variable exported in an earlier segment is not out of scope",
    );
    deniedBecause(
      `$env:GIT_SSH_COMMAND = "sh -c 'ssh prod git-receive-pack repo.git'"; ${push}`,
      /GIT_SSH_COMMAND/,
      "and its PowerShell spelling",
    );
    deniedBecause(`GIT_PROXY_COMMAND=/tmp/evil ${push}`, /GIT_PROXY_COMMAND/, "a proxy command is a command too");
    deniedBecause(`export GIT_ASKPASS=/tmp/evil; ${push}`, /GIT_ASKPASS/, "so is an askpass helper");
    // Inherited rather than written: unlike GIT_CONFIG*, sharing the environment
    // does NOT neutralise this — it changes what the push runs, not what the
    // guard reads.
    {
      const result = runHook(push, { GIT_SSH_COMMAND: "sh -c 'ssh prod git-receive-pack repo.git'" });
      assert.equal(result.decision, "deny", "an inherited transport variable denies");
      assert.match(result.reason || "", /GIT_SSH_COMMAND/, "and the denial names it");
    }
    assert.equal(
      runHook(push, { GIT_SSH_COMMAND: "ssh -o ServerAliveInterval=20" }).decision,
      "allow",
      "an inherited keepalive value in the documented shape still works",
    );
    assert.equal(
      runHook(`export GIT_SSH_COMMAND="ssh -o ServerAliveInterval=20"; ${push}`).decision,
      "allow",
      "and the same value written in an earlier segment",
    );

    // Round 22, end-to-end: a repository selector inherited from the shell. The
    // command is an ordinary push; the guard's own lookups strip these variables
    // so they read the real checkout, which is exactly why the two disagree.
    {
      const result = runHook(push, { GIT_DIR: path.join(work, ".git-elsewhere") });
      assert.equal(result.decision, "deny", "an inherited GIT_DIR is denied");
      assert.match(result.reason, /GIT_DIR/, "and the denial names it");
    }
    {
      const result = runHook(push, { GIT_WORK_TREE: work });
      assert.equal(result.decision, "deny", "so is an inherited GIT_WORK_TREE");
      assert.match(result.reason, /GIT_WORK_TREE/, "and the denial names that too");
    }
    assert.equal(runHook(push, { GIT_DIR: "" }).decision, "allow", "an empty selector is not a selection");

    // Round 21, end-to-end: the STORED twins of round 17's `--receive-pack`.
    // Nothing about the command line is unusual — the checkout itself remembers
    // a program to hand the objects to, so the destination the guard reads is
    // not where they land. The scratch `origin` is an unrelated local repo, and
    // it is still denied: an unreadable destination is the point, not the repo.
    for (const [key, value] of [
      ["remote.origin.receivepack", "/tmp/relay"],
      ["core.sshCommand", "ssh -i /tmp/relay"],
    ]) {
      try {
        git(["config", key, value], work);
        const result = runHook(push);
        assert.equal(result.decision, "deny", `a stored ${key} is denied`);
        assert.match(result.reason, /name a program to carry the push/, `and the denial names ${key}`);
        assert.match(result.reason, new RegExp(key.toLowerCase().replace(/\./g, "\\.")), "and quotes the setting itself");
      } finally {
        git(["config", "--unset", key], work);
      }
    }
    assert.equal(runHook(push).decision, "allow", "and unsetting them restores an ordinary push");

    // Controls: the guard must not have become a blanket denier. Both of these
    // run all the way through the destination lookups against the scratch repo.
    assert.equal(runHook(push).decision, "allow", "an ordinary push to an unrelated remote stays allowed");
    assert.equal(
      runHook(`GIT_SSH_COMMAND="ssh -o ServerAliveInterval=20" ${push}`).decision,
      "allow",
      "the documented SSH keepalive workaround is a transport option, not a destination override",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("OK - codex push shared library checks passed.");
