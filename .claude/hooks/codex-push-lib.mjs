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

function reviewProofValid(data, headSha, nowMs, ranKey) {
  if (!data || data[ranKey] !== true) return false;
  const v = String(data.verdict || "");
  if (v !== "clean" && v !== "blockers-fixed") return false;
  if (headSha && data.head_sha !== headSha) return false;
  const t = data.timestamp ? Date.parse(data.timestamp) : NaN;
  if (!Number.isFinite(t)) return false;
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  const age = now - t;
  if (age < 0 || age > 30 * 60 * 1000) return false;
  return true;
}

// Validate Claude's existing Codex-review proof shape.
export function proofValid(data, headSha, nowMs) {
  return reviewProofValid(data, headSha, nowMs, "codex_ran");
}

// Mirror validation for Codex's Claude-review proof shape.
export function claudeProofValid(data, headSha, nowMs) {
  return reviewProofValid(data, headSha, nowMs, "claude_ran");
}

export { RISKY_PATH_RES, RISKY_CONTENT_RE };
