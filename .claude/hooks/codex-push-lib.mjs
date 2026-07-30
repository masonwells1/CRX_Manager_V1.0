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
  // `--config-env` must be listed here or the whole command stops looking like a
  // push: without it `git --config-env=remote.origin.pushurl=VAR push origin main`
  // failed `isGitPush` and skipped EVERY check in this guard (found while testing
  // Codex's 2026-07-30 inline-config finding).
  `(?:\\s+(?:-C\\s+${GIT_ARG}|-c\\s+${GIT_ARG}|--config-env(?:=${GIT_ARG}|\\s+${GIT_ARG})|--git-dir(?:=${GIT_ARG}|\\s+${GIT_ARG})|--work-tree(?:=${GIT_ARG}|\\s+${GIT_ARG})|--no-pager|--literal-pathspecs|--exec-path(?:=${GIT_ARG})?))*`;
const GIT_PUSH_RE = new RegExp(`(?:^|\\s)${GIT_BIN}${GIT_GLOBAL_OPTS}\\s+push\\b([^;&|]*)`, "i");
const GIT_PUSH_PREFIX_RE = new RegExp(`(?:^|\\s)${GIT_BIN}(${GIT_GLOBAL_OPTS})\\s+push\\b`, "i");
export function isGitPush(cmd) {
  return GIT_PUSH_RE.test(String(cmd || ""));
}

