#!/usr/bin/env node

import strictAssert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildMaintainedSource,
  buildProducerProtectionSources,
  exactHeadProofValid,
  maintenanceProducerCommandMentioned,
  maintenanceProducerInvocationAllowed,
  normalizeLineEndings,
  worktreeEntriesFromStatus,
} from "./apply-live-testdata-maintenance-20260812.mjs";

let assertionCount = 0;
const assert = new Proxy(strictAssert, {
  get(target, property, receiver) {
    const assertion = Reflect.get(target, property, receiver);
    if (typeof assertion !== "function") return assertion;
    return (...args) => {
      assertionCount += 1;
      return Reflect.apply(assertion, target, args);
    };
  },
});

assert.deepEqual(
  worktreeEntriesFromStatus("## codex/maintenance...origin/codex/maintenance\n"),
  [],
  "clean branch status has no worktree entries",
);
assert.deepEqual(
  worktreeEntriesFromStatus("## codex/maintenance\n M tracked.mjs\n?? untracked.txt\n"),
  [" M tracked.mjs", "?? untracked.txt"],
  "tracked and untracked changes are both dirty",
);
assert.deepEqual(
  worktreeEntriesFromStatus(" M tracked.mjs\r\n"),
  [" M tracked.mjs"],
  "status without a branch header remains dirty",
);
assert.equal(
  normalizeLineEndings("first\r\nsecond\r\n"),
  "first\nsecond\n",
  "working-tree CRLF bytes normalize before Git-blob hashing",
);

