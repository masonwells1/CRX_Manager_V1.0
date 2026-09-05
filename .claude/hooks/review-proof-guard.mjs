#!/usr/bin/env node

// Review proof files are outputs of the real Claude/Codex CLI wrappers. Direct
// tool or shell access would let an agent self-certify the gate, so deny it for
// both agents. The wrappers write internally and never name the proof path in
// their tool command, so legitimate proof creation still works.

import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

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
  // NotebookRead/NotebookEdit carry their target here (exact-SHA gpt-5.6-sol
  // review, round 4: without it the NotebookRead cases below never reached the
  // guard, so they passed against every version of it).
  input.notebook_path,
  input.notebookPath,
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
// The basename matcher above sees the NAME the tool was given, not the file the
// operating system will open. On Windows every long name also answers to an 8.3
// short alias — `.claude/session-state/CODEX-~1.JSO` IS `codex-review-<sha>.json`
// (exact-SHA gpt-5.6-sol review, round 4, HIGH: a native Read through the alias
// was allowed) — and a symlink can carry any name at all. For the native
// single-file readers, resolve the target through the OS and run the proof-file
// rule again on the real path. The verdict is one of four explicit words, never
// an ambiguous null (exact-SHA gpt-5.6-sol review, round 6: an earlier draft
// folded "multi-link" into "unresolvable" and so let an OUTSIDE symlink to a
// hard-linked proof through — the proof-name check must come first):
//   "proof"        — resolves to a regular file whose REAL name is a proof or
//                    the ledger: deny wherever the read points;
//   "evidence"     — resolves into the state directory with a `.json` real
//                    name that the proof-name rule does not list. Every wrapper
//                    writes its evidence as JSON — `migration-review-<name>.json`
//                    (write-apply-proofs.mjs, consumed by migration-apply-lib),
//                    `codex-review-mig-<name>.json`, `claude-review-push.json`,
//                    the applied-migrations snapshot, the ledger — and the name
//                    rule only ever listed some of them (exact-SHA gpt-5.6-sol
//                    review, round 11, HIGH: a native Read of
//                    `migration-review-*.json` was allowed). The legitimate reads
//                    the exemption exists for are all `.flag` and `.txt` files,
//                    so JSON in the state directory is evidence by shape and
//                    fails closed here, present and future producers alike;
//   "aliased"      — resolves into the state directory with more than one hard
//                    link. A hard link has no "real" name to resolve to (both
//                    names ARE the file); the wrappers never hard-link what they
//                    write, so a second name there can only be an alias made to
//                    read a proof. Outside the state directory link counts are
//                    ignored — pnpm-style stores hard-link every module file;
//   "unresolvable" — missing, a directory, or a path the OS cannot resolve;
//   "clear"        — a regular file that is none of the above.
const READ_ONLY_SINGLE_FILE_TOOL_RE = /^(?:read|notebookread)$/i;
const STATE_DIR_REAL_PATH_RE = /[\\/]\.claude[\\/]session-state[\\/]/i;
const STATE_DIR_EVIDENCE_RE = /\.json$/i;
// Membership in the state directory is decided three ways, because when
// `.claude/session-state` is ITSELF a junction or symlink to somewhere else,
// realpath strips the protected components from every file under it and a
// resolved-path test alone says "outside" (Codex GitHub App review of
// eb887fd47, P1 — reproduced with a symlinked state directory):
//   1. the RESOLVED path spells `.claude/session-state/` (the normal case, and
//      the 8.3-aliased-component case, since realpath expands the alias);
//   2. the LEXICAL path the tool was given spells it (a junctioned directory
//      read through its protected name);
//   3. the resolved file's directory IS the real location of this checkout's
//      own state directory (the junction target read by its external name).
// Residual, documented in KNOWN_ISSUES: a junctioned state directory of a
// DIFFERENT checkout read by its external name is not this checkout's to know.
const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
function realStateDirOf(baseDir) {
  try {
    return realpathSync.native(path.join(baseDir, ".claude", "session-state"));
  } catch {
    return null;
  }
}
const cwdStateDirReal = realStateDirOf(hookCwd || process.cwd());
function classifyReadTarget(candidate) {
  const lexical = path.resolve(hookCwd || process.cwd(), String(candidate));
  let resolved;
  let stats;
  try {
    resolved = realpathSync.native(lexical);
    stats = statSync(resolved);
  } catch {
    return "unresolvable";
  }
  if (!stats.isFile()) return "unresolvable";
  if (reviewProofPathMentioned(resolved) || reviewProofPathMentioned(lexical)) return "proof";
  const inStateDir = STATE_DIR_REAL_PATH_RE.test(resolved) ||
    STATE_DIR_REAL_PATH_RE.test(lexical) ||
    (cwdStateDirReal != null && samePath(path.dirname(resolved), cwdStateDirReal));
  if (inStateDir && (STATE_DIR_EVIDENCE_RE.test(resolved) || STATE_DIR_EVIDENCE_RE.test(lexical))) return "evidence";
  if (inStateDir && stats.nlink > 1) return "aliased";
  return "clear";
}
if (READ_ONLY_SINGLE_FILE_TOOL_RE.test(toolName)) {
  for (const candidate of pathCandidates) {
    if (candidate == null || String(candidate) === "") continue;
    const verdict = classifyReadTarget(candidate);
    if (verdict === "proof" || verdict === "evidence") {
      deny("REVIEW PROOF GUARD: that path resolves to wrapper-owned evidence in the review state directory (a review proof, the applied-source ledger, or other JSON the apply and push gates consume). Run the real review workflow; evidence files are not readable through file tools. Flags and .txt captures there remain readable by their real names.");
    }
  }
}
// A native or MCP file-mutation tool (Write/Edit, move_file, delete_directory,
// …) that targets the state DIRECTORY itself — not a protected basename — moves
// or deletes the whole ledger + every proof at once, and the basename matcher
// above never sees a protected filename (blind Opus review 2026-08-19 — proven
// HIGH bypass: `move_file source=".claude/session-state"`,
// `delete_directory path=".claude/session-state"`, `move_file source=".claude"`
// all slipped through). Every pathCandidate is a mutation target, so deny any
// that ENTERS the state dir (`.claude/session-state`, a `session-state`
// component, or the whole `.claude` parent). cdTargetEntersStateDir leaves a
// file INSIDE `.claude` but outside session-state alone (`.claude/settings.json`,
// `.claude/hooks/*.mjs`) allowed, so ordinary hook/settings edits still pass.
// Also catches a forge-by-move whose destination lands a NON-ledger basename in
// the state dir. MCP path fields are literal (no shell glob expansion), so the
// literal component check is sufficient here.
//
// stop-wrap-ack.json is the one designed session-end acknowledgment valve:
// stop-wrap.mjs instructs the agent to write {"signature": ...} to
// .claude/session-state/stop-wrap-ack.json to confirm ordinary loose ends are
// intentional. codex-push-lib.mjs's reviewProofPathMentioned already carves this
// basename out on purpose; the round-8 whole-dir deny above re-broke it. The
// carve-out below restores it. Safe: stop-wrap.mjs refuses to honor an ack while
// any live-applied migration lacks committed source, so the C3 alarm can never
// be self-acknowledged regardless of this write.
//
// The exemption is scoped exactly to its intent — a Write/Edit whose DESTINATION
// is the ack file (CodeRabbit PR #430). Two guards keep it that narrow:
//   1. It opens only when EVERY state-dir-entering candidate IS the ack path, so
//      a move/delete whose OTHER operand is a protected file (the ledger, a
//      proof) can never ride the exemption — that operand isn't the ack path, so
//      the deny still fires. This is the load-bearing safety floor.
//   2. A move/delete SHAPE is never exempt: a tool exposing both source AND
//      destination (a move/copy), or whose name is move/rename/delete/remove/
//      unlink/trash/copy, is denied even when it only names the ack file — so an
//      MCP delete_file/move_file (which reuse the `path` field a legit write_file
//      also uses) cannot slip through. Only a genuine Write/Edit/write_file opens.
// The match is CASE-SENSITIVE (the valve path stop-wrap.mjs reads/writes is
// canonical lowercase), so a case-variant name is denied like any other. The
// proof JSON, the applied-source ledger, a lookalike (stop-wrap-ack.json.bak),
// whole-dir moves/deletes, and every OTHER session-state basename all still deny
// — mutation-proved in review-proof-guard.test.mjs.
const ACK_VALVE_RE = /(?:^|\/)\.claude\/session-state\/stop-wrap-ack\.json$/;
const isAckValvePath = (candidate) =>
  ACK_VALVE_RE.test(String(candidate).replace(/\\/g, "/").replace(/\/+$/, ""));
