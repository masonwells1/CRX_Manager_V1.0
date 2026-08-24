#!/usr/bin/env node
// Codex recursion / process-kill guard for CRX Manager.
//
// WHY (2026-08-23, reproduced twice while reviewing PR #447 — PIDs 39564, 36244):
// `codex review --base origin/main` loads AGENTS.md / CLAUDE.md /
// .claude/commands/codex-gauntlet.md as project context. Those files instruct an
// agent to "run a Codex review", so the reviewer follows them literally into a
// NESTED `codex review`, then enumerates codex.exe processes, sees duplicates, and
// taskkills the tree INCLUDING ITS OWN PID.
//
// The damage is not the crash. The pipeline still EXITS 0, so anything reading exit
// status records a clean Codex review when Codex reviewed nothing — a false "hard
// gate passed" on exactly the money/RLS/migration diffs the gate exists for.
//
// TWO RULES, and rule 2 is deliberately broader than "commands mentioning codex":
//
//   1. DENY `codex review` from a shell. It cannot complete in this repo. Route to
//      `node scripts/write-codex-push-proof.mjs`, which reviews a sanitized snapshot
//      pair with no agent-instruction files present to recurse on.
//
//   2. DENY force process kills (taskkill / Stop-Process / pkill / killall /
//      kill -9). NOT scoped to commands naming codex ON PURPOSE: the command that
//      actually killed the reviewer was `taskkill /PID 39564 /T /F`, which never
//      says "codex" anywhere. A guard matching the word would have watched it
//      happen. Matching the DANGEROUS VERB is what binds; see the LIVE-DATA GUARD
//      lesson about matching text rather than effect.
//
// The wrapper is unaffected: it spawns Codex from Node, not through a shell tool
// call, so it never reaches this hook.
//
// Fail-open on unparseable input, matching the house hook style.

import { readFileSync } from "node:fs";

export function out(decision, reason) {
  const payload = decision === "block"
    ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
    : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
  return JSON.stringify(payload);
}

// A shell COMMAND POSITION: start of string, after a separator, or just inside an
// interpreter's command wrapper. Anchoring here rather than "after any whitespace"
// is what keeps `echo "do not run codex review here"` from being blocked — prose
// sits mid-argument, an invocation sits at a command position.
//
// `cmd /c` and `cmd /k` are listed because Sol flagged (PR #452 P2) that
// `cmd /c codex review ...` sailed through a version that only knew `-c`/-Command.
const SEP = String.raw`(?:^|[;|&\n{(]|-Command\s+|-c\s+|cmd(?:\.exe)?["']?\s+\/[ckCK]\s+)`;
const Q = String.raw`["']?`;

// The codex binary as actually written in the wild: bare `codex`, a versioned
// absolute path ending in codex.exe, or a variable whose NAME contains CODEX —
// `$CODEX`, `"$CODEX"`, `${CODEX}`. That last form matters because it is the exact
// spelling this repo's own skill documented (`"$CODEX" review $SCOPE`), so a guard
// that missed it would have permitted the documented broken path.
const BIN = String.raw`(?:[^\s"';&|]*[\\/])?codex(?:\.exe)?|\$\{?\w*CODEX\w*\}?`;

// Executable names are NORMALIZED rather than spelled out. Sol's first HIGH on
// PR #452: a pattern listing bare verbs allowed `taskkill.exe`,
// `C:\Windows\System32\taskkill.exe`, `/usr/bin/pkill -9` and `/bin/kill -9` —
// ordinary Windows and POSIX spellings, not obfuscation. Adding more alternatives
// only moves the hole, so compare the basename: strip path, strip `.exe`, lowercase.

// Every guarded kill tool, by NORMALIZED basename.
//
// `kill` is in here unconditionally. An earlier version exempted a bare
// `kill <pid>` as "a polite TERM" and its test pinned that exemption — Sol's second
// HIGH on PR #452 pointed out the exemption is a POSIX fact that is false on this
// machine: in PowerShell `kill` IS `Stop-Process`, so `kill 39564` force-kills, and
// read-only execution proved the hook returned "allow". A test that pins a wrong
// assumption makes the bug permanent, so the exemption and its test are gone.
const GUARDED_KILL = new Map([
  ["taskkill", "taskkill"],
  ["pkill", "pkill"],
  ["killall", "killall"],
  ["stop-process", "Stop-Process"],
  ["spps", "Stop-Process"],
  ["kill", "kill"],
]);