// EVERY push in the command, not just the first. `String.match` without /g and
// `RegExp.exec` on a non-global pattern both stop at the first hit, which meant a
// whole-command check saw only the leading push — so `git push origin feature &&
// git push --recurse-submodule no <CRX Manager URL> HEAD:main` reported no unknown
// options and no inline variables at all, while the second push carried both
// (Codex's eighth 2026-07-30 review; confirmed by probe the same day, which also
// showed pushSetsInlineEnv blind to a chained second push, which the review did
// not name). Every whole-command scan below iterates this instead.
export function eachPush(cmd) {
  const text = String(cmd || "");
  const scanner = new RegExp(GIT_PUSH_RE.source, "gi");
  const found = [];
  let match;
  while ((match = scanner.exec(text)) !== null) {
    found.push({ args: match[1] || "", index: match.index });
    if (scanner.lastIndex === match.index) scanner.lastIndex += 1; // zero-width safety
  }
  return found;
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

// This gate exists to protect the CRX Manager production app repo. It has no
// remit over OTHER repositories, and on 2026-07-29 that gap bit: the unanchored
// `/policy|grant/i` path pattern above matched a MARKDOWN NOTE named
// `project_policy-grantee-disk-vs-live-drift.md` and blocked a snapshot push to
// the private masonwells1/CRX_Backups backup repo — a repo with no migrations,
// no RLS, and no production surface. Scope the gate by the repository's own
// remotes so it keeps FULL strength on the app repo (the path patterns are
// deliberately untouched) and stops policing unrelated ones.
export const GUARDED_REPO_RE = /[:/]masonwells1\/CRX_Manager_V1\.0(?:\.git)?$/i;

// Raw string matching is not repository identity. `https://github.com/masonwells1/
// ./CRX_Manager_V1.0.git` is the production repo — every URL parser and git itself
// resolve it there — but the suffix pattern above does not match it, so the guard
// classified it as some unrelated repo and skipped the proof gate entirely
// (Codex's ninth 2026-07-30 review). Compare canonical identity instead: reduce a
// destination to `host/owner/repo`, resolving `.`/`..`, collapsing separators,
// dropping credentials, port, trailing slashes and `.git`, and lowercasing (GitHub
// treats owner and repo case-insensitively). Returns null when the text is not a
// URL form at all — a bare remote name like `origin` or a filesystem path — so
// callers can tell "not this repo" apart from "no repository named here".
export function canonicalRepoId(url) {
  let text = String(url ?? "").trim();
  if (!text) return null;
  const outer = /^(['"])([\s\S]*)\1$/.exec(text);
  if (outer) text = outer[2].trim();
  let host;
  let rawPath;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) {
    let parsed;
    try { parsed = new URL(text); } catch { return null; }
    host = parsed.hostname;
    rawPath = parsed.pathname;
  } else {
    // scp-like: [user@]host:path — the colon must not be followed by a slash
    // (that would be a scheme) and the host must not look like a drive letter.
    const scp = /^(?:[^@\s/\\]+@)?([^\s:/\\]{2,}):(?!\/)([\s\S]+)$/.exec(text);
    if (!scp) return null;
    host = scp[1];
    rawPath = scp[2];
  }
  const segments = [];
  for (const segment of String(rawPath).split(/[\\/]+/)) {
    if (!segment || segment === ".") continue;
    if (segment === "..") { segments.pop(); continue; }
    segments.push(segment);
  }
  if (segments.length === 0 || !host) return null;
  segments[segments.length - 1] = segments[segments.length - 1].replace(/\.git$/i, "");
  if (!segments[segments.length - 1]) return null;
  return `${canonicalHost(host)}/${segments.join("/")}`.toLowerCase();
}
// One repository, several hostnames. `ssh://git@ssh.github.com:443/owner/repo.git`
// is GitHub's documented endpoint for networks that block port 22 — it reaches the
// exact same repository, but on host name alone it read as somewhere unrelated, so
// a push to production through it skipped the proof gate entirely (Codex's eleventh
// 2026-07-30 review). Fold every hostname that serves github.com onto `github.com`
// BEFORE identity is decided.
const HOST_ALIASES = new Map([
  ["ssh.github.com", "github.com"],
  ["www.github.com", "github.com"],
]);
function canonicalHost(host) {
  const lower = String(host).toLowerCase().replace(/\.$/, "");
  return HOST_ALIASES.get(lower) || lower;
}
const GUARDED_REPO_ID = "github.com/masonwells1/crx_manager_v1.0";
// Accepts `git remote -v` output. Fails CLOSED: anything unparseable or empty is
// treated as the guarded repo, so a broken remote lookup cannot skip the gate.
export function repoIsGuardedApp(remoteListOutput) {
  const lines = String(remoteListOutput ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return true;
  return lines.some((line) => {
    const url = line.split(/\s+/)[1] || "";
    return canonicalRepoId(url) === GUARDED_REPO_ID || GUARDED_REPO_RE.test(url);
  });
}
// The checkout's CONFIGURED remotes are not the whole answer, and relying on
// them alone was a bypass (Codex pre-push review 2026-07-30): `git push
// git@github.com:masonwells1/CRX_Manager_V1.0.git HEAD:main` writes to the
// production app repo from a checkout whose only configured remote is something
// unrelated, so a configured-remotes-only check would have waved it through.
// The guard now classifies the push's ACTUAL destination as well, and gates
// when EITHER the destination or the checkout is the app repo.
export function urlIsGuardedApp(url) {
  const text = String(url ?? "").trim().replace(/\/+$/, "");
  if (text.length === 0) return true; // fail CLOSED: unresolvable destination gates
  const id = canonicalRepoId(text);
  if (id) return id === GUARDED_REPO_ID;
  // Not canonicalizable. If it still carries a URL SCHEME it names some host the
  // guard could not resolve — fail CLOSED, because an unreadable remote is
  // exactly the case this exists for. A bare remote name (`origin`) or a
  // filesystem path names no host at all; those resolve elsewhere, and calling
  // them guarded here would gate every push to a local repo.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) return true;
  return GUARDED_REPO_RE.test(text);
}

// Options that consume the FOLLOWING argv token. Without this, `git push -o
// ci.skip origin main` would read `ci.skip` as the destination.
//
// `--recurse-submodules` was missing until Codex's seventh 2026-07-30 review.
// Verified the same day against git 2.54: `git push --recurse-submodules no
// <urlA> HEAD:main` in a checkout that ALSO has a remote named `no` pushed to
// urlA, not to `no` — git consumed `no` as the option's value. The guard read
// `no` as the destination, classified it as an unrelated remote, and skipped the
// proof gate while the push went to the URL that followed.
const PUSH_OPTS_WITH_VALUE = new Set([
  "--receive-pack", "--exec", "--repo", "-o", "--push-option", "--recurse-submodules",
]);
// Every remaining `git push` option, from `git push -h` on git 2.54. These take
// no separate value (`--force-with-lease` and `--signed` take an OPTIONAL one,
// which git only accepts attached with `=`, so they never swallow a token).
//
// This list exists so the guard can fail CLOSED on an option it does not know.
// Rounds four through seven were all the same mistake in different clothes — a
// hand-kept list that was missing an entry — so the list is no longer trusted to
// be complete. Anything not named here makes the argv walk untrustworthy, and an
// untrustworthy walk means an untrustworthy destination. A future git option
// then costs one clear error message; the old behaviour cost an unreviewed push.
const PUSH_OPTS_KNOWN = new Set([
  ...PUSH_OPTS_WITH_VALUE,
  "--verbose", "--quiet", "--all", "--branches", "--mirror", "--delete", "--tags",
  "--dry-run", "--porcelain", "--force", "--force-with-lease", "--force-if-includes",
  "--thin", "--set-upstream", "--progress", "--prune", "--verify", "--follow-tags",
  "--signed", "--atomic", "--ipv4", "--ipv6",
]);
// Short forms, which git also accepts bundled (`-fu`). `-o` is the only one that
// takes a value.
const PUSH_SHORT_OPTS_KNOWN = new Set(["v", "q", "d", "n", "f", "u", "o", "4", "6"]);

// Any option in a push command that this guard's argv walk does not understand.
// A non-empty result means the destination cannot be resolved safely.
export function unknownPushOptions(cmd) {
  const unknown = [];
  for (const push of eachPush(cmd)) {
    const tokens = splitShellArgs(push.args);
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === "--") break;
      if (token === "-" || !token.startsWith("-")) continue;
      const eq = token.indexOf("=");
      const bare = eq === -1 ? token : token.slice(0, eq);
      if (bare.startsWith("--")) {
        // `--no-force` is git's negation of `--force`; judge the base option.
        // Note that git also accepts unambiguous ABBREVIATIONS of long options
        // (`--recurse-submodule`), which do not match here and are therefore
        // reported as unknown — the fail-closed direction, and how round eight's
        // finding gets caught rather than parsed.
        const base = PUSH_OPTS_KNOWN.has(bare) ? bare : bare.replace(/^--no-/, "--");
        if (!PUSH_OPTS_KNOWN.has(base)) unknown.push(bare);
        else if (eq === -1 && PUSH_OPTS_WITH_VALUE.has(base)) i += 1;
        continue;
      }
      for (const ch of bare.slice(1)) {
        if (!PUSH_SHORT_OPTS_KNOWN.has(ch)) unknown.push(`-${ch}`);
      }
      if (eq === -1 && bare.includes("o")) i += 1;
    }
  }
  return unknown;
}
// The destination this push writes to: a remote NAME, a URL, or null when the
// command names none (git then resolves its own default — see the guard).
export function pushDestinationToken(cmd) {
  const args = String(cmd || "").match(GIT_PUSH_RE)?.[1] || "";
  const tokens = splitShellArgs(args);
  // `--repo=<url>` names a destination, but git-push documents that "if both are
  // specified, the command-line argument takes precedence" — and git 2.54 really
  // does behave that way (verified 2026-07-30: `git push --repo=<dest> HEAD:main`
  // reports "set the remote as upstream ... HEAD:main", i.e. the POSITIONAL was
  // read as the repository). Returning `--repo` eagerly therefore reported the
  // wrong destination for `git push --repo=<harmless> <CRX Manager URL> HEAD:main`
  // — the guard would classify the push as unguarded while git sent it to
  // production. Remember `--repo` but keep scanning, and let a positional win.
  let repoOpt = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") return tokens[i + 1] ?? repoOpt;
    if (!token.startsWith("-")) return token;
    const eq = token.indexOf("=");
    const bare = eq === -1 ? token : token.slice(0, eq);
    if (bare === "--repo") {
      const value = eq === -1 ? tokens[i + 1] : token.slice(eq + 1);
      if (repoOpt === null && value) repoOpt = value;
      if (eq === -1) i += 1;
      continue;
    }
    if (eq === -1 && PUSH_OPTS_WITH_VALUE.has(bare)) i += 1;
    // A bundled short form (`-uo ci.skip`) hides the value-taking `-o` inside a
    // longer token, so the bundle consumes the next argv token too.
    else if (eq === -1 && !bare.startsWith("--") && bare.includes("o")) i += 1;
  }
  return repoOpt;
}