const scratch = mkdtempSync(path.join(tmpdir(), "crx-live-guard-candidate-test-"));
const producerProtection = buildProducerProtectionSources();
assert.match(
  producerProtection.outputs.codexGuard,
  /apply-live-testdata-maintenance-20260812/,
  "Codex guard output protects the one-use producer",
);
assert.match(
  producerProtection.outputs.pushLib,
  /scripts\\\/apply-live-testdata-maintenance-20260812/,
  "push gate output classifies the one-use producer as risky",
);
assert.match(
  producerProtection.outputs.codexGuard,
  /gateMaintenanceProducerExecution/,
  "Codex guard output binds producer execution to committed reviewed HEAD",
);
assert.equal(
  producerProtection.outputs.codexGuard.includes(`export ${normalizeLineEndings(maintenanceProducerCommandMentioned.toString())}`),
  true,
  "generated guard embeds the invocation matcher exercised below",
);
assert.equal(
  producerProtection.outputs.codexGuard.includes(`export ${normalizeLineEndings(maintenanceProducerInvocationAllowed.toString())}`),
  true,
  "generated guard embeds the strict invocation allowlist exercised below",
);
assert.match(
  producerProtection.outputs.codexGuard,
  /if \(!maintenanceProducerInvocationAllowed\(command\)\)/,
  "generated execution gate enforces the strict invocation allowlist",
);
const decodedPowerShellProcessLaunch = "Set-Item Env:NODE_OPTIONS ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('LS1yZXF1aXJlPS4vcHJlbG9hZC5janM='))); Set-Variable E ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('bm9kZQ=='))); Set-Variable A @(([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('c2NyaXB0cy9hcHBseS1saXZlLXRlc3RkYXRhLW1haW50ZW5hbmNlLTIwMjYwODEyLm1qcw=='))),([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('LS1hcHByb3ZlZC1ieS1tYXNvbj0yMDI2LTA4LTEy')))); Start-Process (Get-Variable E -ValueOnly) -ArgumentList (Get-Variable A -ValueOnly) -Wait -NoNewWindow";
const producerInvocations = [
  decodedPowerShellProcessLaunch,
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
  'node "scripts/apply-live-testdata-maintenance-20260812.mjs" --protect-producer',
  "node 'scripts/apply-live-testdata-maintenance-20260812.mjs' --protect-producer",
  "node scripts\\apply-live-testdata-maintenance-20260812.mjs --verify",
  "node scripts\\\\apply-live-testdata-maintenance-20260812.mjs --verify",
  "env FLAG=1 node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
  "cmd /c node scripts\\apply-live-testdata-maintenance-20260812.mjs --verify",
  'node "C:\\repo\\scripts\\apply-live-testdata-maintenance-20260812.mjs" --verify',
  'node scripts/apply-live-testdata-maintenance-20260812".mjs" --verify',
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
  "pwsh -Cus reviewpipe --" + "Encoded" + "Command ZW5jb2RlZA==",
  "exec -ca review pwsh --" + "Encoded" + "Command ZW5jb2RlZA==",
  "exec -la review pwsh --" + "Encoded" + "Command ZW5jb2RlZA==",
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
];
for (const command of producerInvocations) {
  assert.equal(maintenanceProducerCommandMentioned(command), true, `must recognize producer invocation: ${command}`);
}
assert.equal(
  maintenanceProducerCommandMentioned("node scripts/apply-some-other-maintenance.mjs --verify"),
  false,
  "unrelated maintenance command is not classified as this producer",
);
assert.equal(
  maintenanceProducerCommandMentioned("node scripts/apply-live-testdata-maintenance-20260812.test.mjs"),
  false,
  "focused producer test harness is not classified as the protected producer",
);
assert.equal(
  maintenanceProducerCommandMentioned("Select-String -Pattern 'node' | ForEach-Object { $_ }"),
  false,
  "Node mentioned as PowerShell data is not classified as an invocation",
);
const wrappedDynamicProducer = 'F=$(decode); P=$(decode); S=$(decode); T=$(decode); command node --no-warnings "$F" "$P" "$S" "$T"';
const wrappedDynamicProducers = [
  decodedPowerShellProcessLaunch,
  'python -c "import base64; exec(base64.b64decode(PAYLOAD))"',
  "printf %s ENCODED | base64 -d | sh",
  "printf %s ENCODED | base64 -d | xargs",
  "sh -- < encoded-command.txt",
  "pwsh -File C:\\Temp\\launch.ps1",
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
  "pwsh -Cus reviewpipe --" + "Encoded" + "Command ZW5jb2RlZA==",
  "exec -ca review pwsh --" + "Encoded" + "Command ZW5jb2RlZA==",
  "exec -la review pwsh --" + "Encoded" + "Command ZW5jb2RlZA==",
  wrappedDynamicProducer,
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
];
assert.equal(
  maintenanceProducerCommandMentioned('Write-Output \'command node "$F"\''),
  false,
  "wrapped Node spelling used as quoted data is not classified as an invocation",
);
const envSplitStringAsData = "env MODE=-S powershell -Command 'Write-Output $env:MODE'";
assert.equal(maintenanceProducerCommandMentioned(envSplitStringAsData), false, "env assignment value named -S is not parsed as a split-string option");
const envPostCommandSplitStringData = "env -- powershell -Command 'Write-Output -S $env:MODE'";
assert.equal(maintenanceProducerCommandMentioned(envPostCommandSplitStringData), false, "env scanner stops before child-command -S data");
const powershellOptionData = "pwsh -ExecutionPolicy Bypass 'Write-Output node $value'";
assert.equal(maintenanceProducerCommandMentioned(powershellOptionData), false, "PowerShell non-command options do not reinterpret later quoted data");
const encodedPowerShellAsData = "rg -n 'pwsh /EncodedCommand' docs";
assert.equal(maintenanceProducerCommandMentioned(encodedPowerShellAsData), false, "PowerShell encoded-command spelling used as quoted search data is not classified as an invocation");
const encodedPowerShellAsPlainData = "Write-Output pwsh /EncodedCommand";
assert.equal(maintenanceProducerCommandMentioned(encodedPowerShellAsPlainData), false, "PowerShell encoded-command spelling after a non-wrapper command is not classified as an invocation");
const encodedPowerShellAsScriptArgument = "pwsh -File script.ps1 /EncodedCommand";
assert.equal(maintenanceProducerCommandMentioned(encodedPowerShellAsScriptArgument), true, "PowerShell script-file launch is classified as opaque");
const powerShellLookupCommands = ["command -v pwsh /EncodedCommand", "command -V pwsh /EncodedCommand"];
for (const command of powerShellLookupCommands) {
  assert.equal(maintenanceProducerCommandMentioned(command), false, `PowerShell name lookup is not classified as an invocation: ${command}`);
}
const nestedShellAsData = "Write-Output bash -c 'pwsh /EncodedCommand text'";
assert.equal(maintenanceProducerCommandMentioned(nestedShellAsData), false, "nested shell spelling after a non-wrapper command is not classified as an invocation");
const inlineInterpreterAsData = "rg -n 'python -c' docs";
assert.equal(maintenanceProducerCommandMentioned(inlineInterpreterAsData), false, "inline interpreter spelling used as quoted search data is not classified as an invocation");
const decoderToShellAsData = "rg -n 'base64 -d | sh' docs";
assert.equal(maintenanceProducerCommandMentioned(decoderToShellAsData), false, "decoder-to-shell spelling used as quoted search data is not classified as an invocation");
const terminalWrapperCommands = ["env --help pwsh /EncodedCommand", "timeout --help pwsh /EncodedCommand"];
for (const command of terminalWrapperCommands) {
  assert.equal(maintenanceProducerCommandMentioned(command), false, `terminal wrapper mode is not classified as execution: ${command}`);
}
for (const command of [
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --approved-by-mason=2026-08-12",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --approved-by-mason=2026-08-12 --protect-producer",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --approved-by-mason=2026-08-12 --retire-producer",
]) {
  assert.equal(maintenanceProducerInvocationAllowed(command), true, `exact producer invocation accepted: ${command}`);
}
for (const command of [
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --verify; Write-Output chained",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --verify --unknown",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --protect-producer --approved-by-mason=2026-08-12",
  "node \"scripts/apply-live-testdata-maintenance-20260812.mjs\" --verify",
  "node scripts\\apply-live-testdata-maintenance-20260812.mjs --verify",
  "cmd /c node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
  "env FLAG=1 node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
  'python -c "import base64; exec(base64.b64decode(PAYLOAD))"',
  "printf %s ENCODED | base64 -d | sh",
  "sh -- < encoded-command.txt",
  wrappedDynamicProducer,
  "[IO.File]::WriteAllText('scripts/apply-live-testdata-maintenance-20260812.mjs','owned'); node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
]) {
  assert.equal(maintenanceProducerInvocationAllowed(command), false, `non-literal producer invocation rejected: ${command}`);
}
const terminalWrapperAfterOption = "timeout -s TERM --help pwsh /" + "Encoded" + "Command";
assert.equal(maintenanceProducerCommandMentioned(terminalWrapperAfterOption), false, "terminal wrapper mode after an option is not classified as execution");
const generatedMatcherStart = producerProtection.outputs.codexGuard.indexOf("export function maintenanceProducerCommandMentioned");
const generatedMatcherEnd = producerProtection.outputs.codexGuard.indexOf("\n\nexport function maintenanceProducerInvocationAllowed", generatedMatcherStart);
assert.notEqual(generatedMatcherStart, -1, "generated guard contains the producer matcher export");
assert.notEqual(generatedMatcherEnd, -1, "generated guard matcher has a stable export boundary");
const generatedMatcherModule = await import(`data:text/javascript;base64,${Buffer.from(
  producerProtection.outputs.codexGuard.slice(generatedMatcherStart, generatedMatcherEnd),
).toString("base64")}`);
for (const command of wrappedDynamicProducers) {
  assert.equal(generatedMatcherModule.maintenanceProducerCommandMentioned(command), true, `generated guard recognizes wrapped dynamic producer arguments: ${command}`);
}
assert.equal(generatedMatcherModule.maintenanceProducerCommandMentioned('Write-Output \'command node "$F"\''), false, "generated guard preserves quoted-data negative");
assert.equal(generatedMatcherModule.maintenanceProducerCommandMentioned(envSplitStringAsData), false, "generated guard preserves env assignment-value negative");
assert.equal(generatedMatcherModule.maintenanceProducerCommandMentioned(terminalWrapperAfterOption), false, "generated guard preserves terminal-wrapper-after-option negative");
assert.equal(generatedMatcherModule.maintenanceProducerCommandMentioned(envPostCommandSplitStringData), false, "generated guard preserves child-command -S data negative");
assert.equal(generatedMatcherModule.maintenanceProducerCommandMentioned(powershellOptionData), false, "generated guard preserves PowerShell option-data negative");
assert.equal(generatedMatcherModule.maintenanceProducerCommandMentioned(encodedPowerShellAsData), false, "generated guard preserves encoded-command quoted-data negative");
assert.equal(generatedMatcherModule.maintenanceProducerCommandMentioned(encodedPowerShellAsPlainData), false, "generated guard preserves encoded-command plain-data negative");
assert.equal(generatedMatcherModule.maintenanceProducerCommandMentioned(encodedPowerShellAsScriptArgument), true, "generated guard rejects opaque -File launch");
for (const command of powerShellLookupCommands) {
  assert.equal(generatedMatcherModule.maintenanceProducerCommandMentioned(command), false, `generated guard preserves PowerShell lookup negative: ${command}`);
}
assert.equal(generatedMatcherModule.maintenanceProducerCommandMentioned(nestedShellAsData), false, "generated guard preserves nested-shell data negative");
assert.equal(generatedMatcherModule.maintenanceProducerCommandMentioned(inlineInterpreterAsData), false, "generated guard preserves inline-interpreter quoted-data negative");
assert.equal(generatedMatcherModule.maintenanceProducerCommandMentioned(decoderToShellAsData), false, "generated guard preserves decoder-to-shell quoted-data negative");
for (const command of terminalWrapperCommands) {
  assert.equal(generatedMatcherModule.maintenanceProducerCommandMentioned(command), false, `generated guard preserves terminal-wrapper negative: ${command}`);
}
const proofNow = Date.parse("2026-08-13T05:30:00.000Z");
const exactProof = {
  codex_ran: true,
  verdict: "clean",
  model: "gpt-5.6-sol",
  reasoning_effort: "high",
  head_sha: "head",
  base_sha: "base",
  timestamp: "2026-08-13T05:29:00.000Z",
};
assert.equal(exactHeadProofValid(exactProof, "head", "base", proofNow), true, "fresh exact proof is accepted");
assert.equal(exactHeadProofValid(exactProof, "other", "base", proofNow), false, "wrong HEAD proof is rejected");
assert.equal(exactHeadProofValid(exactProof, "head", "other", proofNow), false, "wrong base proof is rejected");
assert.equal(exactHeadProofValid({ ...exactProof, timestamp: "2026-08-13T04:00:00.000Z" }, "head", "base", proofNow), false, "stale proof is rejected");
const producerAssertions = assertionCount;
process.stdout.write(`producer protection candidate blobs: ${JSON.stringify(producerProtection.blobs)}\n`);
for (const [name, source] of Object.entries(producerProtection.outputs)) {
  const sourcePath = path.join(scratch, `${name}.mjs`);
  writeFileSync(sourcePath, source, "utf8");
  execFileSync(process.execPath, ["--check", sourcePath], { stdio: ["ignore", "pipe", "pipe"] });
}

