#!/usr/bin/env node

// Shared rule book for the guarded-surface lock.
//
// WHY THIS EXISTS
// ---------------
// Live `execute_sql`, live `apply_migration`, and pushes are auto-allowed in the
// permission manifest. Their ONLY protection is the PreToolUse hooks. So the
// hooks — and the files that decide whether the hooks run at all — are the real
// security boundary, and an approval PROMPT on them is the wrong instrument:
// a prompt is a thing Mason clicks through at 11pm, and removing the prompt (as
// PR #530's first commit did) opens a two-step silent path — rewrite a guard,
// then run the operation that guard used to gate.
//
// So these files are LOCKED, not prompted. An edit is denied outright unless
// Mason has unlocked the surface from a real terminal (see scripts/guard-unlock.mjs,
// which requires a TTY and a typed phrase — an agent's non-interactive shell
// cannot satisfy either). That lets every OTHER file be edited with no prompt at
// all, which is the actual goal: fewer prompts, a harder boundary.
//
// DESIGN NOTE — why this is not modelled on review-proof-guard's "deny every
// mention". That guard can deny reads too, because nothing legitimately reads a
// proof file through the shell. Here, agents must keep READING hooks and
// settings constantly (routine work does this). So this rule book has to
// distinguish read from write inside a shell command, and it fails CLOSED: a
// command touching a guarded path is denied unless its shape is on the
// known-read-only allowlist. An unrecognized command is a denied command.

// ---------------------------------------------------------------------------
// What is guarded
// ---------------------------------------------------------------------------
// Every entry answers one question: "if an agent rewrote this file, could it
// stop a guard from running, or change what a guard concludes?" Prose contracts
// (AGENTS.md, CLAUDE.md) deliberately are NOT here — they advise, they do not
// enforce, and locking them would buy nothing while costing real edits.
export const GUARDED_SURFACE_RES = [
  // The guards themselves, and their Codex adapters.
  /(?:^|\/)\.claude\/hooks\/./,
  /(?:^|\/)\.codex\/hooks\/./,
  /(?:^|\/)\.codex\/hooks\.json$/,
  // Hook REGISTRATION and the permission manifests. Unregistering a hook is
  // equivalent to deleting it.
  /(?:^|\/)\.claude\/settings\.json$/,
  /(?:^|\/)\.claude\/settings\.local\.json$/,
  /(?:^|\/)\.codex\/config\.toml$/,
  // Git-level enforcement: husky runs the pre-commit/pre-push gates.
  /(?:^|\/)\.husky\/./,
  // CI enforcement and the review gate's configuration.
  /(?:^|\/)\.github\/workflows\/./,
  /(?:^|\/)\.coderabbit\.ya?ml$/,
  // package.json defines the `typecheck`/`build`/test scripts the husky hooks
  // invoke; redefining one to `exit 0` neuters the pre-push gate without
  // touching a hook file. The lockfile rides along because a swapped dependency
  // is another way to change what those scripts do.
  /(?:^|\/)package\.json$/,
  /(?:^|\/)package-lock\.json$/,
  // Validators the gates call.
  /(?:^|\/)scripts\/(?:check|validate|verify)-[^/]*$/,
  // Proof generation, ledger surgery, and the review runners: these MINT or
  // REMOVE the evidence other gates trust.
  /(?:^|\/)scripts\/write-codex-push-proof\.mjs$/,
  /(?:^|\/)scripts\/remove-applied-ledger-entry\.mjs$/,
  /(?:^|\/)scripts\/run-claude-review\.mjs$/,
  /(?:^|\/)scripts\/agent-manifest-parity\.mjs$/,
  /(?:^|\/)scripts\/sync-agent-workflows\.mjs$/,
  // Self-protection: the lock's own unlock switch. Without this line an agent
  // rewrites guard-unlock.mjs to always return "unlocked" and the whole
  // mechanism is decorative.
  /(?:^|\/)scripts\/guard-unlock\.mjs$/,
];

// Bare names that must be recognized even when a glob hides the rest of the
// path (`.clau*/hooks/x`, `.hus*/pre-push`). Mirrors the proven approach in
// review-proof-guard.mjs.
const GUARDED_GLOB_TARGETS = [".claude", ".codex", ".husky", ".github", "hooks", "workflows", "package.json", "package-lock.json"];

export function normalizePath(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
}

/** True when a literal path points at a guarded enforcement surface. */
export function guardedSurfacePath(candidate) {
  if (candidate == null) return false;
  const norm = normalizePath(candidate);
  if (!norm) return false;
  return GUARDED_SURFACE_RES.some((re) => re.test(norm));
}

