#!/usr/bin/env node
// Tests for codex-recursion-guard.mjs.
//
// The two REAL commands from the 2026-08-23 incident are the first cases, verbatim:
// a guard that does not stop those has not fixed anything.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { classifyCommand, normalizeExecutable } from "./codex-recursion-guard.mjs";

const HOOK_PATH = fileURLToPath(new URL("./codex-recursion-guard.mjs", import.meta.url));

// End-to-end through the REAL hook process, not the exported classifier.
// Sol's round-8 HIGH was invisible to every classifier-level test: the parser was
// correct and the ENTRYPOINT read the wrong field. Testing the pure function only
// would have kept reporting 30/30 green while the Codex wiring was dead.
function runHook(toolInput) {
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: toolInput }),
    encoding: "utf8",
  });
  return JSON.parse(result.stdout).hookSpecificOutput.permissionDecision;
}

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

const blocks = (cmd) => classifyCommand(cmd);
const rule = (cmd) => classifyCommand(cmd)?.rule ?? null;

// ── The incident itself ───────────────────────────────────────────────────────
check("blocks the exact taskkill that destroyed the 2026-08-23 review", () => {
  assert.equal(rule("taskkill /PID 39564 /T /F"), "force-kill");
});

check("blocks the exact Stop-Process tree-kill attempt from the same session", () => {
  const real =
    '$root=39564; $all=Get-CimInstance Win32_Process; $ids | Sort-Object -Descending | ' +
    'ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }';
  assert.equal(rule(real), "force-kill");
});

check("blocks the nested codex review the reviewer spawned", () => {
  const real =
    'codex review --base origin/main -c \'model="gpt-5.6-sol"\' ' +
    "-c 'model_reasoning_effort=\"high\"' -c approval_policy=never";
  assert.equal(rule(real), "codex-review");
});

check("a PID-only kill is caught even though it never says codex", () => {
  // The whole point: matching the word "codex" would have missed the real command.
  const cmd = "taskkill /PID 12345 /T /F";
  assert.ok(!/codex/i.test(cmd));
  assert.equal(rule(cmd), "force-kill");
});

// ── codex review spellings ────────────────────────────────────────────────────
check("blocks a versioned absolute-path codex.exe review", () => {
  assert.equal(
    rule('"/c/Users/mason/AppData/Local/OpenAI/Codex/bin/110b3d66a02d864e/codex.exe" review --base origin/main'),
    "codex-review",
  );
});

check("blocks codex review wrapped in pwsh -Command", () => {
  assert.equal(rule('pwsh -NoProfile -Command "codex review --base origin/main"'), "codex-review");
});

check("blocks codex review after a shell separator", () => {
  assert.equal(rule("cd /repo && codex review --uncommitted"), "codex-review");
});

check("blocks the $CODEX spelling this repo's own skill documented", () => {
  // `"$CODEX" review $SCOPE` is verbatim what .claude/skills/codex-review/SKILL.md
  // printed. A guard that missed it would have waved through the documented path.
  assert.equal(rule('"$CODEX" review $SCOPE -c approval_policy=never'), "codex-review");
  assert.equal(rule("$CODEX review --base origin/main"), "codex-review");
  assert.equal(rule("${CODEX} review --base origin/main"), "codex-review");
});

// ── Bypasses Sol found on PR #452 (each failed before the fix) ────────────────
check("P2: blocks `cmd /c codex review` — cmd's wrapper is a command position too", () => {
  assert.equal(rule("cmd /c codex review --base origin/main"), "codex-review");
  assert.equal(rule("cmd.exe /K codex review"), "codex-review");
});

check("P2: blocks global options placed BEFORE the review subcommand", () => {
  // Legal codex usage — options may precede the subcommand. A pattern demanding
  // `codex` and `review` be adjacent waved this through.
  assert.equal(rule('codex -c model="gpt-5.6-sol" review --base origin/main'), "codex-review");
  assert.equal(rule("codex --cd /repo -c approval_policy=never review"), "codex-review");
});

check("P3: blocks the SIGKILL spellings", () => {
  assert.equal(rule("kill -SIGKILL 1234"), "force-kill");
  assert.equal(rule("kill -s SIGKILL 1234"), "force-kill");
  assert.equal(rule("kill -s 9 1234"), "force-kill");
});

check("blocks PowerShell's kill alias, where kill IS Stop-Process", () => {
  assert.equal(rule("kill -Id 39564 -Force"), "force-kill");
  assert.equal(rule("spps -Id 39564"), "force-kill");
});

check("HIGH: blocks the four path/extension spellings Sol proved were allowed", () => {
  // Verbatim from Sol's BLOCKERS verdict on 72405060. Ordinary Windows and POSIX
  // spellings, not obfuscation — each one recreates the reviewer-kill exactly.
  assert.equal(rule("taskkill.exe /PID 39564 /T /F"), "force-kill");
  assert.equal(rule("C:\\Windows\\System32\\taskkill.exe /PID 39564 /T /F"), "force-kill");
  assert.equal(rule("/usr/bin/pkill -9 codex"), "force-kill");
  assert.equal(rule("/bin/kill -9 39564"), "force-kill");
});

