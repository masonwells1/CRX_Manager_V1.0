#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hookPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "review-proof-guard.mjs");

function run(payload) {
  return spawnSync(process.execPath, [hookPath], {
    encoding: "utf8",
    input: JSON.stringify(payload),
  });
}

for (const payload of [
  { tool_name: "Write", tool_input: { file_path: ".claude/session-state/claude-review-push.json", content: "{}" } },
  { tool_name: "Edit", tool_input: { file_path: "C:\\repo\\.claude\\session-state\\codex-review-abc.json" } },
  { tool_name: "mcp__filesystem__write_file", tool_input: { path: ".claude/session-state/claude-review-push.json" } },
  { tool_name: "Bash", tool_input: { command: "echo {} > .claude/session-state/claude-review-push.json" } },
  { tool_name: "PowerShell", tool_input: { command: "Remove-Item .claude/session-state/codex-review-abc.json" } },
  { tool_name: "Bash", tool_input: { command: "cd .claude/session-state" } },
  { tool_name: "Bash", tool_input: { command: "cd .claude && cd session-state && printf '{}' >claude-review-push.json" } },
  { tool_name: "Bash", tool_input: { command: 'pushd ".claude/session-state" && ls' } },
  { tool_name: "PowerShell", tool_input: { command: "Set-Location -Path .claude\\session-state" } },
  { tool_name: "PowerShell", tool_input: { command: "Set-Location -LiteralPath 'C:\\repo\\.claude\\session-state'" } },
  // Unresolvable cd target + state-dir mention elsewhere stays fail-closed.
  { tool_name: "Bash", tool_input: { command: 'X=.claude/session-state; cd "$X"' } },
  { tool_name: "Bash", tool_input: { command: "cd session-state/sub" } },
  // CodeRabbit PR #423: option tokens and shell-joined quoting must not hide
  // the real destination from the target parser.
  { tool_name: "Bash", tool_input: { command: "cd -- .claude/session-state" } },
  { tool_name: "Bash", tool_input: { command: "cd -P .claude/session-state" } },
  { tool_name: "Bash", tool_input: { command: 'cd .claude/"session-state"' } },
  { tool_name: "PowerShell", tool_input: { command: "Set-Location -Path:.claude\\session-state" } },
  // Round 2: a Bash escape is dropped by the shell, so this cd really enters
  // the state dir — the decoded target must be checked as well.
  { tool_name: "Bash", tool_input: { command: "cd .claude/session-\\state" } },
  // Opus review 2026-08-19: a NEWLINE also separates cd invocations. The old
  // \s+ argument separator swallowed line breaks, so only the FIRST cd's
  // target was ever resolved and `cd /tmp\ncd .claude/session-state` passed.
  { tool_name: "Bash", tool_input: { command: "cd /tmp\ncd .claude/session-state" } },
  { tool_name: "Bash", tool_input: { command: "cd /tmp\r\ncd .claude/session-state" } },
  { tool_name: "Bash", tool_input: { command: "set -e\ncd /c/repo\ncd .claude/session-state\nls" } },
  { tool_name: "Bash", tool_input: { command: "cd /tmp\ncd .claude/session-state\nprintf '{}' > proof.json" } },
  // Split-quote runs join into ONE path in the shell; the token parser must
  // join adjacent quoted/unquoted segments the same way.
  { tool_name: "Bash", tool_input: { command: 'cd ".claude/session"-state' } },
  { tool_name: "Bash", tool_input: { command: "cd '.claude/session'-state" } },
  // PowerShell's other cd verb.
  { tool_name: "PowerShell", tool_input: { command: "Push-Location .claude\\session-state" } },
  // Glob metacharacters make a cd target statically unresolvable; with the
  // state dir mentioned elsewhere in the same command, that stays fail-closed.
  { tool_name: "Bash", tool_input: { command: "cd .claude/session-stat[e] && cat .claude/session-state/latest.json" } },
  { tool_name: "Bash", cwd: "C:\\repo\\.claude\\session-state", tool_input: { command: "printf {} > harmless-name.json" } },
  { tool_name: "Bash", tool_input: { command: "printf {} > codex-review-forged.json" } },
  { tool_name: "Bash", tool_input: { command: "rm codex-review-forged.json;ls" } },
  // Codex round-4: patch-style payloads carry the destination in free-form text.
  { tool_name: "apply_patch", tool_input: { patch: "*** Add File: .claude/session-state/claude-review-push.json\n+{}" } },
  { tool_name: "mcp__codex__apply_patch", tool_input: { input: "*** Update File: .claude/session-state/codex-review-abc.json" } },
  // Opus review 2026-08-19 round 4 — proven cd bypasses. A quoted, escaped,
  // eval-wrapped, or composed verb still executes as `cd` in the shell, so the
  // scan must see through each disguise.
  { tool_name: "Bash", tool_input: { command: 'eval "cd .claude/session-state"' } },
  { tool_name: "Bash", tool_input: { command: '"cd" .claude/session-state' } },
  { tool_name: "Bash", tool_input: { command: "'cd' .claude/session-state" } },
  { tool_name: "Bash", tool_input: { command: "\\cd .claude/session-state" } },
  { tool_name: "Bash", tool_input: { command: 'c"d" .claude/session-state' } },
  // $IFS glued to the verb leaves an empty argument run — statically
  // unresolvable, so it fails closed with the state dir mentioned.
  { tool_name: "Bash", tool_input: { command: "cd$IFS.claude/session-state" } },
  // A backslash line continuation splices into ONE invocation — both the LF
  // and the CRLF form (CodeRabbit PR #423: a Windows checkout's continuation
  // ends `\<CR><LF>`, which must splice the same way).
  { tool_name: "Bash", tool_input: { command: "cd \\\n.claude/session-state" } },
  { tool_name: "Bash", tool_input: { command: "cd \\\r\n.claude/session-state" } },
  // PowerShell's default Set-Location alias.
  { tool_name: "PowerShell", tool_input: { command: "sl .claude\\session-state" } },
  // ANSI-C quoting resolves escapes before the shell runs the command.
  { tool_name: "Bash", tool_input: { command: "cd $'\\x2eclaude/session\\x2dstate'" } },
  // Round 4: destroying/moving the state dir (it holds the applied-source
  // ledger) is denied outright when a destructive verb appears with it.
  { tool_name: "Bash", tool_input: { command: "rm -rf .claude/session-state" } },
  { tool_name: "PowerShell", tool_input: { command: "Remove-Item -Recurse -Force C:\\repo\\.claude\\session-state" } },
  { tool_name: "Bash", tool_input: { command: "mv .claude/session-state /tmp/aside" } },
  // Round 4: the applied-source ledger itself is proof-protected — direct
  // writes/edits/deletes naming it are denied on every channel.
  { tool_name: "Write", tool_input: { file_path: "C:\\repo\\.claude\\session-state\\applied-source-ledger.json", content: "[]" } },
  { tool_name: "Bash", tool_input: { command: "printf [] > applied-source-ledger.json" } },
  { tool_name: "Bash", tool_input: { command: "node -e \"require('fs').unlinkSync('.claude/session-state/applied-source-ledger.json')\"" } },
  // Opus review 2026-08-19 round 5 (F4): cmd.exe glues the verb to its target
  // (`cd/d`, `cd.claude`), and a composed/quoted verb hides the glue. The
  // deglue pass must separate verb from path so the target is resolved.
  { tool_name: "Bash", tool_input: { command: "cd.claude/session-state" } },
  { tool_name: "cmd", tool_input: { command: "cd/d C:\\repo\\.claude\\session-state" } },
  { tool_name: "Bash", tool_input: { command: 'c"d".claude/session-state' } },
  { tool_name: "PowerShell", tool_input: { command: "chdir.claude\\session-state" } },
  // (F5): a state-dir move/pipe leaves the location verb with an EMPTY target
  // run — statically unresolvable, so it fails closed when the state dir is
  // named elsewhere in the same command.
  { tool_name: "PowerShell", tool_input: { command: "Get-Content .claude/session-state/x.json | sl" } },
  // (F6): destroying/moving the .claude PARENT directory takes the state dir
  // (and the applied-source ledger) with it — denied when a destructive verb
  // names .claude itself, not just the session-state subpath.
  { tool_name: "Bash", tool_input: { command: "rm -rf .claude" } },
  { tool_name: "Bash", tool_input: { command: "mv .claude /tmp/aside" } },
  { tool_name: "PowerShell", tool_input: { command: "Remove-Item -Recurse -Force .claude" } },
  // Opus review 2026-08-19 round 6 — the destructive-verb net and proof-path
  // matcher were hardened for ONE spelling while the cd net already scanned
  // every normalized view. Each of these EXECUTES as the real command in the
  // shell and was a proven bypass of the raw-only scans.
  // Quote-split / composed destructive verb, still names the state dir.
  { tool_name: "Bash", tool_input: { command: 'r"m" -rf .claude/session-state' } },
  { tool_name: "Bash", tool_input: { command: "'rm' -rf .claude/session-state" } },
  { tool_name: "Bash", tool_input: { command: 'm"v" .claude/session-state /tmp/aside' } },
  // Backslash-dropped `.claude` ancestor: bash drops the unquoted `\`, so
  // `.clau\de` executes as `.claude`.
  { tool_name: "Bash", tool_input: { command: "rm -rf .clau\\de" } },
  { tool_name: "Bash", tool_input: { command: "rm -rf .clau\\de/session-state" } },
  // `find` deletes by traversal, never naming the basename — a delete/exec
  // action on the state dir (or its `.claude` parent) is treated as destructive.
  { tool_name: "Bash", tool_input: { command: "find .claude/session-state -delete" } },
  { tool_name: "Bash", tool_input: { command: "find .claude -delete" } },
  { tool_name: "Bash", tool_input: { command: "find .claude/session-state -type f -exec rm {} \\;" } },
  { tool_name: "Bash", tool_input: { command: "find .claude -execdir rm {} +" } },
  // Quote/backslash-split ledger or proof filename: the shell joins the tokens
  // into the real basename, disarming C3 or forging a proof.
  { tool_name: "Bash", tool_input: { command: 'printf "[]" > .claude/session-state/applied-source"-"ledger.json' } },
  { tool_name: "Bash", tool_input: { command: "printf [] > applied-source\\-ledger.json" } },
  { tool_name: "Bash", tool_input: { command: 'printf {} > codex-review"-"forged.json' } },
  // Opus review 2026-08-19 round 7 — the round-6 net still matched the state-dir
  // path and the destructive verbs LITERALLY. Each of these executes against the
  // real state dir but hid from the literal matcher:
  //   (a) a glob on the `.claude` / `session-state` / ledger component expands to
  //       the protected name at runtime (component-aware + glob-fail-closed);
  { tool_name: "Bash", tool_input: { command: "rm -rf .clau*/session-state" } },
  { tool_name: "Bash", tool_input: { command: "rm -rf .clau*/sess*" } },
  { tool_name: "Bash", tool_input: { command: "find .clau*/session-state -delete" } },
  { tool_name: "Bash", tool_input: { command: "mv .clau*/session-state/applied-source-ledger.jso* /tmp/x" } },
  //   (b) a `>`/`>>` write into the state dir overwrites a wrapper-owned file
  //       even with NO destructive verb and a globbed basename;
  { tool_name: "Bash", tool_input: { command: 'printf "[]" > .clau*/session-state/applied-source-ledger.jso*' } },
  //   (c) `git clean` / `rsync --delete` / `truncate` delete or zero files but
  //       were absent from the destructive-verb net.
  { tool_name: "Bash", tool_input: { command: "git clean -fdx .claude/session-state" } },
  { tool_name: "Bash", tool_input: { command: "rsync -a --delete /tmp/empty/ .claude/session-state/" } },
  { tool_name: "Bash", tool_input: { command: "truncate -s0 .claude/session-state/applied-source-ledger.json" } },
  //   (d) a cd whose target is unresolvable BUT whose own literal skeleton names
  //       a protected component (`.claude/session-$part`) enters the state dir at
  //       runtime — the whole `.claude/session-state` string is never spelled out,
  //       so the second-literal-reference test missed it (CodeRabbit PR #423, the
  //       auto-"addressed" marker was wrong — verified still-ALLOW before the fix).
  { tool_name: "Bash", tool_input: { command: "part=state; cd .claude/session-$part" } },
  { tool_name: "Bash", tool_input: { command: "X=session-state; cd .claude/$X" } },
  { tool_name: "Bash", tool_input: { command: "cd .clau[d]e/session-state" } },
  // Opus review 2026-08-19 round 8 (blind adversarial, both reviewers) —
  //   (a) short-lead glob on the `.claude` component: `.c*` / `.c*/s*` expand to
  //       `.claude` / `.claude/session-state` at runtime. The length-3 lead floor
  //       let a DOTTED 2-char lead (`.c`) through, because the ONLY protected name
  //       starting with `.` is `.claude` and `.c*` is already a real glob for it.
  //       The floor is now dotted-aware (min lead 2 when dotted, 3 otherwise).
  { tool_name: "Bash", tool_input: { command: "rm -rf .c*/s*" } },
  { tool_name: "Bash", tool_input: { command: "rm -rf .c*" } },
  { tool_name: "Bash", tool_input: { command: "mv .c*/s* /tmp/x" } },
  { tool_name: "Bash", tool_input: { command: "find .c*/s* -delete" } },
  { tool_name: "Bash", tool_input: { command: "cd .c*/s* && printf {} > x.json" } },
  //   (b) a native/MCP file tool (Write/Edit, move_file, delete_directory) whose
  //       path field is the state DIRECTORY itself — not a protected basename —
  //       moves or deletes the whole ledger + every proof at once, and the
  //       basename matcher never sees a protected filename. Deny any path
  //       candidate that ENTERS the state dir (session-state component, or the
  //       whole `.claude` parent). A forge-by-move whose DESTINATION lands in the
  //       state dir is caught the same way.
  { tool_name: "mcp__filesystem__move_file", tool_input: { source: ".claude/session-state", destination: "/tmp/aside" } },
  { tool_name: "mcp__filesystem__move_file", tool_input: { source: ".claude", destination: "/tmp/aside" } },
  { tool_name: "mcp__filesystem__delete_directory", tool_input: { path: ".claude/session-state" } },
  { tool_name: "mcp__filesystem__move_file", tool_input: { source: "/tmp/x.json", destination: ".claude/session-state/forged.json" } },
  // Ack-valve exemption is basename-EXACT: a lookalike suffix or any OTHER
  // session-state basename must STILL deny (only stop-wrap-ack.json is opened).
  { tool_name: "Write", tool_input: { file_path: ".claude/session-state/stop-wrap-ack.json.bak", content: "{}" } },
  { tool_name: "Write", tool_input: { file_path: ".claude/session-state/harmless.json", content: "{}" } },
  // The exemption is WRITE-destination-only and case-sensitive (CodeRabbit PR
  // #430): a move/delete that merely names the ack file (source OR destination),
  // and a case-variant name, must STILL deny — only a genuine Write/Edit to the
  // canonical lowercase path opens.
  { tool_name: "mcp__filesystem__move_file", tool_input: { source: ".claude/session-state/stop-wrap-ack.json", destination: "/tmp/x" } },
  { tool_name: "mcp__filesystem__move_file", tool_input: { source: "/tmp/x.json", destination: ".claude/session-state/stop-wrap-ack.json" } },
  { tool_name: "mcp__filesystem__delete_file", tool_input: { path: ".claude/session-state/stop-wrap-ack.json" } },
  { tool_name: "Write", tool_input: { file_path: ".claude/session-state/STOP-WRAP-ACK.JSON", content: "{}" } },
]) {
  const result = run(payload);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /"permissionDecision":"deny"/);
}

