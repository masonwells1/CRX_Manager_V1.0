// Shared helpers for Claude's and Codex's production-push guards.

import path from "node:path";

// Does the git command push (to main)? We fire on any `git push`; the hook then
// checks whether the push actually TARGETS main before doing anything.
// Tolerates git GLOBAL options between `git` and `push` — `git -C <dir> push`,
// `git --git-dir=... push`, `git -c k=v push` — which used to bypass the gate
// entirely (observed 2026-07-10: a `git -C` push slipped past this guard).
const GIT_ARG = `(?:"[^"]*"|'[^']*'|\\S+)`;
const GIT_BIN = `(?:"[^"]*[\\\\/]git(?:\\.exe)?"|'[^']*[\\\\/]git(?:\\.exe)?'|(?:\\S*[\\\\/])?git(?:\\.exe)?)`;
const GIT_GLOBAL_OPTS =
  `(?:\\s+(?:-C\\s+${GIT_ARG}|-c\\s+${GIT_ARG}|--git-dir(?:=${GIT_ARG}|\\s+${GIT_ARG})|--work-tree(?:=${GIT_ARG}|\\s+${GIT_ARG})|--no-pager|--literal-pathspecs|--exec-path(?:=${GIT_ARG})?))*`;
const GIT_PUSH_RE = new RegExp(`(?:^|\\s)${GIT_BIN}${GIT_GLOBAL_OPTS}\\s+push\\b([^;&|]*)`, "i");
const GIT_PUSH_PREFIX_RE = new RegExp(`(?:^|\\s)${GIT_BIN}(${GIT_GLOBAL_OPTS})\\s+push\\b`, "i");
export function isGitPush(cmd) {
  return GIT_PUSH_RE.test(String(cmd || ""));
}

