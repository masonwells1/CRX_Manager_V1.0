#!/usr/bin/env node
// Tests for mcp-tool-guard.mjs (FIX 1, 2026-07-13 audit — "Desktop Commander
// blind spot"). Spawns the real hook with crafted stdin payloads, the same
// pattern guards.test.mjs / autopilot-lib.test.mjs use for their LIVE checks.
// Run: node .claude/hooks/mcp-tool-guard.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmodSync, existsSync, linkSync, mkdtempSync, writeFileSync, mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkCommandDeep, fixedTrustedGitExecutable, SECURITY_COMMAND_CHAR_BUDGET } from "./bash-safety-lib.mjs";

// npm injects its own config paths into child test processes. Clear all
// runtime-startup controls so fixtures begin from the production hook's safe
// baseline; dedicated cases below add hostile values back explicitly.
for (const name of Object.keys(process.env)) {
  if (/^(?:NODE_OPTIONS|NPM_CONFIG_(?:USERCONFIG|GLOBALCONFIG|NODE_OPTIONS|SCRIPT_SHELL)|PYTHON(?:PATH|HOME|STARTUP|USERBASE|INSPECT))$/i.test(name)) delete process.env[name];
  if (/^GIT_(?:CONFIG(?:_.+)?|DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|REPLACE_REF_BASE|COMMON_DIR|NAMESPACE|EXEC_PATH|EXTERNAL_DIFF|DIFF_OPTS)$/i.test(name)) delete process.env[name];
}

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
function isAsk(r) { return r.stdout.includes('"permissionDecision":"ask"'); }

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
eq(hostileRunnerResult.status, 0, "mcp-tool-guard exits 0 after denying an at-budget hostile runner payload");
ok(isDeny(hostileRunnerResult), "DC start_process denies an at-budget hostile runner payload");
ok(hostileRunnerElapsedMs < 1_500, `DC at-budget hostile runner denial stays well below the 5s hook timeout (actual ${hostileRunnerElapsedMs.toFixed(0)}ms)`);
const hostileGlobCommand = `${String.fromCharCode(99, 112)} ${"*".repeat(4_000)}never scratch; ${hostileRunnerTail}`;
const hostileGlobStartedAt = process.hrtime.bigint();
const hostileGlobResult = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: hostileGlobCommand } });
const hostileGlobElapsedMs = Number(process.hrtime.bigint() - hostileGlobStartedAt) / 1_000_000;
eq(hostileGlobResult.status, 0, "mcp-tool-guard exits 0 after denying a hostile nonmatching glob");
ok(isDeny(hostileGlobResult), "DC start_process reaches the blocked tail after a hostile nonmatching glob");
ok(hostileGlobElapsedMs < 1_500, `DC hostile glob denial stays well below the 15s hook timeout (actual ${hostileGlobElapsedMs.toFixed(0)}ms)`);
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
const gitEnvItemWriter = String.fromCharCode(83, 101, 116, 45, 73, 116, 101, 109);
const gitEnvApiWriter = String.fromCharCode(83, 101, 116, 69, 110, 118, 105, 114, 111, 110, 109, 101, 110, 116, 86, 97, 114, 105, 97, 98, 108, 101);
for (const command of [
  "GIT_CONFIG_COUNT=1 git status",
  "$env:GIT_CONFIG_COUNT = 1; git status",
  "set GIT_CONFIG_COUNT=1 && git status",
  `${gitEnvItemWriter} Env:GIT_CONFIG_COUNT 1; git status`,
  `[Environment]::${gitEnvApiWriter}('GIT_CONFIG_COUNT', '1'); git status`,
]) {
  const result = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command } });
  eq(result.status, 0, `mcp-tool-guard exits 0 after Git control environment injection: ${command}`);
  ok(isDeny(result), `MCP start_process denies Git control environment injection: ${command}`);
}
for (const command of [
  ["git -c diff.", "external=node output/ignored-wrapper.mjs diff HEAD HEAD"].join(""),
  ["git -cdiff.", "external=node diff HEAD HEAD"].join(""),
  ["git config diff.", "external 'node output/ignored-wrapper.mjs'"].join(""),
  "git -c 'difftool.untrusted.cmd=node output/ignored-wrapper.mjs' difftool HEAD HEAD",
  "git config mergetool.untrusted.cmd 'node output/ignored-wrapper.mjs'",
]) {
  const result = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command } });
  eq(result.status, 0, `mcp-tool-guard exits 0 after Git executable configuration injection: ${command}`);
  ok(isDeny(result), `MCP start_process denies Git executable configuration injection: ${command}`);
}
for (const command of [
  "git difftool --no-prompt HEAD HEAD",
  "git mergetool --no-prompt",
  "git --exec-path=output/git-shim status --short",
  "git --exec-path output/git-shim status --short",
]) {
  const result = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command } });
  eq(result.status, 0, `mcp-tool-guard exits 0 after Git helper/exec-path dispatch: ${command}`);
  ok(isDeny(result), `MCP start_process denies Git helper/exec-path dispatch: ${command}`);
}
const reviewBootstrap = ["scripts", ["write", "codex", "push", "proof.mjs"].join("-")].join("/");
for (const command of [
  ["node --test --test-reporter=output/ignored-wrapper.mjs", reviewBootstrap].join(" "),
  ["node --env-file=output/ignored.env", reviewBootstrap].join(" "),
  ["node --snapshot-blob=output/ignored.blob", reviewBootstrap].join(" "),
  ["node --build-snapshot-config=output/ignored.json", reviewBootstrap].join(" "),
]) {
  const result = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command } });
  eq(result.status, 0, `mcp-tool-guard exits 0 after an option-bearing review bootstrap: ${command}`);
  ok(isDeny(result), `MCP start_process denies an option-bearing review bootstrap: ${command}`);
}
for (const command of [
  "node --test --test-reporter=output/ignored-wrapper.mjs .claude/hooks/bash-safety.test.mjs",
  "node --env-file=output/ignored.env .claude/hooks/bash-safety.test.mjs",
  "node --snapshot-blob=output/ignored.blob .claude/hooks/bash-safety.test.mjs",
  "node --experimental-sea-config=output/ignored.json .claude/hooks/bash-safety.test.mjs",
  "node --conditions=ignored .claude/hooks/bash-safety.test.mjs",
  "node --future-code-loader=output/ignored-wrapper.mjs .claude/hooks/bash-safety.test.mjs",
]) {
  const result = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command } });
  eq(result.status, 0, `mcp-tool-guard exits 0 after a code-loading or unknown Node startup option: ${command}`);
  ok(isDeny(result), `MCP start_process denies a code-loading or unknown Node startup option: ${command}`);
}
for (const command of [
  "npm --userconfig=output/evil.npmrc run agent-health",
  "NPM_CONFIG_USERCONFIG=output/evil.npmrc npm run agent-health",
  "$env:NPM_CONFIG_USERCONFIG='output/evil.npmrc'; npm run agent-health",
  "PYTHONPATH=output python scripts/backup-via-rest.py",
  "python scripts/backup-via-rest.py",
  "env HOME=output/alternate-home npm --version",
  "command env USERPROFILE=output/alternate-home npm --version",
  "XDG_CONFIG_HOME=output/alternate-home npm --version",
  "$env:HOME='output/alternate-home'; npm --version",
  "set USERPROFILE=output/alternate-home && npm --version",
  ["npm ", "install"].join(""),
  ["npm ", "i"].join(""),
  "npm ci",
  "npm rebuild",
  "npm restart",
]) {
  const result = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command } });
  eq(result.status, 0, `mcp-tool-guard exits 0 after runtime startup injection: ${command}`);
  ok(isDeny(result), `MCP start_process denies runtime startup injection: ${command}`);
}
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
  `Set-Alias mutate ([string]::Concat("Set-","Item")); mutate ([string]::Concat("Env:NO","DE_OPTIONS")) "--require=./preload.cjs"; npm --version`,
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
const producerWriterWord = (codes) => String.fromCharCode(...codes);
const producerContentWriterCases = [
  [producerWriterWord([115, 101, 116, 45, 99, 111, 110, 116, 101, 110, 116]), "scripts/*.mjs", "payload"].join(" "),
  [producerWriterWord([99, 108, 101, 97, 114, 45, 99, 111, 110, 116, 101, 110, 116]), "scripts/*.mjs"].join(" "),
  [producerWriterWord([97, 100, 100, 45, 99, 111, 110, 116, 101, 110, 116]), "scripts/*.mjs", "payload"].join(" "),
  [producerWriterWord([115, 101, 100]), "-i", "s/x/y/", "scripts/*.mjs"].join(" "),
  [producerWriterWord([116, 114, 117, 110, 99, 97, 116, 101]), "-s", "0", "scripts/*.mjs"].join(" "),
  ["Write-Output", "payload", ">", "scripts/*.mjs"].join(" "),
];
const powerShellComputedMutationGuardCases = [
  `Set-Item ("Env:NODE-XOPTIONS".Replace("-X","_")) ("--requXire=./preload.cjs".Replace("X","")); npm --version`,
  `Set-Content ("Env:NODE_OPTIONS".ToLower()) ("--require=./preload.cjs"); npm --version`,
  `pwsh -NoProfile -Command "Set-Item ('Env:NODE-XOPTIONS'.Replace('-X','_')) ('--requXire=./preload.cjs'.Replace('X','')); npm --version"`,
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
for (const command of powerShellLineBoundaryDenyCases) {
  r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command } });
  eq(r.status, 0, `mcp-tool-guard exits 0 after denying a PowerShell boundary bypass: ${JSON.stringify(command)}`);
  ok(isDeny(r), `DC start_process denies a PowerShell boundary bypass: ${JSON.stringify(command)}`);
}
for (const command of powerShellLineBoundaryAskCases) {
  r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command } });
  eq(r.status, 0, `mcp-tool-guard exits 0 after gating a PowerShell boundary deploy: ${JSON.stringify(command)}`);
  ok(isAsk(r), `DC start_process asks for a PowerShell boundary deploy: ${JSON.stringify(command)}`);
}
for (const command of producerContentWriterCases) {
  r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command } });
  eq(r.status, 0, `mcp-tool-guard exits 0 after inspecting a producer content writer: ${JSON.stringify(command)}`);
  ok(isDeny(r), `DC start_process denies a wildcard producer content writer: ${JSON.stringify(command)}`);
}
for (const command of [
  "Set-Alias ll Get-ChildItem",
  "echo Set-Alias",
  "rg -n Set-Alias docs",
  "Set-Alias -Name ll -Value Get-ChildItem",
  "New-Alias ll Get-ChildItem",
]) {
  r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command } });
  eq(r.status, 0, `mcp-tool-guard exits 0 for a harmless alias command: ${command}`);
  eq(r.stdout.trim(), "", `mcp-tool-guard allows a harmless alias command: ${command}`);
}

