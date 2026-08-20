#!/usr/bin/env node
// Tests for mcp-tool-guard.mjs (FIX 1, 2026-07-13 audit — "Desktop Commander
// blind spot"). Spawns the real hook with crafted stdin payloads, the same
// pattern guards.test.mjs / autopilot-lib.test.mjs use for their LIVE checks.
// Run: node .claude/hooks/mcp-tool-guard.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SECURITY_COMMAND_CHAR_BUDGET } from "./bash-safety-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }
function eq(a, b, m) { assert.equal(a, b, m); pass++; }

function runHook(payload, cwd) {
  return spawnSync(process.execPath, [path.join(__dirname, "mcp-tool-guard.mjs")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd || process.env.CLAUDE_PROJECT_DIR },
  });
}
function isDeny(r) { return r.stdout.includes('"permissionDecision":"deny"'); }

const oversizedWrapperCommand = `echo ${"watch ".repeat(30_000)}; ${["git", "push", "--force", "origin", "main"].join(" ")}`;
const oversizedStartedAt = process.hrtime.bigint();
const oversizedResult = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: oversizedWrapperCommand } });
const oversizedElapsedMs = Number(process.hrtime.bigint() - oversizedStartedAt) / 1_000_000;
ok(isDeny(oversizedResult), "DC start_process denies an oversized wrapper payload");
ok(oversizedResult.status === 0, "mcp-tool-guard.mjs exits 0 after an oversized wrapper payload");
ok(oversizedElapsedMs < 1_500, `DC oversized wrapper denial stays well below the 5s hook timeout (actual ${oversizedElapsedMs.toFixed(0)}ms)`);

const findCommand = ["fi", "nd"].join("");
const findExecOption = ["-ex", "ec"].join("");
const findGroupOpen = "\x5c(";
const findGroupClose = "\x5c)";
const findTerminator = "\x5c;";
const pythonCommand = ["py", "thon"].join("");
const xargsCommand = ["xar", "gs"].join("");
const noRunIfEmptyOption = ["--no-run", "-if-empty"].join("");
const awkCommand = ["aw", "k"].join("");
const opaqueAwkProgram = `'BEGIN { cmd = decode(); ${["sys", "tem"].join("")}(cmd) }'`;
const timeCommand = ["ti", "me"].join("");
const hostileRunnerTail = ["git", "push", "--force", "origin", "main"].join(" ");
const hostileRunnerUnit = `${findCommand} . ${findExecOption} ${awkCommand} --help `;
const hostileRunnerCommand = `${hostileRunnerUnit.repeat(Math.floor((SECURITY_COMMAND_CHAR_BUDGET - hostileRunnerTail.length) / hostileRunnerUnit.length))}${hostileRunnerTail}`;
ok(hostileRunnerCommand.length <= SECURITY_COMMAND_CHAR_BUDGET, "DC hostile runner fixture stays within the character budget");
const hostileRunnerStartedAt = process.hrtime.bigint();
const hostileRunnerResult = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: hostileRunnerCommand } });
const hostileRunnerElapsedMs = Number(process.hrtime.bigint() - hostileRunnerStartedAt) / 1_000_000;
ok(isDeny(hostileRunnerResult), "DC start_process denies an at-budget hostile runner payload");
ok(hostileRunnerElapsedMs < 1_500, `DC at-budget hostile runner denial stays well below the 5s hook timeout (actual ${hostileRunnerElapsedMs.toFixed(0)}ms)`);
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
const dynamicNodeOptionsGuardCases = [
  "env $(printf NODE_OPTIONS=--require=./preload.cjs) npm --version",
  'N=NODE; env "${N}_OPTIONS=--require=./preload.cjs" npm --version',
  'powershell -Command "Set-Item (\'Env:NO\' + \'DE_OPTIONS\') \'--require=./preload.cjs\'; npm --version"',
  'cmd /v:on /c "set N=NODE_OPTIONS & set !N!=--require=./preload.cjs & npm --version"',
  'cmd /v:on /c "set N=NODE_OPTIONS & set !N!=--require=./preload.cjs & n^pm --version"',
  'N=NODE_OPTIONS; env "${N}=--require=./preload.cjs" n\\pm --version',
  'cmd /v:on /c "set N=NODE_OPTIONS & set !N!=--require=./preload.cjs & ya^rn --version"',
  'cmd /v:on /c "set N=NODE_OPTIONS & set !N!=--require=./preload.cjs & b^un --version"',
  'pwsh -NoProfile -co "si Env:NODE_OPTIONS --require=./preload.cjs; n\\pm --version"',
];

