#!/usr/bin/env node
// Tests for bash-safety-lib.mjs (dangerous-command patterns + npm-script
// indirection, FIX 2) and a couple of LIVE invocations of bash-safety.mjs
// itself (benign command allowed, dangerous command denied).
// Run: node .claude/hooks/bash-safety.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmodSync, existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkMaintenanceProducerInvocation,
  checkDangerousCommand,
  checkAskCommand,
  checkCommandDeep,
  checkMigrationModify,
  extractNpmRunNames,
  fixedTrustedGitExecutable,
  maintenanceProducerCommandMentioned,
  resolveNpmScriptChain,
  readPackageScripts,
  SECURITY_COMMAND_CHAR_BUDGET,
  SECURITY_COMMAND_TOKEN_BUDGET,
} from "./bash-safety-lib.mjs";
import { gitLocalEnvironmentNames } from "./git-test-env.mjs";

// Husky invokes this suite from a Git hook and exports repository/index
// redirect variables. Disposable fixtures must not inherit those redirects,
// and bootstrap-specific tests need to add hostile variables deliberately.
for (const name of gitLocalEnvironmentNames()) delete process.env[name];
for (const name of Object.keys(process.env)) {
  if (/^GIT_(?:CONFIG(?:_.+)?|DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|REPLACE_REF_BASE|COMMON_DIR|NAMESPACE|EXEC_PATH|EXTERNAL_DIFF|DIFF_OPTS)$/i.test(name)) delete process.env[name];
  if (/^(?:NODE_OPTIONS|NPM_CONFIG_(?:USERCONFIG|GLOBALCONFIG|NODE_OPTIONS|SCRIPT_SHELL)|PYTHON(?:PATH|HOME|STARTUP|USERBASE|INSPECT))$/i.test(name)) delete process.env[name];
}
process.env.PATH = `${path.dirname(fixedTrustedGitExecutable())}${path.delimiter}${process.env.PATH || ""}`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }
function eq(a, b, m) { assert.equal(a, b, m); pass++; }
// Windows resolves a backslash-separated relative command; POSIX treats the
// backslash as a literal filename character, so `scripts\x.bat` there names a
// file that does not exist and the guard has nothing to classify. Exercise the
// backslash spelling only where the platform actually resolves it, so these
// assertions test the deny they name instead of a missing-path accident.
const nativeCommandPath = (relative) => (process.platform === "win32" ? relative.replaceAll("/", "\\") : relative);
function runHook(payload, cwd) {
  return spawnSync(process.execPath, [path.join(__dirname, "bash-safety.mjs")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    cwd: cwd || process.cwd(),
  });
}

// ── direct dangerous-command patterns (unchanged behavior) ────────────────
ok(checkDangerousCommand("git push --force origin main"), "force push blocked");
ok(checkDangerousCommand("git push -f origin main"), "force push -f blocked");
ok(checkDangerousCommand("git reset --hard HEAD~1"), "hard reset blocked");
ok(checkDangerousCommand("git checkout ."), "discard-all checkout blocked");
ok(checkDangerousCommand("git clean -fd"), "git clean -f blocked");
ok(checkDangerousCommand("npm test -- --no-verify"), "--no-verify blocked");
// Hard-link aliasing of a protected file (Codex CRX-SEC-01, 2026-08-23). The
// alias gets an innocuous pathname for the same file data, so a later write
// through it edits the protected file while every path pattern sees nothing.
ok(checkDangerousCommand("mklink /H notes.mjs .claude\\hooks\\bash-safety-lib.mjs"), "mklink /H alias of a protected hook blocked");
ok(checkDangerousCommand("mklink /h scratch\\x.json .claude\\settings.json"), "mklink /h alias of settings.json blocked");
ok(checkDangerousCommand("ln .claude/hooks/mcp-tool-guard.mjs /tmp/alias.mjs"), "POSIX hard link to a protected hook blocked");
ok(checkDangerousCommand("ln supabase/migrations/20260101000000_x.sql /tmp/m.sql"), "POSIX hard link to a migration blocked");
// The junction->hardlink->write chain Codex demonstrated (2026-08-24). Only the
// FIRST command names a protected path; the hard link and the write are laundered
// through the alias directory. Every step must deny on its own, because an
// attacker does not have to run them in one command.
ok(checkDangerousCommand("mklink /J scratch\\hooks .claude\\hooks"), "the junction hop that launders a protected path is blocked");
ok(checkDangerousCommand("mklink /H scratch\\alias.mjs scratch\\hooks\\mcp-tool-guard.mjs"), "the laundered hard link is blocked even though its text names no protected path");
// Aliases aimed at a protected location are blocked whatever kind they are.
ok(checkDangerousCommand("ln -s .claude/hooks/mcp-tool-guard.mjs /tmp/alias.mjs"), "a symlink aimed at a protected hook is blocked");
ok(checkDangerousCommand("mklink /D scratch\\hooks .claude\\hooks"), "a directory symlink aimed at the protected hooks directory is blocked");
ok(checkDangerousCommand("New-Item -ItemType SymbolicLink -Path scratch\\h -Target .claude\\hooks"), "a PowerShell symlink aimed at a protected location is blocked");
// Hard links are denied outright, so an unprotected target is no longer a way in.
ok(checkDangerousCommand("mklink /H scratch\\a.txt docs\\README.md"), "hard-link creation is denied even between unprotected files");
ok(checkDangerousCommand("ln docs/README.md /tmp/readme.md"), "a POSIX hard link is denied even between unprotected files");
// `cp` and `link` create the same alias without ever saying "link" the way ln
// does (Codex, 2026-08-24). Defence in depth only — the identity check at the
// write boundary is what actually holds when a creator is not on this list.
ok(checkDangerousCommand("cp -l .claude/hooks/bash-safety-lib.mjs scratch/alias.mjs"), "cp -l is denied");
ok(checkDangerousCommand("cp --link docs/README.md scratch/a.md"), "cp --link is denied");
ok(checkDangerousCommand("cp -al src scratch/src"), "a combined short cluster containing -l is denied");
ok(checkDangerousCommand("link .claude/hooks/bash-safety-lib.mjs scratch/alias.mjs"), "the standalone link utility is denied");
ok(checkDangerousCommand("busybox cp -l docs/README.md scratch/a.md"), "busybox cp -l is denied");
// Ordinary copying must keep working, including flags that merely contain other
// letters, so this does not become a tax on normal work.
eq(checkDangerousCommand("cp -r src scratch/src"), null, "an ordinary recursive copy is allowed");
eq(checkDangerousCommand("cp docs/README.md scratch/a.md"), null, "an ordinary copy is allowed");
eq(checkDangerousCommand("cp -p docs/README.md scratch/a.md"), null, "a preserving copy is allowed");
// Ordinary symlinks away from protected locations still work.
eq(checkDangerousCommand("ln -s docs/README.md /tmp/readme.md"), null, "an ordinary symlink to an unprotected file is allowed");
eq(checkDangerousCommand("mklink /D scratch\\docs docs"), null, "a directory symlink to an unprotected directory is allowed");
// Other spellings of the same alias. A guard that knows only `mklink`/`ln`
// leaves the route open through PowerShell and fsutil.
ok(checkDangerousCommand("New-Item -ItemType HardLink -Path scratch\\notes.mjs -Target .claude\\hooks\\bash-safety-lib.mjs"), "PowerShell New-Item HardLink to a protected hook blocked");
ok(checkDangerousCommand("New-Item -Target .claude\\hooks\\bash-safety-lib.mjs -ItemType HardLink -Path scratch\\notes.mjs"), "PowerShell New-Item HardLink blocked with the target named first");
ok(checkDangerousCommand("ni -Type HardLink -Path x.json -Target .claude\\settings.json"), "the ni alias and -Type spelling are blocked too");
ok(checkDangerousCommand("fsutil hardlink create scratch\\alias.mjs .claude\\hooks\\mcp-tool-guard.mjs"), "fsutil hardlink create against a protected hook blocked");
ok(checkDangerousCommand("New-Item -ItemType HardLink -Path scratch\\a.txt -Target docs/README.md"), "hard-link creation is denied even when both operands are unprotected");
// PowerShell evaluates the item type, so the literal token can be assembled at
// runtime and never appear in the command text (Codex, 2026-08-24). The item
// type must therefore be a recognized safe literal or the command fails closed.
ok(checkDangerousCommand('New-Item -ItemType ("Hard"+"Link") -Path scratch/n.mjs -Target .claude/hooks/bash-safety-lib.mjs'), "a concatenated item type cannot smuggle a hard link past the literal matcher");
ok(checkDangerousCommand("New-Item -ItemType $t -Path scratch/n.mjs -Target .claude/hooks/bash-safety-lib.mjs"), "a variable item type fails closed");
ok(checkDangerousCommand("ni -Type ('Hard'+'Link') -Path a -Target b"), "the ni alias with a computed -Type fails closed");
ok(checkDangerousCommand("New-Item -ItemType ([char]72+'ardLink') -Path a -Target b"), "a char-code item type fails closed");
// The safe literals stay usable, including the ordinary directory creation that
// real work depends on.
eq(checkDangerousCommand("New-Item -ItemType Directory -Path scratch/output"), null, "creating a directory is allowed");
eq(checkDangerousCommand("New-Item -ItemType File -Path scratch/notes.txt"), null, "creating a file is allowed");
eq(checkDangerousCommand("New-Item -Path scratch/notes.txt"), null, "New-Item without an item type is allowed");
eq(checkDangerousCommand("New-Item -ItemType SymbolicLink -Path scratch/a -Target docs/README.md"), null, "a symlink to an unprotected target is still allowed");
ok(checkDangerousCommand("rm -rf src"), "rm -rf src blocked");
ok(checkDangerousCommand("rm -rf supabase"), "rm -rf supabase blocked");
ok(checkDangerousCommand("git add file.txt .env"), "staging .env blocked");
ok(checkDangerousCommand("npx supabase db push"), "supabase db push blocked");
ok(checkDangerousCommand("supabase db push"), "bare (non-npx) supabase db push blocked — 2026-07-16 review B1");
ok(checkDangerousCommand("cd repo && supabase db push --linked"), "supabase db push blocked mid-compound-command");
ok(checkDangerousCommand("supabase migration up"), "bare supabase migration up blocked — sibling live-apply spelling");
ok(checkDangerousCommand("npx supabase migration up --linked"), "npx supabase migration up blocked");
ok(checkDangerousCommand("supabase db reset"), "supabase db reset blocked");
ok(checkDangerousCommand("dropdb mydb"), "dropdb blocked");
ok(checkDangerousCommand("git branch -D main"), "force-delete main blocked");
ok(checkDangerousCommand("git push --mirror origin"), "push --mirror blocked");
ok(checkDangerousCommand("git filter-branch --force"), "filter-branch blocked");
ok(checkDangerousCommand("rm -rf /etc"), "rm -rf /etc blocked (outside scratch allowlist)");
ok(checkDangerousCommand("npm run nuke"), "npm run nuke blocked (literal script name)");
ok(checkDangerousCommand('psql -c "DROP TABLE customers;"'), "psql DROP TABLE blocked");
ok(!checkDangerousCommand("npm run build"), "npm run build allowed");
ok(!checkDangerousCommand("git status"), "git status allowed");
ok(!checkDangerousCommand("git push origin feature/x"), "ordinary feature push allowed");
ok(!checkDangerousCommand(""), "empty command allowed");
ok(!checkDangerousCommand(null), "null command allowed (no throw)");
eq(checkDangerousCommand("x".repeat(SECURITY_COMMAND_CHAR_BUDGET)), null, "command at the inspection budget remains inspectable");
ok(checkDangerousCommand("x".repeat(SECURITY_COMMAND_CHAR_BUDGET + 1)), "command above the inspection budget fails closed");