check("normalizeExecutable strips path, extension, quotes, and case", () => {
  assert.equal(normalizeExecutable('"C:\\Windows\\System32\\TaskKill.EXE"'), "taskkill");
  assert.equal(normalizeExecutable("/usr/bin/pkill"), "pkill");
  assert.equal(normalizeExecutable("Stop-Process"), "stop-process");
  assert.equal(normalizeExecutable("node"), "node");
});

check("a pathed codex binary review is still caught after the rewrite", () => {
  assert.equal(rule("/usr/local/bin/codex review --base origin/main"), "codex-review");
});

check("still allows codex exec even when the prompt text says review", () => {
  // exec is the subcommand; "review" here is prompt content, not a subcommand.
  assert.equal(blocks('codex exec "review this diff and report"'), null);
  assert.equal(blocks("codex exec --skip-git-repo-check -"), null);
});

// ── Must NOT block ────────────────────────────────────────────────────────────
check("allows codex exec — the wrapper and one-off prompts depend on it", () => {
  assert.equal(blocks("codex exec --skip-git-repo-check -"), null);
});

check("allows the sanctioned wrapper", () => {
  assert.equal(blocks("node scripts/write-codex-push-proof.mjs"), null);
});

check("HIGH round 7: blocks the seven wrapper spellings Sol proved were allowed", () => {
  // Shell builtins and launcher arguments that ended the old position-tracking walk.
  assert.equal(rule("command codex review --base origin/main"), "codex-review");
  assert.equal(rule("exec codex review --base origin/main"), "codex-review");
  assert.equal(rule("cmd /c call codex review --base origin/main"), "codex-review");
  assert.equal(rule("timeout 90 codex review --base origin/main"), "codex-review");
  assert.equal(rule("command taskkill.exe /PID 39564 /T /F"), "force-kill");
  assert.equal(rule("exec /bin/kill -9 39564"), "force-kill");
  assert.equal(
    rule("Start-Process codex.exe -ArgumentList @('review','--base','origin/main')"),
    "codex-review",
  );
});

check("ACCEPTED OVER-BLOCK: prose naming a guarded tool is refused", () => {
  // Previously asserted as allowed. Fail-closed means a token is a token; there is
  // no reliable way to tell `echo taskkill` from an invocation by string shape, and
  // four rounds proved that guessing loses. A refused echo costs one message.
  assert.equal(rule('echo "do not run codex review here"'), "codex-review");
  assert.equal(rule("grep -r taskkill docs/"), "force-kill");
});

check("HIGH: blocks a BARE kill — on Windows `kill` IS Stop-Process", () => {
  // This assertion previously read `assert.equal(blocks("kill 1234"), null)`, pinning
  // a "polite TERM" exemption that is a POSIX fact and false on this machine. Sol
  // proved by read-only execution that `kill 39564` returned "allow". A test that
  // pins a wrong assumption makes the bug permanent — so the exemption is gone and
  // this is its inverse.
  assert.equal(rule("kill 1234"), "force-kill");
  assert.equal(rule("kill 39564"), "force-kill");
});

check("HIGH: blocks launcher-based execution of a guarded kill tool", () => {
  // Sol proved `Start-Process taskkill.exe … /F` slipped past a check that only
  // looked at the command-position token.
  assert.equal(rule("Start-Process taskkill.exe -ArgumentList '/PID','39564','/F'"), "force-kill");
  assert.equal(rule("sudo pkill -9 codex"), "force-kill");
  assert.equal(rule("saps taskkill"), "force-kill");
  assert.equal(rule('pwsh -NoProfile -Command "taskkill /PID 1 /F"'), "force-kill");
});

check("HIGH round 6: blocks the three wrapper spellings Sol proved were allowed", () => {
  // Each returned permissionDecision "allow" against the real hook before this fix.
  assert.equal(rule("Start-Process codex.exe -ArgumentList 'review','--base','origin/main'"), "codex-review");
  assert.equal(rule('cmd /c start "" taskkill.exe /PID 39564 /T /F'), "force-kill");
  assert.equal(rule("env X=1 pkill -9 codex"), "force-kill");
});

check("an empty quoted arg does not end the walk", () => {
  // `start ""` supplies a window title; it used to terminate the scan.
  assert.equal(rule('start "" taskkill /F /PID 1'), "force-kill");
});

check("an env assignment does not end the walk", () => {
  assert.equal(rule("env A=1 B=2 killall node"), "force-kill");
});

check("a launcher running something harmless is still allowed", () => {
  assert.equal(blocks("sudo npm install"), null);
  assert.equal(blocks("timeout 90 codex exec -"), null);
  assert.equal(blocks("env NODE_ENV=test npm run test"), null);
});

check("allows unrelated commands", () => {
  assert.equal(blocks("npm run test"), null);
  assert.equal(blocks("git status --short"), null);
  assert.equal(blocks(""), null);
  assert.equal(blocks(undefined), null);
});

check("allows a filename that merely contains the word killall", () => {
  assert.equal(blocks("cat docs/killall-notes.md"), null);
});