const persistentShellPid = 321;
r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: "pwsh" } });
eq(r.stdout.trim(), "", "starting an interactive PowerShell shell remains allowed");
r = runHook({ tool_name: "mcp__Desktop_Commander__interact_with_process", tool_input: { pid: persistentShellPid, input: "" } });
ok(isDeny(r), "even an empty interaction is denied while the protected producer exists");
const producerAbsentCwd = path.join(os.tmpdir(), `mcp-tool-guard-no-producer-${process.pid}`);
r = runHook(
  { tool_name: "mcp__Desktop_Commander__interact_with_process", tool_input: { pid: persistentShellPid, input: "Write-Output safe" } },
  producerAbsentCwd
);
eq(r.status, 0, "mcp-tool-guard.mjs exits 0 when the protected producer is absent");
ok(isDeny(r), "the retirement latch keeps persistent-process input denied even when the producer is absent from the current checkout");
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
{
  const integrityRepo = mkdtempSync(path.join(os.tmpdir(), "mcp-producer-integrity-"));
  try {
    const integrityRelativePath = ["scripts/apply-live-testdata-maintenance-", "20260812.mjs"].join("");
    const integrityPath = path.join(integrityRepo, ...integrityRelativePath.split("/"));
    const integrityGitEnv = { ...process.env };
    for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete integrityGitEnv[name];
    mkdirSync(path.dirname(integrityPath), { recursive: true });
    writeFileSync(integrityPath, "export const reviewed = true;\n");
    for (const args of [
      ["init", "--quiet"],
      ["config", "user.email", "guard-test@example.invalid"],
      ["config", "user.name", "Guard Test"],
      ["add", "--", integrityRelativePath],
      ["commit", "--quiet", "-m", "test fixture"],
      ["update-ref", "refs/remotes/origin/main", "HEAD"],
    ]) {
      const result = spawnSync("git", args, { cwd: integrityRepo, encoding: "utf8", windowsHide: true, env: integrityGitEnv });
      eq(result.status, 0, `MCP producer integrity fixture command succeeds: git ${args[0]}`);
    }
    const authoritativeResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: integrityRepo, encoding: "utf8", windowsHide: true, env: integrityGitEnv });
    eq(authoritativeResult.status, 0, "MCP producer fixture authoritative main SHA resolves");
    const reviewOptions = { authoritativeMainShaForTest: authoritativeResult.stdout.trim() };
    const integrityCommand = ["node", integrityRelativePath, "--verify"].join(" ");
    eq(checkCommandDeep(integrityCommand, integrityRepo, reviewOptions), null, "direct injection proves an exact reviewed executor is allowed without weakening the production hook");
    r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: integrityCommand } }, integrityRepo);
    eq(r.status, 0, "mcp-tool-guard exits 0 after refusing a temp repository without GitHub provenance");
    ok(isDeny(r), "the production MCP hook does not accept a test-only authoritative SHA");
    writeFileSync(integrityPath, "export const reviewed = false;\n");
    ok(checkCommandDeep(integrityCommand, integrityRepo, reviewOptions), "direct injection still denies worktree bytes that differ from exact HEAD");
    r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: integrityCommand } }, integrityRepo);
    eq(r.status, 0, "mcp-tool-guard exits 0 after denying a modified-worktree executor");
    ok(isDeny(r), "MCP exact producer launch is denied when worktree bytes differ from exact HEAD");
  } finally {
    rmSync(integrityRepo, { recursive: true, force: true });
  }
}

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
  "npm_config_node_options=--require=./preload.cjs npm run ordinary",
  "env NPM_CONFIG_NODE_OPTIONS=--require=./preload.cjs npm run ordinary",
  "Set-Item Env:NPM_CONFIG_NODE_OPTIONS --require=./preload.cjs; npm run ordinary",
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
  ...posixLineContinuationGuardCases,
  ...powerShellComputedMutationGuardCases,
  ...nestedParserGuardCases,
  ...indirectRunnerGuardCases,
  'nodejs "--import=data:text/javascript;base64,ZXhwb3J0IHt9" scripts/ordinary-check.mjs',
]) {
  r = runHook({
    tool_name: "mcp__Desktop_Commander__start_process",
    tool_input: { command },
  });
  ok(isDeny(r), `DC start_process denies boundary-safe NODE_OPTIONS preload: ${JSON.stringify(command)}`);
}