// ── tools NOT in the Desktop Commander mutating set pass straight through ──
let r = runHook({ tool_name: "Read", tool_input: { file_path: "src/App.tsx" } });
eq(r.status, 0, "unrelated tool exits 0");
eq(r.stdout.trim(), "", "unrelated tool is silent (passthrough)");

r = runHook({ tool_name: "mcp__Desktop_Commander__list_directory", tool_input: { path: "." } });
eq(r.stdout.trim(), "", "non-mutating DC tool (list_directory) is silent (not matched)");

// ── start_process / interact_with_process: dangerous command denied ───────
r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: "git push --force origin main" } });
ok(isDeny(r), "DC start_process with a force-push command is denied");

const persistentShellPid = 321;
r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: "pwsh" } });
eq(r.stdout.trim(), "", "starting an interactive PowerShell shell remains allowed");
r = runHook({ tool_name: "mcp__Desktop_Commander__interact_with_process", tool_input: { pid: persistentShellPid, input: "" } });
ok(isDeny(r), "even an empty interaction is denied while the protected producer exists");
for (const fragment of [
  "set NO^",
  "DE_OPTIONS=--require=./preload.cjs",
  "node scripts/apply-live-testdata-^",
  "maintenance-20260812.mjs --approved-by-^",
  "mason=2026-08-12",
]) {
  r = runHook({ tool_name: "mcp__Desktop_Commander__interact_with_process", tool_input: { pid: persistentShellPid, input: fragment } });
  ok(isDeny(r), `a persistent shell cannot receive a cross-call continuation fragment: ${fragment}`);
}
r = runHook({ tool_name: "mcp__Desktop_Commander__interact_with_process", tool_input: { pid: persistentShellPid, input: "si Env:NODE_OPTIONS '--require=./preload.cjs'" } });
ok(isDeny(r), "a persistent PowerShell interaction cannot stage NODE_OPTIONS through si");
r = runHook({ tool_name: "mcp__Desktop_Commander__interact_with_process", tool_input: { pid: persistentShellPid, input: "Set-Alias mutate Set-Item" } });
ok(isDeny(r), "a persistent PowerShell interaction cannot stage a mutation alias");
r = runHook({ tool_name: "mcp__Desktop_Commander__interact_with_process", tool_input: { pid: persistentShellPid, input: "mutate Env:NODE_OPTIONS '--require=./preload.cjs'" } });
ok(isDeny(r), "a pre-existing PowerShell alias cannot target Env:NODE_OPTIONS");
r = runHook({ tool_name: "mcp__Desktop_Commander__interact_with_process", tool_input: { pid: persistentShellPid, input: `Set-Item "Env:$('NODE_OPTIONS')" '--require=./preload.cjs'` } });
ok(isDeny(r), "a persistent PowerShell interaction cannot construct NODE_OPTIONS through a subexpression");
r = runHook({ tool_name: "mcp__Desktop_Commander__interact_with_process", tool_input: { pid: persistentShellPid, input: "$target = 'NODE_OPTIONS'" } });
ok(isDeny(r), "a persistent-shell variable cannot stage the NODE_OPTIONS target for a later interaction");
r = runHook({ tool_name: "mcp__Desktop_Commander__interact_with_process", tool_input: { pid: persistentShellPid, input: `Set-Item "Env:$target" '--require=./preload.cjs'` } });
ok(isDeny(r), "a later persistent interaction cannot use variable indirection for an environment-provider mutation");
r = runHook({ tool_name: "mcp__Desktop_Commander__interact_with_process", tool_input: { pid: persistentShellPid, input: "Set-Item Env:SAFE '--require=./preload.cjs'" } });
ok(isDeny(r), "all non-empty persistent-shell input is denied while the protected producer exists");
const providerTransferCommand = `${["Co", "py-Item"].join("")} Env:SAFE 'Env:NODE_OPTIONS'`;
r = runHook({ tool_name: "mcp__Desktop_Commander__interact_with_process", tool_input: { pid: persistentShellPid, input: providerTransferCommand } });
ok(isDeny(r), "a later persistent interaction cannot transfer a provider item into quoted Env:NODE_OPTIONS");
r = runHook({ tool_name: "mcp__Desktop_Commander__interact_with_process", tool_input: { pid: persistentShellPid, input: "node --version" } });
ok(isDeny(r), "even benign commands must use a fresh process while the protected producer exists");
const approvedProducerCommand = [
  "node", ["scripts/apply-live-testdata-maintenance-", "20260812.mjs"].join(""),
  ["--approved-by-", "mason=2026-08-12"].join(""),
].join(" ");
r = runHook({ tool_name: "mcp__Desktop_Commander__interact_with_process", tool_input: { pid: persistentShellPid, input: approvedProducerCommand } });
ok(isDeny(r), "the protected producer cannot run inside a persistent interactive process");
r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: approvedProducerCommand } });
ok(!isDeny(r), "the exact approved producer command remains allowed in a fresh process");