function unquoteShellArg(value) {
  const text = String(value || "");
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function splitShellArgs(value) {
  return String(value || "").match(/"[^"]*"|'[^']*'|\S+/g)?.map(unquoteShellArg) || [];
}

// Resolve the repository directory selected by one or more `git -C` options.
// Git applies repeated -C values from left to right, so preserve that behavior.
export function gitPushCwd(cmd, fallbackCwd) {
  const base = path.resolve(fallbackCwd || process.cwd());
  const prefix = String(cmd || "").match(GIT_PUSH_PREFIX_RE)?.[1] || "";
  const optionRe = new RegExp(`(?:^|\\s)-C\\s+(${GIT_ARG})`, "g");
  let cwd = base;
  let match;
  while ((match = optionRe.exec(prefix)) !== null) {
    cwd = path.resolve(cwd, unquoteShellArg(match[1]));
  }
  return cwd;
}

// Shell directory changes and git context environment variables apply outside
// the git argv, so the ref parser cannot safely bind them to a worktree. Deny
// these forms and require the explicit, inspectable `git -C <repo> push` form.
export function pushContextIsAmbiguous(cmd) {
  const text = String(cmd || "");
  if (!isGitPush(text)) return false;
  return /(?:^|[;&|\r\n()]|\s)(?:cd(?:\s+\/d)?|chdir|pushd|popd|set-location|pop-location)\s+/i.test(text) ||
    /(?:\$env:|\benv\s+|\bset\s+|^|[;&|\r\n]\s*)(?:GIT_DIR|GIT_WORK_TREE)\s*=/i.test(text);
}

export function reviewProofPathMentioned(value) {
  const text = String(value || "").replace(/\\/g, "/");
  // Match both full paths and bare basenames. The latter matters when a shell
  // changed into session-state on a previous tool call: `printf ... >
  // codex-review-forged.json` must still be recognized without the directory
  // appearing in the second command.
  // Filename-character boundaries avoid an endless delimiter allowlist: shell
  // separators, commas, redirects, parentheses, and future punctuation all
  // delimit the protected basename, while embedded lookalikes such as
  // `my-claude-review-push.json.bak` do not match.
  return /(?<![\w.-])(?:claude-review-push\.json|codex-review-[^\s/"']+\.json)(?![\w.-])/i.test(text);
}

export function reviewStateDirectoryMentioned(value) {
  const text = String(value || "").replace(/\\/g, "/");
  return /(?:^|[\s"'=:\/])(?:\.?\/?(?:[^\s"']+\/)*\.claude\/session-state)(?:$|[\s/"'])/i.test(text) ||
    /\.claude\/session-state/i.test(text) ||
    // Deny the component steps too. Otherwise `cd .claude` followed by `cd
    // session-state` can assemble the protected cwd without either command
    // containing the contiguous full path.
    /(?:^|[;&|\r\n()]|\s)(?:cd(?:\s+\/d)?|chdir|pushd|set-location)\s+["']?(?:\.claude|session-state)(?:["']?(?:$|[;&|\s]))/i.test(text);
}

// Which LOCAL ref is this push landing on main? Returns:
//   null      — the push does not target main (gate stands down)
//   "DELETE"  — `push origin :main` (deleting main!) — the guard denies outright
//   a ref     — the SOURCE being pushed to main ("HEAD", "main", a branch name).
// The guard must diff/bind its Codex proof against THIS ref, not blindly HEAD
// (Codex 2026-07-05: `git push origin release:main` from another branch used to
// be diffed/proofed against HEAD — the wrong content).
export function mainPushSource(cmd, currentBranch) {
  const c = String(cmd || "");
  const m = c.match(GIT_PUSH_RE);
  if (!m) return null;
  const tokens = splitShellArgs(m[1]);
  // Option-based deletion: `git push origin --delete main` / `-d main`. Git
  // accepts unambiguous long-option abbreviations, and the only push option
  // starting "--de" is --delete, so any --de… token is delete intent (Codex
  // review 2026-07-13: these forms used to classify as an ordinary main push).
  const deleteIntent = tokens.some((t) => /^--de\S*$/.test(t) || /^-[A-Za-z]*d[A-Za-z]*$/.test(t));
  const argsAll = tokens.filter((a) => !a.startsWith("-"));
  if (deleteIntent && argsAll.slice(1).some((a) => a.replace(/^refs\/heads\//, "") === "main")) {
    return "DELETE";
  }
  // Whole-refspace push modes do not name main in a refspec, but they still
  // include it. Treat local main as the source so callers cannot stand down
  // merely because the command used `--all`/`--branches`/`--mirror`.
  if (tokens.some((token) => ["--all", "--branches", "--mirror"].includes(token))) return "main";
  const args = argsAll;
  const refspecs = args.slice(1); // args[0] = remote, if present
  if (refspecs.length === 0) return currentBranch === "main" ? "HEAD" : null;
  for (const rs of refspecs) {
    const hasColon = rs.includes(":");
    const src = hasColon ? rs.split(":")[0].replace(/^\+/, "") : rs;
    const dst = (hasColon ? rs.split(":").pop() : rs).replace(/^refs\/heads\//, "");
    if (dst === "main") {
      if (hasColon) return src ? src.replace(/^refs\/heads\//, "") : "DELETE";
      return "main"; // bare `git push origin main` pushes local main
    }
    if (!hasColon && dst === "HEAD" && currentBranch === "main") return "HEAD";
  }
  return null;
}

// Back-compat boolean used by tests/other callers.
export function pushTargetsMain(cmd, currentBranch) {
  return mainPushSource(cmd, currentBranch) !== null;
}

// Any push is forced when it carries a history-rewriting force flag anywhere
// after `push`, or uses Git's `+<src>:<dst>` force-refspec syntax. This scan is
// deliberately independent of target resolution: AGENTS.md requires approval
// before force-pushing ANY branch, and an implicit target such as `--all` must
// not make force intent disappear.
export function pushIsForced(cmd) {
  const args = String(cmd || "").match(GIT_PUSH_RE)?.[1] || "";
  const tokens = splitShellArgs(args);
  // Any long option starting "--force" is force intent: git accepts unambiguous
  // abbreviations (`--force-w` = --force-with-lease), and every valid abbreviation
  // of a force option itself starts with "--force" — anything shorter ("--forc")
  // is ambiguous and git rejects it (Codex review 2026-07-13).
  const forceFlag = tokens.some((token) =>
    /^--force(?:$|[-=])/.test(token) ||
    /^-[A-Za-z]*f[A-Za-z]*$/.test(token)
  );
  const forceRefspec = tokens.some((token) => token.startsWith("+") && token.length > 1);
  return forceFlag || forceRefspec;
}

// Back-compat helper for callers that specifically care about main.
export function mainPushIsForced(cmd, currentBranch) {
  return mainPushSource(cmd, currentBranch) !== null && pushIsForced(cmd);
}

// Bulk modes are too broad for an unattended agent: they can update or delete
// multiple remote refs without naming them in the command. Git accepts
// unambiguous long-option abbreviations (`--mirr`, `--al` — Codex round-4), so
// match any `--` token that is a prefix (length ≥ 3) of a bulk option;
// ambiguous prefixes git would reject anyway, and over-denying them is safe.
const BULK_PUSH_OPTS = ["--all", "--branches", "--mirror", "--prune"];
export function pushUsesBulkMode(cmd) {
  const args = String(cmd || "").match(GIT_PUSH_RE)?.[1] || "";
  const tokens = splitShellArgs(args);
  return tokens.some((token) => {
    if (!token.startsWith("--") || token.length < 3) return false;
    const bare = token.split("=")[0];
    return BULK_PUSH_OPTS.some((opt) => opt.startsWith(bare));
  });
}

// Extract the DESTINATION paths from a free-form patch payload (Codex
// apply_patch envelopes and unified diffs). Guards must classify a patch by
// where it WRITES, not by every path its added prose happens to mention —
// whole-body scans false-positive on documentation that discusses guard files
// (Codex round-5).
export function extractPatchDestinations(text) {
  const out = [];
  const re = /^(?:\*{3}\s*(?:Add|Update|Delete|Move(?:\s+to)?)\s+File:\s*(.+?)\s*$|\+{3}\s+(?:b\/)?(\S+)|-{3}\s+(?:a\/)?(\S+)|rename\s+to\s+(\S+)\s*$)/gim;
  let match;
  while ((match = re.exec(String(text || ""))) !== null) {
    const dest = match[1] || match[2] || match[3] || match[4];
    if (dest && dest !== "/dev/null") out.push(dest);
  }
  return out;
}

// A changed file is "risky" (needs an independent second-model verdict) when it
// touches migrations, edge functions, money/RLS-shaped code, or the guardrail
// machinery that decides whether a change can reach main. Guard hooks, CI,
// Husky, and the review wrapper are explicit here so a self-modification cannot
// avoid independent review merely because its diff lacks a money keyword.
const RISKY_PATH_RES = [
  /(^|\/)supabase\/migrations\//i,
  /(^|\/)supabase\/functions\//i,
  /(^|\/)rls[_-]/i,
  /policy|grant/i,
  /(^|\/)src\/lib\/db\.ts$/i,
  /(^|\/)src\/lib\/sentry(\.ts|\/)/i,
  /(^|\/)\.claude\/hooks\//i,
  /(^|\/)\.codex\/hooks\//i,
  /(^|\/)\.github\/workflows\//i,
  /(^|\/)\.husky\//i,
  /(^|\/)scripts\/run-claude-review\.mjs$/i,
  /(^|\/)scripts\/write-codex-push-proof\.mjs$/i,
  // Reviewer charters are executable review instructions for the migration
  // proof gate (write-apply-proofs runs each .claude/agents/<reviewer>.md as a
  // machine-verdict Codex run) — editing one weakens the gate, so charter
  // changes require the same independent verdict (Codex round-7, PR #142).
  /(^|\/)\.claude\/agents\//i,
  /(^|\/)scripts\/write-apply-proofs\.mjs$/i,
  // The hook-REGISTRATION surfaces: every guard is only active because it is
  // wired here. A PR that de-registers a guard (removes the pr-merge-guard line,
  // etc.) touches ONLY these files and would otherwise merge un-gated, disabling
  // the very gate meant to review it (Codex round-8, PR #142).
  /(^|\/)\.claude\/settings\.json$/i,
  /(^|\/)\.codex\/hooks\.json$/i,
];
export function riskyFiles(files) {
  return (files || []).filter((f) => RISKY_PATH_RES.some((re) => re.test(String(f || ""))));
}

// A push can also be risky by CONTENT even when no file's PATH matches the
// patterns above — e.g. a helper file outside the usual risky paths that still
// touches cents-math or writes financial_audit_log / prepay / payment-allocation
// logic. Checked against the full diff TEXT (not just file names).
// NOTE: `_cents` is a SUFFIX on identifiers like total_cents/balance_cents/
// extended_cents — a leading \b would never match there (underscore is a \w
// character, so there's no word boundary between "total" and "_cents"). Only
// the trailing \b is meaningful for that one; the other three are matched as
// whole identifiers.
const RISKY_CONTENT_RE = /_cents\b|\bfinancial_audit_log\b|\ballocate_payment\b|\bapply_prepay\b/;
export function contentIsRisky(diffText) {
  return RISKY_CONTENT_RE.test(String(diffText || ""));
}

function reviewProofValid(data, headSha, nowMs, ranKey, expectedBaseSha) {
  if (!data || data[ranKey] !== true) return false;
  const v = String(data.verdict || "");
  if (v !== "clean") return false;
  if (headSha && data.head_sha !== headSha) return false;
  // Base-SHA binding: a proof records the exact origin/main it was reviewed
  // against (base_sha). origin/main can advance — a sibling session fetches a
  // just-merged commit — WITHOUT dirtying the worktree or moving HEAD, which
  // would otherwise leave a HEAD-bound-only proof valid even though the diff the
  // guard now gates (origin/main...HEAD) is no longer the diff that was
  // reviewed. When the caller supplies the base it is gating against, the proof
  // must carry a matching base_sha; a proof with no base_sha (pre-hardening) or a
  // stale/mismatched base fails closed and forces a fresh review. The check is
  // gated on `expectedBaseSha` exactly like the head_sha check above so the
  // shared validator stays usable in base-agnostic unit contexts; both real
  // guards always pass the resolved origin/main.
  if (expectedBaseSha && data.base_sha !== expectedBaseSha) return false;
  const t = data.timestamp ? Date.parse(data.timestamp) : NaN;
  if (!Number.isFinite(t)) return false;
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  const age = now - t;
  if (age < 0 || age > 30 * 60 * 1000) return false;
  return true;
}

// Validate Claude's existing Codex-review proof shape.
export function proofValid(data, headSha, nowMs, expectedBaseSha) {
  return reviewProofValid(data, headSha, nowMs, "codex_ran", expectedBaseSha);
}

// Mirror validation for Codex's Claude-review proof shape.
export function claudeProofValid(data, headSha, nowMs, expectedBaseSha) {
  return reviewProofValid(data, headSha, nowMs, "claude_ran", expectedBaseSha);
}

// Every session-state directory belonging to THIS repository — the primary
// checkout plus each linked worktree.
//
// Why this exists (2026-07-27, PR #252): pr-merge-guard resolves its root from
// the SESSION's cwd, which the Claude harness pins to the primary checkout and
// resets after every command. `scripts/write-codex-push-proof.mjs` resolves its
// OUTPUT from `git rev-parse --show-toplevel` of wherever it ran — the worktree
// holding the branch. A PR built in a linked worktree therefore wrote a
// perfectly valid proof somewhere the merge guard never looked, and `gh pr merge`
// was denied no matter how many clean Codex reviews were minted. Head and base
// matched `gh pr view` exactly; only the directory differed.
//
// Widening the SEARCH does not widen what COUNTS. `proofValid()` still demands
// the exact head SHA GitHub reports, the exact base GitHub will merge onto, a
// clean verdict, and an age inside 30 minutes; and
// `review-proof-guard.mjs` still blocks hand-writing a proof in ANY directory.
// These are sibling checkouts of one repository, not arbitrary paths — a proof
// that would be rejected in the primary checkout is rejected in every one.
//
// `listWorktrees` is injected so this is testable without a real repo.
export function proofSearchDirs(root, listWorktrees) {
  const stateDir = (dir) => path.resolve(dir, ".claude", "session-state");
  const dirs = [stateDir(root)];
  let porcelain;
  try {
    porcelain = listWorktrees();
  } catch {
    // Enumeration unavailable (no git, not a repo, timeout). Fall back to the
    // primary directory alone: losing the widening can only make the gate
    // STRICTER, never laxer, so this fails in the safe direction.
    return dirs;
  }
  for (const line of String(porcelain ?? "").split(/\r?\n/)) {
    // `\s+(.+)` (not `\s*(.*)`) is what keeps a pathless `worktree` line out: an empty
    // capture would resolve against process.cwd() and manufacture a search directory
    // that has nothing to do with this repository.
    const match = /^worktree\s+(.+)$/.exec(line.trim());
    if (match) dirs.push(stateDir(match[1]));
  }
  // The primary checkout appears in `git worktree list` too — scanning a path
  // twice is wasted I/O, not a correctness bug, but dedupe it anyway.
  return [...new Set(dirs)];
}

// ── PR-merge request detection (2026-07-16 scaffolding review Theme 1) ───────
// Since the 2026-07-14 `protect-main` ruleset, work lands on main via PR merge,
// not `git push` — so the merge action needs the same risky-diff Codex gate the
// push had. These parsers mirror the battle-tested ones in
// .codex/hooks/production-action-guard.mjs (rounds 4-5 hardening); they live
// here because .claude/hooks/ is the single source of truth for shared guard
// logic. Follow-up: production-action-guard should import these instead of
// carrying its own copies.

// gh binary reference — tolerates quoted absolute paths and gh.exe.
const GH_BIN_RE = /(?:^|\s)(?:"[^"]*[\\/]gh\.exe"|\S*[\\/]gh(?:\.exe)?|gh(?:\.exe)?)(?:\s|$)/i;

// `gh pr merge` with global flags possibly between words (`gh -R o/r pr merge`).
// Over-matching (e.g. `gh pr view merge-notes`) only routes a read through the
// gate, which fails safe.
export function ghMergeRequest(command) {
  const text = String(command || "");
  if (!GH_BIN_RE.test(text)) return null;
  const words = splitShellArgs(text);
  const prIndex = words.findIndex((word) => word.toLowerCase() === "pr");
  if (prIndex === -1) return null;
  const mergeIndex = words.findIndex((word, index) => index > prIndex && word.toLowerCase() === "merge");
  if (mergeIndex === -1) return null;
  // `--disable-auto` cancels a pending auto-merge — it does not land anything,
  // so the gate stands down for it.
  if (words.some((word) => word.toLowerCase() === "--disable-auto")) return null;
  const valueFlags = new Set(["--repo", "-R", "--match-head-commit", "--subject", "--body", "-t", "-b"]);
  let selector = "";
  let repo = "";
  let auto = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word.startsWith("--repo=")) { repo = word.slice("--repo=".length); continue; }
    if (word.toLowerCase() === "--auto" || word.toLowerCase().startsWith("--auto=")) { auto = true; continue; }
    if (valueFlags.has(word)) {
      const value = words[index + 1] || "";
      if (word === "--repo" || word === "-R") repo = value;
      index += 1;
      continue;
    }
    if (index > mergeIndex && !word.startsWith("-") && !selector) selector = word;
  }
  return { selector, repo, auto };
}

// `gh api -X PUT repos/o/r/pulls/N/merge`, plus the GraphQL mergePullRequest
// mutation (unresolvable → caller must deny). The `api` subcommand is found by
// word-scan, NOT by position — global flags may sit between `gh` and `api`
// (`gh -R o/r api graphql ...` — Codex round-5 finding on this guard's own PR:
// the position-anchored `gh\s+api` regex let that exact form pass ungated).
export function ghApiMergeRequest(command) {
  const text = String(command || "");
  if (!GH_BIN_RE.test(text)) return null;
  const words = splitShellArgs(text);
  const apiIndex = words.findIndex((word) => word.toLowerCase() === "api");
  if (apiIndex === -1) return null;
  if (words.some((word, index) => index > apiIndex && word.toLowerCase() === "graphql") &&
      /\bmergePullRequest\b/i.test(text)) {
    return { unsupportedGraphql: true };
  }
  let method = "GET";
  let endpoint = "";
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === "-X" || word === "--method") { method = String(words[index + 1] || "").toUpperCase(); index += 1; continue; }
    if (word.startsWith("--method=")) { method = word.slice("--method=".length).toUpperCase(); continue; }
    if (/^-X\S+/i.test(word)) { method = word.slice(2).toUpperCase(); continue; }
    const normalizedEndpoint = word.replace(/^https:\/\/api\.github\.com\//i, "").replace(/^\//, "");
    if (/^repos\/[^/]+\/[^/]+\/pulls\/\d+\/merge$/i.test(normalizedEndpoint)) endpoint = normalizedEndpoint;
  }
  if (method !== "PUT" || !endpoint) return null;
  const match = endpoint.match(/^repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/i);
  return match ? { selector: match[3], repo: `${match[1]}/${match[2]}`, auto: false } : null;
}

// MCP merge tool inputs — key spellings differ per connector (GitHub MCP uses
// pull_number/owner/repo; app-style connectors use pr_number/repository_full_name).
export function mcpMergeRequest(toolInput = {}) {
  const selector = toolInput.pull_number ?? toolInput.pullNumber ?? toolInput.pullRequestNumber ??
    toolInput.pr_number ?? toolInput.prNumber ?? toolInput.number ?? "";
  const owner = toolInput.owner ?? toolInput.organization ?? "";
  const repository = toolInput.repo ?? toolInput.repository ?? toolInput.repoName ??
    toolInput.repository_full_name ?? toolInput.repositoryFullName ?? toolInput.full_name ?? "";
  const repo = String(repository).includes("/") ? String(repository) : (owner && repository ? `${owner}/${repository}` : "");
  return { selector: String(selector), repo, auto: false };
}

// Fully-green pipeline: mergeStateStatus CLEAN and every reported check
// completed successfully / neutral / skipped. Zero reported checks fails closed
// (the Vercel check is required on main — its absence means "not reported yet").
export function pullRequestChecksGreen(pullRequest) {
  if (String(pullRequest?.mergeStateStatus || "").toUpperCase() !== "CLEAN") return false;
  const checks = pullRequest?.statusCheckRollup;
  if (!Array.isArray(checks) || checks.length === 0) return false;
  return checks.every((check) => {
    if (check?.__typename === "StatusContext") {
      return String(check.state || "").toUpperCase() === "SUCCESS";
    }
    if (check?.__typename === "CheckRun") {
      const status = String(check.status || "").toUpperCase();
      const conclusion = String(check.conclusion || "").toUpperCase();
      return status === "COMPLETED" && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion);
    }
    return false;
  });
}

export { RISKY_PATH_RES, RISKY_CONTENT_RE };
