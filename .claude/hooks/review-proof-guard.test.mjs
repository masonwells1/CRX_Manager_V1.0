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

console.log("OK - review proof guard checks passed.");