assert.equal(run({ tool_name: "Write", tool_input: { file_path: "docs/review.md", content: "ok" } }).stdout, "");
assert.equal(run({ tool_name: "Bash", tool_input: { command: "node scripts/run-claude-review.mjs --scope base-main" } }).stdout, "");
// 2026-08-18 false-positive class: a cd to an UNRELATED literal directory plus a
// read-only mention of the state dir must be allowed — only the cd TARGET matters.
assert.equal(run({ tool_name: "Bash", tool_input: { command: 'cd "C:\\CRX_Manager\\.claude\\worktrees\\skills-audit-x" && wc -l src/app.ts; ls .claude/session-state 2>/dev/null' } }).stdout, "");
assert.equal(run({ tool_name: "Bash", tool_input: { command: "cd /c/repo && cat .claude/session-state/README.md" } }).stdout, "");
assert.equal(run({ tool_name: "Bash", tool_input: { command: "cd .claude/hooks && node review-proof-guard.test.mjs" } }).stdout, "");
// Unresolvable target WITHOUT any state-dir mention is fine.
assert.equal(run({ tool_name: "Bash", tool_input: { command: 'cd "$HOME/projects" && ls' } }).stdout, "");
// Option tokens before an UNRELATED literal target must not re-trigger the
// old "cd anywhere + state-dir mention" false positive.
const optionAllow = run({ tool_name: "Bash", tool_input: { command: "cd -- /c/repo && ls .claude/session-state 2>/dev/null" } });
assert.equal(optionAllow.status, 0);
assert.equal(optionAllow.stdout, "");
// Multi-line commands whose cds all target innocent directories stay allowed —
// the newline fix must not turn every multi-line script into a false positive.
assert.equal(run({ tool_name: "Bash", tool_input: { command: "cd /c/repo\nnpm run test\nls .claude/session-state" } }).stdout, "");
assert.equal(run({ tool_name: "PowerShell", tool_input: { command: "Push-Location C:\\repo\nGet-ChildItem" } }).stdout, "");
// Round 4 non-regressions: `sl` must not swallow `sleep`; the sanctioned
// removal script is the allowed path and never names the ledger file; a
// destructive verb WITHOUT any state-dir mention stays allowed.
assert.equal(run({ tool_name: "Bash", tool_input: { command: "sleep 5 && ls .claude/session-state" } }).stdout, "");
assert.equal(run({ tool_name: "Bash", tool_input: { command: "node scripts/remove-applied-ledger-entry.mjs --name stale_probe" } }).stdout, "");
assert.equal(run({ tool_name: "Bash", tool_input: { command: "node scripts/remove-applied-ledger-entry.mjs --list" } }).stdout, "");
assert.equal(run({ tool_name: "Bash", tool_input: { command: "rm -rf node_modules && npm install" } }).stdout, "");
// Round 5 non-regressions (F4/F5/F6): the deglue pass must not split a verb out
// of an unrelated word; an empty location target WITHOUT a state-dir mention is
// fine; and a destructive verb on a `.claude`-PREFIXED but distinct path
// (`.claude-cache`, `.clauderc`) must stay allowed — only bare `.claude` counts.
assert.equal(run({ tool_name: "Bash", tool_input: { command: "scandir.parse('.claude/session-state')" } }).stdout, "");
assert.equal(run({ tool_name: "Bash", tool_input: { command: "cd && ls /tmp" } }).stdout, "");
assert.equal(run({ tool_name: "PowerShell", tool_input: { command: "Get-Content foo.json | sl" } }).stdout, "");
assert.equal(run({ tool_name: "Bash", tool_input: { command: "rm -rf .claude-cache && rm -rf build/.clauderc" } }).stdout, "");
// Round 6 non-regressions: the new backslash-dropped and quote-stripped views
// must not manufacture a false `.claude` component or proof basename. A
// destructive verb on a `.claude`-PREFIXED-but-distinct path stays allowed even
// after the `\` is dropped, and a find-delete on an unrelated `.claudex` glob is
// fine — only bare `.claude` as a whole component with a delete/exec counts.
assert.equal(run({ tool_name: "Bash", tool_input: { command: "rm -rf build\\.clauderc-cache" } }).stdout, "");
assert.equal(run({ tool_name: "Bash", tool_input: { command: "find src -name '*.claudex' -delete" } }).stdout, "");
// Round 7 non-regressions: the component-aware / glob-fail-closed / new-verb net
// must not over-match. A glob with NO literal prefix (`*.js`), a destructive verb
// on an unrelated path, and `git clean` / `rsync --delete` / `truncate` that name
// no protected component all stay allowed. Only a glob whose LITERAL prefix could
// expand to `.claude` / `session-state` / the ledger — or a redirect INTO the
// state dir — is denied.
assert.equal(run({ tool_name: "Bash", tool_input: { command: "rm dist/*.js" } }).stdout, "");
assert.equal(run({ tool_name: "Bash", tool_input: { command: "rm -rf node_modules/.cache" } }).stdout, "");
assert.equal(run({ tool_name: "Bash", tool_input: { command: "echo hi > /tmp/out" } }).stdout, "");
assert.equal(run({ tool_name: "Bash", tool_input: { command: "echo x > .claude-notes.txt" } }).stdout, "");
assert.equal(run({ tool_name: "Bash", tool_input: { command: "git clean -fdx dist" } }).stdout, "");
assert.equal(run({ tool_name: "Bash", tool_input: { command: "rsync -a --delete /tmp/a/ /tmp/b/" } }).stdout, "");
assert.equal(run({ tool_name: "Bash", tool_input: { command: "truncate -s0 /tmp/log" } }).stdout, "");
// The unresolvable-target skeleton check must not over-match: a `$VAR` target whose
// literal parts are NOT protected components stays allowed, and a `.claude`-PREFIXED
// but distinct component (`.claude-cache`) stays allowed even unresolved.
assert.equal(run({ tool_name: "Bash", tool_input: { command: "cd $HOME/session-state-notes && ls" } }).stdout, "");
assert.equal(run({ tool_name: "Bash", tool_input: { command: "cd .claude-cache/$sub && ls" } }).stdout, "");
// Round 8 non-regressions: the dotted-lead glob floor must not over-block an
// ordinary delete whose glob lead is a bare `s`/`a` (a prefix of `session-state`
// / `applied-source-ledger.json` but too generic to be a real target of them),
// and the MCP directory-level deny must still allow a legit hook/settings edit
// or a hook-file move that never enters `.claude/session-state`.
assert.equal(run({ tool_name: "Bash", tool_input: { command: "rm s*.o" } }).stdout, "");
assert.equal(run({ tool_name: "Bash", tool_input: { command: "rm a*.log" } }).stdout, "");
assert.equal(run({ tool_name: "Write", tool_input: { file_path: ".claude/hooks/review-proof-guard.mjs", content: "// edit" } }).stdout, "");
assert.equal(run({ tool_name: "Write", tool_input: { file_path: ".claude/settings.json", content: "{}" } }).stdout, "");
assert.equal(run({ tool_name: "Edit", tool_input: { file_path: ".claude/hooks/stop-wrap.mjs" } }).stdout, "");
// DELIBERATELY REVERSED 2026-09-01. This line used to assert that an MCP move of
// a hook file was ALLOWED — true when `guarded-surface-lock` existed to catch it.
// With the lock deleted, that is exactly the "silently rewrite a guard, then run
// the operation it gated" route, so a path-field tool aimed at a hook file now
// denies. Native Write/Edit stay allowed (asserted just above and below) because
// there is no unlock any more and they are the only way to maintain a hook.
assert.match(
  run({ tool_name: "mcp__filesystem__move_file", tool_input: { source: ".claude/hooks/a.mjs", destination: ".claude/hooks/b.mjs" } }).stdout,
  /"permissionDecision":"deny"/,
);