/**
 * True when a path targets a guarded DIRECTORY itself rather than a file inside
 * it. `rm -rf .claude/hooks` and `move_file source=".husky"` destroy every guard
 * at once while never naming a guarded FILE, so the file matcher above misses
 * them (this is the exact bypass class review-proof-guard documents for its own
 * state directory).
 */
export function guardedSurfaceDirectory(candidate) {
  const norm = normalizePath(candidate).toLowerCase();
  if (!norm) return false;
  return [
    ".claude/hooks", ".codex/hooks", ".husky", ".github/workflows", ".github", ".claude", ".codex",
  ].some((dir) => norm === dir || norm.endsWith(`/${dir}`));
}

// A glob segment whose leading literal run could still expand to a guarded name.
// A too-generic lead (`*`, `s*`) is ignored so ordinary deletes are not blocked.
function globSegCouldTargetGuarded(seg) {
  if (!/[*?[\]{}]/.test(seg)) return false;
  const lead = (seg.match(/^[^*?[\]{}]*/)[0] || "").toLowerCase();
  const minLead = lead.startsWith(".") ? 2 : 3;
  if (lead.length < minLead) return false;
  return GUARDED_GLOB_TARGETS.some((name) => name.startsWith(lead));
}

/**
 * Shell-normalized views of a command. The shell resolves ANSI-C escapes, drops
 * unquoted backslashes, and joins quote-split tokens before executing, so
 * `.clau"de"/hooks/x` and `.clau\de/hooks/x` RUN as the real path while a
 * raw-string scan misses them. Return every view; the caller fails closed if ANY
 * matches. The raw view still covers Windows `\` separators.
 */
