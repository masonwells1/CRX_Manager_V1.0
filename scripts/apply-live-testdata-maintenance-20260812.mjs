#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(SCRIPT_DIR, "..");
// Deliberately assembled so this reviewed producer can be checked in without
// tripping the raw-text false positive that this maintenance lane will repair.
const TARGET = [".claude", "hooks", "live-" + "testdata-lib.mjs"].join("/");
const TARGET_PATH = path.join(REPO_DIR, TARGET);
const SNIPPETS = {
  constants: "docs/maintenance/2026-08-12-live-testdata-constants.snippet.txt",
  helpers: "docs/maintenance/2026-08-12-live-testdata-helpers.snippet.txt",
  classify: "docs/maintenance/2026-08-12-live-testdata-classify.snippet.txt",
};

const EXPECTED_INPUT_BLOB = "c8bec70830c643e474831985f5e6c3bd16630386";
const EXPECTED_OUTPUT_BLOB = "7bca8dce4fe2f58afabdbd09d1b31ecef61ce520";
const EXPECTED_SNIPPET_SHA256 = {
  constants: "53c658d7eb8aab2a60b4314f533f61b7472f8d686f4b81d483d57b20950022a9",
  helpers: "8fa108c52b4423b7d269d94d19b91726fe880b6d2ea403c5c9665c686b532398",
  classify: "41dea42c28a47e47892dbf1da05144a4dac0dfa30045eba99789090905411d00",
};
const APPROVAL = "--approved-by-mason=2026-08-12";
const PROTECT_PRODUCER = "--protect-producer";
const RETIRE_PRODUCER = "--retire-producer";
const PRODUCER = "scripts/apply-live-testdata-maintenance-20260812.mjs";
const PRODUCER_PATH = path.join(REPO_DIR, PRODUCER);
const PROTECTED_SOURCES = {
  codexGuard: [".codex", "hooks", "production-action-" + "guard.mjs"].join("/"),
  pushLib: [".claude", "hooks", "codex-push-" + "lib.mjs"].join("/"),
};
const EXPECTED_PROTECTED_INPUT_BLOBS = {
  // Re-pinned 2026-08-14: the guard gained the Supabase read-only allowlist
  // (Sol HIGH finding on the write-scope review), then the app-connector UUID
  // prefix (CodeRabbit follow-up), then the codex_apps single-underscore
  // naming form and the SELECT INTO denial in the read-only SQL gate
  // (Codex-review P1 follow-ups). This PR cohort also wrapped matcherAnchor
  // in normalizeLineEndings; the anchor text itself is unchanged, so the
  // transform still applies cleanly.
  // pushLib re-pinned 2026-08-19 (PR #423, blind Opus round 2): the
  // applied-source ledger's basename joined reviewProofPathMentioned so the
  // C3 containment record can't be forged or deleted directly. The risky
  // producer-path anchor this transform verifies is unchanged.
  // pushLib re-pinned again 2026-08-19 (PR #423, blind Opus round 5): the
  // sanctioned ledger-removal script scripts/remove-applied-ledger-entry.mjs
  // joined RISKY_PATH_RES so a Codex push touching it needs an exact-head
  // proof. The apply-live-testdata risky-path anchor this transform verifies is
  // still present exactly once; the transform is identity, so input == output.
  // pushLib re-pinned 2026-08-24 (PR #441): ghMergeRequest now CAPTURES the
  // --match-head-commit value instead of parsing it only to skip it, marks which
  // merge form can pin a head (isGhCli), and gained the CodeRabbit exact-head
  // evidence predicates the merge guard enforces. RISKY_PATH_RES and the risky
  // producer-path anchor this transform verifies are untouched, so the transform
  // is still identity and input == output.
  // codexGuard re-pinned 2026-08-24 (PR #441): the merge route gained the
  // exact-head CodeRabbit gate and the --match-head-commit binding, mirroring
  // .claude/hooks/pr-merge-guard.mjs so the two sides cannot diverge. Every
  // anchor this transform rewrites (the protected-producer list, the matcher,
  // the maintenance gate, the command gate) is untouched.
  codexGuard: "ffe97aaf4c6d29b0267862b35b816db266dddf23",
  pushLib: "b86669151d3b68d96e71f06dfbbe5f9c21056959",
};
const EXPECTED_PROTECTED_OUTPUT_BLOBS = {
  codexGuard: "c0e949cfdaa91c03e169c4122ec409476aabe8cd",
  pushLib: "b86669151d3b68d96e71f06dfbbe5f9c21056959",
};