// Programs that RUN another program, so the executable is a later token. Sol proved
// `Start-Process taskkill.exe … /F` slipped past a check that only looked at the
// command-position token.
const LAUNCHERS = new Set([
  "start-process", "saps", "start", "sudo", "doas", "env", "nohup", "nice",
  "timeout", "xargs", "cmd", "powershell", "pwsh", "sh", "bash", "zsh",
  "invoke-expression", "iex", "invoke-command", "icm",
]);

// Windows resolves a bare name against PATHEXT, so `codex.cmd` and `taskkill.bat`
// are ordinary spellings of the same program, not obfuscation. Sol's round-8 HIGH
// proved `codex.cmd review --base origin/main` returned "allow" because only `.exe`
// was stripped — and `.cmd` is the SHIM extension npm-installed CLIs actually get.
const EXECUTABLE_EXT_RE = /\.(?:exe|cmd|bat|com|ps1)$/i;

export function normalizeExecutable(token) {
  // Quotes are stripped EVERYWHERE, not just at the ends. Sol's round-9 HIGH:
  // `c"od"ex review` ran normally and read as an unknown token, because only
  // leading/trailing quotes were removed. The shell concatenates the pieces before
  // exec, so the guard has to as well — the same lesson as the earlier
  // `("Hard"+"Link")` bypass in the maintenance guard. This also covers the
  // unreported twin, `task"kill"`, which I found probing the reported one.
  // The caret is cmd.exe's escape character and vanishes before the program is
  // resolved, so `co^dex` and `task^kill.exe` launch normally (round 10). It is
  // stripped with the quotes for the same reason: the shell removes it, so the
  // guard must compare what actually gets executed.
  const unquoted = String(token || "").replace(/["'`^]/g, "");
  const base = unquoted.split(/[\\/]/).pop() || "";
  return base.replace(EXECUTABLE_EXT_RE, "").toLowerCase();
}

// Termination reached through an API rather than a kill PROGRAM. Sol's round-8
// HIGH: `Get-Process codex | ForEach-Object { $_.Kill() }`,
// `node -e "process.kill(39564, 'SIGKILL')"` and
// `Invoke-CimMethod … -MethodName Terminate` all end the reviewer without ever
// naming a guarded executable, so the basename walk above cannot see them.
//
// These are METHOD-CALL shapes, matched anywhere in the command text for the same
// fail-closed reason the basename walk is position-blind.
//
// Honest limit, stated where the next reader will see it: this is enumeration, and
// enumeration of a language's kill APIs cannot be finished. Sol's own conclusion on
// round 8 was "a capability-level restriction is needed; enumerating shell strings
// remains bypassable". Adding a pattern here closes one named hole; it does not make
// the class complete. Do not read a green test run as coverage of this class.
const KILL_MECHANISMS = [
  { re: /\.kill\s*\(/i, what: "a .kill() call" },
  { re: /\bkill\s*\(\s*\d/i, what: "a kill(pid) call" },
  { re: /-MethodName\s+["']?Terminate\b/i, what: "CIM Terminate" },
  { re: /\.Terminate\s*\(/i, what: "a .Terminate() call" },
  { re: /\bcall\s+terminate\b/i, what: "wmic call terminate" },
];

// A flag rather than a program: `-x`, `--x`, or a Windows `/X` switch. A POSIX path
// like `/usr/bin/pkill` has further separators, so it is NOT treated as a flag.
function isFlag(token) {
  const t = token.replace(/^["']+/, "");
  if (t.startsWith("-")) return true;
  return t.startsWith("/") && !t.slice(1).includes("/");
}

// Tokens that are neither a flag nor the program: an empty quoted argument (the
// title slot in `cmd /c start "" taskkill.exe`) and a `KEY=VALUE` assignment (as in
// `env X=1 pkill -9`). Sol's round-6 HIGH: both ENDED the walk, so the executable
// after them was never examined.
function isSkippableArgument(token) {
  const bare = token.replace(/^["']+|["']+$/g, "");
  if (bare === "") return true;
  return /^[\w.]+=/.test(bare);
}

// A variable that expands to the binary, in every shell this repo actually runs.
// Round 9 proved the Bash-only form was not enough: `& $env:CODEX review` is the
// PowerShell spelling and `%CODEX%` the cmd.exe one, and the hook is registered for
// PowerShell. Matched on the variable NAME containing CODEX, since that is the
// convention this repo's own skill documented (`"$CODEX" review $SCOPE`).
// Matched on the STRIPPED form rather than the full spelling, because the
// tokenizer splits on `{` and `}` — `${env:CODEX}` arrives here as `env:CODEX`
// with the `$` already gone, so a pattern anchored on the sigil misses it. Caught
// by the test for this fix, not by reading the regex.
const CODEX_VAR_RE = /^\w*CODEX\w*$/i;

function stripVariableSyntax(token) {
  return String(token || "")
    .replace(/["'`]/g, "")
    .replace(/[${}%]/g, "")
    .replace(/^env:/i, "");
}

function isCodexBinary(token) {
  if (normalizeExecutable(token) === "codex") return true;
  return CODEX_VAR_RE.test(stripVariableSyntax(token));
}

// A `review` / `exec` subcommand token. The delimiter class includes quotes and
// commas so PowerShell's `-ArgumentList 'review','--base'` is seen as a subcommand
// list rather than one opaque token — Sol's round-6 HIGH again.
const REVIEW_TOKEN_RE = /(?:^|[\s'",(])review(?:$|[\s'",);&|])/i;
const EXEC_TOKEN_RE = /(?:^|[\s'",(])exec(?:$|[\s'",);&|])/i;

/**
 * ONE walk for both rules.
 *
 * They were separate parsers with different notions of a command position, and every
 * round of review found a wrapper that one understood and the other did not. Sol's
 * round-6 finding named that directly: "the kill parser stops at launcher arguments,
 * while the Codex-review detector does not inspect launchers at all". Two parsers
 * mean two sets of holes, so there is now one.
 */
/**
 * FAIL CLOSED. Every token is a candidate executable, not just the ones at a
 * position this parser believes it understands.
 *
 * Four adversarial rounds killed the position-tracking approach. Each round the
 * walk stopped at a token it did not recognise and everything after it went
 * unexamined: an empty `""`, a `KEY=VALUE`, a bare `90` after `timeout`, and then
 * `command`, `exec`, `call`, `@(…)`. Sol's round-7 verdict named the shape rather
 * than the spellings — "parsing stops when it encounters an unrecognized launcher
 * or launcher argument" — and asked for fail-closed handling of opaque launchers.
 *
 * Correctly recognising every wrapper in every shell is not achievable with string
 * matching, so this stops trying. If a guarded kill tool appears ANYWHERE as a
 * token, refuse. No launcher table to be incomplete, no walk to terminate early.
 *
 * THE TRADE, stated plainly: this over-blocks. `grep taskkill notes.md` and
 * `echo "never run codex review"` are now refused. That is the intended direction —
 * a refused `grep` costs one message, a missed kill costs a security gate that
 * reports clean without running. See the KNOWN_ISSUES entry.
 */
export function classifyWalk(rawCommand) {
  const cmd = String(rawCommand || "");
  if (!cmd.trim()) return null;

  // Redirections split too. CodeRabbit found, on the final head, that a redirect
  // glued straight to the executable kept the guarded name inside an unrecognised
  // token: `codex>/tmp/review.log review`, `/bin/kill>/tmp/out.log -9 39564` and
  // `taskkill.exe>nul /PID 39564 /F` all ran while the hook returned "allow".
  // Bash launches the program exactly the same way; only the output moves.
  const tokens = cmd.split(/[\s;|&<>\n(){}]+/).filter(Boolean);

  for (const token of tokens) {
    const guarded = GUARDED_KILL.get(normalizeExecutable(token));
    if (guarded) return { rule: "force-kill", what: guarded };
  }

  for (const mechanism of KILL_MECHANISMS) {
    if (mechanism.re.test(cmd)) return { rule: "force-kill", what: mechanism.what };
  }

  for (let i = 0; i < tokens.length; i += 1) {
    if (!isCodexBinary(tokens[i])) continue;
    const rest = tokens.slice(i + 1).join(" ");
    const review = rest.search(REVIEW_TOKEN_RE);
    if (review === -1) continue;
    const exec = rest.search(EXEC_TOKEN_RE);
    // `exec` first means the subcommand is exec and "review" is prompt text —
    // the sanitized wrapper and one-off prompts both depend on `codex exec`.
    if (exec !== -1 && exec < review) continue;
    return { rule: "codex-review" };
  }

  return null;
}

export function findForceKill(rawCommand) {
  const hit = classifyWalk(rawCommand);
  return hit?.rule === "force-kill" ? hit.what : null;
}

// True when a codex binary sits at a command position and its SUBCOMMAND is
// `review`. Options may appear between the two — `codex -c model=x review` is a
// legal invocation and must not slip past.
//
// `exec` winning the race means the subcommand is `exec`, so the word "review"
// later in the line is part of a PROMPT, not a subcommand: `codex exec "review
// this diff"` stays allowed, which matters because the sanitized wrapper and
// ordinary one-off prompts both rely on `codex exec`.
export function invokesCodexReview(rawCommand) {
  return classifyWalk(rawCommand)?.rule === "codex-review";
}

export function classifyCommand(rawCommand) {
  const cmd = String(rawCommand || "");
  if (!cmd.trim()) return null;

  if (invokesCodexReview(cmd)) {
    return {
      rule: "codex-review",
      reason:
        "CODEX RECURSION GUARD: `codex review` cannot complete in this repository. It loads " +
        "AGENTS.md / CLAUDE.md / .claude/commands/codex-gauntlet.md as context, follows their " +
        '"run a Codex review" instruction into a NESTED review, then taskkills its own process ' +
        "tree — while still EXITING 0 with no verdict, so it reads as a clean gate that never ran " +
        "(reproduced twice 2026-08-23, PIDs 39564 and 36244).\n\n" +
        "Use the sanitized wrapper instead, bare from the repo root:\n" +
        "    node scripts/write-codex-push-proof.mjs\n\n" +
        "It reviews a BASE/CANDIDATE snapshot pair with no agent-instruction files present to " +
        "recurse on, and mints the exact-SHA proof only on a terminal CLEAN verdict. It covers the " +
        "`--base origin/main` scope only; for --uncommitted or --commit, commit to a branch first " +
        "or use /codex-cross-review. Detail: .claude/skills/codex-review/SKILL.md.",
    };
  }

  {
    const what = findForceKill(cmd);
    if (what) {
      return {
        rule: "force-kill",
        reason:
          `CODEX RECURSION GUARD: refusing a force process kill (\`${what}\`). An agent force-killing ` +
          "processes is how the 2026-08-23 Codex reviewer destroyed its own review — the command was " +
          "`taskkill /PID 39564 /T /F`, which never mentions codex, so this guard matches the kill " +
          "VERB rather than the target. Matching the word would have watched it happen.\n\n" +
          "To stop something you started, use the harness (TaskStop) rather than a PID kill. If a " +
          "stray process genuinely must die, tell Mason which PID and why and let him do it — a " +
          "wrong PID here kills the thing that was proving the work.",
      };
    }
  }

  return null;
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.stdout.write(out("allow"));
    process.exit(0);
  }

  // BOTH field names. Sol's round-8 HIGH: this read only `command`, so a
  // Codex-native payload — which carries `cmd`, and which `.codex/hooks.json`
  // forwards unchanged through the adapter — returned "allow" for `taskkill …` and
  // `codex review …` alike. The Codex half of the wiring this PR adds was DEAD, and
  // a sibling guard (`review-proof-guard.mjs`) already read both. Wiring a hook on
  // both sides is not the same as the hook understanding both sides' payloads.
  const toolInput = payload?.tool_input ?? {};
  const verdict = classifyCommand(toolInput.command ?? toolInput.cmd);
  process.stdout.write(verdict ? out("block", verdict.reason) : out("allow"));
  process.exit(0);
}

// Only run when executed directly, so the test can import the classifier.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  main();
}