// ── maintenance producer: current outer shell guard closes the pre-bootstrap
//    TOCTOU gap before the generated production-action guard is installed. ──
const decodedPowerShellProcessLaunch = "Set-Item Env:NODE_OPTIONS ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('LS1yZXF1aXJlPS4vcHJlbG9hZC5janM='))); Set-Variable E ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('bm9kZQ=='))); Set-Variable A @(([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('c2NyaXB0cy9hcHBseS1saXZlLXRlc3RkYXRhLW1haW50ZW5hbmNlLTIwMjYwODEyLm1qcw=='))),([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('LS1hcHByb3ZlZC1ieS1tYXNvbj0yMDI2LTA4LTEy')))); Start-Process (Get-Variable E -ValueOnly) -ArgumentList (Get-Variable A -ValueOnly) -Wait -NoNewWindow";
for (const command of [
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --approved-by-mason=2026-08-12",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --approved-by-mason=2026-08-12 --protect-producer",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --approved-by-mason=2026-08-12 --retire-producer",
]) {
  eq(checkMaintenanceProducerInvocation(command), null, `exact producer invocation allowed by shell guard: ${command}`);
}
for (const command of [
  decodedPowerShellProcessLaunch,
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --verify; Write-Output chained",
  "[IO.File]::WriteAllText('scripts/apply-live-testdata-maintenance-20260812.mjs','owned'); node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --verify --unknown",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --protect-producer --approved-by-mason=2026-08-12",
  "node \"scripts/apply-live-testdata-maintenance-20260812.mjs\" --verify",
  "node scripts\\apply-live-testdata-maintenance-20260812.mjs --verify",
  "cmd /c node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
  "env FLAG=1 node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
  "node scripts/apply-live-testdata-maintenance-20260812.?js --approved-by-mason=2026-08-12",
  "node scripts/apply-live-testdata-ma[i]ntenance-20260812.mjs --approved-by-mason=2026-08-12",
  "node scripts/appl?-live-testdata-maintenance-20260812.mjs --approved-by-mason=2026-08-12",
  "node scripts/apply-l[i]ve-testdata-maintenance-20260812.mjs --approved-by-mason=2026-08-12",
  "node scripts/appl?-live-testdata-maintenance-2026081?.mjs --approved-by-mason=2026-08-12",
  "node scripts/appl?-live-testdata-maintenance-2026081?.mjs --approved-by-mason=2026-08-$(printf 12)",
  "node scripts/appl?-live-testdata-maintenance-2026081?.mjs --approved-by-$(printf mason)=2026-08-12",
  "node scripts/$(printf apply-live-testdata-maintenance-20260812.mjs) --approved-by-mason=2026-08-12",
  "node --no-warnings scripts/$(printf apply-live-testdata-maintenance-20260812.mjs) --approved-by-$(printf mason)=2026-08-12",
  "node --require fs scripts/$(printf apply-live-testdata-maintenance-20260812.mjs) --approved-by-$(printf mason)=2026-08-12",
  "node </dev/null --no-warnings scripts/$(printf YXBwbHktbGl2ZS10ZXN0ZGF0YS1tYWludGVuYW5jZS0yMDI2MDgxMi5tanM= | base64 -d) --approved-by-$(printf bWFzb24= | base64 -d)=2026-08-12",
  "node --no-warnings \\\nscripts/$(printf YXBwbHktbGl2ZS10ZXN0ZGF0YS1tYWludGVuYW5jZS0yMDI2MDgxMi5tanM= | base64 -d) --approved-by-$(printf bWFzb24= | base64 -d)=2026-08-12",
  "node --require ./preload.cjs scripts/apply-l{i..i}ve-testdata-maintenance-20260{8..8}12.mjs --approved-by-ma{s..s}on=2026-08-12",
  'python -c "import base64; exec(base64.b64decode(PAYLOAD))"',
  "awk 'BEGIN { cmd = decode(); system(cmd) }'",
  "gawk 'BEGIN { cmd = decode(); system(cmd) }'",
  "mawk 'BEGIN { cmd = decode(); system(cmd) }'",
  "nawk 'BEGIN { cmd = decode(); system(cmd) }'",
  "printf %s ENCODED | base64 -d | sh",
  "printf %s ENCODED | base64 -d | xargs",
  "sh -- < encoded-command.txt",
  "bash launch.sh",
  ". ./launch.ps1",
  'Invoke-Expression "$COMMAND"',
  "Invoke-Command -ScriptBlock ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('ZW5jb2RlZA=='))))",
  "icm -ScriptBlock ([ScriptBlock]::Create('encoded'))",
  "Start-Job -ScriptBlock ([ScriptBlock]::Create('encoded'))",
  "Start-ThreadJob -ScriptBlock ([ScriptBlock]::Create('encoded'))",
  "Start-RSJob -ScriptBlock ([ScriptBlock]::Create('encoded'))",
  "[ScriptBlock]::Create('encoded').Invoke()",
  'F=$(decode); nodejs --require ./preload.cjs "$F" "$P" "$S" "$T"',
  'F=$(decode); bun --preload ./preload.mjs "$F" "$P" "$S" "$T"',
  'F=$(decode); deno run "$F" "$P" "$S" "$T"',
  'F=$(decode); ./reviewed-runtime --require ./preload.cjs "$F" "$P" "$S" "$T"',
  "node (\"--req\"+\"uire\") ./preload.cjs (\"scripts/apply-\"+\"live-testdata-maintenance-20260812.mjs\") (\"--approved-by-\"+\"mason=2026-08-12\")",
  'cmd /v:on /c "set a=--requ&set b=ire&set c=scripts/apply-live-testdata-maintenance-20260812.mjs&node !a!!b! ./preload.cjs !c! --approved-by-mason=2026-08-12"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); command node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); command -p node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); exec node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); exec -c node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); env -i node --no-warnings "$F" "$P" "$S" "$T"',
  'set F=encoded& set P=encoded& set S=encoded& set T=encoded& cmd /v:on /c "node --no-warnings !F! !P! !S! !T!"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); exec -ca reviewed-name node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); env --default-signal node --no-warnings "$F" "$P" "$S" "$T"',
  'PACKED=$(decode); env -S "$PACKED"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); command -p -- node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); exec -a "reviewed name" node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); env -C "C:\\temp dir" node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); nohup node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); nice node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); timeout 5 node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); taskset -c 0 node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); ionice -c 3 node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); unshare -Ur node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); setsid node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); stdbuf -o0 node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); (node --no-warnings "$F" "$P" "$S" "$T")',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); "node" --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); nohup "node" --no-warnings "$F" "$P" "$S" "$T"',
  'PACKED=$(decode); env -S"$PACKED"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); Select-String -Pattern\n"node" --no-warnings "$F" "$P" "$S" "$T"',
  'set F=encoded& set P=encoded& set S=encoded& set T=encoded& cmd /v:on /c"node --no-warnings !F! !P! !S! !T!"',
  'PACKED=$(decode); env -a reviewed-name -S"$PACKED"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); Select-String -Pattern ^\n"node" --no-warnings "$F" "$P" "$S" "$T"',
  'set F=encoded& set P=encoded& set S=encoded& set T=encoded& cmd /v:on /d/s/c"node --no-warnings !F! !P! !S! !T!"',
  'PACKED=$(decode); env -vS"$PACKED"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); $\'node\' --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); n^ode --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); "n`ode" --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); bash -c \'"node" --no-warnings "$F" "$P" "$S" "$T"\'',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); pwsh -Command \'"node" --no-warnings "$F" "$P" "$S" "$T"\'',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); bash -c \'bash -c "node --no-warnings $F $P $S $T"\'',
  'F=$(decode); bash -c \'echo safe\'; bash -c \'bash -c "node $F"\'',
  'F=$(decode); pwsh -Com \'"node" $F\'',
  'F=$(decode); pwsh -CommandWithArgs \'"node" $F\'',
  'F=$(decode); pwsh -cwa \'"node" $F\'',
  'pwsh -EncodedCommand ZW5jb2RlZA==',
  'ENC=$(decode); pwsh -ec "$ENC"',
  'F=$(decode); pwsh /Com \'"node" $F\'',
  'F=$(decode); pwsh /CommandWithArgs \'"node" $F\'',
  'F=$(decode); pwsh /cwa \'"node" $F\'',
  'F=$(decode); pwsh /Com:\'"node" $F\'',
  'pwsh /EncodedCommand ZW5jb2RlZA==',
  'pwsh /EncodedCommand:ZW5jb2RlZA==',
  'ENC=$(decode); pwsh /ec "$ENC"',
  'F=$(decode); "pwsh" /Com \'"node" $F\'',
  '"pwsh" /EncodedCommand ZW5jb2RlZA==',
  'pwsh "$env:OPT" "$env:PAYLOAD"',
  'pwsh @args',
  "Start-Process pwsh -ArgumentList '-" + "Encoded" + "Command','ZW5jb2RlZA==' -Wait",
  "Start-Process awk -ArgumentList '-f payload.awk' -Wait",
  "Start-Process env -ArgumentList 'NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs' -Wait",
  "saps awk -ArgumentList '-f payload.awk' -Wait",
  "start env -ArgumentList 'NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs' -Wait",
  "Write-Output payload | xargs pwsh --" + "Encoded" + "Command ZW5jb2RlZA==",
  'Write-Output payload | pwsh -Command -',
  "& ('no','de' -join '') ('--requ','ire' -join '') ./preload.cjs ('scripts/apply-live-testdata-maintenance-20260812','.mjs' -join '') ('--approved-by-','mason=2026-08-12' -join '')",
  '& $EXE $OPTION $MODULE $SCRIPT $APPROVAL',
  "pwsh -Command \"Start-Process pwsh -ArgumentList @('-" + "Encoded" + "Command','ZW5jb2RlZA==') -Wait\"",
  "pwsh -Command \"Start-Process pwsh -ArgumentList '-" + "Encoded" + "Command ZW5jb2RlZA==' -Wait\"",
  "bash -c 'if true; then pwsh --" + "Encoded" + "Command ZW5jb2RlZA==; fi'",
  "pwsh -Command 'if ($true) { pwsh --" + "Encoded" + "Command ZW5jb2RlZA== }'",
  "cmd /d /c '@pwsh --" + "Encoded" + "Command ZW5jb2RlZA=='",
  "cmd /d /c 'call pwsh --" + "Encoded" + "Command ZW5jb2RlZA=='",
  "cmd /d /c 'if 1==1 pwsh --" + "Encoded" + "Command ZW5jb2RlZA=='",
  'F=$(decode); cmd /d /c \'@node "$F"\'',
  "command command command command command command command command command pwsh --" + "Encoded" + "Command ZW5jb2RlZA==",
  "env -vu FOO pwsh --" + "Encoded" + "Command ZW5jb2RlZA==",
  "timeout -vk 1s 5s pwsh --" + "Encoded" + "Command ZW5jb2RlZA==",
  "exec -ca review pwsh --" + "Encoded" + "Command ZW5jb2RlZA==",
  "exec -la review pwsh --" + "Encoded" + "Command ZW5jb2RlZA==",
  "pwsh -Cus reviewpipe --" + "Encoded" + "Command ZW5jb2RlZA==",
  'cmd /d /c pwsh /EncodedCommand ZW5jb2RlZA==',
  'bash -c \'pwsh /EncodedCommand ZW5jb2RlZA==\'',
  'env -S \'pwsh /EncodedCommand ZW5jb2RlZA==\'',
  'pwsh -En\\codedCommand ZW5jb2RlZA==',
  'cmd /c pwsh -En^codedCommand ZW5jb2RlZA==',
  'pwsh --EncodedCommand ZW5jb2RlZA==',
  'F=$(decode); pwsh --Command \'"node" $F\'',
  'F=$(decode); pwsh --CommandWithArgs \'"node" $F\'',
  'bash -c \'pwsh --EncodedCommand ZW5jb2RlZA==\'',
  'pwsh \\/EncodedCommand ZW5jb2RlZA==',
  'MID=w env -S \'p${MID}sh /EncodedCommand ZW5jb2RlZA==\'',
  'pwsh -CustomPipeName reviewpipe --EncodedCommand ZW5jb2RlZA==',
  'pwsh -ep Bypass --EncodedCommand ZW5jb2RlZA==',
  'pwsh -ConfigurationName Microsoft.PowerShell --EncodedCommand ZW5jb2RlZA==',
  'pwsh -ConfigurationFile config.pssc --EncodedCommand ZW5jb2RlZA==',
  'pwsh -SettingsFile settings.json --EncodedCommand ZW5jb2RlZA==',
  'pwsh -inp text --EncodedCommand ZW5jb2RlZA==',
  'pwsh -out text --EncodedCommand ZW5jb2RlZA==',
  'pwsh -w hidden --EncodedCommand ZW5jb2RlZA==',
  'pwsh -wd . --EncodedCommand ZW5jb2RlZA==',
  'cmd /d /k pwsh --EncodedCommand ZW5jb2RlZA==',
  'cmd /d/k"pwsh --EncodedCommand ZW5jb2RlZA=="',
]) {
  ok(maintenanceProducerCommandMentioned(command), `producer spelling recognized by shell guard: ${command}`);
  ok(checkDangerousCommand(command), `non-literal producer invocation denied by shell guard: ${command}`);
}
const producerMutationWord = (codes) => String.fromCharCode(...codes);
const producerWildcardPath = [
  "scripts/apply-live-testdata-maintenance-2026081",
  "?",
  ".mjs",
].join("");
const producerPathMutationCases = [
  [producerMutationWord([103, 105, 116]), producerMutationWord([114, 109]), producerWildcardPath].join(" "),
  [producerMutationWord([103, 105, 116]), producerMutationWord([114, 109]), "scripts/*.mjs"].join(" "),
  [producerMutationWord([103, 105, 116]), producerMutationWord([114, 109]), ":(glob)scripts/**/*.mjs"].join(" "),
  [producerMutationWord([99, 112]), producerWildcardPath, "scratch/producer.mjs"].join(" "),
  [producerMutationWord([109, 118]), "scripts", "scratch/scripts"].join(" "),
  [producerMutationWord([103, 105, 116]), producerMutationWord([109, 118]), producerWildcardPath, "scratch/producer.mjs"].join(" "),
  [producerMutationWord([115, 101, 116, 45, 99, 111, 110, 116, 101, 110, 116]), "scripts/*.mjs", "payload"].join(" "),
  [producerMutationWord([99, 108, 101, 97, 114, 45, 99, 111, 110, 116, 101, 110, 116]), "scripts/*.mjs"].join(" "),
  [producerMutationWord([97, 100, 100, 45, 99, 111, 110, 116, 101, 110, 116]), "scripts/*.mjs", "payload"].join(" "),
  [producerMutationWord([115, 101, 100]), "-i", "s/x/y/", "scripts/*.mjs"].join(" "),
  [producerMutationWord([116, 114, 117, 110, 99, 97, 116, 101]), "-s", "0", "scripts/*.mjs"].join(" "),
  [producerMutationWord([100, 100]), "if=payload", "of=scripts/*.mjs"].join(" "),
  ["Write-Output", "payload", ">", "scripts/*.mjs"].join(" "),
];
for (const command of producerPathMutationCases) {
  ok(maintenanceProducerCommandMentioned(command), `a producer path mutation enters the protected producer gate: ${command}`);
  ok(checkDangerousCommand(command), `a producer path mutation is denied: ${command}`);
}
const unrelatedScriptMutation = [
  producerMutationWord([103, 105, 116]),
  producerMutationWord([114, 109]),
  "scripts/ordinary-tool.mjs",
].join(" ");
ok(!maintenanceProducerCommandMentioned(unrelatedScriptMutation), "a specific unrelated script path stays outside the producer gate");
const redirectedReadOnlyScriptsInput = "rg -n pattern scripts > out.txt";
ok(!maintenanceProducerCommandMentioned(redirectedReadOnlyScriptsInput), "a redirected read-only command does not treat its scripts input as a producer mutation");
ok(!checkDangerousCommand(redirectedReadOnlyScriptsInput), "a redirected read-only scripts search stays allowed");
const redirectedReadOnlyHookResult = runHook({ tool_name: "Bash", tool_input: { command: redirectedReadOnlyScriptsInput } });
eq(redirectedReadOnlyHookResult.status, 0, "the Bash hook exits 0 for a redirected read-only scripts search");
ok(redirectedReadOnlyHookResult.stdout.includes('"permissionDecision":"allow"'), "the Bash hook allows a redirected read-only scripts search");
const protectedRedirectTarget = ["scripts/apply-live-testdata-maintenance-", "20260812.mjs"].join("");
const protectedGlobRedirectTarget = ["scripts/apply-live-testdata-maintenance-", "2026081[2].mjs"].join("");
for (const command of [
  "printf evil>|" + protectedRedirectTarget,
  "printf evil >| " + protectedGlobRedirectTarget,
]) {
  ok(maintenanceProducerCommandMentioned(command), "an adjacent or clobber redirect targets the protected producer: " + command);
  const result = runHook({ tool_name: "Bash", tool_input: { command } });
  eq(result.status, 0, "the Bash hook exits 0 after denying a protected clobber redirect: " + command);
  ok(result.stdout.includes('"permissionDecision":"deny"'), "the Bash hook denies a protected clobber redirect: " + command);
}
{
  const integrityRepo = mkdtempSync(path.join(os.tmpdir(), "producer-integrity-"));
  const externalExecutorDir = mkdtempSync(path.join(os.tmpdir(), "producer-external-executor-"));
  try {
    const integrityRelativePath = ["scripts/apply-live-testdata-maintenance-", "20260812.mjs"].join("");
    const integrityPath = path.join(integrityRepo, ...integrityRelativePath.split("/"));
    const trackedWrapperRelative = "scripts/reviewed-wrapper.mjs";
    const trackedWrapperPath = path.join(integrityRepo, ...trackedWrapperRelative.split("/"));
    const importingWrapperRelative = "scripts/importing-wrapper.mjs";
    const importingWrapperPath = path.join(integrityRepo, ...importingWrapperRelative.split("/"));
    const importedHelperRelative = "scripts/imported-helper.mjs";
    const importedHelperPath = path.join(integrityRepo, ...importedHelperRelative.split("/"));
    const reviewedPythonRelative = "scripts/reviewed.py";
    const reviewedPythonPath = path.join(integrityRepo, ...reviewedPythonRelative.split("/"));
    const childRunnerRelative = "scripts/reviewed-child-runner.mjs";
    const childRunnerPath = path.join(integrityRepo, ...childRunnerRelative.split("/"));
    const builtinEscapeRelative = "scripts/reviewed-builtin-escape.mjs";
    const builtinEscapePath = path.join(integrityRepo, ...builtinEscapeRelative.split("/"));
    const commentLoaderRelative = "scripts/reviewed-comment-loader.mjs";
    const commentLoaderPath = path.join(integrityRepo, ...commentLoaderRelative.split("/"));
    const trackedDirectRelative = "scripts/reviewed-direct.bat";
    const trackedDirectPath = path.join(integrityRepo, ...trackedDirectRelative.split("/"));
    const bootstrapRelative = ["scripts", ["write", "codex", "push", "proof.mjs"].join("-")].join("/");
    const bootstrapPath = path.join(integrityRepo, ...bootstrapRelative.split("/"));
    const ignoredWrapperRelative = "output/ignored-wrapper.mjs";
    const ignoredWrapperPath = path.join(integrityRepo, ...ignoredWrapperRelative.split("/"));
    const ignoredMarkerPath = path.join(integrityRepo, "output", "wrapper-executed.txt");
    const reviewedWrapperSource = "console.log('reviewed wrapper');\n";
    const wrapperSource = [
      'import { spawnSync } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'writeFileSync("output/wrapper-executed.txt", "executed");',
      `spawnSync(process.execPath, [${JSON.stringify(integrityRelativePath)}, "--approved-by-mason=2026-08-12"], { env: { ...process.env, NODE_OPTIONS: "--require=output/preload.cjs" } });`,
      "",
    ].join("\n");
    const integrityGitEnv = { ...process.env };
    for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete integrityGitEnv[name];
    const runIntegrityGit = (args) => spawnSync("git", args, { cwd: integrityRepo, encoding: "utf8", windowsHide: true, env: integrityGitEnv });
    mkdirSync(path.dirname(integrityPath), { recursive: true });
    mkdirSync(path.dirname(ignoredWrapperPath), { recursive: true });
    writeFileSync(integrityPath, "export const reviewed = true;\n");
    writeFileSync(trackedWrapperPath, reviewedWrapperSource);
    writeFileSync(importingWrapperPath, 'import "./imported-helper.mjs";\nconsole.log("reviewed importer");\n');
    writeFileSync(importedHelperPath, 'export const reviewed = true;\n');
    writeFileSync(reviewedPythonPath, 'print("reviewed python")\n');
    writeFileSync(childRunnerPath, 'import { spawnSync } from "node:child_process";\nspawnSync("npx", ["vitest", "run"]);\n');
    writeFileSync(builtinEscapePath, 'process.getBuiltinModule("node:child_process");\n');
    writeFileSync(commentLoaderPath, 'import /* loader gap */ ("../output/ignored-wrapper.mjs");\n');
    writeFileSync(trackedDirectPath, "@echo reviewed direct wrapper\n");
    writeFileSync(bootstrapPath, "console.log('review bootstrap');\n");
    const packageManifest = ["package", "json"].join(".");
    const reviewedPackageSource = JSON.stringify({ scripts: { build: "vite build", test: "echo reviewed test", pretest: "echo reviewed pretest", posttest: "echo reviewed posttest" } });
    writeFileSync(path.join(integrityRepo, packageManifest), reviewedPackageSource);
    mkdirSync(path.join(integrityRepo, "node_modules", ".bin"), { recursive: true });
    writeFileSync(path.join(integrityRepo, "node_modules", ".bin", "vite.cmd"), "@echo off\r\n");
    writeFileSync(path.join(integrityRepo, ".gitignore"), "output/\n");
    let localRefMoveArgs = null;
    for (const args of [
      ["init", "--quiet"],
      ["config", "user.email", "guard-test@example.invalid"],
      ["config", "user.name", "Guard Test"],
      ["add", "--", integrityRelativePath, trackedWrapperRelative, importingWrapperRelative, importedHelperRelative, reviewedPythonRelative, childRunnerRelative, builtinEscapeRelative, commentLoaderRelative, trackedDirectRelative, bootstrapRelative, packageManifest, ".gitignore"],
      ["commit", "--quiet", "-m", "test fixture"],
      ["update-ref", "refs/remotes/origin/main", "HEAD"],
    ]) {
      if (args.length === 3 && String(args[1]).includes("refs/remotes")) localRefMoveArgs = args;
      const result = spawnSync("git", args, { cwd: integrityRepo, encoding: "utf8", windowsHide: true, env: integrityGitEnv });
      eq(result.status, 0, `producer integrity fixture command succeeds: git ${args[0]}`);
    }
    const authoritativeResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: integrityRepo, encoding: "utf8", windowsHide: true, env: integrityGitEnv });
    eq(authoritativeResult.status, 0, "producer fixture authoritative main SHA resolves");
    const reviewOptions = { authoritativeMainShaForTest: authoritativeResult.stdout.trim() };
    const injectedGitShimDir = path.join(integrityRepo, "output", "git-shim");
    const localGitShimMarker = path.join(integrityRepo, "local-git-shim-ran.txt");
    const pathGitShimMarker = path.join(integrityRepo, "path-git-shim-ran.txt");
    mkdirSync(injectedGitShimDir, { recursive: true });
    const writeGitShim = (directory, marker) => {
      const shimPath = path.join(directory, process.platform === "win32" ? "git.cmd" : "git");
      writeFileSync(shimPath, process.platform === "win32"
        ? `@echo shim>"${marker}"\r\n@exit /b 99\r\n`
        : `#!/bin/sh\nprintf shim > '${marker.replaceAll("'", "'\\''")}'\nexit 99\n`);
      if (process.platform !== "win32") chmodSync(shimPath, 0o755);
      return shimPath;
    };
    const localGitShimPath = writeGitShim(integrityRepo, localGitShimMarker);
    const pathGitShimPath = writeGitShim(injectedGitShimDir, pathGitShimMarker);
    const originalPath = process.env.PATH;
    process.env.PATH = `${injectedGitShimDir}${path.delimiter}${originalPath || ""}`;
    eq(checkCommandDeep(`node ${trackedWrapperRelative}`, integrityRepo, reviewOptions), null, "executor provenance uses fixed Git even with local and PATH shims present");
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    ok(!existsSync(localGitShimMarker), "repository-local Git shim never executes during provenance inspection");
    ok(!existsSync(pathGitShimMarker), "PATH-injected Git shim never executes during provenance inspection");
    rmSync(localGitShimPath, { force: true });
    rmSync(pathGitShimPath, { force: true });
    rmSync(injectedGitShimDir, { recursive: true, force: true });
    const integrityCommand = ["node", integrityRelativePath, "--verify"].join(" ");
    eq(checkCommandDeep(integrityCommand, integrityRepo, reviewOptions), null, "an exact producer launch is allowed when HEAD is the reviewed main commit and worktree bytes match");
    eq(checkCommandDeep(`node ${trackedWrapperRelative}`, integrityRepo, reviewOptions), null, "a reviewed file-backed executor is allowed when HEAD is the reviewed main commit");
    eq(checkCommandDeep(`node -- ${trackedWrapperRelative}`, integrityRepo, reviewOptions), null, "a reviewed file-backed executor after -- is allowed on the reviewed main commit");
    eq(checkCommandDeep(`node --no-warnings ${trackedWrapperRelative}`, integrityRepo, reviewOptions), null, "a reviewed Node entrypoint remains available with an explicitly safe startup flag");
    ok(checkCommandDeep(nativeCommandPath(trackedDirectRelative), integrityRepo, reviewOptions)?.includes("not auditable JavaScript"), "a non-JavaScript wrapper is denied even when tracked because it can launch a mutable child runtime");
    ok(checkCommandDeep(`node ${builtinEscapeRelative}`, integrityRepo, reviewOptions)?.includes("dynamic code or native-process escape"), "process.getBuiltinModule cannot bypass reviewed runtime closure");
    ok(checkCommandDeep(`node ${commentLoaderRelative}`, integrityRepo, reviewOptions)?.includes("ignored or untracked code"), "comment-separated dynamic imports cannot bypass reviewed runtime closure");
    eq(checkCommandDeep(`node ${importingWrapperRelative}`, integrityRepo, reviewOptions), null, "a reviewed importer is allowed while its tracked dependency tree exactly matches HEAD");
    writeFileSync(importedHelperPath, 'throw new Error("hostile imported helper executed");\n');
    ok(
      checkCommandDeep(`node ${importingWrapperRelative}`, integrityRepo, reviewOptions)?.includes("tracked dependency tree"),
      "a modified imported helper denies an unchanged reviewed entry script",
    );
    const importedHelperHookResult = runHook({ tool_name: "Bash", tool_input: { command: `node ${importingWrapperRelative}` } }, integrityRepo);
    ok(importedHelperHookResult.stdout.includes('"permissionDecision":"deny"'), "the Bash hook denies an unchanged entry script with a modified imported helper");
    eq(runIntegrityGit(["restore", "--worktree", "--", importedHelperRelative]).status, 0, "the imported helper fixture is restored byte-for-byte from reviewed HEAD");
    for (const command of [
      "npm --userconfig=output/evil.npmrc run build",
      "NPM_CONFIG_USERCONFIG=output/evil.npmrc npm run build",
      "$env:NPM_CONFIG_USERCONFIG='output/evil.npmrc'; npm run build",
    ]) {
      ok(checkCommandDeep(command, integrityRepo, reviewOptions)?.includes(command.startsWith("npm ") ? "configuration override" : "runtime preload/search-path mutation"), "npm startup configuration injection is denied: " + command);
      const result = runHook({ tool_name: "Bash", tool_input: { command } }, integrityRepo);
      ok(result.stdout.includes('"permissionDecision":"deny"'), "the Bash hook denies npm startup configuration injection: " + command);
    }
    const priorNodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = "--require=output/ignored-wrapper.mjs";
    ok(checkCommandDeep(nativeCommandPath(trackedDirectRelative), integrityRepo, reviewOptions)?.includes("inherited NODE_OPTIONS"), "an indirect tracked wrapper cannot inherit a Node preload");
    if (priorNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = priorNodeOptions;
    const indirectPreloadCommand = `NODE_OPTIONS=--require=output/ignored-wrapper.mjs ${nativeCommandPath(trackedDirectRelative)}`;
    ok(checkCommandDeep(indirectPreloadCommand, integrityRepo, reviewOptions)?.includes("runtime preload/search-path mutation"), "a command-local Node preload cannot hide behind a tracked wrapper");
    const indirectPreloadHookResult = runHook({ tool_name: "Bash", tool_input: { command: indirectPreloadCommand } }, integrityRepo);
    ok(indirectPreloadHookResult.stdout.includes('"permissionDecision":"deny"'), "the Bash hook denies a command-local preload behind an indirect wrapper");
    const alternateHome = path.join(integrityRepo, "output", "alternate-home");
    const alternateHomeMarker = path.join(integrityRepo, "output", "alternate-home-shell-executed.txt");
    mkdirSync(alternateHome, { recursive: true });
    writeFileSync(path.join(alternateHome, ".npmrc"), `script-shell=${path.join(alternateHome, "evil.cmd")}\n`);
    writeFileSync(path.join(alternateHome, "evil.cmd"), `@echo hostile>"${alternateHomeMarker}"\r\n`);
    for (const command of [
      "env HOME=output/alternate-home npm --version",
      "command env USERPROFILE=output/alternate-home npm --version",
      "XDG_CONFIG_HOME=output/alternate-home npm --version",
      "$env:HOME='output/alternate-home'; npm --version",
      "set USERPROFILE=output/alternate-home && npm --version",
    ]) {
      ok(checkCommandDeep(command, integrityRepo, reviewOptions)?.includes("runtime preload/search-path mutation"), "alternate npm home/config relocation is denied: " + command);
      const result = runHook({ tool_name: "Bash", tool_input: { command } }, integrityRepo);
      ok(result.stdout.includes('"permissionDecision":"deny"'), "the Bash hook denies alternate npm home/config relocation: " + command);
    }
    ok(!existsSync(alternateHomeMarker), "the denied alternate-home npm configuration never executes its ignored shell");
    mkdirSync(path.join(integrityRepo, "output"), { recursive: true });
    writeFileSync(path.join(integrityRepo, "output", "sitecustomize.py"), 'raise RuntimeError("sitecustomize executed")\n');
    ok(checkCommandDeep(`PYTHONPATH=output python ${reviewedPythonRelative}`, integrityRepo, reviewOptions)?.includes("runtime preload/search-path mutation"), "PYTHONPATH cannot preload an unreviewed sitecustomize module");
    ok(checkCommandDeep(`python ${reviewedPythonRelative}`, integrityRepo, reviewOptions)?.includes("non-isolated Python startup"), "reviewed Python scripts require isolated startup");
    ok(checkCommandDeep(`python -I -S ${reviewedPythonRelative}`, integrityRepo, reviewOptions)?.includes("not auditable JavaScript"), "an isolated Python script remains denied because its child-runtime closure is not statically auditable");
    const pythonHookResult = runHook({ tool_name: "Bash", tool_input: { command: `PYTHONPATH=output python ${reviewedPythonRelative}` } }, integrityRepo);
    ok(pythonHookResult.stdout.includes('"permissionDecision":"deny"'), "the Bash hook denies Python sitecustomize preloading");
    const ignoredPackageMarker = path.join(integrityRepo, "output", "ignored-package-executed.txt");
    writeFileSync(path.join(integrityRepo, "node_modules", ".bin", "npx.cmd"), `@echo hostile>"${ignoredPackageMarker}"\r\n`);
    ok(checkCommandDeep(`node ${childRunnerRelative}`, integrityRepo, reviewOptions)?.includes("mutable child code"), "a reviewed script cannot spawn an ignored package executable");
    const childRunnerHookResult = runHook({ tool_name: "Bash", tool_input: { command: `node ${childRunnerRelative}` } }, integrityRepo);
    ok(childRunnerHookResult.stdout.includes('"permissionDecision":"deny"'), "the Bash hook denies a reviewed script that can spawn ignored package code");
    ok(!existsSync(ignoredPackageMarker), "the denied reviewed child runner never executes the ignored package shim");
    ok(checkCommandDeep("npm run build", integrityRepo, reviewOptions), "a mutable ignored package shim is denied even when manifests are reviewed");
    eq(checkCommandDeep("npm test", integrityRepo, reviewOptions), null, "an exact-HEAD npm lifecycle alias is allowed only after its package manifest and pre/post scripts are reviewed");
    writeFileSync(path.join(integrityRepo, packageManifest), JSON.stringify({ scripts: { test: "node output/ignored-wrapper.mjs" } }));
    ok(checkCommandDeep("npm test", integrityRepo, reviewOptions)?.includes("exact HEAD"), "a modified npm lifecycle script is denied before execution");
    eq(runIntegrityGit(["restore", "--worktree", "--", packageManifest]).status, 0, "the package manifest fixture is restored byte-for-byte from reviewed HEAD");
    for (const command of [["npm ", "install"].join(""), ["npm ", "i"].join(""), ["npm --cache output ", "i"].join(""), "npm ci", "npm rebuild", "npm restart"]) {
      ok(checkCommandDeep(command, integrityRepo, reviewOptions)?.includes("dependency and lifecycle execution"), "unreviewed npm dependency lifecycle execution is denied: " + command);
      const result = runHook({ tool_name: "Bash", tool_input: { command } }, integrityRepo);
      ok(result.stdout.includes('"permissionDecision":"deny"'), "the Bash hook denies unreviewed npm dependency lifecycle execution: " + command);
    }
    for (const command of [
      "npm config edit --editor output/evil.cmd",
      "npm explore vite -- vite --config=output/evil.ts",
      "npm --editor=output/evil.cmd edit vite",
      "npm --shell=output/evil.cmd explore vite",
      "npm config set editor output/evil.cmd",
      "NPM_CONFIG_EDITOR=output/evil.cmd npm config get cache",
    ]) {
      ok(checkCommandDeep(command, integrityRepo, reviewOptions), "npm arbitrary editor/shell and ignored-package execution is denied: " + command);
      const result = runHook({ tool_name: "Bash", tool_input: { command } }, integrityRepo);
      ok(result.stdout.includes('"permissionDecision":"deny"'), "the Bash hook denies npm arbitrary program dispatch: " + command);
    }
    const trackedWrapperBlob = runIntegrityGit(["rev-parse", `HEAD:${trackedWrapperRelative}`]);
    eq(trackedWrapperBlob.status, 0, "the tracked-wrapper blob resolves for the mode-substitution regression");
    eq(
      runIntegrityGit(["update-index", "--add", "--cacheinfo", `120000,${trackedWrapperBlob.stdout.trim()},${trackedWrapperRelative}`]).status,
      0,
      "the regression stages the reviewed regular-file blob as a symlink",
    );
    ok(checkCommandDeep(`node ${trackedWrapperRelative}`, integrityRepo, reviewOptions)?.includes("index differs from exact HEAD"), "a regular-file-to-symlink index substitution is denied even when the blob ID is unchanged");
    const modeSubstitutionHookResult = runHook({ tool_name: "Bash", tool_input: { command: `node ${trackedWrapperRelative}` } }, integrityRepo);
    ok(modeSubstitutionHookResult.stdout.includes('"permissionDecision":"deny"'), "the Bash hook denies a same-blob symlink substitution");
    eq(runIntegrityGit(["reset", "--", trackedWrapperRelative]).status, 0, "the mode-substitution regression restores the exact HEAD index mode");
    writeFileSync(trackedWrapperPath, wrapperSource);
    eq(runIntegrityGit(["add", "--", trackedWrapperRelative]).status, 0, "replacement-object fixture stages the hostile wrapper");
    const replacementTree = runIntegrityGit(["write-tree"]);
    eq(replacementTree.status, 0, "replacement-object fixture writes its hostile tree");
    const replacementCommit = runIntegrityGit(["commit-tree", replacementTree.stdout.trim(), "-p", "HEAD", "-m", "replacement tree"]);
    eq(replacementCommit.status, 0, "replacement-object fixture writes its replacement commit");
    eq(runIntegrityGit(["reset", "--", trackedWrapperRelative]).status, 0, "replacement-object fixture restores the real index");
    eq(runIntegrityGit(["replace", "HEAD", replacementCommit.stdout.trim()]).status, 0, "replacement-object fixture installs a local replacement ref");
    ok(checkCommandDeep(`node ${trackedWrapperRelative}`, integrityRepo, reviewOptions)?.includes("worktree bytes differ"), "a local replacement tree cannot make hostile wrapper bytes authoritative");
    const replacementBootstrapReason = checkCommandDeep(["node", bootstrapRelative].join(" "), integrityRepo, reviewOptions);
    ok(
      replacementBootstrapReason?.includes("replacement refs are present"),
      `the bootstrap is denied while a local Git replacement ref could substitute reviewed objects (actual: ${replacementBootstrapReason})`,
    );
    eq(runIntegrityGit(["replace", "-d", "HEAD"]).status, 0, "replacement-object fixture removes its local replacement ref");
    writeFileSync(trackedWrapperPath, reviewedWrapperSource);
    const hostileFsmonitor = path.join(integrityRepo, "output", process.platform === "win32" ? "fsmonitor.cmd" : "fsmonitor.sh");
    writeFileSync(hostileFsmonitor, process.platform === "win32" ? "@echo off\r\n@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") chmodSync(hostileFsmonitor, 0o755);
    for (const [key, value, expected] of [
      ["core.fsmonitor", hostileFsmonitor, "core.fsmonitor"],
      ["diff.external", hostileFsmonitor, "diff.external"],
      ["filter.review.process", hostileFsmonitor, "filter clean, smudge, or process"],
      ["core.attributesfile", hostileFsmonitor, "core.attributesfile"],
    ]) {
      eq(runIntegrityGit(["config", key, value]).status, 0, `hostile local ${key} fixture is installed`);
      ok(
        checkCommandDeep(["node", bootstrapRelative].join(" "), integrityRepo, reviewOptions)?.includes(expected),
        `the bootstrap is denied while local Git ${key} could execute unreviewed code`,
      );
      eq(runIntegrityGit(["config", "--unset-all", key]).status, 0, `hostile local ${key} fixture is removed`);
    }
    const infoAttributesResult = runIntegrityGit(["rev-parse", "--git-path", "info/attributes"]);
    eq(infoAttributesResult.status, 0, "Git info attributes path resolves");
    const infoAttributesPath = path.resolve(integrityRepo, infoAttributesResult.stdout.trim());
    mkdirSync(path.dirname(infoAttributesPath), { recursive: true });
    writeFileSync(infoAttributesPath, "* filter=review\n");
    ok(checkCommandDeep(["node", bootstrapRelative].join(" "), integrityRepo, reviewOptions)?.includes("info/attributes"), "the bootstrap denies unreviewed repository-local attribute overrides");
    rmSync(infoAttributesPath, { force: true });
    const hostileGlobalHome = path.join(integrityRepo, "output", "hostile-git-home");
    mkdirSync(hostileGlobalHome, { recursive: true });
    const hostileGlobalAttributes = path.join(hostileGlobalHome, "attributes");
    const hostileGlobalFilterMarker = path.join(hostileGlobalHome, "global-filter-ran.txt");
    const hostileGlobalFilter = path.join(hostileGlobalHome, process.platform === "win32" ? "filter.cmd" : "filter.sh");
    writeFileSync(hostileGlobalAttributes, "* filter=review\n");
    writeFileSync(hostileGlobalFilter, process.platform === "win32"
      ? `@echo hostile>"${hostileGlobalFilterMarker}"\r\n@exit /b 1\r\n`
      : `#!/bin/sh\nprintf hostile > '${hostileGlobalFilterMarker.replaceAll("'", "'\\''")}'\nexit 1\n`);
    if (process.platform !== "win32") chmodSync(hostileGlobalFilter, 0o755);
    writeFileSync(path.join(hostileGlobalHome, ".gitconfig"), [
      "[core]",
      `\tattributesfile = ${hostileGlobalAttributes.replaceAll("\\", "/")}`,
      '[filter "review"]',
      `\tprocess = ${hostileGlobalFilter.replaceAll("\\", "/")}`,
      "",
    ].join("\n"));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = hostileGlobalHome;
    process.env.USERPROFILE = hostileGlobalHome;
    eq(checkCommandDeep(["node", bootstrapRelative].join(" "), integrityRepo, reviewOptions), null, "global attributes and filter configuration is inert because trusted bootstrap Git disables global/system config");
    ok(!existsSync(hostileGlobalFilterMarker), "the hostile global Git process filter never executes during bootstrap inspection");
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    const originalGitConfigCount = process.env.GIT_CONFIG_COUNT;
    process.env.GIT_CONFIG_COUNT = "1";
    ok(
      checkCommandDeep(["node", bootstrapRelative].join(" "), integrityRepo, reviewOptions)?.includes("GIT_CONFIG_COUNT"),
      "the bootstrap is denied when inherited Git configuration injection is present",
    );
    if (originalGitConfigCount === undefined) delete process.env.GIT_CONFIG_COUNT;
    else process.env.GIT_CONFIG_COUNT = originalGitConfigCount;
    const gitEnvItemWriter = String.fromCharCode(83, 101, 116, 45, 73, 116, 101, 109);
    const gitEnvApiWriter = String.fromCharCode(83, 101, 116, 69, 110, 118, 105, 114, 111, 110, 109, 101, 110, 116, 86, 97, 114, 105, 97, 98, 108, 101);
    for (const command of [
      `GIT_CONFIG_COUNT=1 node ${bootstrapRelative}`,
      `$env:GIT_CONFIG_COUNT = 1; node ${bootstrapRelative}`,
      `set GIT_CONFIG_COUNT=1 && node ${bootstrapRelative}`,
      `${gitEnvItemWriter} Env:GIT_CONFIG_COUNT 1; node ${bootstrapRelative}`,
      `[Environment]::${gitEnvApiWriter}('GIT_CONFIG_COUNT', '1'); node ${bootstrapRelative}`,
    ]) {
      ok(checkCommandDeep(command, integrityRepo, reviewOptions)?.includes("Git control environment mutation"), `command-local Git configuration injection is denied: ${command}`);
      const result = runHook({ tool_name: "Bash", tool_input: { command } }, integrityRepo);
      ok(result.stdout.includes('"permissionDecision":"deny"'), `the Bash hook denies command-local Git configuration injection: ${command}`);
    }
    for (const replacementMutationCommand of [
      "git replace HEAD replacement",
      "git update-ref refs/replace/deadbeef replacement",
      "printf 'update refs/replace/deadbeef replacement\\n' | git update-ref --stdin",
    ]) {
      ok(checkCommandDeep(replacementMutationCommand, integrityRepo, reviewOptions)?.includes("replacement-object mutation"), "Git replacement-object mutation is denied: " + replacementMutationCommand);
      const replacementHookResult = runHook({ tool_name: "Bash", tool_input: { command: replacementMutationCommand } }, integrityRepo);
      ok(replacementHookResult.stdout.includes('"permissionDecision":"deny"'), "the Bash hook denies Git replacement-object mutation: " + replacementMutationCommand);
    }
    const shadowBootstrapPath = path.join(integrityRepo, "output", ...bootstrapRelative.split("/"));
    mkdirSync(path.dirname(shadowBootstrapPath), { recursive: true });
    writeFileSync(shadowBootstrapPath, "console.log('ignored shadow');\n");
    for (const shiftedCommand of [
      "cd output && node " + bootstrapRelative,
      "Set-Location output; node " + bootstrapRelative,
      "Push-Location output; node " + bootstrapRelative,
      "env --chdir=output node " + bootstrapRelative,
      "sudo --chdir=output node " + bootstrapRelative,
      "wsl --cd output node " + bootstrapRelative,
      "pwsh -WorkingDirectory output -File " + bootstrapRelative,
      "Start-Process node -WorkingDirectory output -ArgumentList " + bootstrapRelative,
      ["fi", "nd"].join("") + " output " + ["-ex", "ecdir"].join("") + " node " + bootstrapRelative + " {} ;",
      "parallel --workdir output node " + bootstrapRelative + " ::: one",
      "npm --prefix output run build",
      "bash -c " + JSON.stringify("cd output && node " + bootstrapRelative),
    ]) {
      ok(checkCommandDeep(shiftedCommand, integrityRepo, reviewOptions)?.includes("working-directory change"), "a working-directory shift cannot redirect a reviewed executor to an ignored shadow: " + shiftedCommand);
      const shiftedHookResult = runHook({ tool_name: "Bash", tool_input: { command: shiftedCommand } }, integrityRepo);
      eq(shiftedHookResult.status, 0, "the Bash hook exits 0 after denying a shifted executor: " + shiftedCommand);
      ok(shiftedHookResult.stdout.includes('"permissionDecision":"deny"'), "the Bash hook denies a shifted executor: " + shiftedCommand);
    }
    eq(checkCommandDeep("cd output && git status --short", integrityRepo, reviewOptions), null, "a directory change followed only by a Git read remains allowed");
    const inlineGitAliasCommand = "git -c 'alias.run=!node output/ignored-wrapper.mjs' run";
    ok(checkCommandDeep(inlineGitAliasCommand, integrityRepo, reviewOptions)?.includes("executable Git configuration"), "an inline Git shell alias cannot launch an ignored wrapper");
    ok(checkCommandDeep("git -c 'alias.run = !node output/ignored-wrapper.mjs' run", integrityRepo, reviewOptions)?.includes("executable Git configuration"), "whitespace before an inline Git alias value cannot evade the guard");
    const inlineGitAliasHookResult = runHook({ tool_name: "Bash", tool_input: { command: inlineGitAliasCommand } }, integrityRepo);
    eq(inlineGitAliasHookResult.status, 0, "the Bash hook exits 0 after denying an inline Git shell alias");
    ok(inlineGitAliasHookResult.stdout.includes('"permissionDecision":"deny"'), "the Bash hook denies an inline Git shell alias");
    ok(checkCommandDeep("git config alias.run '!node output/ignored-wrapper.mjs'", integrityRepo, reviewOptions)?.includes("persisted executable Git configuration"), "persisted Git shell aliases are denied");
    for (const command of [
      ["git -c diff.", "external=node output/ignored-wrapper.mjs diff HEAD HEAD"].join(""),
      ["git -cdiff.", "external=node diff HEAD HEAD"].join(""),
      ["git config diff.", "external 'node output/ignored-wrapper.mjs'"].join(""),
    ]) {
      ok(checkCommandDeep(command, integrityRepo, reviewOptions)?.includes("executable Git configuration"), "Git executable configuration dispatch is denied: " + command);
      const result = runHook({ tool_name: "Bash", tool_input: { command } }, integrityRepo);
      ok(result.stdout.includes('"permissionDecision":"deny"'), "the Bash hook denies Git executable configuration dispatch: " + command);
    }
    ok(checkCommandDeep("git run", integrityRepo, reviewOptions)?.includes("alias or external helper"), "unknown Git aliases and executable helpers fail closed");
    eq(checkCommandDeep("git status --short", integrityRepo, reviewOptions), null, "an ordinary built-in Git read remains allowed");
    const opaquePackageRunner = ["n", "px vite"].join("");
    ok(checkCommandDeep(opaquePackageRunner, integrityRepo, reviewOptions)?.includes("opaque package execution"), "an opaque package resolver is denied even on authoritative main");
    const untrackedConfig = "vite.config.mjs";
    writeFileSync(path.join(integrityRepo, untrackedConfig), "export default {};\n");
    ok(checkCommandDeep("npm run build", integrityRepo, reviewOptions), "an untracked auto-loaded package config denies a reviewed package script");
    ok(checkCommandDeep(["vite --con", "fig ", untrackedConfig].join(""), integrityRepo, reviewOptions), "an explicit untracked package config is denied");
    ok(checkCommandDeep(["vite -", "c ", untrackedConfig].join(""), integrityRepo, reviewOptions), "a short-form untracked package config is denied");
    rmSync(path.join(integrityRepo, untrackedConfig), { force: true });
    writeFileSync(trackedWrapperPath, `${wrapperSource}// worktree divergence\n`);
    writeFileSync(trackedDirectPath, "@echo worktree-divergent direct wrapper\n");
    ok(checkCommandDeep(`node ${trackedWrapperRelative}`, integrityRepo, reviewOptions), "a worktree-divergent file-backed executor is denied");
    ok(checkCommandDeep(`node -- ${trackedWrapperRelative}`, integrityRepo, reviewOptions), "a worktree-divergent file-backed executor after -- is denied");
    ok(checkCommandDeep(nativeCommandPath(trackedDirectRelative), integrityRepo, reviewOptions)?.includes("worktree bytes differ"), "a directly executed modified script is denied");
    const divergentDirectHookResult = runHook({ tool_name: "Bash", tool_input: { command: nativeCommandPath(trackedDirectRelative) } }, integrityRepo);
    ok(divergentDirectHookResult.stdout.includes("Blocked file-backed interpreter"), "the Bash hook denies a directly executed modified script");
    const divergentHookResult = runHook({ tool_name: "Bash", tool_input: { command: `node -- ${trackedWrapperRelative}` } }, integrityRepo);
    ok(divergentHookResult.stdout.includes("Blocked file-backed interpreter"), "the Bash hook origin/main-binds a worktree-divergent executor after --");
    for (const args of [
      ["add", "--", trackedWrapperRelative, trackedDirectRelative],
      ["commit", "--quiet", "-m", "unreviewed malicious wrapper"],
      localRefMoveArgs,
    ]) {
      const result = spawnSync("git", args, { cwd: integrityRepo, encoding: "utf8", windowsHide: true, env: integrityGitEnv });
      eq(result.status, 0, `local-only malicious wrapper commit succeeds for the regression: git ${args[0]}`);
    }
    ok(checkCommandDeep(`node -- ${trackedWrapperRelative}`, integrityRepo, reviewOptions)?.includes("fresh exact-SHA independent review proof"), "a local commit plus a moved local tracking ref cannot forge authoritative provenance");
    ok(checkCommandDeep(nativeCommandPath(trackedDirectRelative), integrityRepo, reviewOptions)?.includes("fresh exact-SHA independent review proof"), "a directly executed script from an unreviewed local HEAD is denied");
    const localCommitHookResult = runHook({ tool_name: "Bash", tool_input: { command: `node -- ${trackedWrapperRelative}` } }, integrityRepo);
    ok(localCommitHookResult.stdout.includes("Blocked file-backed interpreter"), "the production Bash hook refuses a test environment local main substitution");
    const featureBranchGitShim = writeGitShim(integrityRepo, localGitShimMarker);
    ok(
      checkCommandDeep(["node", bootstrapRelative].join(" "), integrityRepo, reviewOptions)?.includes("bare Git does not resolve"),
      "the feature-branch bootstrap is denied while bare Git could resolve to a repository-local shim",
    );
    rmSync(featureBranchGitShim, { force: true });
    eq(checkCommandDeep(["node", bootstrapRelative].join(" "), integrityRepo, reviewOptions), null, "the reviewed byte-identical proof producer remains available to bootstrap feature-branch review");
    for (const command of [
      ["node --test --test-reporter=output/ignored-wrapper.mjs", bootstrapRelative].join(" "),
      ["node --env-file=output/ignored.env", bootstrapRelative].join(" "),
      ["node --snapshot-blob=output/ignored.blob", bootstrapRelative].join(" "),
      ["node --build-snapshot-config=output/ignored.json", bootstrapRelative].join(" "),
    ]) {
      const reason = checkCommandDeep(command, integrityRepo, reviewOptions);
      ok(reason, "the review bootstrap denies every option-bearing Node startup route: " + command);
      const result = runHook({ tool_name: "Bash", tool_input: { command } }, integrityRepo);
      ok(result.stdout.includes('"permissionDecision":"deny"'), "the Bash hook denies an option-bearing review bootstrap: " + command);
    }
    for (const command of [
      `node --test --test-reporter=output/ignored-wrapper.mjs ${trackedWrapperRelative}`,
      `node --env-file=output/ignored.env ${trackedWrapperRelative}`,
      `node --snapshot-blob=output/ignored.blob ${trackedWrapperRelative}`,
      `node --experimental-sea-config=output/ignored.json ${trackedWrapperRelative}`,
      `node --conditions=ignored ${trackedWrapperRelative}`,
      `node --future-code-loader=output/ignored-wrapper.mjs ${trackedWrapperRelative}`,
    ]) {
      ok(checkCommandDeep(command, integrityRepo, reviewOptions), "ordinary Node entrypoints fail closed on code-loading or unknown startup options: " + command);
      const result = runHook({ tool_name: "Bash", tool_input: { command } }, integrityRepo);
      ok(result.stdout.includes('"permissionDecision":"deny"'), "the Bash hook denies a code-loading or unknown Node startup option: " + command);
    }
    writeFileSync(trackedWrapperPath, reviewedWrapperSource);
    writeFileSync(ignoredWrapperPath, wrapperSource);
    const ignoredDirectRelative = "output/ignored-wrapper.bat";
    writeFileSync(path.join(integrityRepo, ...ignoredDirectRelative.split("/")), "@echo ignored direct wrapper\n");
    const ignoredPowerShellRelative = "output/ignored-wrapper.ps1";
    writeFileSync(path.join(integrityRepo, ...ignoredPowerShellRelative.split("/")), "Write-Output ignored\n");
    const ignoredShebangRelative = "output/ignored-shebang";
    writeFileSync(path.join(integrityRepo, ...ignoredShebangRelative.split("/")), "#!/bin/sh\necho ignored\n");
    writeFileSync(path.join(integrityRepo, "output", "ignored.psm1"), "Write-Output ignored\n");
    writeFileSync(path.join(integrityRepo, "output", "ignored.mk"), "all:\n\t@echo ignored\n");
    writeFileSync(path.join(integrityRepo, "output", "ignored.jar"), "ignored\n");
    writeFileSync(path.join(integrityRepo, "evil.cmd"), "@echo bare ignored wrapper\n");
    ok(checkCommandDeep(`node ${ignoredWrapperRelative}`, integrityRepo, reviewOptions), "an ignored file-backed executor that spawns the producer is denied");
    ok(checkCommandDeep(`node -- ${ignoredWrapperRelative}`, integrityRepo, reviewOptions), "an ignored file-backed executor after -- is denied");
    ok(checkCommandDeep(ignoredDirectRelative.replaceAll("/", "\\"), integrityRepo, reviewOptions)?.includes("ignored or untracked"), "a directly executed ignored script is denied");
    ok(checkCommandDeep(`cmd /c ${ignoredDirectRelative.replaceAll("/", "\\")}`, integrityRepo, reviewOptions)?.includes("ignored or untracked"), "cmd dispatch cannot hide a directly executed ignored script");
    for (const cmdBuiltinCommand of [
      `cmd /c call ${ignoredDirectRelative.replaceAll("/", "\\")}`,
      `cmd /c @call ${ignoredDirectRelative.replaceAll("/", "\\")}`,
      `cmd /c if exist ${ignoredDirectRelative.replaceAll("/", "\\")} ${ignoredDirectRelative.replaceAll("/", "\\")}`,
      `cmd /c if 1==1 call ${ignoredDirectRelative.replaceAll("/", "\\")}`,
      `cmd /c for %A in (1) do ${ignoredDirectRelative.replaceAll("/", "\\")}`,
    ]) {
      const cmdBuiltinReason = checkCommandDeep(cmdBuiltinCommand, integrityRepo, reviewOptions);
      ok(cmdBuiltinReason?.includes("ignored or untracked"), "CMD builtin traversal cannot hide an ignored executable: " + cmdBuiltinCommand + " reason=" + cmdBuiltinReason);
      const cmdBuiltinHookResult = runHook({ tool_name: "Bash", tool_input: { command: cmdBuiltinCommand } }, integrityRepo);
      ok(cmdBuiltinHookResult.stdout.includes('"permissionDecision":"deny"'), "the Bash hook denies a CMD builtin wrapper: " + cmdBuiltinCommand);
    }
    ok(checkCommandDeep("cmd /c evil", integrityRepo, reviewOptions)?.includes("ignored or untracked"), "cmd current-directory PATHEXT resolution cannot hide a bare ignored wrapper");
    const bareCmdHookResult = runHook({ tool_name: "Bash", tool_input: { command: "cmd /c evil" } }, integrityRepo);
    ok(bareCmdHookResult.stdout.includes("Blocked file-backed interpreter"), "the Bash hook denies a bare current-directory CMD wrapper");
    writeFileSync(path.join(integrityRepo, "output", "evil.cmd"), "@echo PATH-resolved ignored wrapper\n");
    for (const pathMutationCommand of [
      'cmd /c "set PATH=output&&evil"',
      "cmd /c set PATH=output&&evil",
      "PATH=output evil",
      "env PATH=output evil",
      "$env:PATH='output'; evil",
    ]) {
      ok(checkCommandDeep(pathMutationCommand, integrityRepo, reviewOptions)?.includes("PATH or PATHEXT mutation"), "a command-local PATH change cannot hide an ignored bare executable: " + pathMutationCommand);
      const pathMutationHookResult = runHook({ tool_name: "Bash", tool_input: { command: pathMutationCommand } }, integrityRepo);
      ok(pathMutationHookResult.stdout.includes('"permissionDecision":"deny"'), "the Bash hook denies command-local PATH executable dispatch: " + pathMutationCommand);
    }
    ok(checkCommandDeep(`& .\\${ignoredPowerShellRelative.replaceAll("/", "\\")}`, integrityRepo, reviewOptions)?.includes("ignored or untracked"), "the PowerShell invocation operator cannot hide a directly executed ignored script");
    const powerShellAliasCommand = `Set-Alias x .\\${ignoredPowerShellRelative.replaceAll("/", "\\")}; x`;
    ok(checkCommandDeep(powerShellAliasCommand, integrityRepo, reviewOptions)?.includes("ignored or untracked"), "a static PowerShell alias cannot hide a directly executed ignored script");
    const powerShellAliasHookResult = runHook({ tool_name: "Bash", tool_input: { command: powerShellAliasCommand } }, integrityRepo);
    ok(powerShellAliasHookResult.stdout.includes("Blocked file-backed interpreter"), "the Bash hook denies a static PowerShell alias to an ignored script");
    ok(checkCommandDeep(`./${ignoredShebangRelative}`, integrityRepo, reviewOptions)?.includes("ignored or untracked"), "a directly executed ignored shebang path is denied");
    ok(checkCommandDeep(`bash -c ${JSON.stringify(`./${ignoredShebangRelative}`)}`, integrityRepo, reviewOptions), "nested shell dispatch cannot hide a directly executed ignored shebang path");
    for (const implicitLoaderCommand of [
      "Import-Module output/ignored.psm1",
      "make -f output/ignored.mk",
      "java -jar output/ignored.jar",
    ]) {
      ok(checkCommandDeep(implicitLoaderCommand, integrityRepo, reviewOptions), "an implicit code loader fails closed: " + implicitLoaderCommand);
      const loaderHookResult = runHook({ tool_name: "Bash", tool_input: { command: implicitLoaderCommand } }, integrityRepo);
      ok(loaderHookResult.stdout.includes('"permissionDecision":"deny"'), "the Bash hook denies an implicit code loader: " + implicitLoaderCommand);
    }
    const ignoredDirectHookResult = runHook({ tool_name: "Bash", tool_input: { command: ignoredDirectRelative.replaceAll("/", "\\") } }, integrityRepo);
    ok(ignoredDirectHookResult.stdout.includes("Blocked file-backed interpreter"), "the Bash hook denies a directly executed ignored script");
    const ignoredHookResult = runHook({ tool_name: "Bash", tool_input: { command: `node -- ${ignoredWrapperRelative}` } }, integrityRepo);
    ok(ignoredHookResult.stdout.includes('"permissionDecision":"deny"'), "the Bash hook denies an ignored wrapper before it can spawn the producer");
    ok(ignoredHookResult.stdout.includes("Blocked file-backed interpreter"), "the Bash hook denial comes from the HEAD-bound executor check");
    ok(!existsSync(ignoredMarkerPath), "the denied ignored wrapper never executes");
    const externalExecutorPath = path.join(externalExecutorDir, "external-wrapper.mjs");
    writeFileSync(externalExecutorPath, wrapperSource);
    ok(checkCommandDeep(`node ${JSON.stringify(externalExecutorPath)}`, integrityRepo, reviewOptions), "an external file-backed executor is denied");
    ok(checkCommandDeep(`node -- ${JSON.stringify(externalExecutorPath)}`, integrityRepo, reviewOptions), "an external file-backed executor after -- is denied");
    const externalHookResult = runHook({ tool_name: "Bash", tool_input: { command: `node -- ${JSON.stringify(externalExecutorPath)}` } }, integrityRepo);
    ok(externalHookResult.stdout.includes("Blocked file-backed interpreter"), "the Bash hook denies an external executor after --");
    writeFileSync(integrityPath, "export const reviewed = false;\n");
    ok(checkCommandDeep(integrityCommand, integrityRepo, reviewOptions), "an exact producer launch is denied when worktree bytes differ from exact HEAD");
  } finally {
    rmSync(integrityRepo, { recursive: true, force: true });
    rmSync(externalExecutorDir, { recursive: true, force: true });
  }
}
const focusedProducerHarness = "node scripts/apply-live-testdata-maintenance-20260812.test.mjs";
ok(!maintenanceProducerCommandMentioned(focusedProducerHarness), "focused producer test harness is not classified as the protected producer");
eq(checkMaintenanceProducerInvocation(focusedProducerHarness), null, "focused producer test harness stays allowed by the shell guard");
ok(!checkDangerousCommand(focusedProducerHarness), "focused producer test harness stays runnable");
const nodeMentionAsData = "Select-String -Pattern 'node' | ForEach-Object { $_ }";
ok(!maintenanceProducerCommandMentioned(nodeMentionAsData), "Node mentioned as text is not classified as an invocation");
eq(checkMaintenanceProducerInvocation(nodeMentionAsData), null, "Node text search stays outside the producer gate");
ok(!checkDangerousCommand(nodeMentionAsData), "ordinary PowerShell Node text search stays allowed");
ok(!checkDangerousCommand("rg -n 'Start-Process awk -ArgumentList payload' docs"), "PowerShell process-launch spelling used as quoted search data stays allowed");
ok(!checkDangerousCommand("echo $PATH"), "ordinary environment-variable display stays allowed");
ok(!checkDangerousCommand("Get-ChildItem *.mjs"), "ordinary non-Node file glob stays allowed");
const wrappedNodeMentionAsData = 'Write-Output \'command node "$F"\'';
ok(!maintenanceProducerCommandMentioned(wrappedNodeMentionAsData), "wrapped Node spelling used as quoted data is not classified as an invocation");
eq(checkMaintenanceProducerInvocation(wrappedNodeMentionAsData), null, "wrapped Node quoted data stays outside the producer gate");
ok(!checkDangerousCommand(wrappedNodeMentionAsData), "ordinary wrapped Node quoted data stays allowed");
const envSplitStringAsData = "env MODE=-S powershell -Command 'Write-Output $env:MODE'";
ok(!maintenanceProducerCommandMentioned(envSplitStringAsData), "env assignment value named -S is not parsed as a split-string option");
eq(checkMaintenanceProducerInvocation(envSplitStringAsData), null, "env assignment value stays outside the producer gate");
ok(!checkDangerousCommand(envSplitStringAsData), "ordinary env assignment value stays allowed");
const envPostCommandSplitStringData = "env -- powershell -Command 'Write-Output -S $env:MODE'";
ok(!maintenanceProducerCommandMentioned(envPostCommandSplitStringData), "env scanner stops before child-command -S data");
eq(checkMaintenanceProducerInvocation(envPostCommandSplitStringData), null, "child-command -S data stays outside the producer gate");
ok(!checkDangerousCommand(envPostCommandSplitStringData), "ordinary child-command -S data stays allowed");
const powershellOptionData = "pwsh -ExecutionPolicy Bypass 'Write-Output node $value'";
ok(!maintenanceProducerCommandMentioned(powershellOptionData), "PowerShell non-command options do not reinterpret later quoted data");
eq(checkMaintenanceProducerInvocation(powershellOptionData), null, "PowerShell option data stays outside the producer gate");
ok(!checkDangerousCommand(powershellOptionData), "ordinary PowerShell option data stays allowed");
const encodedPowerShellAsData = "rg -n 'pwsh /EncodedCommand' docs";
ok(!maintenanceProducerCommandMentioned(encodedPowerShellAsData), "PowerShell encoded-command spelling used as quoted search data is not classified as an invocation");
eq(checkMaintenanceProducerInvocation(encodedPowerShellAsData), null, "encoded-command quoted data stays outside the producer gate");
ok(!checkDangerousCommand(encodedPowerShellAsData), "ordinary encoded-command text search stays allowed");
const encodedPowerShellAsPlainData = "Write-Output pwsh /EncodedCommand";
ok(!maintenanceProducerCommandMentioned(encodedPowerShellAsPlainData), "PowerShell encoded-command spelling after a non-wrapper command is not classified as an invocation");
eq(checkMaintenanceProducerInvocation(encodedPowerShellAsPlainData), null, "encoded-command plain data stays outside the producer gate");
ok(!checkDangerousCommand(encodedPowerShellAsPlainData), "ordinary encoded-command plain output stays allowed");
const encodedPowerShellAsScriptArgument = "pwsh -File script.ps1 /EncodedCommand";
ok(maintenanceProducerCommandMentioned(encodedPowerShellAsScriptArgument), "PowerShell script-file launch is classified as opaque");
ok(checkMaintenanceProducerInvocation(encodedPowerShellAsScriptArgument), "PowerShell script-file launch enters the producer gate");
ok(checkDangerousCommand(encodedPowerShellAsScriptArgument), "PowerShell script-file launch is denied while the producer exists");
for (const lookupCommand of ["command -v pwsh /EncodedCommand", "command -V pwsh /EncodedCommand"]) {
  ok(!maintenanceProducerCommandMentioned(lookupCommand), `PowerShell name lookup is not classified as an invocation: ${lookupCommand}`);
  eq(checkMaintenanceProducerInvocation(lookupCommand), null, `PowerShell lookup stays outside the producer gate: ${lookupCommand}`);
  ok(!checkDangerousCommand(lookupCommand), `ordinary PowerShell lookup stays allowed: ${lookupCommand}`);
}
const nestedShellAsData = "Write-Output bash -c 'pwsh /EncodedCommand text'";
ok(!maintenanceProducerCommandMentioned(nestedShellAsData), "nested shell spelling after a non-wrapper command is not classified as an invocation");
eq(checkMaintenanceProducerInvocation(nestedShellAsData), null, "nested shell data stays outside the producer gate");
ok(!checkDangerousCommand(nestedShellAsData), "ordinary nested shell text output stays allowed");
const inlineInterpreterAsData = "rg -n 'python -c' docs";
ok(!maintenanceProducerCommandMentioned(inlineInterpreterAsData), "inline interpreter spelling used as quoted search data is not classified as an invocation");
eq(checkMaintenanceProducerInvocation(inlineInterpreterAsData), null, "inline interpreter search data stays outside the producer gate");
ok(!checkDangerousCommand(inlineInterpreterAsData), "ordinary inline interpreter text search stays allowed");
const awkProgramAsData = "rg -n \"awk 'BEGIN'\" docs";
ok(!maintenanceProducerCommandMentioned(awkProgramAsData), "AWK program spelling used as quoted search data is not classified as an invocation");
eq(checkMaintenanceProducerInvocation(awkProgramAsData), null, "AWK program search data stays outside the producer gate");
ok(!checkDangerousCommand(awkProgramAsData), "ordinary AWK program text search stays allowed");
ok(!maintenanceProducerCommandMentioned("awk --help"), "AWK help mode stays outside the producer gate");
const findCommand = ["fi", "nd"].join("");
const findExecOption = ["-ex", "ec"].join("");
const findGroupOpen = "\x5c(";
const findGroupClose = "\x5c)";
const findTerminator = "\x5c;";
const pythonCommand = ["py", "thon"].join("");
const deepPowerShellBoundaryTail = `; ${pythonCommand} -c \"print('opaque')\"`;
const deepPowerShellBoundaryCommand = `Write-Output marker${"\\".repeat(SECURITY_COMMAND_CHAR_BUDGET - deepPowerShellBoundaryTail.length - 200)}${deepPowerShellBoundaryTail}`;
const xargsCommand = ["xar", "gs"].join("");
const noRunIfEmptyOption = ["--no-run", "-if-empty"].join("");
const awkCommand = ["aw", "k"].join("");
const opaqueAwkProgram = `'BEGIN { cmd = decode(); ${["sys", "tem"].join("")}(cmd) }'`;
const timeCommand = ["ti", "me"].join("");
const shellGrammarGuardCases = [
  [timeCommand, awkCommand, opaqueAwkProgram].join(" "),
  ["SAFE+=1", awkCommand, opaqueAwkProgram].join(" "),
  ["env", "SAFE+=1", awkCommand, opaqueAwkProgram].join(" "),
  ["coproc", "worker", "env", "NODE_OPTIONS=--require=./preload.cjs", "node", "scripts/ordinary-check.mjs"].join(" "),
  ["if", "true", ";", "then", awkCommand, opaqueAwkProgram, ";", "fi"].join(" "),
  ["if", "true", ";", "then", "env", "NODE_OPTIONS=--require=./preload.cjs", "node", "scripts/ordinary-check.mjs", ";", "fi"].join(" "),
];
const xargsGuardCases = [
  [xargsCommand, noRunIfEmptyOption, "-a", ["package", ".json"].join(""), awkCommand, opaqueAwkProgram].join(" "),
  [xargsCommand, noRunIfEmptyOption, "-a", ["package", ".json"].join(""), "env", "NODE_OPTIONS=--require=./preload.cjs", "node", "scripts/ordinary-check.mjs"].join(" "),
  [xargsCommand, "--replace", "-a", ["package", ".json"].join(""), awkCommand, opaqueAwkProgram].join(" "),
  [xargsCommand, "--eof", "-a", ["package", ".json"].join(""), awkCommand, opaqueAwkProgram].join(" "),
  [xargsCommand, "--max-lines", "-a", ["package", ".json"].join(""), awkCommand, opaqueAwkProgram].join(" "),
  [xargsCommand, "-E", "''", "-a", ["package", ".json"].join(""), awkCommand, opaqueAwkProgram].join(" "),
  [xargsCommand, "-E", "''", "-a", ["package", ".json"].join(""), "env", "NODE_OPTIONS=--require=./preload.cjs", "node", "scripts/ordinary-check.mjs"].join(" "),
];
const shellBuiltinNodeOptionsCases = [
  ["NODE_OPTIONS+=--require=./preload.cjs", "node", "scripts/ordinary-check.mjs"].join(" "),
  ["export", "NODE_OPTIONS+=--require=./preload.cjs", ";", "node", "scripts/ordinary-check.mjs"].join(" "),
  [["decl", "are"].join(""), "-x", "NODE_OPTIONS+=--require=./preload.cjs", ";", "node", "scripts/ordinary-check.mjs"].join(" "),
  [["type", "set"].join(""), "-gx", "NODE_OPTIONS+=--require=./preload.cjs", ";", "node", "scripts/ordinary-check.mjs"].join(" "),
  [["lo", "cal"].join(""), "-x", "NODE_OPTIONS+=--require=./preload.cjs", ";", "node", "scripts/ordinary-check.mjs"].join(" "),
  [["read", "only"].join(""), "NODE_OPTIONS+=--require=./preload.cjs", ";", "node", "scripts/ordinary-check.mjs"].join(" "),
  [["decl", "are"].join(""), "-x", "NODE_OPTIONS=--require=./preload.cjs", ";", "node", "scripts/ordinary-check.mjs"].join(" "),
  [["type", "set"].join(""), "-gx", "NODE_OPTIONS=--require=./preload.cjs", ";", "node", "scripts/ordinary-check.mjs"].join(" "),
  [["built", "in"].join(""), "export", "NODE_OPTIONS=--require=./preload.cjs", ";", "node", "scripts/ordinary-check.mjs"].join(" "),
  [["built", "in"].join(""), "--", ["decl", "are"].join(""), "-gx", "NODE_OPTIONS=--require=./preload.cjs", ";", "node", "scripts/ordinary-check.mjs"].join(" "),
  [["lo", "cal"].join(""), "-x", "NODE_OPTIONS=--require=./preload.cjs", ";", "node", "scripts/ordinary-check.mjs"].join(" "),
  [["read", "only"].join(""), "NODE_OPTIONS=--require=./preload.cjs", ";", "node", "scripts/ordinary-check.mjs"].join(" "),
  [["decl", "are"].join(""), "NODE_OPTIONS=--require=./preload.cjs", ";", "export", "NODE_OPTIONS", ";", "node", "scripts/ordinary-check.mjs"].join(" "),
  ["printf", "-v", "NODE_OPTIONS", "%s", "--require=./preload.cjs", ";", "node", "scripts/ordinary-check.mjs"].join(" "),
  ["set", "-a", ";", "printf", "-v", "NODE_OPTIONS", "%s", "--require=./preload.cjs", ";", "node", "scripts/ordinary-check.mjs"].join(" "),
  ["set", "-o", "allexport", ";", "read", "NODE_OPTIONS", "<", "preload.txt", ";", "npm", "--version"].join(" "),
  ["printf", "-v", '"${TARGET}_OPTIONS"', "%s", "--require=./preload.cjs", ";", "node", "scripts/ordinary-check.mjs"].join(" "),
  ["read", '"$TARGET"', "<", "preload.txt", ";", "node", "scripts/ordinary-check.mjs"].join(" "),
  ["set", "-a", ";", "SAFE=1", ";", "node", "scripts/ordinary-check.mjs"].join(" "),
  `pwsh -NoProfile -Command "$env:NODE_OPTIONS='--require=./preload.cjs'; npm --version"`,
  `pwsh -NoProfile -Command "$env:NODE_OPTIONS = '--require=./preload.cjs'; npm --version"`,
  `powershell -NoProfile -Command "Set-Item Env:NODE_OPTIONS '--require=./preload.cjs'; npm --version"`,
  `powershell -NoProfile -Command "Set-Content -Path Env:\\NODE_OPTIONS -Value '--require=./preload.cjs'; npm --version"`,
  `powershell -NoProfile -Command "si Env:NODE_OPTIONS '--require=./preload.cjs'; node scripts/ordinary-check.mjs"`,
  `powershell -NoProfile -Command "sc -Path Env:\\NODE_OPTIONS -Value '--require=./preload.cjs'; npm --version"`,
  `powershell -NoProfile -Command "ni Env:NODE_OPTIONS -Value '--require=./preload.cjs'; npm --version"`,
  `powershell -NoProfile -Command "ac Env:NODE_OPTIONS '--require=./preload.cjs'; npm --version"`,
  `powershell -NoProfile -Command "Set-Alias mutate Set-Item; mutate Env:NODE_OPTIONS '--require=./preload.cjs'; node scripts/ordinary-check.mjs"`,
  `powershell -NoProfile -Command "sal mutate si; mutate Env:NODE_OPTIONS '--require=./preload.cjs'; npm --version"`,
  `pwsh -NoProfile -Command "[Environment]::SetEnvironmentVariable('NODE_OPTIONS','--require=./preload.cjs'); npm --version"`,
  `si Env:NODE_OPTIONS '--require=./preload.cjs'`,
  `sc -Path Env:\\NODE_OPTIONS -Value '--require=./preload.cjs'`,
  `$env:NODE_OPTIONS='--require=./preload.cjs'`,
  `si ('Env:NO' + 'DE_OPTIONS') '--require=./preload.cjs'`,
  `Set-Alias mutate Set-Item`,
  `Set-Alias -Name mutate -Value Set-Item`,
  `Set-Alias -Name mutate Set-Item`,
  `Set-Alias -Name:mutate Set-Item`,
  `New-Alias mutate Set-Item`,
  `nal mutate si`,
  `mutate Env:NODE_OPTIONS '--require=./preload.cjs'`,
  `[Environment]::SetEnvironmentVariable('NODE_OPTIONS','--require=./preload.cjs')`,
  `cmd /d /c "set NODE_OPTIONS=--require=./preload.cjs"`,
  `cmd /v:on /c "set N=NODE_OPTIONS & set !N!=--require=./preload.cjs"`,
  `cmd /d /c "call set NODE_OPTIONS=--require=./preload.cjs & node scripts/ordinary-check.mjs"`,
  `cmd /d /c "@call set NODE_OPTIONS=--require=./preload.cjs & node scripts/ordinary-check.mjs"`,
  `cmd /d /c "if 1==1 set NODE_OPTIONS=--require=./preload.cjs & npm --version"`,
  `cmd /d /c "if defined PATH call set NODE_OPTIONS=--require=./preload.cjs & npm --version"`,
  `cmd /d /c "for %A in (1) do set NODE_OPTIONS=--require=./preload.cjs & node scripts/ordinary-check.mjs"`,
  `export $(printf NODE_OPTIONS=--require=./preload.cjs); npm --version`,
  `declare -x "$(printf NODE_OPTIONS=--require=./preload.cjs)"; node scripts/ordinary-check.mjs`,
  `readonly "\${TARGET}=--require=./preload.cjs"; npm --version`,
  `declare -n ref=NODE_OPTIONS; export ref; ref=--require=./preload.cjs; node scripts/ordinary-check.mjs`,
  `typeset -n ref=NODE_OPTIONS; ref=--require=./preload.cjs; npm --version`,
  `local -n ref="\$TARGET"; node scripts/ordinary-check.mjs`,
  `declare -n ref=NODE_OPTIONS; export ref; ref=--require=./preload.cjs; "node" scripts/ordinary-check.mjs`,
  `env NODE_OPTIONS=--require=./preload.cjs "npm" --version`,
];
const privilegeWrapperNodeOptionsCases = [
  ["sudo", "NODE_OPTIONS=--require=./preload.cjs", "node", "scripts/ordinary-check.mjs"].join(" "),
  ["sudo", "-u", "root", "NODE_OPTIONS=--require=./preload.cjs", "node", "scripts/ordinary-check.mjs"].join(" "),
  ["wsl", "sudo", "NODE_OPTIONS=--require=./preload.cjs", "node", "scripts/ordinary-check.mjs"].join(" "),
  ["doas", "NODE_OPTIONS=--require=./preload.cjs", "node", "scripts/ordinary-check.mjs"].join(" "),
];
const watchRunnerGuardCases = [
  ["watch", "-n", "1", awkCommand, opaqueAwkProgram].join(" "),
  ["watch", "--unknown-runner-option", awkCommand, opaqueAwkProgram].join(" "),
  ["wsl", "busybox", "watch", "-n", "1", awkCommand, opaqueAwkProgram].join(" "),
  ["wsl", "busybox", "watch", "-n", "1", "env", "NODE_OPTIONS=--require=./preload.cjs", "node", "scripts/ordinary-check.mjs"].join(" "),
  ["busybox", "watch", "-n", "1", `'env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs'`].join(" "),
];
const nestedParserGuardCases = [
  ["cmd", "/d", "/c", `\"${awkCommand} -f payload.awk\"`].join(" "),
  ["env", `-S\"${awkCommand} -f payload.awk\"`].join(" "),
  `${findCommand} . \\${findExecOption} env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs \\;`,
  ["cmd", "/d", "/c", '"NO^DE_OPTIONS=--require=./preload.cjs & node scripts/ordinary-check.mjs"'].join(" "),
  ["cmd", "/d", "/c", '"set NO^DE_OPTIONS=--require=./preload.cjs & node scripts/ordinary-check.mjs"'].join(" "),
  ["env", '--split-string="-i NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs"'].join(" "),
  [["e", "nv"].join("\\"), "NODE_OPTIONS=--require=./preload.cjs", "node", "scripts/ordinary-check.mjs"].join(" "),
  [["co", "mmand"].join("\\"), "env", "NODE_OPTIONS=--require=./preload.cjs", "node", "scripts/ordinary-check.mjs"].join(" "),
];
const evalCommand = ["ev", "al"].join("");
const sourceCommand = ["sour", "ce"].join("");
const parallelCommand = ["para", "llel"].join("");
const indirectRunnerGuardCases = [
  `${evalCommand} 'export NODE_OPTIONS=--require=./preload.cjs'; node scripts/ordinary-check.mjs`,
  `${parallelCommand} -- env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs`,
  `${parallelCommand} -- '${awkCommand} "BEGIN { cmd = decode(); system(cmd) }"' ::: x`,
  `${evalCommand} \"$loader\"`,
  `${sourceCommand} ./setup.sh`,
  `${evalCommand} '${awkCommand} -f payload.awk'`,
];
const nestedCompletePolicyGuardCases = [
  `pwsh -NoProfile -Command "Start-Process env -ArgumentList 'NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs' -Wait"`,
  `${evalCommand} "wsl watch '${awkCommand} -f payload.awk'"`,
  `cmd /d /c "watch -n 1 ${awkCommand} -f payload.awk"`,
  `bash -c "watch -n 1 ${awkCommand} -f payload.awk"`,
  `pwsh -Command "${parallelCommand} -- '${awkCommand} -f payload.awk' ::: x"`,
];
const dynamicNodeOptionsGuardCases = [
  "env $(printf NODE_OPTIONS=--require=./preload.cjs) npm --version",
  'N=NODE; env "${N}_OPTIONS=--require=./preload.cjs" npm --version',
  'powershell -Command "Set-Item (\'Env:NO\' + \'DE_OPTIONS\') \'--require=./preload.cjs\'; npm --version"',
  'cmd /v:on /c "set N=NODE_OPTIONS & set !N!=--require=./preload.cjs & npm --version"',
  'cmd /v:on /c "set A=NODE & set B=_OPTIONS & set !A!!B!=--require=./preload.cjs & npm --version"',
  'cmd /v:on /c "set N=NODE_OPTIONS & set !N!=--require=./preload.cjs & n^pm --version"',
  'N=NODE_OPTIONS; env "${N}=--require=./preload.cjs" n\\pm --version',
  'cmd /v:on /c "set N=NODE_OPTIONS & set !N!=--require=./preload.cjs & ya^rn --version"',
  'cmd /v:on /c "set N=NODE_OPTIONS & set !N!=--require=./preload.cjs & b^un --version"',
  'pwsh -NoProfile -co "si Env:NODE_OPTIONS --require=./preload.cjs; n\\pm --version"',
];
const powerShellProviderGuardCases = [
  `${["Co", "py-Item"].join("")} Env:SAFE 'Env:NODE_OPTIONS'`,
  `${["c", "pi"].join("")} 'Env:SAFE' 'Env:NODE_OPTIONS'`,
  `${["c", "p"].join("")} Env:SAFE 'Env:NODE_OPTIONS'`,
  `${["co", "py"].join("")} Env:SAFE 'Env:NODE_OPTIONS'`,
  `${["Mo", "ve-Item"].join("")} Env:SAFE 'Env:NODE_OPTIONS'`,
  `${["m", "i"].join("")} 'Env:SAFE' 'Env:NODE_OPTIONS'`,
  `${["m", "ove"].join("")} Env:SAFE 'Env:NODE_OPTIONS'`,
  `${["m", "v"].join("")} 'Env:SAFE' 'Env:NODE_OPTIONS'`,
  `${["Re", "name-Item"].join("")} Env:SAFE 'NODE_OPTIONS'`,
  `${["r", "ni"].join("")} 'Env:SAFE' 'NODE_OPTIONS'`,
  `${["r", "en"].join("")} Env:SAFE 'NODE_OPTIONS'`,
  `${["Re", "mo", "ve-Item"].join("")} Env:NODE_OPTIONS`,
  `${["c", "li"].join("")} Env:NODE_OPTIONS`,
];
const powerShellProviderReadCases = [
  "Write-Output $env:NODE_OPTIONS",
  "Get-Item Env:NODE_OPTIONS",
  "Test-Path Env:NODE_OPTIONS",
];
const powerShellAliasGuardCases = [
  "Set-Alias -Na mutate -Va Set-Item",
  "Set-Alias -Va Set-Item -Na mutate",
  "New-Alias -N mutate -V Set-Item",
  "New-Alias -Val:Set-Item -Nam:mutate",
  "Set-Alias -Name mutate -Unknown Set-Item",
  'Set-Alias mutate ([string]::Concat("Set-","Item")); mutate ([string]::Concat("Env:NO","DE_OPTIONS")) "--require=./preload.cjs"; npm --version',
];
const powerShellComputedMutationGuardCases = [
  `Set-Item ("Env:NODE-XOPTIONS".Replace("-X","_")) ("--requXire=./preload.cjs".Replace("X","")); npm --version`,
  `Set-Content ("Env:NODE_OPTIONS".ToLower()) ("--require=./preload.cjs"); npm --version`,
  `pwsh -NoProfile -Command "Set-Item ('Env:NODE-XOPTIONS'.Replace('-X','_')) ('--requXire=./preload.cjs'.Replace('X','')); npm --version"`,
];
const npmConfigNodeOptionsGuardCases = [
  "npm_config_node_options=--require=./preload.cjs npm run ordinary",
  "env NPM_CONFIG_NODE_OPTIONS=--require=./preload.cjs npm run ordinary",
  "export NPM_CONFIG_NODE_OPTIONS=--require=./preload.cjs; npm run ordinary",
  "Set-Item Env:NPM_CONFIG_NODE_OPTIONS --require=./preload.cjs; npm run ordinary",
  "$env:NPM_CONFIG_NODE_OPTIONS='--require=./preload.cjs'; npm run ordinary",
  'cmd /c "set NPM_CONFIG_NODE_OPTIONS=--require=./preload.cjs & npm run ordinary"',
];
const harmlessPowerShellAliasCases = [
  "Set-Alias ll Get-ChildItem",
  "echo Set-Alias",
  "rg -n Set-Alias docs",
  "Set-Alias -Name ll -Value Get-ChildItem",
  "New-Alias ll Get-ChildItem",
];
const harmlessShellNodeOptionsCases = [
  "export -p NODE_OPTIONS; npm --version",
  "export -n NODE_OPTIONS; npm --version",
  "export -f NODE_OPTIONS; npm --version",
  "export -pn NODE_OPTIONS; npm --version",
];
const posixLineContinuationGuardCases = [
  ["NODE_\\", "OPTIONS=--require=./preload.cjs npm --version"].join("\n"),
  ["NODE_\\", "OPTIONS=--require=./preload.cjs npm --version"].join("\r\n"),
];
const boundaryForcePush = ["git", "push", "--force", "origin", "main"].join(" ");
const boundaryHardReset = ["git", "reset", "--hard", "HEAD~1"].join(" ");
const boundaryProdDeploy = [["ver", "cel"].join(""), ["--", "prod"].join("")].join(" ");
const boundaryEdgeDeploy = ["supabase", "functions", ["de", "ploy"].join(""), "guarded-function"].join(" ");
const powerShellLineBoundaryDenyCases = ["\n", "\r\n"].flatMap((newline) => [
  ["Write-Output x\\", boundaryForcePush].join(newline),
  ["Write-Output x\\", boundaryHardReset].join(newline),
]);
const powerShellLineBoundaryAskCases = ["\n", "\r\n"].flatMap((newline) => [
  ["Write-Output x\\", boundaryProdDeploy].join(newline),
  ["Write-Output x\\", boundaryEdgeDeploy].join(newline),
]);
for (const separator of [";", "|", "&"]) {
  ok(checkDangerousCommand(`Write-Output marker\x5c${separator} ${pythonCommand} -c \"print('opaque')\"`), `PowerShell backslash-prefixed ${separator} cannot hide an opaque interpreter`);
  ok(checkDangerousCommand(`Write-Output marker\x5c${separator} NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs`), `PowerShell backslash-prefixed ${separator} cannot hide a NODE_OPTIONS preload`);
}
ok(deepPowerShellBoundaryCommand.length <= SECURITY_COMMAND_CHAR_BUDGET, "deep PowerShell boundary fixture stays within the character budget");
ok(maintenanceProducerCommandMentioned(deepPowerShellBoundaryCommand), "deep PowerShell boundary normalization fails closed without unbounded recursion");
for (const command of xargsGuardCases) ok(checkDangerousCommand(command), `long no-run option cannot hide an xargs execution target: ${command}`);
for (const command of shellGrammarGuardCases) ok(checkDangerousCommand(command), `shell grammar cannot hide an opaque execution target: ${command}`);
ok(!checkDangerousCommand(`${timeCommand} --help ${awkCommand} ${opaqueAwkProgram}`), "terminal time help mode does not execute its trailing operand");
ok(!checkDangerousCommand(`'then' env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs`), "a quoted keyword remains an ordinary executable name");
for (const command of shellBuiltinNodeOptionsCases) ok(checkDangerousCommand(command), `shell builtin cannot hide an exported NODE_OPTIONS preload: ${command}`);
for (const command of privilegeWrapperNodeOptionsCases) ok(checkDangerousCommand(command), `privilege wrapper cannot hide a NODE_OPTIONS preload: ${command}`);
for (const command of watchRunnerGuardCases) ok(checkDangerousCommand(command), `watch runner cannot hide an opaque command: ${command}`);
ok(!checkDangerousCommand(["busybox", "watch", "--help", awkCommand, opaqueAwkProgram].join(" ")), "terminal BusyBox watch help mode does not execute a trailing operand");
for (const command of dynamicNodeOptionsGuardCases) ok(checkDangerousCommand(command), `dynamic NODE_OPTIONS construction fails closed: ${command}`);
for (const command of powerShellProviderGuardCases) ok(checkDangerousCommand(command), `PowerShell provider operation cannot stage NODE_OPTIONS: ${command}`);
for (const command of powerShellAliasGuardCases) ok(checkDangerousCommand(command), `PowerShell alias parameter form cannot hide a mutation-capable target: ${command}`);
for (const command of powerShellComputedMutationGuardCases) ok(checkDangerousCommand(command), `computed PowerShell mutation cannot stage a Node preload: ${command}`);
for (const command of npmConfigNodeOptionsGuardCases) ok(checkDangerousCommand(command), `npm config NODE_OPTIONS cannot stage a lifecycle preload: ${command}`);
for (const command of posixLineContinuationGuardCases) ok(checkDangerousCommand(command), `POSIX line continuation cannot hide NODE_OPTIONS: ${JSON.stringify(command)}`);
for (const command of powerShellLineBoundaryDenyCases) ok(checkDangerousCommand(command), `PowerShell line boundary cannot hide a blocked command: ${JSON.stringify(command)}`);
for (const command of powerShellLineBoundaryAskCases) ok(checkAskCommand(command), `PowerShell line boundary cannot hide an approval-gated command: ${JSON.stringify(command)}`);
for (const command of nestedParserGuardCases) ok(checkDangerousCommand(command), `nested or POSIX-escaped parser route is denied: ${command}`);
for (const command of nestedParserGuardCases.slice(0, 2)) ok(maintenanceProducerCommandMentioned(command), `nested AWK launcher enters the producer gate: ${command}`);
for (const command of indirectRunnerGuardCases) ok(checkDangerousCommand(command), `indirect or dynamic command runner fails closed: ${command}`);
for (const command of nestedCompletePolicyGuardCases) ok(checkDangerousCommand(command), `nested command body receives the complete runner policy: ${command}`);
ok(!checkDangerousCommand(`${parallelCommand} -- 'echo safe' ::: x`), "a quoted benign Parallel command body stays allowed");
ok(!checkDangerousCommand("env $(printf SAFE=1) echo ok"), "dynamic env construction without a Node-backed executable stays allowed");
ok(!checkDangerousCommand("rg -n 'env $(printf NODE_OPTIONS=x) npm' docs"), "dynamic NODE_OPTIONS spelling used as quoted search data stays allowed");
ok(!checkDangerousCommand("rg -n 'n^pm n\\pm ya^rn b^un NODE_OPTIONS' docs"), "escaped runner spellings used as quoted search data stay allowed");
ok(!checkDangerousCommand(`${findCommand} . '\\${findExecOption}' env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs \\;`), "a quoted escaped find action stays literal data");
for (const command of [
  "wsl awk 'BEGIN { cmd = decode(); system(cmd) }'",
  "wsl -d docker-desktop -- awk 'BEGIN { cmd = decode(); system(cmd) }'",
  "wsl --distribution=docker-desktop --exec busybox awk 'BEGIN { cmd = decode(); system(cmd) }'",
  `${findCommand} . -maxdepth 0 ${findExecOption} awk 'BEGIN { cmd = decode(); system(cmd) }' \\;`,
  `wsl ${findCommand} . -maxdepth 0 ${findExecOption} awk 'BEGIN { cmd = decode(); system(cmd) }' \\;`,
  `${findCommand} . ${findGroupOpen} ${findExecOption} awk 'BEGIN { cmd = decode(); system(cmd) }' ${findTerminator} ${findGroupClose}`,
  `${findCommand} . ${findExecOption} echo ok {} ${findTerminator} ${findExecOption} awk 'BEGIN { cmd = decode(); system(cmd) }' ${findTerminator}`,
  "xargs -a inputs.txt awk 'BEGIN { cmd = decode(); system(cmd) }'",
  "sudo awk 'BEGIN { cmd = decode(); system(cmd) }'",
]) {
  ok(maintenanceProducerCommandMentioned(command), `WSL/multi-call AWK launcher recognized: ${command}`);
  ok(checkDangerousCommand(command), `WSL/multi-call AWK launcher denied: ${command}`);
}
ok(!maintenanceProducerCommandMentioned("wsl --help awk 'BEGIN { print 1 }'"), "WSL help mode stays outside the producer gate");
const decoderToShellAsData = "rg -n 'base64 -d | sh' docs";
ok(!maintenanceProducerCommandMentioned(decoderToShellAsData), "decoder-to-shell spelling used as quoted search data is not classified as an invocation");
eq(checkMaintenanceProducerInvocation(decoderToShellAsData), null, "decoder-to-shell search data stays outside the producer gate");
ok(!checkDangerousCommand(decoderToShellAsData), "ordinary decoder-to-shell text search stays allowed");
for (const terminalWrapperCommand of ["env --help pwsh /EncodedCommand", "timeout --help pwsh /EncodedCommand", "taskset --help env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs", "ionice --help env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs", "unshare --help env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs"]) {
  ok(!maintenanceProducerCommandMentioned(terminalWrapperCommand), `terminal wrapper mode is not classified as execution: ${terminalWrapperCommand}`);
  eq(checkMaintenanceProducerInvocation(terminalWrapperCommand), null, `terminal wrapper mode stays outside the producer gate: ${terminalWrapperCommand}`);
  ok(!checkDangerousCommand(terminalWrapperCommand), `terminal wrapper mode stays allowed: ${terminalWrapperCommand}`);
}
const terminalWrapperAfterOption = "timeout -s TERM --help pwsh /" + "Encoded" + "Command";
ok(!maintenanceProducerCommandMentioned(terminalWrapperAfterOption), "terminal wrapper mode after an option is not classified as execution");
eq(checkMaintenanceProducerInvocation(terminalWrapperAfterOption), null, "terminal wrapper mode after an option stays outside the producer gate");
ok(!checkDangerousCommand(terminalWrapperAfterOption), "terminal wrapper mode after an option stays allowed");
ok(checkDangerousCommand("node --require ./preload.cjs scripts/ordinary-check.mjs"), "Node require preload is denied");
ok(checkDangerousCommand('nodejs "--import=data:text/javascript;base64,ZXhwb3J0IHt9" scripts/ordinary-check.mjs'), "nodejs import preload is denied before a reviewed script can run");
const nodejsPreloadHookResult = runHook({ tool_name: "Bash", tool_input: { command: 'nodejs "--import=data:text/javascript;base64,ZXhwb3J0IHt9" scripts/ordinary-check.mjs' } });
eq(nodejsPreloadHookResult.status, 0, "the Bash hook exits 0 after denying a nodejs import preload");
ok(nodejsPreloadHookResult.stdout.includes('"permissionDecision":"deny"'), "the Bash hook denies a nodejs import preload");
ok(checkDangerousCommand("NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs"), "NODE_OPTIONS preload is denied");
ok(checkDangerousCommand("FOO=1 NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs"), "prefixed NODE_OPTIONS preload is denied");
ok(checkDangerousCommand("command env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs"), "command-wrapped env NODE_OPTIONS preload is denied");
ok(checkDangerousCommand("SAFE=1 env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs"), "assignment-prefixed env NODE_OPTIONS preload is denied");
ok(checkDangerousCommand("SAFE=1 command -p env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs"), "assignment-prefixed command/env NODE_OPTIONS preload is denied");
ok(checkDangerousCommand("SAFE= command env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs"), "empty assignment before command/env NODE_OPTIONS preload is denied");
ok(checkDangerousCommand("command -- env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs"), "command terminator before env NODE_OPTIONS preload is denied");
ok(checkDangerousCommand("SAFE='x y' command -p -- env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs"), "quoted assignment before command/env NODE_OPTIONS preload is denied");
for (const command of [
  "exec env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
  "nohup env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
  "nice -n 5 env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
  "timeout 5s env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
  "taskset -c 0 env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
  "taskset --cpu-list 0 env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
  "taskset 0x1 env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
  "ionice -c 3 env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
  "ionice --class idle env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
  "ionice -c3 -n7 env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
  "unshare env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
  "unshare -Ur env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
  "unshare --mount=/tmp env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
  "unshare --map-user 0 --map-group=0 env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
  'unshare --unknown bash -c "export NODE_OPTIONS=--require=./preload.cjs; node scripts/ordinary-check.mjs"',
  'taskset --unknown bash -c "export NODE_OPTIONS=--require=./preload.cjs; node scripts/ordinary-check.mjs"',
  'ionice --unknown bash -c "export NODE_OPTIONS=--require=./preload.cjs; node scripts/ordinary-check.mjs"',
  "setsid env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
  "stdbuf -oL env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
  "timeout -vk 1s 5s env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
  "nohup NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
  `${findCommand} . -maxdepth 0 ${findExecOption} env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs \\;`,
  `${findCommand} . ${findGroupOpen} ${findExecOption} env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs ${findTerminator} ${findGroupClose}`,
  `${findCommand} . ${findExecOption} echo ok {} ${findTerminator} ${findExecOption} env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs ${findTerminator}`,
  "wsl env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
  "busybox env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
  "xargs -a inputs.txt env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
  "sudo env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
]) {
  ok(checkDangerousCommand(command), `process wrapper cannot hide an env NODE_OPTIONS preload: ${command}`);
}
ok(checkDangerousCommand("env -SNODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs"), "attached short env split-string NODE_OPTIONS preload is denied");
ok(checkDangerousCommand("env --split-string='NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs'"), "attached long env split-string NODE_OPTIONS preload is denied");
ok(checkDangerousCommand("echo safe\nNODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs"), "LF-delimited NODE_OPTIONS preload is denied");
ok(checkDangerousCommand("echo safe\r\nNODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs"), "CRLF-delimited NODE_OPTIONS preload is denied");
ok(checkDangerousCommand("export SAFE=1 NODE_OPTIONS=--require=./preload.cjs; node scripts/ordinary-check.mjs"), "later export operand NODE_OPTIONS preload is denied");
ok(checkDangerousCommand("SAFE=1 export MODE=test NODE_OPTIONS=--require=./preload.cjs; node scripts/ordinary-check.mjs"), "assignment-prefixed later export operand NODE_OPTIONS preload is denied");
ok(checkDangerousCommand('cmd /d /c "echo safe & set NODE_OPTIONS=--require=./preload.cjs & node scripts/ordinary-check.mjs"'), "cmd command-string NODE_OPTIONS preload is denied");
ok(checkDangerousCommand('powershell -NoProfile -Command "cmd /c \'set NODE_OPTIONS=--require=./preload.cjs & node scripts/ordinary-check.mjs\'"'), "PowerShell command-string NODE_OPTIONS preload is denied");
ok(checkDangerousCommand('bash -c "NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs"'), "POSIX shell command-string NODE_OPTIONS preload is denied");
ok(checkDangerousCommand("Set-Item Env:NODE_OPTIONS $PRELOAD"), "PowerShell Set-Item NODE_OPTIONS mutation is denied");
ok(checkDangerousCommand("$env:NODE_OPTIONS = $PRELOAD"), "PowerShell env assignment to NODE_OPTIONS is denied");
ok(checkDangerousCommand("[Environment]::SetEnvironmentVariable('NODE_OPTIONS', $PRELOAD)"), ".NET NODE_OPTIONS mutation is denied");
for (const command of powerShellProviderReadCases) ok(!checkDangerousCommand(command), `PowerShell environment read remains allowed: ${command}`);
for (const command of harmlessPowerShellAliasCases) ok(!checkDangerousCommand(command), `PowerShell alias text or read-only alias remains allowed: ${command}`);
for (const command of harmlessShellNodeOptionsCases) ok(!checkDangerousCommand(command), `non-assignment export mode remains allowed: ${command}`);
ok(!checkDangerousCommand("rg -n 'NODE_OPTIONS=' docs"), "NODE_OPTIONS spelling used as quoted search data stays allowed");
ok(!checkDangerousCommand("rg -n 'command env NODE_OPTIONS=' docs"), "wrapped NODE_OPTIONS spelling used as quoted search data stays allowed");
ok(!checkDangerousCommand("rg -n 'SAFE= command -- env NODE_OPTIONS=' docs"), "complex wrapped NODE_OPTIONS spelling used as quoted search data stays allowed");
ok(!checkDangerousCommand("rg -n 'cmd /c set NODE_OPTIONS=' docs"), "command-string NODE_OPTIONS spelling used as quoted search data stays allowed");
ok(!checkDangerousCommand("rg -n 'Set-Item Env:NODE_OPTIONS' docs"), "PowerShell NODE_OPTIONS mutation spelling used as quoted search data stays allowed");
ok(!checkDangerousCommand("rg -n 'si Env:NODE_OPTIONS; Set-Alias mutate Set-Item' docs"), "PowerShell alias mutation spelling used as quoted search data stays allowed");
ok(!checkDangerousCommand("printf -v SAFE %s ok; node scripts/ordinary-check.mjs"), "printf -v to an ordinary static variable remains allowed");
ok(!checkDangerousCommand("read -p NODE_OPTIONS SAFE < input.txt; node scripts/ordinary-check.mjs"), "read prompt text is not mistaken for a variable target");
ok(!checkDangerousCommand("set -a; set +a; node scripts/ordinary-check.mjs"), "disabling allexport before a Node-backed command remains allowed");
ok(!checkDangerousCommand(`rg -n 'pwsh -Command "$env:NODE_OPTIONS=x; npm --version"' docs`), "nested PowerShell mutation spelling used as quoted search data stays allowed");
ok(!checkDangerousCommand(`rg -n 'call set NODE_OPTIONS=x & npm --version' docs`), "nested CMD mutation spelling used as quoted search data stays allowed");
ok(!checkDangerousCommand(`rg -n 'export $(printf NODE_OPTIONS=x); npm --version' docs`), "dynamic export spelling used as quoted search data stays allowed");
ok(!checkDangerousCommand(`rg -n 'declare -n ref=NODE_OPTIONS; node app.mjs' docs`), "nameref spelling used as quoted search data stays allowed");
ok(!checkDangerousCommand(`rg -n '"node" app.mjs' docs`), "a quoted Node executable spelling used as search data stays allowed");