const { output, blob } = buildMaintainedSource();
assert.equal(blob, "0e947bc2a86cda1bdb4b2ad860b3aef5e023e264", "pinned generated blob");

try {
  const candidatePath = path.join(scratch, "candidate.mjs");
  writeFileSync(candidatePath, output, "utf8");
  const { classifySql } = await import(pathToFileURL(candidatePath).href);

  const blocked = [
    "ALTER TABLE public.profiles ADD COLUMN x text; -- RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'",
    "UPDATE customers SET phone = '555' WHERE id = 1 -- [E2E]",
    "SELECT '[E2E]'; UPDATE customers SET phone = '555' WHERE id = 1",
    "UPDATE customers SET notes = '[E2E] fixture' WHERE id = 1",
    "UPDATE customers SET phone = '555' WHERE name LIKE '[E2E]%' OR id = 1",
    "UPDATE profiles SET role = 'admin' WHERE id = '00000000-0000-0000-0000-000000000000'",
    "INSERT INTO some_log_table (x) VALUES (1)",
    "MERGE INTO invoices i USING source_rows s ON i.id=s.id WHEN MATCHED THEN UPDATE SET total_cents=1",
    "WITH source AS (SELECT '00000000-0000-0000-0000-000000000000'::uuid AS id) MERGE public.customers AS c USING source AS s ON c.id = s.id WHEN MATCHED THEN DELETE",
    "WITH changed AS (UPDATE ONLY public.customers SET phone = 'owned' WHERE id = 1 RETURNING id) SELECT count(*) FROM changed;",
    "WITH changed AS (DELETE FROM ONLY public.customers WHERE id = 1 RETURNING id) SELECT count(*) FROM changed;",
    "WITH incoming AS (SELECT 1 AS id) MERGE ONLY public.customers c USING incoming i ON c.id = i.id WHEN MATCHED THEN DELETE;",
    "SELECT * INTO public.guard_bypass FROM public.profiles",
    "COMMENT ON TABLE public.profiles IS 'raw change'",
    "SELECT preview_product_cost_basis_changes('00000000-0000-0000-0000-000000000000')",
    "DO $$ BEGIN UPDATE customers SET phone='owned' WHERE id=1; COMMIT; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;",
    "DO $$ BEGIN UPDATE customers SET phone='owned' WHERE id=1; ROLLBACK; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;",
    "DO $$ BEGIN IF false THEN RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END IF; UPDATE customers SET phone='owned' WHERE id=1; END $$;",
    "DO $$ BEGIN UPDATE customers SET phone='owned' WHERE id=1; BEGIN RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; EXCEPTION WHEN OTHERS THEN NULL; END; END $$;",
    "DO $$ BEGIN RETURN; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;",
    "UPDATE customers SET phone='owned' WHERE id=1 AND '[E2E]'='[E2E]'",
    "DELETE FROM customers WHERE id=1 AND '[E2E]'='[E2E]'",
    "VALUES (public.cancel_order('00000000-0000-0000-0000-000000000000'))",
    "VALUES (public.numeric(10,2))",
    "WITH source AS (SELECT 1 AS x) SELECT x INTO public.guard_bypass FROM source",
    "INSERT INTO customers (name) VALUES ('[E2E] Farm Alpha')",
    "UPDATE customers SET phone = '555' WHERE name LIKE '[E2E]%'",
    "DELETE FROM customers WHERE name ILIKE '[E2E]%'",
    "DELETE FROM customers WHERE NOT (name ILIKE '[E2E]%')",
    "INSERT INTO customers (name, notes) VALUES ('Real Customer', '[E2E] marker')",
    "WITH seed AS (INSERT INTO customers (name) VALUES ('[E2E] probe') RETURNING id) DELETE FROM customers WHERE id IS NOT NULL",
    "SELECT E'foo\\''; DROP TABLE public.customers",
    "SELECT E'foo\\''; TRUNCATE public.customers",
    "SELECT E'foo\\''; GRANT ALL ON public.customers TO anon",
    "SELECT E'foo\\''; INSERT INTO customers (name) VALUES ('owned')",
    "SELECT E'foo\\''; UPDATE customers SET phone='owned' WHERE id=1",
    "SELECT E'foo\\''; DELETE FROM customers WHERE id=1",
    "EXPLAIN ANALYZE SELECT public.cancel_order('00000000-0000-0000-0000-000000000000')",
    "CREATE TEMP TABLE scratch AS SELECT public.cancel_order('00000000-0000-0000-0000-000000000000')",
    "INSERT INTO pg_temp.scratch SELECT public.cancel_order('00000000-0000-0000-0000-000000000000')",
    "DO $$ BEGIN PERFORM nextval('invoice_number_seq'); RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;",
    "DO $$ BEGIN PERFORM setval('invoice_number_seq', 1); RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;",
    "BEGIN; DO $$ BEGIN PERFORM nextval('invoice_number_seq'); RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$; ROLLBACK;",
    "BEGIN; DO $$ BEGIN PERFORM setval('invoice_number_seq', 1); RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$; ROLLBACK;",
    "SELECT 1 -- comment\r; UPDATE customers SET phone='owned' WHERE id=1",
    "SELECT 1 -- comment\r; DELETE FROM customers WHERE id=1",
    "SELECT 1 -- comment\r; DROP TABLE public.customers",
    "SELECT 1 -- comment\r; GRANT ALL ON public.customers TO anon",
    "SELECT 1 -- comment\r; SELECT public.cancel_order('00000000-0000-0000-0000-000000000000')",
    "WITH a AS (SELECT E'foo\\'$x$'), b AS (DELETE FROM customers RETURNING id), c AS (SELECT '$x$') SELECT 1;",
    "BEGIN; ALTER TABLE public.customers DISABLE ROW LEVEL SECURITY; END; BEGIN; ROLLBACK;",
    "BEGIN; ROLLBACK; ALTER TABLE public.customers DISABLE ROW LEVEL SECURITY; BEGIN; ROLLBACK;",
    "SELECT 1 AS open$x$; ALTER TABLE public.customers DISABLE ROW LEVEL SECURITY; SELECT 1 AS close$x$;",
    "SELECT 1 AS open$x$; TRUNCATE public.customers; SELECT 1 AS close$x$;",
    "SELECT 1 /* x */ -- comment\r; ALTER TABLE public.customers DISABLE ROW LEVEL SECURITY;",
    "SELECT 1 /* x */ -- comment\r; DELETE FROM customers WHERE id=1;",
    "BEGIN; CREATE FUNCTION pg_temp.get_pwn() RETURNS bigint LANGUAGE sql AS $$ SELECT setval('invoice_number_seq', 1) $$; SELECT pg_temp.get_pwn(); ROLLBACK;",
    "SELECT 1 AS é$x$; DELETE FROM public.customers WHERE id = 1; SELECT 1 AS é$x$;",
    "CREATE TEMP VIEW customer_passthrough AS SELECT * FROM public.customers; UPDATE pg_temp.customer_passthrough SET phone = 'owned' WHERE id = 1;",
    "CREATE TEMP TABLE customer_passthrough AS SELECT 1; DROP TABLE pg_temp.customer_passthrough; CREATE TEMP VIEW customer_passthrough AS SELECT * FROM public.customers; UPDATE pg_temp.customer_passthrough SET phone = 'owned' WHERE id = 1;",
    "UPDATE pg_temp.some_log_table SET x = 1 WHERE id = 1",
    "BEGIN; COPY public.customers TO PROGRAM 'example-command'; ROLLBACK;",
    "BEGIN; COPY public.customers TO '/tmp/customer-export.csv'; ROLLBACK;",
    "BEGIN; VACUUM public.customers; ROLLBACK;",
    "CREATE TEMP TABLE get_scratch (LIKE public.invoices INCLUDING DEFAULTS); INSERT INTO pg_temp.get_scratch (customer_id, created_by) SELECT gen_random_uuid(), gen_random_uuid() FROM generate_series(1, 1000000);",
    "CREATE TEMP TABLE scratch_columns (id int, x int); UPDATE pg_temp.scratch_columns SET x = 1 WHERE id = 1;",
    "SELECT pg_catalog.U&\"\\006c\\006f\\005f\\0063\\0072\\0065\\0061\\0074\\0065\"(0)",
    "SELECT public.U&\"\\0063\\0061\\006e\\0063\\0065\\006c\\005f\\006f\\0072\\0064\\0065\\0072\"('00000000-0000-0000-0000-000000000000')",
    "BEGIN; CREATE VIEW pg_temp.guard_probe AS SELECT customer_id, created_by FROM public.invoices; CREATE TEMP TABLE IF NOT EXISTS guard_probe AS SELECT 1; INSERT INTO pg_temp.guard_probe SELECT c.id, p.id FROM public.customers c CROSS JOIN public.profiles p LIMIT 1; ROLLBACK;",
    "EXPLAIN ANALYZE CREATE TABLE public.guard_bypass AS SELECT * FROM public.customers;",
    "EXPLAIN ANALYZE CREATE MATERIALIZED VIEW public.guard_bypass AS SELECT * FROM public.customers;",
    "EXPLAIN (ANALYZE TRUE, BUFFERS TRUE) CREATE TABLE public.guard_bypass AS SELECT * FROM public.customers;",
    "EXPLAIN (ANALYZE TRUE) EXECUTE prepared_mutator('00000000-0000-0000-0000-000000000000');",
    "BEGIN; CREATE TABLE public.guard_probe (id int DEFAULT public.cancel_order()); ROLLBACK;",
    "BEGIN; CREATE INDEX guard_probe_idx ON public.customers (public.cancel_order(id)); ROLLBACK;",
    "SELECT $é$' $é$; DROP TABLE public.customers",
    "BEGIN; SET LOCAL standard_conforming_strings = off; SELECT 'a\\''; DROP TABLE public.customers; SELECT 'x\\''; ROLLBACK;",
  ];
  for (const sql of blocked) {
    assert.equal(classifySql(sql).block, true, `must block: ${sql}`);
  }

  const allowed = [
    "SELECT * FROM customers WHERE id = 1",
    "VALUES (1::numeric(10,2))",
    "CREATE TEMP TABLE some_log_table AS SELECT 1 AS id, 0 AS x; UPDATE pg_temp.some_log_table SET x = 1 WHERE id = 1",
    "CREATE TEMP TABLE scratch AS SELECT 1",
    "CREATE TEMP TABLE scratch_columns (id int, x int)",
    "BEGIN; ALTER TABLE invoices ADD COLUMN x text; ROLLBACK;",
    "BEGIN; CREATE TABLE public.guard_probe (id int); ROLLBACK;",
    "BEGIN; CREATE INDEX guard_probe_idx ON public.customers (id); ROLLBACK;",
    "BEGIN; SET LOCAL statement_timeout = '1s'; SELECT 1; ROLLBACK;",
    "CREATE TEMP TABLE scratch_copy AS TABLE public.invoices",
  ];
  for (const sql of allowed) {
    const result = classifySql(sql);
    assert.equal(result.block, false, `must allow: ${sql}; got ${JSON.stringify(result)}`);
  }

  process.stdout.write(
    `live-testdata maintenance candidate: ${blocked.length + allowed.length} classifier assertions + ${producerAssertions} producer assertions passed\n`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