// Git treats a destination as a URL/path unless it is a bare remote name, and a
// remote name can contain neither `:` nor a path separator.
export function destinationLooksLikeUrl(token) {
  const text = String(token ?? "");
  if (text.length === 0) return false;
  return text.includes(":") || text.includes("/") || text.includes("\\");
}

// Inline configuration overrides the guard cannot see. Codex's second 2026-07-30
// review found this bypass: the destination is resolved with SEPARATE `git`
// calls, which do not inherit `-c` values from the push command, so
//   git -c remote.origin.pushurl=<CRX Manager URL> push origin HEAD:main
// sends the push to production while every lookup the guard makes still
// describes the checkout's ordinary, unrelated remote. Rather than trying to
// replay arbitrary overrides (`-c` can rewrite pushurl, url.*.pushInsteadOf,
// remote.pushDefault, and more), deny the form outright: `git -C <repo> push`
// is inspectable and is the only form this repo's workflows use.
//
// `-C` (directory) and `-c` (config) differ only in case, so this must stay
// case-SENSITIVE — matching `-C` here would deny every legitimate push.
export function pushUsesInlineConfig(cmd) {
  const text = String(cmd || "");
  if (!isGitPush(text)) return false;
  const prefix = text.match(GIT_PUSH_PREFIX_RE)?.[1] || "";
  return /(?:^|\s)(?:-c(?:\s|=)|--config-env(?:\s|=))/.test(prefix);
}