// ── net-new: shell-redirect .env write (2026-07-13, shared with mcp-tool-guard) ──
ok(checkDangerousCommand("echo SECRET=x > .env"), "shell-redirect write to .env blocked");
ok(checkDangerousCommand("echo SECRET=x >> .env.local"), "shell-redirect append to .env.local blocked");
ok(checkDangerousCommand("echo SECRET=x | tee .env"), "tee to .env blocked");
ok(!checkDangerousCommand("cat .env.example"), "reading .env.example is not a write, allowed");

// ── migration-modify check (unchanged) ─────────────────────────────────────
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "bash-safety-migtest-"));
  try {
    const migDir = path.join(tmp, "supabase", "migrations");
    mkdirSync(migDir, { recursive: true });
    const existing = path.join(migDir, "20260101000000_existing.sql");
    writeFileSync(existing, "select 1;");
    ok(
      checkMigrationModify(`echo "x" >> supabase/migrations/20260101000000_existing.sql`, tmp),
      "redirect-modify of an EXISTING migration file blocked"
    );
    ok(
      !checkMigrationModify(`echo "x" >> supabase/migrations/20260102000000_new.sql`, tmp),
      "redirect to a NEW (not-yet-existing) migration file allowed"
    );
    ok(!checkMigrationModify("echo hi", tmp), "unrelated command allowed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── FIX 2: npm-script indirection ──────────────────────────────────────────
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "bash-safety-npmtest-"));
  try {
    const pkg = {
      scripts: {
        safe: "vite build",
        dangerous: "git push --force origin main",
        producer: "node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
        "chain:a": "npm run chain:b",
        "chain:b": "npm run chain:c",
        "chain:c": "rm -rf src",
        // 5-deep chain: the dangerous command sits at hop 5 (depth 4), one past
        // the maxDepth=3 cap — proves the cap is a real boundary, not just
        // documentation. cap-a..cap-d (depths 0-3) ARE resolved; cap-e (depth 4)
        // is not, so its dangerous body is never inspected.
        "chain:cap-a": "npm run chain:cap-b",
        "chain:cap-b": "npm run chain:cap-c",
        "chain:cap-c": "npm run chain:cap-d",
        "chain:cap-d": "npm run chain:cap-e",
        "chain:cap-e": "git reset --hard HEAD~1",
      },
    };
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify(pkg, null, 2));

    const npmPackageManifest = ["package", "json"].join(".");
    const npmGitEnv = { ...process.env };
    for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete npmGitEnv[name];
    for (const args of [
      ["init", "--quiet"],
      ["config", "user.email", "guard-test@example.invalid"],
      ["config", "user.name", "Guard Test"],
      ["add", "--", npmPackageManifest],
      ["commit", "--quiet", "-m", "package fixture"],
    ]) {
      const gitResult = spawnSync("git", args, { cwd: tmp, encoding: "utf8", windowsHide: true, env: npmGitEnv });
      eq(gitResult.status, 0, `npm boundary fixture command succeeds: git ${args[0]}`);
    }
    const authoritativeResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8", windowsHide: true, env: npmGitEnv });
    eq(authoritativeResult.status, 0, "npm boundary fixture authoritative main SHA resolves");
    const reviewOptions = { authoritativeMainShaForTest: authoritativeResult.stdout.trim() };

    eq(extractNpmRunNames("npm run dangerous").length, 1, "extracts one npm run target");
    eq(extractNpmRunNames("npm test")[0], "test", "extracts npm's test lifecycle alias");
    eq(extractNpmRunNames(["npm ", "t"].join(""))[0], "test", "normalizes npm's short test alias");
    eq(extractNpmRunNames("npm rum dangerous")[0], "dangerous", "extracts npm's transposed run alias");
    ok(extractNpmRunNames("npm --workspace fixture run dangerous").includes("dangerous"), "extracts a script target after a valued npm option");
    ok(extractNpmRunNames("npm --workspace fixture test").includes("test"), "extracts a lifecycle alias after a valued npm option");
    eq(extractNpmRunNames("npm run safe && npm run dangerous").length, 2, "extracts multiple npm run targets");

    const scripts = readPackageScripts(tmp);
    ok(scripts && typeof scripts === "object", "readPackageScripts reads the temp package.json");
    eq(resolveNpmScriptChain(scripts, "chain:a").length, 3, "resolves a 3-deep chain (a, b, c bodies)");

    ok(!checkCommandDeep("npm run safe", tmp, reviewOptions), "npm run safe stays allowed");
    ok(checkCommandDeep("npm run dangerous", tmp, reviewOptions), "npm run dangerous is caught via its resolved script body");
    const reviewedProducerScriptCommand = ["npm run pro", "ducer"].join("");
    ok(checkCommandDeep(reviewedProducerScriptCommand, tmp, reviewOptions), "the reviewed main fixture still denies its untracked protected executor");
    ok(checkCommandDeep("npm run producer", tmp), "producer invocation hidden in an npm script is denied");
    ok(
      checkCommandDeep("npm run chain:a", tmp, reviewOptions),
      "a dangerous command hidden 2 levels deep behind chained npm scripts is caught (FIX 2)"
    );
    // Depth cap is a real boundary: cap-a..cap-d (depths 0-3) are resolved, and
    // the unresolved hop at cap-e is represented by a fail-closed marker.
    eq(resolveNpmScriptChain(scripts, "chain:cap-a", 0, 3).length, 5, "depth cap includes an unresolved-chain marker after 4 bodies");
    ok(
      checkCommandDeep("npm run chain:cap-a", tmp, reviewOptions),
      "a command one hop past the depth-3 cap fails closed"
    );

    // Unreadable/missing package.json → warn-and-allow, never throw or block.
    const missingDir = path.join(tmp, "does-not-exist");
    let threw = false;
    let result;
    try { result = checkCommandDeep("npm run dangerous", missingDir); } catch { threw = true; }
    ok(!threw, "missing package.json does not throw");
    eq(result, null, "missing package.json warn-and-allows (no block) for the script-body check");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── LIVE: bash-safety.mjs itself — benign allowed, dangerous denied ────────
