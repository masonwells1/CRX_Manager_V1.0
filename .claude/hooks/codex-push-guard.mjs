#!/usr/bin/env node
// PreToolUse(Bash) guard: block a push to main whose diff touches migrations /
// edge-functions / money-RLS code unless a fresh independent Codex verdict was
// recorded THIS session. This turns Mason's recurring "has codex reviewed all of
// these?" into a gate, not a hope. Non-risky pushes pass (auto-push stays intact).
//
// Proof: .claude/session-state/codex-review-<sha>.json with
//   { "codex_ran": true, "verdict": "clean", "head_sha": "<HEAD>", "timestamp": "<ISO>" }
// written by the /codex-review skill after the headless codex CLI returns.
//
// Non-pushes and ordinary non-production pushes pass. Ambiguous push context,
// force intent, and broad multi-ref modes fail closed.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  activeAutoMergePrNumbers,
  contentIsRisky,
  describeRiskyContent,
  eachPush,
  featurePushDestinations,
  gitPushCwd,
  gitSubcommandIsDynamic,
  isGitPush,
  pushUsesExecPathOption,
  mainPushSource,
  proofValid,
  pushContextIsAmbiguous,
  pushHiddenByShellComposition,
  pushIsForced,
  pushNamesRemoteProgram,
  pushUsesBulkMode,
  pushUsesInlineConfig,
  pushUsesConfigEnv,
  pushUsesConfigRootEnv,
  pushUsesTransportEnv,
  pushSetsInlineEnv,
  shellSegments,
  unknownPushOptions,
  unknownGitGlobalOptions,
  environmentCarriesConfigOverride,
  pushDestinationLookupArgs,
  pushNamesRefspec,
  REFSPEC_DEFAULT_LOOKUPS,
  pushDefaultConsultsBranchMerge,
  pushNamesDestination,
  REMOTE_SELECTION_LOOKUPS,
  divergentPushLookups,
  pushDestinationDecisions,
  pushDestinationDecision,
  environmentCarriesTransportOverride,
  environmentSelectsDifferentRepo,
  destinationLooksLikeUrl,
  pushDestinationToken,
  repoIsGuardedApp,
  rewritesReachGuardedApp,
  executableTransportSettings,
  configuredMirrorRemotes,
  urlIsGuardedApp,
  riskyFiles,
} from "./codex-push-lib.mjs";

function passthrough() { process.exit(0); }               // emit nothing → normal flow (git push is allow-listed)
function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
  process.exit(0);
}

let payload;
try { payload = JSON.parse(readFileSync(0, "utf8")); } catch { passthrough(); }

const cmd = String(payload?.tool_input?.command || "");
if (gitSubcommandIsDynamic(cmd)) {
  deny("CODEX GATE: Git's subcommand must be written literally. Shell variables, substitutions, splats, and globs are expanded after this review, so a command such as `$verb='push'; git $verb ...` can execute a push while bypassing every destination, force, and proof check. Write the Git operation plainly (for example `git -C <repo> push <remote> <refspec>`).");
}
// Before `isGitPush`, because the point of this check is that `isGitPush` is
// reading text the shell will not execute (Codex's nineteenth 2026-07-30
// review). A command that only becomes a push after quote-splicing or command
// substitution is refused outright — analysing a spelling the shell rewrites
// proves nothing about where the objects go.
if (pushHiddenByShellComposition(cmd)) {
  deny("CODEX GATE: shell quoting or command substitution changes this push's meaning or reveals an additional push (for example `git p\"us\"h`, `HEAD:ma\"in\"`, `$(git push …)`, or a backtick). The review gate reads command text, so analysing a spelling the shell rewrites would not prove the executed destination, force intent, or refspec. Write each push plainly: `git -C <repo> push <remote> <refspec>`.");
}
if (pushUsesExecPathOption(cmd)) {
  deny("CODEX GATE: git --exec-path is denied for pushes. It replaces Git's transport helpers, so a planted git-remote-https program can ignore the destination this guard verified. Use Git's normal executable path.");
}
const strangeGlobalOptions = unknownGitGlobalOptions(cmd);
if (strangeGlobalOptions.length > 0) {
  deny(`CODEX GATE: this command places unrecognised Git global options before push (${strangeGlobalOptions.join(", ")}). The literal push parser cannot safely determine which later token is the subcommand, so allowing it would skip every destination, force, and proof check. Use the supported plain form: \`git -C <repo> push <remote> <refspec>\`.`);
}
if (!isGitPush(cmd)) passthrough();
if (pushContextIsAmbiguous(cmd)) {
  deny("CODEX GATE: directory-changing or GIT_DIR/GIT_WORK_TREE-prefixed pushes cannot be bound safely to the inspected worktree. Use `git -C <repo> push`.");
}
// Checked against the WHOLE command, not the per-push segments below: an
// environment variable is set in its own segment (`export GIT_CONFIG_KEY_0=...;
// git push ...`), so a per-segment check never sees it. Found by probing the
// guard after writing the per-segment version, which passed its unit tests and
// still let the chained form through.
if (pushUsesConfigEnv(cmd)) {
  deny("CODEX GATE: pushes that name the GIT_CONFIG* environment namespace are denied. Those variables rewrite git configuration for that one command only (e.g. GIT_CONFIG_KEY_0=remote.origin.pushurl), so the push can land in a different repository than the one this guard inspected. Use `git -C <repo> push` with the repository's own configuration.");
}
// Claude's shell cwd can persist across tool calls. The hook payload's cwd is
// therefore the authoritative repository context for this specific push; the
// session-wide CLAUDE_PROJECT_DIR is only a fallback.
// Hoisted above the inherited-GIT_CONFIG* check below, which needs a repository
// to read its two answer sets from. Nothing here depends on the checks above.
const projectDir = path.resolve(
  payload?.cwd || payload?.tool_input?.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd(),
);
function gitIn(args, cwd, { keepConfigOverrides = false } = {}) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
  // Defence in depth for the GIT_CONFIG* bypass denied above: if this hook is
  // ever invoked with those variables already in its OWN environment, they would
  // rewrite the answers to the very lookups used to classify the destination.
  // Strip them so the guard always reads the repository's real configuration.
  //
  // `keepConfigOverrides` is the ONE exception, used only to read the second,
  // comparison-only answer set below. Nothing classifies a push from it — it
  // exists purely to prove the stripped answers and the push's answers agree.
  if (!keepConfigOverrides) {
    for (const key of Object.keys(env)) if (/^GIT_CONFIG(_|$)/i.test(key)) delete env[key];
  }
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}
const git = (args, cwd) => gitIn(args, cwd);

