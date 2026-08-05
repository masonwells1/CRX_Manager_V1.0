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
  contentIsRisky,
  eachPush,
  gitPushCwd,
  gitSubcommandIsDynamic,
  isGitPush,
  pushUsesExecPathOption,
  mainPushSource,
  proofValid,
  pushContextIsAmbiguous,
  pushHiddenByShellComposition,
  pushIsForced,
  pushTargetsCurrentHead,
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
import { validateApprovedFactoryLanding } from "../../scripts/factory-state-lib.mjs";

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
  // Every repository this command could push from, not just the session's cwd:
  // `git -C <other> push` must be proven in <other>, and a chained command can
  // name several. Parsing here is pure text work with no new dependencies.
  const overrideRepoDirs = [...new Set([
    projectDir,
    ...shellSegments(cmd)
      .map((segment) => segment.trim())
      .filter((segment) => isGitPush(segment))
      .map((segment) => gitPushCwd(segment, projectDir)),
  ])];
  // Destinations compare by a normalised DECISION; everything else by exact
  // text. A credential proxy's whole job is re-spelling `git@github.com:` as
  // `https://github.com/` for the same repository, so comparing destination text
  // denied every SSH-remote checkout in a web session. The decision is a pair —
  // the production-gate classification AND a spelling key — and only an
  // allow-list of GitHub spellings collapses; see `pushDestinationDecisions`
  // for why neither half alone is safe. The other lookups are config VALUES (a
  // remote name, a refspec), which a rewrite does not re-spell, so they stay
  // literal.
  const normalizeAnswer = (name, text) => {
    if (name === "remotes") return pushDestinationDecisions(text);
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
  const answerFor = (name, args, cwd, keepConfigOverrides) => {
    // `config --get` exits 1 when a key is unset, which is the ordinary case and
    // must read as "absent", not "failed" — but it has to be DISTINGUISHABLE from
    // a real failure, because an error on one side only is itself a divergence.
    try { return `ok:${normalizeAnswer(name, gitIn(args, cwd, { keepConfigOverrides }))}`; }
    catch (error) { return `err:${error?.status ?? error?.message ?? "failed"}`; }
  };
  for (const repoDir of overrideRepoDirs) {
    let overrideBranch = "";
    try {
      overrideBranch = gitIn(["rev-parse", "--abbrev-ref", "HEAD"], repoDir);
    } catch (error) {
      deny(`CODEX GATE: this shell has GIT_CONFIG* variables set (${inheritedOverrides.join(", ")}) and the guard could not read ${repoDir} to prove they do not redirect the push. ${error?.message || error}`);
    }
    const scrubbed = {};
    const ambient = {};
    for (const [name, args] of pushDestinationLookupArgs(overrideBranch)) {
      scrubbed[name] = answerFor(name, args, repoDir, false);
      ambient[name] = answerFor(name, args, repoDir, true);
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

  // AUTHORITY-MONOTONIC: factory state can only add exact-byte restrictions;
  // the ordinary main risk classification and Sol proof checks below still run.
  let factoryLandingRequired = false;
  try {
    const factoryLanding = validateApprovedFactoryLanding(pushRepoDir, { commitish: "HEAD" });
    factoryLandingRequired = factoryLanding.required;
    if (factoryLanding.required && !pushTargetsCurrentHead(pushCmd, branch)) {
      deny("CODEX GATE: a factory-approved landing may push only this checkout's exact current HEAD. Alternate local refs require parking, fresh proof, and a new owner acceptance.");
    }
  } catch (error) {
    deny(`CODEX GATE: factory landing proof no longer matches the pushed bytes (${error.message}). Park the job, rerun evidence and Sol/high review, and re-present Mason's morning decision.`);
  }
  if (factoryLandingRequired) {
    let headSha = "";
    let baseSha = "";
    try {
      headSha = git(["rev-parse", "--verify", "HEAD"], pushRepoDir);
      baseSha = git(["rev-parse", "--verify", "origin/main"], pushRepoDir);
    } catch (error) {
      deny(`CODEX GATE: could not bind the factory feature push to exact HEAD/base commits (${error?.message || error}).`);
    }
    const proofPath = path.join(pushRepoDir, ".claude", "session-state", `codex-review-${headSha}.json`);
    let proof = null;
    try { proof = JSON.parse(readFileSync(proofPath, "utf8")); } catch { /* missing/unreadable is denied below */ }
    if (!proofValid(proof, headSha, Date.now(), baseSha)) {
      deny("CODEX GATE: a factory-approved feature push requires the canonical fresh Sol/high proof bound to this exact HEAD and origin/main. Run node scripts/write-codex-push-proof.mjs, then retry.");
    }
    try {
      const openPullRequests = JSON.parse(execFileSync("gh", [
        "pr", "list", "--head", branch, "--state", "open",
        "--json", "headRefOid,baseRefName,autoMergeRequest",
      ], {
        cwd: pushRepoDir,
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      }));
      if (!Array.isArray(openPullRequests)) throw new Error("GitHub returned a non-array PR list");
      if (openPullRequests.some((pr) => pr?.autoMergeRequest)) {
        deny("CODEX GATE: this factory feature branch already has auto-merge enabled. Disable auto-merge before pushing so the exact PR head, base, green checks, and Sol proof are verified at an immediate merge gate.");
      }
    } catch (error) {
      deny(`CODEX GATE: could not verify that factory feature-branch auto-merge is disabled, so the push is denied (fail closed). ${error?.message || error}`);
    }
  }

  const srcRef = mainPushSource(pushCmd, branch);
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
  // Checked BEFORE the "unrelated repository, skip the gate" exit below, because
  // these settings are what make "which repository is this?" answerable in the
  // first place. `remote.<name>.receivepack` and `core.sshCommand` name programs
  // that carry the objects, so a nominal backup remote can deliver to the app
  // repo while all three classifiers below say "unrelated" (Codex's twenty-first
  // 2026-07-30 review). Same fact as round seventeen's command-line flag, stored
  // instead of typed.
  // Unioned across both environments for the same reason as the rewrite table
  // above: a carrier program installed by an inherited GIT_CONFIG* variable must
  // still deny, and this classifier can only ever add denials.
  let transportConfig = "";
  const readTransportConfig = (keepConfigOverrides) => {
    try { return gitIn(["config", "--list"], pushRepoDir, { keepConfigOverrides }); }
    catch (_error) { return ""; } // an unreadable config is handled by the checks below
  };
  transportConfig = [readTransportConfig(false), readTransportConfig(true)].filter(Boolean).join("\n");
  const namedPrograms = executableTransportSettings(transportConfig);
  if (namedPrograms.length > 0) {
    deny(`CODEX GATE: this checkout configures git settings that name a program to carry the push (${namedPrograms.join(", ")}). That program decides where the objects actually go, so no destination check here can be trusted. Unset them with \`git config --unset <setting>\` and push normally — git's own defaults need none of them.`);
  }
  // `--mirror` as a command-line flag is already an unconditional deny above.
  // This is the same instruction stored in config instead of typed, and it is
  // read from the same both-environment union for the same reason: an inherited
  // GIT_CONFIG* may be what sets it. Denied at the same breadth as the flag —
  // before the guarded-repository test below — because a mirror push updates
  // every ref in whatever repository it reaches.
  const mirrorRemotes = configuredMirrorRemotes(transportConfig);
  if (mirrorRemotes.length > 0) {
    deny(`CODEX GATE: this checkout configures a mirror remote (${mirrorRemotes.map((r) => `remote.${r}.mirror`).join(", ")}), which is \`--mirror\` stored in config. A bare push to a mirror remote updates EVERY ref — main included — without naming one, so the production review gate never sees a main-bound push, and git rejects any explicit refspec that would narrow it. Unset it with \`git config --unset remote.<name>.mirror\` and push one explicit branch.`);
  }
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
  if (risky.length === 0) {
    try {
      contentFlagged = contentIsRisky(git(["diff", `origin/main...${srcSha}`], pushRepoDir));
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
    : "changes content that matches a money/financial-audit pattern (_cents, balance_cents, financial_audit_log, allocate_payment, apply_prepay) even though no changed file's PATH looked risky";

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
