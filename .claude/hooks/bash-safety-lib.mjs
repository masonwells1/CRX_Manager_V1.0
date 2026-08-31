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

const MAINTENANCE_PRODUCER_NAME = "apply-live-testdata-maintenance-20260812.mjs";
const MAINTENANCE_PRODUCER_ALLOWED_COMMANDS = new Set([
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --approved-by-mason=2026-08-12",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --approved-by-mason=2026-08-12 --protect-producer",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --approved-by-mason=2026-08-12 --retire-producer",
]);

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
  return compact.includes(MAINTENANCE_PRODUCER_NAME)
    || compact.includes("--approved-by-mason=");
}

export function checkMaintenanceProducerInvocation(command) {
  const value = String(command || "").trim();
  if (!maintenanceProducerCommandMentioned(value)) return null;
  if (MAINTENANCE_PRODUCER_ALLOWED_COMMANDS.has(value)) return null;
  return "Blocked maintenance producer invocation. Use one exact repository-relative node command only; chaining, wrappers, substitutions, alternate spellings, reordered or unknown arguments, and indirect writers are denied.";
}

// Ordered [pattern, reason] checks. First match wins. Verbatim from the
// original bash-safety.mjs inline table (2026-07 extraction), plus one addition
// marked below.
export const DANGEROUS_CMD_CHECKS = [
  [/(?:^|[\r\n;&|])\s*(?:(?:export|set|setx)\s+|env(?:\s+(?:-\S+|[A-Za-z_]\w*=\S+))*\s+)?(?:[A-Za-z_]\w*=\S+\s+)*NODE_OPTIONS\s*=|\bnode(?:\.exe)?\b[^\r\n;&|]*(?:--require(?:=|\s)|(?:^|\s)-r(?:\s|\S)|--import(?:=|\s)|--(?:experimental-)?loader(?:=|\s))/i, "Blocked Node pre-execution loading. NODE_OPTIONS, require/import, and loader hooks can run code before a reviewed script's own safety checks."],
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
  // `git clean` is handled by checkGitClean() below, not by a flat pattern: the
  // old `-[A-Za-z]*[fdx][A-Za-z]*` cluster denied `git clean -nd` — a DRY RUN,
  // which deletes nothing — with a message telling the reader to run a dry run
  // first. A flat regex cannot fix that safely (`--dry-run` itself matches a
  // naive `[dx]` cluster), so the decision moved to a per-invocation parse.
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
  const text = String(cmd || "");
  if (!text) return null;
  for (const [re, reason] of ASK_CMD_CHECKS) {
    if (re.test(text)) return reason;
  }
  return null;
}

// Destructive raw SQL via psql/supabase CLI (kept as its own exported check
// since the original file ran it as a second, independent condition).
export function checkDestructiveSql(cmd) {
  const text = String(cmd || "");
  if (/\b(?:DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE)\b/i.test(text) && /(psql|supabase\s+sql|--?c\s)/i.test(text)) {
    return "Blocked destructive SQL via psql/supabase. Add a migration instead.";
  }
  return null;
}

// Run raw text against the ordered pattern table + the destructive-SQL rule.
// Returns the FIRST matching reason, or null. This is the literal-command check
// only — no npm-script resolution (see checkCommandDeep for that).
const GIT_CLEAN_REASON = "Blocked `git clean -f`. Permanently deletes untracked files. Review with `git clean -n` (or `git clean -nd`) first.";