// The remote names this repository actually has, read under BOTH environments —
// an inherited GIT_CONFIG* can define a remote the scrubbed read cannot see, and
// recognising more remotes can only make more checks apply.
//
// This is the authoritative name list, and it exists as a shared helper because
// a remote name is NOT a whitespace-delimited token. `git remote add` rejects a
// name containing a space, but writing `remote.<name>.url` into the config
// directly creates one git then honours: `git remote` lists `my remote`,
// `git remote -v` prints it TAB-separated from the URL, and `git remote get-url
// --push 'my remote'` resolves it. Parsing such a line with `\S+` captures only
// `my`, so scoping by that truncated name filtered the REAL remote's `(push)`
// line out of BOTH comparison sets and the guard allowed a bare push whose
// inherited `remote.my remote.pushurl` pointed at production — a fail-OPEN, not
// an over-refusal (Codex, 2026-08-06, reproduced against the hook before fixing).
function configuredRemoteNames(repoDir) {
  const read = (keepConfigOverrides) => {
    try { return gitIn(["remote"], repoDir, { keepConfigOverrides }); }
    catch { return ""; }
  };
  return [...new Set(
    [read(false), read(true)]
      .join("\n")
      .split(/\r?\n/)
      .map((name) => name.replace(/\r/g, ""))
      .filter(Boolean),
  )];
}

// Split one `git remote -v` line into its remote name and the rest, using the
// KNOWN names rather than a delimiter guess. Longest first, so a name that is a
// prefix of another (`my` alongside `my remote`) cannot shadow the longer one.
// Returns null when no configured name matches, which every caller treats as
// fail-closed rather than as "no remote".
function remoteNameOnLine(line, knownRemotes) {
  const candidates = [...knownRemotes].sort((a, b) => b.length - a.length);
  return candidates.find((name) =>
    line.startsWith(name) && /^\s/.test(line.slice(name.length))) ?? null;
}

// The same question for a `git config --get-regexp` line, which prints
// `remote.<name>.<key> <value>`. Also answered from the known names, and for a
// second reason beyond whitespace: the name sits between two dots, so the old
// greedy `^remote\.(.*)\.(?:push|mirror)\b` backtracked to the LAST match in the
// whole line — including one inside the value. `remote.origin.push
// HEAD:refs/heads/evil.push` (a legal ref; dots are allowed) keyed as
// `origin.push HEAD:refs/heads/evil`, which no scope contains, so the redirecting
// line was dropped from both sets and compared equal. Same fail-open shape as the
// `remote -v` finding, one lookup over; found while fixing that one and confirmed
// against `git config --get-regexp` output.
//
// Returning null when no configured name matches keeps the line in the comparison
// rather than dropping it. That is safe to rely on because `git remote` lists a
// remote that has ANY `remote.<name>.*` key — verified here for a `push`-only and
// a `mirror`-only remote, and for one defined solely by inherited config — so a
// key whose remote is unknown is genuinely anomalous and belongs in the diff.
function remoteNameInConfigKey(line, knownRemotes) {
  if (!/^remote\./.test(line)) return null; // not a per-remote key at all
  const candidates = [...knownRemotes].sort((a, b) => b.length - a.length);
  return candidates.find((name) =>
    line.startsWith(`remote.${name}.`)
    && /^(?:push|mirror)(?:\s|$)/.test(line.slice(`remote.${name}.`.length))) ?? null;
}

// Which remote will a given push actually use? Git's own resolution order, in one
// place because two separate checks need it: the inherited-override proof below
// (to compare only the per-remote settings this push consults) and the per-remote
// transport/mirror classifiers further down (to deny only on the remote it
// targets). They disagreed for one revision, which is how the same over-refusal
// reached the second call site after being fixed at the first (Codex, 2026-08-06).
//
// Returns `{ remote: null }` when resolution fails — every caller then falls back
// to full breadth rather than trusting a name it could not compute. `rawUrl` means
// the destination is a literal URL, which consults no `remote.<name>.*` at all.
function resolvePushRemote(pushCmd, repoDir, branch) {
  try {
    const destinationToken = pushDestinationToken(pushCmd);
    // Ask git which remotes EXIST rather than inferring from the token's shape.
    // A configured remote name may legally contain `/` — `team/origin` is a name
    // git accepts and resolves — and the URL heuristic reads that as a raw URL.
    // That mattered because "raw URL" means "no `remote.<name>.*` applies", so
    // `remote.team/origin.mirror=true` skipped every per-remote check and the
    // guard ALLOWED a mirror push carrying main (Codex, 2026-08-06, reproduced
    // before fixing). An existing remote therefore wins over the shape test; the
    // heuristic only decides tokens that are not remotes at all.
    //
    // Read across both environments for the same reason as the config reads: an
    // inherited GIT_CONFIG* can define a remote the scrubbed read cannot see, and
    // recognising more remotes here can only make more checks apply.
    const configuredRemotes = configuredRemoteNames(repoDir);
    if (destinationToken && configuredRemotes.includes(destinationToken)) {
      return { remote: destinationToken, rawUrl: false };
    }
    if (destinationToken && destinationLooksLikeUrl(destinationToken)) {
      return { remote: null, rawUrl: true };
    }
    const config = (key) => { try { return git(["config", "--get", key], repoDir); } catch { return ""; } };
    return {
      remote: destinationToken
        || config(`branch.${branch}.pushRemote`)
        || config("remote.pushDefault")
        || config(`branch.${branch}.remote`)
        || "origin",
      rawUrl: false,
    };
  } catch (_error) {
    return { remote: null, rawUrl: false }; // fail CLOSED — every remote stays in scope
  }
}

