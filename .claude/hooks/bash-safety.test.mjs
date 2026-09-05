#!/usr/bin/env node
// Tests for bash-safety-lib.mjs (dangerous-command patterns + npm-script
// indirection, FIX 2) and a couple of LIVE invocations of bash-safety.mjs
// itself (benign command allowed, dangerous command denied).
// Run: node .claude/hooks/bash-safety.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkMaintenanceProducerInvocation,
  checkDangerousCommand,
  checkCommandDeep,
  checkMigrationModify,
  extractNpmRunNames,
  maintenanceProducerNamed,
  computedJavaScriptScriptArgument,
  splitShellSegments,
  resolveNpmScriptChain,
  readPackageScripts,
} from "./bash-safety-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }
function eq(a, b, m) { assert.equal(a, b, m); pass++; }

// ── direct dangerous-command patterns (unchanged behavior) ────────────────
ok(checkDangerousCommand("git push --force origin main"), "force push blocked");
ok(checkDangerousCommand("git push -f origin main"), "force push -f blocked");
ok(checkDangerousCommand("git reset --hard HEAD~1"), "hard reset blocked");
ok(checkDangerousCommand("git checkout ."), "discard-all checkout blocked");
ok(checkDangerousCommand("git clean -fd"), "git clean -f blocked");
ok(checkDangerousCommand("npm test -- --no-verify"), "--no-verify blocked");
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