// Ack valve (stop-wrap-ack.json): the ONE session-state basename stop-wrap.mjs
// tells the agent to write to acknowledge loose ends — must be ALLOWED again
// (the round-8 whole-dir deny had broken this designed carve-out).
assert.equal(run({ tool_name: "Write", tool_input: { file_path: ".claude/session-state/stop-wrap-ack.json", content: '{"signature":"x"}' } }).stdout, "");
assert.equal(run({ tool_name: "Edit", tool_input: { file_path: "C:\\repo\\.claude\\session-state\\stop-wrap-ack.json" } }).stdout, "");
assert.equal(run({ tool_name: "mcp__filesystem__write_file", tool_input: { path: ".claude/session-state/stop-wrap-ack.json" } }).stdout, "");

// ── Worktree-path denials: a tripwire for any future carve-out ──────────────
// Agent worktrees live at <repo>/.claude/worktrees/<name>/, so every file in one
// carries a `.claude` component and the guard denies destructive shell commands
// that NAME a worktree path. That is a known, documented limitation with a
// zero-risk workaround (use relative paths — the agent's shell already starts in
// the worktree); see docs/reference/gotchas.md and docs/manual/KNOWN_ISSUES.md.
//
// A "carve-out" that strips the worktree prefix out of the command text before
// the protection checks run was attempted on 2026-08-19/20 and ABANDONED: five
// independent gpt-5.6-sol review rounds found EIGHT real holes in five successive
// versions, each a different way to spell the same path, and each round's suite
// was green over the next round's hole. The cases below are exactly those eight
// spellings. They pass against today's guard trivially — the point is that they
// must STILL deny if anyone attempts a carve-out again. Every one of them was an
// exploit that reached the repo's own review state, the applied-source ledger, or
// a whole worktree's state directory.
for (const payload of [
  // Round 1 — a trailing separator (or `/*`) let the prefix consume the ENTIRE
  // target, leaving a bare `rm -rf` naming nothing protected.
  { tool_name: "Bash", tool_input: { command: "rm -rf .claude/worktrees/wt-a/" } },
  { tool_name: "Bash", tool_input: { command: "rm -rf .claude/worktrees/wt-a/*" } },
  { tool_name: "Bash", tool_input: { command: "rm -rf C:\\repo\\.claude\\worktrees\\wt-a\\" } },
  // Round 2 — parent traversal after the worktree reference was erased. From
  // inside a worktree, `../..` IS the repo's own `.claude`.
  { tool_name: "Bash", tool_input: { command: "cd C:\\repo\\.claude\\worktrees\\wt-a && find ../.. -delete" } },
  { tool_name: "Bash", tool_input: { command: "cd .claude/worktrees/wt-a && rm -rf ../../session-state" } },
  // Round 3 — a shell-expanded descendant is unreadable and can BE the protected
  // path (`target=.claude/session-state`).
  { tool_name: "Bash", tool_input: { command: "mv .claude/worktrees/wt-a/$target /tmp/x" } },
  { tool_name: "Bash", tool_input: { command: "rm -rf .claude/worktrees/wt-a/${X}" } },
  // Round 4 — a dot alias names the worktree ROOT; and traversal spelled with
  // quote-joining shows no literal `..` in the raw command text.
  { tool_name: "Bash", tool_input: { command: "find .claude/worktrees/wt-a/. -delete" } },
  { tool_name: "Bash", tool_input: { command: 'rm -rf .claude/worktrees/wt-a/"."' } },
  { tool_name: "Bash", tool_input: { command: 'cd .claude/worktrees/wt-a && find ."."/."." -delete' } },
  // Round 5 — an OPERAND that happens to be named `cd`; cmd.exe substring and
  // delayed expansion; and cmd.exe caret escapes decoding to traversal.
  { tool_name: "Bash", tool_input: { command: "mv cd .claude/worktrees/wt-a /tmp/" } },
  //       The cmd.exe forms are pinned through the `cmd` tool name as well as
  //       Bash: `%VAR:~0%`, `!VAR!` and `^` only carry their exploit semantics in
  //       cmd.exe, so a future shell-specific carve-out could open the real route
  //       while Bash-labelled cases stayed green (Codex connector, PR #434 round
  //       3). Both routes are pinned — the guard must not decide by tool name.
  { tool_name: "cmd", tool_input: { command: "mv .claude\\worktrees\\wt-a\\%TARGET:~0% C:\\tmp\\x" } },
  { tool_name: "cmd", tool_input: { command: "mv .claude\\worktrees\\wt-a\\!TARGET! C:\\tmp\\x" } },
  { tool_name: "cmd", tool_input: { command: "mv .claude\\worktrees\\wt-a\\.^.\\.^.\\session^-state C:\\tmp\\x" } },
  { tool_name: "Bash", tool_input: { command: "cmd /c mv .claude\\worktrees\\wt-a\\%TARGET:~0% C:\\tmp\\x" } },
  { tool_name: "Bash", tool_input: { command: "mv .claude\\worktrees\\wt-a\\%TARGET:~0% C:\\tmp\\x" } },
  { tool_name: "Bash", tool_input: { command: "mv .claude\\worktrees\\wt-a\\!TARGET! C:\\tmp\\x" } },
  { tool_name: "Bash", tool_input: { command: "mv .claude\\worktrees\\wt-a\\.^.\\.^.\\session^-state C:\\tmp\\x" } },
  // The worktrees container and a whole worktree root are protected in their own
  // right — each holds worktree state directories.
  { tool_name: "Bash", tool_input: { command: "rm -rf .claude/worktrees" } },
  { tool_name: "Bash", tool_input: { command: "rm -rf .claude/worktrees/wt-a" } },
  // A worktree's OWN review state, protected exactly like the repo's.
  { tool_name: "Bash", tool_input: { command: "rm -rf .claude/worktrees/wt-a/.claude/session-state" } },
  { tool_name: "Write", tool_input: { file_path: "C:\\repo\\.claude\\worktrees\\wt-a\\.claude\\session-state\\applied-source-ledger.json", content: "[]" } },
]) {
  const result = run(payload);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /"permissionDecision":"deny"/);
}