// Environment-variable configuration is the same bypass as `-c`, wearing a
// different hat. Codex's third 2026-07-30 review found it and a live test
// confirmed it (2026-07-30): with `origin` configured to point at nowhere.git,
//   GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.pushurl \
//   GIT_CONFIG_VALUE_0=<other repo> git -C <repo> push origin <branch>
// pushed to the OTHER repo — "* [new branch] feature -> probe" — while every
// lookup this guard makes still reported the configured `origin`. The variables
// live in the command string, not in the hook's own environment, so the guard
// cannot see them by inspecting its own config. Deny the form.
//
// Only GIT_CONFIG* is denied. Transport variables (GIT_SSH_COMMAND and friends)
// change HOW a connection is made, not WHICH repository is written, and the
// documented keepalive push workaround for this repo sets GIT_SSH_COMMAND —
// denying it would break the normal push path to close nothing.
// Four review rounds tried to describe the SYNTAX of setting one of these
// variables, and each description had a hole:
//   round 3 — the variables existed at all (`GIT_CONFIG_KEY_0=… git push`)
//   round 4 — quoting  (`env 'GIT_CONFIG_COUNT=1' git push`)
//   round 5 — the variable NAME list  (`GIT_CONFIG_PARAMETERS` was not on it)
//   round 6 — the assignment SYNTAX  (`Set-Item Env:GIT_CONFIG_COUNT 1`,
//             `${env:GIT_CONFIG_COUNT} = '1'`, `New-Item -Path Env:… -Value …`,
//             and `[Environment]::SetEnvironmentVariable('GIT_CONFIG_COUNT','1')`,
//             which the round-6 review did not even name — all verified `false`
//             against the previous detector on 2026-07-30)
// A shell has unbounded ways to spell "set a variable", so matching spellings is
// the wrong shape. The rule is now about the NAMESPACE, not the syntax: if a
// push command mentions `GIT_CONFIG` as its own identifier ANYWHERE, deny it.
// There is no legitimate reason for a push command in this repo to name that
// namespace at all, and the failure directions are not symmetric — a false deny
// costs one clear error message, a false allow writes to production unreviewed.
export function pushUsesConfigEnv(cmd) {
  const text = String(cmd || "");
  if (!isGitPush(text)) return false;
  // `(?<![A-Za-z0-9_])` keeps an unrelated `MY_GIT_CONFIG_COUNT` allowed: the
  // token has to start on its own, not in the middle of a longer identifier.
  // The trailing group swallows the rest of the variable name so the check does
  // not care which one it is.
  return /(?<![A-Za-z0-9_])GIT_CONFIG(?:_[A-Za-z0-9_]*)?(?![A-Za-z0-9])/i.test(text);
}