// ── start_process: benign command allowed (silent) ─────────────────────────
r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: "git status --short" } });
eq(r.status, 0, "DC start_process benign command exits 0");
eq(r.stdout.trim(), "", "DC start_process with a benign Git status read is silent (allowed)");
r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: ["n", "px vite"].join("") } });
eq(r.status, 0, "DC opaque package resolver denial exits 0");
ok(isDeny(r), "DC denies an opaque package resolver");
r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: ["vite --con", "fig output/ignored-config.mjs"].join("") } });
eq(r.status, 0, "DC untracked explicit package configuration denial exits 0");
ok(isDeny(r), "DC denies an untracked explicit package configuration file");
r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: "rg -n pattern scripts > out.txt" } });
eq(r.status, 0, "DC redirected read-only scripts search exits 0");
eq(r.stdout.trim(), "", "DC redirected read-only scripts search is silent (allowed)");
for (const command of ["rg -n npx docs", "git log --grep npm --grep exec", "echo vite"]) {
  r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command } });
  eq(r.status, 0, "DC read-only package-name argument exits 0: " + command);
  ok(!isDeny(r), "DC treats package-tool names in read-only arguments as data: " + command);
}
const reviewBootstrapRelative = ["scripts", ["write", "codex", "push", "proof.mjs"].join("-")].join("/");
for (const command of [
  "cd output && node " + reviewBootstrapRelative,
  "Set-Location output; node " + reviewBootstrapRelative,
  "Push-Location output; node " + reviewBootstrapRelative,
  "env --chdir=output node " + reviewBootstrapRelative,
  "sudo --chdir=output node " + reviewBootstrapRelative,
  "wsl --cd output node " + reviewBootstrapRelative,
  "pwsh -WorkingDirectory output -File " + reviewBootstrapRelative,
  "Start-Process node -WorkingDirectory output -ArgumentList " + reviewBootstrapRelative,
  ["fi", "nd"].join("") + " output " + ["-ex", "ecdir"].join("") + " node " + reviewBootstrapRelative + " {} ;",
  "parallel --workdir output node " + reviewBootstrapRelative + " ::: one",
  "npm --prefix output run build",
]) {
  r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command } });
  eq(r.status, 0, "DC shifted-executor denial exits 0: " + command);
  ok(isDeny(r), "DC denies an executor whose effective working directory differs from the verified root: " + command);
}
r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: "cd output && git status --short" } });
eq(r.status, 0, "DC directory-shifted Git read exits 0");
ok(!isDeny(r), "DC allows a directory change followed only by a Git read");
for (const target of [
  ["scripts/apply-live-testdata-maintenance-", "20260812.mjs"].join(""),
  ["scripts/apply-live-testdata-maintenance-", "2026081[2].mjs"].join(""),
]) {
  r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: "printf evil >| " + target } });
  eq(r.status, 0, "DC protected clobber redirect denial exits 0: " + target);
  ok(isDeny(r), "DC denies a clobber redirect targeting the protected executor: " + target);
}

// ── write_file / edit_block / move_file: protected paths denied ────────────
r = runHook({ tool_name: "mcp__Desktop_Commander__write_file", tool_input: { path: ".env" } });
ok(isDeny(r), "DC write_file targeting .env is denied");

r = runHook({ tool_name: "mcp__Desktop_Commander__write_file", tool_input: { path: ".claude/settings.json" } });
ok(isDeny(r), "DC write_file targeting .claude/settings.json is denied");

r = runHook({ tool_name: "mcp__Desktop_Commander__edit_block", tool_input: { path: ".claude/hooks/bash-safety.mjs" } });
ok(isDeny(r), "DC edit_block targeting a hook file is denied");

// ── PARITY WITH THE NATIVE ROUTE (exact-review Highs, PR #432) ─────────────
// The native Write/Edit guard learned two rules this route never received: the
// wrapper-owned review state directory, and the `.git` POINTER of a linked
// worktree. Claude can write files BOTH ways, so a rule enforced on only one of
// them is not enforced at all — an MCP write could mint trusted review JSON and
// self-certify a risky change, or repoint the checkout at an attacker-chosen
// gitdir. Both routes now call the SAME functions in protected-identity-lib
// rather than keeping two copies of the patterns that drifted apart.
r = runHook({ tool_name: "mcp__Desktop_Commander__write_file", tool_input: { path: ".claude/session-state/codex-review-deadbeef.json", content: "{}" } });
ok(isDeny(r), "DC write_file creating a review proof is denied");

r = runHook({ tool_name: "mcp__Desktop_Commander__move_file", tool_input: { source: "notes.json", destination: ".claude/session-state/codex-review-deadbeef.json" } });
ok(isDeny(r), "DC move_file whose DESTINATION lands in the review state directory is denied");

// The ack valve is the one designed agent-writable file there; denying it would
// break session close-out, and the native route deliberately allows it.
r = runHook({ tool_name: "mcp__Desktop_Commander__write_file", tool_input: { path: ".claude/session-state/stop-wrap-ack.json", content: "{}" } });
eq(r.stdout.trim(), "", "DC write_file to the stop-wrap ack valve stays allowed");

r = runHook({ tool_name: "mcp__Desktop_Commander__write_file", tool_input: { path: ".git", content: "gitdir: C:/attacker-controlled/.git" } });
ok(isDeny(r), "DC write_file targeting the linked-worktree .git pointer is denied");

