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

// A shell COMMAND POSITION: start of string, after a separator, or just inside a
// `-Command "` / `-c "` wrapper. Anchoring here rather than "after any whitespace"
// is what keeps `echo "do not run codex review here"` from being blocked — prose
// sits mid-argument, an invocation sits at a command position.
const SEP = String.raw`(?:^|[;|&\n{(]|-Command\s+|-c\s+)`;
const Q = String.raw`["']?`;

// The codex binary as actually written in the wild: bare `codex`, a versioned
// absolute path ending in codex.exe, or a variable whose NAME contains CODEX —
// `$CODEX`, `"$CODEX"`, `${CODEX}`. That last form matters because it is the exact
// spelling this repo's own skill documented (`"$CODEX" review $SCOPE`), so a guard
// that missed it would have permitted the documented broken path.
const BIN = String.raw`(?:[^\s"';&|]*[\\/])?codex(?:\.exe)?|\$\{?\w*CODEX\w*\}?`;

// Requires the `review` SUBCOMMAND specifically. `codex exec` stays allowed: the
// sanitized wrapper and ordinary one-off prompts depend on it, and neither recurses.
const CODEX_REVIEW_RE = new RegExp(`${SEP}\\s*${Q}(?:${BIN})${Q}\\s+review(?:$|[\\s"';&|])`, "i");

// Force-kill verbs, anchored to a command position for the same reason. A bare
// `kill <pid>` is a polite TERM and is left alone; only the forceful spellings are
// listed. `Stop-Process` inside a `ForEach-Object { ... }` block is caught because
// `{` is a separator — that is the real 2026-08-23 command.
const KILL_VERBS = [
  { pattern: String.raw`taskkill`, what: "taskkill" },
  { pattern: String.raw`Stop-Process`, what: "Stop-Process" },
  { pattern: String.raw`pkill`, what: "pkill" },
  { pattern: String.raw`killall`, what: "killall" },
  { pattern: String.raw`kill\s+(?:-9|-KILL|-s\s*(?:9|KILL))`, what: "kill -9" },
];
const KILL_RES = KILL_VERBS.map(({ pattern, what }) => ({
  re: new RegExp(`${SEP}\\s*${pattern}(?:$|[\\s"';&|])`, "i"),
  what,
}));

export function classifyCommand(rawCommand) {
  const cmd = String(rawCommand || "");
  if (!cmd.trim()) return null;

  if (CODEX_REVIEW_RE.test(cmd)) {
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

  for (const { re, what } of KILL_RES) {
    if (re.test(cmd)) {
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

  const verdict = classifyCommand(payload?.tool_input?.command);
  process.stdout.write(verdict ? out("block", verdict.reason) : out("allow"));
  process.exit(0);
}

// Only run when executed directly, so the test can import the classifier.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  main();
}
