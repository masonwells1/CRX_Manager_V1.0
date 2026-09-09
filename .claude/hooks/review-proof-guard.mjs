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
import { trimWin32Segment, hasShortNameSegment } from "./autopilot-lib.mjs";

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
  input.notebook_path,
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
if (stateDirCandidates.length > 0 && !isPureAckWrite) {
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
function shellBaseViews(cmd) {
  const base = decodeAnsiCQuotes(String(cmd || "")).replace(/[\\`]\r?\n/g, "");
  const stripQuotes = (v) => v.replace(/["']/g, "");
  const dropBackslash = (v) => v.replace(/\\(.)/g, "$1");
  return [base, stripQuotes(base), dropBackslash(base), dropBackslash(stripQuotes(base))];
}
// SHELL VARIABLES. GitHub Codex P1 on 6e3f1bd36, probe-confirmed: `d=.claude; printf x >
// "$d/hooks/review-proof-guard.mjs"` and `n=package; printf '{}' > "$n.json"` passed the whole
// registered Bash hook chain, because every matcher here reads the literal command text and the
// protected name was assembled at run time.
//
// The first fix RESOLVED same-command assignments before matching. Codex gpt-5.6-sol High
// (CRX-SEC-002 on 5f69ecc2d) broke it: the parser scanned raw text, so assignment-shaped text
// the shell never executes — inside single quotes, a comment, an argument — forged a value and
// the guard substituted the HARMLESS one while the real destination still reached the shell. A
// parser that must model quoting, execution position and scope to stay safe is the wrong shape
// for a deny guard: every gap in it is an allow.
//
// So there is no parser. An expansion in a write destination is simply unreadable, and
// unreadable fails closed (the rule at the enforcement-surface deny below). Spell the
// destination out. This refuses `printf x > "$LOG"` and `d=/tmp/s; printf x > "$d/out.log"`
// too, which is the accepted cost: reads are untouched, and a literal path is always available.
function shellCommandViews(cmd) {
  return shellBaseViews(cmd);
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
  // PR #605 (gpt-5.6-sol HIGH on 02b342610): the migration-proof minter's inputs -
  // `.claude/agents/**` (reviewer charters run as machine-verdict Codex reviews),
  // `scripts/write-apply-proofs.mjs`, and `scripts/write-apply-proofs-lib.mjs` - were
  // gated only for native editors via the settings `ask` tier; `Set-Content` to all
  // three was probe-confirmed ALLOW here. A weakened charter mints a clean proof for a
  // LIVE apply, before any merge-time review, so they join both patterns below.
  // `.claude/launch.json` (GitHub Codex P1 on 8179ae989): `mcp__Claude_Browser__preview_start`
  // executes the `runtimeExecutable`/`runtimeArgs` that file names, so a shell or
  // path-field rewrite of it followed by preview_start ran any command outside every
  // Bash hook. Reading it stays allowed.
  // protected-surface-parity.test.mjs (PR #605, round twelve) derived the rest from one
  // question - what does a gate producer read from the working tree at decision time?
  // `.claude/schema-registry.json` (three SQL PreToolUse hooks and the migration review
  // packet), `.claude/caller-graph.json` (grant-change-guard), and `package.json` (the
  // scripts CI and husky run) were native-editor protected but shell-writable here. The
  // generators that rewrite the first two (`node scripts/regenerate-schema-registry.mjs`,
  // `node scripts/generate-caller-graph.mjs`) never name their output on the command
  // line, so they are unaffected; `npm install`/`npm pkg set` never name package.json.
  // Round thirteen widened it again, by shape rather than by the file that got caught:
  // `.claude/commands`, `.claude/skills` and `.claude/workflows` all reach CI - the two
  // `.test.mjs` files under workflows and `check-agent-workflows.mjs` run inside
  // `npm run test:agent-workflows` (package.json:57, ci.yml:468, .husky/pre-commit:43),
  // and `check-agent-guidance.mjs` reads `commands/preflight.md`, `commands/ship.md` and
  // `skills/graphify/SKILL.md` by name. A defanged test still turns the CI row green, so
  // the gate does not fail, it lies. `.codex` is now matched bare, the way `.husky` is:
  // `sync-from-claude.ps1` was the last unprotected entry in a directory whose other
  // three were already covered, and it writes into `.codex/hooks/**` (an agent that
  // needs to run it does so outside the Bash tool, or edits the outputs deliberately).
  const ENFORCEMENT_SURFACE_RE =
    /(?:^|[\s"'=:/\\(])(?:\.husky|\.github[/\\]workflows|\.codex|\.claude[/\\](?:hooks|agents|commands|skills|workflows|launch\.json|schema-registry\.json|caller-graph\.json|settings(?:\.local)?\.json)|\.coderabbit\.ya?ml|package\.json|scripts[/\\](?:(?:check|validate|verify)-[^\s"']*|write-codex-push-proof\.mjs|write-apply-proofs(?:-lib)?\.mjs|run-claude-review\.mjs|remove-applied-ledger-entry\.mjs|agent-manifest-parity\.mjs|sync-agent-workflows\.mjs))(?![\w-])/i;
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
    // Staging/committing record content; they do not alter it. `worktree` is a
    // NAMESPACE whose only reader is `list`; see the sub === "worktree" rule below.
    "add", "commit", "push", "worktree",
  ]);
  // The action word after `git worktree` (options skipped), or null.
  const gitWorktreeActionOf = (segment) => {
    const tokens = String(segment).match(/(?:"[^"]*"|'[^']*'|\S)+/g) || [];
    const w = tokens.findIndex((t) => t.replace(/["']/g, "").toLowerCase() === "worktree");
    if (w < 0) return null;
    for (let i = w + 1; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token.startsWith("-")) continue;
      return token.replace(/["']/g, "").toLowerCase();
    }
    return null;
  };
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
  // `gh` is a NAMESPACE, not a reader. GitHub Codex P1 on c94e16dc7, probe-confirmed:
  // `gh gist clone <gist> [<dir>]` and `gh repo clone <repo> [<dir>]` materialise files at
  // the named directory, `gh run download --dir` / `gh release download --dir` write into
  // it, `gh repo fork --clone` and `gh extension install` write too, yet the whole
  // command sat in the read-only set. Only an allowlist of READ verbs (view, list,
  // status, checks, diff, watch, browse, search) or a read-only command (`api`,
  // `search`, `status`, `browse`, `auth status`, `help`) is vouched for; any other
  // verb, including one this rule has never heard of, is a writer of the paths it
  // names (fail closed). Global options that take a value (`-R/--repo`, `--hostname`)
  // are skipped so they cannot pose as the command word.
  const GH_READ_COMMANDS = new Set(["api", "search", "status", "browse", "help", "version", "--version", "--help"]);
  const GH_READ_VERBS = new Set(["view", "list", "ls", "status", "checks", "diff", "watch", "browse", "search", "help"]);
  const GH_VALUE_OPTIONS = new Set(["-R", "--repo", "--hostname"]);
  const ghIsReadOnly = (segment) => {
    const tokens = String(segment).replace(/["'`]/g, " ").split(/\s+/).filter(Boolean).slice(1);
    let i = 0;
    while (i < tokens.length && tokens[i].startsWith("-")) {
      const name = tokens[i].split("=")[0];
      if (GH_VALUE_OPTIONS.has(name) && !tokens[i].includes("=")) i += 2; else i += 1;
    }
    const command = (tokens[i] || "").toLowerCase();
    if (command === "") return true;                                   // bare `gh`
    if (GH_READ_COMMANDS.has(command)) return true;
    if (command === "auth") return (tokens[i + 1] || "").toLowerCase() === "status";
    const verb = (tokens.slice(i + 1).find((t) => !t.startsWith("-")) || "").toLowerCase();
    return GH_READ_VERBS.has(verb);
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
    if (head === "gh" && !ghIsReadOnly(segment)) return false;
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
      // `git worktree` is a NAMESPACE, not a reader. GitHub Codex P1 on 06f0039a2:
      // `add` and `move` POPULATE the path they are given — `git worktree add --detach
      // .claude/skills/probe <sha>` materialises a committed SKILL.md under a protected
      // directory with no approval — and `remove` deletes it, yet the whole namespace
      // sat in the read-only set. Only `list` is vouched for; every other action, and
      // an unknown one, is a writer of the paths it names (fail closed).
      if (sub === "worktree" && gitWorktreeActionOf(segment) !== "list") return false;
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
  // The resolver itself is resolvePathCandidate() below (a hoisted function shared with the
  // path-field rule): one algorithm, one output contract, both channels. It was two identical
  // copies until CodeRabbit (Trivial on 60910c005) asked for one; the Win32 segment rules
  // live in autopilot-lib's trimWin32Segment() so armed autopilot cannot drift either.
  const namesEnforcementSurface = (text) => {
    // `\` → `/` first, then repeated separators collapsed, so the whole-string test
    // below and every token split out of `flat` both see the canonical path. See
    // the separator note in resolvePathCandidate.
    const flat = String(text ?? "").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    if (ENFORCEMENT_SURFACE_RE.test(flat)) return true;
    const loose = flat.split(/[\s"'=:;&|()<>]+/).filter(Boolean);
    // A QUOTED argument is one path to the shell even with a space inside it, and the
    // resolver folds a `.. ` segment onto `..` (CodeRabbit Major on 60910c005), so
    // `cp /tmp/evil ".claude/worktrees/.. /hooks/x.mjs"` must be judged as ONE path that
    // canonicalises onto the hook, while the whitespace split above sees two harmless halves.
    // Quote-aware tokens are judged too (deny-only: it can only add a match).
    const quoted = (flat.match(/(?:"[^"]*"|'[^']*'|\S)+/g) || []).map((t) => t.replace(/["']/g, ""));
    return [...loose, ...quoted].some((token) => ENFORCEMENT_SURFACE_RE.test(`/${resolvePathCandidate(token)}`));
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
  const REDEFINES_COMMANDS_RE =
    /(?:^|[\s;&|(){}])(?:function\s+[\w.-]+|[\w.-]+\s*\(\s*\)|alias\s|eval\s|source\s|\.\s+\/)/;
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
  // UNREADABLE WRITE DESTINATIONS (GitHub Codex P1 on 6e3f1bd36; see shellAssignments at the
  // top of this file). Judged on the RESOLVED views only, so a variable assigned in the same
  // command has already been substituted and is not what is caught here. What remains is a
  // destination the guard cannot read, and this is a self-certification gate, so it fails
  // closed by shape rather than by guessing:
  //   1. a redirect (`>`, `>>`) whose target still carries any expansion — `$d`, `${d}`,
  //      `$(…)`, a backtick, `%d%` — whatever the head;
  //   2. in a segment whose head is not a recognised reader (and not a shell control word,
  //      which writes nothing itself), a token that carries a COMPUTED expansion — command
  //      substitution, a backtick, or any `${…}` form other than a plain name — or a plain
  //      variable glued to a path fragment (`$d/hooks/x.mjs`, `$n.json`, `%d%\x`).
  // Known over-blocks, accepted on this file's standing rule that a false refusal is the
  // cheaper failure: `printf x > "$TEMP/scratch.log"` (assign the path in the same command or
  // spell it out), `npm run build -- --out=$DIR/dist`, `gh pr merge … --match-head-commit
  // $(git rev-parse HEAD)` (pass the literal SHA; that is the exact-head discipline anyway).
  // Readers are unaffected: `echo "$d/hooks/x"`, `cat "$(git rev-parse --show-toplevel)/…"`,
  // `node scripts/x.mjs "$(cat f)"` and `for f in $(git ls-files); do …` all stay allowed.
  // Residual, stated: a plain variable NOT glued to a path shape (`cp /tmp/evil "$dst"`) is
  // an environment variable by construction (same-command assignments are resolved), and the
  // user's environment is not an in-command channel this rule has to read.
  const UNRESOLVED_EXPANSION_RE = /[$`]|%[A-Za-z_][A-Za-z0-9_]*%|~\d/;
  const COMPUTED_EXPANSION_RE = /\$\(|`|<\(|>\(|\$\{(?![A-Za-z_][A-Za-z0-9_]*\})/;
  const PLAIN_VARIABLE_ON_PATH_RE = /(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$env:[A-Za-z_][A-Za-z0-9_]*|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%)(?:[\\/]|\.[A-Za-z0-9]+(?![A-Za-z0-9_]))/;
  // Words that PRECEDE the real command in a segment (`do cp …`, `then tee …`, `{ cp …`,
  // `time cp …`) are stepped over so the write behind them is judged; a segment that is
  // ONLY control flow (`for f in $(…)`, `fi`, `done`) writes nothing and is skipped.
  const SHELL_PREFIX_WORDS = new Set(["do", "then", "else", "{", "(", "!", "time", "elif"]);
  const SHELL_CONTROL_HEADS = new Set([
    "for", "while", "until", "if", "fi", "done", "case", "esac", "in", "select", "function",
    "[", "[[", "}", ")", "export", "local", "declare", "readonly", "typeset", "unset",
    "shift", "break", "continue", "return", "exit", ":", "set",
  ]);
  const redirectTargetUnreadable = (v) => {
    for (const m of v.matchAll(/>>?\s*("[^"]*"|'[^']*'|[^\s;&|()<>]+)/g)) {
      if (UNRESOLVED_EXPANSION_RE.test(m[1])) return true;
    }
    return false;
  };
  const writerSegmentUnreadable = (segment) => {
    const words = String(segment).trim().split(/\s+/);
    // A leading `NAME=value` is an environment prefix (`FOO=1 cp …`), not the command.
    let k = 0;
    while (k < words.length && (SHELL_PREFIX_WORDS.has(words[k].toLowerCase()) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]))) k += 1;
    const body = words.slice(k).join(" ");
    const head = (words[k] || "").toLowerCase();
    if (!head || SHELL_CONTROL_HEADS.has(head)) return false;
    if (enforcementSegmentIsReadOnly(body)) return false;
    const tokens = body.match(/(?:"[^"]*"|'[^']*'|\S)+/g) || [];
    return tokens.some((raw) => {
      const token = raw.replace(/["']/g, "");
      return COMPUTED_EXPANSION_RE.test(token) || PLAIN_VARIABLE_ON_PATH_RE.test(token)
        || hasShortNameSegment(token);
    });
  };
  const unreadableWriteDestination = (v) =>
    redirectTargetUnreadable(v) || enforcementSegments(v).some(writerSegmentUnreadable);
  if (destructiveViews.some(unreadableWriteDestination)) {
    deny("REVIEW PROOF GUARD: this shell command writes to a destination the guard cannot read — a redirect target or a write command's argument built from a variable, command substitution, or parameter expansion that is not assigned in the same command. The protected-path rules judge the literal text, so an assembled path could reach .claude/hooks, package.json, or the other gate files unseen. Spell the destination out and re-run. A DOS 8.3 short name (`CLAUDE~1`, `MIGRAT~1`) is refused the same way: it opens the real file but matches no protected pattern, so the long path is required.");
  }
  if (destructiveViews.some((v) =>
    redirectTargetsEnforcementSurface(v) ||
    ((REDEFINES_COMMANDS_RE.test(v) || NESTED_EXECUTION_RE.test(v) || COMMAND_RESOLUTION_RE.test(v)) &&
      namesEnforcementSurface(v)) ||
    enforcementSegments(v).some((seg) =>
      namesEnforcementSurface(seg) && !enforcementSegmentIsReadOnly(seg)))) {
    deny("REVIEW PROOF GUARD: shell commands that WRITE to .husky, .github/workflows, .claude/hooks, .claude/agents, .claude/commands, .claude/skills, .claude/workflows, .claude/launch.json, .claude/schema-registry.json, .claude/caller-graph.json, .codex, .coderabbit.yaml, package.json, or the check/validate/proof/parity scripts are blocked — these decide whether the commit, push, CI, and review gates run at all. Reading them is always allowed (cat/grep/git diff/git show/ls/…); an unrecognized command head naming one of these paths is treated as a writer and denied. Change one deliberately through Edit/Write; the permission tiers in .claude/settings.json decide whether that native edit proceeds, prompts, or is refused, and every one of these paths is a risky path that cannot merge without the exact-SHA Codex proof.");
  }

  // PACKAGE-MANAGER WRITES TO package.json THAT NEVER NAME IT. CodeRabbit on
  // 18d1bee17 (review 5126628334, Major, PR #605): the path rule above protects
  // package.json, but `npm install left-pad`, `npm uninstall`, `npm pkg set` and
  // `npm version patch` rewrite it without the file name ever appearing in the
  // command — the comment at the top of ENFORCEMENT_SURFACE_RE documented exactly
  // that gap, and the test pinned `npm install left-pad` as ALLOW. All four were
  // probe-confirmed silent before this fix.
  //
  // Matched by SHAPE, not by listing four npm spellings: any package-manager head
  // (npm/pnpm/yarn/bun, path-qualified or .cmd, optionally behind `corepack` or a
  // leading VAR=value), then a subcommand FAMILY that writes the manifest. A name
  // list inherits its own omissions — the failure mode this file has already paid
  // for twice — so families, aliases and the other three managers are covered
  // together. @proven-by review-proof-guard.test.mjs (both forms: the deny block
  // and the allow block below it).
  //   deny : <pm> install|i|add|link <positional>   adds a dependency
  //          <pm> uninstall|remove|rm|un|unlink     always rewrites the manifest
  //          <pm> update|up|upgrade                 npm >= 7 saves the new ranges
  //          <pm> pkg set|delete|fix, <pm> init, <pm> set-script
  //          <pm> version <bump> (and bare `yarn version`, which prompts and writes)
  //          <pm> create, patch-commit, unplug, `yarn set`, `audit fix`, `dedupe|prune --save`
  //          <pm> <any non-script subcommand> fix|--fix (`yarn constraints --fix`)
  //          <pm> exec|x|dlx|workspace … <writing word>, and ANY subcommand the rule does
  //          not know (fail closed, PM_READ_OR_RUN is the allowlist)
  //   allow: installing FROM the manifest (`npm install`, `npm ci`, `pnpm install`,
  //          `yarn`, `bun install`), `--no-save`, `-g`/`--global`, `npm run`,
  //          `npm test`, `npm pkg get`, bare `npm version` (prints), `npx`.
  // Known over-blocks, accepted on this file's standing rule that a false refusal is
  // the cheaper failure: a value-taking flag before the package name (`--registry
  // <url>`) reads as a positional; bare `pnpm update` / `yarn upgrade` are refused
  // even where the lockfile alone would change. Use `--no-save` or edit package.json.
  // A versioned DESCRIPTOR (`pnpm@latest`, `yarn@4.1.0`) is the same manager: Corepack and
  // npx accept it in place of the bare name (GitHub Codex P1 on c94e16dc7).
  const PACKAGE_MANAGER_RE = /^(?:.*[/\\])?(?:npm|pnpm|yarn|bun)(?:\.cmd|\.exe|\.ps1)?(?:@[^\s/\\]+)?$/i;
  // Corepack itself: `corepack use <desc>` assigns the release to package.json and installs;
  // `corepack up` rewrites the same field. `enable`/`disable`/`prepare`/`hydrate`/`pack`/
  // `cache`/`install` touch the shim store, not the manifest. A subcommand in neither set is
  // refused (fail closed); a manager descriptor after `corepack` is classified as a manager.
  const COREPACK_MANIFEST_WRITERS = new Set(["use", "up"]);
  const COREPACK_READ_OR_RUN = new Set(["enable", "disable", "prepare", "hydrate", "pack", "cache", "install", "help", "--version", "-v", "--help", "-h"]);
  const PM_ADD_FAMILY = new Set(["install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "add", "a", "link", "ln"]);
  const PM_REMOVE_FAMILY = new Set(["uninstall", "unlink", "remove", "rm", "r", "un"]);
  const PM_UPDATE_FAMILY = new Set(["update", "up", "upgrade", "udpate", "upgrade-interactive"]);
  // `trust` writes trustedDependencies into package.json (bun pm trust <pkg>).
  const PM_MANIFEST_EDITORS = new Set(["init", "innit", "create", "set-script", "patch-commit", "unplug", "trust"]);
  const PM_NO_MANIFEST_RE = /(?:^|\s)(?:--no-save|-g|--global|--location(?:=|\s+)global)(?=\s|$)/i;
  const PM_VALUE_OPTIONS = new Set(["--prefix", "--cwd", "--dir", "--directory", "-C", "--registry", "--cache", "--userconfig", "--globalconfig", "--location", "--workspace", "-w", "--filter", "-F"]);
  const PM_BOOLEAN_OPTIONS = new Set(["-g", "--global", "--no-save", "--silent", "-s", "--verbose", "--version", "-v", "--help", "-h"]);
  // Subcommands that never write package.json. A subcommand that is in NEITHER this set
  // NOR a writing family is REFUSED (fail closed) — Codex gpt-5.6-sol High on fc36b2d28:
  // `npm audit fix` and `npm dedupe --save` were unknown to the rule and passed. A new
  // read-only subcommand is added here deliberately, with its proof; an unknown one costs a
  // refusal, never a silent manifest write.
  const PM_READ_OR_RUN = new Set([
    "run", "run-script", "rum", "urn", "test", "t", "tst", "start", "stop", "restart",
    "ci", "clean-install", "ic", "install-clean", "isntall-clean", "install-ci-test", "cit", "clean-install-test", "sit", "install-test", "it",
    "view", "v", "info", "show", "ls", "list", "ll", "la", "outdated", "ping", "whoami", "doctor", "help", "help-search",
    "explain", "why", "fund", "search", "s", "se", "find", "root", "prefix", "bin", "docs", "home", "repo", "bugs", "issues",
    "cache", "rebuild", "rb", "prune", "dedupe", "ddp", "find-dupes", "diff", "pack", "publish", "unpublish", "owner", "author",
    "access", "deprecate", "undeprecate", "dist-tag", "dist-tags", "star", "unstar", "stars", "team", "org", "profile", "login",
    "logout", "adduser", "add-user", "completion", "token", "hook", "sbom", "query", "audit", "config", "c", "get",
    "licenses", "store", "fetch", "env", "setup", "server", "node", "plugin", "constraints", "stage", "check", "autoclean",
    "policies", "import", "build", "info", "npm",
    // bun pm read-only leaves (bun pm ls / bin / cache / hash / whoami / view / untrusted).
    "hash", "hash-string", "hash-print", "untrusted", "default-trusted",
  ]);
  // `pm` is a NAMESPACE (bun pm pkg set, bun pm version, bun pm trust), not a subcommand.
  // Codex gpt-5.6-sol High on cbd986732: it sat in PM_READ_OR_RUN, so `bun pm pkg set
  // scripts.test=…` was "not a manifest write" while `npm pkg set` denied. What follows
  // `pm` is now classified as if the manager had been invoked directly, so every rule
  // above (pkg get vs set/delete/fix, version <bump>, trust, unknown → refuse) applies.
  const PM_NAMESPACES = new Set(["pm"]);
  // Launcher subcommands run OTHER programs: what follows them is classified too (see
  // PM_LAUNCHERS below), and a nested manager token is classified in its own right.
  const PM_LAUNCHERS = new Set(["exec", "x", "explore", "dlx", "workspace", "workspaces", "w"]);
  // `audit fix` rewrites overrides/dependencies; `dedupe`/`prune` write only under --save.
  const PM_SAVE_SENSITIVE = new Set(["dedupe", "ddp", "find-dupes", "prune"]);
  // Script runners hand their arguments to the project's own script: `npm run lint -- --fix`
  // and `npm test -- --fix` are the script's flags, not the manager's, so the FIX rule
  // below does not read them.
  const PM_SCRIPT_RUNNERS = new Set(["run", "run-script", "rum", "urn", "test", "t", "tst", "start", "stop", "restart"]);
  const isWritingWord = (t) => PM_ADD_FAMILY.has(t) || PM_REMOVE_FAMILY.has(t) || PM_UPDATE_FAMILY.has(t)
    || PM_MANIFEST_EDITORS.has(t) || t === "pkg" || t === "version" || t === "audit";
  const classifyFrom = (tokens, i) => {
    const manager = tokens[i].replace(/^.*[/\\]/, "").replace(/\.(?:cmd|exe|ps1)$/i, "").replace(/@.*$/, "").toLowerCase();
    const rest = tokens.slice(i + 1);
    let subIndex = 0;
    while (subIndex < rest.length && rest[subIndex].startsWith("-")) {
      const option = rest[subIndex];
      const name = option.split("=")[0];
      if (PM_VALUE_OPTIONS.has(name)) subIndex += option.includes("=") ? 1 : 2;
      else if (PM_BOOLEAN_OPTIONS.has(option)) subIndex += 1;
      else return true; // Unknown leading options cannot hide the subcommand.
    }
    if (subIndex >= rest.length) return false;                                        // bare `yarn`, `npm --version`
    const sub = rest[subIndex].toLowerCase();
    const after = rest.slice(subIndex + 1);
    const positionals = after.filter((t) => !t.startsWith("-"));
    // A competing save/global option may override an earlier exemption. Refuse
    // ambiguous combinations instead of assuming --no-save or -g always wins.
    const competingSave = tokens.some((t) => /^(?:--save(?:[=-]|$)|-[SDEO]$|--global=|--location(?:=|$))/.test(t));
    const noManifest = PM_NO_MANIFEST_RE.test(tokens.join(" ")) && !competingSave;
    if (PM_NAMESPACES.has(sub)) return after.length > 0 && classifyFrom([manager, ...after], 0);
    if (PM_MANIFEST_EDITORS.has(sub)) return true;
    if (sub === "pkg") return (positionals[0] || "").toLowerCase() !== "get";
    if (sub === "version") return manager === "yarn" || after.length > 0;
    if (sub === "set") return manager === "yarn";                                       // `yarn set version` writes packageManager; npm/pnpm `set` is config
    // A subcommand asked to FIX rewrites what it checks. GitHub Codex P1 on 6e3f1bd36's
    // diff: `yarn constraints --fix` persists every changed workspace manifest (Yarn 4
    // documents --fix as automatically fixing unambiguous issues), yet `constraints` sat
    // in the read/run allowlist and the FIX check below was written for `audit` alone.
    // The rule is now the class: a `fix` word or `--fix*` flag after ANY non-script-runner
    // subcommand (`audit fix`, `constraints --fix`, `pkg fix`) is a manifest write.
    // `npm config fix` over-blocks (it writes .npmrc); accepted on this file's standing rule.
    // A LAUNCHER runs another program, so `--fix` after it belongs to that program
    // (`npm exec -- eslint --fix`, `pnpm exec eslint --fix`) — CodeRabbit Minor on
    // 60910c005: the FIX check below ran first and refused both. The launcher rule
    // still refuses a nested manifest write (`npm exec -- npm pkg fix`, `… npm audit fix`)
    // because `pkg`/`audit` are writing words, and a nested manager token is classified
    // in its own right by packageManagerWritesManifest.
    if (PM_LAUNCHERS.has(sub)) return after.some((t) => !t.startsWith("-") && isWritingWord(t.toLowerCase()));
    if (!PM_SCRIPT_RUNNERS.has(sub) && (positionals.some((t) => t.toLowerCase() === "fix") || after.some((t) => /^--fix/i.test(t)))) return true;
    if (PM_SAVE_SENSITIVE.has(sub)) return competingSave;
    if (PM_REMOVE_FAMILY.has(sub)) return !noManifest;
    if (PM_UPDATE_FAMILY.has(sub)) return !noManifest;
    if (PM_ADD_FAMILY.has(sub)) return positionals.length > 0 && !noManifest;
    if (PM_READ_OR_RUN.has(sub)) return false;
    return true;                                                                        // unknown subcommand: fail closed
  };
  const packageManagerWritesManifest = (segment) => {
    const text = String(segment ?? "");
    // Quotes are dropped and the text re-split so a manager hidden inside a quoted
    // wrapper argument (`sh -c 'npm install x'`) is seen as its own tokens.
    const tokens = text.replace(/["'`]/g, " ").split(/\s+/).filter(Boolean);
    // Wrapper-agnostic and position-agnostic (Codex gpt-5.6-sol High on 8ac85002d and
    // on fc36b2d28): the manager may sit behind ANY launcher — `cmd /c`, `sh -c`,
    // `powershell -Command`, `npx`, `env`, `command`, `nice`, `corepack`, a VAR=value
    // prefix, or another manager's `exec` — and a launcher list would inherit its own
    // omissions, so EVERY token that names a package manager is classified, and one
    // writing classification denies. Known over-block, accepted on this file's standing
    // rule: text that merely quotes such a command (`git commit -m "npm install x"`,
    // `grep "npm add x"`) is refused too; reword it. Accepted residual, beyond any
    // lexical hook: arbitrary code (`npx <tool>`, `node -e`) can write any file — that
    // is what the exact-SHA Codex review and the parity test stand for.
    // A descriptor that is an ARGUMENT of a Corepack subcommand (`corepack prepare pnpm@9
    // --activate`, `corepack use pnpm@latest`) is not a manager invocation of its own; it is
    // judged by the Corepack rule below, not classified as if `pnpm@9 --activate` had been run.
    const corepackArgs = new Set();
    for (let i = 0; i < tokens.length; i += 1) {
      const base = tokens[i].replace(/^.*[/\\]/, "").replace(/\.(?:cmd|exe|ps1)$/i, "").toLowerCase();
      if (base !== "corepack") continue;
      const subIndex = tokens.findIndex((t, k) => k > i && !t.startsWith("-"));
      if (subIndex < 0) continue;
      const sub = tokens[subIndex].toLowerCase();
      if (!COREPACK_MANIFEST_WRITERS.has(sub) && !COREPACK_READ_OR_RUN.has(sub)) continue;
      for (let k = subIndex + 1; k < tokens.length; k += 1) {
        if (/^(?:npm|pnpm|yarn|bun)@/i.test(tokens[k])) corepackArgs.add(k);
      }
    }
    for (let i = 0; i < tokens.length; i += 1) {
      if (!corepackArgs.has(i) && PACKAGE_MANAGER_RE.test(tokens[i]) && classifyFrom(tokens, i)) return true;
      const base = tokens[i].replace(/^.*[/\\]/, "").replace(/\.(?:cmd|exe|ps1)$/i, "").toLowerCase();
      if (base === "corepack") {
        const next = tokens.slice(i + 1).find((t) => !t.startsWith("-")) || "";
        const sub = next.toLowerCase();
        if (sub === "") continue;                                   // `corepack --version`
        if (COREPACK_MANIFEST_WRITERS.has(sub)) return true;
        if (PACKAGE_MANAGER_RE.test(next)) continue;                // the descriptor is classified on its own turn
        if (!COREPACK_READ_OR_RUN.has(sub)) return true;            // unknown subcommand: fail closed
      }
    }
    return false;
  };
  if (destructiveViews.some((v) => enforcementSegments(v).some(packageManagerWritesManifest))) {
    deny("REVIEW PROOF GUARD: package-manager commands that rewrite package.json are blocked — `npm install <pkg>`, `npm uninstall`, `npm update`, `npm pkg set`, `npm version <bump>`, `npm init` and the pnpm/yarn/bun equivalents edit the scripts and dependency list that CI and husky run from without ever naming the file. Installing FROM the manifest stays allowed (`npm install`, `npm ci`, `pnpm install`, `yarn`), as do `--no-save`, `-g`, `npm run`, `npm test`, `npm pkg get`, `npm audit`, `npm ls`, `npm view`; a subcommand this rule does not know is refused rather than guessed. `corepack use`/`corepack up` and a versioned descriptor (`pnpm@latest add x`) are the same writes under another name. Add or remove a dependency deliberately through Edit/Write on package.json, where the permission tiers in .claude/settings.json decide; package.json is a risky path that cannot merge without the exact-SHA Codex proof.");
  }
}

// Mutating tools that carry their target in a PATH FIELD rather than a shell
// command — MCP filesystem writers, move/copy tools, patch destinations. Codex
// (2026-09-01, HIGH) listed these alongside the shell bypasses. Native `Write`/
// `Edit` are deliberately NOT denied here: they are the only way a hook file can
// ever be legitimately changed, there is no unlock any more, and denying them
// would permanently strand hook maintenance the way the deleted lock did twice
// in one session. Whether a native edit to these paths proceeds, prompts, or is
// refused is decided by the permission tiers in .claude/settings.json (see the
// 2026-09-05 changelog entries for the current tiering). @unproven — any tier
// there is mode-dependent: a session in bypass-permissions mode honours neither
// it nor any allow/deny rule, so native writes to these paths are ungated there.
// Recorded, not hidden; closing it needs a boundary outside this repository,
// which is branch protection plus the risky-path exact-SHA Codex proof at merge.
// Read-only built-ins are exempt as well as the native editors. Fifth
// gpt-5.6-sol round, MEDIUM: this rule applied to EVERY tool except the native
// writers, and the hook is registered under `matcher: "*"`, so `Read`, `Grep`,
// and `Glob` against a protected path were all DENIED — flatly contradicting
// this guard's own message that reading these files is always allowed. The
// deleted lock carried the same exemption and it was not ported; that is the
// third thing lost in that port, so the list is spelled out here rather than
// inferred. Name-matched, never shape-matched: a tool that both reads and writes
// must not appear below.
// The enforcement surface as a path-field regex (shared by the non-native rule below and the
// native-editor canonical-spelling rule after it).
const ENFORCEMENT_PATH_FIELD_RE = /(?:^|\/)(?:\.husky|\.github\/workflows|\.codex|\.claude\/(?:hooks|agents|commands|skills|workflows|launch\.json|schema-registry\.json|caller-graph\.json|settings(?:\.local)?\.json)|\.coderabbit\.ya?ml|package\.json|scripts\/(?:(?:check|validate|verify)-[^/]*(?:\/[^/]*)*|write-codex-push-proof\.mjs|write-apply-proofs(?:-lib)?\.mjs|run-claude-review\.mjs|remove-applied-ledger-entry\.mjs|agent-manifest-parity\.mjs|sync-agent-workflows\.mjs))(?![\w-])/i;
// Dot segments are resolved here too. Second review round, HIGH: an MCP write to
// `.claude/commands/../hooks/review-proof-guard.mjs` was probe-confirmed ALLOW —
// the intermediate directory exists, so the filesystem lands on the real hook.
function resolvePathCandidate(value) {
  // Codex gpt-5.6-sol High on b2988f2da, probe-confirmed: Win32 path ALIASES reached the
  // protected files past the canonical-spelling rule. Windows drops a drive-RELATIVE
  // prefix onto the drive's current directory (`C:.claude/hooks/x.mjs` opens
  // `.claude/hooks/x.mjs`), and its path normaliser strips trailing periods and spaces
  // from every segment before the file system sees the name (`.claude/hooks./x.mjs`,
  // `.claude/settings.json.`, `x.mjs ` all open the real file; probe-confirmed with
  // Get-Item on 2026-09-03 for the sibling canonicaliser in production-action-guard,
  // whose rules this now mirrors). A drive-relative prefix is DROPPED (the spelling is
  // then non-canonical by construction); a rooted drive (`C:/…`) is kept, because that
  // is the spelling the native editors send on this machine and the settings globs are
  // measured against it. Trailing periods and spaces are stripped from every segment
  // and a segment left empty is dropped — deliberately over-inclusive, which for a
  // deny-guard can only over-block. NTFS ALTERNATE DATA STREAMS (Codex gpt-5.6-sol High on
  // d1bbf5ac6, probe-confirmed: `package.json::$DATA`, `.claude/settings.json::$DATA` and
  // `scripts/write-codex-push-proof.mjs::$DATA` resolve to the real files): a colon inside a
  // segment names a stream of that file, so the segment is cut at its first colon (the
  // rooted drive `C:` is handled before the walk and never reaches it); a `\\?\` or `\\.\`
  // device prefix in front of a drive is dropped. Repeated separators still collapse first (seventh
  // gpt-5.6-sol round, P1: `rm -f .github//workflows/ci.yml` passed the whole chain), and
  // there is no early return any more: every spelling goes through the segment walk.
  const p = String(value).trim().replace(/\\/g, "/").replace(/^\/\/[?.]\/(?=[A-Za-z]:)/, "").replace(/\/{2,}/g, "/");
  const drive = /^([a-zA-Z]:)(\/?)/.exec(p);
  const rooted = drive ? drive[2] === "/" : p.startsWith("/");
  const body = drive ? p.slice(drive[0].length) : p;
  const out = [];
  for (const raw of body.split("/")) {
    // Win32 segment rules (stream suffix, trailing period/space, `.. ` folded onto `..`) are
    // applied BEFORE the dot check — see trimWin32Segment in autopilot-lib.mjs.
    const seg = trimWin32Segment(raw);
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!rooted) out.push("..");
      continue;
    }
    out.push(seg);
  }
  const joined = out.join("/");
  if (drive && drive[2] === "/") return `${drive[1]}/${joined}`;
  return rooted ? `/${joined}` : joined;
}
if (!/^(?:write|edit|notebookedit|multiedit|read|grep|glob|notebookread|ls|todowrite)$/i.test(toolName)) {
  // The `scripts/(check|validate|verify)-` arm crosses "/" explicitly (PR #605, CodeRabbit F3,
  // decided "widen" 2026-09-06) so it reads the same as the shell regex above and the measured
  // settings-glob behaviour. The earlier `[^/]*` form already caught nested paths as a prefix
  // match (the trailing lookahead permits "/"), so this is an alignment of stated intent, not a
  // behaviour change here; the behaviour change lives in codex-push-lib.mjs RISKY_PATH_RES.
  const enforcementPathHit = pathCandidates.some((candidate) => {
    if (candidate == null) return false;
    // A DOS 8.3 alias (Codex CRX-SEC-001 on 5f69ecc2d) resolves to the real file but matches
    // no pattern, and this channel has no prompt behind it at all, so it is refused here too.
    if (hasShortNameSegment(candidate)) return true;
    return ENFORCEMENT_PATH_FIELD_RE
      .test(`/${resolvePathCandidate(candidate)}`);
  });
  if (enforcementPathHit) {
    deny("REVIEW PROOF GUARD: this tool would write to .husky, .github/workflows, .claude/hooks, .claude/agents, .claude/commands, .claude/skills, .claude/workflows, .claude/launch.json, .claude/schema-registry.json, .claude/caller-graph.json, .codex, .coderabbit.yaml, package.json, or the check/validate/proof/parity scripts through a path field. These decide whether the commit, push, CI, and review gates run at all. Use native Edit/Write for a deliberate change; enforcement-surface changes require an exact-SHA independent review before merge.");
  }
}
// GitHub Codex P1 on ac5758f03 (`settings.json:216`), probe-confirmed: the native editors are
// gated by the settings `ask` globs, and a glob matches the SPELLING it is given, so
// `Edit $ROOT/.github/scripts/../workflows/ci.yml` prompted nothing while the filesystem landed
// on ci.yml; this hook exempted the native editors because the prompt is their boundary, and
// armed autopilot was the only place that canonicalised. The exemption is sound only when the
// spelling IS the canonical path. A non-canonical spelling (a `.`/`..` segment, a repeated or
// trailing separator, a drive-relative prefix, a trailing period or space in a segment, an NTFS
// stream suffix such as `::$DATA`, a `\\?\` device prefix) whose
// canonical form is on the enforcement surface, or one that still
// escapes the tree after resolution, is denied here in EVERY mode: re-issue with the canonical
// path and the prompt fires. Backslashes are not counted as non-canonical — Windows spellings
// are what the editors send on this machine, and the globs are measured against them.
if (/^(?:write|edit|notebookedit|multiedit)$/i.test(toolName)) {
  const nonCanonicalProtected = pathCandidates.some((candidate) => {
    if (candidate == null) return false;
    const folded = String(candidate).replace(/\\/g, "/");
    const canonical = resolvePathCandidate(candidate);
    // A relative path that still begins with `..` after resolution leaves the tree the hook
    // was given, whether or not the spelling was already canonical; it is never a native
    // edit this repository can vouch for.
    if (/^\.\.(?:\/|$)/.test(canonical)) return true;
    // A DOS 8.3 alias (Codex CRX-SEC-001 on 5f69ecc2d): `CLAUDE~1/hooks/x.mjs` opens the real
    // file, the settings glob matches the spelling it is given, so the prompt never fires.
    if (hasShortNameSegment(folded)) return true;
    if (folded === canonical) return false;
    return ENFORCEMENT_PATH_FIELD_RE.test(`/${canonical}`);
  });
  if (nonCanonicalProtected) {
    deny("REVIEW PROOF GUARD: this native edit names a protected enforcement path through a non-canonical spelling (a `..` or `.` segment, a repeated or trailing separator), or a relative path that leaves the tree. The protected-path prompt matches the spelling it is given, so it would not fire. Re-issue the edit with the canonical path (for example `.github/workflows/ci.yml`, not `.github/scripts/../workflows/ci.yml`) and answer the prompt.");
  }
}
if (shellTool && reviewStateDirectoryMentioned(hookCwd)) {
  deny("REVIEW PROOF GUARD: shell commands from the wrapper-owned review state directory are blocked. Return to the repository root and run the real review wrapper.");
}

process.exit(0);
