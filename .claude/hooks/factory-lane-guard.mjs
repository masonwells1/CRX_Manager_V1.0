#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  ACTIVE_STAGES,
  FACTORY_CUSTODY_STAGES,
  hasFactoryIntentFailureLatch,
  loadFactorySnapshot,
  mintFactoryCliPermit,
  pathAllowedByTicket,
  rejectSecretBearingText,
  resolveHookFactoryPaths,
  validateApprovedFactoryLanding,
} from "../../scripts/factory-state-lib.mjs";
import { isGitPush, pushTargetsCurrentHead } from "./codex-push-lib.mjs";
import { isBuildActionUnderHold } from "./hold-latch-lib.mjs";

function nothing() { process.exit(0); }
function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

function allowWithCommand(payload, command, projectDir) {
  const input = payload?.tool_input || {};
  const powerShell = /^(?:PowerShell|shell_command)$/i.test(String(payload?.tool_name || ""));
  const root = path.resolve(projectDir).replace(/\\/g, "/");
  const rootedCommand = powerShell
    ? `Set-Location -LiteralPath '${root.replace(/'/g, "''")}'; ${command}`
    : `cd -- '${root.replace(/'/g, "'\"'\"'")}' && ${command}`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...input, command: rootedCommand },
    },
  }));
  process.exit(0);
}

function allowWithPermit(payload, token, canonicalCommand, projectDir) {
  const powerShell = /^(?:PowerShell|shell_command)$/i.test(String(payload?.tool_name || ""));
  const trustedCommand = powerShell
    ? `$env:CRX_FACTORY_PERMIT='${token}'; ${canonicalCommand}`
    : `CRX_FACTORY_PERMIT='${token}' ${canonicalCommand}`;
  allowWithCommand(payload, trustedCommand, projectDir);
}