let r = runHook({ tool_name: "Bash", tool_input: { command: "git status --short" } });
eq(r.status, 0, "bash-safety.mjs exits 0 on benign command");
ok(!r.stdout.includes('"permissionDecision":"deny"'), "bash-safety.mjs allows a benign Git status read");
r = runHook({ tool_name: "Bash", tool_input: { command: ["n", "px vite"].join("") } });
eq(r.status, 0, "bash-safety.mjs exits 0 after denying an opaque package resolver");
ok(r.stdout.includes('"permissionDecision":"deny"'), "bash-safety.mjs denies an opaque package resolver");
r = runHook({ tool_name: "Bash", tool_input: { command: ["vite --con", "fig output/ignored-config.mjs"].join("") } });
eq(r.status, 0, "bash-safety.mjs exits 0 after denying an untracked explicit package configuration file");
ok(r.stdout.includes('"permissionDecision":"deny"'), "bash-safety.mjs denies an untracked explicit package configuration file");
for (const command of ["rg -n npx docs", "git log --grep npm --grep exec", "echo vite"]) {
  r = runHook({ tool_name: "Bash", tool_input: { command } });
  eq(r.status, 0, "bash-safety.mjs exits 0 when a read-only argument names package tooling: " + command);
  ok(!r.stdout.includes('"permissionDecision":"deny"'), "bash-safety.mjs treats package-tool names in read-only arguments as data: " + command);
}

