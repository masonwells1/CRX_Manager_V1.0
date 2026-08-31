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
  maintenanceProducerCommandMentioned,
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

// `git clean` dry-run exemption (2026-08-31). The old flat cluster pattern
// denied `git clean -nd` — a dry run that deletes NOTHING — with a message
// telling the reader to run a dry run first. These pin both directions.
// Destructive spellings MUST stay blocked:
ok(checkDangerousCommand("git clean -f"), "git clean -f blocked");
ok(checkDangerousCommand("git clean -fdx"), "git clean -fdx blocked");
ok(checkDangerousCommand("git clean --force"), "git clean --force blocked");
ok(checkDangerousCommand("git clean -d"), "git clean -d without a dry run blocked");
ok(checkDangerousCommand("git clean -x"), "git clean -x without a dry run blocked");
ok(checkDangerousCommand("git -C /repo clean -fd"), "git clean -fd blocked through -C");
// Force wins over a dry-run flag in the same cluster — deliberately conservative
// rather than relying on git's -n/-f precedence inside a destructive guard.
ok(checkDangerousCommand("git clean -fn"), "git clean -fn blocked (force wins)");
ok(checkDangerousCommand("git clean --dry-run --force"), "git clean --dry-run --force blocked (force wins)");
// A dry run must NOT excuse a destructive sibling invocation (gpt-5.6-sol HIGH).
ok(checkDangerousCommand("git clean -n && git clean -fd"), "dry run does not excuse a later destructive git clean");
ok(checkDangerousCommand("git clean -nd; git clean -fdx"), "dry run does not excuse a destructive git clean after ';'");
// An operand after `--` is a pathspec, never a flag (gpt-5.6-sol HIGH).
ok(checkDangerousCommand("git clean -f -- -n"), "`-n` after `--` is a pathspec, not a dry-run flag");
ok(checkDangerousCommand("git clean -fd -- -n -d"), "pathspecs after `--` never exempt a destructive git clean");
// Attached `-e <pattern>` inside a cluster. Git parses `-fde*.tmp` as
// `-f -d -e '*.tmp'` — a real force-delete. An earlier version of this fix
// required the whole token to be letters, skipped these tokens entirely, and
// permitted them; the flat pattern it replaced had caught them, so that was a
// regression (gpt-5.6-sol exact-HEAD review, 2026-08-31, HIGH).
ok(checkDangerousCommand("git clean -fde*.tmp"), "clustered force with attached exclude pattern blocked");
ok(checkDangerousCommand("git clean -fefoo/bar"), "clustered force with attached exclude path blocked");
ok(checkDangerousCommand("git clean -fdx -e *.tmp"), "force with a separate exclude flag blocked");
ok(checkDangerousCommand("git clean -de*.tmp"), "cluster pruning with attached exclude and no dry run blocked");
// FAIL-CLOSED BY DESIGN: a dry run carrying an exclude is not in the allowlist
// grammar, so it keeps the original blocked behaviour. Over-blocking an exotic
// spelling is the intended cost of a carve-out that cannot open a bypass.
ok(checkDangerousCommand("git clean -nde*.tmp"), "dry run with attached exclude is outside the allowlist and stays blocked");
// An exclude-only invocation matches the base pattern's behaviour (unchanged
// here), but it is NOT inherently safe: `git clean` refuses without `-f`/`-n`
// only because of `clean.requireForce`, so overriding that setting on the
// command line deletes without ever naming `-f` (CodeRabbit, PR #527, Major).
eq(checkDangerousCommand("git clean -e *.tmp"), null, "exclude-only invocation keeps the base pattern's allow behaviour");
ok(checkDangerousCommand("git -c clean.requireForce=false clean -e *.tmp"), "requireForce override makes an exclude-only clean destructive");
ok(checkDangerousCommand("git -c clean.requireForce=false clean"), "requireForce override makes a bare clean destructive");
ok(checkDangerousCommand("git -c clean.requireForce = false clean -e *.tmp"), "spaced requireForce override is still detected");
ok(checkDangerousCommand("git -c CLEAN.REQUIREFORCE=FALSE clean"), "requireForce override is case-insensitive");
ok(checkDangerousCommand("git -c clean.requireForce=false clean -nd"), "override plus a dry run is outside the allowlist and stays blocked");
// Git's false booleans are false/no/off/0 AND an empty value — matching only the
// literal `false` let `=0` through (CodeRabbit, PR #527 follow-up, P1).
ok(checkDangerousCommand("git -c clean.requireForce=0 clean -e *.tmp"), "requireForce=0 is a false boolean and blocks");
ok(checkDangerousCommand("git -c clean.requireForce=no clean"), "requireForce=no blocks");
ok(checkDangerousCommand("git -c clean.requireForce=off clean"), "requireForce=off blocks");
ok(checkDangerousCommand("git -c clean.requireForce= clean"), "empty requireForce value is falsey and blocks");
ok(checkDangerousCommand("git -c CLEAN.REQUIREFORCE=OFF clean"), "false booleans are case-insensitive");
// A truthy value leaves requireForce in effect, so the clean still refuses on its
// own; it must not be treated as an override.
eq(checkDangerousCommand("git -c clean.requireForce=true clean -e *.tmp"), null, "requireForce=true is not an override");
// The override alternative must be anchored to a real `git ... clean`: an earlier
// draft denied read-only commands that merely contained the text (same review, P2).
eq(checkDangerousCommand('rg -n "clean.requireForce=false" .'), null, "searching for the config text is not a destructive clean");
eq(checkDangerousCommand("grep -rn clean.requireForce=false docs"), null, "grepping the config text is not a destructive clean");
eq(checkDangerousCommand("git config --get clean.requireForce"), null, "reading the config value is not a destructive clean");
eq(checkDangerousCommand("git -c clean.requireForce=false status"), null, "override without a clean subcommand is not a destructive clean");
// Git's OWN global options precede the subcommand and some consume the next
// token, so they must never be read as clean flags. In the first case below the
// `-n` is the directory argument to `-C`, not a dry run; in the second the `-n`
// is the exclude pattern for a standalone `-e`. An earlier version of this fix
// scanned every dash token in the segment, set dryRun from those, and permitted
// a destructive `clean -dx` (gpt-5.6-sol exact-HEAD review, 2026-08-31, HIGH).
ok(checkDangerousCommand("git -C -n -c clean.requireForce=false clean -dx"), "`-n` as a -C directory argument is not a dry run");
ok(checkDangerousCommand("git clean -e -n -dx"), "`-n` as a standalone -e pattern is not a dry run");
ok(checkDangerousCommand("git clean --exclude -n -dx"), "`-n` as a --exclude pattern is not a dry run");
ok(checkDangerousCommand("git -c core.pager=n clean -fd"), "global -c does not mask a destructive clean");
// Also fail-closed: only a bare `-C <path>` prefix is in the grammar. Other
// global options are not recognised, so the segment keeps the original blocked
// behaviour rather than being guessed at.
ok(checkDangerousCommand("git -C /repo -c core.pager=less clean -nd"), "unrecognised global options are outside the allowlist and stay blocked");
// Genuine dry runs MUST be allowed — this is the bug being fixed:
eq(checkDangerousCommand("git clean -nd"), null, "git clean -nd is a dry run and is allowed");
eq(checkDangerousCommand("git clean -n"), null, "git clean -n is allowed");
eq(checkDangerousCommand("git clean -ndx"), null, "git clean -ndx is a dry run and is allowed");
eq(checkDangerousCommand("git clean --dry-run"), null, "git clean --dry-run is allowed");
eq(checkDangerousCommand("git clean --dry-run -d"), null, "git clean --dry-run -d is allowed");
// Fail-closed: split dry-run spellings are outside the allowlist grammar.
ok(checkDangerousCommand("git clean -d -n"), "split `-d -n` spelling is outside the allowlist and stays blocked");
// The allowlist grammar has NO free-text slot. An earlier version permitted an
// optional `-C <path>` with `<path>` as any non-whitespace text, which was a
// fail-open: the shell processes a redirect or command substitution in that
// operand BEFORE git runs (gpt-5.6-sol exact-HEAD review, 2026-08-31, HIGH).
ok(checkDangerousCommand("git -C >src/App.tsx clean -nd"), "redirect in a -C operand truncates a file before git runs and stays blocked");
ok(checkDangerousCommand("git -C $(cat /tmp/x) clean -nd"), "command substitution in a -C operand stays blocked");
ok(checkDangerousCommand("git -C `cat /tmp/x` clean -nd"), "backtick substitution in a -C operand stays blocked");
ok(checkDangerousCommand("git -C /repo clean -nd"), "`-C` is outside the allowlist entirely; run the dry run from the directory itself");
// Fail-closed: anything trailing the option group leaves the grammar, including
// a harmless redirect. Over-blocking here is the intended cost of a slot-free
// allowlist — pipe the output of a plain `git clean -n` instead.
ok(checkDangerousCommand("git clean -nd > out.txt"), "trailing redirect leaves the allowlist and stays blocked");
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
const focusedProducerHarness = "node scripts/apply-live-testdata-maintenance-20260812.test.mjs";
ok(!maintenanceProducerCommandMentioned(focusedProducerHarness), "focused producer test harness is not classified as the protected producer");
eq(checkMaintenanceProducerInvocation(focusedProducerHarness), null, "focused producer test harness stays allowed by the shell guard");
ok(!checkDangerousCommand(focusedProducerHarness), "focused producer test harness stays runnable");
const nodeMentionAsData = "Select-String -Pattern 'node' | ForEach-Object { $_ }";
ok(!maintenanceProducerCommandMentioned(nodeMentionAsData), "Node mentioned as text is not classified as an invocation");
eq(checkMaintenanceProducerInvocation(nodeMentionAsData), null, "Node text search stays outside the producer gate");
ok(!checkDangerousCommand(nodeMentionAsData), "ordinary PowerShell Node text search stays allowed");
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
const decoderToShellAsData = "rg -n 'base64 -d | sh' docs";
ok(!maintenanceProducerCommandMentioned(decoderToShellAsData), "decoder-to-shell spelling used as quoted search data is not classified as an invocation");
eq(checkMaintenanceProducerInvocation(decoderToShellAsData), null, "decoder-to-shell search data stays outside the producer gate");
ok(!checkDangerousCommand(decoderToShellAsData), "ordinary decoder-to-shell text search stays allowed");
for (const terminalWrapperCommand of ["env --help pwsh /EncodedCommand", "timeout --help pwsh /EncodedCommand"]) {
  ok(!maintenanceProducerCommandMentioned(terminalWrapperCommand), `terminal wrapper mode is not classified as execution: ${terminalWrapperCommand}`);
  eq(checkMaintenanceProducerInvocation(terminalWrapperCommand), null, `terminal wrapper mode stays outside the producer gate: ${terminalWrapperCommand}`);
  ok(!checkDangerousCommand(terminalWrapperCommand), `terminal wrapper mode stays allowed: ${terminalWrapperCommand}`);
}
const terminalWrapperAfterOption = "timeout -s TERM --help pwsh /" + "Encoded" + "Command";
ok(!maintenanceProducerCommandMentioned(terminalWrapperAfterOption), "terminal wrapper mode after an option is not classified as execution");
eq(checkMaintenanceProducerInvocation(terminalWrapperAfterOption), null, "terminal wrapper mode after an option stays outside the producer gate");
ok(!checkDangerousCommand(terminalWrapperAfterOption), "terminal wrapper mode after an option stays allowed");
ok(checkDangerousCommand("node --require ./preload.cjs scripts/ordinary-check.mjs"), "Node require preload is denied");
ok(checkDangerousCommand("NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs"), "NODE_OPTIONS preload is denied");
ok(checkDangerousCommand("FOO=1 NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs"), "prefixed NODE_OPTIONS preload is denied");
ok(checkDangerousCommand("Set-Item Env:NODE_OPTIONS $PRELOAD"), "PowerShell Set-Item NODE_OPTIONS mutation is denied");
ok(checkDangerousCommand("$env:NODE_OPTIONS = $PRELOAD"), "PowerShell env assignment to NODE_OPTIONS is denied");
ok(checkDangerousCommand("[Environment]::SetEnvironmentVariable('NODE_OPTIONS', $PRELOAD)"), ".NET NODE_OPTIONS mutation is denied");
ok(!checkDangerousCommand("rg -n 'NODE_OPTIONS=' docs"), "NODE_OPTIONS spelling used as quoted search data stays allowed");
ok(!checkDangerousCommand("rg -n 'Set-Item Env:NODE_OPTIONS' docs"), "PowerShell NODE_OPTIONS mutation spelling used as quoted search data stays allowed");

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

    eq(extractNpmRunNames("npm run dangerous").length, 1, "extracts one npm run target");
    eq(extractNpmRunNames("npm run safe && npm run dangerous").length, 2, "extracts multiple npm run targets");

    const scripts = readPackageScripts(tmp);
    ok(scripts && typeof scripts === "object", "readPackageScripts reads the temp package.json");
    eq(resolveNpmScriptChain(scripts, "chain:a").length, 3, "resolves a 3-deep chain (a, b, c bodies)");

    ok(!checkCommandDeep("npm run safe", tmp), "npm run safe stays allowed");
    ok(checkCommandDeep("npm run dangerous", tmp), "npm run dangerous is caught via its resolved script body");
    ok(checkCommandDeep("npm run producer", tmp), "producer invocation hidden in an npm script is denied");
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