// The other half of the same bypass: a variable that was set by an EARLIER,
// separate command and is still live when the push runs. The push command text
// is then completely innocent, so `pushUsesConfigEnv` above cannot see it — but
// the hook inherits the same environment the push will inherit, so it can just
// look. Codex's sixth 2026-07-30 review asked for this after noting that
// `Set-Item Env:GIT_CONFIG_COUNT 1` on its own line is not a push command.
//
// Fails CLOSED by design: if any `GIT_CONFIG*` variable is set, the guard cannot
// trust its own destination lookups (it strips them to read the real config) AND
// the push would carry them, so the two disagree by construction.
export function environmentCarriesConfigOverride(env) {
  return Object.keys(env || {}).filter((key) => /^GIT_CONFIG(_|$)/i.test(key));
}

// `GIT_CONFIG*` names a config FILE. These name the DIRECTORY git looks in for
// the global config, which reaches the same place by a longer road: point HOME
// at a directory holding a `.gitconfig` with `url.<CRX Manager URL>.pushInsteadOf`
// and an ordinary-looking `git push origin main` lands in production.
//
// Verified against git 2.54 on 2026-07-30, in a scratch repo whose only remote
// was a harmless local path: with HOME overridden, `git config --get-regexp
// '^url\..*insteadof$'` returned NOTHING in the guard's environment and the
// rewrite in the push's environment, and the objects arrived in the rewritten
// destination. Codex's seventh 2026-07-30 review found this.
//
// Note the asymmetry that decides the shape of the fix: this only works when the
// override reaches the PUSH but not the GUARD, i.e. when it is written into the
// command itself. A variable set by an earlier, separate command is inherited by
// both, so the guard reads the very config the push will use and classifies the
// destination correctly — which is why this half needs no environment check, and
// why `environmentCarriesConfigOverride` above stays scoped to `GIT_CONFIG*`.
const CONFIG_ROOT_ENV_RE =
  /(?<![A-Za-z0-9_])(?:HOME|HOMEDRIVE|HOMEPATH|USERPROFILE|XDG_CONFIG_HOME|GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_CEILING_DIRECTORIES|GIT_DISCOVERY_ACROSS_FILESYSTEM)(?![A-Za-z0-9])/i;
export function pushUsesConfigRootEnv(cmd) {
  const text = String(cmd || "");
  if (!isGitPush(text)) return false;
  return CONFIG_ROOT_ENV_RE.test(text);
}