const stateDirCandidates = pathCandidates.filter((c) => c != null && cdTargetEntersStateDir(c));
const isMoveOrDeleteShape =
  (input.source != null && input.destination != null) ||
  /(?:^|[-._])(?:move|rename|delete|remove|unlink|trash|copy)(?:[-._]|$)/i.test(toolName);
const isPureAckWrite = stateDirCandidates.length > 0 &&
  !isMoveOrDeleteShape &&
  stateDirCandidates.every((c) => isAckValvePath(c));
// A native single-file READ cannot create, move, or delete anything, and it can
// only open the ONE path it names. So the whole-directory rule below does not
// apply to `Read`/`NotebookRead` — PROVIDED the path it names resolves, through
// the operating system, to a regular file whose REAL name the proof-file rule
// clears (the alias check above) AND that is not JSON: every wrapper writes its
// evidence as `.json`, and the reads this exemption exists for are flags and
// `.txt` captures (round 11 closed `migration-review-*.json`, which the name
// rule never listed). Inside the state directory a target that does not resolve
// fails closed: there is nothing to read from a missing file, and a directory or
// an unresolvable alias is not "the one file it names". It was
// applying to plain reads: reading `OVERNIGHT-INTENT.flag` or
// `codex-review-latest.txt` back is exactly what the guards' own messages and
// the codex-review skill tell an agent to do (33 such denials, 2026-09-04 audit).
// `Grep` and `Glob` are deliberately NOT exempt (exact-SHA gpt-5.6-sol review of
// the first cut, HIGH): a directory-level search SELECTS files by pattern, so
// `Grep(path=".claude/session-state", pattern="verdict")` reads proof JSON line
// by line while naming no proof basename. Fail closed there; search a narrower
// path (`.claude/hooks`) instead. NAME-matched, never shape-matched, and only the
// built-in reader — an MCP reader keeps the deny because its name proves nothing.
// @proven-by review-proof-guard.test.mjs (the read-only session-state block pins
// both directions: a native Read of a real non-proof file allows; a Read of a
// proof basename, of a proof's 8.3 or symlink alias, of a missing file, of the
// directory itself, a Grep/Glob over the directory, and an MCP read still deny).
const isCanonicalSingleFileRead = READ_ONLY_SINGLE_FILE_TOOL_RE.test(toolName) &&
  stateDirCandidates.length > 0 &&
  stateDirCandidates.every((candidate) => classifyReadTarget(candidate) === "clear");