const oversizedWrapperCommand = `echo ${"watch ".repeat(30_000)}; ${["git", "push", "--force", "origin", "main"].join(" ")}`;
const oversizedStartedAt = process.hrtime.bigint();
const oversizedResult = runHook({ tool_name: "Bash", tool_input: { command: oversizedWrapperCommand } });
const oversizedElapsedMs = Number(process.hrtime.bigint() - oversizedStartedAt) / 1_000_000;
eq(oversizedResult.status, 0, "bash-safety.mjs exits 0 after an oversized wrapper payload");
ok(oversizedResult.stdout.includes('"permissionDecision":"deny"'), "bash-safety.mjs denies an oversized wrapper payload");
ok(oversizedElapsedMs < 1_500, `oversized wrapper denial stays well below the 5s hook timeout (actual ${oversizedElapsedMs.toFixed(0)}ms)`);

const hostileRunnerTail = ["git", "push", "--force", "origin", "main"].join(" ");
const hostileRunnerUnit = `${findCommand} . ${findExecOption} ${awkCommand} --help `;
const hostileRunnerCommand = `${hostileRunnerUnit.repeat(Math.floor((SECURITY_COMMAND_CHAR_BUDGET - hostileRunnerTail.length) / hostileRunnerUnit.length))}${hostileRunnerTail}`;
ok(hostileRunnerCommand.length <= SECURITY_COMMAND_CHAR_BUDGET, "hostile runner fixture stays within the character budget");
const hostileRunnerStartedAt = process.hrtime.bigint();
const hostileRunnerResult = runHook({ tool_name: "Bash", tool_input: { command: hostileRunnerCommand } });
const hostileRunnerElapsedMs = Number(process.hrtime.bigint() - hostileRunnerStartedAt) / 1_000_000;
eq(hostileRunnerResult.status, 0, "bash-safety.mjs exits 0 after an at-budget hostile runner payload");
ok(hostileRunnerResult.stdout.includes('"permissionDecision":"deny"'), "bash-safety.mjs denies an at-budget hostile runner payload");
ok(hostileRunnerElapsedMs < 1_500, `at-budget hostile runner denial stays well below the 5s hook timeout (actual ${hostileRunnerElapsedMs.toFixed(0)}ms)`);