// The documented workaround must keep working: a destructive command that does
// NOT name the worktree path passes THIS guard, because the agent's shell already
// runs inside the worktree. That is what makes the limitation above tolerable, so
// it is pinned rather than left to chance.
//
// Scope note (PR #434 review): these assert only that review-proof-guard allows
// the command — NOT that it runs. Other guards sit on the same Bash call, and
// `git clean -f/-fd/-fdx` is blocked by bash-safety-lib.mjs no matter how the path
// is written. It is deliberately absent below: an earlier draft pinned it here and
// documented it as a workaround, which was wrong. Do not add a case to this block
// without checking the whole hook stack.
//
// status is asserted alongside stdout: a hook that CRASHES also produces empty
// stdout, so an empty-stdout-only assertion would pass on a broken guard.
for (const payload of [
  { tool_name: "Bash", cwd: "C:\\repo\\.claude\\worktrees\\wt-a", tool_input: { command: "rm -f guard-probe.tmp" } },
  { tool_name: "Bash", cwd: "C:\\repo\\.claude\\worktrees\\wt-a", tool_input: { command: "rm -rf node_modules/.cache" } },
  { tool_name: "Bash", cwd: "C:\\repo\\.claude\\worktrees\\wt-a", tool_input: { command: "mv a.txt b.txt" } },
  { tool_name: "Write", cwd: "C:\\repo\\.claude\\worktrees\\wt-a", tool_input: { file_path: "src/foo.ts", content: "x" } },
]) {
  const result = run(payload);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
}