// `git clean` blocks unless the invocation is an unmistakable DRY RUN. A dry run
// deletes nothing, so denying it with a message that says "review with
// `git clean -n` first" blocked the very command it recommended: the original
// flat pattern matched any option cluster containing `f`, `d`, or `x`, and `-nd`
// — the standard "what would this show, including directories" probe — has `d`.
//
// DESIGN: strict allowlist, deliberately NOT a parser. The original destructive
// pattern is kept verbatim and still decides; the ONLY change is that a segment
// matching a tiny, boring dry-run grammar is exempted from it. Anything that
// grammar does not recognise keeps the original behaviour, so an unanticipated
// spelling stays BLOCKED. A survivor is a false positive, never a hole.
//
// This replaced two successive hand-written option parsers, each of which the
// exact-HEAD gpt-5.6-sol review caught opening a real destructive bypass that
// the flat pattern had blocked (2026-08-31, two HIGH findings):
//   * `git clean -fde*.tmp` — git allows the `-e` exclude pattern to be ATTACHED,
//     so this is `-f -d -e '*.tmp'`; a letters-only token test skipped it whole.
//   * `git -C -n -c clean.requireForce=false clean -dx` — the `-n` there is the
//     DIRECTORY argument to git's global `-C`, not a dry-run flag.
// Both stay blocked here because neither matches the allowlist, and this code
// never has to understand either construction. That is the point of the shape.
//
// Segmentation matches the sibling git rules above (`[^\r\n;&|]*`), so a dry run
// never excuses a destructive sibling: `git clean -n && git clean -fd` blocks.
// Also treats a command-line `clean.requireForce=false` override as destructive.
// `git clean` normally refuses without `-f` or `-n`, which is why a bare or
// exclude-only invocation reads as harmless — but that refusal IS
// `clean.requireForce`, so `git -c clean.requireForce=false clean -e '*.tmp'`
// deletes without ever naming `-f` (CodeRabbit, PR #527, Major). Detectable only
// in its command-line spelling; the same setting in a user's `.gitconfig` cannot
// be seen from command text, and that gap is unchanged from the base pattern.
const GIT_CLEAN_DESTRUCTIVE_RE = /\bgit\b[^\r\n;&|]*\bclean\b[^\r\n;&|]*\s(?:--force\b|-[A-Za-z]*[fdx][A-Za-z]*\b)|\bclean\.requireForce\s*=\s*false\b/i;
// The whole segment must be exactly `git clean` plus one dry-run option group,
// and NOTHING else. The grammar deliberately contains NO free-text slot.
//
// An earlier version allowed an optional `-C <path>` prefix with `<path>` as
// `[^\s]+`. That one slot was a fail-open: `git -C >src/App.tsx clean -nd`
// matched, and the SHELL truncates App.tsx before git ever runs — command
// substitution in the same operand hides arbitrary commands the same way
// (gpt-5.6-sol exact-HEAD review, 2026-08-31, HIGH; the base pattern denied it).
// Sanitising an operand is the same losing game as parsing one, so the slot is
// gone instead. `git -C <path> clean -nd` is therefore blocked, which is the
// fail-closed cost: run the dry run from the directory itself.
const GIT_CLEAN_DRY_RUN_ONLY_RE = /^\s*git\s+clean\s+(?:-n[dx]{0,2}|--dry-run(?:\s+-[dx]{1,2})?)\s*$/;
export function checkGitClean(cmd) {
  const text = String(cmd || "");
  if (!text) return null;
  for (const segment of text.split(/[\r\n;&|]+/)) {
    if (!GIT_CLEAN_DESTRUCTIVE_RE.test(segment)) continue;
    if (GIT_CLEAN_DRY_RUN_ONLY_RE.test(segment)) continue;
    return GIT_CLEAN_REASON;
  }
  return null;
}

export function checkDangerousCommand(cmd) {
  const text = String(cmd || "");
  if (!text) return null;
  const producerReason = checkMaintenanceProducerInvocation(text);
  if (producerReason) return producerReason;
  for (const [re, reason] of DANGEROUS_CMD_CHECKS) {
    if (re.test(text)) return reason;
  }
  const gitCleanReason = checkGitClean(text);
  if (gitCleanReason) return gitCleanReason;
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
  const text = String(cmd || "");
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
  const text = String(cmd || "");
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