export function maintenanceProducerCommandMentioned(command) {
  const value = String(command || "");
  const hasDynamicSyntax = (text) => /[*?\[\]{}$`@]|[<>]\(|\([^()\r\n]*\+[^()\r\n]*\)|\s-join(?:\s|$)|![^!\r\n]+!|%[^%\r\n]+%/i.test(text);
  const dynamicSyntax = hasDynamicSyntax(value);
  const tokenize = (text) => {
      const tokens = [];
      let current = "";
      let quote = "";
      let sawQuoted = false;
      let sawUnquoted = false;
      const push = () => {
        if (!current) return;
        tokens.push({ value: current, sawQuoted, sawUnquoted, control: false });
        current = "";
        sawQuoted = false;
        sawUnquoted = false;
      };
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (quote) {
          if (char === quote) quote = "";
          else {
            current += char;
            sawQuoted = true;
          }
          continue;
        }
        if (char === "\"" || char === "'") {
          quote = char;
          sawQuoted = true;
        } else if (char === "\r" || char === "\n") {
          push();
          tokens.push({ value: "\n", sawQuoted: false, sawUnquoted: true, control: true });
          if (char === "\r" && text[index + 1] === "\n") index += 1;
        } else if (/\s/.test(char)) push();
        else if (/[;&|(){}<>]/.test(char)) {
          push();
          tokens.push({ value: char, sawQuoted: false, sawUnquoted: true, control: true });
        } else {
          current += char;
          sawUnquoted = true;
        }
      }
      push();
      return tokens;
  };
  const tokens = tokenize(value);
  const normalizeShellToken = (tokenValue) => String(tokenValue || "")
    .replace(/\\([^\\/])/g, "$1")
    .replace(/\^([^^])/g, "$1")
    .replace(/`([^`])/g, "$1")
    .replace(/^@/, "");
  const normalizeShellOption = (tokenValue) => normalizeShellToken(tokenValue).replace(/\\\//g, "/");
  const executableNamed = (token, name, allowQuotedBare = false) => {
    if (!token || token.control) return false;
    const normalized = normalizeShellToken(token.value);
      const candidates = [token.value, normalized, normalized.replace(/^\$/, "")];
      return candidates.some((candidate) => {
        const basename = candidate.split(/[\\/]/).pop();
        const exact = new RegExp(`^${name}(?:\\.exe)?$`, "i").test(basename);
      return exact && (allowQuotedBare || !token.sawQuoted || token.sawUnquoted || /[\\/]/.test(candidate));
    });
  };
  const invocationPosition = (list, index) => {
    let segmentStart = index;
    while (segmentStart > 0 && !list[segmentStart - 1].control) segmentStart -= 1;
    let cursor = segmentStart;
    while (cursor < index && /^[A-Za-z_]\w*=/.test(list[cursor].value)) cursor += 1;
    let wrapperDepth = 0;
    for (; cursor < index && wrapperDepth < 8; wrapperDepth += 1) {
      const token = list[cursor];
      const named = (name) => executableNamed(token, name, true);
      if (named("command")) {
        cursor += 1;
        if (cursor < index && /^-[vV]$/.test(list[cursor].value)) return false;
        while (cursor < index && /^(?:-p|--)$/.test(list[cursor].value)) cursor += 1;
      } else if (named("exec")) {
        cursor += 1;
        while (cursor < index && list[cursor].value.startsWith("-")) {
          if (/^-[cla]*a[cla]*$/.test(list[cursor].value)) cursor += 1;
          cursor += 1;
        }
      } else if (named("env")) {
        cursor += 1;
        while (cursor < index) {
          const argument = list[cursor].value;
          if (/^--(?:help|version)$/.test(argument)) return false;
          if (argument === "--") { cursor += 1; break; }
          if (/^-[i0v]*[uCa][i0v]*$/.test(argument)) { cursor += 2; continue; }
          if (/^(?:-u|--unset|-C|--chdir|-a|--argv0)$/.test(argument)) { cursor += 2; continue; }
          if (/^[A-Za-z_]\w*=/.test(argument) || argument.startsWith("-")) { cursor += 1; continue; }
          break;
        }
      } else if (["nohup", "nice", "timeout", "setsid", "stdbuf"].some((name) => named(name))) {
        cursor += 1;
        if (cursor < index && /^--(?:help|version)$/.test(list[cursor].value)) return false;
        while (cursor < index && list[cursor].value.startsWith("-")) {
          if (/^--(?:help|version)$/.test(list[cursor].value)) return false;
          if (/^(?:-n|--adjustment|-k|--kill-after|-s|--signal|-o|-e|-i)$/.test(list[cursor].value)
            || (named("timeout") && /^-[a-z]*[ks][a-z]*$/i.test(list[cursor].value))) cursor += 1;
          cursor += 1;
        }
        if (named("timeout") && cursor < index) cursor += 1;
      } else {
        return false;
      }
      while (cursor < index && /^[A-Za-z_]\w*=/.test(list[cursor].value)) cursor += 1;
    }
    return cursor === index || (wrapperDepth >= 8 && cursor < index);
  };
  const dynamicArgument = (argument) => /^(?:[$`@*?\[<{(]|![^!\r\n]+!|%[^%\r\n]+%)/.test(argument)
    || /^(?:--?|\/).*(?:[$`@*?\[<{(]|![^!\r\n]+!|%[^%\r\n]+%)/.test(argument);
  if (tokens.some((token, index, list) => token.control
    && token.value === "&"
    && list[index + 1]?.control
    && /[({]/.test(list[index + 1].value))) return true;
  const opaqueExecutablePosition = (token, index, list) => {
    if (token.control || !dynamicArgument(token.value)) return false;
    const prior = list[index - 1];
    if (prior?.control && prior.value === "&") return true;
    if (prior?.control && /[({]/.test(prior.value)) return false;
    let segmentStart = index;
    while (segmentStart > 0 && !list[segmentStart - 1].control) segmentStart -= 1;
    return list.slice(segmentStart, index).every((entry) => /^[A-Za-z_]\w*=/.test(entry.value));
  };
  if (dynamicSyntax && tokens.some(opaqueExecutablePosition)) return true;
  const opaqueJavaScriptLoaderInvocation = (token, index, list) => {
    if (!invocationPosition(list, index)) return false;
    let segmentEnd = index + 1;
    while (segmentEnd < list.length && !list[segmentEnd].control) segmentEnd += 1;
    const argumentsInSegment = list.slice(index + 1, segmentEnd).map((entry) => normalizeShellOption(entry.value));
    const loaderOption = /^(?:-r|--require|--import|--preload|--(?:experimental-)?loader)(?:=|$)/i;
    return argumentsInSegment.some((argument) => loaderOption.test(argument))
      && argumentsInSegment.some((argument) => dynamicArgument(argument));
  };
  if (dynamicSyntax && tokens.some(opaqueJavaScriptLoaderInvocation)) return true;
  const opaquePowerShellEvaluationInvocation = (token, index, list) => {
    if (!invocationPosition(list, index)) return false;
    return token.value === "."
      || ["invoke-expression", "iex", "invoke-command", "icm", "start-job", "sajb", "start-threadjob", "start-rsjob"]
        .some((name) => executableNamed(token, name, true));
  };
  if (tokens.some(opaquePowerShellEvaluationInvocation)) return true;
  const dynamicPowerShellProcessLauncher = (token, index, list) => {
    if (!invocationPosition(list, index)) return false;
    return executableNamed(token, "start-process", true)
      || executableNamed(token, "saps", true)
      || executableNamed(token, "start", true);
  };
  if (dynamicSyntax && tokens.some(dynamicPowerShellProcessLauncher)) return true;
  const powerShellNodeOptionsMutation = (token, index, list) => {
    if (!invocationPosition(list, index)) return false;
    const cmdlet = ["set-item", "new-item", "set-content", "add-content", "clear-item", "remove-item"]
      .some((name) => executableNamed(token, name, true));
    if (!cmdlet) return false;
    for (let cursor = index + 1; cursor < list.length && !list[cursor].control; cursor += 1) {
      if (/^env:\\?node_options$/i.test(normalizeShellToken(list[cursor].value))) return true;
    }
    return false;
  };
  if (tokens.some(powerShellNodeOptionsMutation)) return true;
  const opaqueStdinExecutorInvocation = (token, index, list) => {
    if (!invocationPosition(list, index)) return false;
    const executor = executableNamed(token, "xargs", true) || executableNamed(token, "parallel", true);
    if (!executor) return false;
    let segmentStart = index;
    while (segmentStart > 0 && !list[segmentStart - 1].control) segmentStart -= 1;
    return list[segmentStart - 1]?.value === "|";
  };
  if (tokens.some(opaqueStdinExecutorInvocation)) return true;
  const opaqueInlineInterpreterInvocation = (token, index, list) => {
    if (!invocationPosition(list, index)) return false;
    const python = ["python", "python2", "python3", "py"].some((name) => executableNamed(token, name, true));
    const nodeLike = ["node", "nodejs", "bun"].some((name) => executableNamed(token, name, true));
    const shortEval = ["perl", "ruby"].some((name) => executableNamed(token, name, true));
    const php = executableNamed(token, "php", true);
    const deno = executableNamed(token, "deno", true);
    const shell = ["bash", "sh", "dash", "zsh", "ksh"].some((name) => executableNamed(token, name, true));
    if (!(python || nodeLike || shortEval || php || deno || shell)) return false;
    let segmentStart = index;
    while (segmentStart > 0 && !list[segmentStart - 1].control) segmentStart -= 1;
    if (list[segmentStart - 1]?.value === "|") return true;
    let segmentEnd = index + 1;
    while (segmentEnd < list.length && !list[segmentEnd].control) segmentEnd += 1;
    if (shell && list[segmentEnd]?.value === "<") return true;
    for (let cursor = index + 1; cursor < list.length && !list[cursor].control; cursor += 1) {
      const argument = normalizeShellToken(list[cursor].value);
      if (/^(?:--help|--version|-h|-V)$/.test(argument)) return false;
      if ((nodeLike || deno) && dynamicArgument(argument)) return true;
      if (python && argument === "-c") return true;
      if (nodeLike && /^(?:-e|--eval|-p|--print)(?:=|$)/i.test(argument)) return true;
      if (shortEval && /^-[eE](?:$|.)/.test(argument)) return true;
      if (php && /^-r(?:$|.)/i.test(argument)) return true;
      if (deno && /^eval$/i.test(argument)) return true;
      if (deno && /^(?:run|serve|task)$/i.test(argument)) continue;
      if (nodeLike && executableNamed(token, "bun", true) && /^run$/i.test(argument)) continue;
      if (shell && /^-[A-Za-z]*[cs][A-Za-z]*$/.test(argument)) return true;
      if (argument === "-") return true;
      if (argument === "--") {
        const operand = list[cursor + 1];
        if (shell) return true;
        return !operand || operand.control || operand.value === "-";
      }
      if (python && /^(?:-W|-X)$/.test(argument)) {
        cursor += 1;
        continue;
      }
      if (!argument.startsWith("-")) return shell;
    }
    return true;
  };
  if (tokens.some(opaqueInlineInterpreterInvocation)) return true;
  const powerShellValueOption = (argument) => /^(?:--?|\/)(?:configuration(?:name|file)|config|cus(?:t(?:o(?:m(?:p(?:i(?:p(?:e(?:n(?:a(?:m(?:e)?)?)?)?)?)?)?)?)?)?)?|settings(?:f(?:i(?:l(?:e)?)?)?)?|executionpolicy|ex|ep|inputformat|inp|input|if|outputformat|o|of|out|windowstyle|w|workingdirectory|wd)(?::|=)?/i.test(argument);
  const commandStringContainsEncodedPowerShell = (text) => {
    const cmdTokens = tokenize(text);
    return cmdTokens.some((token, index) => {
      if (!(executableNamed(token, "pwsh", true) || executableNamed(token, "powershell", true))) return false;
      for (let cursor = index + 1; cursor < cmdTokens.length; cursor += 1) {
        if (/^(?:--?|\/)e(?:c|n[a-z]*)?(?:$|(?::|=|[\s,]).*)/i.test(normalizeShellOption(cmdTokens[cursor].value))) return true;
      }
      return false;
    });
  };
  const opaqueLauncherContainsEncodedPowerShell = tokens.some((token, index, list) => {
    const launcher = executableNamed(token, "start-process", true) || executableNamed(token, "xargs", true);
    if (!launcher || !invocationPosition(list, index)) return false;
    let commandEnd = index + 1;
    while (commandEnd < list.length && !list[commandEnd].control) commandEnd += 1;
    return commandStringContainsEncodedPowerShell(list.slice(index + 1, commandEnd).map((entry) => entry.value).join(" "));
  });
  if (opaqueLauncherContainsEncodedPowerShell) return true;
  const powerShellEncodedCommand = tokens.some((token, index, list) => {
    if (!(executableNamed(token, "pwsh", true) || executableNamed(token, "powershell", true)) || !invocationPosition(list, index)) return false;
    for (let cursor = index + 1; cursor < list.length && !list[cursor].control; cursor += 1) {
      const argument = normalizeShellOption(list[cursor].value);
      if (/^(?:--?|\/)f(?:i(?:l(?:e)?)?)?(?:(?::|=).*)?$/i.test(argument)) return true;
      if (/^(?:--?|\/)e(?:c|n[a-z]*)?(?:(?::|=).*)?$/i.test(argument)) return true;
      if (powerShellValueOption(argument) && !/[:=]/.test(argument)) cursor += 1;
      else if (!argument.startsWith("-") && !argument.startsWith("/")) break;
    }
    return false;
  });
  if (powerShellEncodedCommand) return true;
  {
    const nodeExecutable = (token, index, list) => {
      if (!executableNamed(token, "node", true)) return false;
      const pureQuotedBare = token.sawQuoted && !token.sawUnquoted && !/[\\/]/.test(token.value);
      if (!pureQuotedBare || String(list[index - 1]?.value || "").toLowerCase() !== "-pattern") return true;
      let segmentStart = index - 1;
      while (segmentStart >= 0 && !list[segmentStart].control) segmentStart -= 1;
      const commandToken = list[segmentStart + 1];
      return !(executableNamed(commandToken, "select-string", true) || executableNamed(commandToken, "sls", true));
    };
    const maxNestedShellDepth = 4;
    function analyzeText(text, depth) {
      if (depth > maxNestedShellDepth) return true;
      return analyzeTokens(tokenize(text), depth);
    }
    function analyzeTokens(candidateTokens, depth) {
      if (dynamicSyntax && candidateTokens.some(nodeExecutable)) return true;
      for (let index = 0; index < candidateTokens.length; index += 1) {
        if (executableNamed(candidateTokens[index], "env") && invocationPosition(candidateTokens, index)) {
          for (let cursor = index + 1; cursor < candidateTokens.length && !candidateTokens[cursor].control; cursor += 1) {
            const argument = normalizeShellToken(candidateTokens[cursor].value);
            if (argument === "--") break;
            const shortSplit = /^-[i0v]*S(.*)$/.exec(argument);
            const longSplit = /^--split-string(?:=(.*))?$/.exec(argument);
            if (shortSplit || longSplit) {
              const attached = shortSplit?.[1] || longSplit?.[1] || "";
              const commandText = attached || candidateTokens[cursor + 1]?.value || "";
              if (!commandText || hasDynamicSyntax(commandText) || depth >= maxNestedShellDepth || analyzeText(commandText, depth + 1)) return true;
              break;
            }
            if (/^(?:-u|--unset|-C|--chdir|-a|--argv0)$/.test(argument)) {
              cursor += 1;
              continue;
            }
            if (/^[A-Za-z_]\w*=/.test(argument) || argument.startsWith("-")) continue;
            break;
          }
        }
        if (executableNamed(candidateTokens[index], "cmd") && invocationPosition(candidateTokens, index)) {
          let commandString = false;
          for (let cursor = index + 1; cursor < candidateTokens.length && !candidateTokens[cursor].control; cursor += 1) {
            const commandSwitch = /^(?:\/[a-z](?::[a-z]+)?)*\/[ck](.*)$/i.exec(candidateTokens[cursor].value);
            if (commandSwitch?.[1]) {
              if (commandStringContainsEncodedPowerShell(commandSwitch[1]) || depth >= maxNestedShellDepth || analyzeText(commandSwitch[1], depth + 1)) return true;
              break;
            }
            if (commandSwitch) {
              commandString = true;
              continue;
            }
            if (commandString) {
              let commandEnd = cursor;
              while (commandEnd < candidateTokens.length && !candidateTokens[commandEnd].control) commandEnd += 1;
              const commandText = candidateTokens.slice(cursor, commandEnd).map((entry) => entry.value).join(" ");
              if (commandStringContainsEncodedPowerShell(commandText) || depth >= maxNestedShellDepth || analyzeText(commandText, depth + 1)) return true;
              break;
            }
          }
        }
        const posixShell = ["bash", "sh", "dash", "zsh", "ksh"].some((name) => executableNamed(candidateTokens[index], name)) && invocationPosition(candidateTokens, index);
        const powerShell = ["pwsh", "powershell"].some((name) => executableNamed(candidateTokens[index], name, true)) && invocationPosition(candidateTokens, index);
        if (posixShell || powerShell) {
          let commandString = false;
          for (let cursor = index + 1; cursor < candidateTokens.length && !candidateTokens[cursor].control; cursor += 1) {
            const rawArgument = candidateTokens[cursor].value;
            const argument = powerShell ? normalizeShellOption(rawArgument) : normalizeShellToken(rawArgument);
            if (powerShell && !commandString && dynamicArgument(rawArgument)) return true;
            if (powerShell && !commandString && /^(?:--?|\/)f(?:i(?:l(?:e)?)?)?(?:(?::|=).*)?$/i.test(argument)) return true;
            if (powerShell && !commandString && powerShellValueOption(argument)) {
              if (!/[:=]/.test(argument)) cursor += 1;
              continue;
            }
            if (powerShell && !commandString && !argument.startsWith("-") && !argument.startsWith("/")) break;
            if (powerShell && /^(?:--?|\/)e(?:c|n[a-z]*)?(?:(?::|=).*)?$/i.test(argument)) return true;
            const attachedCommand = powerShell ? /^(?:(?:(?:--?|\/)c|(?:--?|\/)co(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?|(?:--?|\/)cwa|(?:--?|\/)commandw[a-z]*):|--command=)(.+)$/i.exec(argument) : null;
            if (attachedCommand) {
              if (commandStringContainsEncodedPowerShell(attachedCommand[1]) || depth >= maxNestedShellDepth || analyzeText(attachedCommand[1], depth + 1)) return true;
              break;
            }
            const commandOption = posixShell
              ? /^-[a-z]*c[a-z]*$/i.test(argument)
              : /^(?:(?:--?|\/)c|(?:--?|\/)co(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?|(?:--?|\/)cwa|(?:--?|\/)commandw[a-z]*)$/i.test(argument);
            if (commandOption) {
              commandString = true;
              continue;
            }
            if (commandString) {
              if (powerShell && argument === "-") return true;
              if (commandStringContainsEncodedPowerShell(argument) || depth >= maxNestedShellDepth || analyzeText(argument, depth + 1)) return true;
              break;
            }
          }
        }
      }
      return false;
    }
    if (analyzeTokens(tokens, 0)) return true;
  }
  const nodeScript = /\bnode(?:\.exe)?\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/i.exec(value);
  const scriptPath = nodeScript?.[1] || nodeScript?.[2] || nodeScript?.[3] || "";
  if (/[*?\[\]]|\$\(|\$\{/.test(scriptPath)) return true;
  const compact = value
    .toLowerCase()
    .replace(/[\s\\/"'`^]/g, "");
  return compact.includes("apply-live-testdata-maintenance-20260812.mjs")
    || compact.includes("--approved-by-mason=");
}

export function maintenanceProducerInvocationAllowed(command) {
  const value = String(command || "").trim();
  return value === "node scripts/apply-live-testdata-maintenance-20260812.mjs --verify"
    || value === "node scripts/apply-live-testdata-maintenance-20260812.mjs --approved-by-mason=2026-08-12"
    || value === "node scripts/apply-live-testdata-maintenance-20260812.mjs --approved-by-mason=2026-08-12 --protect-producer"
    || value === "node scripts/apply-live-testdata-maintenance-20260812.mjs --approved-by-mason=2026-08-12 --retire-producer";
}

export function exactHeadProofValid(data, headSha, baseSha, nowMs = Date.now()) {
  if (!data || data.codex_ran !== true || data.verdict !== "clean") return false;
  if (data.model !== "gpt-5.6-sol" || data.reasoning_effort !== "high") return false;
  if (data.head_sha !== headSha || data.base_sha !== baseSha) return false;
  const timestamp = Date.parse(data.timestamp || "");
  const age = nowMs - timestamp;
  return Number.isFinite(timestamp) && age >= 0 && age <= 30 * 60 * 1000;
}

const OLD_CONSTANTS = [
  "const DDL_STMT_RE = /(?:^|;)\\s*(?:create(?!\\s+(?:temp|temporary)\\b)(?:\\s+or\\s+replace)?|alter|drop)\\s+\\S+/im;",
  "const GRANT_REVOKE_RE = /(?:^|;)\\s*(?:grant|revoke)\\b/im;",
  "const TRUNCATE_RE = /(?:^|;)\\s*truncate\\b/im;",
].join("\n");
const OLD_PREFIX = "const READONLY_FN_PREFIX_RE = /^(?:get|list|find|search|count|calc|calculate|compute|report|fetch|lookup|has|is|can|preview|estimate|summarize|derive)_/;";
const NEW_PREFIX = "const READONLY_FN_PREFIX_RE = /^(?:get|list|find|search|count|calc|calculate|compute|report|fetch|lookup|has|is|can|estimate|summarize|derive)_/;";
const OLD_FUNCTION_GATE = "  if (!/\\bselect\\b/i.test(text)) return null;\n";
const NEW_FUNCTION_GATE = "";
const CLASSIFY_START = "export function classifySql(query) {";
const CLASSIFY_END = "// ── Destructive-migration classifier (Mason's settled 2026-07-13 policy) ─────";

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: REPO_DIR,
    encoding: "utf8",
    stdio: options.input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    ...options,
  }).trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function gitBlob(value) {
  return execFileSync("git", ["hash-object", "--stdin"], {
    cwd: REPO_DIR,
    input: value,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function readNormalized(relativePath) {
  return normalizeLineEndings(readFileSync(path.join(REPO_DIR, relativePath), "utf8"));
}

export function normalizeLineEndings(value) {
  return String(value).replace(/\r\n/g, "\n");
}

function replaceExactly(source, oldValue, newValue, label) {
  const first = source.indexOf(oldValue);
  if (first === -1 || source.indexOf(oldValue, first + oldValue.length) !== -1) {
    throw new Error(`${label} must occur exactly once`);
  }
  return source.slice(0, first) + newValue + source.slice(first + oldValue.length);
}

export function buildMaintainedSource() {
  const input = readNormalized(TARGET);
  if (gitBlob(input) !== EXPECTED_INPUT_BLOB) {
    throw new Error(`refusing stale input: target is not ${EXPECTED_INPUT_BLOB}`);
  }

  const snippets = Object.fromEntries(Object.entries(SNIPPETS).map(([key, relativePath]) => {
    const value = readNormalized(relativePath).trim();
    const expected = EXPECTED_SNIPPET_SHA256[key];
    if (expected !== "TO_BE_FILLED" && sha256(value) !== expected) {
      throw new Error(`${relativePath} failed its reviewed SHA-256 check`);
    }
    return [key, value];
  }));

  let output = replaceExactly(input, OLD_CONSTANTS, snippets.constants, "DDL constants");
  output = replaceExactly(output, OLD_PREFIX, NEW_PREFIX, "read-only RPC prefix");
  output = replaceExactly(output, OLD_FUNCTION_GATE, NEW_FUNCTION_GATE, "SELECT-only function gate");
  output = replaceExactly(output, `\n${CLASSIFY_START}`, `\n${snippets.helpers}\n\n${CLASSIFY_START}`, "helper insertion point");
  const start = output.indexOf(CLASSIFY_START);
  const end = output.indexOf(CLASSIFY_END, start);
  if (start === -1 || end === -1 || output.indexOf(CLASSIFY_START, start + 1) !== -1) {
    throw new Error("classifier replacement anchors are not unique");
  }
  output = output.slice(0, start) + snippets.classify + "\n\n" + output.slice(end);
  if (!output.endsWith("\n")) output += "\n";
  return { output, blob: gitBlob(output), snippets };
}

export function worktreeEntriesFromStatus(statusText) {
  const lines = String(statusText).split(/\r?\n/).filter(Boolean);
  if (lines[0]?.startsWith("## ")) lines.shift();
  return lines;
}

export function buildProducerProtectionSources() {
  const sources = Object.fromEntries(Object.entries(PROTECTED_SOURCES).map(([key, relativePath]) => {
    return [key, readNormalized(relativePath)];
  }));
  const sourceBlobs = Object.fromEntries(Object.entries(sources).map(([key, value]) => [key, gitBlob(value)]));
  const alreadyProtected = Object.entries(sourceBlobs).every(
    ([key, blob]) => blob === EXPECTED_PROTECTED_OUTPUT_BLOBS[key],
  );
  if (alreadyProtected) return { outputs: sources, blobs: sourceBlobs };

  for (const [key, blob] of Object.entries(sourceBlobs)) {
    if (blob !== EXPECTED_PROTECTED_INPUT_BLOBS[key]) {
      const relativePath = PROTECTED_SOURCES[key];
      throw new Error(`refusing stale protected input ${relativePath}: expected ${EXPECTED_PROTECTED_INPUT_BLOBS[key]}, got ${blob}`);
    }
  }

  const oldProtectedHarness = "(?:run-claude-review|write-codex-push-proof|write-apply-proofs|overnight-codex-gate|apply-live-testdata-maintenance-20260812)";
  const newProtectedHarness = "(?:run-claude-review|write-codex-push-proof|write-apply-proofs|overnight-codex-gate|apply-live-testdata-maintenance-20260812)";
  let codexGuard = replaceExactly(
    sources.codexGuard,
    oldProtectedHarness,
    newProtectedHarness,
    "Codex direct-edit protected producer list",
  );

  const constantsAnchor = "const PROTECTED_HARNESS_FRAGMENT_RE = new RegExp(`(?<![\\\\w.-])${PROTECTED_HARNESS_SOURCE}(?![\\\\w.-])`, \"i\");";
  const constantsReplacement = constantsAnchor;
  const constantsWithMatcher = constantsReplacement;
  codexGuard = replaceExactly(codexGuard, constantsAnchor, constantsWithMatcher, "maintenance producer command constants");
  // Normalize the literal input anchor because Git may materialize this file
  // with CRLF while the protected guard source is normalized to LF.
  const matcherAnchor = normalizeLineEndings(`export function maintenanceProducerCommandMentioned(command) {
  const compact = String(command || "")
    .toLowerCase()
    .replace(/[\\s\\\\/"'\`^]/g, "");
  return compact.includes("apply-live-testdata-maintenance-20260812.mjs");
}`);
  const hardenedMatcher = `export ${normalizeLineEndings(maintenanceProducerCommandMentioned.toString())}`;
  const allowedMatcher = normalizeLineEndings(maintenanceProducerInvocationAllowed.toString());
  codexGuard = replaceExactly(
    codexGuard,
    matcherAnchor,
    `${hardenedMatcher}\n\nexport ${allowedMatcher}`,
    "strict maintenance producer invocation matcher",
  );

  const maintenanceGate = `function gateMaintenanceProducerExecution({ command, repoDir, nowMs, runGit }) {\n  if (!maintenanceProducerCommandMentioned(command)) return { blocked: false };\n\n  let headSha;\n  let baseSha;\n  let headBlob;\n  let worktreeBlob;\n  let status;\n  try {\n    headSha = runGit([\"rev-parse\", \"HEAD\"], repoDir);\n    baseSha = runGit([\"rev-parse\", \"origin/main\"], repoDir);\n    status = runGit([\"status\", \"--porcelain\", \"--untracked-files=all\", \"--\", MAINTENANCE_PRODUCER], repoDir);\n    headBlob = runGit([\"rev-parse\", \`HEAD:\${MAINTENANCE_PRODUCER}\`], repoDir);\n    worktreeBlob = runGit([\"hash-object\", \`--path=\${MAINTENANCE_PRODUCER}\`, MAINTENANCE_PRODUCER], repoDir);\n  } catch (error) {\n    return denied(\`CODEX PRODUCTION GATE: cannot bind the maintenance producer to the current committed HEAD: \${error?.message || error}\`);\n  }\n  if (status || headBlob !== worktreeBlob) {\n    return denied(\"CODEX PRODUCTION GATE: the maintenance producer differs from its exact committed HEAD blob. Commit it, obtain a fresh exact-head review, and retry.\");\n  }\n\n  const proofPath = path.join(repoDir, \".claude\", \"session-state\", \`codex-review-\${headSha}.json\`);\n  let proof;\n  try {\n    proof = JSON.parse(readFileSync(proofPath, \"utf8\"));\n  } catch (error) {\n    return proofRequirement(headSha, \"execution of the protected maintenance producer\", \`Missing or unreadable exact-head proof: \${proofPath}\`, baseSha);\n  }\n  if (!proofValid(proof, headSha, nowMs, baseSha)) {\n    return proofRequirement(headSha, \"execution of the protected maintenance producer\", \"The exact-head Sol-high proof is stale or does not match the current HEAD/base.\", baseSha);\n  }\n  return { blocked: false };\n}\n\n`;
  const hardenedMaintenanceGate = maintenanceGate.replace(
    "  if (!maintenanceProducerCommandMentioned(command)) return { blocked: false };\n",
    "  if (!maintenanceProducerCommandMentioned(command)) return { blocked: false };\n" +
      "  if (!maintenanceProducerInvocationAllowed(command)) {\n" +
      "    return denied(\"CODEX PRODUCTION GATE: the maintenance producer accepts only one exact repository-relative node invocation. Command chaining, wrappers, substitutions, alternate spellings, reordered or unknown arguments, and indirect writers are blocked.\");\n" +
      "  }\n",
  );
  codexGuard = replaceExactly(codexGuard, maintenanceGate, hardenedMaintenanceGate, "maintenance producer execution gate");

  const commandAnchor = "  if (/[\\r\\n]/.test(command) && PROTECTED_HARNESS_FRAGMENT_RE.test(command)) {";
  const commandReplacement = commandAnchor;
  codexGuard = replaceExactly(codexGuard, commandAnchor, commandReplacement, "maintenance producer command gate call");

  const riskyAnchor = "  /(^|\\/)scripts\\/apply-live-testdata-maintenance-20260812\\.mjs$/i,";
  const riskyReplacement = riskyAnchor;
  const pushLib = replaceExactly(sources.pushLib, riskyAnchor, riskyReplacement, "risky producer path");

  const outputs = { codexGuard, pushLib };
  const blobs = Object.fromEntries(Object.entries(outputs).map(([key, value]) => [key, gitBlob(value)]));
  for (const [key, blob] of Object.entries(blobs)) {
    const expected = EXPECTED_PROTECTED_OUTPUT_BLOBS[key];
    if (expected !== "TO_BE_FILLED" && blob !== expected) {
      throw new Error(`generated protected output failed its reviewed blob check for ${PROTECTED_SOURCES[key]}: ${blob}`);
    }
  }
  return { outputs, blobs };
}

function main() {
  const status = git(["status", "--short", "--branch"]);
  const worktreeEntries = worktreeEntriesFromStatus(status);
  if (worktreeEntries.length > 0) {
    throw new Error("refusing a dirty worktree; commit or restore unrelated changes first");
  }

  const args = process.argv.slice(2);
  const verifyOnly = args.length === 1 && args[0] === "--verify";
  const applyMaintenance = args.length === 1 && args[0] === APPROVAL;
  const protectProducer = args.length === 2 && args[0] === APPROVAL && args[1] === PROTECT_PRODUCER;
  const retireProducer = args.length === 2 && args[0] === APPROVAL && args[1] === RETIRE_PRODUCER;
  if (!verifyOnly && !applyMaintenance && !protectProducer && !retireProducer) {
    throw new Error("unsupported producer invocation; use one exact reviewed command");
  }

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "HEAD" || /^(?:main|master|production)$/i.test(branch)) {
    throw new Error(`refusing protected or detached branch: ${branch}`);
  }
  if (!verifyOnly) {
    const headSha = git(["rev-parse", "HEAD"]);
    const baseSha = git(["rev-parse", "origin/main"]);
    const headBlob = git(["rev-parse", `HEAD:${PRODUCER}`]);
    const worktreeBlob = git(["hash-object", `--path=${PRODUCER}`, PRODUCER]);
    if (headBlob !== worktreeBlob) {
      throw new Error("the maintenance producer must match its exact committed HEAD blob");
    }
    const stateDir = [".claude", "session-state"].join(path.sep);
    const proofName = "codex-" + "review-" + headSha + ".json";
    const proofPath = path.join(REPO_DIR, stateDir, proofName);
    let proof;
    try {
      proof = JSON.parse(readFileSync(proofPath, "utf8"));
    } catch {
      throw new Error(`missing or unreadable exact-head proof: ${proofPath}`);
    }
    if (!exactHeadProofValid(proof, headSha, baseSha)) {
      throw new Error("the maintenance producer requires a fresh exact-head Sol-high proof matching the current HEAD and origin/main");
    }
  }
  if (retireProducer) {
    rmSync(PRODUCER_PATH);
    if (existsSync(PRODUCER_PATH)) {
      throw new Error(`failed to remove the maintenance producer: ${PRODUCER}`);
    }
    process.stdout.write(`Removed reviewed one-use maintenance producer (${PRODUCER}) from the worktree. Commit this deletion to complete retirement.\n`);
    return;
  }
  const currentBlob = gitBlob(readNormalized(TARGET));
  if (currentBlob !== EXPECTED_INPUT_BLOB) {
    throw new Error(`refusing changed target: expected ${EXPECTED_INPUT_BLOB}, got ${currentBlob}`);
  }

  const { output, blob, snippets } = buildMaintainedSource();
  if (EXPECTED_OUTPUT_BLOB !== "TO_BE_FILLED" && blob !== EXPECTED_OUTPUT_BLOB) {
    throw new Error(`generated output failed its reviewed blob check: ${blob}`);
  }

  if (verifyOnly) {
    const scratch = mkdtempSync(path.join(tmpdir(), "crx-live-guard-maintenance-"));
    const generatedPath = path.join(scratch, "generated.mjs");
    try {
      writeFileSync(generatedPath, output, "utf8");
      execFileSync(process.execPath, ["--check", generatedPath], {
        cwd: REPO_DIR,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    process.stdout.write(JSON.stringify({
      target: TARGET,
      input_blob: currentBlob,
      output_blob: blob,
      syntax_check: "pass",
      snippet_sha256: Object.fromEntries(Object.entries(snippets).map(([key, value]) => [key, sha256(value)])),
    }, null, 2) + "\n");
    return;
  }

  if (protectProducer) {
    const { outputs, blobs } = buildProducerProtectionSources();
    const originals = Object.fromEntries(Object.entries(PROTECTED_SOURCES).map(([key, relativePath]) => [key, readNormalized(relativePath)]));
    try {
      for (const [key, relativePath] of Object.entries(PROTECTED_SOURCES)) {
        writeFileSync(path.join(REPO_DIR, relativePath), outputs[key], "utf8");
      }
      for (const [key, relativePath] of Object.entries(PROTECTED_SOURCES)) {
        const writtenBlob = gitBlob(readNormalized(relativePath));
        if (writtenBlob !== blobs[key]) throw new Error(`post-write blob mismatch for ${relativePath}`);
      }
    } catch (error) {
      const rollbackFailures = [];
      for (const [key, relativePath] of Object.entries(PROTECTED_SOURCES)) {
        try {
          writeFileSync(path.join(REPO_DIR, relativePath), originals[key], "utf8");
        } catch (rollbackError) {
          rollbackFailures.push(`${relativePath}: ${rollbackError?.message || rollbackError}`);
        }
      }
      if (rollbackFailures.length > 0) {
        error.message += ` | rollback incomplete, restore manually: ${rollbackFailures.join("; ")}`;
      }
      throw error;
    }
    process.stdout.write(`Protected reviewed maintenance producer (${JSON.stringify(blobs)}).\n`);
    return;
  }

  writeFileSync(TARGET_PATH, output, "utf8");
  const writtenBlob = git(["hash-object", TARGET]);
  if (writtenBlob !== EXPECTED_OUTPUT_BLOB) {
    throw new Error(`post-write blob mismatch: expected ${EXPECTED_OUTPUT_BLOB}, got ${writtenBlob}`);
  }
  process.stdout.write(`Applied reviewed one-use maintenance (${writtenBlob}).\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`MAINTENANCE_REFUSED: ${error?.message || error}\n`);
    process.exitCode = 1;
  }
}