// ---------------------------------------------------------------------------
// Enforcement surfaces outside `.claude`, absorbed here 2026-09-01 when
// guarded-surface-lock was removed. These are the ONLY paths that lock covered
// and this guard did not, so they are the whole replacement — if these stop
// denying, the removal was a net loss of coverage and this suite must say so.
// ---------------------------------------------------------------------------
for (const command of [
  "rm -f .husky/pre-push",
  "rm -rf .husky",
  "mv .husky/pre-commit /tmp/x",
  "echo x > .husky/pre-push",
  "printf 'exit 0' >> .husky/pre-commit",
  "rm .github/workflows/ci.yml",
  "echo broken > .github/workflows/ci.yml",
  "rm -rf .codex/hooks",
  "echo {} > .codex/hooks.json",
  "rm .coderabbit.yaml",
  "echo '' > .coderabbit.yml",
  // Quote/backslash obfuscation must not help: the shell resolves these to the
  // real path, and the guard tests every normalized view.
  'r"m" -f .husky/pre-push',
  "rm -f .hus\\ky/pre-push",
  // Windows separators travel in the raw view.
  "rm -f .github\\workflows\\ci.yml",
  // Overwrite verbs whose CONTENT comes from git history or a patch file, so no
  // redirect and no rm/mv ever appears in the command text. The removed lock
  // caught these; dropping them would have been a silent loss of coverage.
  "git checkout main -- .husky/pre-push",
  "git restore --source=HEAD~5 .husky/",
  "git checkout main -- .claude/hooks/sql-safety.mjs",
  "git apply /tmp/disable-guards.patch .codex/hooks.json",
  "patch -p1 .husky/pre-commit < /tmp/x.diff",
  "git rm .github/workflows/ci.yml",
  "git -C /repo checkout main -- .husky/pre-push",
  // Every bypass the gpt-5.6-sol review confirmed against the FIRST cut of this
  // rule, which enumerated destructive verbs instead of allowlisting read-only
  // heads. Each one was parser-confirmed ALLOWED then; each must deny now. If a
  // future edit turns this back into a verb blocklist, these go red.
  "cp /tmp/evil .husky/pre-push",
  "tee .husky/pre-push",
  "sed -i s/exit/return/ .husky/pre-push",
  "Set-Content .codex/hooks.json",
  "Copy-Item /tmp/x .claude/hooks/sql-safety.mjs",
  "echo x >| .husky/pre-push",
  "Out-File -FilePath .husky/pre-push",
  "Add-Content .coderabbit.yaml",
  "install -m 755 /tmp/x .husky/pre-push",
  "dd if=/tmp/x of=.husky/pre-push",
  "python -c open('.husky/pre-push','w')",
  "perl -i -pe s/a/b/ .husky/pre-push",
  // An unrecognized head is a writer by construction — the whole point of the
  // allowlist. No new verb has to be enumerated for this to hold.
  "someNewTool --overwrite .husky/pre-push",
  // SECOND gpt-5.6-sol round. Each of these wears a read-only head and still
  // writes a NAMED file; each was probe-confirmed ALLOW before this fix. This is
  // not the documented hidden-indirection residual — the target is right there in
  // the command text.
  "node -e require('fs').writeFileSync('.husky/pre-push','')",
  "node --eval require('fs').writeFileSync('.husky/pre-push','')",
  "sed -n w .husky/pre-push /dev/null",
  "sort -o .husky/pre-push /dev/null",
  "find . -name x -fprintf .husky/pre-push %p",
  "awk -v p=.husky/pre-push END{print>p}",
  // `..` traversal through an existing sibling directory resolves onto the real
  // hook. Same round, HIGH, and a re-opened bypass the deleted lock had closed.
  "cp /tmp/evil .claude/commands/../hooks/review-proof-guard.mjs",
  "tee .claude/commands/../hooks/sql-safety.mjs",
  "cp /tmp/evil .github/ISSUE_TEMPLATE/../workflows/ci.yml",
  // THIRD gpt-5.6-sol round. A WRAPPER hides the real program from a head-only
  // check: bare `cp` denied while `command cp` was ALLOW. Wrappers are refused by
  // never being listed, so this block also pins the ones nobody has tried yet.
  "command cp /tmp/evil .husky/pre-push",
  "env cp /tmp/evil .husky/pre-push",
  "exec cp /tmp/evil .husky/pre-push",
  "timeout 5 cp /tmp/evil .husky/pre-push",
  "sudo cp /tmp/evil .husky/pre-push",
  "xargs cp .husky/pre-push",
  // Utilities that take an OUTPUT operand or an in-place flag, all probe-confirmed
  // ALLOW before removal from the allowlist.
  "uniq /tmp/in .husky/pre-push",
  "diff --output=.husky/pre-push a b",
  "yq -i .a=1 .codex/hooks.json",
  "xxd -r /tmp/x .husky/pre-push",
  // A package runner executes an arbitrary program with the protected path as its
  // argument. `node <script>` stays allowed; these do not.
  "npx rimraf .husky",
  "npm exec rimraf .husky/pre-push",
  "yarn rimraf .claude/hooks/sql-safety.mjs",
]) {
  const result = run({ tool_name: "Bash", tool_input: { command } });
  assert.equal(result.status, 0, `hook should exit 0: ${command}`);
  assert.match(result.stdout, /"permissionDecision":"deny"/, `must deny: ${command}`);
}