const hostileGlobCommand = `${String.fromCharCode(99, 112)} ${"*".repeat(4_000)}never scratch; ${hostileRunnerTail}`;
const hostileGlobStartedAt = process.hrtime.bigint();
const hostileGlobResult = runHook({ tool_name: "Bash", tool_input: { command: hostileGlobCommand } });
const hostileGlobElapsedMs = Number(process.hrtime.bigint() - hostileGlobStartedAt) / 1_000_000;
eq(hostileGlobResult.status, 0, "bash-safety.mjs exits 0 after a hostile nonmatching glob");
ok(hostileGlobResult.stdout.includes('"permissionDecision":"deny"'), "bash-safety.mjs reaches the blocked tail after a hostile nonmatching glob");
ok(hostileGlobElapsedMs < 1_500, `hostile glob denial stays well below the 15s hook timeout (actual ${hostileGlobElapsedMs.toFixed(0)}ms)`);

const nestedEvalCommand = `${`${evalCommand} `.repeat(450)}${hostileRunnerTail}`;
ok(nestedEvalCommand.length <= SECURITY_COMMAND_CHAR_BUDGET, "nested eval fixture stays within the character budget");
ok(nestedEvalCommand.trim().split(/\s+/).length <= SECURITY_COMMAND_TOKEN_BUDGET, "nested eval fixture stays within the token budget");
const nestedEvalStartedAt = process.hrtime.bigint();
const nestedEvalResult = runHook({ tool_name: "Bash", tool_input: { command: nestedEvalCommand } });
const nestedEvalElapsedMs = Number(process.hrtime.bigint() - nestedEvalStartedAt) / 1_000_000;
eq(nestedEvalResult.status, 0, "bash-safety.mjs exits 0 after a below-budget nested eval payload");
ok(nestedEvalResult.stdout.includes('"permissionDecision":"deny"'), "bash-safety.mjs denies a below-budget nested eval payload");
ok(nestedEvalElapsedMs < 1_500, `nested eval denial stays well below the 15s hook timeout (actual ${nestedEvalElapsedMs.toFixed(0)}ms)`);