r = runHook({ tool_name: "mcp__Desktop_Commander__interact_with_process", tool_input: { pid: 123, input: "rm -rf src\n" } });
ok(isDeny(r), "DC interact_with_process feeding rm -rf src is denied");

r = runHook({
  tool_name: "mcp__Desktop_Commander__start_process",
  tool_input: {
    command: "[IO.File]::WriteAllText('scripts/apply-live-testdata-maintenance-20260812.mjs','owned'); node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
  },
});
ok(isDeny(r), "DC start_process cannot route around the exact producer invocation gate");

r = runHook({
  tool_name: "mcp__Desktop_Commander__start_process",
  tool_input: { command: "command env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs" },
});
ok(isDeny(r), "DC start_process cannot preload Node through command/env wrappers");

r = runHook({
  tool_name: "mcp__Desktop_Commander__start_process",
  tool_input: { command: "awk 'BEGIN { cmd = decode(); system(cmd) }'" },
});
ok(isDeny(r), "DC start_process cannot launch an opaque AWK program while the producer exists");

r = runHook({
  tool_name: "mcp__Desktop_Commander__start_process",
  tool_input: { command: "wsl -d docker-desktop -- awk 'BEGIN { cmd = decode(); system(cmd) }'" },
});
ok(isDeny(r), "DC start_process cannot launch an opaque AWK program through WSL");

for (const command of [
  "Start-Process awk -ArgumentList '-f payload.awk' -Wait",
  "Start-Process env -ArgumentList 'NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs' -Wait",
  "saps awk -ArgumentList '-f payload.awk' -Wait",
  "start env -ArgumentList 'NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs' -Wait",
]) {
  r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command } });
  ok(isDeny(r), `DC start_process cannot use a PowerShell process launcher: ${command}`);
}

r = runHook({
  tool_name: "mcp__Desktop_Commander__start_process",
  tool_input: { command: "SAFE= command -- env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs" },
});
ok(isDeny(r), "DC start_process cannot preload Node through empty assignments and command terminators");

