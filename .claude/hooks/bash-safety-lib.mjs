// Shared dangerous-command pattern table for bash-safety.mjs (Bash|PowerShell
// PreToolUse) AND mcp-tool-guard.mjs (Desktop Commander start_process /
// interact_with_process PreToolUse). Single source of truth so a fix landed in
// one hook is a fix landed in both — Desktop Commander's process tools can run
// the exact same shell commands bash-safety.mjs was built to catch, and until
// this file existed, routing a command through Desktop Commander instead of the
// Bash tool silently skipped every one of these checks (2026-07-13 audit finding).
//
// Behavior of the checks below is UNCHANGED from the original inline bash-safety.mjs
// table — this is a pure extraction, plus one net-new pattern (shell-redirect writes
// to .env, explicitly called for by the audit) and the npm-script-indirection helpers.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export const SECURITY_COMMAND_CHAR_BUDGET = 16_384;
export const SECURITY_COMMAND_TOKEN_BUDGET = 512;
const commandExceedsSecurityBudget = (command) => String(command || "").length > SECURITY_COMMAND_CHAR_BUDGET;
const normalizePosixLineContinuations = (command) => String(command || "").replace(/\\\r?\n/g, "");

const MAINTENANCE_PRODUCER_NAME = "apply-live-testdata-maintenance-20260812.mjs";
const MAINTENANCE_PRODUCER_ALLOWED_COMMANDS = new Set([
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --approved-by-mason=2026-08-12",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --approved-by-mason=2026-08-12 --protect-producer",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --approved-by-mason=2026-08-12 --retire-producer",
]);

export function maintenanceProducerCommandMentioned(command, depth = 0) {
  const rawValue = String(command || "");
  if (commandExceedsSecurityBudget(rawValue)) return true;
  const value = normalizePosixLineContinuations(rawValue);
  const powerShellBoundaryVariant = value.replace(/\\([;&|])/g, "$1");
  if (powerShellBoundaryVariant !== value
    && (depth >= 4 || maintenanceProducerCommandMentioned(powerShellBoundaryVariant, depth + 1))) return true;
  const hasDynamicSyntax = (text) => /[*?\[\]{}$`@]|[<>]\(|\([^()\r\n]*\+[^()\r\n]*\)|\s-join(?:\s|$)|![^!\r\n]+!|%[^%\r\n]+%/i.test(text);
  const dynamicSyntax = hasDynamicSyntax(value);
  const tokenize = (text) => {
      const tokens = [];
      let current = "";
      let quote = "";
      let sawQuoted = false;
      let sawUnquoted = false;
      const push = () => {
        if (!current && !sawQuoted) return;
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
        if (char === "\\" && index + 1 < text.length) {
          current += char + text[index + 1];
          sawUnquoted = true;
          index += 1;
          continue;
        }
        if (char === "{" && text[index + 1] === "}") {
          current += "{}";
          sawUnquoted = true;
          index += 1;
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
  if (tokens.length > SECURITY_COMMAND_TOKEN_BUDGET) return true;
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
  const watchOperandStart = (list, start, end) => {
    let cursor = start;
    while (cursor < end) {
      const argument = normalizeShellOption(list[cursor].value);
      if (/^(?:--help|--version|-h|-v)$/.test(argument)) return { cursor, terminal: true, opaque: false };
      if (argument === "--") return { cursor: cursor + 1, terminal: false, opaque: false };
      if (/^(?:-n|--interval|-q|--equexit)$/.test(argument)) {
        if (cursor + 1 >= end) return { cursor, terminal: false, opaque: true };
        cursor += 2;
        continue;
      }
      if (/^(?:-n.+|-q.+|--(?:interval|equexit)=.+|-d(?:=.+)?|--differences(?:=.+)?|-[bcegptx]+|--(?:beep|color|errexit|chgexit|precise|no-title|exec))$/.test(argument)) {
        cursor += 1;
        continue;
      }
      if (argument.startsWith("-")) return { cursor, terminal: false, opaque: true };
      break;
    }
    return { cursor, terminal: false, opaque: false };
  };
  const invocationPosition = (list, index) => {
    let segmentStart = index;
    while (segmentStart > 0 && !list[segmentStart - 1].control) segmentStart -= 1;
    let cursor = segmentStart;
    const shellExecutionKeywords = new Set(["if", "then", "elif", "else", "while", "until", "do", "!"]);
    const shellExecutionKeyword = (token) => token
      && !token.control
      && !token.sawQuoted
      && shellExecutionKeywords.has(normalizeShellToken(token.value).toLowerCase());
    while (cursor < index && shellExecutionKeyword(list[cursor])) cursor += 1;
    while (cursor < index && /^[A-Za-z_]\w*\+?=/.test(list[cursor].value)) cursor += 1;
    let wrapperDepth = 0;
    for (; cursor < index && wrapperDepth < 8; wrapperDepth += 1) {
      const token = list[cursor];
      const named = (name) => executableNamed(token, name, true);
      if (named("command")) {
        cursor += 1;
        if (cursor < index && /^-[vV]$/.test(list[cursor].value)) return false;
        while (cursor < index && /^(?:-p|--)$/.test(list[cursor].value)) cursor += 1;
      } else if (named("coproc")) {
        cursor += 1;
        const directCommandNames = [
          "command", "time", "exec", "env", "find", "xargs", "parallel", "sudo", "doas",
          "wsl", "busybox", "toybox", "nohup", "nice", "timeout", "taskset", "ionice", "setsid", "stdbuf",
        ];
        const directCommand = directCommandNames.some((name) => executableNamed(list[cursor], name, true));
        if (cursor < index && !directCommand && /^[A-Za-z_]\w*$/.test(normalizeShellToken(list[cursor].value))) cursor += 1;
      } else if (named("time")) {
        cursor += 1;
        while (cursor < index) {
          const argument = normalizeShellOption(list[cursor].value);
          if (/^--(?:help|version)$/.test(argument)) return false;
          if (argument === "--") { cursor += 1; break; }
          if (/^(?:-o|--output|-f|--format)$/.test(argument)) { cursor += 2; continue; }
          if (/^(?:-o.+|-f.+|--(?:output|format)=.+|-[apvq]+|--(?:append|portability|quiet|verbose))$/.test(argument)) { cursor += 1; continue; }
          if (argument.startsWith("-")) return true;
          break;
        }
      } else if (named("watch")) {
        const parsed = watchOperandStart(list, cursor + 1, index);
        if (parsed.terminal) return false;
        if (parsed.opaque) return true;
        cursor = parsed.cursor;
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
          if (/^[A-Za-z_]\w*\+?=/.test(argument) || argument.startsWith("-")) { cursor += 1; continue; }
          break;
        }
      } else if (named(["fi", "nd"].join(""))) {
        cursor += 1;
        let runnerCursor = -1;
        for (let scan = cursor; scan < index; scan += 1) {
          if (/^-(?:exec|execdir|ok|okdir)$/.test(normalizeShellOption(list[scan].value))) runnerCursor = scan + 1;
        }
        if (runnerCursor < 0) return false;
        cursor = runnerCursor;
      } else if (named("xargs")) {
        cursor += 1;
        if (cursor < index && /^--(?:help|version)$/.test(list[cursor].value)) return false;
        while (cursor < index) {
          const argument = normalizeShellOption(list[cursor].value);
          if (argument === "--") { cursor += 1; break; }
          if (/^(?:-a|--arg-file|-d|--delimiter|-E|-I|-J|-L|-n|--max-args|-P|--max-procs|-R|-S|-s|--max-chars|--process-slot-var)$/.test(argument)) {
            cursor += 2;
            continue;
          }
          if (/^(?:-[adEIJLnPRSs].+|--(?:arg-file|delimiter|eof|replace|max-lines|max-args|max-procs|max-chars|process-slot-var)=.+|--(?:eof|replace|max-lines|null|open-tty|interactive|no-run-if-empty|show-limits|verbose|exit)|-[0oprtx]+|-[eil].*)$/.test(argument)) {
            cursor += 1;
            continue;
          }
          if (argument.startsWith("-")) return true;
          break;
        }
      } else if (named("parallel")) {
        for (let scan = cursor + 1; scan < index; scan += 1) {
          if (/^--(?:help|version)$/.test(normalizeShellOption(list[scan].value))) return false;
        }
        return true;
      } else if (["sudo", "doas"].some((name) => named(name))) {
        cursor += 1;
        while (cursor < index) {
          const argument = normalizeShellOption(list[cursor].value);
          if (/^(?:--help|--version|-V|-l|--list)$/.test(argument)) return false;
          if (argument === "--") { cursor += 1; break; }
          if (/^(?:-u|--user|-g|--group|-h|--host|-p|--prompt|-C|--close-from|-r|--role|-t|--type|-D|--chdir)$/.test(argument)) {
            cursor += 2;
            continue;
          }
          if (argument.startsWith("-") || /^[A-Za-z_]\w*\+?=/.test(argument)) { cursor += 1; continue; }
          break;
        }
      } else if (named("wsl")) {
        cursor += 1;
        while (cursor < index) {
          const argument = normalizeShellOption(list[cursor].value);
          if (/^(?:--help|--version|--status|--list|-l)$/.test(argument)) return false;
          if (argument === "--") { cursor += 1; break; }
          if (/^(?:-e|--exec)$/.test(argument)) { cursor += 1; break; }
          if (/^(?:-d|--distribution|-u|--user|--cd|--shell-type)$/.test(argument)) {
            cursor += 2;
            continue;
          }
          if (/^(?:--distribution|--user|--cd|--shell-type)=/.test(argument)) {
            cursor += 1;
            continue;
          }
          if (argument.startsWith("-")) { cursor += 1; continue; }
          break;
        }
      } else if (["busybox", "toybox"].some((name) => named(name))) {
        cursor += 1;
        if (cursor < index && /^(?:--help|--version|--list|--list-full|--install)$/.test(normalizeShellOption(list[cursor].value))) return false;
        if (cursor < index && list[cursor].value === "--") cursor += 1;
      } else if (named("ionice")) {
        cursor += 1;
        let processMode = false;
        while (cursor < index && list[cursor].value.startsWith("-")) {
          const argument = normalizeShellOption(list[cursor].value);
          if (/^(?:--help|--version|-h|-V)$/.test(argument)) return false;
          if (argument === "--") { cursor += 1; break; }
          if (/^(?:-p|-P|-u|--pid|--pgid|--uid)$/.test(argument)) processMode = true;
          if (/^(?:-c|-n|-p|-P|-u|--class|--classdata|--pid|--pgid|--uid)$/.test(argument)) { cursor += 2; continue; }
          if (/^(?:-[cnpPu].+|--(?:class|classdata|pid|pgid|uid)=.+|-t|--ignore)$/.test(argument)) { cursor += 1; continue; }
          return true;
        }
        if (processMode || cursor >= index) return false;
      } else if (named("taskset")) {
        cursor += 1;
        let pidMode = false;
        while (cursor < index && list[cursor].value.startsWith("-")) {
          const argument = normalizeShellOption(list[cursor].value);
          if (/^--(?:help|version)$/.test(argument)) return false;
          if (argument === "--") { cursor += 1; break; }
          if (/^(?:-p|--pid)$/.test(argument) || /^-[ac]*p[ac]*$/.test(argument)) pidMode = true;
          if (/^(?:-[acp]+|--(?:all-tasks|cpu-list|pid))$/.test(argument)) { cursor += 1; continue; }
          return true;
        }
        if (pidMode || cursor >= index) return false;
        cursor += 1;
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
      while (cursor < index && /^[A-Za-z_]\w*\+?=/.test(list[cursor].value)) cursor += 1;
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
    return list.slice(segmentStart, index).every((entry) => /^[A-Za-z_]\w*\+?=/.test(entry.value));
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
  if (tokens.some(dynamicPowerShellProcessLauncher)) return true;
  const powerShellNodeOptionsMutation = (token, index, list) => {
    if (!invocationPosition(list, index)) return false;
    const cmdlet = ["set-item", "new-item", "set-content", "add-content", "clear-item", "remove-item"]
      .some((name) => executableNamed(token, name, true));
    if (!cmdlet) return false;
    for (let cursor = index + 1; cursor < list.length && !list[cursor].control; cursor += 1) {
      if (/^env:\\?(?:node_options|npm_config_node_options)$/i.test(normalizeShellToken(list[cursor].value))) return true;
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
    // AWK programs can construct and execute a command through system(), so
    // their source is as opaque to this static gate as an inline Python eval.
    const awk = ["awk", "gawk", "mawk", "nawk"].some((name) => executableNamed(token, name, true));
    if (!(python || nodeLike || shortEval || php || deno || shell || awk)) return false;
    let segmentStart = index;
    while (segmentStart > 0 && !list[segmentStart - 1].control) segmentStart -= 1;
    if (list[segmentStart - 1]?.value === "|") return true;
    let segmentEnd = index + 1;
    while (segmentEnd < list.length && !list[segmentEnd].control) segmentEnd += 1;
    if (shell && list[segmentEnd]?.value === "<") return true;
    if (awk) {
      const firstArgument = normalizeShellToken(list[index + 1]?.value || "");
      return !/^(?:--help|--version|-h|-V)$/.test(firstArgument);
    }
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
  const nestedParallelCommand = (token, index, list) => {
    if (!executableNamed(token, "parallel", true) || !invocationPosition(list, index)) return false;
    let segmentEnd = index + 1;
    while (segmentEnd < list.length && !list[segmentEnd].control) segmentEnd += 1;
    const remaining = list.slice(index + 1, segmentEnd);
    const terminator = remaining.findIndex((entry) => normalizeShellOption(entry.value) === "--");
    const optionTokens = terminator >= 0 ? remaining.slice(0, terminator) : remaining;
    if (optionTokens.some((entry) => /^--(?:help|version)$/.test(normalizeShellOption(entry.value)))) return false;
    const bodyTokens = terminator >= 0 ? remaining.slice(terminator + 1) : remaining;
    for (const entry of bodyTokens.filter((candidate) => candidate.sawQuoted)) {
      if (depth >= 4 || maintenanceProducerCommandMentioned(entry.value, depth + 1)) return true;
    }
    if (terminator < 0) return false;
    const body = bodyTokens.map((entry) => entry.value).join(" ");
    return Boolean(body) && (depth >= 4 || maintenanceProducerCommandMentioned(body, depth + 1));
  };
  if (tokens.some(nestedParallelCommand)) return true;
  const nestedWatchCommand = (token, index, list) => {
    if (!executableNamed(token, "watch", true) || !invocationPosition(list, index)) return false;
    let segmentEnd = index + 1;
    while (segmentEnd < list.length && !list[segmentEnd].control) segmentEnd += 1;
    const parsed = watchOperandStart(list, index + 1, segmentEnd);
    if (parsed.terminal) return false;
    if (parsed.opaque) return true;
    const body = list.slice(parsed.cursor, segmentEnd).map((entry) => entry.value).join(" ");
    if (!body) return false;
    return depth >= 4 || maintenanceProducerCommandMentioned(body, depth + 1);
  };
  if (tokens.some(nestedWatchCommand)) return true;
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
      // Re-enter the complete policy for nested command bodies. Calling only
      // analyzeTokens here omits top-level runner checks such as PowerShell
      // process launchers, watch, and GNU Parallel.
      return maintenanceProducerCommandMentioned(text, depth);
    }
    function analyzeTokens(candidateTokens, depth) {
      if (dynamicSyntax && candidateTokens.some(nodeExecutable)) return true;
      if (candidateTokens.some(opaqueInlineInterpreterInvocation)) return true;
      for (let index = 0; index < candidateTokens.length; index += 1) {
        if ((candidateTokens[index].value === "." || executableNamed(candidateTokens[index], "source", true))
          && invocationPosition(candidateTokens, index)) return true;
        if (executableNamed(candidateTokens[index], "eval", true) && invocationPosition(candidateTokens, index)) {
          let bodyEnd = index + 1;
          while (bodyEnd < candidateTokens.length && !candidateTokens[bodyEnd].control) bodyEnd += 1;
          const body = candidateTokens.slice(index + 1, bodyEnd).map((entry) => entry.value).join(" ");
          if (!body || hasDynamicSyntax(body) || depth >= maxNestedShellDepth || analyzeText(body, depth + 1)) return true;
        }
        if (executableNamed(candidateTokens[index], "env") && invocationPosition(candidateTokens, index)) {
          for (let cursor = index + 1; cursor < candidateTokens.length && !candidateTokens[cursor].control; cursor += 1) {
            const argument = normalizeShellToken(candidateTokens[cursor].value);
            if (argument === "--") break;
            const shortSplit = /^-[i0v]*S(.*)$/.exec(argument);
            const longSplit = /^--split-string(?:=(.*))?$/.exec(argument);
            if (shortSplit || longSplit) {
              const attached = shortSplit?.[1] || longSplit?.[1] || "";
              const commandText = attached || candidateTokens[cursor + 1]?.value || "";
              if (!commandText || hasDynamicSyntax(commandText) || depth >= maxNestedShellDepth || analyzeText(`env ${commandText}`, depth + 1)) return true;
              break;
            }
            if (/^(?:-u|--unset|-C|--chdir|-a|--argv0)$/.test(argument)) {
              cursor += 1;
              continue;
            }
            if (/^[A-Za-z_]\w*\+?=/.test(argument) || argument.startsWith("-")) continue;
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
    if (analyzeTokens(tokens, depth)) return true;
  }
  const nodeScript = /\bnode(?:\.exe)?\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/i.exec(value);
  const scriptPath = nodeScript?.[1] || nodeScript?.[2] || nodeScript?.[3] || "";
  if (/[*?\[\]]|\$\(|\$\{/.test(scriptPath)) return true;
  const compact = value
    .toLowerCase()
    .replace(/[\s\\/"'`^]/g, "");
  return compact.includes(MAINTENANCE_PRODUCER_NAME)
    || compact.includes("--approved-by-mason=");
}