// ── Round 8 (Sol on 1bdf061c) ─────────────────────────────────────────────────
check("HIGH round 8: a Codex-native `cmd` payload is guarded, not just `command`", () => {
  // The hook read only tool_input.command. `.codex/hooks.json` forwards Codex's
  // payload unchanged, and Codex carries the text in `cmd` — so the Codex half of
  // the wiring this PR adds was DEAD and returned "allow" for both rules.
  assert.equal(runHook({ cmd: "taskkill /PID 39564 /T /F" }), "deny");
  assert.equal(runHook({ cmd: "codex review --base origin/main" }), "deny");
  // The Claude field still works, and benign commands still pass on both fields.
  assert.equal(runHook({ command: "taskkill /PID 39564 /T /F" }), "deny");
  assert.equal(runHook({ command: "git status --short" }), "allow");
  assert.equal(runHook({ cmd: "git status --short" }), "allow");
});

check("HIGH round 8: .cmd/.bat/.ps1 are executable extensions too", () => {
  // `codex.cmd` is the shim extension an npm-installed CLI actually gets on
  // Windows; only `.exe` was stripped, so this was an ordinary allowed spelling.
  assert.equal(rule("codex.cmd review --base origin/main"), "codex-review");
  assert.equal(rule("taskkill.bat /PID 1 /F"), "force-kill");
  assert.equal(normalizeExecutable("codex.cmd"), "codex");
  assert.equal(normalizeExecutable("Stop-Process.ps1"), "stop-process");
});

check("HIGH round 8: termination via an API call, naming no kill program", () => {
  // None of these contain a guarded executable name, so the basename walk is blind
  // to them. Each was proven to return "allow".
  assert.equal(rule("Get-Process codex | ForEach-Object { $_.Kill() }"), "force-kill");
  assert.equal(rule("node -e \"process.kill(39564, 'SIGKILL')\""), "force-kill");
  assert.equal(
    rule("Invoke-CimMethod -InputObject $p -MethodName Terminate"),
    "force-kill",
  );
  assert.equal(rule("wmic process where name='codex.exe' call terminate"), "force-kill");
});

check("the API-call patterns do not swallow ordinary commands", () => {
  assert.equal(blocks("npm run test"), null);
  assert.equal(blocks("git log --oneline -5"), null);
  assert.equal(blocks("node scripts/write-codex-push-proof.mjs"), null);
});

// ── Round 9 (Sol on c4c0898c) ─────────────────────────────────────────────────
check("HIGH round 9: platform-native variable expansion", () => {
  // The hook is registered for PowerShell, but only the Bash `$CODEX` form was
  // recognised. These are the ordinary PowerShell and cmd.exe spellings.
  assert.equal(rule("& $env:CODEX review --base origin/main"), "codex-review");
  assert.equal(rule("cmd /c %CODEX% review --base origin/main"), "codex-review");
  assert.equal(rule("& ${env:CODEX} review"), "codex-review");
});

check("HIGH round 9: quotes INSIDE the executable name", () => {
  // The shell concatenates `c"od"ex` before exec, so the guard must too. Only
  // leading/trailing quotes were stripped.
  assert.equal(rule('c"od"ex review --base origin/main'), "codex-review");
  assert.equal(normalizeExecutable('c"od"ex'), "codex");
});

check("the same quote trick on a termination tool — found by probing, not reported", () => {
  // Sol reported the codex-side spelling only. The kill side splits identically,
  // and a fix for one that left the other open would be the same bug twice.
  assert.equal(rule('task"kill" /PID 39564 /F'), "force-kill");
  assert.equal(rule("pk'i'll -9 codex"), "force-kill");
});

check("variable matching stays anchored to the CODEX name", () => {
  // A whole-token match, so an unrelated variable is not swept up.
  assert.equal(blocks("$env:EDITOR review-notes.md"), null);
  assert.equal(blocks("echo %PATH%"), null);
});

check("CodeRabbit on the final head: a redirect glued to the executable", () => {
  // Bash launches the program identically; only the output moves. The redirect
  // stayed inside the token, so the guarded name was never seen.
  assert.equal(rule("codex>/tmp/review.log review --base origin/main"), "codex-review");
  assert.equal(rule("/bin/kill>/tmp/out.log -9 39564"), "force-kill");
  assert.equal(rule("taskkill.exe>nul /PID 39564 /F"), "force-kill");
  assert.equal(rule("codex 2>&1 review --base origin/main"), "codex-review");
});

check("redirection splitting does not break ordinary commands", () => {
  assert.equal(blocks("npm run build > build.log 2>&1"), null);
  assert.equal(blocks("git log --oneline > /tmp/log.txt"), null);
});

// ── Deny payload shape ────────────────────────────────────────────────────────
check("a blocked command names the wrapper as the alternative", () => {
  const v = classifyCommand("codex review --base origin/main");
  assert.match(v.reason, /write-codex-push-proof\.mjs/);
});

check("a blocked kill points at TaskStop rather than another kill", () => {
  const v = classifyCommand("taskkill /PID 1 /F");
  assert.match(v.reason, /TaskStop/);
});

console.log(`\n${passed} checks passed.`);
