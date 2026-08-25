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

import { readFileSync, existsSync, readdirSync, realpathSync, lstatSync, readlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { builtinModules } from "node:module";
import { performance } from "node:perf_hooks";
import path from "node:path";
import {
  aliasesProtectedFile,
  canonicalizeThroughExistingAncestor,
  fileIdentity,
  protectedControlPathReason,
  protectedFileIdentities,
  protectedProofCreationReason,
} from "./protected-identity-lib.mjs";

export const SECURITY_COMMAND_CHAR_BUDGET = 16_384;
export const SECURITY_COMMAND_TOKEN_BUDGET = 512;
export const REVIEWED_EXECUTOR_PROVENANCE_BUDGET_MS = 3_500;
export const REVIEWED_EXECUTOR_MAX_TRACKED_FILES = 4_096;
export const REVIEWED_EXECUTOR_MAX_TRACKED_BYTES = 128 * 1024 * 1024;
export const REVIEWED_EXECUTOR_MAX_TRACKED_FILE_BYTES = 16 * 1024 * 1024;
const SECURITY_CONFIG_FILE_BUDGET_BYTES = 1024 * 1024;
const AUTHORITATIVE_REPOSITORY_URL = "https://github.com/masonwells1/CRX_Manager_V1.0.git";
const commandExceedsSecurityBudget = (command) => String(command || "").length > SECURITY_COMMAND_CHAR_BUDGET;
const normalizePosixLineContinuations = (command) => String(command || "").replace(/\\\r?\n/g, "");
const preservePowerShellLineBoundaries = (command) => String(command || "").replace(/\\(\r?\n)/g, "$1");
const commandInspectionViews = (command) => [...new Set([
  preservePowerShellLineBoundaries(command),
  normalizePosixLineContinuations(command),
])];

export function fixedTrustedGitExecutable() {
  const candidates = process.platform === "win32"
    ? ["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\bin\\git.exe"]
    : ["/usr/bin/git", "/usr/local/bin/git"];
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error("A fixed trusted Git executable is required for executor provenance checks.");
  return executable;
}

const DANGEROUS_GIT_ENV_NAME_RE = /^GIT_(?:CONFIG(?:_.+)?|DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|REPLACE_REF_BASE|COMMON_DIR|NAMESPACE|EXEC_PATH|EXTERNAL_DIFF|DIFF_OPTS)$/i;

function resolvedBareGitExecutable(cwd) {
  const directories = [cwd, ...String(process.env.PATH || "").split(path.delimiter).filter(Boolean)];
  const names = process.platform === "win32"
    ? String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((extension) => `git${extension.toLowerCase()}`)
    : ["git"];
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.resolve(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "";
}

function sameExecutablePath(left, right) {
  const normalize = (value) => {
    const candidate = path.resolve(String(value || ""));
    let resolved = candidate;
    try { resolved = realpathSync.native(candidate); } catch { /* Missing candidates cannot equal the trusted executable. */ }
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function bootstrapGitSafetyReason(root, gitExecutable, runGit, gitEnv, provenanceDeadlineExhausted) {
  const inherited = Object.keys(process.env).find((name) => DANGEROUS_GIT_ENV_NAME_RE.test(name));
  if (inherited) return `Git control environment variable ${inherited} is present`;
  const bareGit = resolvedBareGitExecutable(root);
  if (!bareGit || !sameExecutablePath(bareGit, gitExecutable)) {
    return "bare Git does not resolve to the fixed trusted executable";
  }
  // Inspect the exact configuration scope used by every trusted bootstrap Git
  // call. Global/system config and system attributes stay disabled in gitEnv,
  // so only repository-local settings can be effective here.
  const configInspectionEnv = { ...gitEnv };
  const readConfig = (key) => runGit(
    ["-C", root, "--no-replace-objects", "config", "--includes", "--get-all", key],
    { encoding: "utf8", windowsHide: true, env: configInspectionEnv },
  );
  const fsmonitor = readConfig("core.fsmonitor");
  if (fsmonitor.error || ![0, 1].includes(fsmonitor.status)) return "effective Git fsmonitor configuration could not be verified";
  if (fsmonitor.status === 0 && String(fsmonitor.stdout || "").trim().toLowerCase() !== "false") {
    return "effective Git core.fsmonitor can execute code before review";
  }
  const externalDiff = readConfig("diff.external");
  if (externalDiff.error || ![0, 1].includes(externalDiff.status)) return "effective Git diff.external configuration could not be verified";
  if (externalDiff.status === 0 && String(externalDiff.stdout || "").trim()) return "effective Git diff.external can execute code before review";
  const executableFilters = runGit(
    ["-C", root, "--no-replace-objects", "config", "--includes", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"],
    { encoding: "utf8", windowsHide: true, env: configInspectionEnv },
  );
  if (executableFilters.error || ![0, 1].includes(executableFilters.status)) return "effective Git executable filters could not be verified";
  if (executableFilters.status === 0 && String(executableFilters.stdout || "").trim()) return "effective Git filter clean, smudge, or process configuration can execute code before review";
  const attributesFile = runGit(
    ["-C", root, "--no-replace-objects", "config", "--includes", "--get-all", "core.attributesfile"],
    { encoding: "utf8", windowsHide: true, env: configInspectionEnv },
  );
  if (attributesFile.error || ![0, 1].includes(attributesFile.status)) return "effective Git attributes override could not be verified";
  if (attributesFile.status === 0 && String(attributesFile.stdout || "").trim()) return "effective Git core.attributesfile can activate unreviewed filters before review";
  const gitInfoAttributes = runGit(
    ["-C", root, "--no-replace-objects", "rev-parse", "--git-path", "info/attributes"],
    { encoding: "utf8", windowsHide: true, env: gitEnv },
  );
  if (gitInfoAttributes.error || gitInfoAttributes.status !== 0) return "Git info attributes path could not be verified";
  const rawInfoAttributesPath = String(gitInfoAttributes.stdout || "").trim();
  const infoAttributesPath = path.isAbsolute(rawInfoAttributesPath) ? rawInfoAttributesPath : path.resolve(root, rawInfoAttributesPath);
  if (provenanceDeadlineExhausted()) return "reviewed provenance deadline expired before Git info attributes verification";
  if (infoAttributesPath && existsSync(infoAttributesPath)) {
    try {
      const stat = lstatSync(infoAttributesPath);
      if (!stat.isFile() || stat.size > SECURITY_CONFIG_FILE_BUDGET_BYTES) return "Git info/attributes exceeds the auditable configuration boundary";
      if (readFileSync(infoAttributesPath, "utf8").trim()) return "unreviewed Git info/attributes can activate executable filters before review";
    } catch {
      return "Git info/attributes could not be verified inert";
    }
    if (provenanceDeadlineExhausted()) return "reviewed provenance deadline expired while reading Git info attributes";
  }
  const replacements = runGit(
    ["-C", root, "--no-replace-objects", "for-each-ref", "--format=%(refname)", "refs/replace"],
    { encoding: "utf8", windowsHide: true, env: gitEnv },
  );
  if (replacements.error || replacements.status !== 0) return "Git replacement refs could not be verified absent";
  if (String(replacements.stdout || "").trim()) return "Git replacement refs are present";
  return null;
}

function gitControlEnvironmentAssignmentReason(command) {
  const names = "GIT_(?:CONFIG(?:_[A-Z0-9_]+)?|DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|REPLACE_REF_BASE|COMMON_DIR|NAMESPACE|EXEC_PATH|EXTERNAL_DIFF|DIFF_OPTS)";
  const directAssignment = new RegExp(`\\b${names}\\b\\s*=`, "i");
  const providerAssignment = new RegExp(`(?:\\$?env:)${names}\\b[^\\r\\n;&|]*=`, "i");
  const itemWriterNames = [[115, 101, 116], [110, 101, 119], [99, 111, 112, 121], [109, 111, 118, 101]]
    .map((codes) => String.fromCharCode(...codes)).join("|");
  const providerItemWriter = new RegExp(`\\b(?:${itemWriterNames})-item\\b[^\\r\\n;&|]*(?:env:)${names}\\b`, "i");
  const environmentSetterName = String.fromCharCode(83, 101, 116, 69, 110, 118, 105, 114, 111, 110, 109, 101, 110, 116, 86, 97, 114, 105, 97, 98, 108, 101);
  const environmentSetter = new RegExp(`${environmentSetterName}\\s*\\(\\s*['\"]${names}['\"]`, "i");
  for (const text of commandInspectionViews(command)) {
    if (directAssignment.test(text) || providerAssignment.test(text) || providerItemWriter.test(text) || environmentSetter.test(text)) {
      return "Blocked Git control environment mutation. Git configuration, repository, index, object, replacement, executable, and external-diff overrides can execute or substitute unreviewed content before provenance checks.";
    }
  }
  return null;
}

const DANGEROUS_RUNTIME_ENV_NAME_RE = /^(?:NODE_OPTIONS|NPM_CONFIG_(?:USERCONFIG|GLOBALCONFIG|NODE_OPTIONS|SCRIPT_SHELL|EDITOR|SHELL)|PYTHON(?:PATH|HOME|STARTUP|USERBASE|INSPECT))$/i;

function runtimeExecutionSegments(command) {
  const tokens = tokenizeShellWords(command);
  const hardBoundary = (token) => token?.control && /^(?:;|&|\||\n)$/.test(token.value);
  const executableName = (token) => String(token?.value || "")
    .replace(/^@/, "")
    .replace(/\\([^\\/])/g, "$1")
    .replace(/\^([^^])/g, "$1")
    .replace(/`([^`])/g, "$1")
    .split(/[\\/]/)
    .pop()
    .replace(/\.(?:exe|cmd|bat|ps1)$/i, "")
    .toLowerCase();
  const wrappers = new Set(["command", "builtin", "env", "sudo", "doas", "exec", "nohup", "nice", "timeout", "wsl"]);
  const segments = [];
  for (let start = 0; start < tokens.length;) {
    while (start < tokens.length && hardBoundary(tokens[start])) start += 1;
    let end = start;
    while (end < tokens.length && !hardBoundary(tokens[end])) end += 1;
    const words = tokens.slice(start, end).filter((token) => !token.control);
    let cursor = 0;
    while (/^(?:[A-Za-z_]\w*\+?=|\$env:[A-Za-z_]\w*\s*=)/i.test(words[cursor]?.value || "")) cursor += 1;
    while (wrappers.has(executableName(words[cursor]))) {
      cursor += 1;
      while (/^(?:-|[A-Za-z_]\w*\+?=|\$env:[A-Za-z_]\w*\s*=)/i.test(words[cursor]?.value || "")) cursor += 1;
    }
    if (words[cursor]) segments.push({ executable: executableName(words[cursor]), args: words.slice(cursor + 1).map((token) => token.value) });
    start = end + 1;
  }
  return segments;
}

function runtimePreloadControlReason(command) {
  const segments = runtimeExecutionSegments(command);
  const runtimeNames = new Set(["node", "nodejs", "bun", "npm", "npx", "pnpm", "yarn", "corepack", "python", "python2", "python3", "py"]);
  const indirectRuntimeHosts = new Set(["pwsh", "powershell", "bash", "sh", "dash", "zsh", "ksh", "cmd", "cscript", "wscript"]);
  const pathBackedWrapper = commandInspectionViews(command).some((text) => /(?:^|[\s;&|])(?:["']?[^\s;&|"']+["']?)\.(?:ps1|bat|cmd|sh|py|js|mjs|cjs)\b/i.test(text));
  if (!segments.some((segment) => runtimeNames.has(segment.executable) || indirectRuntimeHosts.has(segment.executable)) && !pathBackedWrapper) return null;
  const inherited = Object.keys(process.env).find((name) => DANGEROUS_RUNTIME_ENV_NAME_RE.test(name));
  if (inherited) return `Blocked runtime preload/search-path control because inherited ${inherited} is present.`;
  const names = "(?:NODE_OPTIONS|NPM_CONFIG_(?:USERCONFIG|GLOBALCONFIG|NODE_OPTIONS|SCRIPT_SHELL|EDITOR|SHELL)|PYTHON(?:PATH|HOME|STARTUP|USERBASE|INSPECT)|HOME|USERPROFILE|XDG_CONFIG_HOME|COMSPEC|SHELL)";
  const itemWriterNames = [[115, 101, 116], [110, 101, 119], [99, 111, 112, 121], [109, 111, 118, 101]]
    .map((codes) => String.fromCharCode(...codes)).join("|");
  const environmentSetterName = String.fromCharCode(83, 101, 116, 69, 110, 118, 105, 114, 111, 110, 109, 101, 110, 116, 86, 97, 114, 105, 97, 98, 108, 101);
  const views = commandInspectionViews(command).flatMap((text) => [text, text.replace(/\^([^^])/g, "$1").replace(/`([^`])/g, "$1")]);
  for (const text of views) {
    const direct = new RegExp(`\\b${names}\\b\\s*=`, "i").test(text);
    const provider = new RegExp(`(?:\\$?env:)${names}\\b[^\\r\\n;&|]*=`, "i").test(text);
    const itemWriter = new RegExp(`\\b(?:${itemWriterNames})-item\\b[^\\r\\n;&|]*(?:env:)${names}\\b`, "i").test(text);
    const apiWriter = new RegExp(`${environmentSetterName}\\s*\\(\\s*['\"]${names}['\"]`, "i").test(text);
    if (direct || provider || itemWriter || apiWriter) {
      return "Blocked runtime preload/search-path mutation. Node, npm, and Python startup controls can execute unreviewed code before an exact-HEAD entry script.";
    }
  }
  return null;
}

function runtimeConfigurationReason(command, cwd) {
  const segments = runtimeExecutionSegments(command);
  const packageManagers = new Set(["npm", "npx", "pnpm", "yarn", "bun", "corepack"]);
  const dangerousPackageFlags = ["userconfig", "globalconfig", ["node", "options"].join("-"), ["script", "shell"].join("-"), "editor", "shell"];
  let packageManagerSeen = false;
  for (const { executable, args } of segments) {
    if (packageManagers.has(executable)) {
      packageManagerSeen = true;
      if (args.some((argument) => dangerousPackageFlags.some((flag) => new RegExp(`^--${flag}(?:=|$)`, "i").test(argument)))) {
        return "Blocked package-manager configuration override. User/global config and startup settings can preload unreviewed code.";
      }
    }
    if (["python", "python2", "python3", "py"].includes(executable)) {
      if (args.some((argument) => /^(?:--help|--version|-h|-V)$/.test(argument))) continue;
      const shortOptions = args.filter((argument) => /^-[A-Za-z]+$/.test(argument)).join("");
      if (!(shortOptions.includes("I") && shortOptions.includes("S"))) {
        return "Blocked non-isolated Python startup. Reviewed Python scripts must use both -I and -S so search paths, user-site modules, and startup hooks cannot run first.";
      }
    }
  }
  if (!packageManagerSeen) return null;
  const dangerousNpmKeys = [["node", "options"].join("-"), ["script", "shell"].join("-")];
  for (const candidate of [path.join(cwd || process.cwd(), ".npmrc"), path.join(process.env.HOME || process.env.USERPROFILE || "", ".npmrc")]) {
    if (!candidate || !existsSync(candidate)) continue;
    try {
      const content = readFileSync(candidate, "utf8");
      if (dangerousNpmKeys.some((key) => new RegExp(`^\\s*${key}\\s*=`, "im").test(content))) {
        return "Blocked executable npm configuration. Default package-manager startup settings can preload or redirect unreviewed code.";
      }
    } catch {
      return "Blocked unreadable npm configuration while package execution is protected.";
    }
  }
  return null;
}

const MAINTENANCE_PRODUCER_NAME = "apply-live-testdata-maintenance-20260812.mjs";
const MAINTENANCE_PRODUCER_ALLOWED_COMMANDS = new Set([
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --approved-by-mason=2026-08-12",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --approved-by-mason=2026-08-12 --protect-producer",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --approved-by-mason=2026-08-12 --retire-producer",
]);

const MAINTENANCE_PRODUCER_REPO_PATH = `scripts/${MAINTENANCE_PRODUCER_NAME}`;
const REVIEW_BOOTSTRAP_REPO_PATH = ["scripts", ["write", "codex", "push", "proof.mjs"].join("-")].join("/");
const REVIEW_BOOTSTRAP_EXACT_COMMAND = ["node", REVIEW_BOOTSTRAP_REPO_PATH].join(" ");

function shellGlobMatchesLiteral(pattern, literal) {
  const normalized = String(pattern || "")
    .replace(/^:\([^)]*\)/, "")
    .replace(/\\/g, "/")
    .toLowerCase();
  const target = String(literal || "").toLowerCase();
  const tokens = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*") {
      let runEnd = index;
      while (normalized[runEnd + 1] === "*") runEnd += 1;
      if (runEnd > index && normalized[runEnd + 1] === "/") {
        tokens.push({ type: "directories" });
        index = runEnd + 1;
      } else {
        tokens.push({ type: "star" });
        index = runEnd;
      }
      continue;
    }
    if (char === "?") {
      tokens.push({ type: "one" });
      continue;
    }
    if (char === "[") {
      const close = normalized.indexOf("]", index + 1);
      if (close < 0) return null;
      let body = normalized.slice(index + 1, close);
      let negated = false;
      if (body.startsWith("!") || body.startsWith("^")) {
        negated = true;
        body = body.slice(1);
      }
      tokens.push({ type: "class", body, negated });
      index = close;
      continue;
    }
    tokens.push({ type: "literal", char });
  }

  const classMatches = (token, char) => {
    let matched = false;
    for (let index = 0; index < token.body.length; index += 1) {
      const start = token.body[index];
      if (index + 2 < token.body.length && token.body[index + 1] === "-") {
        const end = token.body[index + 2];
        if (start <= char && char <= end) matched = true;
        index += 2;
      } else if (start === char) {
        matched = true;
      }
    }
    return token.negated ? !matched : matched;
  };

  let states = new Uint8Array(target.length + 1);
  states[0] = 1;
  for (const token of tokens) {
    const next = new Uint8Array(target.length + 1);
    if (token.type === "star") {
      const first = states.findIndex((state) => state === 1);
      if (first >= 0) next.fill(1, first);
    } else if (token.type === "directories") {
      for (let position = 0; position <= target.length; position += 1) {
        if (states[position]) next[position] = 1;
      }
      const first = states.findIndex((state) => state === 1);
      if (first >= 0) {
        for (let position = first; position < target.length; position += 1) {
          if (target[position] === "/") next[position + 1] = 1;
        }
      }
    } else {
      for (let position = 0; position < target.length; position += 1) {
        if (!states[position]) continue;
        if (token.type === "one"
          || (token.type === "literal" && token.char === target[position])
          || (token.type === "class" && classMatches(token, target[position]))) {
          next[position + 1] = 1;
        }
      }
    }
    states = next;
    if (!states.includes(1)) return false;
  }
  return states[target.length] === 1;
}