export function checkMaintenanceProducerInvocation(command) {
  const value = String(command || "").trim();
  if (!maintenanceProducerCommandMentioned(value)) return null;
  if (MAINTENANCE_PRODUCER_ALLOWED_COMMANDS.has(value)) return null;
  return "Blocked maintenance producer invocation. Use one exact repository-relative node command only; chaining, wrappers, substitutions, alternate spellings, reordered or unknown arguments, and indirect writers are denied.";
}

function tokenizeShellWords(text) {
  const tokens = [];
  let current = "";
  let quote = "";
  let sawQuoted = false;
  let sawUnquoted = false;
  const push = () => {
    if (!current && !sawQuoted) return;
    tokens.push({ value: current, control: false, sawQuoted, sawUnquoted });
    current = "";
    sawQuoted = false;
    sawUnquoted = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === "\\" && index + 1 < text.length) {
      current += char + text[index + 1];
      sawUnquoted = true;
      index += 1;
      continue;
    }
    if (char === "{" && text[index + 1] === "}") {
      current += "{}";
      sawUnquoted = true;
      index += 1;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      sawQuoted = true;
    }
    else if (char === "\r" || char === "\n") {
      push();
      tokens.push({ value: "\n", control: true, sawQuoted: false, sawUnquoted: true });
      if (char === "\r" && text[index + 1] === "\n") index += 1;
    } else if (/\s/.test(char)) push();
    else if (/[;&|(){}<>]/.test(char)) {
      push();
      tokens.push({ value: char, control: true, sawQuoted: false, sawUnquoted: true });
    } else {
      current += char;
      sawUnquoted = true;
    }
  }
  push();
  return tokens;
}