// The command text is only half the story. A GIT_CONFIG* variable set by an
// EARLIER command is still live when this push runs, and the push command itself
// then looks completely ordinary. This hook inherits the same environment the
// push will inherit, so it checks directly rather than trying to parse history.
// Codex's sixth 2026-07-30 review asked for this.
//
// Until 2026-08-04 the mere PRESENCE of such a variable was denied. That was
// stricter than the danger: it also denied every environment that legitimately
// routes git through a credential proxy (Claude Code on the web installs a
// `url.…insteadOf` rewrite this way), which made pushing from a web or mobile
// session impossible. Presence is not the hazard — a CHANGED destination is. So
// read every answer this guard classifies a push from twice, once with the
// variables stripped and once exactly as the push will see them, and deny only
// when they disagree. Identical answers prove the variables cannot redirect the
// push; anything that could move the destination, the remote, the refspec, or
// the program carrying the objects still fails closed, and so does any lookup
// that errors on one side only.
const inheritedOverrides = environmentCarriesConfigOverride(process.env);
if (inheritedOverrides.length > 0) {
  // Every repository this command could push FROM — resolved per push, because
  // `git -C <other> push` must be proven in <other> and a chained command can
  // name several. Parsing here is pure text work with no new dependencies.
  //
  // The session's cwd is deliberately NOT added unconditionally (Codex, 2026-08-06,
  // reproduced before fixing). A push that names `-C <repo>` does not read the
  // cwd's configuration at all, so proving the cwd proves nothing about that push
  // — and when the cwd is not itself a checkout, the `rev-parse` below cannot read
  // it and denied an ordinary feature-branch push that was never going to touch
  // it. `-C` is a documented global form, so this is a real invocation, not a
  // contrived one. Nothing is given up: a push WITHOUT `-C` resolves to the cwd
  // through `gitPushCwd`, so the ordinary case still proves exactly the
  // repository the push will use.
  const overrideRepoDirs = [...new Set(
    shellSegments(cmd)
      .map((segment) => segment.trim())
      .filter((segment) => isGitPush(segment))
      .map((segment) => gitPushCwd(segment, projectDir)),
  )];
  // Fail closed if the command read as a push (line 86) but no individual segment
  // did: an empty set would skip this proof entirely, so fall back to the widest
  // thing known rather than proving nothing.
  if (overrideRepoDirs.length === 0) overrideRepoDirs.push(projectDir);
  // Destinations compare by a normalised DECISION; everything else by exact
  // text. A credential proxy's whole job is re-spelling `git@github.com:` as
  // `https://github.com/` for the same repository, so comparing destination text
  // denied every SSH-remote checkout in a web session. The decision is a pair —
  // the production-gate classification AND a spelling key — and only an
  // allow-list of GitHub spellings collapses; see `pushDestinationDecisions`
  // for why neither half alone is safe. The other lookups are config VALUES (a
  // remote name, a refspec), which a rewrite does not re-spell, so they stay
  // literal.
  // `remote.*.push` and `remote.*.mirror` are read repository-WIDE by regexp, but
  // git consults only the remote a given push resolves to. Comparing the whole
  // set denied `push origin HEAD:feature` merely because an inherited override
  // added `remote.archive.push` for a remote that push never touches — the fourth
  // over-refusal of this shape on this branch (Codex, 2026-08-06, reproduced
  // before fixing), and the same one already fixed for the mirror classifier
  // below, which this earlier comparison had not inherited.
  //
  // Scoping the ANSWER rather than the git command keeps the lookup itself
  // unchanged and handles a command that pushes to several remotes. `null` in the
  // scope set means a push whose remote could not be resolved, and that keeps the
  // full text — an unresolved remote must not narrow what is compared.
  const scopeRemoteAnswer = (text, scope, knownRemotes) => {
    if (scope === null) return text;
    return String(text).split(/\r?\n/).filter((line) => {
      const name = remoteNameInConfigKey(line.trim(), knownRemotes);
      // Either not a per-remote line, or one naming a remote git does not list.
      // Both keep the line — only a positively identified remote can be filtered.
      if (name === null) return true;
      return scope.has(name.toLowerCase());
    }).join("\n");
  };
  // `git remote -v` lists EVERY remote, but a push consults only the one it
  // resolves to — the same over-refusal `scopeRemoteAnswer` fixes above, missed
  // here because this lookup normalises through a different path and so did not
  // inherit it. An inherited `remote.archive.url` adds an `archive … (push)` line
  // and denied `push origin HEAD:feature`, whose destination git's own dry run
  // reports as origin's URL with and without the variable (Codex, 2026-08-06,
  // reproduced against the hook before fixing).
  //
  // An EMPTY scope is deliberately NOT narrowed, unlike above: it means no push
  // here resolved to a named remote, so there is no positive evidence to narrow
  // by, and narrowing to nothing would compare nothing. Only a scope naming at
  // least one remote filters. `null` keeps the full text for the same reason.
  const scopeRemotesAnswer = (text, scope, knownRemotes) => {
    if (scope === null || scope.size === 0) return text;
    return String(text).split(/\r?\n/).filter((line) => {
      const named = remoteNameOnLine(line.trim(), knownRemotes);
      if (named === null) return true; // unrecognised — never filtered away, stays fail-closed
      return scope.has(named.toLowerCase());
    }).join("\n");
  };
  const normalizeAnswer = (name, text, scope, knownRemotes) => {
    if (name === "remote.*.push" || name === "remote.*.mirror") {
      return scopeRemoteAnswer(text, scope, knownRemotes);
    }
    if (name === "remotes") return pushDestinationDecisions(scopeRemotesAnswer(text, scope, knownRemotes));
    // A literal URL destination resolves to one URL and gets the same pair. It
    // used to get the classification ALONE, which was the identical fail-open
    // one path over: `urlIsGuardedApp` is path-only, so it reads `guarded-app`
    // for `https://evil.example.com/masonwells1/CRX_Manager_V1.0` — the
    // production path on someone else's host — and a rewrite that moved a
    // literal-URL push off-host compared equal on both sides and was allowed.
    if (name.startsWith("url ")) {
      return pushDestinationDecision(String(text).trim());
    }
    return text;
  };
  const answerFor = (name, args, cwd, keepConfigOverrides, scope, knownRemotes = []) => {
    // `config --get` exits 1 when a key is unset, which is the ordinary case and
    // must read as "absent", not "failed" — but it has to be DISTINGUISHABLE from
    // a real failure, because an error on one side only is itself a divergence.
    try { return `ok:${normalizeAnswer(name, gitIn(args, cwd, { keepConfigOverrides }), scope, knownRemotes)}`; }
    catch (error) {
      // `--get-regexp` exits 1 for "no keys matched", which is absence, not
      // failure — and once the per-remote answers are scoped (above), a side that
      // matched only out-of-scope keys normalises to the empty string while the
      // other side exited 1. Recording that as an error made the two incomparable
      // and denied on a difference that isn't one. Map it into the same space as
      // an empty match; any other status stays a real, still-fail-closed error.
      if (error?.status === 1 && args.includes("--get-regexp")) {
        return `ok:${normalizeAnswer(name, "", scope, knownRemotes)}`;
      }
      return `err:${error?.status ?? error?.message ?? "failed"}`;
    }
  };
  for (const repoDir of overrideRepoDirs) {
    let overrideBranch = "";
    try {
      overrideBranch = gitIn(["rev-parse", "--abbrev-ref", "HEAD"], repoDir);
    } catch (error) {
      deny(`CODEX GATE: this shell has GIT_CONFIG* variables set (${inheritedOverrides.join(", ")}) and the guard could not read ${repoDir} to prove they do not redirect the push. ${error?.message || error}`);
    }
    // Every remote name git lists for this repository, computed once and handed to
    // the answer scopers below. They need the NAMES, not a delimiter guess, because
    // a remote name may contain whitespace (see `configuredRemoteNames`).
    const knownRemotes = configuredRemoteNames(repoDir);
    // The remotes the pushes running in THIS repository actually consult. A push
    // whose remote cannot be resolved collapses the whole set to `null` (compare
    // everything); a raw-URL destination contributes no remote, because git reads
    // no `remote.<name>.*` for it.
    let remoteScope = new Set();
    // …and whether EVERY push here names its refspecs. Git reads the default-refspec
    // configuration only for a push that does not, so for an all-explicit command an
    // inherited override of those keys cannot move anything — comparing them denied
    // `push origin HEAD:feature` over a `remote.origin.push` git never consults
    // (Codex, 2026-08-06, reproduced against git's own dry run before fixing).
    //
    // ALL, not any: one bare push in a chained command still consults them, and the
    // lookups are repository-wide, so a single bare push keeps them compared. An
    // empty segment list leaves this `false` and changes nothing.
    let everyPushNamesRefspec = null;
    // …and, separately, whether every push here names its DESTINATION. Git resolves
    // a bare push's remote through `branch.<b>.pushRemote` → `remote.pushDefault` →
    // `branch.<b>.remote`, and consults none of them once the command names one, so
    // comparing those keys denied `push origin HEAD:feature` over a `branch.remote`
    // git never reads (Codex, 2026-08-06, the mirror of the refspec finding above —
    // and missed on that round precisely because the reply then treated one
    // question as covering both. Explicit refspec and explicit destination are
    // different facts about a push, and each silences its own set of keys).
    // Reproduced against git's own dry run for all three keys before fixing.
    let everyPushNamesDestination = null;
    // …and the narrower scope for `remote.<name>.push` specifically: the remotes of
    // the BARE pushes only. One bare push keeps that key compared for the whole
    // command (above), but git still reads it only for the remote that bare push
    // selects — so in `push origin HEAD:feature && push archive` an inherited
    // `remote.origin.push` moves neither push and must not deny (Codex, 2026-08-06,
    // PR #313 review, the ninth over-refusal of this shape; reproduced against git's
    // own dry run before fixing). Kept
    // separate from `remoteScope`, which the explicit push still contributes to
    // for every other per-remote key.
    let refspecDefaultScope = new Set();
    // The same remotes in their ORIGINAL spelling. `refspecDefaultScope` is
    // lower-cased for comparison against config output, but a git config
    // subsection name is case-SENSITIVE — `remote.Origin.push` and
    // `remote.origin.push` are different keys — so a `config --get` built from the
    // lower-cased name would read the wrong one (silently absent) for a remote
    // named `Origin`. Kept alongside rather than replacing the scope set, whose
    // case-insensitive matching is deliberate.
    let bareRemoteNames = new Set();
    for (const segment of shellSegments(cmd).map((s) => s.trim()).filter((s) => isGitPush(s))) {
      if (gitPushCwd(segment, projectDir) !== repoDir) continue;
      const namesRefspec = pushNamesRefspec(segment);
      everyPushNamesRefspec = (everyPushNamesRefspec ?? true) && namesRefspec;
      everyPushNamesDestination = (everyPushNamesDestination ?? true) && pushNamesDestination(segment);
      const resolved = resolvePushRemote(segment, repoDir, overrideBranch);
      // Leaving the loop early means the remaining segments were never examined, so
      // both verdicts are only partial — a later BARE push would go unseen.
      // Fail them closed rather than skipping a lookup on unread evidence.
      if (resolved.remote === null && !resolved.rawUrl) {
        remoteScope = null;
        refspecDefaultScope = null;
        bareRemoteNames = null;
        everyPushNamesRefspec = false;
        everyPushNamesDestination = false;
        break;
      }
      if (resolved.remote !== null) {
        remoteScope.add(resolved.remote.toLowerCase());
        if (!namesRefspec) {
          refspecDefaultScope.add(resolved.remote.toLowerCase());
          bareRemoteNames.add(resolved.remote);
        }
      }
    }
    // …and, one level down from the refspec verdict, whether a BARE push here
    // reads `branch.<b>.merge` at all. `pushNamesRefspec` correctly reports that
    // such a push has no refspec of its own, but only some `push.default` modes
    // then derive one from that key — under `current` git names the destination
    // from the branch and never reads it, so comparing it denied the ordinary
    // feature-branch push over an inherited value git would not consult (Codex,
    // 2026-08-06, PR #313 review; reproduced on git 2.43.0 both ways before
    // fixing — `current` reports `feature:feature` with the key set and unset,
    // `upstream` reports `feature:main` only with it).
    //
    // Read under BOTH environments and skipped only when the two AGREE the mode
    // ignores the key: an inherited override that flips `current` to `upstream`
    // must keep `branch.merge` compared. It also diverges on `push.default`
    // itself, which is compared whenever a bare push is present — so that vector
    // denies twice over. An unreadable mode compares, fail-closed.
    const branchMergeIsConsulted = (() => {
      const readMode = (keepConfigOverrides) => {
        try { return gitIn(["config", "--get", "push.default"], repoDir, { keepConfigOverrides }); }
        catch (error) { return error?.status === 1 ? "" : null; } // 1 = unset, not a failure
      };
      const scrubbedMode = readMode(false);
      const ambientMode = readMode(true);
      if (scrubbedMode === null || ambientMode === null) return true;
      return pushDefaultConsultsBranchMerge(scrubbedMode)
        || pushDefaultConsultsBranchMerge(ambientMode);
    })();
    // …and one level below THAT: whether the bare pushes get their refspec from
    // `remote.<name>.push` in the first place. That key outranks the whole
    // `push.default` mechanism, so when it is set neither `push.default` nor
    // `branch.<b>.merge` is consulted at all and comparing them is pure
    // over-refusal (Codex, 2026-08-06, PR #313 review, the tenth of this shape).
    //
    // Reproduced on git 2.43.0 before fixing, and the precedence is total, not
    // partial: with `remote.origin.push=HEAD:refs/heads/fixed`, a bare
    // `push origin` dry-runs to `HEAD:refs/heads/fixed` under EVERY mode —
    // `current`, `upstream`, `matching`, `nothing`, and unset alike — and with
    // `branch.<b>.merge` set or unset. Codex reported it for `push.default`; the
    // probe showed `branch.merge` rides along, so both are skipped together.
    //
    // Fail-closed exactly like the mode check above: read under BOTH environments
    // and skip only when the two AGREE the key is set for every bare push's
    // remote. An inherited variable that ADDS `remote.<name>.push` leaves the
    // scrubbed side empty, so nothing is skipped — and it diverges on
    // `remote.*.push`, which is still compared here, so it denies anyway. An
    // inherited CHANGE to the value denies on that same key. Unreadable compares.
    const refspecComesFromRemotePush = (() => {
      // No bare push here (or an unresolved one) — nothing to reason about, and
      // the all-explicit case is already handled by `everyPushNamesRefspec`.
      if (refspecDefaultScope === null || bareRemoteNames === null) return false;
      if (bareRemoteNames.size === 0) return false;
      const readRemotePush = (remote, keepConfigOverrides) => {
        try { return gitIn(["config", "--get", `remote.${remote}.push`], repoDir, { keepConfigOverrides }); }
        catch (error) { return error?.status === 1 ? "" : null; } // 1 = unset, not a failure
      };
      // EVERY bare push, not any: one whose remote lacks the key still reads the
      // default-refspec configuration, and the lookups are repository-wide.
      return [...bareRemoteNames].every((remote) => {
        const scrubbedPush = readRemotePush(remote, false);
        const ambientPush = readRemotePush(remote, true);
        if (scrubbedPush === null || ambientPush === null) return false;
        return scrubbedPush !== "" && ambientPush !== "";
      });
    })();
    const scrubbed = {};
    const ambient = {};
    for (const [name, args] of pushDestinationLookupArgs(overrideBranch)) {
      if (everyPushNamesRefspec === true && REFSPEC_DEFAULT_LOOKUPS.has(name)) continue;
      // `remote.*.push` is deliberately NOT skipped here — it is the key actually
      // supplying the refspec, so a change to it is the redirect, not a non-event.
      if (refspecComesFromRemotePush && (name === "push.default" || name === "branch.merge")) continue;
      if (name === "branch.merge" && !branchMergeIsConsulted) continue;
      if (everyPushNamesDestination === true && REMOTE_SELECTION_LOOKUPS.has(name)) continue;
      // `remote.*.push` is read only for a bare push's own remote; every other
      // per-remote answer is read for whichever remote its push selects.
      const scope = name === "remote.*.push" ? refspecDefaultScope : remoteScope;
      scrubbed[name] = answerFor(name, args, repoDir, false, scope, knownRemotes);
      ambient[name] = answerFor(name, args, repoDir, true, scope, knownRemotes);
    }
    // NOT compared here: the URL-rewrite table and the settings naming a program
    // to carry the objects. Those two feed classifiers whose only power is to
    // make the gate APPLY — a rewrite reaching the app repo gates the push, a
    // named transport program denies it outright. Demanding equality on them
    // would deny every credential proxy (whose rewrite base is a bare host, which
    // those classifiers correctly fail closed on) while protecting nothing.
    // They are handled the safe way instead, at their own use sites below: read
    // under BOTH environments and unioned, so a rewrite or carrier that exists
    // only in the inherited configuration still gates. Strictly safer than the
    // single scrubbed read this guard used before.
    //
    // A push naming a URL outright is rewritten at transport time, where
    // `remote -v` cannot see it — so resolve each literal URL under both.
    for (const segment of shellSegments(cmd).map((s) => s.trim()).filter((s) => isGitPush(s))) {
      const token = pushDestinationToken(segment);
      if (!token || !destinationLooksLikeUrl(token)) continue;
      scrubbed[`url ${token}`] = answerFor(`url ${token}`, ["ls-remote", "--get-url", token], repoDir, false);
      ambient[`url ${token}`] = answerFor(`url ${token}`, ["ls-remote", "--get-url", token], repoDir, true);
    }
    const divergent = divergentPushLookups(scrubbed, ambient);
    if (divergent.length > 0) {
      deny(`CODEX GATE: this shell has GIT_CONFIG* variables set (${inheritedOverrides.join(", ")}) that CHANGE where this push would go — ${divergent.join(", ")} differ with and without them, in ${repoDir}. The guard's own destination lookups strip those variables, so the push and this gate would disagree. Unset them before pushing.`);
    }
  }
}
// Those name a config file; these name the REPOSITORY. An inherited GIT_DIR or
// GIT_WORK_TREE sends the push to one repository while every lookup below reads
// another — the `git()` helper strips exactly these variables so it sees the real
// checkout, which is precisely what makes the two disagree (Codex's twenty-second
// 2026-07-30 review). Stripping them for our own reads is right; continuing as if
// the push would do the same is not.
const inheritedSelectors = environmentSelectsDifferentRepo(process.env);
if (inheritedSelectors.length > 0) {
  deny(`CODEX GATE: this shell already selects a different repository (${inheritedSelectors.join(", ")}), so the push would act on that repository while this guard inspects the working directory's own checkout. Unset them and use \`git -C <repo> push\`.`);
}
// `GIT_CONFIG*` names a config file; these name the directory git searches for
// the global one, which redirects a push just as effectively. Codex's seventh
// 2026-07-30 review found it, and a scratch-repo probe the same day confirmed a
// HOME override sent the objects somewhere the guard's own lookups never saw.
if (pushUsesConfigRootEnv(cmd)) {
  deny("CODEX GATE: pushes that name HOME, XDG_CONFIG_HOME, or the GIT_DIR/GIT_WORK_TREE/GIT_OBJECT_* namespace are denied. Those select which git configuration the push reads, so a planted global config (e.g. url.<repo>.pushInsteadOf) can send an innocent-looking push to a different repository than the one this guard inspected. Use `git -C <repo> push`.");
}
// The general form of the same problem, and the reason the two rules above are
// backstops rather than the whole answer: this guard resolves the destination in
// ITS environment while the push runs in a different one. Naming variables one
// at a time has now failed four review rounds running, so an inline assignment
// of ANYTHING but the sanctioned transport variables is denied outright.
const inlineEnv = pushSetsInlineEnv(cmd);
if (inlineEnv.length > 0) {
  deny(`CODEX GATE: this push sets environment variables inline (${inlineEnv.join(", ")}). The guard resolves the destination in its own environment, so any variable the push carries and the guard does not makes the two disagree. The only prefixes accepted are GIT_TERMINAL_PROMPT=0/1 and GIT_SSH_COMMAND in its exact documented keepalive shape (\`ssh\` with ServerAliveInterval/ServerAliveCountMax/BatchMode options and nothing else) — GIT_SSH_COMMAND is a command line git executes, so any other value can run git-receive-pack against production while this guard reads only the nominal destination.`);
}
// The rule above only inspects each push's OWN prefix, which is the right scope
// for a variable that must be attached to the command to matter. A transport
// variable is not that: `export GIT_SSH_COMMAND="…"; git push origin HEAD:main`
// sets it in a segment of its own, and the push then looks entirely ordinary.
// Checked across the whole command, and by value, so the sanctioned keepalive
// shape still works wherever it is written.
const transportEnv = pushUsesTransportEnv(cmd);
if (transportEnv.length > 0) {
  deny(`CODEX GATE: this command sets or names transport variables (${transportEnv.join(", ")}) somewhere other than the sanctioned keepalive form. GIT_SSH_COMMAND and its relatives are command lines git EXECUTES — they do not change what this guard resolves, so one set in an earlier segment can run git-receive-pack against production while the push itself looks ordinary. Unset it, or use the documented \`GIT_SSH_COMMAND="ssh -o ServerAliveInterval=…"\` shape.`);
}
// And the same variables arriving from the surrounding shell. Unlike GIT_CONFIG*,
// an inherited one is NOT neutralised by this guard sharing the environment: it
// changes what the push runs, not what the guard reads.
let trustedGitExecPath = null;
try {
  const cleanExecEnv = { ...process.env };
  delete cleanExecEnv.GIT_EXEC_PATH;
  trustedGitExecPath = execFileSync("git", ["--exec-path"], {
    encoding: "utf8",
    env: cleanExecEnv,
    windowsHide: true,
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch { /* fail closed below when GIT_EXEC_PATH is present */ }
const inheritedTransport = environmentCarriesTransportOverride(process.env, trustedGitExecPath);
if (inheritedTransport.length > 0) {
  deny(`CODEX GATE: this shell already has transport variables set (${inheritedTransport.join(", ")}) whose values are outside the sanctioned keepalive shape. They select a command git executes, so the push could reach production regardless of the destination this guard inspected. Unset them before pushing.`);
}
// The destination is read by walking argv, and that walk has to know which
// options swallow the following token. `--recurse-submodules no <url>` slipped
// through exactly that gap. Rather than trust the option list to be complete
// this time, refuse to walk argv at all when it contains something unrecognised.
const strangeOptions = unknownPushOptions(cmd);
if (strangeOptions.length > 0) {
  deny(`CODEX GATE: this push uses options this guard does not recognise (${strangeOptions.join(", ")}), so it cannot tell which argument is the destination — and a misread destination is how a production push skips this gate. Use a plain \`git -C <repo> push <remote> <refspec>\`, or add the option to PUSH_OPTS_KNOWN in codex-push-lib.mjs after checking whether it takes a value.`);
}

// Inspect every push in a chained/multiline command. A harmless first push must
// not hide a later main-bound push. Single `|` splits too (Codex round-4):
// both sides of a pipeline execute.
// Quote-aware, so a separator inside a quoted value cannot manufacture a phantom
// segment boundary (Codex round 9).
const pushCommands = shellSegments(cmd)
  .map((segment) => segment.trim())
  .filter((segment) => isGitPush(segment));

if (pushCommands.length > 0 && (pushCommands.length !== 1 || shellSegments(cmd).filter((segment) => segment.trim()).length !== 1)) {
  deny("CODEX GATE: a feature push must be one standalone command. Chaining a push with another shell action could arm auto-merge after the pre-push GitHub check, so run `git -C <repo> push <remote> <single-refspec>` by itself.");
}

// Backstop for the splitter itself. Every check below classifies ONE push, so a
// segment holding two of them means the split failed and a push would be judged
// by the other push's arguments — which is exactly how an escaped quote hid a
// main-bound push from Codex's tenth 2026-07-30 review. A single shell command
// cannot legitimately invoke `git push` twice, so this can only mean the guard
// misread the line: refuse instead of guessing. Any future parser gap lands here.
for (const pushCmd of pushCommands) {
  if (eachPush(pushCmd).length > 1) {
    deny("CODEX GATE: this command chains more than one push in a way the guard cannot split reliably (quoting/escaping makes the boundaries ambiguous), so it is denied rather than judged on a guess. Run each push as its own separate command.");
  }
  // Command substitution runs a whole command of its own, INSIDE this one, before
  // this one runs — and it is not separated by `;`/`&&`/`|`, so nothing above sees
  // it: `git push origin feature \`git push <prod-url> HEAD:main\`` reaches
  // production while the guard classifies only the harmless outer push. Found while
  // building the round-10 regression tests. A legitimate push never needs it.
  if (/\$\(|`/.test(pushCmd)) {
    deny("CODEX GATE: this push contains a command substitution (`$(...)` or backticks). The substitution executes as a command in its own right before the push does, and the guard cannot classify what it will run — so a second, hidden push could reach production while only the outer one is inspected. Write the value out literally, or run the inner command as its own separate step.");
  }
}

for (const pushCmd of pushCommands) {
  if (/--git-dir|--work-tree/i.test(pushCmd)) {
    deny("CODEX GATE: pushes using explicit --git-dir/--work-tree contexts are denied because the guard cannot safely bind them to the inspected worktree. Use `git -C <repo> push` instead.");
  }
  // Before any question about WHERE this push is addressed, because this option
  // makes that question unanswerable: `--receive-pack`/`--exec` name the program
  // that ingests the objects on the far side, and that program is free to send
  // them somewhere other than the destination named here.
  if (pushNamesRemoteProgram(pushCmd)) {
    deny("CODEX GATE: pushes naming a custom receive-pack program (`--receive-pack` / `--exec`) are denied. That option chooses the program that RECEIVES the push on the far side, so it can relay the objects past the destination this guard inspected — the review gate would classify a harmless repository while the code lands somewhere else. GitHub runs its own receive-pack; drop the option and push normally.");
  }
  if (pushUsesBulkMode(pushCmd)) {
    deny("CODEX GATE: bulk push modes (`--all`/`--branches`/`--mirror`/`--prune`) can alter multiple remote refs and are always blocked. Push one explicit branch/refspec instead.");
  }
  if (pushUsesInlineConfig(pushCmd)) {
    deny("CODEX GATE: pushes carrying inline git configuration (`git -c ...` / `--config-env`) are denied because those overrides silently change the push destination (e.g. `-c remote.origin.pushurl=...`) and the guard's own lookups cannot see them. Use `git -C <repo> push` instead.");
  }
  if (pushIsForced(pushCmd)) {
    deny("CODEX GATE: force-pushing any branch rewrites shared history and requires Mason's explicit approval. Use a normal push or a compensating commit.");
  }

  const pushRepoDir = gitPushCwd(pushCmd, projectDir);
  let branch = "";
  try {
    branch = git(["rev-parse", "--abbrev-ref", "HEAD"], pushRepoDir);
  } catch (error) {
    deny(`CODEX GATE: could not determine the repository/branch selected by this push, so it is denied. ${error?.message || error}`);
  }

  // Both checks below are deliberately ABOVE the `if (!srcRef) continue` that
  // follows, and moving them here is a bug fix, not a tidy-up (2026-08-05).
  // They used to sit ~90 lines further down, after that `continue`, which meant
  // they only ever ran for a push ALREADY classified as main-bound. For the
  // mirror check that is precisely backwards: the hazard it names in its own
  // deny text is that `git push` with no refspec updates every ref INCLUDING
  // main, so `mainPushSource` returns nothing and the loop `continue`d straight
  // past the check that existed to catch it. Probed against a real repo carrying
  // `remote.origin.mirror`: `push origin feature`, `push origin`, and a bare
  // `push` were all ALLOWED, and only the explicit `push origin HEAD:main` — the
  // one form a mirror remote makes unnecessary — was denied. The `--mirror`
  // command-line flag is denied unconditionally above; this is the same
  // instruction stored in config, and it now denies at the same breadth.
  //
  // The same reasoning applies to the transport-program check: `remote.<name>.
  // receivepack` and `core.sshCommand` name the program that carries the
  // objects, so it decides where they land regardless of what this command's
  // refspec says (Codex's twenty-first 2026-07-30 review asked for it at full
  // breadth for exactly that reason).
  //
  // Read TWICE and unioned, as with the rewrite table above: an inherited
  // GIT_CONFIG* variable can install a carrier program or a mirror flag that the
  // stripped read cannot see, and these classifiers only ever ADD denials, so
  // taking both can gate more, never less.
  let transportConfig = "";
  const readTransportConfig = (keepConfigOverrides) => {
    try { return gitIn(["config", "--list"], pushRepoDir, { keepConfigOverrides }); }
    catch (_error) { return ""; } // an unreadable config is handled by the checks below
  };
  transportConfig = [readTransportConfig(false), readTransportConfig(true)].filter(Boolean).join("\n");

  // Which remote will THIS push actually use? Both checks below read config keyed
  // by remote name, and running them at full breadth (above) without this made
  // them refuse on a remote the push never touches: with an unrelated mirrored
  // backup remote configured, `push origin HEAD:feature` was denied because
  // `archive` was mirrored (Codex's 2026-08-05 re-review of the hoist, reproduced
  // before fixing). `mirror`, `receivepack`, `uploadpack`, and `vcs` are all
  // per-remote settings — git applies them only to the remote it resolves — so
  // scoping to that remote removes the over-refusal without giving anything up.
  //
  // Resolution order is git's own, and matches the destination lookup further
  // down. `null` means "could not resolve", and every check below then falls back
  // to full breadth rather than trusting a name it failed to compute.
  // Shared with the inherited-override proof above — see `resolvePushRemote`.
  // Keeping one implementation is the point: these two call sites drifted once,
  // and the over-refusal fixed here survived at the other one for a full revision.
  const { remote: targetRemote, rawUrl: targetIsRawUrl } = resolvePushRemote(pushCmd, pushRepoDir, branch);
  // Compared case-INsensitively even though a subsection name is case-sensitive
  // to git. The mismatch can only make this deny more (a remote differing from
  // the configured one by case alone is treated as in scope), which is the safe
  // direction; Codex's case is two different names and is unaffected.
  const remoteInScope = (name) => {
    if (targetIsRawUrl) return false;
    if (targetRemote === null) return true;
    return String(name).toLowerCase() === targetRemote.toLowerCase();
  };

  const namedPrograms = executableTransportSettings(transportConfig).filter((key) => {
    // `core.sshCommand`, `core.gitProxy`, `protocol.*.command`, and `ssh.variant`
    // are global: they carry the objects whichever remote is picked, so they are
    // never scoped away. Only the `remote.<name>.*` forms are.
    const perRemote = key.match(/^remote\.(.+)\.(?:receivepack|uploadpack|vcs)$/);
    return perRemote ? remoteInScope(perRemote[1]) : true;
  });
  if (namedPrograms.length > 0) {
    deny(`CODEX GATE: this checkout configures git settings that name a program to carry the push (${namedPrograms.join(", ")}). That program decides where the objects actually go, so no destination check here can be trusted. Unset them with \`git config --unset <setting>\` and push normally — git's own defaults need none of them.`);
  }
  const mirrorRemotes = configuredMirrorRemotes(transportConfig).filter(remoteInScope);
  if (mirrorRemotes.length > 0) {
    deny(`CODEX GATE: this push's remote is configured as a mirror (${mirrorRemotes.map((r) => `remote.${r}.mirror`).join(", ")}), which is \`--mirror\` stored in config. A bare push to a mirror remote updates EVERY ref — main included — without naming one, so the production review gate never sees a main-bound push, and git rejects any explicit refspec that would narrow it. Unset it with \`git config --unset remote.<name>.mirror\` and push one explicit branch.`);
  }

  const srcRef = mainPushSource(pushCmd, branch);
  if (!srcRef) {
    // Auto-merge can be armed before a later commit is pushed. GitHub then
    // merges that new commit after CI without any immediate merge command, so
    // the exact-head merge proof never gets a chance to run. Check the remote
    // PR state BEFORE every ordinary feature push and fail closed on an API
    // error. The agent can disable auto-merge and retry without involving Mason.
    let featureBranches;
    try {
      featureBranches = featurePushDestinations(pushCmd);
    } catch (error) {
      deny(`CODEX GATE: could not determine the exact remote feature branch for the auto-merge check, so the push is denied (fail closed). ${error?.message || error}`);
    }
    for (const featureBranch of featureBranches) {
      let activeAutoMergePrs;
      try {
        const response = execFileSync("gh", [
          "pr", "list",
          "--repo", "masonwells1/CRX_Manager_V1.0",
          "--state", "open",
          "--base", "main",
          "--head", featureBranch,
          "--json", "number,autoMergeRequest",
        ], {
          cwd: pushRepoDir,
          encoding: "utf8",
          timeout: 10000,
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
        activeAutoMergePrs = activeAutoMergePrNumbers(response);
      } catch (error) {
        deny(`CODEX GATE: could not prove auto-merge is disabled for the open main-bound PR on branch ${featureBranch}, so the feature push is denied (fail closed). ${error?.message || error}`);
      }
      if (activeAutoMergePrs.length > 0) {
        deny(
          `CODEX GATE: auto-merge is already armed on PR ${activeAutoMergePrs.map((number) => `#${number}`).join(", ")} for branch ${featureBranch}. ` +
          `A later push could then merge without an exact-head review. Run \`gh pr merge ${activeAutoMergePrs[0]} --disable-auto\`, verify auto-merge is off, and retry this push.`,
        );
      }
    }
  }

  if (!srcRef) continue;
  if (srcRef === "DELETE") {
    deny("CODEX GATE: `git push origin :main` DELETES the production main branch. Never do this. If a bad commit landed, use the /rollback runbook (compensating commit / Vercel promote-previous) instead.");
  }

  // Everything above here (force-push, bulk modes, deleting main) is destructive
  // in ANY repository and stays global. What follows is the risky-file / Codex
  // proof gate, and that one is specific to the CRX Manager production app: it
  // reasons about supabase migrations, RLS policies, and money code that only
  // exist here. On 2026-07-29 it blocked a snapshot push to the private
  // masonwells1/CRX_Backups repo because a MARKDOWN NOTE was named
  // `project_policy-grantee-disk-vs-live-drift.md` and the path pattern
  // `/policy|grant/i` is unanchored. Scope the gate to the app repo rather than
  // loosening the patterns, so its strength here is unchanged.
  //
  // "Is this the app repo?" is answered TWICE and the gate fires if EITHER says
  // yes. Codex's 2026-07-30 pre-push review found that asking only about the
  // checkout's configured remotes is a bypass: `git push
  // git@github.com:masonwells1/CRX_Manager_V1.0.git HEAD:main` writes straight
  // to production from a checkout whose configured remote is something else.
  // So: (1) resolve the push's ACTUAL destination URL, and (2) keep the
  // configured-remotes check as a second line of defence. Both fail CLOSED.
  let destinationUrls = [];
  try {
    const destinationToken = pushDestinationToken(pushCmd);
    if (destinationToken && destinationLooksLikeUrl(destinationToken)) {
      destinationUrls = [destinationToken];
    } else {
      // No destination named → git resolves its own default, in this order.
      const config = (key) => { try { return git(["config", "--get", key], pushRepoDir); } catch { return ""; } };
      const remoteName = destinationToken
        || config(`branch.${branch}.pushRemote`)
        || config("remote.pushDefault")
        || config(`branch.${branch}.remote`)
        || "origin";
      destinationUrls = git(["remote", "get-url", "--push", "--all", remoteName], pushRepoDir)
        .split(/\r?\n/)
        .map((url) => url.trim())
        .filter(Boolean);
    }
  } catch (_error) {
    // Fail CLOSED: urlIsGuardedApp("") is true, so an unresolvable destination
    // gates the push instead of waving it through.
    destinationUrls = [""];
  }
  let remoteList = "";
  try {
    remoteList = git(["remote", "-v"], pushRepoDir);
  } catch (_error) {
    // Fail CLOSED: repoIsGuardedApp("") is true, so a broken remote lookup
    // gates the push instead of waving it through.
    remoteList = "";
  }
  // Third answer to the same question: a configured URL rewrite
  // (`url.<CRX Manager URL>.pushInsteadOf = crx:`) lets `git push crx: main`
  // reach production behind an alias that classifies as unguarded on its own.
  // If this checkout has any rewrite whose base is the app repo, the gate
  // applies. An unreadable config gates too.
  // Read TWICE and unioned (2026-08-04): once with GIT_CONFIG* stripped, once as
  // the push will see them. An inherited variable can install a rewrite the
  // stripped read cannot see, and this classifier only ever makes the gate APPLY
  // — so taking both can gate more, never less. Concatenating the two outputs is
  // the union: `rewritesReachGuardedApp` is a some() over lines.
  let urlRewrites = "";
  const readRewrites = (keepConfigOverrides) => {
    try {
      return gitIn(["config", "--get-regexp", "^url\\..*insteadof$"], pushRepoDir, { keepConfigOverrides });
    } catch (_error) {
      // `--get-regexp` exits 1 when nothing matches, which is the common case and
      // means "no rewrites configured" — NOT a failure. An empty string is
      // correctly read as "no rewrite reaches the app repo".
      return "";
    }
  };
  urlRewrites = [readRewrites(false), readRewrites(true)].filter(Boolean).join("\n");
  // The transport-program and mirror-remote checks that used to sit here now run
  // above, before the `if (!srcRef) continue` — see the note at that call site.
  if (
    !destinationUrls.some((url) => urlIsGuardedApp(url)) &&
    !repoIsGuardedApp(remoteList) &&
    !rewritesReachGuardedApp(urlRewrites)
  ) continue;

  let baseSha = "";
  try {
    // Capture the exact origin/main the diff is gated against, so the proof can
    // be bound to the SAME base it was reviewed on (a moved base forces a fresh
    // review). `--verify` prints the resolved sha on success.
    baseSha = git(["rev-parse", "--verify", "--quiet", "origin/main"], pushRepoDir);
  } catch (error) {
    deny(`CODEX GATE: could not resolve origin/main for the selected push repository, so the push is denied. ${error?.message || error}`);
  }

  let srcSha = "";
  try {
    srcSha = git(["rev-parse", "--verify", srcRef === "HEAD" ? "HEAD" : srcRef], pushRepoDir);
  } catch (error) {
    deny(`CODEX GATE: could not resolve the exact ref being pushed to main, so the push is denied. ${error?.message || error}`);
  }

  let files = [];
  try {
    files = git(["diff", "--name-only", `origin/main...${srcSha}`], pushRepoDir)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (error) {
    deny(`CODEX GATE: could not inspect the main-bound diff, so the push is denied. ${error?.message || error}`);
  }

  const risky = riskyFiles(files);
  let contentFlagged = false;
  let contentDiffText = "";
  if (risky.length === 0) {
    try {
      contentDiffText = git(["diff", `origin/main...${srcSha}`], pushRepoDir);
      contentFlagged = contentIsRisky(contentDiffText);
    } catch (error) {
      deny(`CODEX GATE: could not inspect the full main-bound diff for money/security risk, so the push is denied. ${error?.message || error}`);
    }
  }
  if (risky.length === 0 && !contentFlagged) continue;

  const headSha = srcSha;
  const stateDir = path.join(pushRepoDir, ".claude", "session-state");
  let valid = false;
  try {
    if (existsSync(stateDir)) {
      for (const f of readdirSync(stateDir)) {
        // Charset must be no wider than review-proof-guard's path matcher, or a
        // forged proof named outside the matcher (e.g. with a space) could be
        // written unguarded yet still load here (Codex round-5).
        if (!/^codex-review-[A-Za-z0-9_.-]+\.json$/.test(f)) continue;
        let data;
        try { data = JSON.parse(readFileSync(path.join(stateDir, f), "utf8")); } catch { continue; }
        if (proofValid(data, headSha, Date.now(), baseSha)) { valid = true; break; }
      }
    }
  } catch { /* unreadable means no proof */ }
  if (valid) continue;

  const riskyDescription = risky.length > 0
    ? `changes ${risky.length} risky file(s) that need an independent Codex verdict FIRST:\n` +
      risky.slice(0, 6).map((f) => "  " + f).join("\n") +
      (risky.length > 6 ? `\n  ... and ${risky.length - 6} more` : "")
    : describeRiskyContent(contentDiffText);

  deny(
    `CODEX GATE: this push to main ${riskyDescription}\n\n"Review is queued/scheduled" is NOT reviewed. Before pushing:\n` +
    `  1. Run: node scripts/write-codex-push-proof.mjs — it runs an independent read-only Codex review of this exact HEAD (origin/main...HEAD) and requires a machine verdict.\n` +
    `  2. If Codex flags blockers, fix them and re-run until it reports clean; only a clean verdict on a stable, clean worktree mints the proof.\n` +
    `  3. On success it writes the HEAD-bound proof {codex_ran:true, verdict:"clean", head_sha:"${headSha || "<HEAD>"}", timestamp:"<ISO>"} for you — never hand-write it (review-proof-guard blocks that).\n` +
    `  4. Retry the push.\n` +
    `If the Codex CLI is unavailable, PARK the change and tell Mason — do not self-certify. (Proof is bound to this exact HEAD and to origin/main; it expires in 30min, and a moved base forces a fresh review.)`
  );
}

passthrough();