for (const command of [
  "echo safe\nNODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
  "echo safe\r\nNODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
  "export SAFE=1 NODE_OPTIONS=--require=./preload.cjs; node scripts/ordinary-check.mjs",
  'cmd /d /c "echo safe & set NODE_OPTIONS=--require=./preload.cjs & node scripts/ordinary-check.mjs"',
  'powershell -NoProfile -Command "cmd /c \'set NODE_OPTIONS=--require=./preload.cjs & node scripts/ordinary-check.mjs\'"',
  'bash -c "NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs"',
  "nohup env NODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
  "env -SNODE_OPTIONS=--require=./preload.cjs node scripts/ordinary-check.mjs",
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
  ...xargsGuardCases,
  ...shellBuiltinNodeOptionsCases,
  ...dynamicNodeOptionsGuardCases,
  ...nestedParserGuardCases,
  ...indirectRunnerGuardCases,
]) {
  r = runHook({
    tool_name: "mcp__Desktop_Commander__start_process",
    tool_input: { command },
  });
  ok(isDeny(r), `DC start_process denies boundary-safe NODE_OPTIONS preload: ${JSON.stringify(command)}`);
}

// ── start_process: benign command allowed (silent) ─────────────────────────
r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: "npm run build" } });
eq(r.status, 0, "DC start_process benign command exits 0");
eq(r.stdout.trim(), "", "DC start_process with npm run build is silent (allowed)");

// ── write_file / edit_block / move_file: protected paths denied ────────────
r = runHook({ tool_name: "mcp__Desktop_Commander__write_file", tool_input: { path: ".env" } });
ok(isDeny(r), "DC write_file targeting .env is denied");

r = runHook({ tool_name: "mcp__Desktop_Commander__write_file", tool_input: { path: ".claude/settings.json" } });
ok(isDeny(r), "DC write_file targeting .claude/settings.json is denied");

r = runHook({ tool_name: "mcp__Desktop_Commander__edit_block", tool_input: { path: ".claude/hooks/bash-safety.mjs" } });
ok(isDeny(r), "DC edit_block targeting a hook file is denied");

r = runHook({ tool_name: "mcp__Desktop_Commander__move_file", tool_input: { destination: ".env.production" } });
ok(isDeny(r), "DC move_file targeting .env.production is denied");

// ── write_file to an ordinary source file: allowed (silent) ────────────────
r = runHook({ tool_name: "mcp__Desktop_Commander__write_file", tool_input: { path: "src/pages/Foo.tsx" } });
eq(r.status, 0, "DC write_file to an ordinary file exits 0");
eq(r.stdout.trim(), "", "DC write_file to an ordinary source file is silent (allowed)");