function nodeOptionsAssignmentMentioned(command, depth = 0) {
  const rawValue = String(command || "");
  if (commandExceedsSecurityBudget(rawValue)) return true;
  const value = normalizePosixLineContinuations(rawValue);
  const powerShellBoundaryVariant = value.replace(/\\([;&|])/g, "$1");
  if (powerShellBoundaryVariant !== value
    && (depth >= 4 || nodeOptionsAssignmentMentioned(powerShellBoundaryVariant, depth + 1))) return true;
  const tokens = tokenizeShellWords(value);
  const shellWordCandidates = (token) => {
    const raw = String(token?.value || "");
    const normalized = raw
      .replace(/\\([^\\/])/g, "$1")
      .replace(/\^([^^])/g, "$1")
      .replace(/`([^`])/g, "$1");
    return [raw, normalized];
  };
  const recognizedExecutables = new Set([
    "command", "builtin", "env", "wsl", "busybox", "toybox", "find", "xargs",
    "parallel", "sudo", "doas", "coproc", "time", "watch", "exec", "nohup", "nice", "timeout", "taskset", "ionice", "setsid", "stdbuf",
    "cmd", "powershell", "pwsh", "bash", "sh", "dash", "zsh", "ksh",
    "eval", "source", ".", "node", "nodejs", "export", "declare", "typeset",
    "local", "readonly", "set", "setx", "printf", "read",
    "npm", "npx", "pnpm", "yarn", "bun", "corepack",
  ]);
  const assignmentName = (token) => shellWordCandidates(token)
    .map((candidate) => /^([A-Za-z_]\w*)\+?=/.exec(candidate)?.[1]?.toLowerCase() || "")
    .find(Boolean) || "";
  const executableName = (token) => shellWordCandidates(token)
    .map((candidate) => candidate.replace(/^@/, "").split(/[\\/]/).pop().replace(/\.exe$/i, "").toLowerCase())
    .find((candidate) => recognizedExecutables.has(candidate)) || "";
  const nodeOptionsNames = new Set(["node_options", "npm_config_node_options"]);
  const isNodeOptionsName = (name) => nodeOptionsNames.has(String(name || "").toLowerCase());
  const hasNodeOptionsAssignment = (token) => isNodeOptionsName(assignmentName(token));
  const namesNodeOptionsVariable = (token) => shellWordCandidates(token)
    .some((candidate) => /^(?:node_options|npm_config_node_options)(?:\[[^\]]*\])?(?:\+?=|$)/i.test(candidate));
  const hasDynamicVariableName = (token) => shellWordCandidates(token)
    .some((candidate) => /(?:\$\{|\$[A-Za-z_]|`|![^!\r\n]+!|%[^%\r\n]+%)/.test(candidate));
  const powerShellEnvNodeOptionsTarget = (token) => token?.sawUnquoted && shellWordCandidates(token)
    .some((candidate) => /^\$env\s*:\s*(?:node_options|npm_config_node_options)(?:\+?=|$)/i.test(candidate));
  const unquotedExecutableBasename = (token) => {
    if (!token?.sawUnquoted) return "";
    return shellWordCandidates(token)
      .map((candidate) => candidate.replace(/^[@&]/, "").split(/[\\/]/).pop().replace(/\.exe$/i, "").toLowerCase())
      .find(Boolean) || "";
  };
  const shellExecutionKeywords = new Set(["if", "then", "elif", "else", "while", "until", "do", "!"]);
  const shellExecutionKeyword = (token) => !token?.sawQuoted && shellWordCandidates(token)
    .some((candidate) => shellExecutionKeywords.has(candidate.toLowerCase()));
  const powerShellMutationCommands = new Set([
    "set-item", "si", "set-content", "sc", "new-item", "ni", "add-content", "ac",
  ]);
  for (const nameParts of [
    ["co", "py-item"], ["c", "pi"], ["c", "p"], ["co", "py"],
    ["mo", "ve-item"], ["m", "i"], ["m", "ove"], ["m", "v"],
    ["re", "name-item"], ["r", "ni"], ["r", "en"],
    ["re", "mo", "ve-item"], ["r", "i"], ["r", "m"], ["r", "m", "dir"], ["d", "el"], ["e", "rase"], ["r", "d"],
    ["c", "lear-item"], ["c", "li"],
  ]) powerShellMutationCommands.add(nameParts.join(""));
  const powerShellAliasDefinitionCommands = new Set(["set-alias", "sal", "new-alias", "nal"]);
  const powerShellReadCommands = new Set([
    "write-output", "echo", "write-host",
    "get-item", "gi", "get-childitem", "gci", "dir", "ls",
    "get-content", "gc", "cat", "type", "test-path", "resolve-path",
  ]);

  const tokenNamed = (token, names) => {
    if (!token || token.control || (token.sawQuoted && !/[\\/]/.test(token.value))) return false;
    return shellWordCandidates(token).some((candidate) => {
      const basename = candidate.replace(/^@/, "").split(/[\\/]/).pop().replace(/\.exe$/i, "").toLowerCase();
      return names.includes(basename);
    });
  };
  const hasDynamicAssignmentName = (token) => shellWordCandidates(token).some((candidate) => {
    const equalsIndex = candidate.indexOf("=");
    if (equalsIndex <= 0) return false;
    return /(?:\$\{|\$[A-Za-z_]|`|![^!\r\n]+!|%[^%\r\n]+%)/.test(candidate.slice(0, equalsIndex));
  });
  const nodeBackedExecutables = new Set(["node", "nodejs", "npm", "npx", "pnpm", "yarn", "bun", "corepack"]);
  const nodeBackedRunnerWrappers = new Set([
    "command", "builtin", "env", "wsl", "busybox", "toybox", "find", "xargs", "parallel",
    "sudo", "doas", "coproc", "time", "watch", "exec", "nohup", "nice", "timeout", "taskset", "ionice", "setsid", "stdbuf",
  ]);
  const tokenListMentionsNodeBackedCommand = (list) => {
    for (let start = 0; start < list.length;) {
      while (start < list.length && list[start].control) start += 1;
      let end = start;
      while (end < list.length && !list[end].control) end += 1;
      let cursor = start;
      while (cursor < end && (shellExecutionKeyword(list[cursor]) || assignmentName(list[cursor]))) cursor += 1;
      const commandName = executableName(list[cursor]);
      if (nodeBackedExecutables.has(commandName)) return true;
      if (nodeBackedRunnerWrappers.has(commandName)
        && list.slice(cursor + 1, end).some((entry) => nodeBackedExecutables.has(executableName(entry)))) return true;
      start = end + 1;
    }
    return false;
  };
  const nestedLauncherMentionsNodeBackedCommand = tokens.some((token, index) => {
    if (!token?.sawUnquoted) return false;
    const launcher = executableName(token);
    const argumentsAfterLauncher = tokens.slice(index + 1);
    let body = "";
    if (launcher === "cmd") {
      const switchIndex = argumentsAfterLauncher.findIndex((entry) => /^(?:\/[a-z](?::[a-z]+)?)*\/[ck]/i.test(entry.value));
      if (switchIndex < 0) return false;
      const commandSwitch = argumentsAfterLauncher[switchIndex].value;
      body = [commandSwitch.replace(/^(?:\/[a-z](?::[a-z]+)?)*\/[ck]/i, ""), ...argumentsAfterLauncher.slice(switchIndex + 1).map((entry) => entry.value)]
        .filter(Boolean)
        .join(" ");
    } else if (["powershell", "pwsh"].includes(launcher)) {
      const powerShellCommandSwitch = /^(?:(?:--?|\/)c|(?:--?|\/)co(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?|(?:--?|\/)cwa|(?:--?|\/)commandw[a-z]*)(?:[:=].*)?$/i;
      const switchIndex = argumentsAfterLauncher.findIndex((entry) => powerShellCommandSwitch.test(entry.value));
      if (switchIndex < 0) return false;
      const commandSwitch = argumentsAfterLauncher[switchIndex].value;
      const attached = commandSwitch.replace(/^(?:(?:--?|\/)c|(?:--?|\/)co(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?|(?:--?|\/)cwa|(?:--?|\/)commandw[a-z]*)[:=]?/i, "");
      body = [attached, ...argumentsAfterLauncher.slice(switchIndex + 1).map((entry) => entry.value)].filter(Boolean).join(" ");
    } else if (["bash", "sh", "dash", "zsh", "ksh"].includes(launcher)) {
      const switchIndex = argumentsAfterLauncher.findIndex((entry) => /^-[A-Za-z]*c[A-Za-z]*$/.test(entry.value));
      if (switchIndex < 0) return false;
      body = argumentsAfterLauncher.slice(switchIndex + 1).map((entry) => entry.value).join(" ");
    } else return false;
    return tokenListMentionsNodeBackedCommand(tokenizeShellWords(body));
  });
  const nodeBackedCommandMentioned = tokenListMentionsNodeBackedCommand(tokens)
    || nestedLauncherMentionsNodeBackedCommand;
  const powerShellProviderMutation = tokens.some((token, index) => {
    const commandName = shellWordCandidates(token)
      .map((candidate) => candidate.replace(/^[@&]/, "").split(/[\\/]/).pop().replace(/\.exe$/i, "").toLowerCase())
      .find((candidate) => powerShellMutationCommands.has(candidate));
    if (!commandName) return false;
    let segmentStart = index;
    while (segmentStart > 0 && !tokens[segmentStart - 1].control) segmentStart -= 1;
    let commandCursor = segmentStart;
    while (commandCursor < index && (shellExecutionKeyword(tokens[commandCursor]) || assignmentName(tokens[commandCursor]))) commandCursor += 1;
    if (commandCursor !== index) return false;
    let segmentEnd = index + 1;
    while (segmentEnd < tokens.length && !tokens[segmentEnd].control) segmentEnd += 1;
    const operandCandidates = tokens.slice(index + 1, segmentEnd).flatMap(shellWordCandidates);
    const touchesEnvironmentProvider = operandCandidates.some((candidate) => /^env:\\?/i.test(candidate));
    const namesNodeOptions = operandCandidates.some((candidate) => /^(?:env:\\?)?(?:node_options|npm_config_node_options)$/i.test(candidate));
    return touchesEnvironmentProvider && namesNodeOptions;
  });
  const powerShellMutationCommandInPosition = tokens.some((token, index) => {
    if (!powerShellMutationCommands.has(unquotedExecutableBasename(token))) return false;
    let segmentStart = index;
    while (segmentStart > 0 && !tokens[segmentStart - 1].control) segmentStart -= 1;
    let commandCursor = segmentStart;
    while (commandCursor < index && (shellExecutionKeyword(tokens[commandCursor]) || assignmentName(tokens[commandCursor]))) commandCursor += 1;
    return commandCursor === index;
  });
  const powerShellComputedMutation = nodeBackedCommandMentioned
    && powerShellMutationCommandInPosition
    && /(?:\(|\$\{|\$[A-Za-z_]|@\(|\s-join(?:\s|$)|\+)/i.test(value);
  const compactDynamicTarget = value.toLowerCase().replace(/[\s"'`^+$()[\]{},]/g, "");
  const powershellMutation = tokens.some((token) => powerShellMutationCommands.has(unquotedExecutableBasename(token)))
    && ["env:node_options", "env:npm_config_node_options"].some((target) => compactDynamicTarget.includes(target))
    && /(?:\+|\s-join(?:\s|$)|\$\(|@\()/i.test(value);
  const powerShellDynamicEnvMutation = tokens.some((token) => powerShellMutationCommands.has(unquotedExecutableBasename(token)))
    && /(?:env:|env:\\)\s*\$(?:\(|\{?[A-Za-z_])/i.test(value);
  const powerShellAliasDefinition = tokens.some((token, index) => {
    if (!powerShellAliasDefinitionCommands.has(unquotedExecutableBasename(token))) return false;
    let segmentStart = index;
    while (segmentStart > 0 && !tokens[segmentStart - 1].control) segmentStart -= 1;
    let commandCursor = segmentStart;
    while (commandCursor < index && (shellExecutionKeyword(tokens[commandCursor]) || assignmentName(tokens[commandCursor]))) commandCursor += 1;
    if (commandCursor !== index) return false;
    let segmentEnd = index + 1;
    while (segmentEnd < tokens.length && !tokens[segmentEnd].control) segmentEnd += 1;

    const operands = tokens.slice(index + 1, segmentEnd);
    const positionals = [];
    let explicitValue = null;
    let explicitName = false;
    let unrecognizedParameter = false;
    for (let operandIndex = 0; operandIndex < operands.length; operandIndex += 1) {
      const operand = operands[operandIndex];
      const candidates = shellWordCandidates(operand);
      const attachedValue = candidates
        .map((candidate) => candidate.match(/^-v(?:a(?:l(?:u(?:e)?)?)?)?(?::|=)(.+)$/i)?.[1])
        .find(Boolean);
      if (attachedValue) {
        explicitValue = attachedValue;
        continue;
      }
      if (candidates.some((candidate) => /^-v(?:a(?:l(?:u(?:e)?)?)?)?$/i.test(candidate))) {
        explicitValue = shellWordCandidates(operands[operandIndex + 1])[0] || null;
        operandIndex += 1;
        continue;
      }
      if (candidates.some((candidate) => /^-n(?:a(?:m(?:e)?)?)?$/i.test(candidate))) {
        explicitName = true;
        operandIndex += 1;
        continue;
      }
      if (candidates.some((candidate) => /^-n(?:a(?:m(?:e)?)?)?(?::|=).+/i.test(candidate))) {
        explicitName = true;
        continue;
      }
      if (candidates.some((candidate) => /^-(?:description|option|scope)$/i.test(candidate))) {
        operandIndex += 1;
        continue;
      }
      if (candidates.some((candidate) => /^-(?:passthru|force|whatif|confirm|verbose|debug)$/i.test(candidate))) continue;
      if (candidates.some((candidate) => /^-/i.test(candidate))) {
        unrecognizedParameter = true;
        continue;
      }
      positionals.push(candidates[0] || "");
    }
    if (unrecognizedParameter) return true;
    const aliasTarget = explicitValue || positionals[explicitName ? 0 : 1] || "";
    if (!aliasTarget && ["(", "{"].includes(tokens[segmentEnd]?.value)) return true;
    if (aliasTarget && !/^[@&]?(?:[A-Za-z]:)?[A-Za-z0-9_.:/\\-]+$/.test(aliasTarget)) return true;
    const targetBasename = aliasTarget.replace(/^[@&]/, "").split(/[\\/]/).pop().replace(/\.exe$/i, "").toLowerCase();
    return powerShellMutationCommands.has(targetBasename);
  });
  const dotNetMutation = /setenvironmentvariable/i.test(value)
    && ["setenvironmentvariablenode_options", "setenvironmentvariablenpm_config_node_options"]
      .some((target) => compactDynamicTarget.includes(target));
  const standalonePowerShellEnvMutation = tokens.some((target, index) => {
    if (!target?.sawUnquoted || !shellWordCandidates(target)
      .some((candidate) => /^(?:\$env:(?:node_options|npm_config_node_options)(?:\+?=)?|(?:env:|env:\\)(?:node_options|npm_config_node_options))$/i.test(candidate))) return false;
    let segmentStart = index;
    while (segmentStart > 0 && !tokens[segmentStart - 1].control) segmentStart -= 1;
    const segmentCommand = unquotedExecutableBasename(tokens[segmentStart]);
    return /^\+?=/.test(String(tokens[index + 1]?.value || ""))
      || shellWordCandidates(target).some((candidate) => /\+?=/i.test(candidate))
      || (tokens.slice(segmentStart, index).some((entry) => entry?.sawUnquoted)
        && !powerShellReadCommands.has(segmentCommand));
  });
  const standaloneCmdSetMutation = tokens.some((token, index) => unquotedExecutableBasename(token) === "set"
    && tokens.slice(index + 1).some((entry) => entry?.sawUnquoted && hasNodeOptionsAssignment(entry)));
  const cmdDelayedMutation = tokens.some((token) => tokenNamed(token, ["cmd"]))
    && /\/v(?::on)?(?:\s|$)/i.test(value)
    && /\bset\s+(?:![^!\r\n]+!)+\+?=/i.test(value);
  if (powerShellProviderMutation || powerShellComputedMutation || powershellMutation || powerShellDynamicEnvMutation || powerShellAliasDefinition
    || dotNetMutation || standalonePowerShellEnvMutation || standaloneCmdSetMutation || cmdDelayedMutation) return true;
  if (nodeBackedCommandMentioned) {
    const dynamicAssignmentBuiltin = tokens.some((token) => tokenNamed(token, ["export", "declare", "typeset", "local", "readonly"]))
      && /(?:\$\(|`[^`]*`|<\(|>\(|\$\{|\$[A-Za-z_]|![^!\r\n]+!|%[^%\r\n]+%)/s.test(value);
    const dynamicPosixEnv = tokens.some((token) => tokenNamed(token, ["env"]))
      && (/(?:\$\(|`[^`]*`|<\()/s.test(value) || tokens.some(hasDynamicAssignmentName));
    if (dynamicAssignmentBuiltin || dynamicPosixEnv) return true;
  }

  let allexportEnabled = false;
  for (let segmentStart = 0; segmentStart < tokens.length;) {
    while (segmentStart < tokens.length && tokens[segmentStart].control) segmentStart += 1;
    let segmentEnd = segmentStart;
    while (segmentEnd < tokens.length && !tokens[segmentEnd].control) segmentEnd += 1;
    const segmentTokens = tokens.slice(segmentStart, segmentEnd);
    if (nodeBackedCommandMentioned) {
      const hasExplicitUnquotedAssignment = segmentTokens
        .some((token) => token?.sawUnquoted && hasNodeOptionsAssignment(token));
      const commandPrefix = unquotedExecutableBasename(segmentTokens[0]);
      if (hasExplicitUnquotedAssignment && ["call", "if"].includes(commandPrefix)) return true;
      for (let scan = 0; scan < segmentTokens.length; scan += 1) {
        const token = segmentTokens[scan];
        if (powerShellEnvNodeOptionsTarget(token)) {
          const candidates = shellWordCandidates(token);
          const attachedAssignment = candidates.some((candidate) => /^\$env\s*:\s*(?:node_options|npm_config_node_options)\+?=/i.test(candidate));
          const separatedAssignment = /^\+?=/.test(String(segmentTokens[scan + 1]?.value || ""));
          if (attachedAssignment || separatedAssignment) return true;
        }
        const commandName = unquotedExecutableBasename(token);
        if (powerShellMutationCommands.has(commandName)) {
          const targetTokens = segmentTokens.slice(scan + 1);
          if (targetTokens.some((target) => target.sawUnquoted
            && shellWordCandidates(target).some((candidate) => /^(?:env:|env:\\)(?:node_options|npm_config_node_options)$/i.test(candidate)))) return true;
        }
        const unquotedDotNetMutation = token?.sawUnquoted && shellWordCandidates(token)
          .some((candidate) => /setenvironmentvariable/i.test(candidate));
        if (unquotedDotNetMutation && tokens.some((target) => shellWordCandidates(target)
          .some((candidate) => /node_options/i.test(candidate)))) return true;
      }
    }
    let cursor = segmentStart;

    const skipAssignments = () => {
      while (cursor < segmentEnd && assignmentName(tokens[cursor])) {
        if (hasNodeOptionsAssignment(tokens[cursor])) return true;
        cursor += 1;
      }
      return false;
    };

    while (cursor < segmentEnd && shellExecutionKeyword(tokens[cursor])) cursor += 1;
    if (skipAssignments()) return true;
    while (cursor < segmentEnd) {
      const name = executableName(tokens[cursor]);
      const inspectNestedCommand = (body) => {
        if (!body) return false;
        if (depth >= 4) return true;
        return nodeOptionsAssignmentMentioned(body, depth + 1);
      };
      if (allexportEnabled && nodeBackedExecutables.has(name)) return true;
      if (name === "command") {
        cursor += 1;
        if (cursor < segmentEnd && /^-[vV]$/.test(tokens[cursor].value)) break;
        while (cursor < segmentEnd && /^(?:-p|--)$/.test(tokens[cursor].value)) cursor += 1;
        if (skipAssignments()) return true;
        continue;
      }
      if (name === "env") {
        cursor += 1;
        while (cursor < segmentEnd) {
          const argument = tokens[cursor].value;
          if (/^--(?:help|version)$/.test(argument)) break;
          if (argument === "--") { cursor += 1; break; }
          const shortSplitString = /^-[i0v]*S(.*)$/.exec(argument);
          const longSplitString = /^--split-string(?:=(.*))?$/.exec(argument);
          if (shortSplitString || longSplitString) {
            const hasAttachedValue = shortSplitString
              ? shortSplitString[1].length > 0
              : argument.includes("=");
            const attachedValue = shortSplitString?.[1] ?? longSplitString?.[1] ?? "";
            const splitCommand = hasAttachedValue ? attachedValue : tokens[cursor + 1]?.value || "";
            if (inspectNestedCommand(`env ${splitCommand}`)) return true;
            cursor += hasAttachedValue ? 1 : 2;
            continue;
          }
          if (/^(?:-u|--unset|-C|--chdir|-a|--argv0)$/.test(argument)) { cursor += 2; continue; }
          if (argument.startsWith("-") && !assignmentName(tokens[cursor])) { cursor += 1; continue; }
          if (hasNodeOptionsAssignment(tokens[cursor])) return true;
          if (assignmentName(tokens[cursor])) { cursor += 1; continue; }
          break;
        }
        if (skipAssignments()) return true;
        continue;
      }
      if (name === "coproc") {
        cursor += 1;
        if (cursor + 1 < segmentEnd
          && !executableName(tokens[cursor])
          && !assignmentName(tokens[cursor])
          && /^[A-Za-z_]\w*$/.test(tokens[cursor].value)) cursor += 1;
        if (skipAssignments()) return true;
        continue;
      }
      if (name === "time") {
        cursor += 1;
        let terminalMode = false;
        while (cursor < segmentEnd) {
          const argument = tokens[cursor].value;
          if (/^--(?:help|version)$/.test(argument)) { terminalMode = true; break; }
          if (argument === "--") { cursor += 1; break; }
          if (/^(?:-o|--output|-f|--format)$/.test(argument)) { cursor += 2; continue; }
          if (/^(?:-o.+|-f.+|--(?:output|format)=.+|-[apvq]+|--(?:append|portability|quiet|verbose))$/.test(argument)) { cursor += 1; continue; }
          if (argument.startsWith("-")) {
            if (tokens.slice(cursor + 1, segmentEnd).some(hasNodeOptionsAssignment)) return true;
            break;
          }
          break;
        }
        if (terminalMode) break;
        if (skipAssignments()) return true;
        continue;
      }
      if (name === "watch") {
        cursor += 1;
        let terminalMode = false;
        while (cursor < segmentEnd) {
          const argument = tokens[cursor].value;
          if (/^(?:--help|--version|-h|-v)$/.test(argument)) { terminalMode = true; break; }
          if (argument === "--") { cursor += 1; break; }
          if (/^(?:-n|--interval|-q|--equexit)$/.test(argument)) {
            if (cursor + 1 >= segmentEnd) return true;
            cursor += 2;
            continue;
          }
          if (/^(?:-n.+|-q.+|--(?:interval|equexit)=.+|-d(?:=.+)?|--differences(?:=.+)?|-[bcegptx]+|--(?:beep|color|errexit|chgexit|precise|no-title|exec))$/.test(argument)) { cursor += 1; continue; }
          if (argument.startsWith("-")) {
            const remaining = tokens.slice(cursor + 1, segmentEnd).map((token) => token.value).join(" ");
            if (tokens.slice(cursor + 1, segmentEnd).some(hasNodeOptionsAssignment) || inspectNestedCommand(remaining)) return true;
            break;
          }
          break;
        }
        if (terminalMode) break;
        const body = tokens.slice(cursor, segmentEnd).map((token) => token.value).join(" ");
        if (inspectNestedCommand(body)) return true;
        break;
      }
      if (name === "builtin") {
        cursor += 1;
        if (cursor < segmentEnd && tokens[cursor].value === "--") cursor += 1;
        else if (cursor < segmentEnd && tokens[cursor].value.startsWith("-")) break;
        if (skipAssignments()) return true;
        continue;
      }
      if (name === "eval") {
        const body = tokens.slice(cursor + 1, segmentEnd).map((token) => token.value).join(" ");
        if (!body || /[$`]|!.[^!]*!|%.[^%]*%/.test(body)) return true;
        if (inspectNestedCommand(body)) return true;
        break;
      }
      if (name === "source" || name === ".") return true;
      if (name === "wsl") {
        cursor += 1;
        let terminalMode = false;
        while (cursor < segmentEnd) {
          const argument = tokens[cursor].value.replace(/\\\//g, "/");
          if (/^(?:--help|--version|--status|--list|-l)$/.test(argument)) { terminalMode = true; break; }
          if (argument === "--") { cursor += 1; break; }
          if (/^(?:-e|--exec)$/.test(argument)) { cursor += 1; break; }
          if (/^(?:-d|--distribution|-u|--user|--cd|--shell-type)$/.test(argument)) { cursor += 2; continue; }
          if (/^(?:--distribution|--user|--cd|--shell-type)=/.test(argument)) { cursor += 1; continue; }
          if (argument.startsWith("-")) { cursor += 1; continue; }
          break;
        }
        if (terminalMode) break;
        if (skipAssignments()) return true;
        continue;
      }
      if (["busybox", "toybox"].includes(name)) {
        cursor += 1;
        if (cursor < segmentEnd && /^(?:--help|--version|--list|--list-full|--install)$/.test(tokens[cursor].value)) break;
        if (cursor < segmentEnd && tokens[cursor].value === "--") cursor += 1;
        if (skipAssignments()) return true;
        continue;
      }
      if (name === ["fi", "nd"].join("")) {
        for (let scan = cursor + 1; scan < segmentEnd; scan += 1) {
          const actionCandidates = tokens[scan].sawQuoted ? [tokens[scan].value] : shellWordCandidates(tokens[scan]);
          if (!actionCandidates.some((candidate) => /^-(?:exec|execdir|ok|okdir)$/.test(candidate))) continue;
          const actionStart = scan + 1;
          let actionEnd = actionStart;
          while (actionEnd < segmentEnd && !/^(?:\\;|\+)$/.test(tokens[actionEnd].value)) actionEnd += 1;
          const action = tokens.slice(actionStart, actionEnd).map((token) => token.value).join(" ");
          if (inspectNestedCommand(action)) return true;
          scan = actionEnd;
        }
        break;
      }
      if (name === "xargs") {
        cursor += 1;
        let terminalMode = false;
        while (cursor < segmentEnd) {
          const argument = tokens[cursor].value;
          if (/^--(?:help|version)$/.test(argument)) { terminalMode = true; break; }
          if (argument === "--") { cursor += 1; break; }
          if (/^(?:-a|--arg-file|-d|--delimiter|-E|-I|-J|-L|-n|--max-args|-P|--max-procs|-R|-S|-s|--max-chars|--process-slot-var)$/.test(argument)) { cursor += 2; continue; }
          if (/^(?:-[adEIJLnPRSs].+|--(?:arg-file|delimiter|eof|replace|max-lines|max-args|max-procs|max-chars|process-slot-var)=.+|--(?:eof|replace|max-lines|null|open-tty|interactive|no-run-if-empty|show-limits|verbose|exit)|-[0oprtx]+|-[eil].*)$/.test(argument)) { cursor += 1; continue; }
          if (argument.startsWith("-")) {
            const remaining = tokens.slice(cursor + 1, segmentEnd).map((token) => token.value).join(" ");
            const remainingAfterValue = tokens.slice(cursor + 2, segmentEnd).map((token) => token.value).join(" ");
            if (tokens.slice(cursor + 1, segmentEnd).some(hasNodeOptionsAssignment)
              || inspectNestedCommand(remaining)
              || inspectNestedCommand(remainingAfterValue)) return true;
          }
          break;
        }
        if (terminalMode) break;
        if (skipAssignments()) return true;
        continue;
      }
      if (name === "parallel") {
        const remainingTokens = tokens.slice(cursor + 1, segmentEnd);
        if (remainingTokens.some(hasNodeOptionsAssignment)) return true;
        const terminator = remainingTokens.findIndex((token) => token.value === "--");
        const bodyTokens = terminator >= 0 ? remainingTokens.slice(terminator + 1) : remainingTokens;
        if (bodyTokens.some((token) => /^--(?:help|version)$/.test(token.value))) break;
        if (inspectNestedCommand(bodyTokens.map((token) => token.value).join(" "))) return true;
        break;
      }
      if (["sudo", "doas"].includes(name)) {
        cursor += 1;
        let terminalMode = false;
        while (cursor < segmentEnd) {
          const argument = tokens[cursor].value;
          if (/^(?:--help|--version|-V|-l|--list)$/.test(argument)) { terminalMode = true; break; }
          if (argument === "--") { cursor += 1; break; }
          if (/^(?:-u|--user|-g|--group|-h|--host|-p|--prompt|-C|--close-from|-r|--role|-t|--type|-D|--chdir)$/.test(argument)) { cursor += 2; continue; }
          if (hasNodeOptionsAssignment(tokens[cursor])) return true;
          if (argument.startsWith("-") || assignmentName(tokens[cursor])) { cursor += 1; continue; }
          break;
        }
        if (terminalMode) break;
        if (skipAssignments()) return true;
        continue;
      }
      if (name === "exec") {
        cursor += 1;
        while (cursor < segmentEnd) {
          const argument = tokens[cursor].value;
          if (argument === "--") { cursor += 1; break; }
          if (argument === "-a") { cursor += 2; continue; }
          if (/^-[cl]+$/.test(argument)) { cursor += 1; continue; }
          break;
        }
        if (skipAssignments()) return true;
        continue;
      }
      if (name === "nohup") {
        cursor += 1;
        if (cursor < segmentEnd && /^--(?:help|version)$/.test(tokens[cursor].value)) break;
        if (cursor < segmentEnd && tokens[cursor].value === "--") cursor += 1;
        if (skipAssignments()) return true;
        continue;
      }
      if (name === "nice") {
        cursor += 1;
        let terminalMode = false;
        while (cursor < segmentEnd) {
          const argument = tokens[cursor].value;
          if (/^--(?:help|version)$/.test(argument)) { terminalMode = true; break; }
          if (argument === "--") { cursor += 1; break; }
          if (/^(?:-n|--adjustment)$/.test(argument)) { cursor += 2; continue; }
          if (/^(?:-n.+|--adjustment=.+|-[0-9]+)$/.test(argument)) { cursor += 1; continue; }
          break;
        }
        if (terminalMode) break;
        if (skipAssignments()) return true;
        continue;
      }
      if (name === "timeout") {
        cursor += 1;
        let terminalMode = false;
        while (cursor < segmentEnd) {
          const argument = tokens[cursor].value;
          if (/^--(?:help|version)$/.test(argument)) { terminalMode = true; break; }
          if (argument === "--") { cursor += 1; break; }
          if (/^(?:-[vfp]*(?:k|s)|--kill-after|--signal)$/.test(argument)) { cursor += 2; continue; }
          if (/^(?:-[vfp]*(?:k|s).+|-[vfp]+|--(?:kill-after|signal)=.+|--foreground|--preserve-status|--verbose)$/.test(argument)) { cursor += 1; continue; }
          break;
        }
        if (terminalMode || cursor >= segmentEnd) break;
        cursor += 1;
        if (skipAssignments()) return true;
        continue;
      }
      if (name === "ionice") {
        cursor += 1;
        let terminalMode = false;
        let processMode = false;
        while (cursor < segmentEnd && tokens[cursor].value.startsWith("-")) {
          const argument = tokens[cursor].value;
          if (/^(?:--help|--version|-h|-V)$/.test(argument)) { terminalMode = true; break; }
          if (argument === "--") { cursor += 1; break; }
          if (/^(?:-p|-P|-u|--pid|--pgid|--uid)$/.test(argument)) processMode = true;
          if (/^(?:-c|-n|-p|-P|-u|--class|--classdata|--pid|--pgid|--uid)$/.test(argument)) { cursor += 2; continue; }
          if (/^(?:-[cnpPu].+|--(?:class|classdata|pid|pgid|uid)=.+|-t|--ignore)$/.test(argument)) { cursor += 1; continue; }
          const remaining = tokens.slice(cursor + 1, segmentEnd).map((token) => token.value).join(" ");
          const remainingAfterValue = tokens.slice(cursor + 2, segmentEnd).map((token) => token.value).join(" ");
          if (tokens.slice(cursor + 1, segmentEnd).some(hasNodeOptionsAssignment)
            || inspectNestedCommand(remaining)
            || inspectNestedCommand(remainingAfterValue)) return true;
          terminalMode = true;
          break;
        }
        if (terminalMode || processMode || cursor >= segmentEnd) break;
        if (skipAssignments()) return true;
        continue;
      }
      if (name === "taskset") {
        cursor += 1;
        let terminalMode = false;
        let pidMode = false;
        while (cursor < segmentEnd && tokens[cursor].value.startsWith("-")) {
          const argument = tokens[cursor].value;
          if (/^--(?:help|version)$/.test(argument)) { terminalMode = true; break; }
          if (argument === "--") { cursor += 1; break; }
          if (/^(?:-p|--pid)$/.test(argument) || /^-[ac]*p[ac]*$/.test(argument)) pidMode = true;
          if (/^(?:-[acp]+|--(?:all-tasks|cpu-list|pid))$/.test(argument)) { cursor += 1; continue; }
          const remaining = tokens.slice(cursor + 1, segmentEnd).map((token) => token.value).join(" ");
          const remainingAfterValue = tokens.slice(cursor + 2, segmentEnd).map((token) => token.value).join(" ");
          if (tokens.slice(cursor + 1, segmentEnd).some(hasNodeOptionsAssignment)
            || inspectNestedCommand(remaining)
            || inspectNestedCommand(remainingAfterValue)) return true;
          terminalMode = true;
          break;
        }
        if (terminalMode || pidMode || cursor >= segmentEnd) break;
        cursor += 1;
        if (skipAssignments()) return true;
        continue;
      }
      if (name === "setsid") {
        cursor += 1;
        let terminalMode = false;
        while (cursor < segmentEnd) {
          const argument = tokens[cursor].value;
          if (/^--(?:help|version)$/.test(argument)) { terminalMode = true; break; }
          if (argument === "--") { cursor += 1; break; }
          if (/^(?:-[cfw]+|--(?:ctty|fork|wait))$/.test(argument)) { cursor += 1; continue; }
          break;
        }
        if (terminalMode) break;
        if (skipAssignments()) return true;
        continue;
      }
      if (name === "stdbuf") {
        cursor += 1;
        let terminalMode = false;
        while (cursor < segmentEnd) {
          const argument = tokens[cursor].value;
          if (/^--(?:help|version)$/.test(argument)) { terminalMode = true; break; }
          if (argument === "--") { cursor += 1; break; }
          if (/^(?:-[ioe]|--(?:input|output|error))$/.test(argument)) { cursor += 2; continue; }
          if (/^(?:-[ioe].+|--(?:input|output|error)=.+)$/.test(argument)) { cursor += 1; continue; }
          break;
        }
        if (terminalMode) break;
        if (skipAssignments()) return true;
        continue;
      }
      if (name === "cmd") {
        for (let argumentIndex = cursor + 1; argumentIndex < segmentEnd; argumentIndex += 1) {
          const argument = tokens[argumentIndex].value;
          const commandSwitch = /^(?:\/[a-z](?::[a-z]+)?)*\/[ck](.*)$/i.exec(argument);
          if (commandSwitch) {
            const body = [commandSwitch[1], ...tokens.slice(argumentIndex + 1, segmentEnd).map((token) => token.value)]
              .filter(Boolean)
              .join(" ");
            if (inspectNestedCommand(body)) return true;
            break;
          }
        }
      } else if (["powershell", "pwsh"].includes(name)) {
        for (let argumentIndex = cursor + 1; argumentIndex < segmentEnd; argumentIndex += 1) {
          const argument = tokens[argumentIndex].value;
          const attached = /^(?:(?:(?:--?|\/)c|(?:--?|\/)co(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?|(?:--?|\/)cwa|(?:--?|\/)commandw[a-z]*):|--command=)(.+)$/i.exec(argument);
          if (attached) {
            if (inspectNestedCommand(attached[1])) return true;
            break;
          }
          if (/^(?:(?:--?|\/)c|(?:--?|\/)co(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?|(?:--?|\/)cwa|(?:--?|\/)commandw[a-z]*)$/i.test(argument)) {
            const body = tokens.slice(argumentIndex + 1, segmentEnd).map((token) => token.value).join(" ");
            if (inspectNestedCommand(body)) return true;
            break;
          }
          if (/^(?:--?|\/)f(?:i(?:l(?:e)?)?)?/i.test(argument)) break;
        }
      } else if (["bash", "sh", "dash", "zsh", "ksh"].includes(name)) {
        for (let argumentIndex = cursor + 1; argumentIndex < segmentEnd; argumentIndex += 1) {
          if (/^-[A-Za-z]*c[A-Za-z]*$/.test(tokens[argumentIndex].value)) {
            const body = tokens.slice(argumentIndex + 1, segmentEnd).map((token) => token.value).join(" ");
            if (inspectNestedCommand(body)) return true;
            break;
          }
        }
      }
      if (name === "export") {
        cursor += 1;
        let nonAssignmentMode = false;
        while (cursor < segmentEnd && tokens[cursor].value.startsWith("-")) {
          const option = tokens[cursor].value;
          if (option === "--") { cursor += 1; break; }
          if (/^-[^-]*[fnp]/.test(option)) nonAssignmentMode = true;
          cursor += 1;
        }
        while (cursor < segmentEnd) {
          if (hasNodeOptionsAssignment(tokens[cursor])) return true;
          if (!nonAssignmentMode && namesNodeOptionsVariable(tokens[cursor])) return true;
          cursor += 1;
        }
      } else if (["declare", "typeset", "local", "readonly"].includes(name)) {
        cursor += 1;
        let namerefDeclaration = false;
        while (cursor < segmentEnd && tokens[cursor].value.startsWith("-")) {
          const option = tokens[cursor].value;
          if (option === "--") { cursor += 1; break; }
          if (/^-[^-]*n/.test(option) || option === "--nameref") namerefDeclaration = true;
          cursor += 1;
        }
        if (namerefDeclaration && nodeBackedCommandMentioned) return true;
        while (cursor < segmentEnd) {
          if (namesNodeOptionsVariable(tokens[cursor])) return true;
          cursor += 1;
        }
      } else if (name === "printf") {
        cursor += 1;
        while (cursor < segmentEnd) {
          const argument = tokens[cursor].value;
          if (argument === "--") break;
          if (argument === "-v") {
            const target = tokens[cursor + 1];
            if (namesNodeOptionsVariable(target) || (nodeBackedCommandMentioned && hasDynamicVariableName(target))) return true;
            break;
          }
          const attachedTarget = /^-v(.+)$/.exec(argument);
          if (attachedTarget) {
            const target = { ...tokens[cursor], value: attachedTarget[1] };
            if (namesNodeOptionsVariable(target) || (nodeBackedCommandMentioned && hasDynamicVariableName(target))) return true;
            break;
          }
          if (!argument.startsWith("-")) break;
          cursor += 1;
        }
      } else if (name === "read") {
        cursor += 1;
        while (cursor < segmentEnd) {
          const argument = tokens[cursor].value;
          if (argument === "--") { cursor += 1; break; }
          if (/^-[av]$/.test(argument)) {
            const target = tokens[cursor + 1];
            if (namesNodeOptionsVariable(target) || (nodeBackedCommandMentioned && hasDynamicVariableName(target))) return true;
            cursor += 2;
            continue;
          }
          const attachedTarget = /^-[av](.+)$/.exec(argument);
          if (attachedTarget) {
            const target = { ...tokens[cursor], value: attachedTarget[1] };
            if (namesNodeOptionsVariable(target) || (nodeBackedCommandMentioned && hasDynamicVariableName(target))) return true;
            cursor += 1;
            continue;
          }
          if (/^-[dinNptu]$/.test(argument)) { cursor += 2; continue; }
          if (/^-[dinNptu].+/.test(argument) || /^-[ers]+$/.test(argument)) { cursor += 1; continue; }
          if (argument.startsWith("-")) { cursor += 1; continue; }
          break;
        }
        while (cursor < segmentEnd) {
          if (namesNodeOptionsVariable(tokens[cursor])
            || (nodeBackedCommandMentioned && hasDynamicVariableName(tokens[cursor]))) return true;
          cursor += 1;
        }
      } else if (name === "set") {
        cursor += 1;
        while (cursor < segmentEnd) {
          const argument = tokens[cursor].value;
          if (argument === "--") { cursor += 1; break; }
          if (/^[+-]o$/.test(argument)) {
            const optionName = String(tokens[cursor + 1]?.value || "").toLowerCase();
            if (optionName === "allexport") allexportEnabled = argument.startsWith("-");
            cursor += optionName ? 2 : 1;
            continue;
          }
          if (hasNodeOptionsAssignment(tokens[cursor]) || isNodeOptionsName(argument)) return true;
          if (/^-[^-]*a/.test(argument)) allexportEnabled = true;
          else if (/^\+[^+]*a/.test(argument)) allexportEnabled = false;
          cursor += 1;
        }
      } else if (name === "setx") {
        cursor += 1;
        while (cursor < segmentEnd && tokens[cursor].value.startsWith("-")) cursor += 1;
        if (hasNodeOptionsAssignment(tokens[cursor])) return true;
        if (isNodeOptionsName(tokens[cursor]?.value)) return true;
      }
      break;
    }
    segmentStart = segmentEnd + 1;
  }
  return false;
}

// Ordered [pattern, reason] checks. First match wins. Verbatim from the
// original bash-safety.mjs inline table (2026-07 extraction), plus one addition
// marked below.
export const DANGEROUS_CMD_CHECKS = [
  [/\bnode(?:\.exe)?\b[^\r\n;&|]*(?:--require(?:=|\s)|(?:^|\s)-r(?:\s|\S)|--import(?:=|\s)|--(?:experimental-)?loader(?:=|\s))/i, "Blocked Node pre-execution loading. NODE_OPTIONS, require/import, and loader hooks can run code before a reviewed script's own safety checks."],
  [/\bgit\b[^\r\n;&|]*\bpush\b[^\r\n;&|]*(?:--force(?:-with-lease)?(?:=\S+)?\b|--force-if-includes\b|(?:^|\s)-[A-Za-z]*f[A-Za-z]*\b|(?:^|\s)\+\S+)/, "Blocked force push. Force pushing any branch requires Mason's explicit approval."],
  // Tolerate intervening git options (`git -C <path> reset --hard`, `git -c x=y clean -fd`)
  // — the adjacent-words-only spellings were bypassable (Codex P1, PR #352).
  [/\bgit\b[^\r\n;&|]*\breset\b[^\r\n;&|]*--hard\b/, "Blocked `git reset --hard`. Permanently destroys uncommitted work. Use `git stash` or `git restore <file>`."],
  // `-- .` separator form and long/split clean options covered too
  // (Codex P1 round 2, PR #352: `checkout -- .` and `clean --force -d` bypassed).
  // Terminator grammar includes redirects (`checkout -- . >/tmp/out`) —
  // CodeRabbit major, PR #352.
  [/\bgit\b[^\r\n;&|]*\bcheckout\b[^\r\n;&|]*\s(?:--\s+)?\.\s*(?:$|[;&|<>]|2>)/, "Blocked discard-all. Use targeted `git restore <file>`."],
  // `checkout -f/--force` throws away local modifications wholesale — gate the
  // force option independently of the `.` pathspec (Codex P1 round 4, PR #352).
  [/\bgit\b[^\r\n;&|]*\bcheckout\b[^\r\n;&|]*\s(?:--force\b|-[A-Za-z]*f[A-Za-z]*\b)/, "Blocked force checkout. It throws away local modifications. Use `git stash` first, or targeted `git restore <file>`."],
  // `git switch -f` / `--discard-changes` is the same discard through the newer
  // subcommand (Codex P1 round 5, PR #352). `switch -c <branch>` stays allowed.
  [/\bgit\b[^\r\n;&|]*\bswitch\b[^\r\n;&|]*\s(?:--discard-changes\b|--force\b|-[A-Za-z]*f[A-Za-z]*\b)/, "Blocked force switch. It throws away local modifications. Use `git stash` first, then a plain `git switch <branch>`."],
  [/\bgit\b[^\r\n;&|]*\brestore\b[^\r\n;&|]*\s(?:--\s+)?\.\s*(?:$|[;&|<>]|2>)/, "Blocked discard-all. Use targeted `git restore <file>`."],
  [/\bgit\b[^\r\n;&|]*\bclean\b[^\r\n;&|]*\s(?:--force\b|-[A-Za-z]*[fdx][A-Za-z]*\b)/, "Blocked `git clean -f`. Permanently deletes untracked files. Review with `git clean -n` first."],
  [/--no-verify\b/, "Blocked `--no-verify`. Pre-commit hooks prevent bugs — fix the underlying issue."],
  [/\brm\s+-[A-Za-z]*r[A-Za-z]*f?[A-Za-z]*\s+(?:\.\.?\s*(?:$|;|&|\|)|\.\.?\/(?:src|supabase|docs)(?:\b|\/)|\/?(?:src|supabase|docs)(?:\b|\/))/, "Blocked recursive deletion of project source/migrations/docs."],
  // Long/split option spellings of the same recursive delete — `rm --recursive
  // --force src`, `rm -r --force src` (Codex P1 round 4, PR #352). A lookahead
  // detects ANY recursive flag form, then the same protected targets apply.
  [/\brm\b(?=[^\r\n;&|]*(?:\s--recursive\b|\s-[A-Za-z]*[rR]))[^\r\n;&|]*\s(?:\.\.?\s*(?:$|;|&|\|)|\.\.?\/(?:src|supabase|docs)(?:\b|\/)|\/?(?:src|supabase|docs)(?:\b|\/))/, "Blocked recursive deletion of project source/migrations/docs."],
  [/\bnpm\s+uninstall\s+(?:react|@supabase\/supabase-js|vite|typescript)\b/, "Blocked uninstall of a core dependency."],
  [/git\s+add\s+[^&|;]*\.env(?:\b|$)/, "Blocked staging of .env. Secrets must never be committed."],
  // npx-OPTIONAL (2026-07-16 scaffolding review B1): the bare `supabase db push`
  // spelling — the one older skill docs printed — sailed past the npx-only pattern.
  // db push applies ALL pending local migrations to the linked (live) DB at once;
  // the sanctioned apply path is /migration-review → apply_migration.
  [/(?:npx\s+)?supabase\s+db\s+push\b/, "Blocked `supabase db push`. It applies ALL pending local migrations to the linked database at once, bypassing the migration-review gate. Apply through /migration-review → apply_migration instead."],
  [/npx\s+supabase\s+migration\s+repair\b/, "Blocked `supabase migration repair`. Causes migration history drift."],
  // `migration up` is the same live-apply bypass as `db push` under another name
  // (Codex review of the 2026-07-16 scaffolding audit caught the sibling spelling).
  [/(?:npx\s+)?supabase\s+migration\s+up\b/, "Blocked `supabase migration up`. Like `db push`, it applies pending local migrations outside the migration-review gate. Apply through /migration-review → apply_migration (or per-statement execute_sql for CONCURRENTLY files)."],
  [/(?:npx\s+)?supabase\s+db\s+reset\b/, "Blocked `supabase db reset`. This wipes the entire local Supabase DB and re-runs all 356 migrations from scratch — minutes of work plus loss of any local test data. If you really need to reset, run it manually in a terminal where you can see the warnings."],
  [/\b(?:dropdb|createdb)\b/, "Blocked `dropdb`/`createdb`. Destructive at the database level — if you need a fresh DB, do it via Supabase dashboard with explicit confirmation."],
  [/\bgit\s+branch\s+(?:-D|--delete\s+--force)\s+(?:main|master|production)\b/, "Blocked force-delete of main/master/production branch. Almost never the right move."],
  [/\bgit\b[^\r\n;&|]*\bpush\b[^\r\n;&|]*(?:--mirror|--prune|--all|--branches)\b/, "Blocked bulk `git push` mode (`--all`/`--branches`/`--mirror`/`--prune`). Use one explicit branch/refspec at a time."],
  [/\bgit\s+filter-(branch|repo)\b/, "Blocked `git filter-branch`/`filter-repo`. Rewrites entire repo history — destructive and slow."],
  // send-pack/receive-pack are the plumbing spellings of push — `git send-pack
  // --force` walked straight past the force-push guard (Codex P1 round 3, PR #352).
  // No workflow here ever needs the plumbing form; porcelain `git push` is the path.
  [/\bgit\b[^\r\n;&|]*\b(?:send-pack|receive-pack)\b/, "Blocked `git send-pack`/`receive-pack`. Use plain `git push` — the plumbing form bypasses the force-push guard."],
  [/\brm\s+-[A-Za-z]*r[A-Za-z]*f?[A-Za-z]*\s+\/(?!tmp|var\/tmp|c\/CRX_Manager\/\.playwright-mcp|c\/CRX_Manager\/\.claude\/worktrees)/, "Blocked `rm -rf /<path>` outside known-safe scratch areas. Use a more specific path."],
  [/\bnpm\s+run\s+(?:reset|nuke|wipe)\b/, "Blocked suspicious `npm run reset/nuke/wipe`. Verify what this script does first."],
  // NET-NEW (2026-07-13 mcp-tool-guard audit): shell-redirect writes to .env were
  // only blocked at `git add` time, never at write time — a plain `echo X > .env`
  // (or Desktop Commander running the same shell command) sailed through. This
  // closes that gap for BOTH bash-safety.mjs and mcp-tool-guard.mjs.
  // NOTE: `\s*` after the redirect, not `\s+` — `echo SECRET>.env` is valid shell
  // with NO space (Codex P2 2026-07-13 caught the whitespace-required bypass).
  // Tracked non-secret templates (.env.example/.template/.sample) stay allowed,
  // matching env-guard.mjs's exemptions (Codex P2 round 4).
  [/(?:>>?\s*|\btee\b\s+)['"]?[^\s'";|&]*\.env(?!(?:\.[\w-]+)*\.(?:example|template|sample)\b)(?:\.[\w-]+)?\b/, "Blocked shell-redirect write to .env*. Secrets must never be written this way."],
];

// Production-deploy spellings that must PROMPT (permissionDecision "ask"), not
// auto-approve — added for PR #352 (Codex P1): with a broad Bash allow in
// settings.json, prefix-matched ask rules miss variant spellings like
// `npx vercel --prod`. These are deterministic content checks instead.
// First match wins. Consumed by bash-safety.mjs; mcp-tool-guard.mjs's Desktop
// Commander paths already route deploy tools through the settings ask list.
export const ASK_CMD_CHECKS = [
  [/\b(?:npx\s+)?vercel\b[^\r\n;&|]*(?:--prod\b|--production\b|\bpromote\b|\brollback\b)/, "Production Vercel deploy/promote/rollback — needs Mason's explicit OK (AGENTS.md hard gate)."],
  [/\b(?:npx\s+)?supabase\s+functions\s+deploy\b/, "Edge-function deploy — needs Mason's explicit OK (AGENTS.md hard gate)."],
];

export function checkAskCommand(cmd) {
  const text = normalizePosixLineContinuations(cmd);
  if (!text) return null;
  for (const [re, reason] of ASK_CMD_CHECKS) {
    if (re.test(text)) return reason;
  }
  return null;
}

// Destructive raw SQL via psql/supabase CLI (kept as its own exported check
// since the original file ran it as a second, independent condition).
export function checkDestructiveSql(cmd) {
  const text = normalizePosixLineContinuations(cmd);
  if (/\b(?:DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE)\b/i.test(text) && /(psql|supabase\s+sql|--?c\s)/i.test(text)) {
    return "Blocked destructive SQL via psql/supabase. Add a migration instead.";
  }
  return null;
}

// Run raw text against the ordered pattern table + the destructive-SQL rule.
// Returns the FIRST matching reason, or null. This is the literal-command check
// only — no npm-script resolution (see checkCommandDeep for that).
export function checkDangerousCommand(cmd) {
  const rawText = String(cmd || "");
  const text = normalizePosixLineContinuations(rawText);
  if (!text) return null;
  if (commandExceedsSecurityBudget(rawText)) {
    return `Blocked oversized command payload. Safety inspection is limited to ${SECURITY_COMMAND_CHAR_BUDGET} characters so the hook fails closed within its execution deadline.`;
  }
  const producerReason = checkMaintenanceProducerInvocation(rawText);
  if (producerReason) return producerReason;
  if (nodeOptionsAssignmentMentioned(text)) {
    return "Blocked Node pre-execution loading. NODE_OPTIONS, require/import, and loader hooks can run code before a reviewed script's own safety checks.";
  }
  for (const [re, reason] of DANGEROUS_CMD_CHECKS) {
    if (re.test(text)) return reason;
  }
  return checkDestructiveSql(text);
}

// Bash-based modification of an EXISTING file under supabase/migrations/ (via
// output redirect, or sed/perl/awk -i). Returns a reason or null. Verbatim
// extraction of the original bash-safety.mjs logic.
const MIGRATION_MODIFY_RES = [
  /(?:>>?|2>&1\s*>>?)\s*['"]?([^\s'";|&<>]*supabase[\\/]migrations[\\/][^\s'";|&<>]+)/g,
  /(?:sed|perl|awk)\s+-[A-Za-z]*i[A-Za-z]*\b[^|;&]*?([^\s'";|&<>]*supabase[\\/]migrations[\\/][^\s'";|&<>]+)/g,
];

export function checkMigrationModify(cmd, cwd) {
  const text = normalizePosixLineContinuations(cmd);
  if (!text) return null;
  const base = cwd || process.cwd();
  for (const re of MIGRATION_MODIFY_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const target = m[1].replace(/^['"]|['"]$/g, "");
      const abs = path.isAbsolute(target) ? target : path.resolve(base, target);
      try {
        if (existsSync(abs)) {
          return `Blocked modification of existing migration file: ${target}. Existing migrations must never be edited — create a NEW migration that supersedes it.`;
        }
      } catch { /* ignore, fail open on this one path */ }
    }
  }
  return null;
}

// ── npm-script indirection (FIX 2, 2026-07-13) ──────────────────────────────
// `npm run foo` can hide an arbitrary dangerous command inside package.json's
// scripts.foo, which the literal-command regex table above never sees. Resolve
// the script's body text (recursing into scripts IT calls, max depth 3) and run
// the same checks against the resolved text too.

export function extractNpmRunNames(cmd) {
  const names = [];
  // Accepts valid npm variants (Codex P1 2026-07-13 round 3): options before
  // and after the subcommand (`npm -s run x`, `npm run --silent x`) and the
  // `run-script` alias — option tokens must not be mistaken for script names.
  const re = /\bnpm\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+)*(?:run|run-script)\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+)*([\w:.-]+)/g;
  let m;
  const text = normalizePosixLineContinuations(cmd);
  while ((m = re.exec(text)) !== null) names.push(m[1]);
  return names;
}

// Resolve one script name to an array of script-body texts: itself, plus every
// script reachable via `npm run X` inside it, up to maxDepth levels, with a
// `seen` set so a cyclical script graph can't recurse forever.
export function resolveNpmScriptChain(scripts, name, depth = 0, maxDepth = 3, seen = new Set()) {
  if (depth > maxDepth || !scripts || typeof scripts !== "object") return [];
  if (seen.has(name)) return [];
  seen.add(name);
  const out = [];
  const text = scripts[name];
  if (typeof text === "string") {
    out.push(text);
    for (const nested of extractNpmRunNames(text)) {
      out.push(...resolveNpmScriptChain(scripts, nested, depth + 1, maxDepth, seen));
    }
  }
  // npm auto-runs pre<name>/post<name> around any script — a dangerous command
  // hidden there rides along with an innocent `npm run <name>` (Codex P1
  // 2026-07-13 round 4). Resolve them even when scripts[name] itself is absent.
  for (const lifecycle of [`pre${name}`, `post${name}`]) {
    if (typeof scripts[lifecycle] === "string") {
      out.push(...resolveNpmScriptChain(scripts, lifecycle, depth + 1, maxDepth, seen));
    }
  }
  return out;
}

// Read package.json's `scripts` map from `cwd`. Returns null (never throws) if
// the file is unreadable or unparsable — callers MUST warn-and-allow (skip the
// script-body check, do not block) in that case; a broken/missing package.json
// must never brick the hook.
export function readPackageScripts(cwd) {
  try {
    const raw = readFileSync(path.join(cwd || process.cwd(), "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.scripts === "object" && parsed.scripts !== null ? parsed.scripts : {};
  } catch {
    return null;
  }
}

// The full command check used by both hooks: literal command text first, then
// (only if clean) every `npm run X` target's resolved script body, recursively.
// Returns the first matching reason, or null.
export function checkCommandDeep(cmd, cwd) {
  const direct = checkDangerousCommand(cmd);
  if (direct) return direct;

  const names = extractNpmRunNames(cmd);
  if (names.length === 0) return null;

  const scripts = readPackageScripts(cwd);
  if (scripts === null) {
    // FAIL-OPEN, but loud: package.json missing/unparsable — skip the resolved-
    // script check rather than block or crash.
    process.stderr.write("bash-safety-lib: could not read/parse package.json — skipping npm-script-body check (warn-and-allow)\n");
    return null;
  }

  const seen = new Set();
  for (const name of names) {
    for (const resolved of resolveNpmScriptChain(scripts, name, 0, 3, seen)) {
      if (maintenanceProducerCommandMentioned(resolved)) {
        return "Blocked indirect maintenance producer invocation. Run the exact repository-relative node command directly; npm scripts and lifecycle wrappers are denied.";
      }
      // Run BOTH check families on the resolved body — a script that rewrites an
      // existing migration is as dangerous as one that force-pushes (Codex P1
      // 2026-07-13: only checkDangerousCommand ran here, so npm indirection
      // still bypassed the migration-immutability guard).
      const reason = checkDangerousCommand(resolved) || checkMigrationModify(resolved, cwd);
      if (reason) return `${reason} (found inside \`npm run ${name}\`'s script body)`;
    }
  }
  return null;
}

// Ask-tier twin of checkCommandDeep: literal text first, then resolved npm-script
// bodies, so `npm run deploy-prod` can't hide a production deploy either.
export function checkAskDeep(cmd, cwd) {
  const direct = checkAskCommand(cmd);
  if (direct) return direct;

  const names = extractNpmRunNames(cmd);
  if (names.length === 0) return null;
  const scripts = readPackageScripts(cwd);
  if (scripts === null) return null;

  const seen = new Set();
  for (const name of names) {
    for (const resolved of resolveNpmScriptChain(scripts, name, 0, 3, seen)) {
      const reason = checkAskCommand(resolved);
      if (reason) return `${reason} (found inside \`npm run ${name}\`'s script body)`;
    }
  }
  return null;
}

export { MIGRATION_MODIFY_RES };
