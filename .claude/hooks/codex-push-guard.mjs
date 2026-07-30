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
  gitPushCwd,
  isGitPush,
  mainPushSource,
  proofValid,
  pushContextIsAmbiguous,
  pushIsForced,
  pushUsesBulkMode,
  pushUsesInlineConfig,
  pushUsesConfigEnv,
  environmentCarriesConfigOverride,
  destinationLooksLikeUrl,
  pushDestinationToken,
  repoIsGuardedApp,
  rewritesReachGuardedApp,
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
// The command text is only half the story. A GIT_CONFIG* variable set by an
// EARLIER command is still live when this push runs, and the push command itself
// then looks completely ordinary. This hook inherits the same environment the
// push will inherit, so it checks directly rather than trying to parse history.
// Codex's sixth 2026-07-30 review asked for this.
const inheritedOverrides = environmentCarriesConfigOverride(process.env);
if (inheritedOverrides.length > 0) {
  deny(`CODEX GATE: this shell already has GIT_CONFIG* variables set (${inheritedOverrides.join(", ")}), so the push would inherit configuration this guard cannot see — its own destination lookups deliberately ignore them. Unset them before pushing.`);
}

// Claude's shell cwd can persist across tool calls. The hook payload's cwd is
// therefore the authoritative repository context for this specific push; the
// session-wide CLAUDE_PROJECT_DIR is only a fallback.
const projectDir = path.resolve(
  payload?.cwd || payload?.tool_input?.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd(),
);
function git(args, cwd) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
  // Defence in depth for the GIT_CONFIG* bypass denied above: if this hook is
  // ever invoked with those variables already in its OWN environment, they would
  // rewrite the answers to the very lookups used to classify the destination.
  // Strip them so the guard always reads the repository's real configuration.
  for (const key of Object.keys(env)) if (/^GIT_CONFIG(_|$)/i.test(key)) delete env[key];
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

// Inspect every push in a chained/multiline command. A harmless first push must
// not hide a later main-bound push. Single `|` splits too (Codex round-4):
// both sides of a pipeline execute.
const pushCommands = cmd
  .split(/(?:&&|\|\|?|;|\r?\n)/)
  .map((segment) => segment.trim())
  .filter((segment) => isGitPush(segment));

for (const pushCmd of pushCommands) {
  if (/--git-dir|--work-tree/i.test(pushCmd)) {
    deny("CODEX GATE: pushes using explicit --git-dir/--work-tree contexts are denied because the guard cannot safely bind them to the inspected worktree. Use `git -C <repo> push` instead.");
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
  let destinationUrl = "";
  try {
    const destinationToken = pushDestinationToken(pushCmd);
    if (destinationToken && destinationLooksLikeUrl(destinationToken)) {
      destinationUrl = destinationToken;
    } else {
      // No destination named → git resolves its own default, in this order.
      const config = (key) => { try { return git(["config", "--get", key], pushRepoDir); } catch { return ""; } };
      const remoteName = destinationToken
        || config(`branch.${branch}.pushRemote`)
        || config("remote.pushDefault")
        || config(`branch.${branch}.remote`)
        || "origin";
      destinationUrl = git(["remote", "get-url", "--push", remoteName], pushRepoDir);
    }
  } catch (_error) {
    // Fail CLOSED: urlIsGuardedApp("") is true, so an unresolvable destination
    // gates the push instead of waving it through.
    destinationUrl = "";
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
  let urlRewrites = "";
  try {
    urlRewrites = git(["config", "--get-regexp", "^url\\..*insteadof$"], pushRepoDir);
  } catch (_error) {
    // `--get-regexp` exits 1 when nothing matches, which is the common case and
    // means "no rewrites configured" — NOT a failure. An empty string is
    // correctly read as "no rewrite reaches the app repo".
    urlRewrites = "";
  }
  if (
    !urlIsGuardedApp(destinationUrl) &&
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