{
  const projectRoot = path.resolve(__dirname, "..", "..");
  const pointerAliasDir = mkdtempSync(path.join(os.tmpdir(), "crx-mcp-git-pointer-"));
  const pointerAlias = path.join(pointerAliasDir, "ordinary-checkout-note.txt");
  let pointerLinked = false;
  try {
    linkSync(path.join(projectRoot, ".git"), pointerAlias);
    pointerLinked = true;
  } catch {
    // An ordinary checkout has a .git directory; restricted/cross-volume
    // environments may also reject the link.
  }
  if (pointerLinked) {
    r = runHook({ tool_name: "mcp__Desktop_Commander__write_file", tool_input: { path: pointerAlias, content: "gitdir: C:/attacker-controlled/.git" } }, projectRoot);
    ok(isDeny(r), "MCP write_file denies a hard-link alias of the linked-worktree .git pointer");
    r = runHook({ tool_name: "mcp__Desktop_Commander__edit_block", tool_input: { path: pointerAlias, old_string: "gitdir:", new_string: "owned:" } }, projectRoot);
    ok(isDeny(r), "MCP edit_block denies a hard-link alias of the linked-worktree .git pointer");
  }
  rmSync(pointerAliasDir, { recursive: true, force: true });
}

// A JUNCTION launders the destination out of the supplied pathname: nothing in
// the string spells `session-state`, and identity cannot help because the proof
// file does not exist yet. Canonicalising through the existing ancestor is what
// exposes it — the exact scenario the exact-review probe demonstrated.
{
  const junctionParent = mkdtempSync(path.join(os.tmpdir(), "crx-mcp-junction-"));
  const junction = path.join(junctionParent, "notes");
  const stateDir = path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), ".claude", "session-state");
  let junctionMade = false;
  try {
    symlinkSync(stateDir, junction, "junction");
    junctionMade = true;
  } catch {
    // Environments without junction/symlink permission cannot present this
    // route at all, so there is nothing to assert there.
  }
  if (junctionMade) {
    r = runHook({ tool_name: "mcp__Desktop_Commander__write_file", tool_input: { path: path.join(junction, "codex-review-deadbeef.json"), content: "{}" } });
    ok(isDeny(r), "DC write_file into the review state directory THROUGH A JUNCTION is denied");
  }
  rmSync(junctionParent, { recursive: true, force: true });
}

// A hard link is a second directory entry for the SAME file data, so its
// pathname is innocuous and `realpath` cannot see through it — writing to the
// alias edits the protected hook. Identity (device + inode/file-ID) is what a
// hard link cannot disguise (Codex CRX-SEC-01, 2026-08-23).
{
  const aliasDir = mkdtempSync(path.join(os.tmpdir(), "crx-hardlink-guard-"));
  const protectedHook = path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), ".claude", "hooks", "bash-safety-lib.mjs");
  const aliasPath = path.join(aliasDir, "innocuous-notes.mjs");
  const unrelatedPath = path.join(aliasDir, "unrelated.mjs");
  writeFileSync(unrelatedPath, "// ordinary scratch file\n");
  let linked = false;
  try {
    linkSync(protectedHook, aliasPath);
    linked = true;
  } catch {
    // Cross-volume or permission-restricted environments cannot create the
    // alias at all; the exploit this covers is impossible there.
  }
  if (linked) {
    r = runHook({ tool_name: "mcp__Desktop_Commander__write_file", tool_input: { path: aliasPath } });
    ok(isDeny(r), "DC write_file through a hard-link alias of a protected hook is denied by file identity");
    r = runHook({ tool_name: "mcp__Desktop_Commander__edit_block", tool_input: { path: aliasPath } });
    ok(isDeny(r), "DC edit_block through a hard-link alias of a protected hook is denied by file identity");
  }
  // The identity check must not turn every temporary file into a protected one.
  r = runHook({ tool_name: "mcp__Desktop_Commander__write_file", tool_input: { path: unrelatedPath } });
  eq(r.stdout.trim(), "", "an ordinary unlinked scratch file remains writable (identity check does not over-block)");

  // The full attack through the MCP PROCESS route, not just the file route:
  // create the alias with a computed item type so the literal token never
  // appears, then write through it. Both steps must deny here, because
  // start_process runs the same shell text the Bash matcher would have seen and
  // this route was the one that could otherwise smuggle it in (Codex, 2026-08-24).
  const computedItemType = 'New-Item -ItemType ("Hard"+"Link") -Path scratch/notes.mjs -Target .claude/hooks/bash-safety-lib.mjs';
  r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: computedItemType } });
  ok(isDeny(r), "MCP start_process denies a computed-item-type hard link");
  r = runHook({ tool_name: "mcp__Desktop_Commander__interact_with_process", tool_input: { input: computedItemType } });
  ok(isDeny(r), "MCP interact_with_process denies a computed-item-type hard link fed as process input");
  // Nested one level down: a shell wrapper must not launder the computed form.
  r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: `powershell -Command "${computedItemType}"` } });
  ok(isDeny(r), "a PowerShell command-mode wrapper cannot launder the computed item type");
  r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: `cmd /c ${computedItemType}` } });
  ok(isDeny(r), "a cmd /c wrapper cannot launder the computed item type");
  // The variable form has no literal to match at all.
  r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: "New-Item -ItemType $t -Path a -Target .claude/hooks/bash-safety-lib.mjs" } });
  ok(isDeny(r), "MCP start_process denies a variable item type");
  r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: "New-Item -ItemType Junction -Path scratch/review -Target .claude/session-state" } });
  ok(isDeny(r), "MCP start_process denies a junction into the wrapper-owned proof directory");
  r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: "fsutil $operation create scratch/review/$proof scratch/seed.json" } });
  ok(isDeny(r), "MCP start_process denies the final proof hard-link write when its operation and basename are variables");
  // Ordinary directory creation through the same route stays available.
  r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: "New-Item -ItemType Directory -Path scratch/output" } });
  eq(r.stdout.trim(), "", "MCP start_process still allows ordinary directory creation");
  // The follow-up write is the step that actually changes the protected file, so
  // it must deny on its own even if an alias were created by some other means.
  if (linked) {
    r = runHook({ tool_name: "mcp__Desktop_Commander__write_file", tool_input: { path: aliasPath, content: "HOSTILE" } });
    ok(isDeny(r), "the follow-up write through the alias is denied independently of how the alias was created");
  }
  rmSync(aliasDir, { recursive: true, force: true });
}

r = runHook({ tool_name: "mcp__Desktop_Commander__move_file", tool_input: { destination: ".env.production" } });
ok(isDeny(r), "DC move_file targeting .env.production is denied");

const directoryToolName = (codes) => `mcp__Desktop_Commander__${String.fromCharCode(...codes)}`;
const protectedScriptsDirectoryCases = [
  { tool_name: directoryToolName([109, 111, 118, 101, 95, 100, 105, 114, 101, 99, 116, 111, 114, 121]), tool_input: { source: "scripts", destination: "scratch/scripts" } },
  { tool_name: directoryToolName([100, 101, 108, 101, 116, 101, 95, 100, 105, 114, 101, 99, 116, 111, 114, 121]), tool_input: { path: "scripts" } },
  { tool_name: directoryToolName([99, 111, 112, 121, 95, 100, 105, 114, 101, 99, 116, 111, 114, 121]), tool_input: { source: "scripts", destination: "scratch/scripts" } },
];
for (const payload of protectedScriptsDirectoryCases) {
  r = runHook(payload);
  ok(isDeny(r), `an MCP whole-scripts-directory mutation is denied: ${payload.tool_name}`);
}

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