// The general net behind both of the specific rules above. A push command that
// sets ANY environment variable inline is uninspectable on principle: the guard
// resolves the destination in ITS environment, the push runs in a different one,
// and no amount of naming individual variables closes a gap that is really about
// the two environments differing at all. So the rule is inverted here — an
// allowlist, not a denylist.
//
// The allowlist is by NAME **and VALUE**. An earlier version admitted any
// `GIT_SSH_COMMAND`, on the reasoning that it selects a transport rather than a
// destination — which is wrong, and Codex's ninth 2026-07-30 review said so:
// GIT_SSH_COMMAND is an arbitrary command line that git executes, free to ignore
// the destination git hands it and run `git-receive-pack` against production
// while the guard reads only the innocent-looking nominal destination. So the
// sanctioned keepalive workaround is admitted in its exact documented shape and
// nothing else; every other value is reported and denied.
const INLINE_ENV_ALLOWED = new Map([
  // `ssh` plus keepalive/batch options only — no shell, no command, no host.
  ["GIT_SSH_COMMAND", /^ssh(?:\s+-o\s+(?:ServerAliveInterval=\d{1,4}|ServerAliveCountMax=\d{1,3}|BatchMode=(?:yes|no)))*$/],
  ["GIT_TERMINAL_PROMPT", /^[01]$/],
]);
// Splitting a command on `&&`/`||`/`;` with a plain regex splits INSIDE quotes
// too, and that silently disarmed the value check above: the separator in
// `GIT_SSH_COMMAND="ssh -o ServerAliveInterval=20 && curl evil" git push …` is
// part of the value, but a naive split made the assignment look like it belonged
// to an earlier command and the push looked clean. Track quote state instead.
//
// Quote tracking alone is still not the shell. `echo "a\"b" && git push origin
// HEAD:main` closes its quote at the FINAL `"`, because `\"` is an escaped quote
// and not a delimiter — a tracker blind to escapes reopens the quote there and
// swallows every following separator, so the whole line reads as one segment and
// the main-bound push at the end is never classified. Codex's tenth 2026-07-30
// review demonstrated exactly that. A backslash therefore escapes the next
// character everywhere EXCEPT inside single quotes, where bash treats it
// literally. `.claude/hooks/codex-push-guard.mjs` additionally refuses any
// segment that still contains more than one push, so a future gap in this parser
// fails closed instead of silently skipping a push.
export function shellSegments(cmd) {
  const text = String(cmd ?? "");
  const segments = [];
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\" && quote !== "'" && i + 1 < text.length) { i += 1; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === ";" || ch === "\n" || ch === "\r") {
      segments.push(text.slice(start, i));
      start = i + 1;
      continue;
    }
    if (ch === "&" || ch === "|") {
      segments.push(text.slice(start, i));
      let end = i;
      while (end < text.length && (text[end] === "&" || text[end] === "|")) end += 1;
      start = end;
      i = end - 1;
    }
  }
  segments.push(text.slice(start));
  return segments;
}