function factoryCliInvocation(toolName, toolInput, projectDir) {
  if (!/^(?:Bash|PowerShell|shell_command)$/i.test(String(toolName || ""))) return false;
  const command = String(toolInput?.command || "").trim().replace(/\\/g, "/");
  if (/[\r\n;&|<>`$(){}[\]*?!~%'"]/.test(command)) return false;
  const absolute = path.join(projectDir, "scripts", "factory.mjs").replace(/\\/g, "/");
  const match = command.match(new RegExp(
    `^node(?:\\.exe)?\\s+(?:[\"']?${absolute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\"']?|scripts/factory\\.mjs)\\s+(.+)$`,
    "i",
  ));
  if (!match) return false;
  const action = match[1].trim();
  if (!/^[A-Za-z0-9._:/\\@+=,-]+(?:\s+[A-Za-z0-9._:/\\@+=,-]+)*$/.test(action)) return false;
  return {
    action,
    status: /^status(?:\s|$)/i.test(action),
    recovery: /^recover\s+(?:unlock|commit-gate|torn-tail)(?:\s|$)/i.test(action),
    jobId: action.match(/(?:^|\s)--job\s+([A-Za-z0-9._:@+=,-]+)/i)?.[1] || "",
    canonicalCommand: `node ${JSON.stringify(absolute)} ${action}`,
  };
}

function shellWorkingDirectoryBlockReason(toolName, toolInput, projectDir) {
  if (!/^(?:Bash|PowerShell|shell_command)$/i.test(String(toolName || ""))) return "";
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  const root = path.resolve(projectDir);
  for (const [key, value] of [["cwd", input.cwd], ["workdir", input.workdir]]) {
    if (value == null || String(value).trim() === "") continue;
    const text = String(value).trim();
    if (/[\0\r\n$%~*?[\]{}()]/.test(text)) {
      return `${key} is dynamic or ambiguous`;
    }
    const realRoot = realpathSync(root);
    const candidate = path.resolve(root, text);
    if (!existsSync(candidate)
        || !isInside(root, candidate)
        || realpathSync(candidate) !== realRoot) {
      return `${key} must be the exact governed repository root`;
    }
  }
  return "";
}

const SHELL_MUTATION_RE = /(?:^|[;&|]\s*|\s)(?:set-content|add-content|out-file|new-item|remove-item|copy-item|move-item|rename-item|clear-content|set-item|clear-item|set-itemproperty|new-itemproperty|remove-itemproperty|rename-itemproperty|clear-itemproperty|set-acl|ac|clc|cli|clp|cpi|mi|ni|ri|ren|rni|sc|si|sp|sac|rm|del|erase|mv|cp|copy|move|xcopy|robocopy|mkdir|md|rmdir|rd|touch|truncate|tee|patch|apply_patch)\b|(?:^|[^<])(?:>>?|[12]>>?)\s*(?!&)|\b(?:sed|perl)(?:\.exe)?\b[^\r\n;&|]*\s-i(?:[^\s]*)?|\bgit(?:\.exe)?\s+(?:add|am|apply|branch\s+(?:-[dDmM]|--delete|--move)|checkout|cherry-pick|clean|commit|merge|mv|rebase|reset|restore|rm|switch\s+-c|tag|push)\b|\bnpm(?:\.cmd)?\s+(?:install|uninstall|update|ci|publish)\b|\bnpx(?:\.cmd)?\b/i;
const SAFE_NPM_RUN_RE = /^\s*npm(?:\.cmd)?\s+run\s+(?:test(?::[A-Za-z0-9:_-]+)?|lint|typecheck|build|verify-deps|check-doc-drift|check:agent-workflows|check:agent-guidance)\s*$/i;
const SAFE_NODE_RE = /^\s*node(?:\.exe)?\s+(?:scripts[\\/](?:factory-board|check-doc-drift|verify-deps)\.mjs(?:\s+--[A-Za-z0-9_-]+)*|scripts[\\/]sync-agent-workflows\.mjs\s+--check)\s*$/i;
function nodeCheckTarget(command) {
  const match = String(command || "").match(
    /^\s*node(?:\.exe)?\s+--check\s+((?!-)(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.(?:mjs|cjs|js))\s*$/i,
  );
  return match?.[1] || "";
}

function shellEnvironmentBlockReason(toolName, toolInput) {
  if (!/^(?:Bash|PowerShell|shell_command)$/i.test(String(toolName || ""))) return "";
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  for (const key of ["env", "environment", "env_vars", "environmentVariables"]) {
    const value = input[key];
    if (value && (typeof value !== "object" || Object.keys(value).length > 0)) {
      return "caller-selected shell environment overrides are forbidden in governed work";
    }
  }
  return "";
}
const SAFE_GIT_TOKEN_RE = /^[A-Za-z0-9._/@^~:+,=\\/-]+$/;
function isSafeGitRead(command) {
  const normalized = String(command || "").trim();
  if (!/^git(?:\.exe)?\s+/i.test(normalized)) return false;
  if (/[\r\n;&|<>`$(){}[\]*?!%'"]/.test(normalized)) return false;
  const tokens = normalized.split(/\s+/);
  tokens.shift();
  if (tokens[0] === "-C") {
    return false;
  }
  const subcommand = String(tokens.shift() || "").toLowerCase();
  const args = tokens;
  if (args.some((token) => !SAFE_GIT_TOKEN_RE.test(token))) return false;
  if (args.some((token) =>
    /^--?(?:output|ext-diff|textconv|paginate|exec-path|config-env)(?:=|$)/i.test(token)
    || /^--?config(?:=|$)/i.test(token))) return false;
  const allowedOptions = new Set([
    "--short", "--branch", "--porcelain", "-s", "-b", "-sb",
    "--stat", "--name-only", "--name-status", "--cached", "--staged",
    "--quiet", "--exit-code", "--no-color", "--verify", "--show-toplevel",
    "--git-common-dir", "--is-inside-work-tree", "--is-ancestor",
    "--others", "--exclude-standard", "-z", "-v", "--show-current",
    "-vv", "--list", "list", "--oneline", "--decorate",
  ]);
  const optionsSafe = args.every((token) =>
    token === "--"
    || !token.startsWith("-")
    || allowedOptions.has(token)
    || /^--max-count=\d+$/i.test(token)
    || /^-n\d+$/i.test(token));
  if (!optionsSafe) return false;
  if (subcommand === "status") return true;
  if (["rev-parse", "merge-base", "ls-files"].includes(subcommand)) return true;
  if (subcommand === "remote") return args.length === 1 && args[0] === "-v";
  if (subcommand === "branch") return args.every((item) => ["--show-current", "-vv", "--list"].includes(item) || !item.startsWith("-"));
  if (subcommand === "worktree") return args[0] === "list" && args.length === 1;
  return false;
}
const SAFE_SHELL_READ_RE = /^\s*(?:findstr|where(?:\.exe)?|ls|dir|pwd|Get-Location|Get-Content|Get-ChildItem|Get-Item|Test-Path|Resolve-Path|Select-String|Measure-Object)(?:\s+[^\r\n;&|<>]*)?\s*$/i;
const SAFE_VERSION_RE = /^\s*(?:node|npm|gh|git)(?:\.exe|\.cmd)?\s+--version\s*$/i;
const SECRET_PATH_RE = /(?:^|[\s\\/'"])(?:\.env(?:[./]|$)|[^\s\\/'"]*\.(?:pem|key|p12|pfx)|credentials?(?:[./]|$)|secrets?(?:[./]|$)|id_(?:rsa|dsa|ecdsa|ed25519)(?:[./]|$))/i;

function secretReadSelector(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  const collapsedGlob = normalized
    .replace(/\[([A-Za-z0-9._-])\]/g, "$1")
    .replace(/[*?[\]{}!,]/g, "/");
  return SECRET_PATH_RE.test(normalized)
    || SECRET_PATH_RE.test(collapsedGlob)
    || /\{[^}]*?(?:\.env|\b(?:pem|key|p12|pfx|credentials?|secrets?|id_(?:rsa|dsa|ecdsa|ed25519))\b)[^}]*}/i.test(normalized);
}
const POWERSHELL_PROVIDER_PATH_RE = /(?:^|[\s"'`])(?:[A-Za-z_][\w.-]*::|[A-Za-z_][\w.-]{1,}:|[A-Za-z]:(?![\\/]))/i;

function isShellMutation(toolName, toolInput) {
  if (!/^(?:Bash|PowerShell|shell_command)$/i.test(String(toolName || ""))) return false;
  const command = String(toolInput?.command || "").trim();
  if (!command) return false;
  if (/[\r\n]/.test(command)) return true;
  if (SHELL_MUTATION_RE.test(command)) return true;
  if (/\$\(|`|\b(?:invoke-expression|iex)\b/i.test(command)) return true;
  if (SAFE_NPM_RUN_RE.test(command)
      || SAFE_NODE_RE.test(command)
      || Boolean(nodeCheckTarget(command))
      || isSafeGitRead(command)
      || SAFE_SHELL_READ_RE.test(command)
      || SAFE_VERSION_RE.test(command)) {
    return false;
  }
  return true;
}

function isBuildMutation(toolName, toolInput) {
  if (/^(?:Write|Edit|NotebookEdit|MultiEdit|apply_patch)$/i.test(String(toolName || ""))) return true;
  return isBuildActionUnderHold(toolName, toolInput) || isShellMutation(toolName, toolInput);
}

function isKnownStructuredFilesystemReadTool(toolName) {
  return /^(?:mcp__filesystem__read_file|mcp__desktop_commander__read_file)$/i
    .test(String(toolName || ""));
}

function isOpaqueExecutionTool(toolName) {
  const name = String(toolName || "");
  if (/^(?:Bash|PowerShell|shell_command)$/i.test(name)) return false;
  if (/^(?:Write|Edit|NotebookEdit|MultiEdit|apply_patch)$/i.test(name)) return false;
  if (/^(?:Read|Glob|Grep|LS|WebSearch|WebFetch|TaskOutput|TaskList|TaskGet|TodoWrite|AskUserQuestion|view_image)$/i.test(name)) return false;
  if (/^(?:collaboration[._-])?(?:list_agents|send_message|wait_agent)$/i.test(name)) return false;
  if (isKnownStructuredFilesystemReadTool(name)) return false;
  return true;
}

function structuredMutationTargets(toolName, toolInput) {
  if (!/^(?:Write|Edit|NotebookEdit|MultiEdit|apply_patch)$/i.test(String(toolName || ""))) return [];
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  const targets = [
    input.file_path,
    input.filePath,
    input.path,
    input.target,
    ...(Array.isArray(input.edits)
      ? input.edits.flatMap((edit) => [edit?.file_path, edit?.filePath, edit?.path, edit?.target])
      : []),
  ].filter(Boolean).map(String);
  const patchText = typeof toolInput === "string"
    ? toolInput
    : String(input.patch || input.input || "");
  for (const match of patchText.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)) {
    targets.push(match[1].trim());
  }
  return [...new Set(targets)];
}

function structuredMutationContent(toolInput) {
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  const direct = [
    input.content,
    input.new_string,
    input.newString,
    ...(Array.isArray(input.edits)
      ? input.edits.flatMap((edit) => [edit?.content, edit?.new_string, edit?.newString])
      : []),
  ].filter((value) => typeof value === "string");
  const patchText = typeof toolInput === "string"
    ? toolInput
    : String(input.patch || input.input || "");
  const additions = patchText
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
  return [...direct, ...additions].join("\n");
}

function structuredReadTargets(toolName, toolInput) {
  if (!/^(?:Read|Glob|Grep|LS)$/i.test(String(toolName || ""))
      && !isKnownStructuredFilesystemReadTool(toolName)) return [];
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  return [
    input.file_path,
    input.filePath,
    input.path,
    input.cwd,
    input.root,
    input.directory,
    input.search_path,
  ].filter(Boolean).map(String);
}

function structuredReadSelectors(toolName, toolInput) {
  const name = String(toolName || "");
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  const selectorNames = new Set([
    "glob", "globs", "include", "includes", "exclude", "excludes",
    "ignore", "ignores", "includeglob", "excludeglob", "ignoreglob", "iglob",
  ]);
  const selectors = [];
  for (const [key, value] of Object.entries(input)) {
    const normalized = key.replace(/[^a-z]/gi, "").toLowerCase();
    if (!selectorNames.has(normalized)) continue;
    const values = Array.isArray(value) ? value : [value];
    if (values.some((item) => typeof item !== "string")) {
      return { selectors: [], invalid: `structured ${name} selector ${key} is not a literal string` };
    }
    selectors.push(...values);
  }
  if (/^Glob$/i.test(name) && typeof input.pattern === "string") selectors.push(input.pattern);
  return { selectors, invalid: "" };
}

function grepVisibilityBlockReason(toolName, toolInput) {
  if (!/^Grep$/i.test(String(toolName || ""))) return "";
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  const unsafe = Object.entries(input).find(([key, value]) => {
    const normalized = key.replace(/[^a-z]/gi, "").toLowerCase();
    return (normalized.startsWith("noignore") || ["hidden", "follow"].includes(normalized))
      && value !== false && value != null && value !== "";
  });
  return unsafe ? `Grep option ${unsafe[0]} may expose hidden, ignored, or symlinked files` : "";
}

function nearestExistingPath(candidate) {
  let current = candidate;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return "";
    current = parent;
  }
  return current;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function readTargetBlockReason(rawTarget, projectDir, { allowGlob = false } = {}) {
  const root = path.resolve(projectDir);
  const text = String(rawTarget || "").trim();
  if (!text) return "";
  if (/[\0\r\n$%~]/.test(text)) return `read target is dynamic or ambiguous: ${text}`;
  const normalizedText = text.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  if (normalizedText === ".git" || normalizedText.startsWith(".git/") || normalizedText.includes("/.git/")) {
    return `Git internals are not readable in a factory lane: ${text}`;
  }
  if (secretReadSelector(text)) {
    return `secret-bearing paths are not readable in a factory lane: ${text}`;
  }
  const stablePrefix = allowGlob ? text.split(/[*?[\]{}]/, 1)[0] || "." : text;
  const absolute = path.resolve(root, stablePrefix);
  if (!isInside(root, absolute)) return `read target escapes the worktree: ${text}`;
  const existing = nearestExistingPath(absolute);
  if (!existing || !isInside(realpathSync(root), realpathSync(existing))) {
    return `read target resolves outside the worktree through a symlink: ${text}`;
  }
  const relative = path.relative(root, absolute).replace(/\\/g, "/");
  if (relative && ignoredByGit(root, relative)) {
    return `ignored paths are not readable in a factory lane: ${relative}`;
  }
  return "";
}

function governedReadBlockReason(toolName, toolInput, projectDir) {
  const name = String(toolName || "");
  if (/^(?:Read|Glob|Grep|LS)$/i.test(name) || isKnownStructuredFilesystemReadTool(name)) {
    const input = toolInput && typeof toolInput === "object" ? toolInput : {};
    const visibilityReason = grepVisibilityBlockReason(name, input);
    if (visibilityReason) return visibilityReason;
    const targets = structuredReadTargets(name, input);
    if ((/^Read$/i.test(name) || isKnownStructuredFilesystemReadTool(name)) && targets.length === 0) {
      return "structured read did not expose an exact file target";
    }
    for (const target of targets) {
      const reason = readTargetBlockReason(target, projectDir, { allowGlob: /^Glob$/i.test(name) });
      if (reason) return reason;
    }
    const { selectors, invalid } = structuredReadSelectors(name, input);
    if (invalid) return invalid;
    for (const selector of selectors) {
      const reason = readTargetBlockReason(selector, projectDir, { allowGlob: true });
      if (reason) return reason;
    }
    return "";
  }
  if (!/^(?:Bash|PowerShell|shell_command)$/i.test(name)) return "";
  const command = String(toolInput?.command || "").trim();
  if (/[\r\n]/.test(command)) {
    return "shell reads must contain exactly one command without line breaks";
  }
  const checkedNodeTarget = nodeCheckTarget(command);
  if (checkedNodeTarget) return readTargetBlockReason(checkedNodeTarget, projectDir);
  if (!SAFE_SHELL_READ_RE.test(command)) return "";
  if (secretReadSelector(command)) {
    return "secret-bearing paths are not readable in a factory lane";
  }
  if (POWERSHELL_PROVIDER_PATH_RE.test(command)) {
    return "PowerShell provider paths are not readable in a factory lane";
  }
  if (/(?:^|[\s\\/])\.\.(?:[\\/]|$)|[$%~*?[\]{}()]|\\\\/.test(command)) {
    return "shell reads must use stable paths inside the worktree";
  }
  const shellTokens = command.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  if (shellTokens.join(" ") !== command.replace(/\s+/g, " ").trim()) {
    return "shell reads must use unambiguous literal arguments";
  }
  for (const rawToken of shellTokens.slice(1)) {
    const token = rawToken.replace(/^(['"])([\s\S]*)\1$/, "$2");
    if (!token || token.startsWith("-")) {
      if (/[:=]/.test(token)) return "shell read options cannot hide path values";
      continue;
    }
    if (token.includes(",")) return "shell reads cannot use array or comma-separated paths";
    const reason = readTargetBlockReason(token, projectDir);
    if (reason) return reason;
  }
  const absoluteTargets = [...command.matchAll(
    /(?:^|\s)["']?([A-Za-z]:[\\/][^\s"';&|<>]+|\/[^\s"';&|<>]+)["']?/g,
  )].map((match) => match[1]);
  for (const target of absoluteTargets) {
    const reason = readTargetBlockReason(target, projectDir);
    if (reason) return reason;
  }
  return "";
}

function fixedGitExecutable() {
  const candidates = process.platform === "win32"
    ? ["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\bin\\git.exe"]
    : ["/usr/bin/git", "/usr/local/bin/git"];
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

function ignoredByGit(projectDir, relative) {
  const executable = fixedGitExecutable();
  if (!executable) return true;
  try {
    execFileSync(executable, ["check-ignore", "--no-index", "--quiet", "--", relative], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: "ignore",
      timeout: 10_000,
    });
    return true;
  } catch (error) {
    if (error?.status === 1) return false;
    return true;
  }
}

function structuredMutationBlockReason(toolName, toolInput, projectDir, allowedPaths) {
  const targets = structuredMutationTargets(toolName, toolInput);
  if (targets.length === 0) {
    return "structured mutation did not expose an exact file target";
  }
  const root = path.resolve(projectDir);
  const realRoot = realpathSync(root);
  for (const rawTarget of targets) {
    const absolute = path.resolve(root, rawTarget);
    if (!isInside(root, absolute)) return `target escapes the worktree: ${rawTarget}`;
    const relative = path.relative(root, absolute).replace(/\\/g, "/");
    const lower = relative.toLowerCase();
    if (!relative || lower === ".git" || lower.startsWith(".git/")) {
      return `Git internals are not mutable lane content: ${relative || rawTarget}`;
    }
    if (SECRET_PATH_RE.test(relative)) {
      return `secret-bearing paths are forbidden: ${relative}`;
    }
    const existing = nearestExistingPath(absolute);
    if (!existing || !isInside(realRoot, realpathSync(existing))) {
      return `target resolves outside the worktree through a symlink: ${relative}`;
    }
    if (ignoredByGit(root, relative)) return `ignored paths are outside factory proof: ${relative}`;
    if (!pathAllowedByTicket(relative, allowedPaths)) {
      return `target is outside the approved ticket paths: ${relative}`;
    }
  }
  const mutationContent = structuredMutationContent(toolInput);
  if (mutationContent) {
    try {
      rejectSecretBearingText(mutationContent, "structured mutation");
    } catch {
      return "structured mutation appears to contain credential or secret material";
    }
  }
  return "";
}

function isActiveLaneShellRead(toolName, toolInput) {
  if (!/^(?:Bash|PowerShell|shell_command)$/i.test(String(toolName || ""))) return true;
  const command = String(toolInput?.command || "").trim();
  if (/[\r\n]/.test(command)) return false;
  return isSafeGitRead(command)
    || SAFE_SHELL_READ_RE.test(command)
    || SAFE_VERSION_RE.test(command)
    || Boolean(nodeCheckTarget(command));
}

function pushProofInvocation(toolName, toolInput, projectDir) {
  if (!/^(?:Bash|PowerShell|shell_command)$/i.test(String(toolName || ""))) return null;
  const command = String(toolInput?.command || "").trim().replace(/\\/g, "/");
  const absolute = path.join(projectDir, "scripts", "write-codex-push-proof.mjs").replace(/\\/g, "/");
  const match = command.match(new RegExp(
    `^node(?:\\.exe)?\\s+(?:[\"']?${absolute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\"']?|scripts/write-codex-push-proof\\.mjs)(?:\\s+--timeout\\s+([0-9]{3,4}))?$`,
    "i",
  ));
  if (!match) return null;
  const timeout = match[1] ? Number(match[1]) : 0;
  if (timeout && (timeout < 300 || timeout > 3600)) return null;
  return {
    canonicalCommand: `node ${JSON.stringify(absolute)}${timeout ? ` --timeout ${timeout}` : ""}`,
  };
}

function approvedLandingShellAction(toolName, toolInput, projectDir) {
  if (!/^(?:Bash|PowerShell|shell_command)$/i.test(String(toolName || ""))) return "";
  const command = String(toolInput?.command || "").trim();
  if (!command || /[\r\n;&|<>`$(){}[\]*?!~%]/.test(command)) return "";
  if (pushProofInvocation(toolName, toolInput, projectDir)) return "proof";
  if (/^git(?:\.exe)?\s+fetch\s+(?:--no-tags\s+)?origin\s+main\s*$/i.test(command)) return "refresh-base";
  if (/^git(?:\.exe)?\s+add\b/i.test(command)
      && !/\b(?:--pathspec-from-file|--interactive|--patch)\b|(?:^|\s)-[ip](?:\s|$)/i.test(command)) {
    return "stage";
  }
  if (/^git(?:\.exe)?\s+commit\b/i.test(command)
      && !/\b(?:--amend|--fixup|--squash|--reuse-message|--reedit-message|--no-verify)\b|(?:^|\s)--(?:file|template|pathspec-from-file)(?:=|\s)|(?:^|\s)-[A-Za-z]*[cCFn](?:[^\s]*|\s)/.test(command)) {
    return "commit";
  }
  if (isGitPush(command)) {
    const executable = fixedGitExecutable();
    if (!executable) return "";
    let branch;
    try {
      branch = execFileSync(executable, ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: projectDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      }).trim();
    } catch {
      return "";
    }
    return pushTargetsCurrentHead(command, branch) ? "push" : "";
  }
  if (/^gh(?:\.exe)?\s+pr\s+create\b/i.test(command)
      && !/(?:^|\s)-(?:H|B)(?:\s|$)/.test(command)
      && !/(?:^|\s)-(?:F|T|f)(?:[^\s]*|\s)|\s--(?:body-file|template|fill|fill-first|fill-verbose|recover)(?:=|\s|$)|\s--head(?:=|\s)(?!HEAD\b)/i.test(command)
      && !/\s--base(?:=|\s)(?!main\b)/i.test(command)) {
    return "pr-create";
  }
  if (/^gh(?:\.exe)?\s+pr\s+merge(?:\s+\d+)?(?:\s+--(?:squash|merge|rebase|delete-branch))*\s*$/i.test(command)
      && !/\s--auto\b/i.test(command)) {
    return "merge";
  }
  if (/^gh(?:\.exe)?\s+pr\s+(?:view|checks)(?:\s|$)/i.test(command)) return "pr-read";
  return "";
}

let payload;
try { payload = JSON.parse(readFileSync(0, "utf8")); } catch { nothing(); }

const sessionId = String(payload?.session_id || payload?.thread_id || payload?.conversation_id || "").trim();
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const shellWorkingDirectoryBlock = shellWorkingDirectoryBlockReason(
  payload?.tool_name,
  payload?.tool_input,
  projectDir,
);
const shellEnvironmentBlock = shellEnvironmentBlockReason(payload?.tool_name, payload?.tool_input);
const shellMutation = isShellMutation(payload?.tool_name, payload?.tool_input);
const opaqueExecution = isOpaqueExecutionTool(payload?.tool_name);
const shellOutsideInspection = /^(?:Bash|PowerShell|shell_command)$/i.test(String(payload?.tool_name || ""))
  && !isActiveLaneShellRead(payload?.tool_name, payload?.tool_input);
const buildMutation = isBuildMutation(payload?.tool_name, payload?.tool_input)
  || opaqueExecution
  || shellOutsideInspection
  || Boolean(shellEnvironmentBlock);
const factoryCli = factoryCliInvocation(payload?.tool_name, payload?.tool_input, projectDir);
const actorTool = String(process.env.CRX_AGENT_SURFACE || payload?.agent_type || payload?.tool_surface || "claude").toLowerCase().includes("codex")
  ? "codex"
  : "claude";
const paths = resolveHookFactoryPaths(projectDir);
const intentRecordFailed = Boolean(sessionId) && hasFactoryIntentFailureLatch(paths, sessionId);

let snapshot;
try {
  snapshot = loadFactorySnapshot(paths);
} catch (error) {
  if (factoryCli?.status || !buildMutation) nothing();
  if (factoryCli?.recovery) {
    if (!sessionId) deny("CRX FACTORY GATE: recovery requires a verifiable chat session.");
    if (shellWorkingDirectoryBlock) {
      deny(`CRX FACTORY GATE: ${shellWorkingDirectoryBlock}. Factory commands must execute from the governed checkout.`);
    }
    const permit = mintFactoryCliPermit(paths, {
      sessionId,
      actorTool,
      expectedLastEventHash: "0".repeat(64),
    });
    allowWithPermit(payload, permit.token, factoryCli.canonicalCommand, projectDir);
  }
  deny(`CRX FACTORY GATE: shared factory state could not be verified (${error.message}). Factory-managed build writes fail closed.`);
}

const otherCustody = snapshot.jobs.find((job) =>
  FACTORY_CUSTODY_STAGES.has(job.stage)
  && (job.laneSessionId || job.sessionId) !== sessionId,
);
const factoryCliJob = factoryCli?.jobId
  ? snapshot.jobs.find((job) => job.id === factoryCli.jobId)
  : null;

if (factoryCli) {
  if (shellEnvironmentBlock) {
    deny(`CRX FACTORY GATE: ${shellEnvironmentBlock}. The trusted hook supplies the only permitted factory environment value.`);
  }
  if (shellWorkingDirectoryBlock) {
    deny(`CRX FACTORY GATE: ${shellWorkingDirectoryBlock}. Factory commands must execute from the governed checkout.`);
  }
  if (factoryCli.status) allowWithCommand(payload, factoryCli.canonicalCommand, projectDir);
  if (!sessionId) deny("CRX FACTORY GATE: mutating factory commands require a verifiable chat session.");
  if (intentRecordFailed && !factoryCli.recovery) {
    deny("CRX FACTORY GATE: Mason's factory intent was not recorded in the ledger. Only status/recovery is available until the prompt is re-submitted successfully.");
  }
  if (snapshot.held && !factoryCli.recovery) {
    deny(`CRX FACTORY GATE: the factory is globally paused${snapshot.holdReason ? ` (${snapshot.holdReason})` : ""}. Only status and canonical recovery remain available.`);
  }
  if (!factoryCli.recovery && otherCustody) {
    deny(`CRX FACTORY GATE: pilot job ${otherCustody.id} is under factory custody at ${otherCustody.stage} in another chat. Factory commands cannot seize or rewind another chat's job.`);
  }
  if (!factoryCli.recovery
      && factoryCliJob
      && (factoryCliJob.laneSessionId || factoryCliJob.sessionId) !== sessionId) {
    deny(`CRX FACTORY GATE: factory job ${factoryCliJob.id} belongs to another chat session.`);
  }
  const permit = mintFactoryCliPermit(paths, {
    sessionId,
    actorTool,
    expectedLastEventHash: snapshot.lastEventHash,
  });
  allowWithPermit(payload, permit.token, factoryCli.canonicalCommand, projectDir);
}
if (buildMutation && otherCustody) {
  deny(`CRX FACTORY GATE: pilot job ${otherCustody.id} is under factory custody at ${otherCustody.stage} in another chat. The one-lane pilot blocks cross-session repository writes and opaque helper execution from ticket presentation through owner disposition.`);
}
if (!sessionId) nothing();

const sessionJobs = snapshot.jobs.filter((job) => job.sessionId === sessionId);
const hasIntent = snapshot.factoryIntentSessions.includes(sessionId);
const governedJob = sessionJobs.find((job) =>
  FACTORY_CUSTODY_STAGES.has(job.stage) || job.stage === "parked",
);
if (!hasIntent && !governedJob && !intentRecordFailed) nothing();
if (shellWorkingDirectoryBlock) {
  deny(`CRX FACTORY GATE: ${shellWorkingDirectoryBlock}. Shell inspection must execute from the governed checkout.`);
}
if (shellEnvironmentBlock) {
  deny(`CRX FACTORY GATE: ${shellEnvironmentBlock}. Remove tool-level environment fields and use the canonical command.`);
}
const readBlockReason = governedReadBlockReason(payload?.tool_name, payload?.tool_input, projectDir);
if (readBlockReason) {
  deny(`CRX FACTORY GATE: ${readBlockReason}. Use tracked, non-secret files inside the governed worktree.`);
}
if (!buildMutation) nothing();

if (intentRecordFailed) {
  deny("CRX FACTORY GATE: Mason requested factory-managed work, but its ledger intent could not be recorded. Build writes fail closed until the ledger is recovered and the owner prompt is re-submitted.");
}

if (snapshot.held) {
  deny(`CRX FACTORY GATE: the factory is globally paused${snapshot.holdReason ? ` (${snapshot.holdReason})` : ""}. Reads and verification remain available; build writes are blocked.`);
}
if (!governedJob) {
  deny("CRX FACTORY GATE: this chat requested factory/autonomous work, but no mission ticket is presented and approved. Draft and present the ticket through scripts/factory.mjs before any implementation.");
}
if (governedJob.stage === "needs-ticket-ok") {
  deny(`CRX FACTORY GATE: ticket ${governedJob.id} is waiting for Mason's exact chat approval. Ask only its recorded yes/no question.`);
}
if (governedJob.stage === "queued") {
  deny(`CRX FACTORY GATE: ticket ${governedJob.id} is approved but the deterministic lane-start check has not run. Start it through scripts/factory.mjs lane start.`);
}
if (ACTIVE_STAGES.has(governedJob.stage)) {
  if (/^(?:Write|Edit|NotebookEdit|MultiEdit|apply_patch)$/i.test(String(payload?.tool_name || ""))) {
    const blockReason = structuredMutationBlockReason(
      payload?.tool_name,
      payload?.tool_input,
      projectDir,
      governedJob.ticket?.allowedPaths,
    );
    if (blockReason) {
      deny(`CRX FACTORY GATE: ${blockReason}. Update and re-approve the mission ticket before widening scope.`);
    }
  }
  if (shellMutation || opaqueExecution || !isActiveLaneShellRead(payload?.tool_name, payload?.tool_input)) {
    deny("CRX FACTORY GATE: direct commands and helper-process execution are disabled inside an active lane. Use structured Write/Edit/apply_patch operations, read-only shell inspection, or the permit-bound factory CLI (including evidence run for fixed harnesses) so every mutation target remains visible to the guards.");
  }
  nothing();
}
if (governedJob.stage === "approved-to-land") {
  const landingAction = approvedLandingShellAction(
    payload?.tool_name,
    payload?.tool_input,
    projectDir,
  );
  if (!landingAction) {
    deny(`CRX FACTORY GATE: job ${governedJob.id} is approved to land, so only exact-byte /ship landing commands are available. Source edits, alternate-ref pushes, auto-merge, and other mutations require parking the job, fresh proof, and a new morning acceptance.`);
  }
  try {
    validateApprovedFactoryLanding(projectDir, {
      paths,
      commitish: ["proof", "push", "pr-create", "merge"].includes(landingAction) ? "HEAD" : "",
    });
  } catch (error) {
    deny(`CRX FACTORY GATE: the accepted landing bytes are no longer valid (${error.message}). Park the job, rerun evidence and Sol/high review, and re-present the exact morning decision before landing.`);
  }
  if (landingAction === "proof") {
    const proof = pushProofInvocation(payload?.tool_name, payload?.tool_input, projectDir);
    allowWithCommand(payload, proof.canonicalCommand, projectDir);
  }
  nothing();
}

deny(`CRX FACTORY GATE: job ${governedJob.id} is ${governedJob.stage}. Further build writes are parked until Mason disposes the job in chat.`);