// Reading them stays allowed — that is the whole reason this is a destructive-verb
// rule and not a deny-every-mention rule. Routine work reads these constantly.
for (const command of [
  "cat .husky/pre-push",
  "grep -rn typecheck .husky/",
  "ls -la .github/workflows",
  "head -20 .coderabbit.yaml",
  "git diff .codex/hooks.json",
  "git log --oneline .husky/",
  "git show HEAD:.husky/pre-push",
  // `-am` must not read as the `am` subcommand — this is why GIT_OVERWRITE_RE
  // requires whitespace immediately before the verb.
  "git commit -am wired .husky/pre-push",
  // `-C <dir>` takes a SEPARATE value. A naive flag-skipper reads the directory
  // as the subcommand and fails closed on an ordinary stage — which this rule
  // actually did, blocking `git -C <worktree> add .claude/hooks/...`.
  "git -C /repo add .claude/hooks/review-proof-guard.mjs",
  "git -c core.pager=cat log .husky/pre-push",
  "git --git-dir /repo/.git diff .husky/pre-push",
  // `node <script>` stays allowed — it is how these very suites run. Only the
  // inline-code flags are refused (asserted in the deny block above).
  "node .claude/hooks/review-proof-guard.test.mjs",
  "node scripts/agent-health-check.mjs .husky",
  "find .github/workflows -name *.yml",
  "Get-Content .husky/pre-push",
  "Select-String typecheck .husky/pre-push",
  // A redirect that READS one of these and writes somewhere harmless is not a
  // write INTO the surface; the old lock got this wrong and blocked diagnostics.
  "cat .husky/pre-push > /tmp/out.txt",
]) {
  const result = run({ tool_name: "Bash", tool_input: { command } });
  assert.equal(result.status, 0, `hook should exit 0: ${command}`);
  assert.equal(result.stdout, "", `must allow: ${command}`);
}