// `NAME=value`, `NAME="value with spaces"`, and `'NAME=value'` are all one token
// by the time this sees it. Returns null when the token is not an assignment.
function inlineAssignment(token) {
  let text = String(token ?? "");
  const outer = /^(['"])([\s\S]*)\1$/.exec(text);
  if (outer) text = outer[2];
  const split = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(text);
  if (!split) return null;
  let value = split[2];
  const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
  if (quoted) value = quoted[2];
  return { name: split[1], value: value.trim() };
}
export function pushSetsInlineEnv(cmd) {
  const text = String(cmd || "");
  const names = [];
  for (const push of eachPush(text)) {
    // Assignments sit BEFORE the git binary, which is outside what
    // GIT_PUSH_PREFIX_RE captures (that starts after it). Take the text up to the
    // binary, trimmed to the current segment so an earlier chained command's
    // arguments are not misread as this push's prefix.
    const prefix = shellSegments(text.slice(0, push.index)).pop() || "";
    // splitShellArgs is not usable here: it only treats a quote as grouping when
    // the token STARTS with one, so `GIT_SSH_COMMAND="ssh -o Foo=1"` came apart at
    // the space and the fragment `Foo=1"` read as a second assignment. A token is
    // really a run of unquoted characters and quoted spans, in any order.
    for (const token of prefix.match(/(?:[^\s'"]|'[^']*'|"[^"]*")+/g) || []) {
      const assignment = inlineAssignment(token);
      if (!assignment) continue;
      const shape = INLINE_ENV_ALLOWED.get(assignment.name.toUpperCase());
      if (!shape || !shape.test(assignment.value)) names.push(assignment.name);
    }
  }
  return names;
}

// The asymmetry argument above — "a variable set by an earlier command is
// inherited by BOTH, so the guard reads what the push will read" — is true of
// variables that select CONFIGURATION, and false of variables that select an
// EXECUTABLE. GIT_SSH_COMMAND does not change one byte of what this guard
// resolves; it changes what the push actually runs, and it can run
// `git-receive-pack` against production no matter which destination git hands it.
// So `export GIT_SSH_COMMAND="…"; git push origin HEAD:main` was clean by every
// detector here while being a production push (Codex's twelfth 2026-07-30 review,
// confirmed by its own read-only probe). These names are therefore checked across
// the WHOLE command, not just the push's own prefix, and by VALUE — the sanctioned
// keepalive shape keeps working wherever it is written, everything else is named
// and denied.
const TRANSPORT_ENV_NAMES = [
  "GIT_SSH_COMMAND", "GIT_SSH", "GIT_SSH_VARIANT", "GIT_PROXY_COMMAND",
  "GIT_ASKPASS", "SSH_ASKPASS", "GIT_EXEC_PATH", "GIT_CREDENTIAL_HELPER",
  "GIT_ALLOW_PROTOCOL", "GIT_PROTOCOL_FROM_USER", "GIT_TERMINAL_PROMPT",
];
const TRANSPORT_ENV_RE = new RegExp(
  `(?<![A-Za-z0-9_])(${TRANSPORT_ENV_NAMES.join("|")})(?![A-Za-z0-9_])`, "gi",
);
function transportValueIsAllowed(name, rawValue) {
  const shape = INLINE_ENV_ALLOWED.get(String(name).toUpperCase());
  if (!shape) return false;
  let value = String(rawValue ?? "");
  const quoted = /^(['"])([\s\S]*)\1$/.exec(value.trim());
  return shape.test(quoted ? quoted[2].trim() : value.trim());
}
export function pushUsesTransportEnv(cmd) {
  const text = String(cmd || "");
  if (!isGitPush(text)) return [];
  const offenders = new Set();
  for (const match of text.matchAll(TRANSPORT_ENV_RE)) {
    // `NAME=value`, `export NAME=value`, and PowerShell's `$env:NAME = "value"`
    // all leave `=` next. Anything else that merely NAMES one of these (`echo
    // $GIT_SSH_COMMAND`, a value built up elsewhere) is unverifiable, so it is
    // reported too — fail closed, as everywhere else in this guard.
    const assign = /^\s*=\s*("[^"]*"|'[^']*'|[^\s;&|]*)/.exec(text.slice(match.index + match[1].length));
    if (!assign || !transportValueIsAllowed(match[1], assign[1])) offenders.add(match[1]);
  }
  return [...offenders];
}
// And the same names arriving from the shell the push will inherit. Unlike
// GIT_CONFIG*, an inherited transport variable is NOT neutralised by the guard
// reading the same environment, for exactly the reason above.
// Matched against the whole name, not searched for inside it — and NOT with the
// /g/ pattern above, whose lastIndex advances on every `.test()` and would skip
// every second variable.
//
// GIT_EXEC_PATH is excluded HERE and only here. Git exports it into the
// environment of every hook it runs, so an ordinary push from a session that
// started under a git hook inherits it from git itself — its presence carries no
// signal at all, and treating it as one denied every ordinary feature-branch
// push (caught by the tracked guard suite before this shipped). Written into a
// command it is still a deliberate act, so `pushUsesTransportEnv` keeps checking
// it. The residual risk is stated rather than hidden: a GIT_EXEC_PATH planted in
// an earlier segment is indistinguishable from git's own export, so this rule
// cannot see it.
const INHERITED_TRANSPORT_ENV_NAME_SET = new Set(
  TRANSPORT_ENV_NAMES.filter((name) => name !== "GIT_EXEC_PATH"),
);
export function environmentCarriesTransportOverride(env) {
  return Object.keys(env || {}).filter(
    (key) => INHERITED_TRANSPORT_ENV_NAME_SET.has(key.toUpperCase()) && !transportValueIsAllowed(key, env[key]),
  );
}

// URL rewrites are the other way inline-free config can redirect a push:
//   url.<CRX Manager URL>.pushInsteadOf = crx:
// turns an innocuous-looking `git push crx: main` into a production push, and
// the destination token alone ("crx:") classifies as unguarded. Accepts
// `git config --get-regexp '^url\..*insteadof$'` output. Any rewrite whose BASE
// is the app repo makes this checkout capable of reaching production under an
// alias, so the gate applies. Fails CLOSED on unparseable input.
export function rewritesReachGuardedApp(configOutput) {
  const lines = String(configOutput ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.some((line) => {
    // `url.<base>.insteadof <alias>` — the base is everything between the
    // leading `url.` and the trailing `.insteadof`/`.pushinsteadof` key part.
    const key = line.split(/\s+/)[0] || "";
    const match = key.match(/^url\.(.+)\.(?:push)?insteadof$/i);
    if (!match) return true; // fail CLOSED: a line we cannot parse gates the push
    return urlIsGuardedApp(match[1].replace(/\/+$/, ""));
  });
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

// Same bug, deliberately stricter answer, for the LIVE-APPLY gate (2026-07-29).
//
// `proofSearchDirs` above scans EVERY sibling checkout. For the merge gate that
// is acceptable: its proof is bound to the exact head and base SHAs GitHub
// reports, so a sibling's proof can only ever authorize the identical merge.
// The migration-apply proof is weaker — interactively `queryHash` is checked
// only when present, and migration names match by substring — so "any sibling
// checkout" would let a proof minted by a DIFFERENT concurrent session unlock a
// live apply this session never reviewed. Mason runs dozens of worktrees at
// once, and the settled rule is proof from THIS session (DECISION_LOG 2026-07-13).
//
// So: search this session's OWN checkout and the primary one, and nothing else.
// `hookCwd` is the working directory the harness reports for the tool call —
// the same field codex-push-guard.mjs and pr-merge-guard.mjs already trust — and
// it is honoured ONLY after `git worktree list` confirms it belongs to this
// repository. An unrecognised cwd falls back to the primary directory alone,
// which is the pre-2026-07-29 behaviour: strictly safe, never laxer.
//
// `listWorktrees` is injected so this is testable without a real repo.
export function sessionProofDirs(root, hookCwd, listWorktrees) {
  const stateDir = (dir) => path.resolve(dir, ".claude", "session-state");
  const dirs = [stateDir(root)];
  const cwd = String(hookCwd || "").trim();
  if (!cwd) return dirs;
  let porcelain;
  try {
    porcelain = listWorktrees();
  } catch {
    return dirs;
  }
  // Windows paths differ in case between `git worktree list` and process.cwd(),
  // so compare on a normalised key; keep the ORIGINAL path for the return value.
  const key = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  const cwdKey = key(cwd);
  const contains = (parent, child) => child === parent || child.startsWith(parent + path.sep);
  // Worktrees nest in this repo (C:/CRX_Manager/.claude/worktrees/*), and the
  // primary checkout is listed FIRST — so "first match wins" would resolve a
  // nested worktree's cwd to the primary and reintroduce the original bug. Take
  // the LONGEST containing path: the most specific checkout is the real one.
  let best = null;
  for (const line of String(porcelain ?? "").split(/\r?\n/)) {
    const match = /^worktree\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const wt = path.resolve(match[1]);
    if (contains(key(wt), cwdKey) && (!best || wt.length > best.length)) best = wt;
  }
  if (best) dirs.push(stateDir(best));
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