// ── maintenance producer: denied BY NAME, and by a computed JavaScript script
//    argument (2026-09-05). The opaque-invocation classifier that used to sit here
//    fired 849 times in the 2026-08-21..09-04 fortnight, 59 of them on the
//    producer; the 2026-08-31 decision (DECISION_LOG) recorded it as ineffective
//    and named its removal the next harness task. The corpus below is the SAME
//    corpus the classifier was tested against, re-sorted by what the by-name rule
//    does with each entry, so every flip from deny to allow is explicit and
//    pinned. ──
const decodedPowerShellProcessLaunch = "Set-Item Env:NODE_OPTIONS ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('LS1yZXF1aXJlPS4vcHJlbG9hZC5janM='))); Set-Variable E ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('bm9kZQ=='))); Set-Variable A @(([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('c2NyaXB0cy9hcHBseS1saXZlLXRlc3RkYXRhLW1haW50ZW5hbmNlLTIwMjYwODEyLm1qcw=='))),([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('LS1hcHByb3ZlZC1ieS1tYXNvbj0yMDI2LTA4LTEy')))); Start-Process (Get-Variable E -ValueOnly) -ArgumentList (Get-Variable A -ValueOnly) -Wait -NoNewWindow";
for (const command of [
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --approved-by-mason=2026-08-12",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --approved-by-mason=2026-08-12 --protect-producer",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --approved-by-mason=2026-08-12 --retire-producer",
]) {
  ok(maintenanceProducerNamed(command), `the exact command names the producer: ${command}`);
  eq(checkMaintenanceProducerInvocation(command), null, `…and is exempt as one of the four reviewed invocations: ${command}`);
}
// (a) The producer or its approval token in any spelling that survives
//     quote/slash/whitespace/escape stripping — chained, wrapped, re-spelled,
//     reordered, with an unknown argument, behind cmd/env, or with the name
//     assembled by cmd `set` — stays denied.
for (const command of [
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
  "node scripts/$(printf apply-live-testdata-maintenance-20260812.mjs) --approved-by-mason=2026-08-12",
  "node --no-warnings scripts/$(printf apply-live-testdata-maintenance-20260812.mjs) --approved-by-$(printf mason)=2026-08-12",
  "node --require fs scripts/$(printf apply-live-testdata-maintenance-20260812.mjs) --approved-by-$(printf mason)=2026-08-12",
  'cmd /v:on /c "set a=--requ&set b=ire&set c=scripts/apply-live-testdata-maintenance-20260812.mjs&node !a!!b! ./preload.cjs !c! --approved-by-mason=2026-08-12"',
]) {
  ok(maintenanceProducerNamed(command), `producer named: ${command}`);
  ok(checkDangerousCommand(command), `named producer invocation denied by shell guard: ${command}`);
}
// (b) A JavaScript runtime (node/nodejs/bun/deno) whose SCRIPT argument is
//     computed — a variable, a substitution, a glob, a brace expansion, a cmd
//     `!var!`, a PowerShell sub-expression — stays denied whatever launcher,
//     shell, quote, or word-splitting escape sits around the runtime's name, as
//     long as the segment's head word is something that executes it.
for (const command of [
  "node scripts/appl?-live-testdata-maintenance-2026081?.mjs --approved-by-$(printf mason)=2026-08-12",
  "node </dev/null --no-warnings scripts/$(printf YXBwbHktbGl2ZS10ZXN0ZGF0YS1tYWludGVuYW5jZS0yMDI2MDgxMi5tanM= | base64 -d) --approved-by-$(printf bWFzb24= | base64 -d)=2026-08-12",
  "node --no-warnings \\\nscripts/$(printf YXBwbHktbGl2ZS10ZXN0ZGF0YS1tYWludGVuYW5jZS0yMDI2MDgxMi5tanM= | base64 -d) --approved-by-$(printf bWFzb24= | base64 -d)=2026-08-12",
  "node --require ./preload.cjs scripts/apply-l{i..i}ve-testdata-maintenance-20260{8..8}12.mjs --approved-by-ma{s..s}on=2026-08-12",
  'F=$(decode); nodejs --require ./preload.cjs "$F" "$P" "$S" "$T"',
  'F=$(decode); bun --preload ./preload.mjs "$F" "$P" "$S" "$T"',
  'F=$(decode); deno run "$F" "$P" "$S" "$T"',
  "node (\"--req\"+\"uire\") ./preload.cjs (\"scripts/apply-\"+\"live-testdata-maintenance-20260812.mjs\") (\"--approved-by-\"+\"mason=2026-08-12\")",
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); command node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); command -p node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); exec node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); exec -c node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); env -i node --no-warnings "$F" "$P" "$S" "$T"',
  'set F=encoded& set P=encoded& set S=encoded& set T=encoded& cmd /v:on /c "node --no-warnings !F! !P! !S! !T!"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); exec -ca reviewed-name node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); env --default-signal node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); command -p -- node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); exec -a "reviewed name" node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); env -C "C:\\temp dir" node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); nohup node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); nice node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); timeout 5 node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); setsid node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); stdbuf -o0 node --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); (node --no-warnings "$F" "$P" "$S" "$T")',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); "node" --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); nohup "node" --no-warnings "$F" "$P" "$S" "$T"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); Select-String -Pattern\n"node" --no-warnings "$F" "$P" "$S" "$T"',
  'set F=encoded& set P=encoded& set S=encoded& set T=encoded& cmd /v:on /c"node --no-warnings !F! !P! !S! !T!"',
  'F=$(decode); P=$(decode); S=$(decode); T=$(decode); Select-String -Pattern ^\n"node" --no-warnings "$F" "$P" "$S" "$T"',
  'set F=encoded& set P=encoded& set S=encoded& set T=encoded& cmd /v:on /d/s/c"node --no-warnings !F! !P! !S! !T!"',
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
  'F=$(decode); pwsh /Com \'"node" $F\'',
  'F=$(decode); pwsh /CommandWithArgs \'"node" $F\'',
  'F=$(decode); pwsh /cwa \'"node" $F\'',
  'F=$(decode); pwsh /Com:\'"node" $F\'',
  'F=$(decode); "pwsh" /Com \'"node" $F\'',
  'F=$(decode); cmd /d /c \'@node "$F"\'',
  'F=$(decode); pwsh --Command \'"node" $F\'',
  'F=$(decode); pwsh --CommandWithArgs \'"node" $F\'',
]) {
  ok(computedJavaScriptScriptArgument(command), `computed script argument: ${command}`);
  ok(checkDangerousCommand(command), `computed-script launch denied by shell guard: ${command}`);
}
// (c) NODE_OPTIONS mutation through PowerShell is its own ordered check now (it
//     used to ride inside the classifier); the 2026-08-12 decoded launch still
//     denies, for that reason and no other.
ok(/NODE_OPTIONS/.test(checkDangerousCommand(decodedPowerShellProcessLaunch) || ""), "decoded PowerShell launch is denied by the NODE_OPTIONS rule");
ok(!maintenanceProducerNamed(decodedPowerShellProcessLaunch) && !computedJavaScriptScriptArgument(decodedPowerShellProcessLaunch), "…and by nothing else: its producer name and arguments are base64, invisible to a by-name rule");
// (d) NOW ALLOWED — every corpus entry the classifier refused only because its
//     executable or its code could not be read from the text. None names the
//     producer and none launches a JavaScript runtime on a computed script. Two of
//     them ARE producer invocations with the name split or held in variables
//     (`& ('no','de' -join '') …`, `& $EXE $OPTION $MODULE $SCRIPT $APPROVAL`):
//     allowed on purpose. The producer refuses any argv but its exact reviewed one,
//     a body that differs from its committed HEAD blob, and any write without a
//     fresh exact-head Sol proof; and the same run was always reachable through
//     `node runner.mjs`, which the classifier never saw. The generated Codex
//     production guard keeps the full classifier for the session that holds
//     production credentials.
for (const command of [
  'python -c "import base64; exec(base64.b64decode(PAYLOAD))"',
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
  'F=$(decode); ./reviewed-runtime --require ./preload.cjs "$F" "$P" "$S" "$T"',
  'PACKED=$(decode); env -S "$PACKED"',
  'PACKED=$(decode); env -S"$PACKED"',
  'PACKED=$(decode); env -a reviewed-name -S"$PACKED"',
  'PACKED=$(decode); env -vS"$PACKED"',
  'pwsh -EncodedCommand ZW5jb2RlZA==',
  'ENC=$(decode); pwsh -ec "$ENC"',
  'pwsh /EncodedCommand ZW5jb2RlZA==',
  'pwsh /EncodedCommand:ZW5jb2RlZA==',
  'ENC=$(decode); pwsh /ec "$ENC"',
  '"pwsh" /EncodedCommand ZW5jb2RlZA==',
  'pwsh "$env:OPT" "$env:PAYLOAD"',
  'pwsh @args',
  "Start-Process pwsh -ArgumentList '-" + "Encoded" + "Command','ZW5jb2RlZA==' -Wait",
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
  eq(checkDangerousCommand(command), null, `nameless command with no computed JavaScript script is no longer the producer guard's business: ${command}`);
}
// (e) The ordinary shapes that made up most of the 849 refusals, pinned as allowed…
for (const command of [
  'node -e "console.log(process.versions.node)"',
  "node -v",
  'node -e "console.log(`x ${process.env.HOME}`)"',
  "node -pe 'process.arch'",
  "node - < script.mjs",
  "node --enable-source-maps scripts/x.mjs",
  "node scripts/claude-usage-report.mjs --days $(printf 14)",
  'node scripts/x.mjs "$SINCE"',
  "node scripts/x.mjs; node -e 'x'",
  "bash -c 'ls -la'",
  "printf '%s\\n' a b | xargs -n1 echo",
  "[ -f package.json ] && echo present",
  "python3 -c 'print(1)'",
  "cat <<'EOF'\nhello\nEOF",
  "$HOME/.local/bin/tool --version",
  "Get-ChildItem @('a','b')",
  "& git status",
  "pwsh -File script.ps1 /EncodedCommand",
]) {
  eq(checkDangerousCommand(command), null, `ordinary command stays allowed: ${command}`);
}
// (f) …and the computed-script shapes one token away from them, pinned as denied.
for (const command of [
  'node "$F"',
  "node scripts/$(printf x).mjs",
  "node scripts/appl?.mjs",
  "node --no-warnings \\\n\"$F\"",
  'F=x; n^ode "$F"',
  'F=x; cmd /d /c \'@node "$F"\'',
  'deno run --allow-read "$F"',
  "bun run $SCRIPT",
  'node -r "$P" scripts/x.mjs',
  "node scripts/%SCRIPT%.mjs",
  "node (Get-Item scripts/x.mjs).FullName",
]) {
  ok(computedJavaScriptScriptArgument(command), `computed script argument recognised: ${command}`);
  ok(checkDangerousCommand(command), `computed-script launch denied: ${command}`);
}
// (g) Codex App review of PR #619 (three P2 findings on 0d5823915), each pinned
//     in both directions.
//     1. A redirection glued to the runtime's name is still a launch: `<`/`>`
//        end the name like whitespace, a leading redirection does not hide the
//        head word, and a bare operator's target is not the script.
for (const command of [
  'F=x; node</dev/null "$F"',
  'node</dev/null "$F"',
  'node>out "$F"',
  'node > out "$F"',
  '</dev/null node "$F"',
  '2>&1 node "$F"',
  '> out node "$F"',
  'F=x </dev/null node "$F"',
]) {
  ok(computedJavaScriptScriptArgument(command), `redirection does not hide a computed script: ${command}`);
  ok(checkDangerousCommand(command), `computed-script launch behind a redirection denied: ${command}`);
}
//     2. A separator inside quotes is data, not a new segment: a search or a
//        commit message that quotes `; node "$F"` is not a launch, while a shell
//        head whose quoted argument contains one still is.
for (const command of [
  "rg -n 'foo | node \"$F\"' docs",
  "rg -n 'foo; node \"$F\"' docs",
  'git commit -m "later: run node $SCRIPT; then node $F"',
  "echo 'a & node $F'",
  'Write-Output "it\'s; node $F"',
]) {
  eq(checkMaintenanceProducerInvocation(command), null, `quoted separator does not open a launch segment: ${command}`);
  ok(!checkDangerousCommand(command), `quoted separator stays allowed: ${command}`);
}
for (const command of [
  "bash -c 'echo a; node \"$F\"'",
  "bash -c 'echo a | node \"$F\"'",
  "pwsh -Command 'Write-Output a; node $F'",
  "echo 'a'; node \"$F\"",
  "echo \"it's\"; node \"$F\"",
]) {
  ok(computedJavaScriptScriptArgument(command), `real separator or shell head still reaches the launch: ${command}`);
  ok(checkDangerousCommand(command), `computed-script launch after a quoted word denied: ${command}`);
}
eq(splitShellSegments("rg -n 'a; b | c' docs; node x").length, 2, "quoted separators do not split; a real one does");
eq(splitShellSegments('echo "a; \\" b"; node x').length, 2, "an escaped quote inside double quotes does not end the quote");
eq(splitShellSegments("echo a\\; node x").length, 1, "a backslash-escaped separator does not split");
eq(splitShellSegments("echo 'unterminated; node x").length, 1, "an unterminated quote swallows the rest of the line");
//     3. A literal, non-loader option whose computed value is QUOTED keeps the
//        parser moving toward the (literal) script; an unquoted expansion can
//        word-split into a script argument, and a computed option NAME or a
//        loader option keeps its denial.
for (const command of [
  'TITLE=worker node --title="$TITLE" scripts/safe.mjs',
  "node --title='$TITLE' scripts/safe.mjs",
  'node "--title=$TITLE" scripts/safe.mjs',
  'node --max-old-space-size="$(nproc)" scripts/safe.mjs',
]) {
  ok(!computedJavaScriptScriptArgument(command), `quoted computed value of an ordinary option is not a computed script: ${command}`);
  eq(checkDangerousCommand(command), null, `ordinary option with a quoted computed value stays allowed: ${command}`);
}
for (const command of [
  "node --title=$TITLE scripts/safe.mjs",
  "node --title=%TITLE% scripts/safe.mjs",
  "node --$OPT scripts/safe.mjs",
  "node -$OPT scripts/safe.mjs",
  'node --require="$P" scripts/safe.mjs',
  'node --import="$P" scripts/safe.mjs',
  "node --loader=$P scripts/safe.mjs",
]) {
  ok(computedJavaScriptScriptArgument(command), `computed option name, unquoted value, or loader value is still a computed script: ${command}`);
  ok(checkDangerousCommand(command), `computed option launch denied: ${command}`);
}
const focusedProducerHarness = "node scripts/apply-live-testdata-maintenance-20260812.test.mjs";
ok(!maintenanceProducerNamed(focusedProducerHarness), "focused producer test harness is not the producer's name");
eq(checkMaintenanceProducerInvocation(focusedProducerHarness), null, "focused producer test harness stays allowed by the shell guard");
ok(!checkDangerousCommand(focusedProducerHarness), "focused producer test harness stays runnable");
// Quoted data that merely MENTIONS a runtime, a shell, or an encoded-command
// spelling was never an invocation; it stays outside the producer gate.
for (const dataCommand of [
  "Select-String -Pattern 'node' | ForEach-Object { $_ }",
  "echo $PATH",
  "Get-ChildItem *.mjs",
  'Write-Output \'command node "$F"\'',
  "env MODE=-S powershell -Command 'Write-Output $env:MODE'",
  "env -- powershell -Command 'Write-Output -S $env:MODE'",
  "rg -n 'pwsh /EncodedCommand' docs",
  'rg -n \'node "$F"\' docs',
  'git commit -m "run node $SCRIPT later"',
  'echo node "$F"',
  "Write-Output pwsh /EncodedCommand",
  "command -v pwsh /EncodedCommand",
  "command -V pwsh /EncodedCommand",
  "Write-Output bash -c 'pwsh /EncodedCommand text'",
  "rg -n 'python -c' docs",
  "rg -n 'base64 -d | sh' docs",
  "env --help pwsh /EncodedCommand",
  "timeout --help pwsh /EncodedCommand",
  "timeout -s TERM --help pwsh /" + "Encoded" + "Command",
]) {
  eq(checkMaintenanceProducerInvocation(dataCommand), null, `quoted data stays outside the producer gate: ${dataCommand}`);
  ok(!checkDangerousCommand(dataCommand), `quoted data stays allowed: ${dataCommand}`);
}
// KNOWN OVER-BLOCK, pinned deliberately. A SHELL head makes the whole segment a
// command line to this rule, so a computed `node …` inside a quoted argument of
// `pwsh`/`bash` is refused even when that argument is not a -Command string. The
// old classifier parsed each shell's option grammar to tell the two apart; that
// grammar is what never converged under review. The refusal names the fix.
ok(checkDangerousCommand("pwsh -ExecutionPolicy Bypass 'Write-Output node $value'"), "computed node text inside a shell's quoted argument is refused (recorded over-block)");
ok(checkDangerousCommand("node --require ./preload.cjs scripts/ordinary-check.mjs"), "Node require preload is denied");
ok(checkDangerousCommand("NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs"), "NODE_OPTIONS preload is denied");
ok(checkDangerousCommand("FOO=1 NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs"), "prefixed NODE_OPTIONS preload is denied");
ok(checkDangerousCommand("Set-Item Env:NODE_OPTIONS $PRELOAD"), "PowerShell Set-Item NODE_OPTIONS mutation is denied");
ok(checkDangerousCommand("$env:NODE_OPTIONS = $PRELOAD"), "PowerShell env assignment to NODE_OPTIONS is denied");
ok(checkDangerousCommand("[Environment]::SetEnvironmentVariable('NODE_OPTIONS', $PRELOAD)"), ".NET NODE_OPTIONS mutation is denied");
ok(!checkDangerousCommand("rg -n 'NODE_OPTIONS=' docs"), "NODE_OPTIONS spelling used as quoted search data stays allowed");
ok(!checkDangerousCommand("rg -n 'Set-Item Env:NODE_OPTIONS' docs"), "PowerShell NODE_OPTIONS mutation spelling used as quoted search data stays allowed");
ok(!checkDangerousCommand("Write-Output '$env:NODE_OPTIONS = x'"), "NODE_OPTIONS assignment spelling inside quoted output stays allowed");

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
        "producer:computed": 'node "$PRODUCER" --verify',
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

    eq(extractNpmRunNames("npm run dangerous").length, 1, "extracts one npm run target");
    eq(extractNpmRunNames("npm run safe && npm run dangerous").length, 2, "extracts multiple npm run targets");

    const scripts = readPackageScripts(tmp);
    ok(scripts && typeof scripts === "object", "readPackageScripts reads the temp package.json");
    eq(resolveNpmScriptChain(scripts, "chain:a").length, 3, "resolves a 3-deep chain (a, b, c bodies)");

    ok(!checkCommandDeep("npm run safe", tmp), "npm run safe stays allowed");
    ok(checkCommandDeep("npm run dangerous", tmp), "npm run dangerous is caught via its resolved script body");
    ok(checkCommandDeep("npm run producer", tmp), "producer invocation hidden in an npm script is denied");
    ok(checkCommandDeep("npm run producer:computed", tmp), "computed-script launch hidden in an npm script is denied");
    ok(
      checkCommandDeep("npm run chain:a", tmp),
      "a dangerous command hidden 2 levels deep behind chained npm scripts is caught (FIX 2)"
    );
    // Depth cap is a real boundary: cap-a..cap-d (depths 0-3) are resolved, but
    // the dangerous command lives one hop further (cap-e, depth 4) and is
    // never fetched — documents the intentional bound, not an oversight.
    eq(resolveNpmScriptChain(scripts, "chain:cap-a").length, 4, "depth cap resolves exactly 4 bodies (depths 0-3)");
    ok(
      !checkCommandDeep("npm run chain:cap-a", tmp),
      "a dangerous command one hop past the depth-3 cap is NOT caught (documented bound)"
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
function runHook(payload) {
  return spawnSync(process.execPath, [path.join(__dirname, "bash-safety.mjs")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
}
let r = runHook({ tool_name: "Bash", tool_input: { command: "npm run build" } });
eq(r.status, 0, "bash-safety.mjs exits 0 on benign command");
ok(!r.stdout.includes('"permissionDecision":"deny"'), "bash-safety.mjs allows npm run build");

r = runHook({ tool_name: "Bash", tool_input: { command: "git push --force origin main" } });
eq(r.status, 0, "bash-safety.mjs exits 0 on dangerous command");
ok(r.stdout.includes('"permissionDecision":"deny"'), "bash-safety.mjs denies a force push");

r = runHook({
  tool_name: "PowerShell",
  tool_input: {
    command: "[IO.File]::WriteAllText('scripts/apply-live-testdata-maintenance-20260812.mjs','owned'); node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
  },
});
eq(r.status, 0, "bash-safety.mjs exits 0 after denying a chained producer rewrite");
ok(r.stdout.includes('"permissionDecision":"deny"'), "current shell guard denies the exact producer TOCTOU reproduction");

// The shapes that used to be refused with a misleading "maintenance producer"
// message pass the LIVE hook too, not only the library predicate.
for (const command of [
  'node -e "console.log(1)"',
  "bash -c 'ls'",
  "[ -f package.json ] && echo present",
  "printf a | xargs echo",
  "rg -n 'foo | node \"$F\"' docs",
  'TITLE=worker node --title="$TITLE" scripts/safe.mjs',
]) {
  r = runHook({ tool_name: "Bash", tool_input: { command } });
  eq(r.status, 0, `bash-safety exits 0 on: ${command}`);
  ok(!r.stdout.includes('"permissionDecision":"deny"'), `bash-safety.mjs allows the ordinary shape: ${command}`);
}
// …and the redirection-glued launch from the same review is refused by the LIVE hook.
r = runHook({ tool_name: "Bash", tool_input: { command: 'F=x; node</dev/null "$F"' } });
eq(r.status, 0, "bash-safety exits 0 after denying a redirection-glued computed launch");
ok(r.stdout.includes('"permissionDecision":"deny"'), "bash-safety.mjs denies node</dev/null \"$F\"");

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
    eq(checkCommandDeep("npm run fine", tmp), null, "npm script writing a NEW (non-existent) migration file is allowed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`bash-safety: ${pass} assertions passed`);
