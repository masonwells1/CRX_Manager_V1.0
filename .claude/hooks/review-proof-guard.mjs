#!/usr/bin/env node

// Review proof files are outputs of the real Claude/Codex CLI wrappers. Direct
// tool or shell access would let an agent self-certify the gate, so deny it for
// both agents. The wrappers write internally and never name the proof path in
// their tool command, so legitimate proof creation still works.

import { readFileSync } from "node:fs";

import {
  extractPatchDestinations,
  reviewProofPathMentioned,
  reviewStateDirectoryMentioned,
} from "./codex-push-lib.mjs";

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

const input = payload?.tool_input || payload?.toolInput || {};
const toolName = String(payload?.tool_name || payload?.toolName || "");
const hookCwd = String(payload?.cwd || input.cwd || input.workdir || "");
const pathCandidates = [
  input.file_path,
  input.filePath,
  input.path,
  input.target,
  input.source,
  input.destination,
  // Patch-style tools (Codex apply_patch) carry the DESTINATION inside a
  // free-form payload rather than a path field (Codex round-4). Scan only the
  // patch's destination headers, NOT its whole body — added prose may
  // legitimately mention proof paths in documentation (Codex round-5). Write's
  // `content` is likewise deliberately not scanned; its target is file_path.
  ...[input.patch, input.diff, input.input, input.changes].flatMap((payloadText) => extractPatchDestinations(payloadText)),
];
if (pathCandidates.some((candidate) => reviewProofPathMentioned(candidate))) {
  deny("REVIEW PROOF GUARD: Claude/Codex review proof files are wrapper-owned. Run the real review workflow; do not write, edit, move, or delete proof JSON directly.");
}

const command = String(input.command ?? input.cmd ?? "");
// The shell resolves ANSI-C escapes, drops unquoted backslashes, and joins
// quote-split tokens before running a command, so `applied-source"-"ledger.json`
// or `.clau\de` EXECUTES as the real path/verb while a raw-string regex misses
// it. Return every normalized view and fail closed if ANY matches; the raw
// (base) view still covers Windows `\`-separated paths, where the backslash is a
// real separator (Opus review 2026-08-19, round 4 — both a proof-path forge,
// `printf "[]" > .claude/session-state/applied-source"-"ledger.json`, and a
// composed-verb deletion, `r"m" -rf .claude/session-state`, were proven bypasses
// of the raw-only scans; the cd scanner already ran over a quote-stripped view,
// these matchers did not).
function shellCommandViews(cmd) {
  const base = decodeAnsiCQuotes(String(cmd || "")).replace(/[\\`]\r?\n/g, "");
  const stripQuotes = (v) => v.replace(/["']/g, "");
  const dropBackslash = (v) => v.replace(/\\(.)/g, "$1");
  return [base, stripQuotes(base), dropBackslash(base), dropBackslash(stripQuotes(base))];
}
// Applies ONLY to the shell `command` string (shell syntax). The pathCandidates
// and hookCwd predicates above/below are literal filesystem paths, NOT shell
// syntax — quote-stripping them would be wrong, so they stay raw.
if (shellCommandViews(command).some((v) => reviewProofPathMentioned(v))) {
  deny("REVIEW PROOF GUARD: direct shell access to Claude/Codex review proof JSON is blocked. Run the real review wrapper instead.");
}

// Claude's Bash cwd persists across calls. Deny entering the wrapper-owned
// state directory, and fail closed on shell activity already running there, so
// a two-call `cd` + bare-filename write cannot evade the path matcher.
//
// 2026-08-18: check the ACTUAL cd/pushd/Set-Location target, not "a cd token
// exists anywhere AND the state dir is mentioned anywhere". The old conjunction
// denied legitimate commands like `cd <worktree-root> && ls .claude/session-state`
// (read-only listing after a cd to somewhere unrelated). Targets that cannot be
// resolved statically (contain $VAR/%VAR%/backtick) stay fail-closed whenever
// the command also mentions the state directory.
const shellTool = /(?:bash|powershell|pwsh|cmd|shell|terminal|exec|run_command)/i.test(toolName);

// Deny targets that enter the state dir, either directly or as a component
// step (`cd .claude` then `cd session-state` must not assemble the cwd).
function cdTargetEntersStateDir(target) {
  const t = String(target || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (/\.claude\/session-state/i.test(t)) return true;
  const parts = t.split("/").filter(Boolean);
  if (parts.some((p) => /^session-state$/i.test(p))) return true;
  return /^\.claude$/i.test(parts[parts.length - 1] || "");
}

// Capture the whole argument run of each cd-like invocation, then resolve its
// target token by token (CodeRabbit PR #423): `cd -- <dir>`, `cd -P <dir>`,
// `Set-Location -Path <dir>` / `-Path:<dir>`, and shell-joined quoting like
// `.claude/"session-state"` must all resolve to the real destination instead
// of an option token. The argument-run separator is [^\S\r\n]+ (horizontal
// whitespace ONLY): with plain \s+ a newline-separated `cd A\ncd B` collapsed
// into one invocation whose target resolved to A, so the second cd was never
// checked (Opus review 2026-08-19 — a proven bypass of the state-dir deny).
// Each token is a RUN of adjacent quoted/unquoted segments, because the shell
// joins `".claude/session"-state` into one path; quotes are stripped from the
// whole run.
// `sl` is PowerShell's default Set-Location alias; the trailing lookahead
// keeps `sleep`/`slice`/`cdx` from matching (Opus review 2026-08-19, round 2).
const CD_TOKEN_RE = /(?:cd|chdir|pushd|set-location|push-location|sl)(?![\w.-])/;
const CD_SEG_RE = /(?:"[^"]*"|'[^']*'|[^\s;&|()"']+)+/;
// The prefix class admits quotes and backslash so `eval "cd dir"`, `'cd' dir`,
// and `\cd dir` (backslash suppresses only alias lookup — the builtin still
// runs) are scanned (Opus review 2026-08-19, round 2 — all proven bypasses).
const CD_CMD_RE = new RegExp(
  `(?:^|[;&|\\r\\n()"'\\\\]|\\s)${CD_TOKEN_RE.source}((?:[^\\S\\r\\n]+${CD_SEG_RE.source})*)`,
  "gi"
);
const CD_ARG_RE = new RegExp(CD_SEG_RE.source, "g");

// Statically decode ANSI-C `$'...'` quoting: `cd $'\x2eclaude/...'` executes
// with the escapes resolved, so the scan must see the resolved bytes too
// (Opus review 2026-08-19, round 2 — a proven bypass).
function decodeAnsiCQuotes(text) {
  return text.replace(/\$'((?:\\.|[^'\\])*)'/g, (_, body) =>
    body.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_esc, code) => {
      if (/^x/i.test(code)) return String.fromCharCode(parseInt(code.slice(1), 16));
      if (/^[0-7]/.test(code)) return String.fromCharCode(parseInt(code, 8));
      const map = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", f: "\f", v: "\v" };
      return map[code] ?? code;
    }));
}