export function shellCommandViews(cmd) {
  const base = decodeAnsiCQuotes(String(cmd || "")).replace(/[\\`]\r?\n/g, "");
  const stripQuotes = (v) => v.replace(/["']/g, "");
  const dropBackslash = (v) => v.replace(/\\(.)/g, "$1");
  return [base, stripQuotes(base), dropBackslash(base), dropBackslash(stripQuotes(base))];
}

export function decodeAnsiCQuotes(text) {
  return String(text ?? "").replace(/\$'((?:\\.|[^'\\])*)'/g, (_, body) =>
    body.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_esc, code) => {
      if (/^x/i.test(code)) return String.fromCharCode(parseInt(code.slice(1), 16));
      if (/^[0-7]/.test(code)) return String.fromCharCode(parseInt(code, 8));
      const map = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", f: "\f", v: "\v" };
      return map[code] ?? code;
    }));
}

/** Does this command text reference a guarded surface at all (any view)? */
export function commandMentionsGuardedSurface(cmd) {
  return shellCommandViews(cmd).some((view) => {
    const norm = view.replace(/\\/g, "/");
    if (GUARDED_SURFACE_RES.some((re) => re.test(norm))) return true;
    // Segment/glob pass: catches `.clau*/hooks/x` and a bare guarded directory.
    const segs = norm.split(/[\s"'=:;&|(){}<>]+/).filter(Boolean);
    return segs.some((s) => guardedSurfacePath(s) || guardedSurfaceDirectory(s) || globSegCouldTargetGuarded(s));
  });
}

// ---------------------------------------------------------------------------
// Read vs write, inside a shell command
// ---------------------------------------------------------------------------
// Fail-closed allowlist. A command head NOT listed here is treated as a writer
// whenever it touches a guarded path — so `tee`, `cp`, `mv`, `rm`, `install`,
// `truncate`, `dd`, `patch`, `perl -i`, `python`, and anything invented later
// are all denied without needing to be enumerated. Enumerating writers would be
// a blocklist, and a blocklist reopens every time someone learns a new verb.
const READ_ONLY_HEADS = new Set([
  "cat", "head", "tail", "less", "more", "bat", "nl", "od", "xxd", "strings",
  "grep", "egrep", "fgrep", "rg", "ag", "ack",
  "wc", "ls", "dir", "stat", "file", "du", "tree", "realpath", "readlink", "basename", "dirname",
  "diff", "cmp", "comm", "sort", "uniq", "cut", "tr", "jq", "yq", "column",
  "md5sum", "sha1sum", "sha256sum", "cksum",
  "which", "type", "command", "pwd", "test", "true", "false", "echo", "printf", "date",
  // Runners: they EXECUTE a script rather than editing it. Their arguments are
  // still scanned, so `node -e "fs.writeFileSync('.claude/hooks/x', …)"` is
  // caught by the redirect/mention checks below (and by the maintenance guard).
  "node", "npm", "npx", "pnpm", "yarn",
  "gh", "git", "sed", "awk", "find", "xargs",
]);

// Git subcommands that cannot rewrite working-tree content. Fail closed:
// anything not listed (checkout, restore, apply, rm, mv, clean, reset, stash,
// revert, cherry-pick, rebase, am, …) counts as a writer. This closes the
// documented "git subcommands bypass destination guards" gap.
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "diff", "show", "log", "status", "ls-files", "ls-tree", "cat-file", "blame", "grep",
  "rev-parse", "rev-list", "merge-base", "cherry", "describe", "shortlog", "name-rev",
  "remote", "branch", "tag", "fetch", "ls-remote", "reflog", "check-ignore", "var",
  "config", "help", "version", "count-objects", "verify-commit", "symbolic-ref",
  // Staging and committing do not alter file CONTENT; they record it. A guarded
  // file can only reach the index if an unlocked edit already produced it.
  "add", "commit", "push", "worktree",
]);

// npm/pnpm/yarn subcommands that rewrite package.json or the lockfile WITHOUT
// ever naming them, so the path-mention scan cannot see them. `ci` is absent
// from this list on purpose: it installs from the existing lockfile and is
// needed routinely (a fresh worktree cannot run its own tests without it).
const PACKAGE_MUTATING_SUBCOMMANDS = new Set([
  "install", "i", "add", "remove", "rm", "uninstall", "un", "update", "up", "upgrade",
  "dedupe", "prune", "link", "pkg", "audit",
]);

function firstWord(text) {
  const m = String(text ?? "").trim().match(/^([\w.\/-]+)/);
  return m ? m[1].replace(/^.*\//, "").toLowerCase() : "";
}

/** Split a command into segments on shell separators, so each is judged alone. */
export function shellSegments(cmd) {
  return String(cmd ?? "")
    .split(/(?:\|\||&&|[;\n|])+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A redirect (`>`/`>>`) whose target is guarded overwrites a guard. */
export function redirectTargetsGuardedSurface(cmd) {
  return shellCommandViews(cmd).some((view) => {
    const norm = view.replace(/\\/g, "/");
    for (const m of norm.matchAll(/>>?\s*("[^"]*"|'[^']*'|[^\s;&|()<>]+)/g)) {
      const target = m[1].replace(/["']/g, "");
      if (guardedSurfacePath(target) || guardedSurfaceDirectory(target)) return true;
      if (globSegCouldTargetGuarded(target)) return true;
    }
    return false;
  });
}

/**
 * Some commands rewrite a guarded file WITHOUT naming it: `npm install left-pad`
 * edits package.json and package-lock.json, and `npm pkg set scripts.typecheck=…`
 * rewrites the very script the pre-push gate runs. The path-mention scan cannot
 * see these, so they are recognized by shape instead.
 */
export function commandImplicitlyMutatesGuarded(cmd) {
  return shellSegments(cmd).some((segment) => {
    const head = firstWord(segment);
    // Patch application carries its destinations INSIDE a file this scan cannot
    // read, so `git apply disable-guards.patch` rewrites a hook while naming no
    // guarded path at all. This is the documented "git subcommands bypass
    // destination guards" class; fail closed on the whole verb.
    if (head === "patch") return true;
    if (head === "git") {
      const gitSub = (segment.match(/\bgit\b(?:\s+-[^\s]+)*\s+([\w-]+)/i) || [])[1];
      if (gitSub && ["apply", "am"].includes(gitSub.toLowerCase())) return true;
    }
    if (!["npm", "pnpm", "yarn", "npx"].includes(head)) return false;
    const sub = (segment.match(/^\s*\S+\s+([\w-]+)/) || [])[1];
    return sub ? PACKAGE_MUTATING_SUBCOMMANDS.has(sub.toLowerCase()) : false;
  });
}

/** Everything that makes a command relevant to this lock. */
export function commandTouchesGuardedSurface(cmd) {
  return commandMentionsGuardedSurface(cmd) || commandImplicitlyMutatesGuarded(cmd);
}

/**
 * Is this single shell segment read-only with respect to guarded files?
 * Conservative by construction — when in doubt, it is not.
 */
export function segmentIsReadOnly(segment) {
  if (commandImplicitlyMutatesGuarded(segment)) return false;
  const head = firstWord(segment);
  if (!head) return false;
  if (!READ_ONLY_HEADS.has(head)) return false;

  // In-place editors masquerade as read-only heads.
  if ((head === "sed" || head === "awk" || head === "perl") && /(?:^|\s)-[a-z]*i/i.test(segment)) return false;
  // find that mutates.
  if (head === "find" && /(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fprint|fls)\b/i.test(segment)) return false;
  // xargs is only as safe as what it runs.
  if (head === "xargs") return false;
  // NOT "any redirect is a write". `redirectTargetsGuardedSurface` already
  // checks redirect TARGETS precisely and runs first in shellCommandIsReadOnly,
  // so a blanket `/>>?/` test here adds nothing and wrongly denies the stderr
  // redirects that appear in almost every real command — `grep … 2>/dev/null`,
  // `node … 2>&1`, `git diff .claude/settings.json > /tmp/out.diff`. That bug
  // blocked two legitimate read-only diagnostics during this guard's own build.
  // Verified before removal: the precise check alone still catches every
  // write-into-a-guarded-path case (`> .claude/hooks/x`, `>> .husky/pre-push`,
  // `> package.json`, and a globbed basename), and `sed -i … 2>/dev/null` still
  // denies via the in-place-editor test above.

  if (head === "git") {
    const sub = (segment.match(/\bgit\b(?:\s+-[^\s]+)*\s+([\w-]+)/i) || [])[1];
    if (!sub) return false;
    if (!READ_ONLY_GIT_SUBCOMMANDS.has(sub.toLowerCase())) return false;
  }
  return true;
}

/** True when EVERY segment touching a guarded path is read-only. */
export function shellCommandIsReadOnly(cmd) {
  if (redirectTargetsGuardedSurface(cmd)) return false;
  const segments = shellSegments(cmd);
  if (segments.length === 0) return false;
  for (const segment of segments) {
    if (!commandTouchesGuardedSurface(segment)) continue;
    if (!segmentIsReadOnly(segment)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The unlock
// ---------------------------------------------------------------------------
export const UNLOCK_PHRASE = "unlock the guards";

/**
 * A valid unlock is a fresh, well-formed record produced by scripts/guard-unlock.mjs.
 * Anything malformed, expired, or future-dated fails closed.
 */
export function unlockValid(data, nowMs) {
  if (!data || typeof data !== "object") return false;
  if (data.kind !== "guarded-surface-unlock") return false;
  const expires = Date.parse(data.expiresAt ?? "");
  const issued = Date.parse(data.issuedAt ?? "");
  if (!Number.isFinite(expires) || !Number.isFinite(issued)) return false;
  if (issued > nowMs + 60_000) return false;      // clock-forged future issue
  if (expires <= nowMs) return false;             // expired
  if (expires - issued > 4 * 60 * 60 * 1000) return false; // absurd window
  return true;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------
/**
 * @param {object} args
 * @param {string} args.toolName
 * @param {object} args.input          tool_input from the hook payload
 * @param {object|null} args.unlock    parsed unlock record, or null
 * @param {number} args.nowMs
 * @param {(text:string)=>string[]} [args.extractPatchDestinations]
 * @returns {{decision:"allow"|"block", reason?:string}}
 */
export function evaluateGuardedSurface({ toolName, input = {}, unlock = null, nowMs = 0, extractPatchDestinations }) {
  const allow = { decision: "allow" };
  const unlocked = unlockValid(unlock, nowMs);

  const pathCandidates = [
    input.file_path, input.filePath, input.path, input.target,
    input.source, input.destination, input.notebook_path,
    ...(extractPatchDestinations
      ? [input.patch, input.diff, input.input, input.changes].flatMap((t) => extractPatchDestinations(t) || [])
      : []),
  ];

  const hitPath = pathCandidates.find((c) => guardedSurfacePath(c) || guardedSurfaceDirectory(c));
  if (hitPath != null) {
    if (unlocked) return allow;
    return { decision: "block", reason: lockedReason(String(hitPath)) };
  }

  const command = input.command ?? input.cmd ?? null;
  if (command != null) {
    if (!commandTouchesGuardedSurface(command)) return allow;
    if (shellCommandIsReadOnly(command)) return allow;   // reading a guard is always fine
    if (unlocked) return allow;
    return { decision: "block", reason: lockedReason("a guarded enforcement file") };
  }

  return allow;
}

export function lockedReason(what) {
  return [
    `GUARDED SURFACE LOCK: ${what} is an enforcement file — it decides whether the safety guards run.`,
    "It is LOCKED, not prompt-gated, because live SQL, live migrations, and pushes are auto-allowed:",
    "weakening a guard first would let the next call through silently.",
    "",
    "Reading these files is always allowed. To CHANGE one, Mason unlocks it himself from a real terminal:",
    "    node scripts/guard-unlock.mjs --minutes 30",
    "That command requires an interactive terminal and a typed phrase, so an agent shell cannot run it.",
  ].join("\n");
}