// ── process signals are denied while producer protection is latched ────────
r = runHook({ tool_name: "mcp__Desktop_Commander__kill_process", tool_input: { pid: 123 } });
ok(isDeny(r), "kill_process cannot trigger a persistent-shell signal trap while the producer is tracked");
for (const signalTool of ["send_signal", "signal_process", "terminate_process", "stop_process"]) {
  r = runHook({ tool_name: `mcp__Desktop_Commander__${signalTool}`, tool_input: { pid: 123, signal: "SIGINT" } });
  ok(isDeny(r), `${signalTool} cannot trigger a persistent-shell signal trap while the producer is tracked`);
}

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

// ── exact stateful bypass regression: HEAD tracking survives relocation ────
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "mcpguard-producer-head-"));
  const externalExecutorDir = mkdtempSync(path.join(os.tmpdir(), "mcpguard-external-executor-"));
  const producerRelative = ["scripts/apply-live-testdata-maintenance-", "20260812.mjs"].join("");
  const bootstrapRelative = ["scripts", ["write", "codex", "push", "proof.mjs"].join("-")].join("/");
  const alternateRelative = "scripts/ignored-maintenance-copy.mjs";
  const trackedWrapperRelative = "scripts/reviewed-wrapper.mjs";
  const importingWrapperRelative = "scripts/importing-wrapper.mjs";
  const importedHelperRelative = "scripts/imported-helper.mjs";
  const childRunnerRelative = "scripts/reviewed-child-runner.mjs";
  const builtinEscapeRelative = "scripts/reviewed-builtin-escape.mjs";
  const commentLoaderRelative = "scripts/reviewed-comment-loader.mjs";
  const trackedDirectRelative = "scripts/reviewed-direct.bat";
  const reviewedWrapperSource = "console.log('reviewed wrapper');\n";
  const wrapperSource = [
    'import { spawnSync } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    'writeFileSync("output/wrapper-executed.txt", "executed");',
    `spawnSync(process.execPath, [${JSON.stringify(producerRelative)}, "--approved-by-mason=2026-08-12"], { env: { ...process.env, NODE_OPTIONS: "--require=output/preload.cjs" } });`,
    "",
  ].join("\n");
  try {
    mkdirSync(path.join(tmp, "scripts"), { recursive: true });
    writeFileSync(path.join(tmp, producerRelative), "console.log('tracked producer');\n");
    writeFileSync(path.join(tmp, bootstrapRelative), "console.log('review bootstrap');\n");
    writeFileSync(path.join(tmp, trackedWrapperRelative), reviewedWrapperSource);
    writeFileSync(path.join(tmp, importingWrapperRelative), 'import "./imported-helper.mjs";\nconsole.log("reviewed importer");\n');
    writeFileSync(path.join(tmp, importedHelperRelative), 'export const reviewed = true;\n');
    writeFileSync(path.join(tmp, childRunnerRelative), 'import { spawnSync } from "node:child_process";\nspawnSync("npx", ["vitest", "run"]);\n');
    writeFileSync(path.join(tmp, builtinEscapeRelative), 'process.getBuiltinModule("node:child_process");\n');
    writeFileSync(path.join(tmp, commentLoaderRelative), 'import /* loader gap */ ("../output/ignored-wrapper.mjs");\n');
    writeFileSync(path.join(tmp, trackedDirectRelative), "@echo reviewed direct wrapper\n");
    writeFileSync(path.join(tmp, ".gitignore"), "output/\n");
    const isolatedGitEnv = { ...process.env };
    for (const variableName of [
      "GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_PREFIX",
      "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ]) delete isolatedGitEnv[variableName];
    let localRefMoveArgs = null;
    for (const args of [
      ["init"],
      ["config", "user.email", "guard-test@example.invalid"],
      ["config", "user.name", "Guard Test"],
      ["config", "commit.gpgsign", "false"],
      ["add", producerRelative, bootstrapRelative, trackedWrapperRelative, importingWrapperRelative, importedHelperRelative, childRunnerRelative, builtinEscapeRelative, commentLoaderRelative, trackedDirectRelative, ".gitignore"],
      ["commit", "-m", "track producer"],
      ["update-ref", "refs/remotes/origin/main", "HEAD"],
    ]) {
      if (args.length === 3 && String(args[1]).includes("refs/remotes")) localRefMoveArgs = args;
      const gitResult = spawnSync("git", args, { cwd: tmp, encoding: "utf8", env: isolatedGitEnv, windowsHide: true });
      eq(gitResult.status, 0, `temporary producer repository setup succeeds: git ${args[0]}`);
    }
    const authoritativeResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8", env: isolatedGitEnv, windowsHide: true });
    eq(authoritativeResult.status, 0, "MCP wrapper fixture authoritative main SHA resolves");
    const reviewOptions = { authoritativeMainShaForTest: authoritativeResult.stdout.trim() };
    eq(spawnSync("git", ["config", "filter.review.process", "output/ignored-filter"], { cwd: tmp, encoding: "utf8", env: isolatedGitEnv, windowsHide: true }).status, 0, "MCP hostile Git process filter installs");
    const filterReason = checkCommandDeep(["node", bootstrapRelative].join(" "), tmp, reviewOptions);
    ok(filterReason, `direct injection denies executable Git filters before bootstrap worktree verification (actual: ${filterReason})`);
    r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: ["node", bootstrapRelative].join(" ") } }, tmp);
    ok(isDeny(r), "MCP start_process denies executable Git filters before bootstrap worktree verification");
    eq(spawnSync("git", ["config", "--unset-all", "filter.review.process"], { cwd: tmp, encoding: "utf8", env: isolatedGitEnv, windowsHide: true }).status, 0, "MCP hostile Git process filter removes");
    const hostileGlobalGitHome = path.join(tmp, "output", "hostile-global-git-home");
    const hostileGlobalAttributes = path.join(hostileGlobalGitHome, "attributes");
    const hostileGlobalFilterMarker = path.join(hostileGlobalGitHome, "filter-ran.txt");
    const hostileGlobalFilter = path.join(hostileGlobalGitHome, process.platform === "win32" ? "filter.cmd" : "filter.sh");
    mkdirSync(hostileGlobalGitHome, { recursive: true });
    writeFileSync(hostileGlobalAttributes, "* filter=review\n");
    writeFileSync(hostileGlobalFilter, process.platform === "win32"
      ? `@echo hostile>"${hostileGlobalFilterMarker}"\r\n@exit /b 1\r\n`
      : `#!/bin/sh\nprintf hostile > '${hostileGlobalFilterMarker.replaceAll("'", "'\\''")}'\nexit 1\n`);
    if (process.platform !== "win32") chmodSync(hostileGlobalFilter, 0o755);
    writeFileSync(path.join(hostileGlobalGitHome, ".gitconfig"), [
      "[core]",
      `\tattributesfile = ${hostileGlobalAttributes.replaceAll("\\", "/")}`,
      '[filter "review"]',
      `\tprocess = ${hostileGlobalFilter.replaceAll("\\", "/")}`,
      "",
    ].join("\n"));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const originalBootstrapPath = process.env.PATH;
    process.env.HOME = hostileGlobalGitHome;
    process.env.USERPROFILE = hostileGlobalGitHome;
    // This assertion isolates ONE variable: the hostile global Git configuration.
    // Bare `git` must therefore resolve to the fixed trusted executable, or the
    // bootstrap classifier denies on executable provenance instead and the
    // hostile-config case is never actually exercised. Git for Windows ships a
    // mingw64 `git.exe` that wins on the default PATH, so pin the trusted
    // installation first for this block only — the same normalization
    // bash-safety.test.mjs applies process-wide.
    process.env.PATH = `${path.dirname(fixedTrustedGitExecutable())}${path.delimiter}${originalBootstrapPath || ""}`;
    eq(checkCommandDeep(["node", bootstrapRelative].join(" "), tmp, reviewOptions), null, "MCP direct inspection treats hostile global attributes/filters as inert under sanitized Git config");
    r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: ["node", bootstrapRelative].join(" ") } }, tmp);
    ok(isDeny(r), "the production MCP hook still fails closed when the disposable fixture cannot prove canonical GitHub provenance");
    ok(!existsSync(hostileGlobalFilterMarker), "the hostile global Git process filter never executes through the MCP bootstrap path");
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalBootstrapPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalBootstrapPath;
    ok(checkCommandDeep(trackedDirectRelative.replaceAll("/", "\\"), tmp, reviewOptions)?.includes("not auditable JavaScript"), "direct injection denies a tracked non-JavaScript wrapper");
    eq(checkCommandDeep(`node ${importingWrapperRelative}`, tmp, reviewOptions), null, "direct injection allows an importer whose tracked dependency tree matches reviewed HEAD");
    ok(checkCommandDeep(`node ${builtinEscapeRelative}`, tmp, reviewOptions)?.includes("dynamic code or native-process escape"), "direct injection denies process.getBuiltinModule runtime escape");
    ok(checkCommandDeep(`node ${commentLoaderRelative}`, tmp, reviewOptions)?.includes("ignored or untracked code"), "direct injection denies comment-separated dynamic imports");
    for (const command of [`node ${builtinEscapeRelative}`, `node ${commentLoaderRelative}`]) {
      r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command } }, tmp);
      ok(isDeny(r), `MCP start_process denies a reviewed runtime-closure escape: ${command}`);
    }
    const indirectPreloadCommand = `NODE_OPTIONS=--require=output/ignored-wrapper.mjs ${trackedDirectRelative.replaceAll("/", "\\")}`;
    ok(checkCommandDeep(indirectPreloadCommand, tmp, reviewOptions)?.includes("runtime preload/search-path mutation"), "direct injection denies a command-local preload behind a tracked wrapper");
    r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: indirectPreloadCommand } }, tmp);
    ok(isDeny(r), "MCP start_process denies a command-local preload behind a tracked wrapper");
    writeFileSync(path.join(tmp, importedHelperRelative), 'throw new Error("hostile imported helper executed");\n');
    ok(checkCommandDeep(`node ${importingWrapperRelative}`, tmp, reviewOptions)?.includes("tracked dependency tree"), "direct injection denies an unchanged importer with a modified tracked helper");
    r = runHook({
      tool_name: "mcp__Desktop_Commander__start_process",
      tool_input: { command: `node ${importingWrapperRelative}` },
    }, tmp);
    ok(isDeny(r), "MCP start_process denies an unchanged importer with a modified tracked helper");
    eq(spawnSync("git", ["restore", "--worktree", "--", importedHelperRelative], { cwd: tmp, encoding: "utf8", env: isolatedGitEnv, windowsHide: true }).status, 0, "the MCP imported helper fixture is restored byte-for-byte from reviewed HEAD");
    const ignoredPackageMarker = path.join(tmp, "output", "ignored-package-executed.txt");
    mkdirSync(path.join(tmp, "node_modules", ".bin"), { recursive: true });
    writeFileSync(path.join(tmp, "node_modules", ".bin", "npx.cmd"), `@echo hostile>"${ignoredPackageMarker}"\r\n`);
    ok(checkCommandDeep(`node ${childRunnerRelative}`, tmp, reviewOptions)?.includes("mutable child code"), "direct injection denies a reviewed script that can spawn ignored package code");
    r = runHook({
      tool_name: "mcp__Desktop_Commander__start_process",
      tool_input: { command: `node ${childRunnerRelative}` },
    }, tmp);
    ok(isDeny(r), "MCP start_process denies a reviewed script that can spawn ignored package code");
    ok(!existsSync(ignoredPackageMarker), "the MCP-denied child runner never executes the ignored package shim");
    for (const command of [
      "npm config edit --editor output/evil.cmd",
      "npm explore vite -- vite --config=output/evil.ts",
      "npm --editor=output/evil.cmd edit vite",
      "npm --shell=output/evil.cmd explore vite",
      "npm config set editor output/evil.cmd",
      "NPM_CONFIG_EDITOR=output/evil.cmd npm config get cache",
    ]) {
      ok(checkCommandDeep(command, tmp, reviewOptions), "direct injection denies npm arbitrary program dispatch: " + command);
      r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command } }, tmp);
      ok(isDeny(r), "MCP denies npm arbitrary program dispatch: " + command);
    }
    const alternateHome = path.join(tmp, "output", "alternate-home");
    const alternateHomeMarker = path.join(tmp, "output", "alternate-home-shell-executed.txt");
    mkdirSync(alternateHome, { recursive: true });
    writeFileSync(path.join(alternateHome, ".npmrc"), `script-shell=${path.join(alternateHome, "evil.cmd")}\n`);
    writeFileSync(path.join(alternateHome, "evil.cmd"), `@echo hostile>"${alternateHomeMarker}"\r\n`);
    for (const command of [
      "env HOME=output/alternate-home npm --version",
      "command env USERPROFILE=output/alternate-home npm --version",
      "XDG_CONFIG_HOME=output/alternate-home npm --version",
    ]) {
      r = runHook({
        tool_name: "mcp__Desktop_Commander__start_process",
        tool_input: { command },
      }, tmp);
      ok(isDeny(r), "MCP denies alternate npm home/config relocation: " + command);
    }
    ok(!existsSync(alternateHomeMarker), "the MCP-denied alternate-home npm configuration never executes its ignored shell");

    const ignoredWrapperRelative = "output/ignored-wrapper.mjs";
    const ignoredMarkerPath = path.join(tmp, "output", "wrapper-executed.txt");
    mkdirSync(path.dirname(ignoredMarkerPath), { recursive: true });
    writeFileSync(path.join(tmp, ignoredWrapperRelative), wrapperSource);
    const injectedGitShimDir = path.join(tmp, "output", "git-shim");
    const localGitShimMarker = path.join(tmp, "local-git-shim-ran.txt");
    const pathGitShimMarker = path.join(tmp, "path-git-shim-ran.txt");
    mkdirSync(injectedGitShimDir, { recursive: true });
    const writeGitShim = (directory, marker) => {
      const shimPath = path.join(directory, process.platform === "win32" ? "git.cmd" : "git");
      writeFileSync(shimPath, process.platform === "win32"
        ? `@echo shim>"${marker}"\r\n@exit /b 99\r\n`
        : `#!/bin/sh\nprintf shim > '${marker.replaceAll("'", "'\\''")}'\nexit 99\n`);
      if (process.platform !== "win32") chmodSync(shimPath, 0o755);
      return shimPath;
    };
    const localGitShimPath = writeGitShim(tmp, localGitShimMarker);
    const pathGitShimPath = writeGitShim(injectedGitShimDir, pathGitShimMarker);
    const originalPath = process.env.PATH;
    process.env.PATH = `${injectedGitShimDir}${path.delimiter}${originalPath || ""}`;
    r = runHook({
      tool_name: "mcp__Desktop_Commander__start_process",
      tool_input: { command: `node -- ${ignoredWrapperRelative}` },
    }, tmp);
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    ok(isDeny(r), "MCP start_process denies an ignored wrapper before it can spawn the producer");
    ok(r.stdout.includes("Blocked file-backed interpreter"), "the MCP denial comes from the HEAD-bound executor check");
    ok(!existsSync(localGitShimMarker), "MCP provenance inspection never executes a repository-local Git shim");
    ok(!existsSync(pathGitShimMarker), "MCP provenance inspection never executes a PATH-injected Git shim");
    rmSync(localGitShimPath, { force: true });
    rmSync(pathGitShimPath, { force: true });
    rmSync(injectedGitShimDir, { recursive: true, force: true });
    ok(!existsSync(ignoredMarkerPath), "the MCP-denied ignored wrapper never executes");
    const ignoredDirectRelative = "output/ignored-wrapper.bat";
    writeFileSync(path.join(tmp, ignoredDirectRelative), "@echo ignored direct wrapper\n");
    r = runHook({
      tool_name: "mcp__Desktop_Commander__start_process",
      tool_input: { command: ignoredDirectRelative.replaceAll("/", "\\") },
    }, tmp);
    ok(isDeny(r) && r.stdout.includes("Blocked file-backed interpreter"), "MCP denies a directly executed ignored script");
    for (const cmdBuiltinCommand of [
      `cmd /c call ${ignoredDirectRelative.replaceAll("/", "\\")}`,
      `cmd /c @call ${ignoredDirectRelative.replaceAll("/", "\\")}`,
      `cmd /c if exist ${ignoredDirectRelative.replaceAll("/", "\\")} ${ignoredDirectRelative.replaceAll("/", "\\")}`,
      `cmd /c if 1==1 call ${ignoredDirectRelative.replaceAll("/", "\\")}`,
      `cmd /c for %A in (1) do ${ignoredDirectRelative.replaceAll("/", "\\")}`,
    ]) {
      r = runHook({
        tool_name: "mcp__Desktop_Commander__start_process",
        tool_input: { command: cmdBuiltinCommand },
      }, tmp);
      ok(isDeny(r) && r.stdout.includes("Blocked file-backed interpreter"), "MCP denies a CMD builtin wrapper: " + cmdBuiltinCommand);
    }
    writeFileSync(path.join(tmp, "evil.cmd"), "@echo bare ignored wrapper\n");
    r = runHook({
      tool_name: "mcp__Desktop_Commander__start_process",
      tool_input: { command: "cmd /c evil" },
    }, tmp);
    ok(isDeny(r) && r.stdout.includes("Blocked file-backed interpreter"), "MCP denies a bare current-directory CMD wrapper resolved through PATHEXT");
    writeFileSync(path.join(tmp, "output", "evil.cmd"), "@echo PATH-resolved ignored wrapper\n");
    for (const pathMutationCommand of [
      'cmd /c "set PATH=output&&evil"',
      "cmd /c set PATH=output&&evil",
      "PATH=output evil",
      "env PATH=output evil",
      "$env:PATH='output'; evil",
    ]) {
      r = runHook({
        tool_name: "mcp__Desktop_Commander__start_process",
        tool_input: { command: pathMutationCommand },
      }, tmp);
      ok(isDeny(r) && r.stdout.includes("PATH or PATHEXT mutation"), "MCP denies command-local PATH executable dispatch: " + pathMutationCommand);
    }
    const ignoredPowerShellRelative = "output/ignored-wrapper.ps1";
    writeFileSync(path.join(tmp, ignoredPowerShellRelative), "Write-Output ignored\n");
    r = runHook({
      tool_name: "mcp__Desktop_Commander__start_process",
      tool_input: { command: `Set-Alias x .\\${ignoredPowerShellRelative.replaceAll("/", "\\")}; x` },
    }, tmp);
    ok(isDeny(r) && r.stdout.includes("Blocked file-backed interpreter"), "MCP denies a static PowerShell alias to an ignored script");
    for (const implicitLoaderCommand of [
      "Import-Module output/ignored.psm1",
      "make -f output/ignored.mk",
      "java -jar output/ignored.jar",
    ]) {
      r = runHook({
        tool_name: "mcp__Desktop_Commander__start_process",
        tool_input: { command: implicitLoaderCommand },
      }, tmp);
      ok(isDeny(r), "MCP denies an implicit code loader: " + implicitLoaderCommand);
    }
    for (const replacementMutationCommand of [
      "git replace HEAD replacement",
      "git update-ref refs/replace/deadbeef replacement",
      "printf 'update refs/replace/deadbeef replacement\\n' | git update-ref --stdin",
    ]) {
      r = runHook({
        tool_name: "mcp__Desktop_Commander__start_process",
        tool_input: { command: replacementMutationCommand },
      }, tmp);
      ok(isDeny(r), "MCP denies Git replacement-object mutation: " + replacementMutationCommand);
    }
    const inlineGitAliasCommand = "git -c 'alias.run=!node output/ignored-wrapper.mjs' run";
    r = runHook({
      tool_name: "mcp__Desktop_Commander__start_process",
      tool_input: { command: inlineGitAliasCommand },
    }, tmp);
    ok(isDeny(r), "MCP start_process denies an inline Git shell alias before it can launch an ignored wrapper");
    ok(r.stdout.includes("Blocked executable Git configuration"), "the MCP inline Git alias denial comes from the executable boundary");
    ok(!existsSync(ignoredMarkerPath), "the MCP-denied Git alias never executes its ignored wrapper");
    const trackedWrapperBlob = spawnSync("git", ["rev-parse", `HEAD:${trackedWrapperRelative}`], { cwd: tmp, encoding: "utf8", env: isolatedGitEnv, windowsHide: true });
    eq(trackedWrapperBlob.status, 0, "the MCP tracked-wrapper blob resolves for the mode-substitution regression");
    eq(
      spawnSync("git", ["update-index", "--add", "--cacheinfo", `120000,${trackedWrapperBlob.stdout.trim()},${trackedWrapperRelative}`], { cwd: tmp, encoding: "utf8", env: isolatedGitEnv, windowsHide: true }).status,
      0,
      "the MCP regression stages the reviewed regular-file blob as a symlink",
    );
    r = runHook({
      tool_name: "mcp__Desktop_Commander__start_process",
      tool_input: { command: `node ${trackedWrapperRelative}` },
    }, tmp);
    ok(isDeny(r) && r.stdout.includes("Blocked file-backed interpreter"), "MCP denies a same-blob regular-file-to-symlink index substitution");
    eq(
      spawnSync("git", ["reset", "--", trackedWrapperRelative], { cwd: tmp, encoding: "utf8", env: isolatedGitEnv, windowsHide: true }).status,
      0,
      "the MCP mode-substitution regression restores the exact HEAD index mode",
    );
    writeFileSync(path.join(tmp, trackedWrapperRelative), `${wrapperSource}// worktree divergence\n`);
    writeFileSync(path.join(tmp, trackedDirectRelative), "@echo worktree-divergent direct wrapper\n");
    r = runHook({
      tool_name: "mcp__Desktop_Commander__start_process",
      tool_input: { command: `node -- ${trackedWrapperRelative}` },
    }, tmp);
    ok(isDeny(r) && r.stdout.includes("Blocked file-backed interpreter"), "MCP origin/main-binds a worktree-divergent executor after --");
    r = runHook({
      tool_name: "mcp__Desktop_Commander__start_process",
      tool_input: { command: trackedDirectRelative.replaceAll("/", "\\") },
    }, tmp);
    ok(isDeny(r) && r.stdout.includes("Blocked file-backed interpreter"), "MCP denies a directly executed modified script");
    for (const args of [
      ["add", trackedWrapperRelative, trackedDirectRelative],
      ["commit", "-m", "local-only malicious wrapper"],
      localRefMoveArgs,
    ]) {
      const gitResult = spawnSync("git", args, { cwd: tmp, encoding: "utf8", env: isolatedGitEnv, windowsHide: true });
      eq(gitResult.status, 0, `local-only malicious wrapper commit succeeds for the MCP regression: git ${args[0]}`);
    }
    ok(checkCommandDeep(`node -- ${trackedWrapperRelative}`, tmp, reviewOptions)?.includes("fresh exact-SHA independent review proof"), "direct injection proves a moved local tracking ref cannot replace the authoritative main SHA");
    ok(checkCommandDeep(trackedDirectRelative.replaceAll("/", "\\"), tmp, reviewOptions)?.includes("fresh exact-SHA independent review proof"), "a directly executed script from an unreviewed local HEAD is denied");
    r = runHook({
      tool_name: "mcp__Desktop_Commander__start_process",
      tool_input: { command: `node -- ${trackedWrapperRelative}` },
    }, tmp);
    ok(isDeny(r) && r.stdout.includes("Blocked file-backed interpreter"), "production MCP denies a locally committed wrapper even after the mutable local tracking ref moves");
    writeFileSync(path.join(tmp, trackedWrapperRelative), reviewedWrapperSource);
    const externalExecutorPath = path.join(externalExecutorDir, "external-wrapper.mjs");
    writeFileSync(externalExecutorPath, wrapperSource);
    r = runHook({
      tool_name: "mcp__Desktop_Commander__start_process",
      tool_input: { command: `node -- ${JSON.stringify(externalExecutorPath)}` },
    }, tmp);
    ok(isDeny(r) && r.stdout.includes("Blocked file-backed interpreter"), "MCP denies an external executor after --");

    r = runHook({
      tool_name: "mcp__Desktop_Commander__move_file",
      tool_input: { source: producerRelative, destination: alternateRelative },
    }, tmp);
    ok(isDeny(r), "MCP cannot relocate the protected producer to an alternate path");
    for (const fileTool of ["copy_file", "rename_file", "delete_file"]) {
      r = runHook({
        tool_name: `mcp__filesystem__${fileTool}`,
        tool_input: { source: producerRelative, path: producerRelative, destination: alternateRelative },
      }, tmp);
      ok(isDeny(r), `${fileTool} cannot affect the protected producer`);
    }
    const aliasedScriptsDir = path.join(tmp, "SCRIPT~1");
    symlinkSync(path.join(tmp, "scripts"), aliasedScriptsDir, process.platform === "win32" ? "junction" : "dir");
    const aliasedProducerPath = path.join(aliasedScriptsDir, path.basename(producerRelative));
    r = runHook({
      tool_name: "mcp__filesystem__write_file",
      tool_input: { path: aliasedProducerPath, content: "unreviewed" },
    }, tmp);
    ok(isDeny(r), "MCP canonicalizes a short-name or linked-directory alias before protecting the maintenance producer");
    for (const exclusionPath of [".gitignore", ".git/info/exclude", ".git/config", ".git/config.worktree", ".git/hooks/pre-commit", ".gitconfig", ".config/git/ignore"]) {
      r = runHook({ tool_name: "mcp__Desktop_Commander__write_file", tool_input: { path: exclusionPath } }, tmp);
      ok(isDeny(r), `MCP cannot edit Git exclusion control ${exclusionPath}`);
    }
    r = runHook({ tool_name: "mcp__Desktop_Commander__edit_block", tool_input: { path: ".git/hooks/pre-commit", old_string: "safe", new_string: "hostile" } }, tmp);
    ok(isDeny(r), "MCP edit_block cannot modify a Git pre-commit hook");

    renameSync(path.join(tmp, producerRelative), path.join(tmp, alternateRelative));
    writeFileSync(path.join(tmp, ".git", "info", "exclude"), `${alternateRelative}\n`);
    r = runHook({
      tool_name: "mcp__Desktop_Commander__interact_with_process",
      tool_input: { pid: 321, input: "$COMMAND = 'node'; $TARGET = 'scripts/ignored-maintenance-copy.mjs'" },
    }, tmp);
    ok(isDeny(r), "persistent input stays denied while the tracked producer is absent and ignored");
    r = runHook({ tool_name: "mcp__Desktop_Commander__kill_process", tool_input: { pid: 321 } }, tmp);
    ok(isDeny(r), "process signaling stays denied while the tracked producer is absent and ignored");

    renameSync(path.join(tmp, alternateRelative), path.join(tmp, producerRelative));
    r = runHook({
      tool_name: "mcp__Desktop_Commander__interact_with_process",
      tool_input: { pid: 321, input: "Write-Output restored" },
    }, tmp);
    ok(isDeny(r), "persistent input remains denied after the exact producer blob is restored");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(externalExecutorDir, { recursive: true, force: true });
  }
}

console.log(`mcp-tool-guard: ${pass} assertions passed`);