// Near-misses must NOT be swept up: the path components are whole words.
for (const command of [
  "rm -rf .husky-backup",
  "rm -rf my.husky",
  "rm -rf .github/ISSUE_TEMPLATE",
]) {
  const result = run({ tool_name: "Bash", tool_input: { command } });
  assert.equal(result.status, 0, `hook should exit 0: ${command}`);
  assert.equal(result.stdout, "", `must allow near-miss: ${command}`);
}

// Path-field writers (MCP filesystem tools, move/copy tools, patch destinations)
// must deny too — Codex listed these alongside the shell bypasses.
for (const payload of [
  { tool_name: "mcp__filesystem__write_file", tool_input: { path: ".husky/pre-push" } },
  { tool_name: "mcp__filesystem__move_file", tool_input: { source: "/tmp/x", destination: ".claude/hooks/sql-safety.mjs" } },
  { tool_name: "mcp__filesystem__edit_file", tool_input: { path: ".codex/hooks.json" } },
  { tool_name: "apply_patch", tool_input: { patch: "*** Begin Patch\n*** Update File: .github/workflows/ci.yml\n" } },
  // Traversal through the path field — the MCP half of the same HIGH.
  { tool_name: "mcp__filesystem__write_file", tool_input: { path: ".claude/commands/../hooks/review-proof-guard.mjs" } },
  { tool_name: "mcp__filesystem__write_file", tool_input: { path: ".github/ISSUE_TEMPLATE/../workflows/ci.yml" } },
  { tool_name: "mcp__filesystem__write_file", tool_input: { path: ".claude\\commands\\..\\hooks\\sql-safety.mjs" } },
]) {
  const result = run(payload);
  assert.equal(result.status, 0, `hook should exit 0: ${payload.tool_name}`);
  assert.match(result.stdout, /"permissionDecision":"deny"/, `path-field writer must deny: ${payload.tool_name}`);
}