if (stateDirCandidates.length > 0 && !isPureAckWrite && !isCanonicalSingleFileRead) {
  deny("REVIEW PROOF GUARD: the review state directory (.claude/session-state) and its wrapper-owned contents cannot be created, moved, or deleted through a file tool. Stale ledger entries are removed with node scripts/remove-applied-ledger-entry.mjs after verifying the live migration ledger.");
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
// Gate on the PRESENCE of a command field, not only a known tool name: a shell-
// capable MCP runner named e.g. `start_process`/`execute_command` carries a
// `command` and would otherwise skip the destructive/cd checks entirely (Opus
// review 2026-08-19, round 5 — HIGH: a name-only gate is bypassable). Known
// shell tool names still match so a command-less shell tool is covered too.
const shellTool = input.command != null || input.cmd != null ||
  /(?:bash|powershell|pwsh|cmd|shell|terminal|exec|run_command)/i.test(toolName);

// Deny targets that enter the state dir, either directly or as a component
// step (`cd .claude` then `cd session-state` must not assemble the cwd).
function cdTargetEntersStateDir(target) {
  const t = String(target || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (/\.claude\/session-state/i.test(t)) return true;
  const parts = t.split("/").filter(Boolean);
  if (parts.some((p) => /^session-state$/i.test(p))) return true;
  return /^\.claude$/i.test(parts[parts.length - 1] || "");
}

// Protected directory/file names the state-dir guard must recognize even when a
// shell glob obscures them. `rm -rf .clau*/session-state`, `find .clau*/... -delete`,
// and `printf "[]" > …applied-source-ledger.jso*` all resolve to the real path at
// runtime, yet the literal matchers (reviewStateDirectoryMentioned /
// STATE_DIR_ANCESTOR_RE / reviewProofPathMentioned) never see a literal `.claude`
// or `…ledger.json`, so they missed all three (Opus review 2026-08-19, round 5 —
// two independent reviewers reproduced them). The cd scanner already failed
// closed on glob metacharacters; these matchers did not.
const PROTECTED_GLOB_TARGETS = [".claude", "session-state", "applied-source-ledger.json"];
// A glob SEGMENT whose leading literal run could still expand to a protected name
// (`.clau*` → `.claude`, `sess*` → `session-state`, `…ledger.jso*` → `…ledger.json`).
// Fail closed. A too-generic lead (`*`, `*.tmp`, `x*`) is ignored so ordinary
// deletes like `rm dist/*.js` or `rm -rf node_modules/.cache` are not over-blocked.
function globSegCouldTargetProtected(seg) {
  if (!/[*?[\]{}]/.test(seg)) return false;
  const lead = (seg.match(/^[^*?[\]{}]*/)[0] || "").toLowerCase();
  // Floor the lead length so a too-generic glob (`*`, `s*`, `a*`) is ignored and
  // ordinary deletes (`rm dist/*.js`, `rm s*.o`, `rm a*.log`) are not over-blocked.
  // A DOTTED lead is specific enough at length 2: the only protected name starting
  // with `.` is `.claude`, and `.c*` is a real glob for it — `rm -rf .c*/s*`,
  // `mv .c*/s* /tmp/x`, `find .c*/s* -delete`, `cd .c*/s*` all expand to
  // `.claude/session-state` at runtime, and the length-3 floor let them through
  // (blind Opus review 2026-08-19 — proven bypass; the whole `.claude` parent is
  // the gateway to the state dir). A non-dotted lead keeps the length-3 floor.
  const minLead = lead.startsWith(".") ? 2 : 3;
  if (lead.length < minLead) return false;
  return PROTECTED_GLOB_TARGETS.some((name) => name.startsWith(lead));
}
// Component-aware state-dir reference (parity with cdTargetEntersStateDir): any
// `/`- or `\`-separated segment that is exactly `.claude`/`session-state`, or a
// glob that could expand to one. Catches a globbed ANCESTOR (`.clau*/session-state`
// carries a literal `session-state` segment) without needing a literal `.claude`.
function segmentsHitStateDir(value) {
  const segs = String(value || "").replace(/\\/g, "/").split(/[\s"'=:/(){}|;&<>]+/);
  return segs.some((s) => /^\.claude$/i.test(s) || /^session-state$/i.test(s) || globSegCouldTargetProtected(s));
}
// A redirect (`>`/`>>`) whose target enters the state dir truncates/overwrites a
// wrapper-owned file even when the basename is globbed (`…ledger.jso*`) — which
// the literal-basename proof-path matcher misses (Opus review 2026-08-19, round
// 5). The wrappers write internally via Node fs and never shell-redirect into the
// state dir, so any such redirect is illegitimate; fail closed.
function redirectTargetsStateDir(value) {
  const norm = String(value || "").replace(/\\/g, "/");
  for (const m of norm.matchAll(/>>?\s*("[^"]*"|'[^']*'|[^\s;&|()<>]+)/g)) {
    if (segmentsHitStateDir(m[1].replace(/["']/g, ""))) return true;
  }
  return false;
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
    // the state directory. @proven-by review-proof-guard.test.mjs (the
    // session-state deny cases cover the expansion, glob, and glued-verb forms).
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
    // An unresolvable target whose OWN literal skeleton already names a
    // protected component (`cd .claude/session-$part`, `cd .clau[d]e/…`) can
    // enter the state dir regardless of what else the command says — the
    // second-literal-reference test below misses it because the contiguous
    // `.claude/session-state` string is never spelled out. Fail closed on the
    // target itself, component-aware (parity with the destructive-verb net;
    // CodeRabbit PR #423, still-open despite the auto-"addressed" marker).
    const targetSkeletonHitsStateDir = segmentsHitStateDir(target) || segmentsHitStateDir(decoded);
    if (cdTargetEntersStateDir(target) || cdTargetEntersStateDir(decoded) ||
        (unresolvable && (reviewStateDirectoryMentioned(command) || targetSkeletonHitsStateDir))) {
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
  const DESTRUCTIVE_VERB_RE = /(?:^|[;&|\r\n()"'\\]|\s)(?:rm|rmdir|del|erase|rd|ri|remove-item|unlink|shred|mv|move|mi|move-item|ren|rni|rename-item|trash|truncate)(?![\w.-])/i;
  // `find` deletes by TRAVERSAL, never naming the target basename, so neither
  // DESTRUCTIVE_VERB_RE nor the basename protection fires — `find
  // .claude/session-state -delete` (or `-exec rm`/`-execdir`) wipes the exact
  // ledger + proofs that `rm -rf .claude/session-state` is blocked for (Opus
  // review 2026-08-19, round 4 — a proven bypass). Treat `find` paired with a
  // deletion/exec action as a destructive verb. `-exec cat` is read-only but is
  // still denied when it names the state dir — consistent with the fail-closed
  // stance below; run reads of other files as a separate command.
  const FIND_TRAVERSAL_DELETE_RE = /(?:^|[;&|\r\n()"'\\]|\s)find(?![\w.-])[\s\S]*?-(?:delete|exec(?:dir)?)\b/i;
  // `git clean` (with -x/-X it reaches the git-ignored session-state dir) and
  // `rsync --delete` (mirrors an empty source, emptying the target) wipe the
  // ledger + proofs with NO rm/mv verb — a mundane "clean my worktree" command
  // that silently erases the C3 record, which unlike proof forgery leaves no
  // tamper-evidence (Opus review 2026-08-19, round 5 — both reproduced). Treated
  // as destructive verbs alongside rm/find. NOTE the honest ceiling: a repo-root
  // `git clean -fdx` that names NO path can never be name-caught, exactly like
  // `node -e` deletion; those remain accepted residuals whose real boundary is
  // GitHub branch protection + C3 tamper-evidence (see docs/reference/agent-guardrails.md).
  const GIT_CLEAN_RE = /(?:^|[;&|\r\n()"'\\]|\s)git\s+clean(?![\w-])/i;
  const RSYNC_DELETE_RE = /(?:^|[;&|\r\n()"'\\]|\s)rsync(?![\w.-])[\s\S]*?--delete/i;
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
  const hitsDestructiveVerb = (v) =>
    DESTRUCTIVE_VERB_RE.test(v) || FIND_TRAVERSAL_DELETE_RE.test(v) || GIT_CLEAN_RE.test(v) || RSYNC_DELETE_RE.test(v);
  // namesStateDir now also matches a component-aware / glob-obscured reference
  // (segmentsHitStateDir), so a globbed ancestor like `.clau*/session-state` is
  // caught. redirectTargetsStateDir is a SEPARATE trigger (no destructive verb
  // needed): a `>`/`>>` write into the state dir overwrites a wrapper-owned file
  // even when its basename is globbed.
  const namesStateDir = (v) =>
    reviewStateDirectoryMentioned(v) || STATE_DIR_ANCESTOR_RE.test(v) || segmentsHitStateDir(v);
  // KNOWN OVER-BLOCK, kept on purpose (2026-09-05). The user's HOME `.claude`
  // (`~/.claude/projects`, the transcripts) is Claude Code's own data directory,
  // not a checkout, yet `find ~/.claude/projects … -exec du {} +` is refused here
  // because `.claude` reads as the repo ancestor (22 refusals in the 2026-09-04
  // usage audit, all read-only scans). Three exact-SHA gpt-5.6-sol rounds tried
  // to carve that out and each found a real bypass in the carve-out: `..`
  // climbing back into `~/.claude/worktrees`, `worktrees` followed by a space,
  // and `find … -exec cat {} + > ~/.claude/history.jsonl` truncating the file
  // before the read. Every one of those is a pinned deny case in the test file.
  // The rule stays as it was; the workaround is a pipeline with no `-exec`
  // (`find … -name x | xargs du -m`), which this rule never matched.
  if (destructiveViews.some((v) => (hitsDestructiveVerb(v) && namesStateDir(v)) || redirectTargetsStateDir(v))) {
    deny("REVIEW PROOF GUARD: destructive or overwriting shell commands touching the .claude review state directory (or its parent) are blocked — it holds wrapper-owned proofs and the applied-source ledger. Stale ledger entries are removed with node scripts/remove-applied-ledger-entry.mjs after verifying the live migration ledger.");
  }

  // The enforcement surfaces that live OUTSIDE `.claude`. Added 2026-09-01, when
  // `guarded-surface-lock` was removed (Mason's decision; see DECISION_LOG). That
  // lock was an entire second hook — its own rule book, an unlock ceremony, and a
  // module-load defect that silently disabled it — all for coverage this guard
  // already provided everywhere under `.claude`. Everything below
  // `.claude/hooks/**` was ALREADY blocked by the check above, so the lock's
  // genuinely unique reach was only these four paths. Reuse the proven machinery
  // instead of standing up a second rule book. @speed-bump — this is a
  // command-text guard like the rest of the file: it raises the cost of a silent
  // gate rewrite, it is not a boundary. The honest-scope paragraph at the top of
  // this file governs it too.
  //
  // Same read/write split as above: this fires on a DESTRUCTIVE VERB aimed at one
  // of these paths, or a redirect that writes INTO one. Reading them — `cat
  // .husky/pre-push`, `grep -rn on: .github/workflows/` — is untouched, which is
  // what routine work actually does.
  //
  // Both separators are accepted: the raw view carries Windows `\` paths, and the
  // quote-stripped / backslash-dropped views carry the `/` forms.
  // `.claude/hooks` is listed too, even though the state-dir rule above already
  // names `.claude`. That rule fires on rm/mv-class verbs; the git verbs below
  // are NOT in it, and the removed lock DID catch them. Without this line,
  // deleting the lock would quietly drop `git checkout <rev> -- .claude/hooks/x`
  // — a silent guard rewrite — from the protected set.
  const ENFORCEMENT_SURFACE_RE =
    /(?:^|[\s"'=:/\\(])(?:\.husky|\.github[/\\]workflows|\.codex[/\\](?:hooks|config\.toml)|\.claude[/\\](?:hooks|settings(?:\.local)?\.json)|\.coderabbit\.ya?ml|scripts[/\\](?:(?:check|validate|verify)-[^\s"']*|write-codex-push-proof\.mjs|run-claude-review\.mjs|remove-applied-ledger-entry\.mjs|agent-manifest-parity\.mjs|sync-agent-workflows\.mjs))(?![\w-])/i;
  // FAIL-CLOSED READ-ONLY ALLOWLIST — deliberately NOT a destructive-verb list.
  // @proven-by review-proof-guard.test.mjs (the deny block asserts that heads
  // absent from this set — cp, tee, rm, Set-Content, command, npx — are refused,
  // and the allow block asserts the listed readers still work).
  //
  // The first cut of this rule (2026-09-01, same day) reused the `.claude`
  // state-dir approach above and enumerated WRITERS. An exact-SHA `gpt-5.6-sol`
  // review returned HIGH with parser-confirmed bypasses: `cp … .husky/pre-push`,
  // `tee .husky/pre-push`, `sed -i … .husky/pre-push`, `Set-Content
  // .codex/hooks.json`, `Copy-Item … .claude/hooks/…`, and `echo x >|
  // .husky/pre-push` were all allowed. That is the blocklist failure mode: it
  // reopens every time someone learns a new verb. The lock this rule replaced had
  // the shape right, and losing it in the port was a real regression.
  //
  // So: a segment that NAMES one of these paths must have a recognized read-only
  // head, or it is denied. `tee`, `cp`, `mv`, `rm`, `install`, `dd`, `truncate`,
  // `perl`, `python`, `Set-Content`, `Copy-Item`, and anything invented later are
  // refused without appearing anywhere in this file.
  //
  // The `.claude/session-state` rule above keeps its own verb list unchanged —
  // rewriting that one is a separate, riskier change than this addition.
  const ENFORCEMENT_READ_ONLY_HEADS = new Set([
    "cat", "head", "tail", "less", "more", "bat", "nl", "od", "strings",
    "grep", "egrep", "fgrep", "rg", "ag", "ack",
    "wc", "ls", "dir", "stat", "file", "du", "tree", "realpath", "readlink", "basename", "dirname",
    "cmp", "comm", "cut", "tr", "jq", "column",
    "md5sum", "sha1sum", "sha256sum", "cksum",
    "which", "type", "pwd", "test", "true", "false", "echo", "printf", "date",
    // ABSENT ON PURPOSE — successive gpt-5.6-sol rounds proved each of these
    // writes a NAMED file while wearing a read-only head, every one probe-confirmed
    // ALLOW before removal:
    //   sed  → `sed -n 'w .husky/pre-push' /dev/null`   (the `w` command writes)
    //   awk  → `awk -v p=.husky/pre-push '… > p'`       (redirect inside the script)
    //   sort → `sort -o .husky/pre-push /dev/null`      (`-o` writes in place)
    //   uniq → `uniq in .husky/pre-push`                (second operand is output)
    //   diff → `diff --output=.husky/pre-push a b`
    //   yq   → `yq -i … .codex/hooks.json`              (`-i` edits in place)
    //   xxd  → `xxd -r` reconstructs binary into a file
    // And the WRAPPERS, which hide the real program from a head-only check:
    //   command → `command cp /tmp/evil .husky/pre-push` was ALLOW while bare `cp`
    //             was denied. `env`, `exec`, `nice`, `timeout`, `xargs`, `sudo`,
    //             `stdbuf`, and any future wrapper are refused by simply never
    //             being listed — that is the allowlist doing its job.
    //   npx/npm/pnpm/yarn → `npx rimraf .husky/…` runs an arbitrary program with
    //             the protected path as its argument. `node <script>` stays,
    //             because that is how these suites run.
    // Reading these files never needs any of the above: cat/head/grep/git show
    // cover it, and over-refusing an exotic read is the correct side to err on.
    "node", "gh",
    "git", "find",
    // PowerShell read verbs. Its WRITE verbs (Set-Content, Copy-Item, Out-File,
    // Add-Content, Move-Item, Remove-Item) are absent on purpose.
    "get-content", "gc", "select-string", "sls", "get-childitem", "gci", "get-item", "measure-object",
    // Changing INTO one of these directories writes nothing, and `cd .claude/hooks
    // && node review-proof-guard.test.mjs` is how this very suite is run. @unproven
    // — residual, stated rather than hidden: Bash cwd persists across calls, so a
    // `cd` here followed by a LATER call using a bare filename never names the
    // path and is not seen by this rule. The `.claude/session-state` rule above
    // closes its own version of that with a hookCwd check; the same check here
    // would deny running a hook's tests from inside the hooks directory, which is
    // routine. Branch protection remains the boundary.
    "cd", "pushd", "popd", "set-location", "sl", "push-location", "pop-location", "chdir",
  ]);
  // Git subcommands that cannot rewrite working-tree content. `checkout`,
  // `restore`, `apply`, `am`, `rm`, `mv`, `clean`, `stash`, `reset`, `revert`,
  // `cherry-pick`, and `rebase` are all absent, so they deny by omission — the
  // "git subcommands bypass destination guards" class, closed by shape.
  const ENFORCEMENT_READ_ONLY_GIT = new Set([
    "diff", "show", "log", "status", "ls-files", "ls-tree", "cat-file", "blame", "grep",
    "rev-parse", "rev-list", "merge-base", "cherry", "describe", "shortlog", "name-rev",
    "remote", "branch", "tag", "fetch", "ls-remote", "reflog", "check-ignore", "var",
    "config", "help", "version", "count-objects", "verify-commit", "symbolic-ref",
    // Staging/committing record content; they do not alter it.
    "add", "commit", "push", "worktree",
  ]);
  // KNOWN OVER-BLOCK, pinned in the tests rather than papered over: this splits on
  // `|` even inside quotes, so `grep -E "(a|b)" .husky/pre-push` becomes two
  // segments and the second one's head is `b)"`, which is not allowlisted, so an
  // ordinary read is refused. The workaround is two greps or a bracket class.
  // Deliberately NOT fixed with a quote-aware splitter: that changes which text
  // counts as a segment, and every mistake in that direction turns a denial into
  // an ALLOW. Five review rounds on this file have each found a real bypass, so a
  // false refusal is the acceptable failure and a speculative rewrite is not.
  const enforcementSegments = (cmd) =>
    String(cmd ?? "").split(/(?:\|\||&&|[;\r\n|&])+/).map((s) => s.trim()).filter(Boolean);
  // Resolve git's real subcommand past the global flags THAT TAKE A SEPARATE
  // VALUE. A naive `git(?:\s+-\S+)*\s+(\w+)` reads `git -C <dir> add …` as
  // subcommand `<dir>`, finds it unknown, and refuses an ordinary `git add` —
  // which is exactly how this rule first broke a real command. @proven-by
  // review-proof-guard.test.mjs ("git -C /repo add …" and the -c/--git-dir cases
  // in the allow block). Skip the flag AND its value, then take the first bare
  // token.
  const GIT_VALUE_FLAGS = /^(?:-[cC]|--git-dir|--work-tree|--namespace|--exec-path|--config-env|--super-prefix)$/;
  const gitSubcommandOf = (segment) => {
    const tokens = String(segment).match(/(?:"[^"]*"|'[^']*'|\S)+/g) || [];
    let i = tokens.findIndex((t) => /^(?:.*[/\\])?git(?:\.exe)?$/i.test(t.replace(/["']/g, "")));
    if (i < 0) return null;
    for (i += 1; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (GIT_VALUE_FLAGS.test(token)) { i += 1; continue; }   // flag + its value
      if (token.startsWith("-")) continue;                      // valueless flag
      return token.replace(/["']/g, "").toLowerCase();
    }
    return null;
  };
  const enforcementSegmentIsReadOnly = (segment) => {
    const raw = (String(segment).trim().match(/^([\w.:\\/-]+)/) || [])[1];
    if (!raw) return false;
    // A PATH-QUALIFIED head is not the program the allowlist vouched for. Fifth
    // gpt-5.6-sol round, HIGH: the basename was trusted, so `scripts/cat
    // .husky/pre-push` and `/tmp/git diff .github/workflows/ci.yml` were ALLOW —
    // any file the agent can create, named `cat` or `git`, inherited the
    // allowlist. Only a bare command name may be vouched for.
    if (/[/\\]/.test(raw)) return false;
    const head = raw.toLowerCase();
    if (!ENFORCEMENT_READ_ONLY_HEADS.has(head)) return false;
    // A runner EXECUTES a script; an INLINE-CODE runner is an arbitrary writer
    // wearing the runner's name. `node -e "…writeFileSync('.husky/pre-push'…)"`
    // was probe-confirmed ALLOW in the second review round. Denying the eval
    // flags keeps `node .claude/hooks/x.test.mjs` — how this suite is actually
    // run — working. A script FILE that writes is the documented residual: no
    // command-text rule can see inside it.
    // Node injects code through THREE channels, not one. The eval flags were
    // covered; PRELOAD (`-r`/`--require`/`--import`) and LOADER hooks were not, and
    // both run before the entrypoint — so `node -r ./payload.cjs .husky/pre-push`
    // executed the payload against the named hook and was ALLOW (Codex P1, and
    // CodeRabbit independently). The old regex also missed BUNDLED short forms:
    // `\b` after `-p` does not match in `-pe`, so `node -pe "…"` slipped the eval
    // check it was written for.
    //
    // Matching a short-option CLUSTER containing e, p or r closes the bundling gap
    // without a spelling list. Node's other short flags (`-c`, `-i`, `-v`) contain
    // none of those letters, so `node script.mjs` and `node --check x.mjs` — how
    // this suite actually runs — stay allowed. A script FILE that writes remains
    // the documented residual: no command-text rule can see inside it.
    if (head === "node" && /(?:^|\s)(?:-[A-Za-z]*[epr][A-Za-z]*|--eval|--print|--input-type|--require|--import|--loader|--experimental-loader)(?:[=\s]|$)/i.test(segment)) return false;
    // `-fprintf` writes a named file; the old `fprint\b` missed it because the
    // trailing `f` is a word character.
    if (head === "find" && /(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fls|fprint\w*)\b/i.test(segment)) return false;
    // A READER THAT CAN EXECUTE. Seventh gpt-5.6-sol round, P1: ripgrep's `--pre`
    // runs an arbitrary program on every input path — `rg --pre rm pattern
    // .github/workflows/ci.yml` runs `rm .github/workflows/ci.yml`, and the
    // reviewer reproduced the deletion. `--hostname-bin` likewise names a program
    // to run. That makes `rg` a runner wearing a reader's name, which is the same
    // shape already denied for `node -e` and `find -exec` above, not a new kind of
    // rule. `--pre-glob` only selects which files `--pre` applies to, but it is
    // meaningless without `--pre` and refusing it costs nothing.
    if (head === "rg" && /(?:^|\s)--(?:pre|pre-glob|hostname-bin)(?:[=\s]|$)/i.test(segment)) return false;
    if (head === "git") {
      // GIT CAN BE TOLD TO RUN A PROGRAM, and a read-only SUBCOMMAND does not stop
      // it. Seventh-round P1s, both reproduced by the reviewer deleting
      // `.husky/pre-push`:
      //   git -c diff.external=rm diff --ext-diff -- .husky/pre-push
      //   git grep --open-files-in-pager=rm pattern -- .husky/pre-push
      // `gitSubcommandOf` deliberately SKIPS `-c` and its value to find the real
      // subcommand, which is correct for that job and left this channel invisible.
      //
      // Refuse the whole config-override channel rather than listing the keys that
      // execute — `diff.external`, `core.pager`, `sequence.editor`, `core.editor`,
      // `pager.*`, `alias.*` and whatever git adds next. Enumerating them is the
      // blocklist mistake this file has already made twice. Reading a guarded file
      // never needs `-c`. This deliberately flips `git -c core.pager=cat log
      // <guarded>`, previously an ALLOW case, to a denial: that spelling is the
      // vulnerable shape, and vouching for it was the bug.
      if (/(?:^|\s)(?:-c|--config-env)(?:[=\s]|$)/.test(segment)) return false;
      if (/(?:^|\s)(?:--ext-diff|--open-files-in-pager|-O)(?:[=\s]|$)/.test(segment)) return false;
      const sub = gitSubcommandOf(segment);
      if (!sub || !ENFORCEMENT_READ_ONLY_GIT.has(sub)) return false;
      // `git config` WRITES, and the one write that matters here does not touch a
      // guarded file at all — it decides whether the guards RUN.
      // `git config core.hooksPath <elsewhere>` disables every husky gate in a
      // single ordinary-looking command (its own KNOWN_ISSUES entry), and `config`
      // sat in the read-only allowlist above, so it was ALLOW. CodeRabbit found
      // this after seven adversarial rounds missed it: every earlier bypass needed
      // an exotic flag to smuggle an executor past a reader, while this one is a
      // command anybody might type, and it takes down the whole gate rather than
      // one file.
      //
      // Reads stay allowed. The ONE write that stays allowed is repointing
      // hooksPath AT THE TRACKED `.husky` — the documented repair, which a fresh
      // worktree needs because it is seeded pointing at a foreign checkout. Denying
      // that too would strand the repair, which is the deadlock this file's history
      // already paid for twice.
      //
      // Pinned to the safe DESTINATION rather than enumerating unsafe ones: a value
      // that is exactly `.husky` is the only accepted target, so a spelling nobody
      // has thought of yet is refused by default instead of admitted by omission.
      if (sub === "config") {
        // A READ must actually be a read. `--type` is NOT a read flag — it is a
        // modifier that a SET also takes, so listing it would have let
        // `git config --type=path core.hooksPath /evil/.husky` through.
        const readOnlyConfig = /(?:^|\s)(?:--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|--show-origin|--show-scope|--name-only)(?:[=\s]|$)/.test(segment)
          && !/(?:^|\s)(?:--unset|--unset-all|--remove-section|--rename-section|--replace-all|--add|--edit|-e)(?:[=\s]|$)/.test(segment);
        // The repair is matched as an EXACT WHOLE-SEGMENT SHAPE, not by searching
        // for `.husky` somewhere in the line. A loose search accepted
        // `git config --unset core.hooksPath .husky`, which REMOVES the setting and
        // drops hooks back to `.git/hooks` — disabling husky just as thoroughly as
        // repointing it. Spelling out the entire accepted command means any other
        // form, including ones not yet invented, falls through to the denial.
        const repairsHooksPath = /^git(?:\s+--(?:worktree|local|global|system))*\s+config(?:\s+--(?:worktree|local|global|system))*\s+core\.hooksPath\s+(?:"\.husky"|'\.husky'|\.husky)\s*$/.test(String(segment).trim());
        if (!readOnlyConfig && !repairsHooksPath) return false;
      }
    }
    // A protected path supplied as the VALUE OF A FLAG is an output target, no
    // matter what the flag is called. Fourth gpt-5.6-sol round, HIGH: the git
    // subcommand list was enforced but its flags were not, so
    // `git diff --output=.husky/pre-push HEAD~1 HEAD` and
    // `git show --output=.github/workflows/ci.yml HEAD:package.json` were ALLOW —
    // read-only subcommands overwriting the very files this rule protects.
    //
    // This is a SHAPE rule on purpose, not a list of output flags. Enumerating
    // `-o`/`--output`/`--out-file`/… is the same blocklist mistake made twice
    // already in this file's history, and a blanket `-o` ban would wrongly refuse
    // `grep -o pattern .husky/pre-push`, where the path is a positional operand
    // and nothing is written. The distinction that matters is positional (read)
    // versus flag-value (write), and that holds for flags nobody has invented yet.
    if (flagValueNamesEnforcementSurface(segment)) return false;
    return true;
  };
  const flagValueNamesEnforcementSurface = (segment) => {
    const tokens = String(segment).match(/(?:"[^"]*"|'[^']*'|\S)+/g) || [];
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i].replace(/["']/g, "");
      if (!token.startsWith("-")) continue;
      const inlineValue = token.match(/^--?[\w-]+=(.*)$/);
      if (inlineValue) {
        if (namesEnforcementSurface(inlineValue[1])) return true;
        continue;
      }
      // Space-separated form. Restricted to flags that actually TAKE an output
      // path, because a valueless flag is routinely followed by a positional
      // operand: `git diff --stat .claude/hooks/x.mjs` reads and must stay
      // allowed. This narrow list is a second restriction ON TOP of the
      // fail-closed head allowlist, not the primary defense — an unlisted output
      // flag on an unlisted head is already refused by the head check.
      // @proven-by review-proof-guard.test.mjs (the "git diff --output" deny cases
      // and the "git diff --stat"/"grep -o" allow cases pin both directions).
      if (/^(?:-o|-O|--output|--output-file|--out-file|--out|--dest|--destination|--to|--write-to)$/i.test(token)) {
        const next = tokens[i + 1];
        if (next && namesEnforcementSurface(next.replace(/["']/g, ""))) return true;
      }
    }
    return false;
  };
  // `..` TRAVERSAL. Second review round, HIGH: separators were normalized but dot
  // segments never resolved, so `.claude/commands/../hooks/review-proof-guard.mjs`
  // reaches the real hook while the matcher sees an unguarded path — through BOTH
  // the shell and the path-field channel. The lock this rule replaced resolved
  // traversal for exactly this reason, and not porting it re-opened a bypass its
  // own history had already classified HIGH. A leading `..` that escapes the root
  // is KEPT, never dropped: discarding it would fabricate a different path.
  const resolveDotSegments = (input) => {
    // REPEATED SEPARATORS, collapsed before anything else looks at the path.
    // Seventh gpt-5.6-sol round, P1: `rm -f .github//workflows/ci.yml` and
    // `rm -f .codex//hooks/production-action-guard.mjs` passed the whole registered
    // hook chain. POSIX and Win32 both treat `a//b` as `a/b`, so the write lands on
    // the guarded file while the matcher — which spells the separator exactly once
    // — sees an unguarded path. The early return below used to hand such a path
    // straight back untouched, which is why resolving dot segments alone did not
    // catch it.
    // Belt-and-braces only: the sole caller (namesEnforcementSurface) already
    // collapsed separators, and removing THIS line leaves the suite green — so it
    // protects a future second caller, nothing that exists today. @unproven
    const p = String(input).replace(/\/{2,}/g, "/");
    if (!p.includes("./") && !p.endsWith("/.") && !p.endsWith("/..")) return p;
    const isAbsolute = p.startsWith("/");
    const drive = /^([a-zA-Z]:)(\/.*)?$/.exec(p);
    const body = drive ? (drive[2] || "") : p;
    const out = [];
    for (const seg of body.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        if (out.length && out[out.length - 1] !== "..") out.pop();
        else if (!isAbsolute && !drive) out.push("..");
        continue;
      }
      out.push(seg);
    }
    const joined = out.join("/");
    if (drive) return `${drive[1]}/${joined}`;
    return isAbsolute ? `/${joined}` : joined;
  };
  const namesEnforcementSurface = (text) => {
    // `\` → `/` first, then repeated separators collapsed, so the whole-string test
    // below and every token split out of `flat` both see the canonical path. See
    // the separator note in resolveDotSegments.
    const flat = String(text ?? "").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    if (ENFORCEMENT_SURFACE_RE.test(flat)) return true;
    return flat
      .split(/[\s"'=:;&|()<>]+/)
      .filter(Boolean)
      .some((token) => ENFORCEMENT_SURFACE_RE.test(`/${resolveDotSegments(token)}`));
  };
  const redirectTargetsEnforcementSurface = (v) => {
    for (const m of v.matchAll(/>>?\s*("[^"]*"|'[^']*'|[^\s;&|()<>]+)/g)) {
      if (namesEnforcementSurface(m[1].replace(/["']/g, ""))) return true;
    }
    return false;
  };
  // A command that REDEFINES commands cannot be judged by command name at all.
  // Fifth gpt-5.6-sol round, HIGH: `cat(){ cp /tmp/evil "$1"; }; cat .husky/pre-push`
  // was ALLOW — segments are judged independently, so the second segment's head
  // read as the allowlisted `cat` while the first had already redefined it. The
  // same hole is open to `alias`, and to `eval` assembling the verb at run time.
  // Judged over the WHOLE command, not per segment, because the definition and
  // the call are deliberately in different segments. This denies only commands
  // that ALSO name a protected path, so ordinary shell functions are unaffected.
  // KNOWN OVER-BLOCK, kept on purpose (2026-09-05): the WORD "function" inside a
  // quoted search pattern — `grep -rn "export function" .claude/hooks/x.mjs` — is
  // refused, because the quote-stripped view turns it into `function .claude`
  // (8 refusals in the 2026-09-04 usage audit). Three exact-SHA gpt-5.6-sol
  // rounds rejected every narrowing tried: requiring `(`/`{` after the name
  // missed `function Get-Content # comment\n{`, then `function global:Get-Content
  // <#note#> {`; reading a quotes-removed view missed `x="a\""; function cat {`.
  // Each is a pinned deny case now. The arm stays as broad as it was; the
  // workaround is a bracket class (`"export [f]unction"`), the same one the
  // segment-split over-block below already documents.
  const REDEFINES_COMMANDS_RE =
    /(?:^|[\s;&|(){}])(?:function\s+[\w.:-]+|[\w.-]+\s*\(\s*\)|alias\s|eval\s|source\s|\.\s+\/)/;
  // NESTED EXECUTION. Sixth gpt-5.6-sol round, HIGH: only the OUTER head was
  // inspected, so `echo $(rm -f .husky/pre-push)` was ALLOW — `echo` is
  // allowlisted and the real command hid inside the substitution. Command
  // substitution, process substitution, and backticks all run a program the head
  // check never sees.
  const NESTED_EXECUTION_RE = /\$\(|`|<\(|>\(/;
  // COMMAND RESOLUTION. Same round: `PATH=/tmp:$PATH; cat .husky/pre-push` was
  // ALLOW — the name `cat` stayed allowlisted while pointing at an attacker-placed
  // binary. Anything that changes which program a name resolves to invalidates the
  // allowlist itself, so it is refused alongside the loader variables that achieve
  // the same thing indirectly.
  const COMMAND_RESOLUTION_RE =
    /(?:^|[\s;&|(])(?:export\s+)?(?:PATH|BASH_ENV|ENV|SHELL|IFS|LD_PRELOAD|LD_LIBRARY_PATH|NODE_OPTIONS|PATHEXT)\s*=/i;
  if (destructiveViews.some((v) =>
    redirectTargetsEnforcementSurface(v) ||
    ((REDEFINES_COMMANDS_RE.test(v) || NESTED_EXECUTION_RE.test(v) || COMMAND_RESOLUTION_RE.test(v)) &&
      namesEnforcementSurface(v)) ||
    enforcementSegments(v).some((seg) =>
      namesEnforcementSurface(seg) && !enforcementSegmentIsReadOnly(seg)))) {
    deny("REVIEW PROOF GUARD: shell commands that WRITE to .husky, .github/workflows, .claude/hooks, .codex/hooks, or .coderabbit.yaml are blocked — these decide whether the commit, push, CI, and review gates run at all. Reading them is always allowed (cat/grep/git diff/git show/ls/…); an unrecognized command head naming one of these paths is treated as a writer and denied. Change one deliberately through Edit/Write, which the `ask` tier in .claude/settings.json gates.");
  }
}

// Mutating tools that carry their target in a PATH FIELD rather than a shell
// command — MCP filesystem writers, move/copy tools, patch destinations. Codex
// (2026-09-01, HIGH) listed these alongside the shell bypasses. Native `Write`/
// `Edit` are deliberately NOT denied here: they are the only way a hook file can
// ever be legitimately changed, there is no unlock any more, and denying them
// would permanently strand hook maintenance the way the deleted lock did twice
// in one session. They are gated by the `ask` tier instead. @unproven — that tier
// is mode-dependent: under `dontAsk` it is a real denial, but a session in
// bypass-permissions mode honours neither it nor any allow/deny rule, so native
// writes to these paths are ungated there. Recorded, not hidden; closing it needs
// a boundary outside this repository, which is branch protection.
// Read-only built-ins are exempt as well as the native editors. Fifth
// gpt-5.6-sol round, MEDIUM: this rule applied to EVERY tool except the native
// writers, and the hook is registered under `matcher: "*"`, so `Read`, `Grep`,
// and `Glob` against a protected path were all DENIED — flatly contradicting
// this guard's own message that reading these files is always allowed. The
// deleted lock carried the same exemption and it was not ported; that is the
// third thing lost in that port, so the list is spelled out here rather than
// inferred. Name-matched, never shape-matched: a tool that both reads and writes
// must not appear below.
if (!/^(?:write|edit|notebookedit|multiedit|read|grep|glob|notebookread|ls|todowrite)$/i.test(toolName)) {
  // Dot segments are resolved here too. Second review round, HIGH: an MCP write to
  // `.claude/commands/../hooks/review-proof-guard.mjs` was probe-confirmed ALLOW —
  // the intermediate directory exists, so the filesystem lands on the real hook.
  const resolvePathCandidate = (value) => {
    // Repeated separators collapse here too. The reviewer only demonstrated the
    // shell channel, but this resolver had the identical early return, so an MCP or
    // tool-input write to `.claude//hooks/review-proof-guard.mjs` would have slipped
    // the path-field rule the same way. Fixing one channel and not the other leaves
    // the same defect reachable.
    const p = String(value).replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
    if (!p.includes("./") && !p.endsWith("/.") && !p.endsWith("/..")) return p;
    const isAbsolute = p.startsWith("/");
    const drive = /^([a-zA-Z]:)(\/.*)?$/.exec(p);
    const out = [];
    for (const seg of (drive ? (drive[2] || "") : p).split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        if (out.length && out[out.length - 1] !== "..") out.pop();
        else if (!isAbsolute && !drive) out.push("..");
        continue;
      }
      out.push(seg);
    }
    const joined = out.join("/");
    if (drive) return `${drive[1]}/${joined}`;
    return isAbsolute ? `/${joined}` : joined;
  };
  const enforcementPathHit = pathCandidates.some((candidate) => {
    if (candidate == null) return false;
    return /(?:^|\/)(?:\.husky|\.github\/workflows|\.codex\/(?:hooks|config\.toml)|\.claude\/(?:hooks|settings(?:\.local)?\.json)|\.coderabbit\.ya?ml|scripts\/(?:(?:check|validate|verify)-[^/]*|write-codex-push-proof\.mjs|run-claude-review\.mjs|remove-applied-ledger-entry\.mjs|agent-manifest-parity\.mjs|sync-agent-workflows\.mjs))(?![\w-])/i
      .test(`/${resolvePathCandidate(candidate)}`);
  });
  if (enforcementPathHit) {
    deny("REVIEW PROOF GUARD: this tool would write to .husky, .github/workflows, .claude/hooks, .codex/hooks, or .coderabbit.yaml through a path field. These decide whether the commit, push, CI, and review gates run at all. Use Edit/Write for a deliberate change, which the `ask` tier in .claude/settings.json gates.");
  }
}
if (shellTool && reviewStateDirectoryMentioned(hookCwd)) {
  deny("REVIEW PROOF GUARD: shell commands from the wrapper-owned review state directory are blocked. Return to the repository root and run the real review wrapper.");
}

process.exit(0);