// ── migration files: ALL MCP writes denied, new or existing (Codex P1 R5) ──
// The SQL/RLS/enum/generated-column/idempotency content guards are wired to
// the native Write/Edit matchers only — an MCP write CREATING a migration
// would skip every one of them, so the guard denies the whole directory.
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "mcp-tool-guard-migtest-"));
  try {
    const migDir = path.join(tmp, "supabase", "migrations");
    mkdirSync(migDir, { recursive: true });
    writeFileSync(path.join(migDir, "20260101000000_existing.sql"), "select 1;");

    r = runHook(
      { tool_name: "mcp__Desktop_Commander__write_file", tool_input: { path: "supabase/migrations/20260101000000_existing.sql" } },
      tmp
    );
    ok(isDeny(r), "DC write_file to an EXISTING migration file is denied");

    r = runHook(
      { tool_name: "mcp__Desktop_Commander__write_file", tool_input: { path: "supabase/migrations/20260102000000_new.sql" } },
      tmp
    );
    ok(isDeny(r), "DC write_file to a NEW migration file is ALSO denied — content guards only run on the native Write path");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── kill_process / set_config_value: matched by the tool-name regex but no
//    specific check implemented (documented judgment call) — pass through.
r = runHook({ tool_name: "mcp__Desktop_Commander__kill_process", tool_input: { pid: 123 } });
eq(r.stdout.trim(), "", "kill_process has no path/command check, passes through silently");

// ── fail-open on malformed stdin ────────────────────────────────────────────
r = spawnSync(process.execPath, [path.join(__dirname, "mcp-tool-guard.mjs")], { input: "not json", encoding: "utf8" });
eq(r.status, 0, "malformed stdin still exits 0 (fail-open)");
eq(r.stdout.trim(), "", "malformed stdin produces no block");

// ── Codex P1 2026-07-13: move_file must check the SOURCE path, not just the
//    destination — moving a protected migration AWAY must be denied ──────────
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "mcpguard-move-"));
  try {
    mkdirSync(path.join(tmp, "supabase", "migrations"), { recursive: true });
    writeFileSync(path.join(tmp, "supabase", "migrations", "20260101000000_applied.sql"), "select 1;\n");

    r = runHook(
      {
        tool_name: "mcp__Desktop_Commander__move_file",
        tool_input: { source: "supabase/migrations/20260101000000_applied.sql", destination: "archive/gone.sql" },
      },
      tmp
    );
    ok(isDeny(r), "DC move_file with a protected SOURCE (existing migration) is denied");

    r = runHook(
      {
        tool_name: "mcp__Desktop_Commander__move_file",
        tool_input: { source: "docs/a.md", destination: "docs/b.md" },
      },
      tmp
    );
    eq(r.stdout.trim(), "", "DC move_file between unprotected paths is allowed (silent)");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Codex P1 2026-07-13 round 2: OTHER MCP servers' same-named tools must be
//    guarded too (settings.json allow-lists mcp__filesystem__write_file) ──────
r = runHook({ tool_name: "mcp__filesystem__write_file", tool_input: { path: ".env" } });
ok(isDeny(r), "filesystem-server write_file to .env is denied (server-agnostic matcher)");
r = runHook({ tool_name: "mcp__filesystem__edit_file", tool_input: { path: ".claude/settings.json" } });
ok(isDeny(r), "filesystem-server edit_file to settings.json is denied");
r = runHook({ tool_name: "mcp__filesystem__write_file", tool_input: { path: "docs/notes.md" } });
eq(r.stdout.trim(), "", "filesystem-server write_file to an unprotected path is allowed (silent)");

// ── Codex P2 2026-07-13 round 2: path traversal must not evade the patterns ──
r = runHook({ tool_name: "mcp__Desktop_Commander__write_file", tool_input: { path: ".claude/sub/../settings.json" } });
ok(isDeny(r), "traversal form .claude/sub/../settings.json is denied (resolved-path check)");
r = runHook({ tool_name: "mcp__Desktop_Commander__write_file", tool_input: { path: "docs/../.env" } });
ok(isDeny(r), "traversal form docs/../.env is denied");

// ── Codex P1 round 3: whole-DIRECTORY moves of protected trees are denied ────
r = runHook({ tool_name: "mcp__filesystem__move_file", tool_input: { source: "supabase/migrations", destination: "old-migrations" } });
ok(isDeny(r), "moving the supabase/migrations DIRECTORY is denied");
r = runHook({ tool_name: "mcp__Desktop_Commander__move_file", tool_input: { source: ".claude", destination: "claude-backup" } });
ok(isDeny(r), "moving the .claude DIRECTORY is denied");
r = runHook({ tool_name: "mcp__Desktop_Commander__move_file", tool_input: { source: "supabase", destination: "supabase-old" } });
ok(isDeny(r), "moving the supabase DIRECTORY (parent of migrations) is denied");
r = runHook({ tool_name: "mcp__Desktop_Commander__move_file", tool_input: { source: "docs", destination: "docs-old" } });
eq(r.stdout.trim(), "", "moving an unprotected directory is allowed (silent)");

console.log(`mcp-tool-guard: ${pass} assertions passed`);