// Native Write/Edit are deliberately NOT denied here — there is no unlock any
// more, so denying them would permanently strand hook maintenance. The `ask` tier
// gates them instead. Pinned so the exemption stays a recorded choice.
for (const payload of [
  { tool_name: "Write", tool_input: { file_path: ".claude/hooks/sql-safety.mjs", content: "x" } },
  { tool_name: "Edit", tool_input: { file_path: ".husky/pre-push" } },
]) {
  const result = run(payload);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "", `native editor stays with the ask tier: ${payload.tool_name}`);
}

// KNOWN OVER-BLOCK, pinned deliberately rather than papered over. A dotted
// SUFFIX on the review config (`.coderabbit.yaml.bak`) is refused, because the
// boundary after the path group is `(?![\w-])` and `.` is neither. Widening it to
// `(?![\w.-])` would fix this and simultaneously stop `.codex/hooks.json` from
// matching at all — trading a harmless refusal of a backup file for a real hole
// in the hook-registration coverage. Refusing more is the correct side to err on;
// this test exists so the behavior is a recorded choice, not a latent surprise.
{
  const result = run({ tool_name: "Bash", tool_input: { command: "rm -f .coderabbit.yaml.bak" } });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /"permissionDecision":"deny"/);
}

console.log("OK - review proof guard checks passed.");