r = runHook({ tool_name: "Bash", tool_input: { command: "git push --force origin main" } });
eq(r.status, 0, "bash-safety.mjs exits 0 on dangerous command");
ok(r.stdout.includes('"permissionDecision":"deny"'), "bash-safety.mjs denies a force push");

r = runHook({ tool_name: "Bash", tool_input: { command: "awk 'BEGIN { cmd = decode(); system(cmd) }'" } });
eq(r.status, 0, "bash-safety.mjs exits 0 after denying an opaque AWK launcher");
ok(r.stdout.includes('"permissionDecision":"deny"'), "bash-safety.mjs denies an opaque AWK launcher");
ok(r.stdout.includes("Blocked maintenance producer invocation"), "AWK denial emits the descriptive maintenance reason");
ok(!r.stdout.includes('"permissionDecisionReason":true'), "AWK denial never serializes a boolean as the permission reason");

for (const command of [
  `${findCommand} . -maxdepth 0 ${findExecOption} awk 'BEGIN { cmd = decode(); system(cmd) }' \\;`,
  `wsl ${findCommand} . -maxdepth 0 ${findExecOption} awk 'BEGIN { cmd = decode(); system(cmd) }' \\;`,
  `${findCommand} . ${findGroupOpen} ${findExecOption} awk 'BEGIN { cmd = decode(); system(cmd) }' ${findTerminator} ${findGroupClose}`,
  `${findCommand} . ${findExecOption} echo ok {} ${findTerminator} ${findExecOption} awk 'BEGIN { cmd = decode(); system(cmd) }' ${findTerminator}`,
  `${findCommand} . -maxdepth 0 ${findExecOption} env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs \\;`,
  `${findCommand} . ${findGroupOpen} ${findExecOption} env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs ${findTerminator} ${findGroupClose}`,
  `${findCommand} . ${findExecOption} echo ok {} ${findTerminator} ${findExecOption} env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs ${findTerminator}`,
  "wsl env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
  "busybox env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
  ...[";", "|", "&"].map((separator) => `Write-Output marker\x5c${separator} ${pythonCommand} -c \"print('opaque')\"`),
  ...[";", "|", "&"].map((separator) => `Write-Output marker\x5c${separator} NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs`),
  ...shellGrammarGuardCases,
  ...privilegeWrapperNodeOptionsCases,
  ...watchRunnerGuardCases,
]) {
  r = runHook({ tool_name: command.startsWith("Write-Output") ? "PowerShell" : "Bash", tool_input: { command } });
  eq(r.status, 0, `bash-safety.mjs exits 0 after denying a command-runner route: ${command}`);
  ok(r.stdout.includes('"permissionDecision":"deny"'), `bash-safety.mjs denies a command-runner route: ${command}`);
}

