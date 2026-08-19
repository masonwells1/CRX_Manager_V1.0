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

console.log("OK - review proof guard checks passed.");