function gitBlobHash(buffer) {
  return createHash("sha1")
    .update(`blob ${buffer.length}\0`)
    .update(buffer)
    .digest("hex");
}

function createReviewedExecutorInspector(cwd, options = {}) {
  const base = cwd || process.cwd();
  // The dependency seams are for direct unit tests only. Production hook
  // entrypoints never accept or forward inspector options.
  const clock = typeof options.nowForTest === "function" ? options.nowForTest : performance.now.bind(performance);
  const spawnGitForTest = typeof options.spawnGitForTest === "function" ? options.spawnGitForTest : spawnSync;
  const onTrackedFileForTest = typeof options.onTrackedFileForTest === "function" ? options.onTrackedFileForTest : null;
  const deadline = clock() + REVIEWED_EXECUTOR_PROVENANCE_BUDGET_MS;
  const remainingProvenanceMs = () => Math.floor(deadline - clock());
  const provenanceDeadlineExhausted = () => remainingProvenanceMs() <= 0;
  const runGit = (args, spawnOptions = {}) => {
    const remaining = remainingProvenanceMs();
    if (remaining <= 0) return { status: null, error: new Error("reviewed Git provenance deadline exhausted") };
    const result = spawnGitForTest(gitExecutable, args, { ...spawnOptions, timeout: Math.min(remaining, REVIEWED_EXECUTOR_PROVENANCE_BUDGET_MS) });
    if (result?.error || result?.signal === "SIGTERM") return { ...result, error: result.error || new Error("reviewed Git provenance timed out") };
    if (provenanceDeadlineExhausted()) return { ...result, status: null, error: new Error("reviewed Git provenance deadline exhausted") };
    return result;
  };
  let gitExecutable = "";
  const gitEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"]) {
    if (process.env[name]) gitEnv[name] = process.env[name];
  }
  gitEnv.GIT_NO_REPLACE_OBJECTS = "1";
  gitEnv.GIT_CONFIG_NOSYSTEM = "1";
  gitEnv.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  gitEnv.GIT_TERMINAL_PROMPT = "0";
  gitEnv.GCM_INTERACTIVE = "never";
  gitEnv.GIT_OPTIONAL_LOCKS = "0";
  gitEnv.GIT_ATTR_NOSYSTEM = "1";
  let initialized = false;
  let root = "";
  let headSha = "";
  let baseSha = "";
  const headEntries = new Map();
  const mainEntries = new Map();
  let initializationError = "";
  let reason = "";
  let trackedTreeChecked = false;
  let trackedTreeError = "";

  const initialize = () => {
    if (initialized) return;
    initialized = true;
    try {
      gitExecutable = fixedTrustedGitExecutable();
    } catch {
      initializationError = "a fixed trusted Git executable could not be resolved";
      return;
    }
    const trustedGitPath = path.dirname(gitExecutable);
    const systemPath = process.platform === "win32"
      ? path.join(gitEnv.SystemRoot || gitEnv.WINDIR || "C:\\Windows", "System32")
      : "/usr/bin:/bin";
    gitEnv.PATH = `${trustedGitPath}${path.delimiter}${systemPath}`;
    const rootResult = runGit(["-C", base, "--no-replace-objects", "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      windowsHide: true,
      env: gitEnv,
    });
    root = String(rootResult.stdout || "").trim();
    if (rootResult.status !== 0 || !root) {
      initializationError = "the repository root could not be verified";
      return;
    }
    const headResult = runGit(["-C", root, "--no-replace-objects", "rev-parse", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
      env: gitEnv,
    });
    headSha = String(headResult.stdout || "").trim().toLowerCase();
    if (headResult.status !== 0 || !/^[a-f0-9]{40}$/.test(headSha)) {
      initializationError = "the exact HEAD could not be verified";
      return;
    }
    // Programmatic dependency injection exists only for direct unit tests. The
    // production hook entrypoints never accept or forward this option, so tool
    // input and inherited environment variables cannot replace GitHub's SHA.
    const injectedMainSha = String(options.authoritativeMainShaForTest || "").toLowerCase();
    if (injectedMainSha) {
      if (!/^[a-f0-9]{40}$/.test(injectedMainSha)) {
        initializationError = "the injected test main SHA is invalid";
        return;
      }
      baseSha = injectedMainSha;
    } else {
      const remoteResult = runGit(["ls-remote", "--exit-code", AUTHORITATIVE_REPOSITORY_URL, "refs/heads/main"], {
        cwd: path.parse(root).root,
        encoding: "utf8",
        windowsHide: true,
        env: gitEnv,
      });
      const remoteMatch = /^([a-f0-9]{40})\s+refs\/heads\/main\s*$/i.exec(String(remoteResult.stdout || ""));
      baseSha = String(remoteMatch?.[1] || "").toLowerCase();
      if (remoteResult.status !== 0 || !/^[a-f0-9]{40}$/.test(baseSha)) {
        initializationError = "the authoritative GitHub main SHA could not be verified";
        return;
      }
    }
    if (!/^[a-f0-9]{40}$/.test(baseSha)) {
      initializationError = "the authoritative main SHA could not be verified";
      return;
    }
    for (const [ref, entries] of [[headSha, headEntries], [baseSha, mainEntries]]) {
      const treeResult = runGit(["-C", root, "--no-replace-objects", "ls-tree", "-r", "--full-tree", ref], {
        encoding: "utf8",
        windowsHide: true,
        env: gitEnv,
      });
      if (treeResult.status !== 0) {
        initializationError = `the committed tree ${ref} could not be verified`;
        return;
      }
      for (const line of String(treeResult.stdout || "").split(/\r?\n/)) {
        const match = /^(\d+)\s+blob\s+([a-f0-9]{40})\t(.+)$/.exec(line);
        if (!match) continue;
        const key = process.platform === "win32" ? match[3].toLowerCase() : match[3];
        entries.set(key, { mode: match[1], blob: match[2].toLowerCase(), repoPath: match[3] });
      }
    }
  };

  const verifyTrackedTreeExact = () => {
    if (trackedTreeChecked) return trackedTreeError;
    trackedTreeChecked = true;
    const indexResult = runGit(
      ["-C", root, "--no-replace-objects", "ls-files", "--stage", "-z"],
      { windowsHide: true, env: gitEnv, maxBuffer: 16 * 1024 * 1024 },
    );
    if (indexResult.error || indexResult.status !== 0 || !Buffer.isBuffer(indexResult.stdout)) {
      trackedTreeError = "the exact index could not be verified without worktree filters";
      return trackedTreeError;
    }
    const indexEntries = new Map();
    for (const record of indexResult.stdout.toString("utf8").split("\0").filter(Boolean)) {
      if (provenanceDeadlineExhausted()) {
        trackedTreeError = "the reviewed provenance deadline expired while parsing the exact index";
        return trackedTreeError;
      }
      const match = /^(\d+)\s+([a-f0-9]{40})\s+(\d)\t([\s\S]+)$/i.exec(record);
      if (!match || match[3] !== "0") {
        trackedTreeError = "the index contains an unparseable or conflicted entry";
        return trackedTreeError;
      }
      const key = process.platform === "win32" ? match[4].toLowerCase() : match[4];
      if (indexEntries.has(key)) {
        trackedTreeError = "the index contains duplicate path identities";
        return trackedTreeError;
      }
      indexEntries.set(key, { mode: match[1], blob: match[2].toLowerCase(), repoPath: match[4] });
    }
    if (indexEntries.size > REVIEWED_EXECUTOR_MAX_TRACKED_FILES) {
      trackedTreeError = "the tracked tree exceeds the reviewed provenance file-count limit";
      return trackedTreeError;
    }
    if (indexEntries.size !== headEntries.size) {
      trackedTreeError = "the index path set differs from exact HEAD";
      return trackedTreeError;
    }
    let trackedBytes = 0;
    for (const [key, expectedEntry] of headEntries) {
      if (provenanceDeadlineExhausted()) {
        trackedTreeError = "the reviewed provenance deadline expired while verifying tracked worktree bytes";
        return trackedTreeError;
      }
      onTrackedFileForTest?.(expectedEntry.repoPath);
      if (provenanceDeadlineExhausted()) {
        trackedTreeError = "the reviewed provenance deadline expired before reading the next tracked worktree file";
        return trackedTreeError;
      }
      const entry = indexEntries.get(key);
      if (!entry || entry.mode !== expectedEntry.mode || entry.blob !== expectedEntry.blob) {
        trackedTreeError = "the index differs from exact HEAD";
        return trackedTreeError;
      }
      const diskPath = path.join(root, ...entry.repoPath.split("/"));
      let diskBytes;
      try {
        const stat = lstatSync(diskPath);
        if (expectedEntry.mode === "120000") {
          if (!stat.isSymbolicLink()) throw new Error("symlink mode mismatch");
          diskBytes = Buffer.from(readlinkSync(diskPath), "utf8");
        } else {
          if (!stat.isFile()) throw new Error("tracked path is not a regular file");
          if (stat.size > REVIEWED_EXECUTOR_MAX_TRACKED_FILE_BYTES) {
            trackedTreeError = "a tracked file exceeds the reviewed provenance per-file byte limit";
            return trackedTreeError;
          }
          trackedBytes += stat.size;
          if (trackedBytes > REVIEWED_EXECUTOR_MAX_TRACKED_BYTES) {
            trackedTreeError = "the tracked tree exceeds the reviewed provenance cumulative byte limit";
            return trackedTreeError;
          }
          diskBytes = readFileSync(diskPath);
        }
      } catch {
        trackedTreeError = "the tracked worktree file set is missing or has a mode mismatch";
        return trackedTreeError;
      }
      if (provenanceDeadlineExhausted()) {
        trackedTreeError = "the reviewed provenance deadline expired while reading tracked worktree bytes";
        return trackedTreeError;
      }
      const rawHash = gitBlobHash(diskBytes);
      if (provenanceDeadlineExhausted()) {
        trackedTreeError = "the reviewed provenance deadline expired while hashing tracked worktree bytes";
        return trackedTreeError;
      }
      if (rawHash !== expectedEntry.blob) {
        const normalizedBytes = Buffer.from(diskBytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
        const normalizedHash = gitBlobHash(normalizedBytes);
        if (provenanceDeadlineExhausted()) {
          trackedTreeError = "the reviewed provenance deadline expired while normalizing tracked worktree bytes";
          return trackedTreeError;
        }
        if (normalizedHash !== expectedEntry.blob) {
          trackedTreeError = "the tracked dependency tree worktree bytes differ from exact HEAD";
          return trackedTreeError;
        }
      }
    }
    return trackedTreeError;
  };

  const reviewedRuntimeClosureReason = (entryRepoPath) => {
    const extension = path.posix.extname(entryRepoPath).toLowerCase();
    if ([".json", ".toml", ".yaml", ".yml"].includes(extension)) return null;
    if (![".js", ".mjs", ".cjs"].includes(extension)) {
      return `the reviewed runtime entry ${entryRepoPath} is not auditable JavaScript and could launch an unreviewed child runtime`;
    }
    const safeBuiltins = new Set(builtinModules.map((name) => name.replace(/^node:/, "").split("/")[0]));
    const unsafeBuiltins = new Set(["child_process", "cluster", "module", "vm", "worker_threads"]);
    const queued = [entryRepoPath];
    const visited = new Set();
    while (queued.length > 0) {
      if (provenanceDeadlineExhausted()) {
        return "the reviewed provenance deadline expired while verifying the runtime dependency closure";
      }
      const repoPath = queued.pop();
      const key = process.platform === "win32" ? repoPath.toLowerCase() : repoPath;
      if (visited.has(key)) continue;
      visited.add(key);
      let source = "";
      try {
        const dependencyPath = path.join(root, ...repoPath.split("/"));
        const dependencyStat = lstatSync(dependencyPath);
        if (!dependencyStat.isFile() || dependencyStat.size > REVIEWED_EXECUTOR_MAX_TRACKED_FILE_BYTES) {
          return `the reviewed runtime dependency ${repoPath} exceeds the auditable file boundary`;
        }
        source = readFileSync(dependencyPath, "utf8");
      } catch {
        return `the reviewed runtime dependency ${repoPath} is unreadable`;
      }
      if (provenanceDeadlineExhausted()) {
        return "the reviewed provenance deadline expired while reading the runtime dependency closure";
      }
      if (/\b(?:eval|Function)\s*\(|\bprocess\.(?:binding|_linkedBinding|dlopen)\s*\(|\b(?:Bun\.spawn|Deno\.Command)\b|\b(?:getBuiltinModule|mainModule|createRequire)\b/.test(source)) {
        return `the reviewed runtime dependency ${repoPath} contains a dynamic code or native-process escape`;
      }
      const specifiers = [];
      for (const pattern of [
        /\bimport\s*["']([^"']+)["']/g,
        /\b(?:import|export)\s+[\s\S]*?\s+from\s*["']([^"']+)["']/g,
      ]) {
        for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
      }
      for (const match of source.matchAll(/\b(import|require)(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*\((?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*([^\r\n)]*)\)/g)) {
        const argument = match[2].trim();
        const literal = /^(?:["'])([^"']+)(?:["'])$/.exec(argument);
        if (!literal) return `the reviewed runtime dependency ${repoPath} contains a dynamic module loader`;
        specifiers.push(literal[1]);
      }
      for (const specifier of specifiers) {
        if (provenanceDeadlineExhausted()) {
          return "the reviewed provenance deadline expired while parsing the runtime dependency closure";
        }
        const normalizedBuiltin = specifier.replace(/^node:/, "").split("/")[0];
        if (unsafeBuiltins.has(normalizedBuiltin)) {
          return `the reviewed runtime dependency ${repoPath} can launch or evaluate mutable child code through ${specifier}`;
        }
        if (specifier.startsWith("node:") || safeBuiltins.has(normalizedBuiltin)) continue;
        if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
          return `the reviewed runtime dependency ${repoPath} imports mutable package code through ${specifier}`;
        }
        const unresolved = path.posix.normalize(path.posix.join(path.posix.dirname(repoPath), specifier));
        if (unresolved === ".." || unresolved.startsWith("../") || path.posix.isAbsolute(unresolved)) {
          return `the reviewed runtime dependency ${repoPath} resolves outside the repository`;
        }
        const candidates = path.posix.extname(unresolved)
          ? [unresolved]
          : [unresolved, ...[".mjs", ".js", ".cjs", ".json"].map((suffix) => `${unresolved}${suffix}`), ...["index.mjs", "index.js", "index.cjs", "index.json"].map((name) => path.posix.join(unresolved, name))];
        const dependency = candidates.find((candidate) => headEntries.has(process.platform === "win32" ? candidate.toLowerCase() : candidate));
        if (!dependency) return `the reviewed runtime dependency ${repoPath} resolves ${specifier} to ignored or untracked code`;
        const dependencyKey = process.platform === "win32" ? dependency.toLowerCase() : dependency;
        if (headEntries.get(dependencyKey)?.mode === "120000") {
          return `the reviewed runtime dependency ${dependency} is a symlink and could resolve outside exact HEAD`;
        }
        const dependencyExtension = path.posix.extname(dependency).toLowerCase();
        if (dependencyExtension === ".json") continue;
        if (![".js", ".mjs", ".cjs"].includes(dependencyExtension)) {
          return `the reviewed runtime dependency ${repoPath} loads unsupported executable content from ${dependency}`;
        }
        queued.push(dependency);
      }
    }
    return null;
  };

  const inspect = (scriptPath) => {
    if (reason) return true;
    const rawPath = String(scriptPath || "");
    if (!rawPath || /[*?\[\]{}$`]|[<>]\(|\$\(|\$\{|![^!\r\n]+!|%[^%\r\n]+%/.test(rawPath)) {
      reason = "the file-backed executor path is dynamic or missing";
      return true;
    }
    let resolvedCandidates = [path.resolve(base, rawPath)];
    if (!/[\\/]/.test(rawPath) && !/\.[A-Za-z0-9]+$/.test(rawPath)) {
      if (provenanceDeadlineExhausted()) {
        reason = "the reviewed provenance deadline expired before resolving the file-backed executor";
        return true;
      }
      try {
        const bareName = rawPath.toLowerCase();
        const executableExtensions = new Set([
          "", ".com", ".exe", ".bat", ".cmd", ".ps1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".msc",
          ...String(process.env.PATHEXT || "").toLowerCase().split(";").filter(Boolean),
        ]);
        resolvedCandidates = readdirSync(base, { withFileTypes: true })
          .filter((entry) => {
            if (!(entry.isFile() || entry.isSymbolicLink())) return false;
            const parsed = path.parse(entry.name.toLowerCase());
            return parsed.name === bareName && executableExtensions.has(parsed.ext);
          })
          .map((entry) => path.join(base, entry.name));
      } catch {
        return false;
      }
      if (provenanceDeadlineExhausted()) {
        reason = "the reviewed provenance deadline expired while resolving the file-backed executor";
        return true;
      }
      if (resolvedCandidates.length === 0) return false;
    }
    initialize();
    if (initializationError) {
      reason = initializationError;
      return true;
    }
    for (const resolved of resolvedCandidates) {
      const relative = path.relative(root, resolved);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        reason = "the file-backed executor is outside the repository";
        return true;
      }
      const repoPath = relative.split(path.sep).join("/");
      const key = process.platform === "win32" ? repoPath.toLowerCase() : repoPath;
      const expectedHeadEntry = headEntries.get(key);
      if (!expectedHeadEntry) {
        reason = "the file-backed executor is ignored or untracked at exact HEAD";
        return true;
      }
      try {
        const stat = lstatSync(resolved);
        if (expectedHeadEntry.mode === "120000" || !stat.isFile() || stat.isSymbolicLink()
          || stat.size > REVIEWED_EXECUTOR_MAX_TRACKED_FILE_BYTES) {
          reason = "the file-backed executor type differs from a regular file at exact HEAD";
          return true;
        }
        if (gitBlobHash(readFileSync(resolved)) !== expectedHeadEntry.blob) {
          reason = "the file-backed executor worktree bytes differ from exact HEAD";
          return true;
        }
      } catch {
        reason = "the file-backed executor is missing or unreadable";
        return true;
      }
      if (provenanceDeadlineExhausted()) {
        reason = "the reviewed provenance deadline expired while verifying the file-backed executor";
        return true;
      }
      const bootstrapPath = REVIEW_BOOTSTRAP_REPO_PATH;
      if (repoPath === bootstrapPath && options.exactReviewBootstrapInvocation !== true) {
        reason = "the exact-review bootstrap was invoked with runtime options, wrappers, chaining, alternate spelling, or extra arguments instead of its one exact Node command";
        return true;
      }
      const expectedMainEntry = mainEntries.get(key);
      const bootstrapMatchesMain = expectedMainEntry?.mode === expectedHeadEntry.mode
        && expectedMainEntry?.blob === expectedHeadEntry.blob;
      if (repoPath === bootstrapPath && bootstrapMatchesMain) {
        const bootstrapReason = bootstrapGitSafetyReason(root, gitExecutable, runGit, gitEnv, provenanceDeadlineExhausted);
        if (bootstrapReason) {
          reason = bootstrapReason;
          return true;
        }
      }
      const dependencyTreeReason = verifyTrackedTreeExact();
      if (dependencyTreeReason) {
        reason = dependencyTreeReason;
        return true;
      }
      if (repoPath === bootstrapPath && bootstrapMatchesMain) {
        continue;
      }
      const verifyRuntimeClosure = () => {
        if (repoPath === MAINTENANCE_PRODUCER_REPO_PATH) return null;
        return reviewedRuntimeClosureReason(repoPath);
      };
      if (headSha === baseSha) {
        const runtimeClosureReason = verifyRuntimeClosure();
        if (runtimeClosureReason) {
          reason = runtimeClosureReason;
          return true;
        }
        continue;
      }
      let proofValid = false;
      try {
        if (provenanceDeadlineExhausted()) {
          reason = "the reviewed provenance deadline expired before verifying the exact-SHA review proof";
          return true;
        }
        const proofName = [["codex", "review", headSha].join("-"), "json"].join(".");
        const proof = JSON.parse(readFileSync(path.join(root, ".claude", "session-state", proofName), "utf8"));
        const timestamp = Date.parse(proof?.timestamp);
        const age = Date.now() - timestamp;
        if (proof?.codex_ran === true
          && proof?.verdict === "clean"
          && proof?.model === "gpt-5.6-sol"
          && proof?.reasoning_effort === "high"
          && proof?.head_sha === headSha
          && proof?.base_sha === baseSha
          && Number.isFinite(timestamp)
          && age >= 0
          && age <= 30 * 60 * 1_000) proofValid = true;
      } catch {
        // Missing, malformed, stale, or inaccessible proof is handled below.
      }
      if (!proofValid) {
        reason = "the feature-branch HEAD lacks a fresh exact-SHA independent review proof";
        return true;
      }
      const runtimeClosureReason = verifyRuntimeClosure();
      if (runtimeClosureReason) {
        reason = runtimeClosureReason;
        return true;
      }
    }
    return false;
  };

  return {
    inspect,
    getReason: () => reason
      ? `Blocked file-backed interpreter while the maintenance producer is protected because ${reason}. Run the protected exact-head review producer first; ignored, external, untracked, worktree-divergent, and unreviewed feature-branch wrappers are denied.`
      : null,
  };
}

function maintenanceProducerIntegrityReason(command, inspector) {
  const value = String(command || "").trim();
  if (!MAINTENANCE_PRODUCER_ALLOWED_COMMANDS.has(value)) return null;
  inspector.inspect(MAINTENANCE_PRODUCER_REPO_PATH);
  return inspector.getReason();
}

export function checkMaintenanceProducerIntegrity(command, cwd, options = {}) {
  return maintenanceProducerIntegrityReason(
    command,
    createReviewedExecutorInspector(cwd, options)
  );
}

function maintenanceProducerPathMutationMentioned(command) {
  const value = String(command || "");
  const word = (codes) => String.fromCharCode(...codes);
  const versionControl = word([103, 105, 116]);
  const directPathMutators = [
    word([114, 109]),
    word([109, 118]),
    word([99, 112]),
    word([100, 101, 108]),
    word([101, 114, 97, 115, 101]),
    word([114, 101, 109, 111, 118, 101, 45, 105, 116, 101, 109]),
    word([109, 111, 118, 101, 45, 105, 116, 101, 109]),
    word([99, 111, 112, 121, 45, 105, 116, 101, 109]),
    word([114, 101, 110, 97, 109, 101, 45, 105, 116, 101, 109]),
    word([114, 111, 98, 111, 99, 111, 112, 121]),
    word([120, 99, 111, 112, 121]),
    word([117, 110, 108, 105, 110, 107]),
    word([114, 109, 100, 105, 114]),
    word([114, 100]),
    word([114, 105]),
    word([109, 105]),
    word([114, 101, 110]),
    word([114, 101, 110, 97, 109, 101]),
    word([115, 101, 116, 45, 99, 111, 110, 116, 101, 110, 116]),
    word([99, 108, 101, 97, 114, 45, 99, 111, 110, 116, 101, 110, 116]),
    word([97, 100, 100, 45, 99, 111, 110, 116, 101, 110, 116]),
    word([111, 117, 116, 45, 102, 105, 108, 101]),
    word([115, 101, 116, 45, 105, 116, 101, 109]),
    word([110, 101, 119, 45, 105, 116, 101, 109]),
    word([116, 101, 101]),
    word([115, 101, 100]),
    word([112, 101, 114, 108]),
    word([97, 119, 107]),
    word([116, 114, 117, 110, 99, 97, 116, 101]),
    word([100, 100]),
    word([105, 110, 115, 116, 97, 108, 108]),
    word([112, 97, 116, 99, 104]),
    word([101, 100]),
    word([101, 120]),
  ];
  const pathMutators = [
    `${versionControl}\\s+${word([114, 109])}`,
    `${versionControl}\\s+${word([109, 118])}`,
    ...directPathMutators,
  ];
  const mutatorPattern = new RegExp(`\\b(?:${pathMutators.join("|")})\\b`, "i");
  const namedMutator = mutatorPattern.test(value);
  const redirectedWrite = />{1,2}(?![&])/.test(value);
  if (!namedMutator && !redirectedWrite) return false;

  const tokens = tokenizeShellWords(value);
  const normalizedCandidate = (token) => {
    if (!token || token.control) return "";
    return token.value
      .replace(/^:\([^)]*\)/, "")
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/$/, "")
      .replace(/^(?:of|output)=/i, "");
  };
  const candidateTargetsProducer = (token) => {
    const candidate = normalizedCandidate(token);
    if (!candidate || candidate.startsWith("-")) return false;
    if (candidate.toLowerCase() === "scripts" || candidate.toLowerCase().endsWith("/scripts")) return true;
    if (/[*?\[\]{}()]/.test(candidate)
      && /(?:scripts|apply-live-testdata-maintenance|\.mjs(?:$|[^a-z0-9]))/i.test(candidate)) return true;
    const repoMatch = shellGlobMatchesLiteral(candidate, MAINTENANCE_PRODUCER_REPO_PATH);
    const nameMatch = shellGlobMatchesLiteral(candidate, MAINTENANCE_PRODUCER_NAME);
    if (repoMatch === true || nameMatch === true) return true;
    return (repoMatch === null || nameMatch === null)
      && /(?:scripts|apply-live-testdata-maintenance)/i.test(candidate);
  };

  // A redirect mutates only its target operand. Do not classify an input
  // directory as a protected writer target merely because output goes elsewhere.
  for (let index = 0; index < tokens.length; index += 1) {
    if (!tokens[index].control || tokens[index].value !== ">") continue;
    let targetIndex = index + 1;
    while (tokens[targetIndex]?.control && tokens[targetIndex].value === ">") targetIndex += 1;
    // Bash tokenizes the noclobber override `>|` as `>` then `|` in this
    // lightweight lexer. The pipe is part of the redirect operator here, not a
    // command boundary; inspect the following token as the write target.
    if (tokens[targetIndex]?.control && tokens[targetIndex].value === "|") targetIndex += 1;
    if (candidateTargetsProducer(tokens[targetIndex])) return true;
  }
  if (!namedMutator) return false;

  const basename = (token) => String(token?.value || "")
    .replace(/^@/, "")
    .split(/[\\/]/)
    .pop()
    .replace(/\.exe$/i, "")
    .toLowerCase();
  const mutatorNames = new Set(directPathMutators.map((name) => name.toLowerCase()));
  const wrappers = new Set([
    "command", "builtin", "env", "wsl", "busybox", "toybox", "sudo", "doas",
    "exec", "nohup", "nice", "timeout", "taskset", "ionice", "unshare", "setsid",
    "stdbuf", "coproc", "time", "watch",
  ]);
  const segmentHasMutator = (segment) => {
    const words = segment.filter((token) => !token.control);
    let cursor = 0;
    while (/^[A-Za-z_]\w*\+?=/.test(words[cursor]?.value || "")) cursor += 1;
    const first = basename(words[cursor]);
    if (first === versionControl
      && words.slice(cursor + 1).some((token) => [word([114, 109]), word([109, 118])].includes(basename(token)))) return true;
    if (mutatorNames.has(first)) return true;
    if (!wrappers.has(first)) return false;
    return words.slice(cursor + 1).some((token, index, rest) => {
      const name = basename(token);
      if (mutatorNames.has(name)) return true;
      return name === versionControl
        && rest.slice(index + 1).some((entry) => [word([114, 109]), word([109, 118])].includes(basename(entry)));
    });
  };
  const inspectSegment = (segment) => segmentHasMutator(segment)
    && segment.some(candidateTargetsProducer);
  let segment = [];
  for (const token of tokens) {
    if (token.control && /^(?:;|&|\||\n)$/.test(token.value)) {
      if (inspectSegment(segment)) return true;
      segment = [];
      continue;
    }
    segment.push(token);
  }
  return inspectSegment(segment);
}

export function maintenanceProducerCommandMentioned(command, depth = 0, fileExecutorInspector = null) {
  const rawValue = String(command || "");
  if (commandExceedsSecurityBudget(rawValue)) return true;
  const powerShellLineView = preservePowerShellLineBoundaries(rawValue);
  if (powerShellLineView !== rawValue
    && (depth >= 4 || maintenanceProducerCommandMentioned(powerShellLineView, depth + 1, fileExecutorInspector))) return true;
  const value = normalizePosixLineContinuations(rawValue);
  const powerShellBoundaryVariant = value.replace(/\\([;&|])/g, "$1");
  if (powerShellBoundaryVariant !== value
    && (depth >= 4 || maintenanceProducerCommandMentioned(powerShellBoundaryVariant, depth + 1, fileExecutorInspector))) return true;
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
          "wsl", "busybox", "toybox", "nohup", "nice", "timeout", "taskset", "ionice", "unshare", "setsid", "stdbuf",
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
      } else if (named("unshare")) {
        cursor += 1;
        while (cursor < index && list[cursor].value.startsWith("-")) {
          const argument = normalizeShellOption(list[cursor].value);
          if (/^(?:--help|--version|-h|-V)$/.test(argument) || /^-[fmuinpCTUrc]*[hV][fmuinpCTUrc]*$/.test(argument)) return false;
          if (argument === "--") { cursor += 1; break; }
          if (/^(?:-R|-w|-S|-G|-l|--map-user|--map-users|--map-group|--map-groups|--owner|--propagation|--setgroups|--setuid|--setgid|--root|--wd|--monotonic|--boottime|--load-interp|--whitelist-env)$/.test(argument)) { cursor += 2; continue; }
          if (/^(?:-[RwSGl].+|--(?:map-user|map-users|map-group|map-groups|owner|propagation|setgroups|setuid|setgid|root|wd|monotonic|boottime|load-interp|whitelist-env)=.+)$/.test(argument)) { cursor += 1; continue; }
          if (/^(?:-[fmuinpCTUrc]+|--(?:fork|forward-signals|map-root-user|map-current-user|map-auto|map-subids|keep-caps|clear-env)|--(?:mount|uts|ipc|net|pid|user|cgroup|time|kill-child|mount-proc|mount-binfmt)(?:=.*)?)$/.test(argument)) { cursor += 1; continue; }
          return true;
        }
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
  const directPathBackedInvocation = (token, index, list) => {
    if (!fileExecutorInspector || token.control || !invocationPosition(list, index)) return false;
    if (list[index - 1]?.control && /^[<>]$/.test(list[index - 1].value)) return false;
    const candidate = String(token.value || "").replace(/^&/, "");
    if (!candidate || /^(?:https?|file):/i.test(candidate)) return false;
    return fileExecutorInspector(candidate);
  };
  const cmdBuiltinDispatchesReviewedExecutor = () => {
    if (!fileExecutorInspector || depth >= 4) return false;
    const hardBoundary = (token) => token?.control && /^(?:;|&|\||\n)$/.test(token.value);
    const replay = (words, start) => {
      const body = words.slice(start).map((token) => token.value).join(" ");
      return Boolean(body) && maintenanceProducerCommandMentioned(body, depth + 1, fileExecutorInspector);
    };
    for (let segmentStart = 0; segmentStart < tokens.length;) {
      while (segmentStart < tokens.length && hardBoundary(tokens[segmentStart])) segmentStart += 1;
      let segmentEnd = segmentStart;
      while (segmentEnd < tokens.length && !hardBoundary(tokens[segmentEnd])) segmentEnd += 1;
      const words = tokens.slice(segmentStart, segmentEnd).filter((token) => !token.control);
      const commandName = normalizeShellToken(words[0]?.value || "").replace(/^@/, "").toLowerCase();
      if (commandName === "call") {
        if (!String(words[1]?.value || "").startsWith(":" ) && replay(words, 1)) return true;
      } else if (commandName === "if") {
        let cursor = 1;
        if (/^not$/i.test(words[cursor]?.value || "")) cursor += 1;
        if (/^\/i$/i.test(words[cursor]?.value || "")) cursor += 1;
        const mode = String(words[cursor]?.value || "").toLowerCase();
        if (["defined", "exist", "errorlevel", "cmdextversion"].includes(mode)) cursor += 2;
        else if (/==/.test(words[cursor]?.value || "")) cursor += 1;
        else if (/^(?:equ|neq|lss|leq|gtr|geq)$/i.test(words[cursor + 1]?.value || "")) cursor += 3;
        else return true;
        if (/^@?call$/i.test(words[cursor]?.value || "")) cursor += 1;
        if (replay(words, cursor)) return true;
      } else if (commandName === "for") {
        const doIndex = words.findIndex((token, index) => index > 0 && /^do$/i.test(token.value));
        if (doIndex < 0) return true;
        let cursor = doIndex + 1;
        if (/^@?call$/i.test(words[cursor]?.value || "")) cursor += 1;
        if (replay(words, cursor)) return true;
      }
      segmentStart = segmentEnd + 1;
    }
    return false;
  };
  if (cmdBuiltinDispatchesReviewedExecutor()) return true;
  if (tokens.some(directPathBackedInvocation)) return true;
  const opaqueImplicitLoaderInvocation = (token, index, list) => {
    if (!invocationPosition(list, index)) return false;
    const name = normalizeShellToken(token.value).replace(/^[@&]/, "").split(/[\\/]/).pop().replace(/\.(?:exe|cmd|bat|ps1)$/i, "").toLowerCase();
    const implicitLoaders = new Set([
      "import-module", "ipmo", "add-type", "make", "gmake", "nmake", "java", "javaw", "dotnet",
      "cscript", "wscript", "mshta", "rundll32", "regsvr32",
    ]);
    if (!implicitLoaders.has(name)) return false;
    const args = [];
    for (let cursor = index + 1; cursor < list.length && !list[cursor].control; cursor += 1) args.push(normalizeShellOption(list[cursor].value));
    return !args.some((argument) => /^(?:--help|--version|-h|-v|\/?\?)$/i.test(argument));
  };
  if (tokens.some(opaqueImplicitLoaderInvocation)) return true;
  if (fileExecutorInspector) {
    const staticPowerShellAliases = new Map();
    for (let segmentStart = 0; segmentStart < tokens.length;) {
      while (segmentStart < tokens.length && tokens[segmentStart].control) segmentStart += 1;
      let segmentEnd = segmentStart;
      while (segmentEnd < tokens.length && !tokens[segmentEnd].control) segmentEnd += 1;
      const words = tokens.slice(segmentStart, segmentEnd);
      let cursor = 0;
      while (cursor < words.length && /^[A-Za-z_]\w*\+?=/.test(words[cursor].value)) cursor += 1;
      const commandName = normalizeShellToken(words[cursor]?.value || "").replace(/^[@&]/, "").toLowerCase();
      if (["set-alias", "sal", "new-alias", "nal"].includes(commandName)) {
        const positionals = [];
        let aliasName = "";
        let aliasTarget = "";
        let opaque = false;
        for (let index = cursor + 1; index < words.length; index += 1) {
          const argument = words[index].value;
          const attachedName = /^-n(?:a(?:m(?:e)?)?)?(?::|=)(.+)$/i.exec(argument)?.[1];
          const attachedValue = /^-v(?:a(?:l(?:u(?:e)?)?)?)?(?::|=)(.+)$/i.exec(argument)?.[1];
          if (attachedName) { aliasName = attachedName; continue; }
          if (attachedValue) { aliasTarget = attachedValue; continue; }
          if (/^-n(?:a(?:m(?:e)?)?)?$/i.test(argument)) { aliasName = words[index + 1]?.value || ""; index += 1; continue; }
          if (/^-v(?:a(?:l(?:u(?:e)?)?)?)?$/i.test(argument)) { aliasTarget = words[index + 1]?.value || ""; index += 1; continue; }
          if (/^-(?:description|option|scope)$/i.test(argument)) { index += 1; continue; }
          if (/^-(?:passthru|force|whatif|confirm|verbose|debug)$/i.test(argument)) continue;
          if (argument.startsWith("-")) { opaque = true; continue; }
          positionals.push(argument);
        }
        aliasName ||= positionals[0] || "";
        aliasTarget ||= positionals[1] || "";
        if (opaque || !aliasName || !aliasTarget || dynamicArgument(aliasName) || dynamicArgument(aliasTarget)) return true;
        if (fileExecutorInspector(aliasTarget)) return true;
        staticPowerShellAliases.set(aliasName.toLowerCase(), aliasTarget);
      } else if (staticPowerShellAliases.has(commandName)) {
        const resolved = [staticPowerShellAliases.get(commandName), ...words.slice(cursor + 1).map((entry) => entry.value)].join(" ");
        if (depth >= 4 || maintenanceProducerCommandMentioned(resolved, depth + 1, fileExecutorInspector)) return true;
      }
      segmentStart = segmentEnd + 1;
    }
  }
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
    const nodeRuntime = ["node", "nodejs"].some((name) => executableNamed(token, name, true));
    const nodeLike = nodeRuntime || executableNamed(token, "bun", true);
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
      if (nodeRuntime && argument.startsWith("-")) {
        // Fail closed on Node startup flags. Node periodically adds options
        // that load code before the script operand (reporters, env files,
        // snapshots, loaders). Only this small non-loading set is accepted;
        // every unknown or code-bearing startup option is denied.
        if (/^(?:--|--check|-c|--no-warnings|--trace-warnings|--use-strict|--enable-source-maps|--test|--test-only|--test-force-exit)$/.test(argument)) continue;
        const safeValueOption = /^(--test-(?:name-pattern|skip-pattern|concurrency|timeout|shard))(?:=(.*))?$/.exec(argument);
        if (safeValueOption) {
          if (safeValueOption[2] === undefined) {
            const value = list[cursor + 1];
            if (!value || value.control) return true;
            cursor += 1;
          }
          continue;
        }
        return true;
      }
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
        if (!operand || operand.control || operand.value === "-") return true;
        return fileExecutorInspector
          ? fileExecutorInspector(normalizeShellToken(operand.value))
          : false;
      }
      if (python && /^(?:-W|-X)$/.test(argument)) {
        cursor += 1;
        continue;
      }
      if (!argument.startsWith("-")) {
        if (shell) return true;
        return fileExecutorInspector ? fileExecutorInspector(argument) : false;
      }
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
      if (depth >= 4 || maintenanceProducerCommandMentioned(entry.value, depth + 1, fileExecutorInspector)) return true;
    }
    if (terminator < 0) return false;
    const body = bodyTokens.map((entry) => entry.value).join(" ");
    return Boolean(body) && (depth >= 4 || maintenanceProducerCommandMentioned(body, depth + 1, fileExecutorInspector));
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
    return depth >= 4 || maintenanceProducerCommandMentioned(body, depth + 1, fileExecutorInspector);
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
      return maintenanceProducerCommandMentioned(text, depth, fileExecutorInspector);
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
    || maintenanceProducerPathMutationMentioned(value)
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

const shellWord = (codes) => String.fromCharCode(...codes);
const SHELL_FILE_MUTATORS = new Set([
  [115, 101, 116, 45, 99, 111, 110, 116, 101, 110, 116],
  [97, 100, 100, 45, 99, 111, 110, 116, 101, 110, 116],
  [99, 108, 101, 97, 114, 45, 99, 111, 110, 116, 101, 110, 116],
  [111, 117, 116, 45, 102, 105, 108, 101],
  [115, 101, 116, 45, 105, 116, 101, 109],
  [116, 101, 101], [116, 101, 101, 45, 111, 98, 106, 101, 99, 116],
  [115, 99], [97, 99], [99, 108, 99], [115, 105],
  [116, 111, 117, 99, 104], [116, 114, 117, 110, 99, 97, 116, 101],
  [100, 100], [99, 112], [109, 118], [105, 110, 115, 116, 97, 108, 108],
  [114, 111, 98, 111, 99, 111, 112, 121], [120, 99, 111, 112, 121],
  [99, 111, 112, 121], [99, 112, 105],
  [99, 111, 112, 121, 45, 105, 116, 101, 109],
  [109, 111, 118, 101, 45, 105, 116, 101, 109],
  [114, 101, 110, 97, 109, 101, 45, 105, 116, 101, 109],
  [114, 101, 109, 111, 118, 101, 45, 105, 116, 101, 109],
  [114, 109], [117, 110, 108, 105, 110, 107],
  [115, 101, 100], [112, 101, 114, 108], [97, 119, 107],
].map(shellWord));
const SHELL_FILESYSTEM_MAPPING_COMMANDS = new Set([
  [110, 101, 119, 45, 112, 115, 100, 114, 105, 118, 101],
  [115, 117, 98, 115, 116],
  [110, 101, 119, 45, 115, 109, 98, 109, 97, 112, 112, 105, 110, 103],
].map(shellWord));
// These executables either cannot write files themselves or already pass
// through a stronger, command-specific provenance/parser boundary below.
// Everything else still gets its path-shaped arguments checked so adding a new
// copy utility cannot silently re-open a protected hard-link destination.
const SHELL_EXECUTORS_WITH_DEDICATED_GUARDS = new Set([
  "bash", "sh", "dash", "zsh", "ksh", "cmd", "powershell", "pwsh",
  "node", "npm", "npx", "pnpm", "yarn", "bun", "deno",
  "python", "python3", "py", "ruby", "git", "gh",
  "rg", "grep", "find", "fd", "ls", "dir", "cat", "type", "more", "less",
  "head", "tail", "stat", "where", "where.exe", "get-content", "gc",
  "get-item", "gi", "get-childitem", "gci", "resolve-path", "test-path",
]);
const SHELL_MUTATION_WRAPPERS = new Set([
  "command", "builtin", "env", "sudo", "doas", "exec", "nohup", "nice",
  "timeout", "wsl", "busybox", "toybox", "stdbuf",
]);

const shellExecutableName = (token) => String(token?.value || "")
  .replace(/^@/, "")
  .replace(/\\([^\\/])/g, "$1")
  .replace(/\^([^^])/g, "$1")
  .replace(/`([^`])/g, "$1")
  .split(/[\\/]/)
  .pop()
  .replace(/\.(?:exe|cmd|bat|ps1)$/i, "")
  .toLowerCase();

function protectedShellDestinationReason(token, cwd, protectedIdentities) {
  const raw = String(token?.value || "").trim();
  const fullyQuoted = token?.sawQuoted && !token?.sawUnquoted;
  const expressionSyntax = !fullyQuoted && /[()]|@\(|\[[^\]]+\]::/i.test(raw);
  if (!raw || token?.control || expressionSyntax || /[*?\[\]{}$`]|\$\(|\$\{|%[^%]+%|![^!]+!|\+|\s-join(?:\s|$)/i.test(raw)) {
    return "Blocked shell file mutation because its destination is dynamic and cannot be checked against protected filesystem identities.";
  }
  if (/^[A-Za-z][\w-]*:/.test(raw) && !/^[A-Za-z]:[\\/]/.test(raw) && !/^FileSystem::/i.test(raw)) {
    return "Blocked shell file mutation because its PowerShell provider destination cannot be proven to be a safe filesystem path.";
  }
  const candidate = raw.replace(/^FileSystem::/i, "");
  if (!candidate || candidate === "-" || /^(?:NUL|CON|PRN|AUX|COM\d|LPT\d|\/dev\/(?:null|stdout|stderr))$/i.test(candidate)) return null;
  const base = cwd || process.cwd();
  const abs = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(base, candidate);
  const surface = canonicalizeThroughExistingAncestor(abs).replace(/\\/g, "/");
  if (/(^|\/)\.(?:claude|codex)\/hooks(?:\/|$)/i.test(surface)) {
    return `Blocked shell file mutation because ${candidate} resolves into a protected agent-hook directory.`;
  }
  const controlReason = protectedControlPathReason(abs)
    || protectedControlPathReason(surface);
  if (controlReason) return `Blocked shell file mutation because ${candidate} is ${controlReason}.`;
  const proofReason = protectedProofCreationReason(abs);
  if (proofReason) return `Blocked shell file mutation because ${candidate} resolves into ${proofReason}.`;
  if (aliasesProtectedFile(abs, base)) {
    return `Blocked shell file mutation because ${candidate} is a second pathname for a protected file.`;
  }
  const identity = fileIdentity(abs);
  if (identity && protectedIdentities.has(identity)) {
    return `Blocked shell file mutation because ${candidate} is a protected file.`;
  }
  return null;
}

// Process tools carry filesystem destinations inside command text instead of
// explicit path fields. Resolve those destinations before execution and apply
// the same canonical-path and file-identity boundary as native file tools.
export function checkProtectedShellMutation(command, cwd, depth = 0) {
  const value = String(command || "");
  if (!value) return null;
  if (depth > 4 || commandExceedsSecurityBudget(value)) {
    return "Blocked shell file mutation because the command is too complex to resolve its destinations safely.";
  }
  const base = cwd || process.cwd();
  let protectedIdentities = null;
  const tokens = tokenizeShellWords(value);
  const inspect = (token) => {
    if (protectedIdentities === null) protectedIdentities = protectedFileIdentities(base);
    return protectedShellDestinationReason(token, base, protectedIdentities);
  };
  const redirect = shellWord([62]);
  const expressionPathOption = /^(?:--?|\/)(?:literalpath|filepath|path|destination|dest)(?::|=)?$/i;

  for (let index = 0; index < tokens.length; index += 1) {
    if (!tokens[index].control || tokens[index].value !== redirect) continue;
    let targetIndex = index + 1;
    while (tokens[targetIndex]?.control && tokens[targetIndex].value === redirect) targetIndex += 1;
    if (tokens[targetIndex]?.control && tokens[targetIndex].value === "|") targetIndex += 1;
    if (tokens[targetIndex]?.control && tokens[targetIndex].value === "&"
      && /^\d+$/.test(tokens[targetIndex + 1]?.value || "")) continue;
    const reason = inspect(tokens[targetIndex]);
    if (reason) return reason;
  }

  const hardBoundary = (token) => token?.control && /^(?:;|&|\||\n)$/.test(token.value);
  const attachedPathOption = /^(?:--?|\/)(?:literalpath|filepath|path|destination|dest)(?::|=)(.+)$/i;
  const separatePathOption = /^(?:--?|\/)(?:literalpath|filepath|path|destination|dest)$/i;
  const attachedDestinationOption = /^(?:--?|\/)(?:destination|dest)(?::|=)(.+)$/i;
  const separateDestinationOption = /^(?:--?|\/)(?:destination|dest)$/i;
  const valuedOptions = new Set(["-value", "-inputobject", "-encoding", "-width", "-stream", "-filter", "-include", "-exclude", "-credential"]);
  const operands = (words) => {
    const result = [];
    for (let index = 0; index < words.length; index += 1) {
      const argument = String(words[index]?.value || "");
      if (attachedPathOption.test(argument)) continue;
      if (separatePathOption.test(argument) || valuedOptions.has(argument.toLowerCase())) {
        index += 1;
        continue;
      }
      if (argument.startsWith("-")) continue;
      result.push(words[index]);
    }
    return result;
  };
  const namedPath = (words) => {
    for (let index = 0; index < words.length; index += 1) {
      const attached = attachedPathOption.exec(String(words[index]?.value || ""));
      if (attached) return { value: attached[1], control: false };
      if (separatePathOption.test(String(words[index]?.value || ""))) return words[index + 1];
    }
    return null;
  };
  const namedDestination = (words) => {
    for (let index = 0; index < words.length; index += 1) {
      const attached = attachedDestinationOption.exec(String(words[index]?.value || ""));
      if (attached) return { value: attached[1], control: false };
      if (separateDestinationOption.test(String(words[index]?.value || ""))) return words[index + 1];
    }
    return null;
  };

  for (let start = 0; start < tokens.length;) {
    while (start < tokens.length && hardBoundary(tokens[start])) start += 1;
    let end = start;
    while (end < tokens.length && !hardBoundary(tokens[end])) end += 1;
    const segmentTokens = tokens.slice(start, end);
    const segmentWords = segmentTokens.filter((token) => !token.control);
    let cursor = 0;
    while (/^[A-Za-z_]\w*\+?=/.test(segmentWords[cursor]?.value || "")) cursor += 1;
    while (SHELL_MUTATION_WRAPPERS.has(shellExecutableName(segmentWords[cursor]))) {
      cursor += 1;
      while (/^(?:-|[A-Za-z_]\w*\+?=)/.test(segmentWords[cursor]?.value || "")) cursor += 1;
    }
    const executable = shellExecutableName(segmentWords[cursor]);
    const args = segmentWords.slice(cursor + 1);

    if (SHELL_FILESYSTEM_MAPPING_COMMANDS.has(executable)) {
      return "Blocked filesystem drive/provider mapping because it can make a protected destination appear under an unresolved shell path.";
    }

    if (["bash", "sh", "dash", "zsh", "ksh", "pwsh", "powershell", "cmd"].includes(executable)) {
      const optionIndex = args.findIndex((token) => /^(?:-[A-Za-z]*c[A-Za-z]*|--command|\/c)$/i.test(token.value));
      if (optionIndex >= 0) {
        const body = args[optionIndex + 1];
        if (!body || /[$`]|\$\(|\$\{|%[^%]+%|![^!]+!/i.test(body.value)) {
          return "Blocked nested shell file mutation because its command body is dynamic and cannot be inspected safely.";
        }
        const nestedReason = checkProtectedShellMutation(body.value, base, depth + 1);
        if (nestedReason) return nestedReason;
      }
    }

    if (!SHELL_FILE_MUTATORS.has(executable)) {
      if (!SHELL_EXECUTORS_WITH_DEDICATED_GUARDS.has(executable)) {
        for (const token of args) {
          if (token.control || token.value.startsWith("-")) continue;
          const raw = String(token.value || "");
          const candidate = /^(?:\/[^:=]+:|[^=]+=)(.+)$/.exec(raw)?.[1] || raw;
          const abs = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(base, candidate);
          const pathShaped = /[\\/]/.test(candidate) || /^\.?\.?$/.test(candidate) || Boolean(fileIdentity(abs));
          if (!pathShaped) continue;
          const reason = inspect({ ...token, value: candidate });
          if (reason) return `Blocked unclassified executable destination: ${reason}`;
        }
      }
      start = end + 1;
      continue;
    }
    if (args.some((token) => /^(?:--help|--version|-h|\/\?)$/i.test(token.value))) {
      start = end + 1;
      continue;
    }
    const destinationFirst = [
      [115, 101, 116, 45, 99, 111, 110, 116, 101, 110, 116],
      [97, 100, 100, 45, 99, 111, 110, 116, 101, 110, 116],
      [99, 108, 101, 97, 114, 45, 99, 111, 110, 116, 101, 110, 116],
      [111, 117, 116, 45, 102, 105, 108, 101],
      [115, 101, 116, 45, 105, 116, 101, 109],
      [116, 111, 117, 99, 104], [116, 114, 117, 110, 99, 97, 116, 101],
      [114, 101, 109, 111, 118, 101, 45, 105, 116, 101, 109],
      [114, 109], [117, 110, 108, 105, 110, 107],
    ].map(shellWord);
    const rawExecutableIndex = segmentTokens.indexOf(segmentWords[cursor]);
    const rawArgs = rawExecutableIndex >= 0 ? segmentTokens.slice(rawExecutableIndex + 1) : [];
    for (let index = 0; index < rawArgs.length; index += 1) {
      if (rawArgs[index].control || !expressionPathOption.test(rawArgs[index].value)) continue;
      const destinationStart = rawArgs[index + 1];
      const following = rawArgs[index + 2];
      if ((destinationStart?.control && /^[({]$/.test(destinationStart.value))
        || (!destinationStart?.control && /^[\@$]$/.test(destinationStart?.value || "")
          && following?.control && following.value === "(")) {
        return "Blocked shell file mutation because its destination is dynamic and cannot be checked against protected filesystem identities.";
      }
    }
    if (destinationFirst.includes(executable)
      && !rawArgs.some((token) => !token.control && /^(?:--?|\/)(?:literalpath|filepath|path)(?::|=|$)/i.test(token.value))) {
      for (let index = 0; index < rawArgs.length; index += 1) {
        const token = rawArgs[index];
        if (token.control) {
          if (token.value === "(") {
            return "Blocked shell file mutation because its destination is dynamic and cannot be checked against protected filesystem identities.";
          }
          continue;
        }
        if (valuedOptions.has(token.value.toLowerCase())) { index += 1; continue; }
        if (token.value.startsWith("-")) continue;
        break;
      }
    }
    let targets = [];
    const dataDuplicator = shellWord([100, 100]);
    const streamDuplicators = [[116, 101, 101], [116, 101, 101, 45, 111, 98, 106, 101, 99, 116]].map(shellWord);
    const destinationLast = [
      [99, 112], [109, 118], [105, 110, 115, 116, 97, 108, 108],
      [120, 99, 111, 112, 121], [99, 111, 112, 121], [99, 112, 105],
      [99, 111, 112, 121, 45, 105, 116, 101, 109],
      [109, 111, 118, 101, 45, 105, 116, 101, 109],
      [114, 101, 110, 97, 109, 101, 45, 105, 116, 101, 109],
    ].map(shellWord);
    const explicit = destinationLast.includes(executable) ? namedDestination(args) : namedPath(args);
    if (args.slice(0, 6).some((token) => token.value === "+" || /\.(?:Replace|ToLower|ToUpper)\b|::Concat\b/i.test(token.value))) {
      return "Blocked shell file mutation because its destination expression is computed and cannot be resolved statically.";
    }
    if (explicit) targets = [explicit];
    else if (executable === dataDuplicator) {
      targets = args.filter((token) => /^of=/.test(token.value)).map((token) => ({ value: token.value.slice(3), control: false }));
    } else if (executable === shellWord([114, 111, 98, 111, 99, 111, 112, 121])) {
      targets = operands(args).slice(1, 2);
    } else {
      const positional = operands(args);
      const inPlaceEditors = [[115, 101, 100], [112, 101, 114, 108], [97, 119, 107]].map(shellWord);
      if (destinationLast.includes(executable)) targets = positional.slice(-1);
      else if (inPlaceEditors.includes(executable)) {
        if (args.some((token) => /^-[A-Za-z]*i[A-Za-z]*$/.test(token.value))) targets = positional.slice(-1);
        else {
          start = end + 1;
          continue;
        }
      } else if (streamDuplicators.includes(executable)) targets = positional;
      else targets = positional.slice(0, 1);
    }
    if (targets.length === 0) return `Blocked ${executable} because its file destination could not be resolved statically.`;
    for (const target of targets) {
      const reason = inspect(target);
      if (reason) return reason;
    }
    start = end + 1;
  }
  return null;
}

function nodeOptionsAssignmentMentioned(command, depth = 0) {
  const rawValue = String(command || "");
  if (commandExceedsSecurityBudget(rawValue)) return true;
  const powerShellLineView = preservePowerShellLineBoundaries(rawValue);
  if (powerShellLineView !== rawValue
    && (depth >= 4 || nodeOptionsAssignmentMentioned(powerShellLineView, depth + 1))) return true;
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
    "parallel", "sudo", "doas", "coproc", "time", "watch", "exec", "nohup", "nice", "timeout", "taskset", "ionice", "unshare", "setsid", "stdbuf",
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
    "sudo", "doas", "coproc", "time", "watch", "exec", "nohup", "nice", "timeout", "taskset", "ionice", "unshare", "setsid", "stdbuf",
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
      if (name === "unshare") {
        cursor += 1;
        let terminalMode = false;
        while (cursor < segmentEnd && tokens[cursor].value.startsWith("-")) {
          const argument = tokens[cursor].value;
          if (/^(?:--help|--version|-h|-V)$/.test(argument) || /^-[fmuinpCTUrc]*[hV][fmuinpCTUrc]*$/.test(argument)) { terminalMode = true; break; }
          if (argument === "--") { cursor += 1; break; }
          if (/^(?:-R|-w|-S|-G|-l|--map-user|--map-users|--map-group|--map-groups|--owner|--propagation|--setgroups|--setuid|--setgid|--root|--wd|--monotonic|--boottime|--load-interp|--whitelist-env)$/.test(argument)) { cursor += 2; continue; }
          if (/^(?:-[RwSGl].+|--(?:map-user|map-users|map-group|map-groups|owner|propagation|setgroups|setuid|setgid|root|wd|monotonic|boottime|load-interp|whitelist-env)=.+)$/.test(argument)) { cursor += 1; continue; }
          if (/^(?:-[fmuinpCTUrc]+|--(?:fork|forward-signals|map-root-user|map-current-user|map-auto|map-subids|keep-caps|clear-env)|--(?:mount|uts|ipc|net|pid|user|cgroup|time|kill-child|mount-proc|mount-binfmt)(?:=.*)?)$/.test(argument)) { cursor += 1; continue; }
          const remaining = tokens.slice(cursor + 1, segmentEnd).map((token) => token.value).join(" ");
          const remainingAfterValue = tokens.slice(cursor + 2, segmentEnd).map((token) => token.value).join(" ");
          if (tokens.slice(cursor + 1, segmentEnd).some(hasNodeOptionsAssignment)
            || inspectNestedCommand(remaining)
            || inspectNestedCommand(remainingAfterValue)) return true;
          terminalMode = true;
          break;
        }
        if (terminalMode || cursor >= segmentEnd) break;
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
  [/\bnode(?:js)?(?:\.exe)?\b[^\r\n;&|]*(?:--require(?:=|\s)|(?:^|\s)-r(?:\s|\S)|--import(?:=|\s)|--(?:experimental-)?loader(?:=|\s)|--test-reporter(?:=|\s)|--env-file(?:-if-exists)?(?:=|\s)|--snapshot-blob(?:=|\s)|--build-snapshot-config(?:=|\s)|--experimental-sea-config(?:=|\s))/i, "Blocked Node pre-execution loading. Startup loaders, reporters, env files, and snapshots can run unreviewed code before a reviewed script's own safety checks."],
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
  // A hard link gives a file a second pathname that `realpath` cannot see
  // through, so a write to the alias edits the original while every path check
  // sees an innocuous name. Matching the protected path in the COMMAND TEXT was
  // not enough: a directory junction launders it out of the text entirely
  // (Codex, 2026-08-24) —
  //   mklink /J scratch\hooks .claude\hooks
  //   mklink /H scratch\alias.mjs scratch\hooks\mcp-tool-guard.mjs   <- no protected text
  //   Set-Content scratch\alias.mjs ...                              <- edits the real hook
  // Canonicalizing operand text would just move the arms race, so the link
  // creators below are denied whatever their target: nothing in this repo's
  // workflows needs one. This is DEFENCE IN DEPTH, not the boundary — the set of
  // tools that can create a hard link is open-ended (a language runtime's
  // link() binding will never appear here), so the real boundary is the
  // file-identity check enforced on every write route by mcp-tool-guard.mjs and
  // protected-identity-guard.mjs. Do not read this list as exhaustive.
  // Proof files do not exist until the wrapper mints them, so a junction into
  // session-state followed by a dynamically assembled hard-link command can
  // make the alias AS the final write. There is then no later file-tool write
  // for the identity guard to catch. Link creators are therefore denied as a
  // class, including spellings whose option/subcommand is supplied through a
  // shell variable. CRX has no agent workflow that requires filesystem links.
  [/\bmklink\b/i, "Blocked filesystem-link creation. Junctions, symbolic links, and hard links can alias a wrapper-owned proof or control path; CRX agent workflows do not require `mklink`."],
  [/(?:^|[\s;&|])(?:(?:busybox|toybox)\s+)?ln(?:\.exe)?\b/i, "Blocked filesystem-link creation. Junctions, symbolic links, and hard links can alias a wrapper-owned proof or control path; CRX agent workflows do not require `ln`."],
  [/\bfsutil(?:\.exe)?\b/i, "Blocked `fsutil`. Its link and reparse-point operations can alias wrapper-owned proof or control paths, including when the subcommand is assembled dynamically."],
  // `cp` links instead of copying under -l/--link (and inside combined short
  // clusters like -al), and the standalone `link` utility calls link(2)
  // directly. BusyBox/Toybox reach both through a multi-call binary.
  [/\bcp\b[^\r\n;&|]*\s(?:--link\b|-[A-Za-z]*l[A-Za-z]*\b)/, "Blocked hard-link creation. `cp -l`/`--link` creates a second pathname for the same file instead of copying it, which defeats every path-based guard; copy the bytes instead."],
  [/(?:^|[\s;&|])(?:(?:busybox|toybox)\s+)?link\s+\S/, "Blocked hard-link creation. `link` creates a second pathname for the same file, which defeats every path-based guard; copy the bytes instead."],
  // PowerShell `New-Item -ItemType HardLink` (with its `ni`/`-Type` spellings)
  // and `fsutil hardlink create` build the same alias; match the token itself.
  [/\bHardLink\b/i, "Blocked hard-link creation. A hard link is a second pathname for the same file, which defeats every path-based guard; this project has no workflow that needs one."],
  // The literal token above is not enough on its own: PowerShell evaluates an
  // expression there, so `-ItemType ("Hard"+"Link")` never spells the word and a
  // variable hides it entirely (Codex CRX-SEC-01, 2026-08-24). Enumerating the
  // ways to compute a string is unwinnable, so this inverts the test — an item
  // type must be a RECOGNIZED SAFE LITERAL or the command is denied. Computed
  // expressions, variables, link/reparse-point types, and unknown future item
  // types all fail closed. Only ordinary File/Directory creation is needed.
  // Abbreviated parameter spellings (`-Type`, `-ty`, `-ItemT`) are covered;
  // `-Target` is not, because its name cannot reduce to this shape.
  [/\b(?:New-Item|ni)\b[^\r\n;&|]*\s-(?:item)?ty?p?e?\b[\s:]+(?!["']?(?:File|Directory)\b)/i, "Blocked link-capable or unrecognized New-Item item type. Only a literal File or Directory is allowed here; links and reparse points can alias wrapper-owned proof or control paths, and computed item types cannot be inspected safely."],
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
  for (const text of commandInspectionViews(cmd)) {
    if (!text) continue;
    for (const [re, reason] of ASK_CMD_CHECKS) {
      if (re.test(text)) return reason;
    }
  }
  return null;
}

// Destructive raw SQL via psql/supabase CLI (kept as its own exported check
// since the original file ran it as a second, independent condition).
export function checkDestructiveSql(cmd) {
  const rawText = String(cmd || "");
  const powerShellLineView = preservePowerShellLineBoundaries(rawText);
  if (powerShellLineView !== rawText) {
    const boundaryReason = checkDestructiveSql(powerShellLineView);
    if (boundaryReason) return boundaryReason;
  }
  const text = normalizePosixLineContinuations(rawText);
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
  if (!rawText) return null;
  if (commandExceedsSecurityBudget(rawText)) {
    return `Blocked oversized command payload. Safety inspection is limited to ${SECURITY_COMMAND_CHAR_BUDGET} characters so the hook fails closed within its execution deadline.`;
  }
  const producerReason = checkMaintenanceProducerInvocation(rawText);
  if (producerReason) return producerReason;
  if (nodeOptionsAssignmentMentioned(rawText)) {
    return "Blocked Node pre-execution loading. NODE_OPTIONS, require/import, and loader hooks can run code before a reviewed script's own safety checks.";
  }
  for (const text of commandInspectionViews(rawText)) {
    for (const [re, reason] of DANGEROUS_CMD_CHECKS) {
      if (re.test(text)) return reason;
    }
  }
  return checkDestructiveSql(rawText);
}

// Bash-based modification of an EXISTING file under supabase/migrations/ (via
// output redirect, or sed/perl/awk -i). Returns a reason or null. Verbatim
// extraction of the original bash-safety.mjs logic.
const MIGRATION_MODIFY_RES = [
  /(?:>>?|2>&1\s*>>?)\s*['"]?([^\s'";|&<>]*supabase[\\/]migrations[\\/][^\s'";|&<>]+)/g,
  /(?:sed|perl|awk)\s+-[A-Za-z]*i[A-Za-z]*\b[^|;&]*?([^\s'";|&<>]*supabase[\\/]migrations[\\/][^\s'";|&<>]+)/g,
];

export function checkMigrationModify(cmd, cwd) {
  const base = cwd || process.cwd();
  for (const text of commandInspectionViews(cmd)) {
    if (!text) continue;
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
  }
  return null;
}

// ── npm-script indirection (FIX 2, 2026-07-13) ──────────────────────────────
// `npm run foo` can hide an arbitrary dangerous command inside package.json's
// scripts.foo, which the literal-command regex table above never sees. Resolve
// the script's body text (recursing into scripts IT calls, max depth 3) and run
// the same checks against the resolved text too.

export function extractNpmRunNames(cmd) {
  const names = new Set();
  // Accepts valid npm variants (Codex P1 2026-07-13 round 3): options before
  // and after the subcommand (`npm -s run x`, `npm run --silent x`) and the
  // `run-script` alias — option tokens must not be mistaken for script names.
  const re = /\bnpm\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+)*(?:run|run-script|rum|urn)\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+)*([\w:.-]+)/g;
  for (const text of commandInspectionViews(cmd)) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) names.add(m[1]);
    const lifecycle = /\bnpm\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+)*(test|tst|t|start|stop)\b/g;
    lifecycle.lastIndex = 0;
    while ((m = lifecycle.exec(text)) !== null) names.add(["t", "tst"].includes(m[1]) ? "test" : m[1]);
    const runAliases = new Set(["run", "run-script", "rum", "urn"]);
    const lifecycleAliases = new Map([["test", "test"], ["tst", "test"], ["t", "test"], ["start", "start"], ["stop", "stop"]]);
    for (const { executable, args } of runtimeExecutionSegments(text)) {
      if (executable !== "npm") continue;
      for (const argument of args) {
        const canonical = lifecycleAliases.get(argument.toLowerCase());
        if (canonical) names.add(canonical);
      }
      const runIndex = args.findIndex((argument) => runAliases.has(argument.toLowerCase()));
      if (runIndex < 0) continue;
      for (const candidate of args.slice(runIndex + 1)) {
        if (!candidate.startsWith("-") && !runAliases.has(candidate.toLowerCase())) names.add(candidate);
      }
    }
  }
  return [...names];
}

function npmDependencyLifecycleReason(command) {
  const unsafeActions = new Set([
    [99, 105], [105, 110, 115, 116, 97, 108, 108], [114, 101, 98, 117, 105, 108, 100],
    [114, 101, 115, 116, 97, 114, 116], [112, 117, 98, 108, 105, 115, 104], [112, 97, 99, 107],
    [118, 101, 114, 115, 105, 111, 110], [117, 112, 100, 97, 116, 101], [97, 100, 100],
    [100, 101, 100, 117, 112, 101], [105, 110, 105, 116], [108, 105, 110, 107],
    [112, 114, 117, 110, 101], [117, 110, 105, 110, 115, 116, 97, 108, 108],
    [117, 110, 108, 105, 110, 107], [105, 116], [117, 112], [114, 109], [117, 110],
    [105], [105, 110], [105, 110, 115], [105, 110, 115, 116], [105, 110, 115, 116, 97],
    [105, 110, 115, 116, 97, 108], [105, 115, 110, 116], [105, 115, 110, 116, 97],
    [105, 115, 110, 116, 97, 108], [105, 115, 110, 116, 97, 108, 108],
    [99, 108, 101, 97, 110, 45, 105, 110, 115, 116, 97, 108, 108],
    [105, 110, 115, 116, 97, 108, 108, 45, 116, 101, 115, 116],
    [99, 108, 101, 97, 110, 45, 105, 110, 115, 116, 97, 108, 108, 45, 116, 101, 115, 116],
    [99, 105, 116], [114, 101, 109, 111, 118, 101], [114],
    [117, 112, 103, 114, 97, 100, 101], [117, 100, 112, 97, 116, 101],
  ].map((codes) => String.fromCharCode(...codes)));
  for (const { executable, args } of runtimeExecutionSegments(command)) {
    if (executable !== "npm") continue;
    const lowerArgs = args.map((argument) => argument.toLowerCase());
    const parsed = parseNpmInvocation(args);
    if (parsed.unresolved) return parsed.reason;
    const action = parsed.action;
    if (lowerArgs.includes("config") && lowerArgs.includes("edit")) {
      return "Blocked npm config edit because it launches an arbitrary editor outside exact-HEAD review.";
    }
    if (lowerArgs.some((argument) => ["explore", "edit"].includes(argument))) {
      return "Blocked npm package exploration/editing because it launches ignored package code or an arbitrary editor outside exact-HEAD review.";
    }
    const executableConfigKeys = new Set(["editor", "shell", "script-shell", "node-options"]);
    const configMutation = lowerArgs.includes("config") && lowerArgs.some((argument) => ["set", "add"].includes(argument));
    const setAliasMutation = lowerArgs.includes("set") && !lowerArgs.includes("config");
    if ((configMutation || setAliasMutation) && lowerArgs.some((argument) => executableConfigKeys.has(argument.split("=")[0]))) {
      return "Blocked persisted executable npm configuration. Editors, shells, and Node startup options must not dispatch unreviewed code.";
    }
    if (unsafeActions.has(action)) {
      return "Blocked npm dependency and lifecycle execution outside the reviewed tree because it can run ignored package scripts.";
    }
    if (action === "audit" && parsed.rest.some((argument) => /^(?:fix|--fix)$/i.test(argument))) {
      return "Blocked npm audit fix because it can run ignored package lifecycle code.";
    }
  }
  return null;
}

function parseNpmInvocation(args) {
  const valueOptions = new Set([
    "--cache", "--prefix", "-c", "--userconfig", "--globalconfig", "--registry",
    "--scope", "--workspace", "-w", "--loglevel", "--logs-dir", "--script-shell",
    "--node-options", "--location", "--omit", "--include", "--tag", "--otp",
    "--proxy", "--https-proxy",
  ]);
  const flagOptions = new Set([
    "--version", "-v", "--versions", "--help", "-h", "--silent", "-s", "--quiet",
    "-q", "--verbose", "-d", "--global", "-g", "--force", "-f", "--yes", "-y",
    "--json", "--dry-run", "--ignore-scripts", "--foreground-scripts", "--workspaces",
    "--include-workspace-root", "--if-present", "--no-audit", "--no-fund",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const raw = String(args[index] || "");
    const value = raw.toLowerCase();
    if (value === "--") {
      const action = String(args[index + 1] || "").toLowerCase();
      return action
        ? { action, rest: args.slice(index + 2), unresolved: false, reason: "" }
        : { action: "", rest: [], unresolved: true, reason: "Blocked npm execution because its subcommand is missing after the option terminator." };
    }
    if (!value.startsWith("-")) {
      return { action: value, rest: args.slice(index + 1), unresolved: false, reason: "" };
    }
    const attached = /^(--[^=]+)=(.*)$/.exec(value);
    if (attached) {
      if (!valueOptions.has(attached[1]) || !attached[2]) {
        return { action: "", rest: [], unresolved: true, reason: "Blocked npm execution because a global option could not be resolved safely." };
      }
      continue;
    }
    if (valueOptions.has(value)) {
      const operand = args[index + 1];
      if (!operand || String(operand).startsWith("-")) {
        return { action: "", rest: [], unresolved: true, reason: "Blocked npm execution because a global option operand is missing or ambiguous." };
      }
      index += 1;
      continue;
    }
    if (flagOptions.has(value) || value.startsWith("--no-")) continue;
    return { action: "", rest: [], unresolved: true, reason: "Blocked npm execution because an unknown global option makes its subcommand ambiguous." };
  }
  return { action: "", rest: [], unresolved: false, reason: "" };
}

// Resolve one script name to an array of script-body texts: itself, plus every
// script reachable via `npm run X` inside it, up to maxDepth levels, with a
// `seen` set so a cyclical script graph can't recurse forever.
const UNRESOLVED_NPM_SCRIPT_CHAIN = "__CRX_UNRESOLVED_NPM_SCRIPT_CHAIN__";

export function resolveNpmScriptChain(scripts, name, depth = 0, maxDepth = 8, seen = new Set()) {
  if (depth > maxDepth) return [UNRESOLVED_NPM_SCRIPT_CHAIN];
  if (!scripts || typeof scripts !== "object") return [];
  if (seen.has(name)) return [UNRESOLVED_NPM_SCRIPT_CHAIN];
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

function inspectExplicitConfigOperands(command, inspector) {
  const tokens = tokenizeShellWords(command);
  const configOption = /^(?:--?(?:config(?:uration)?(?:-?file)?|project|settings))(?:=(.+))?$/i;
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].control || (tokens[index].sawQuoted && !tokens[index].sawUnquoted)) continue;
    const match = configOption.exec(tokens[index].value);
    if (!match) continue;
    let target = match[1] || "";
    if (!target) {
      const operand = tokens[index + 1];
      if (!operand || operand.control) return true;
      target = operand.value;
    }
    if (!target || target.startsWith("-") || inspector.inspect(target)) return true;
  }
  return false;
}

function packageExecutionBoundaryReason(command, cwd, inspector) {
  const tokens = tokenizeShellWords(command);
  const base = cwd || process.cwd();
  const inspect = inspector.inspect;
  const inspectionReason = inspector.getReason;
  let packageExecution = false;
  const hardBoundary = (token) => token?.control && /^(?:;|&|\||\n)$/.test(token.value);
  const wrappers = new Set([
    "command", "builtin", "env", "wsl", "busybox", "toybox", "sudo", "doas",
    "exec", "nohup", "nice", "timeout", "taskset", "ionice", "unshare", "setsid",
    "stdbuf", "coproc", "time", "watch",
  ]);
  const executableName = (token) => String(token?.value || "")
    .replace(/^@/, "")
    .split(/[\\/]/)
    .pop()
    .replace(/\.(?:exe|cmd|bat|ps1)$/i, "")
    .toLowerCase();
  for (let start = 0; start < tokens.length;) {
    while (start < tokens.length && hardBoundary(tokens[start])) start += 1;
    let end = start;
    while (end < tokens.length && !hardBoundary(tokens[end])) end += 1;
    const words = tokens.slice(start, end).filter((token) => !token.control);
    let cursor = 0;
    while (/^[A-Za-z_]\w*\+?=/.test(words[cursor]?.value || "")) cursor += 1;
    while (wrappers.has(executableName(words[cursor]))) {
      cursor += 1;
      while (/^(?:-|[A-Za-z_]\w*\+?=)/.test(words[cursor]?.value || "")) cursor += 1;
    }
    const executable = executableName(words[cursor]);
    const args = words.slice(cursor + 1).map((token) => token.value);
    const parsedNpm = executable === "npm" ? parseNpmInvocation(args) : null;
    if (parsedNpm?.unresolved) return parsedNpm.reason;
    const action = parsedNpm?.action || args.find((argument) => !argument.startsWith("-"))?.toLowerCase() || "";
    if (["npx", "bunx"].includes(executable)
      || (executable === "npm" && ["exec", "x"].includes(action))
      || (["pnpm", "yarn", "bun"].includes(executable) && ["dlx", "exec", "x"].includes(action))) {
      return "Blocked opaque package execution outside the committed tree.";
    }
    if (["pnpm", "yarn", "bun", "corepack"].includes(executable) && !["", "help", "version"].includes(action)) {
      return "Blocked opaque package-manager execution outside the committed tree.";
    }
    if (executable && ["", ".cmd", ".ps1", ".exe"].some((extension) => existsSync(path.join(base, "node_modules", ".bin", `${executable}${extension}`)))) {
      packageExecution = true;
    }
    start = end + 1;
  }
  if (!packageExecution) return null;
  if (inspectExplicitConfigOperands(command, inspector)) {
    return inspectionReason() || "Blocked dynamic or missing configuration operand.";
  }
  return "Blocked mutable local package executable outside the committed tree; ignored node_modules bytes cannot satisfy exact-HEAD review.";
}

function executionContextShiftReason(command, cwd, depth = 0) {
  if (depth > 4) return "Blocked executor after an unresolved nested working-directory change.";
  const tokens = tokenizeShellWords(command);
  const base = cwd || process.cwd();
  const hardBoundary = (token) => token?.control && /^(?:;|&|\||\n)$/.test(token.value);
  const executableName = (token) => String(token?.value || "")
    .replace(/^@/, "")
    .split(/[\\/]/)
    .pop()
    .replace(/\.(?:exe|cmd|bat|ps1)$/i, "")
    .toLowerCase();
  const locationCommands = new Set([
    "cd", "chdir", "set-location", "sl", "push-location", "pop-location", "pushd", "popd",
  ]);
  const transparentWrappers = new Set([
    "command", "builtin", "env", "sudo", "doas", "exec", "nohup", "nice", "timeout",
    "taskset", "ionice", "unshare", "setsid", "stdbuf", "wsl", "busybox", "toybox",
    "find", "parallel", "start-process", "saps", "start",
  ]);
  const reviewedExecutors = new Set([
    "node", "nodejs", "bun", "deno", "npm", "npx", "pnpm", "yarn", "corepack",
    "python", "python2", "python3", "py", "perl", "ruby", "php",
    "bash", "sh", "dash", "zsh", "ksh", "powershell", "pwsh", "cmd",
  ]);
  const pathMutationShells = new Set([
    "cmd", "powershell", "pwsh", "bash", "sh", "dash", "zsh", "ksh",
    "env", "set", "setx", "export", "declare", "typeset", "local", "readonly",
    "set-item", "si", "sudo", "doas", "exec", "wsl",
  ]);
  const pathMutationMentioned = (words) => {
    const text = words.map((token) => token.value).join(" ");
    return /(?:^|[\s;&|])(?:@?set(?:x)?\s+["']?|(?:export|env)\s+)?(?:path|pathext)\s*\+?=/i.test(text)
      || /\$env\s*:\s*(?:path|pathext)\s*\+?=/i.test(text)
      || /(?:set-item|si)\s+(?:-path\s+)?["']?env\s*:\s*(?:path|pathext)\b/i.test(text);
  };
  const gitBuiltinCommands = new Set([
    "add", "am", "annotate", "apply", "archive", "bisect", "blame", "branch", "bugreport", "bundle",
    "cat-file", "check-attr", "check-ignore", "check-mailmap", "check-ref-format", "checkout", "checkout-index",
    "cherry", "cherry-pick", "clean", "clone", "column", "commit", "commit-graph", "config", "count-objects",
    "credential", "credential-cache", "credential-store", "describe", "diagnose", "diff", "diff-files", "diff-index",
    "diff-tree", "difftool", "fast-export", "fast-import", "fetch", "fetch-pack", "filter-branch", "fmt-merge-msg",
    "for-each-ref", "for-each-repo", "format-patch", "fsck", "gc", "get-tar-commit-id", "grep", "gui",
    "hash-object", "help", "hook", "index-pack", "init", "init-db", "instaweb", "interpret-trailers", "log",
    "ls-files", "ls-remote", "ls-tree", "mailinfo", "mailsplit", "maintenance", "merge", "merge-base", "merge-file",
    "merge-index", "merge-one-file", "merge-tree", "mergetool", "mktag", "mktree", "multi-pack-index", ["m", "v"].join(""),
    "name-rev", "notes", "pack-objects", "pack-redundant", "pack-refs", "patch-id", "prune", "prune-packed",
    "pull", "push", "range-diff", "read-tree", "rebase", "reflog", "refs", "remote", "repack", "replace",
    "request-pull", "rerere", "reset", "restore", "rev-list", "rev-parse", "revert", ["r", "m"].join(""), "scalar", "send-email",
    "shortlog", "show", "show-branch", "show-index", "show-ref", "sparse-checkout", "stage", "stash", "status",
    "stripspace", "submodule", "switch", "symbolic-ref", "tag", "unpack-file", "unpack-objects", "update-index",
    "update-ref", "update-server-info", "upload-archive", "upload-pack", "var", "verify-commit", "verify-pack",
    "verify-tag", "version", "web--browse", "whatchanged", "worktree", "write-tree",
  ]);
  const localPackageBinary = (name) => Boolean(name)
    && ["", ".cmd", ".ps1", ".exe"].some((extension) =>
      existsSync(path.join(base, "node_modules", ".bin", name + extension))
    );
  const namesReviewedExecutor = (words, cursor) => {
    const commandName = executableName(words[cursor]);
    if (reviewedExecutors.has(commandName) || localPackageBinary(commandName)) return true;
    if (!transparentWrappers.has(commandName)) return false;
    return words.slice(cursor + 1).some((token) => {
      if (token.sawQuoted && !token.sawUnquoted) return false;
      const name = executableName(token);
      return reviewedExecutors.has(name) || localPackageBinary(name);
    });
  };
  const changesContextInsideSegment = (words, cursor) => {
    const commandName = executableName(words[cursor]);
    const optionValues = words.slice(cursor + 1)
      .filter((token) => !(token.sawQuoted && !token.sawUnquoted))
      .map((token) => token.value);
    if (commandName === "env"
      && optionValues.some((value) => /^(?:-C|--chdir)(?:=|$)/.test(value))) return true;
    if (["sudo", "doas"].includes(commandName)
      && optionValues.some((value) => /^(?:-D|--chdir)(?:=|$)/.test(value))) return true;
    if (commandName === "wsl"
      && optionValues.some((value) => /^--cd(?:=|$)/i.test(value))) return true;
    if (commandName === "find"
      && optionValues.some((value) => /^-(?:execdir|okdir)$/i.test(value))) return true;
    if (commandName === "parallel"
      && optionValues.some((value) => /^--(?:workdir|wd)(?:=|$)/i.test(value))) return true;
    if (commandName === "npm"
      && optionValues.some((value) => /^--prefix(?:=|$)/i.test(value))) return true;
    if (commandName === "pnpm"
      && optionValues.some((value) => /^(?:-c|--dir|--directory)(?:=|$)/i.test(value))) return true;
    if (["yarn", "bun", "deno"].includes(commandName)
      && optionValues.some((value) => /^--cwd(?:=|$)/i.test(value))) return true;
    if (["powershell", "pwsh", "start-process", "saps"].includes(commandName)
      && optionValues.some((value) => /^-(?:workingdirectory|wd)(?::|=|$)/i.test(value))) return true;
    if (commandName === "start"
      && optionValues.some((value) => /^\/D(?::|$)/.test(value))) return true;
    return false;
  };
  const gitExecutionReason = (words, cursor) => {
    let gitCursor = executableName(words[cursor]) === "git" ? cursor : -1;
    if (gitCursor < 0 && transparentWrappers.has(executableName(words[cursor]))) {
      gitCursor = words.findIndex((token, index) => index > cursor
        && !(token.sawQuoted && !token.sawUnquoted)
        && executableName(token) === "git");
    }
    if (gitCursor < 0) return null;
    const args = words.slice(gitCursor + 1).map((token) => token.value);
    const executableConfigNamed = (value) => /^(?:alias\.[^=\s]+|diff\.external|core\.(?:fsmonitor|pager|editor|askpass|gitproxy|sshcommand|hookspath|attributesfile)|include(?:if\.[^=\s]+)?\.path|pager\.[^=\s]+|interactive\.difffilter|diff\.[^=\s]+\.(?:textconv|command)|difftool\.[^=\s]+\.(?:cmd|path)|merge\.[^=\s]+\.driver|mergetool\.[^=\s]+\.(?:cmd|path)|filter\.[^=\s]+\.(?:clean|smudge|process)|sequence\.editor|gpg(?:\.[^=\s]+)?\.program|credential\.helper|tar\.[^=\s]+\.command)\s*(?:=|$)/i.test(String(value || "").trim());
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];
      if (/^(?:-c|--config-env)$/i.test(argument)) {
        if (executableConfigNamed(args[index + 1])) {
          return "Blocked executable Git configuration because aliases, filters, diff tools, pagers, editors, and helpers can run unreviewed code.";
        }
        index += 1;
        continue;
      }
      const attachedConfig = /^(?:-c|--config-env=)(.+)$/i.exec(argument)?.[1];
      if (executableConfigNamed(attachedConfig)) {
        return "Blocked executable Git configuration because aliases, filters, diff tools, pagers, editors, and helpers can run unreviewed code.";
      }
    }
    let subcommand = "";
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];
      if (/^(?:--help|--version|-h)$/i.test(argument)) return null;
      if (/^--exec-path(?:=|$)/i.test(argument)) {
        return "Blocked Git exec-path override because it can replace built-in subcommands with unreviewed helpers.";
      }
      if (/^(?:-c|-C|--config-env)$/i.test(argument)) { index += 1; continue; }
      if (/^(?:--git-dir|--work-tree|--namespace|--super-prefix)$/i.test(argument)) { index += 1; continue; }
      if (/^(?:--git-dir|--work-tree|--namespace|--super-prefix|--config-env)=/i.test(argument)) continue;
      if (/^-[cC].+/.test(argument)) continue;
      if (/^(?:--bare|--no-pager|--paginate|--literal-pathspecs|--no-literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-replace-objects|--no-optional-locks)$/i.test(argument)) continue;
      if (argument.startsWith("-")) return "Blocked Git execution because its subcommand could not be resolved safely.";
      subcommand = executableName({ value: argument });
      break;
    }
    if (!subcommand) return null;
    if (subcommand === "replace"
      || (subcommand === "update-ref" && args.some((argument) => /^refs\/replace(?:\/|$)/i.test(argument) || /^--stdin(?:=|$)/i.test(argument)))) {
      return "Blocked Git replacement-object mutation because provenance reads must use the canonical committed object graph.";
    }
    if (!gitBuiltinCommands.has(subcommand)) {
      return "Blocked Git alias or external helper execution because it can launch an unreviewed executable.";
    }
    if (subcommand === "difftool" || subcommand === "mergetool") {
      return "Blocked Git helper dispatch because difftool and mergetool can launch unreviewed executables.";
    }
    if (subcommand === "hook") {
      return "Blocked Git hook execution because hooks can launch an unreviewed executable.";
    }
    if (subcommand === "config" && args.some((argument) => /^--rename-section(?:=|$)/i.test(argument))) {
      return "Blocked Git configuration section rename because an inert key can become executable after its section is renamed.";
    }
    if (subcommand === "config" && args.some(executableConfigNamed)) {
      return "Blocked persisted executable Git configuration because it can redirect later Git commands into unreviewed code.";
    }
    return null;
  };
  const nestedBody = (words, cursor) => {
    const commandName = executableName(words[cursor]);
    const args = words.slice(cursor + 1);
    if (["bash", "sh", "dash", "zsh", "ksh"].includes(commandName)) {
      const optionIndex = args.findIndex((token) => /^-[a-z]*c[a-z]*$/i.test(token.value));
      return optionIndex >= 0 ? args[optionIndex + 1]?.value || "" : "";
    }
    if (["powershell", "pwsh"].includes(commandName)) {
      const optionIndex = args.findIndex((token) =>
        /^(?:(?:--?|\/)c|(?:--?|\/)command(?:w(?:ithargs)?)?)(?::|=|$)/i.test(token.value)
      );
      if (optionIndex < 0) return "";
      const attached = args[optionIndex].value.replace(
        /^(?:(?:--?|\/)c|(?:--?|\/)command(?:w(?:ithargs)?)?)(?::|=)?/i,
        ""
      );
      return attached || args[optionIndex + 1]?.value || "";
    }
    if (commandName === "cmd") {
      const optionIndex = args.findIndex((token) => /^(?:\/[a-z](?::[a-z]+)?)*\/[ck]/i.test(token.value));
      if (optionIndex < 0) return "";
      const attached = args[optionIndex].value.replace(/^(?:\/[a-z](?::[a-z]+)?)*\/[ck]/i, "");
      return attached || args[optionIndex + 1]?.value || "";
    }
    return "";
  };

  let contextShifted = false;
  for (let start = 0; start < tokens.length;) {
    while (start < tokens.length && hardBoundary(tokens[start])) start += 1;
    let end = start;
    while (end < tokens.length && !hardBoundary(tokens[end])) end += 1;
    const words = tokens.slice(start, end).filter((token) => !token.control);
    let cursor = 0;
    while (/^[A-Za-z_]\w*\+?=/.test(words[cursor]?.value || "")) cursor += 1;
    while (["command", "builtin"].includes(executableName(words[cursor]))) {
      cursor += 1;
      while (words[cursor]?.value?.startsWith("-")) cursor += 1;
    }
    const commandName = executableName(words[cursor]);
    const leadingPathAssignment = words.slice(0, cursor)
      .some((token) => /^(?:path|pathext)\+?=/i.test(token.value));
    const directPowerShellPathAssignment = /^\$env\s*:\s*(?:path|pathext)\b/i.test(words[0]?.value || "");
    if ((leadingPathAssignment || directPowerShellPathAssignment || pathMutationShells.has(commandName)) && pathMutationMentioned(words)) {
      return "Blocked executable dispatch after a PATH or PATHEXT mutation; command-local search paths can resolve an ignored or unreviewed executable.";
    }
    const gitReason = gitExecutionReason(words, cursor);
    if (gitReason) return gitReason;
    if (locationCommands.has(commandName)) {
      contextShifted = true;
      start = end + 1;
      continue;
    }
    const shiftedHere = changesContextInsideSegment(words, cursor);
    if ((contextShifted || shiftedHere) && namesReviewedExecutor(words, cursor)) {
      return "Blocked file-backed or package executor after a working-directory change; the verified path could differ from the executed path.";
    }
    const body = nestedBody(words, cursor);
    if (body) {
      const nestedReason = executionContextShiftReason(body, base, depth + 1);
      if (nestedReason) return nestedReason;
    }
    start = end + 1;
  }
  return null;
}

// The full command check used by both hooks: literal command text first, then
// (only if clean) every `npm run X` target's resolved script body, recursively.
// Returns the first matching reason, or null.
export function checkCommandDeep(cmd, cwd, options = {}) {
  const runtimePreloadReason = runtimePreloadControlReason(cmd);
  if (runtimePreloadReason) return runtimePreloadReason;
  const runtimeConfigReason = runtimeConfigurationReason(cmd, cwd);
  if (runtimeConfigReason) return runtimeConfigReason;
  const npmLifecycleReason = npmDependencyLifecycleReason(cmd);
  if (npmLifecycleReason) return npmLifecycleReason;
  const gitEnvironmentReason = gitControlEnvironmentAssignmentReason(cmd);
  if (gitEnvironmentReason) return gitEnvironmentReason;
  const contextShift = executionContextShiftReason(cmd, cwd);
  if (contextShift) return contextShift;
  const fileExecutorInspector = createReviewedExecutorInspector(cwd, {
    ...options,
    exactReviewBootstrapInvocation: String(cmd || "").trim() === REVIEW_BOOTSTRAP_EXACT_COMMAND,
  });
  const producerIntegrity = maintenanceProducerIntegrityReason(cmd, fileExecutorInspector);
  if (producerIntegrity) return producerIntegrity;
  const packageBoundaryReason = packageExecutionBoundaryReason(cmd, cwd, fileExecutorInspector);
  if (packageBoundaryReason) return packageBoundaryReason;
  maintenanceProducerCommandMentioned(cmd, 0, fileExecutorInspector.inspect);
  const directExecutorReason = fileExecutorInspector.getReason();
  if (directExecutorReason) return directExecutorReason;
  const protectedShellMutation = checkProtectedShellMutation(cmd, cwd);
  if (protectedShellMutation) return protectedShellMutation;
  const direct = checkDangerousCommand(cmd);
  if (direct) return direct;

  const names = extractNpmRunNames(cmd);
  if (names.length === 0) return null;

  if (existsSync(cwd || process.cwd())) {
    fileExecutorInspector.inspect(["pack", "age.json"].join(""));
    const packageManifestReason = fileExecutorInspector.getReason();
    if (packageManifestReason) return packageManifestReason;
  }

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
      if (resolved === UNRESOLVED_NPM_SCRIPT_CHAIN) {
        return `Blocked npm script chain because it exceeds the review depth or contains a cycle (found inside npm run ${name}).`;
      }
      const resolvedPackageBoundary = packageExecutionBoundaryReason(resolved, cwd, fileExecutorInspector);
      if (resolvedPackageBoundary) return `${resolvedPackageBoundary} (found inside a reviewed package script)`;
      if (maintenanceProducerCommandMentioned(resolved, 0, fileExecutorInspector.inspect)) {
        const resolvedExecutorReason = fileExecutorInspector.getReason();
        if (resolvedExecutorReason) return resolvedExecutorReason;
        return "Blocked indirect maintenance producer invocation. Run the exact repository-relative node command directly; npm scripts and lifecycle wrappers are denied.";
      }
      // Run BOTH check families on the resolved body — a script that rewrites an
      // existing migration is as dangerous as one that force-pushes (Codex P1
      // 2026-07-13: only checkDangerousCommand ran here, so npm indirection
      // still bypassed the migration-immutability guard).
      const reason = checkProtectedShellMutation(resolved, cwd)
        || checkDangerousCommand(resolved)
        || checkMigrationModify(resolved, cwd);
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