function scanCdInvocations(scan) {
  for (const match of scan.matchAll(CD_CMD_RE)) {
    let target = "";
    for (const raw of match[1].match(CD_ARG_RE) || []) {
      const token = raw.replace(/["']/g, "");
      if (token === "--" || /^\/d$/i.test(token)) continue;
      if (token.startsWith("-")) {
        // `-Path:<dir>` / `--path=<dir>` carry the value attached; a bare flag
        // like `-P` or `-LiteralPath` takes it from the next token instead.
        const attached = /^-[^:=]*[:=](.+)$/.exec(token);
        if (!attached) continue;
        target = attached[1];
        break;
      }
      target = token;
      break;
    }
    // Bash drops an unquoted backslash before the next character, so
    // `session-\state` executes as `session-state` (CodeRabbit PR #423 round
    // 2). Check the decoded form too; the RAW form still covers Windows
    // `\`-separated paths, where the backslash is a real separator.
    const decoded = target.replace(/\\(.)/g, "$1");
    // Statically unresolvable: variable expansion ($VAR/%VAR%/backtick),
    // shell glob/brace expansion (Opus review 2026-08-19 — `cd .clau[d]e/...`
    // resolves at runtime to a path the literal matcher never sees), and an
    // expansion glued directly to the verb — `cd$IFS.claude/...` leaves the
    // argument run empty, so inspect the character right after the token
    // (round 2 — a proven bypass). This is a self-certification gate, so fail
    // closed whenever such a target appears in a command that also mentions
    // the state directory.
    const afterToken = scan.charAt(match.index + match[0].length - match[1].length);
    // Statically unreadable: an expansion/glob IN the target, an expansion glued
    // to the verb (`cd$IFS.claude/...` leaves the run empty), OR NO readable
    // positional target at all — the verb matched but every token was an option,
    // or the destination arrives via a pipeline/subexpression the tokenizer
    // cannot see (`… | sl`, `sl (Get-Dir)`). None can be proven to stay OUT of
    // the state dir, so all fail closed when the command also names that
    // directory (Opus review 2026-08-19, round 3 — an empty-target `sl` was a
    // proven gap).
    const unresolvable = /[$%`*?[\]{}]/.test(target) || !target || /[$%`]/.test(afterToken);
    if (cdTargetEntersStateDir(target) || cdTargetEntersStateDir(decoded) || (unresolvable && reviewStateDirectoryMentioned(command))) {
      deny("REVIEW PROOF GUARD: the review state directory is wrapper-owned and cannot become an interactive shell working directory.");
    }
  }
}

if (shellTool) {
  // Two scan passes over preprocessed views of the command:
  //   1. line continuations spliced (`cd \<newline>dir` is ONE invocation) and
  //      ANSI-C quoting decoded — otherwise both split the verb from a target
  //      the raw regex would have caught;
  //   2. the same text with quote characters removed, so composed verbs like
  //      `c"d"` / `"cd"` — which the shell joins back into `cd` — are seen as
  //      the verb they execute as. (Opus review 2026-08-19, round 2.)
  // Windows `\`-separated paths survive both views: only quotes are stripped.
  const spliced = decodeAnsiCQuotes(command).replace(/[\\`]\r?\n/g, "");
  // cmd.exe accepts cd/chdir GLUED to a switch or path — `cd/d X`, `cd\dir`,
  // `cd.claude\session-state`, `chdir/d X`. Without a separating space the
  // cd-verb regex (whose lookahead rejects a following `.`/`-`) never fires, so
  // the glued form slipped past (Opus review 2026-08-19, round 3 — a proven
  // cmd.exe bypass). Insert a space between the verb and the glued `/ . \` so
  // the scan sees the verb and its target apart. Applied to BOTH views (raw and
  // quote-stripped) so a composed verb like `c"d".claude\...` — which becomes
  // `cd.claude\...` only after quotes are removed — is degluated there too.
  const deglue = (t) => t.replace(/(^|[;&|\r\n()"'\\\s])(cd|chdir)([/.\\])/gi, "$1$2 $3");
  scanCdInvocations(deglue(spliced));
  scanCdInvocations(deglue(spliced.replace(/["']/g, "")));

  // A destructive verb in a command that also mentions the state directory is
  // denied outright: `rm -rf .claude/session-state` (or moving it aside)
  // destroys the applied-source ledger and every wrapper-owned proof — the
  // only record that a live apply lacks committed source (Opus review
  // 2026-08-19, round 2 — both reviewers proved deletion was unguarded).
  // Fail-closed by design: even a read-only command that merely MENTIONS the
  // state dir is denied when a destructive verb appears anywhere in it; run
  // reads and deletions of other files as separate commands.
  const DESTRUCTIVE_VERB_RE = /(?:^|[;&|\r\n()"'\\]|\s)(?:rm|rmdir|del|erase|rd|ri|remove-item|unlink|shred|mv|move|mi|move-item|ren|rni|rename-item|trash)(?![\w.-])/i;
  // `find` deletes by TRAVERSAL, never naming the target basename, so neither
  // DESTRUCTIVE_VERB_RE nor the basename protection fires — `find
  // .claude/session-state -delete` (or `-exec rm`/`-execdir`) wipes the exact
  // ledger + proofs that `rm -rf .claude/session-state` is blocked for (Opus
  // review 2026-08-19, round 4 — a proven bypass). Treat `find` paired with a
  // deletion/exec action as a destructive verb. `-exec cat` is read-only but is
  // still denied when it names the state dir — consistent with the fail-closed
  // stance below; run reads of other files as a separate command.
  const FIND_TRAVERSAL_DELETE_RE = /(?:^|[;&|\r\n()"'\\]|\s)find(?![\w.-])[\s\S]*?-(?:delete|exec(?:dir)?)\b/i;
  // Also deny when the destructive verb reaches the `.claude` ANCESTOR, not only
  // the full `.claude/session-state` path: `rm -rf .claude` and `mv .claude
  // /tmp` wipe the state dir (and the applied-source ledger) as collateral, yet
  // reviewStateDirectoryMentioned only matches the contiguous state path (Opus
  // review 2026-08-19, round 3 — deleting the parent was unguarded). `.claude`
  // must be a whole path component: `.claude-cache` / `foo.claude` do not match.
  const STATE_DIR_ANCESTOR_RE = /(?:^|[\s"'=:/\\(])\.claude(?![\w-])/i;
  // Check EVERY normalized view (parity with scanCdInvocations and the
  // proof-path matcher): the shell collapses `r"m"` → `rm` (quote-stripped view)
  // and drops the `\` in `.clau\de` → `.claude` (backslash-dropped view), but
  // with quotes/backslashes intact the regexes never match the composed verb or
  // ancestor (Opus review 2026-08-19, round 4 — `r"m" -rf .claude/session-state`
  // AND `rm -rf .clau\de` were both proven bypasses). The verb and the state-dir
  // mention must appear in the SAME view, so test per-view; the raw (base) view
  // still covers Windows `\`-separated paths, where the backslash is a real
  // separator and dropping it would corrupt the path.
  const destructiveViews = shellCommandViews(command);
  const hitsDestructiveVerb = (v) => DESTRUCTIVE_VERB_RE.test(v) || FIND_TRAVERSAL_DELETE_RE.test(v);
  const namesStateDir = (v) => reviewStateDirectoryMentioned(v) || STATE_DIR_ANCESTOR_RE.test(v);
  if (destructiveViews.some((v) => hitsDestructiveVerb(v) && namesStateDir(v))) {
    deny("REVIEW PROOF GUARD: destructive shell commands touching the .claude review state directory (or its parent) are blocked — it holds wrapper-owned proofs and the applied-source ledger. Stale ledger entries are removed with node scripts/remove-applied-ledger-entry.mjs after verifying the live migration ledger.");
  }
}
if (shellTool && reviewStateDirectoryMentioned(hookCwd)) {
  deny("REVIEW PROOF GUARD: shell commands from the wrapper-owned review state directory are blocked. Return to the repository root and run the real review wrapper.");
}

process.exit(0);