for (const command of xargsGuardCases) {
  r = runHook({ tool_name: "Bash", tool_input: { command } });
  eq(r.status, 0, `bash-safety.mjs exits 0 after denying a long-option xargs route: ${command}`);
  ok(r.stdout.includes('"permissionDecision":"deny"'), `bash-safety.mjs denies a long-option xargs route: ${command}`);
}

for (const command of shellBuiltinNodeOptionsCases) {
  r = runHook({ tool_name: "Bash", tool_input: { command } });
  eq(r.status, 0, `bash-safety.mjs exits 0 after denying a shell-builtin preload: ${command}`);
  ok(r.stdout.includes('"permissionDecision":"deny"'), `bash-safety.mjs denies a shell-builtin preload: ${command}`);
}

for (const command of nestedParserGuardCases) {
  r = runHook({ tool_name: "Bash", tool_input: { command } });
  eq(r.status, 0, `bash-safety.mjs exits 0 after denying a nested parser route: ${command}`);
  ok(r.stdout.includes('"permissionDecision":"deny"'), `bash-safety.mjs denies a nested parser route: ${command}`);
}

for (const command of indirectRunnerGuardCases) {
  r = runHook({ tool_name: "Bash", tool_input: { command } });
  eq(r.status, 0, `bash-safety.mjs exits 0 after denying an indirect runner: ${command}`);
  ok(r.stdout.includes('"permissionDecision":"deny"'), `bash-safety.mjs denies an indirect runner: ${command}`);
}

for (const command of powerShellProviderGuardCases) {
  r = runHook({ tool_name: "PowerShell", tool_input: { command } });
  eq(r.status, 0, `bash-safety.mjs exits 0 after denying a provider mutation: ${command}`);
  ok(r.stdout.includes('"permissionDecision":"deny"'), `bash-safety.mjs denies a provider mutation: ${command}`);
}
for (const command of powerShellAliasGuardCases) {
  r = runHook({ tool_name: "PowerShell", tool_input: { command } });
  eq(r.status, 0, `bash-safety.mjs exits 0 after denying an alias mutation: ${command}`);
  ok(r.stdout.includes('"permissionDecision":"deny"'), `bash-safety.mjs denies an alias mutation: ${command}`);
}
for (const command of powerShellComputedMutationGuardCases) {
  r = runHook({ tool_name: command.startsWith("pwsh") ? "Bash" : "PowerShell", tool_input: { command } });
  eq(r.status, 0, `bash-safety.mjs exits 0 after denying a computed PowerShell mutation: ${command}`);
  ok(r.stdout.includes('"permissionDecision":"deny"'), `bash-safety.mjs denies a computed PowerShell mutation: ${command}`);
}
for (const command of npmConfigNodeOptionsGuardCases) {
  const toolName = /^(?:Set-Item|\$env:)/i.test(command) ? "PowerShell" : "Bash";
  r = runHook({ tool_name: toolName, tool_input: { command } });
  eq(r.status, 0, `bash-safety.mjs exits 0 after denying an npm config NODE_OPTIONS preload: ${command}`);
  ok(r.stdout.includes('"permissionDecision":"deny"'), `bash-safety.mjs denies an npm config NODE_OPTIONS preload: ${command}`);
}
for (const command of posixLineContinuationGuardCases) {
  r = runHook({ tool_name: "Bash", tool_input: { command } });
  eq(r.status, 0, `bash-safety.mjs exits 0 after denying a continued NODE_OPTIONS name: ${JSON.stringify(command)}`);
  ok(r.stdout.includes('"permissionDecision":"deny"'), `bash-safety.mjs denies a continued NODE_OPTIONS name: ${JSON.stringify(command)}`);
}
for (const command of powerShellLineBoundaryDenyCases) {
  r = runHook({ tool_name: "PowerShell", tool_input: { command } });
  eq(r.status, 0, `bash-safety.mjs exits 0 after denying a PowerShell boundary bypass: ${JSON.stringify(command)}`);
  ok(r.stdout.includes('"permissionDecision":"deny"'), `bash-safety.mjs denies a PowerShell boundary bypass: ${JSON.stringify(command)}`);
}
for (const command of powerShellLineBoundaryAskCases) {
  r = runHook({ tool_name: "PowerShell", tool_input: { command } });
  eq(r.status, 0, `bash-safety.mjs exits 0 after gating a PowerShell boundary deploy: ${JSON.stringify(command)}`);
  ok(r.stdout.includes('"permissionDecision":"ask"'), `bash-safety.mjs asks for a PowerShell boundary deploy: ${JSON.stringify(command)}`);
}
for (const command of powerShellProviderReadCases) {
  r = runHook({ tool_name: "PowerShell", tool_input: { command } });
  eq(r.status, 0, `bash-safety.mjs exits 0 for a provider read: ${command}`);
  ok(r.stdout.includes('"permissionDecision":"allow"'), `bash-safety.mjs explicitly allows a provider read: ${command}`);
}
for (const command of harmlessPowerShellAliasCases) {
  r = runHook({ tool_name: "PowerShell", tool_input: { command } });
  eq(r.status, 0, `bash-safety.mjs exits 0 for a harmless alias command: ${command}`);
  ok(r.stdout.includes('"permissionDecision":"allow"'), `bash-safety.mjs explicitly allows a harmless alias command: ${command}`);
}
for (const command of harmlessShellNodeOptionsCases) {
  r = runHook({ tool_name: "Bash", tool_input: { command } });
  eq(r.status, 0, `bash-safety.mjs exits 0 for a non-assignment export mode: ${command}`);
  ok(!r.stdout.includes('"permissionDecision":"deny"'), `bash-safety.mjs allows a non-assignment export mode: ${command}`);
}

for (const command of nestedCompletePolicyGuardCases) {
  r = runHook({ tool_name: "Bash", tool_input: { command } });
  eq(r.status, 0, `bash-safety.mjs exits 0 after denying a nested complete-policy route: ${command}`);
  ok(r.stdout.includes('"permissionDecision":"deny"'), `bash-safety.mjs denies a nested complete-policy route: ${command}`);
}

r = runHook({ tool_name: "PowerShell", tool_input: { command: deepPowerShellBoundaryCommand } });
eq(r.status, 0, "bash-safety.mjs survives a deeply escaped PowerShell boundary");
ok(r.stdout.includes('"permissionDecision":"deny"'), "bash-safety.mjs fails closed on a deeply escaped PowerShell boundary");

r = runHook({
  tool_name: "PowerShell",
  tool_input: {
    command: "[IO.File]::WriteAllText('scripts/apply-live-testdata-maintenance-20260812.mjs','owned'); node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
  },
});
eq(r.status, 0, "bash-safety.mjs exits 0 after denying a chained producer rewrite");
ok(r.stdout.includes('"permissionDecision":"deny"'), "current shell guard denies the exact producer TOCTOU reproduction");

for (const command of [
  "git push origin feature/test --force",
  "git push --all origin --force",
  "git push origin --all --force",
  "git -C . push origin feature/test -uf",
  "git push origin +feature/test",
  "git push --all origin",
  "git push origin --branches",
]) {
  r = runHook({ tool_name: "Bash", tool_input: { command } });
  eq(r.status, 0, `bash-safety exits 0 after denying: ${command}`);
  ok(r.stdout.includes('"permissionDecision":"deny"'), `bash-safety denies force/bulk push: ${command}`);
}

// ── Codex P1 round 3: valid npm option forms must still resolve script names ──
eq(extractNpmRunNames("npm run --silent dangerous")[0], "dangerous", "npm run --silent <name> resolves the name, not the flag");
eq(extractNpmRunNames("npm -s run dangerous")[0], "dangerous", "npm -s run <name> resolves");
eq(extractNpmRunNames("npm run-script dangerous")[0], "dangerous", "npm run-script alias resolves");
eq(extractNpmRunNames("npm --loglevel=silent run dangerous")[0], "dangerous", "npm --opt=value run <name> resolves");

// ── Codex P1 round 4: npm pre/post lifecycle scripts ride along ──────────────
{
  const scripts = { build: "vite build", prebuild: "git push --force origin main" };
  const chain = resolveNpmScriptChain(scripts, "build");
  ok(chain.includes("git push --force origin main"), "prebuild lifecycle script is resolved with npm run build");
}
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "bashsafety-lifecycle-"));
  try {
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify({
      scripts: { build: "echo building", postbuild: "git reset --hard HEAD~1" },
    }));
    ok(checkCommandDeep("npm run build", tmp), "dangerous POSTbuild lifecycle script is blocked");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Codex P2 round 4: tracked .env templates are exempt from the redirect ban ─
eq(checkDangerousCommand("node gen-template.js > .env.example"), null, "redirect to .env.example (template) allowed");
eq(checkDangerousCommand("cat base > .env.staging.example"), null, "redirect to .env.staging.example allowed");
ok(checkDangerousCommand("echo SECRET > .env.staging"), ".env.staging (real env) still blocked");

// ── Codex P2 2026-07-13: .env redirect with NO space after > must be caught ──
ok(checkDangerousCommand("echo SECRET>.env"), "no-space redirect to .env blocked");
ok(checkDangerousCommand("echo SECRET >.env"), "space-before-only redirect to .env blocked");
ok(checkDangerousCommand("echo SECRET>>.env.production"), "no-space append to .env.production blocked");
eq(checkDangerousCommand("echo hello > notes.txt"), null, "redirect to a non-.env file still allowed");
eq(checkDangerousCommand("dotenv -e .env.test -- npm run test"), null, "mentioning .env without a redirect still allowed");

// ── Codex P1 2026-07-13: npm-resolved script bodies must also hit the
//    migration-immutability check, not just the dangerous-command table ──────
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "bashsafety-npm-mig-"));
  try {
    mkdirSync(path.join(tmp, "supabase", "migrations"), { recursive: true });
    writeFileSync(path.join(tmp, "supabase", "migrations", "20260101000000_existing.sql"), "select 1;\n");
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify({
      scripts: { sneaky: "echo '-- tweak' >> supabase/migrations/20260101000000_existing.sql" },
    }));
    ok(checkCommandDeep("npm run sneaky", tmp), "npm script that appends to an EXISTING migration is blocked");
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify({
      scripts: { fine: "echo ok > supabase/migrations/20990101000000_brand_new.sql" },
    }));
    ok(checkCommandDeep("npm run fine", tmp), "an unreviewed package manifest fails closed before any npm script can write a new migration");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`bash-safety: ${pass} assertions passed`);
