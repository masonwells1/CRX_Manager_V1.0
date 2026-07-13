#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  claudeProofValid,
  contentIsRisky,
  gitPushCwd,
  isGitPush,
  mainPushIsForced,
  mainPushSource,
  riskyFiles,
} from "../../.claude/hooks/codex-push-lib.mjs";

const LIVE_TOOL_ACTIONS = /(?:apply_migration|deploy_edge_function|delete_branch)$/i;
const GITHUB_MERGE_TOOL = /merge_pull_request$/i;
const CLAUDE_PROOF_RELATIVE = [".claude", "session-state", "claude-review-push.json"];

function normalize(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function denied(reason) {
  return { blocked: true, reason };
}

export function isClearlyReadOnlySql(sql) {
  const value = normalize(sql)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\r\n]*/g, " ")
    .trim();
  if (!/^(?:select|with|explain|show)\b/i.test(value)) return false;
  return !/\b(?:insert|update|delete|merge|truncate|alter|drop|create|grant|revoke|comment|vacuum|reindex|cluster|refresh|call|copy)\b/i.test(value);
}

function defaultRunGit(args, cwd) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function defaultRunGh(args, cwd) {
  const candidates = process.platform === "win32"
    ? ["gh", "C:\\Program Files\\GitHub CLI\\gh.exe"]
    : ["gh"];
  let lastError;
  for (const executable of candidates) {
    try {
      return execFileSync(executable, args, {
        cwd,
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("GitHub CLI is unavailable");
}

function proofRequirement(headSha, riskDescription, detail) {
  return denied(
    `CODEX PRODUCTION GATE: ${riskDescription}\n\n` +
    `${detail}\n\n` +
    `Claude must actually review the exact diff in this session, then write ` +
    `.claude/session-state/claude-review-push.json by running:\n` +
    `  node scripts/write-claude-push-proof.mjs --verdict clean\n` +
    `(or --verdict blockers-fixed after verified fixes). Required JSON: ` +
    `{\"claude_ran\":true,\"verdict\":\"clean|blockers-fixed\",` +
    `\"head_sha\":\"${headSha || "<exact pushed SHA>"}\",\"timestamp\":\"<ISO-8601, 0-30 minutes old>\"}. ` +
    `The proof is exact-SHA-bound; future-dated, stale, malformed, or BOM-corrupted proof is refused.`
  );
}

function gateMainChange({ repoDir, sourceRef, sourceSha, nowMs, runGit }) {
  let headSha = sourceSha || "";
  try {
    runGit(["rev-parse", "--verify", "--quiet", "origin/main"], repoDir);
    if (!headSha) {
      const ref = sourceRef === "HEAD" ? "HEAD" : sourceRef;
      headSha = runGit(["rev-parse", "--verify", `${ref}^{commit}`], repoDir);
    } else {
      headSha = runGit(["rev-parse", "--verify", `${headSha}^{commit}`], repoDir);
    }
  } catch (error) {
    return denied(
      `CODEX PRODUCTION GATE: could not resolve origin/main or the exact ref being sent to main, so the operation is denied (fail closed). ${error?.message || error}`
    );
  }

  let changedFiles;
  try {
    changedFiles = runGit(["diff", "--name-only", `origin/main...${headSha}`], repoDir)
      .split(/\r?\n/)
      .map((file) => file.trim())
      .filter(Boolean);
  } catch (error) {
    return denied(
      `CODEX PRODUCTION GATE: could not inspect origin/main...${headSha}, so the operation is denied (fail closed). ${error?.message || error}`
    );
  }

  const risky = riskyFiles(changedFiles);
  let contentFlagged = false;
  if (risky.length === 0) {
    try {
      contentFlagged = contentIsRisky(runGit(["diff", `origin/main...${headSha}`], repoDir));
    } catch (error) {
      return denied(
        `CODEX PRODUCTION GATE: could not inspect the full diff for money/security risk, so the operation is denied (fail closed). ${error?.message || error}`
      );
    }
  }

  if (risky.length === 0 && !contentFlagged) return { blocked: false };

  const riskDescription = risky.length > 0
    ? `the main-bound diff changes ${risky.length} risky file(s): ${risky.slice(0, 6).join(", ")}${risky.length > 6 ? ", ..." : ""}`
    : "the main-bound diff contains money or financial-audit identifiers even though its paths look ordinary";
  const proofPath = path.join(repoDir, ...CLAUDE_PROOF_RELATIVE);
  if (!existsSync(proofPath)) {
    return proofRequirement(headSha, riskDescription, `Missing required Claude proof: ${proofPath}`);
  }

  let proof;
  try {
    proof = JSON.parse(readFileSync(proofPath, "utf8"));
  } catch (error) {
    return proofRequirement(headSha, riskDescription, `Claude proof could not be parsed: ${error?.message || error}`);
  }
  if (!claudeProofValid(proof, headSha, nowMs)) {
    return proofRequirement(
      headSha,
      riskDescription,
      "Claude proof is stale, future-dated, bound to a different SHA, has the wrong verdict/ran key, or is otherwise invalid."
    );
  }

  return { blocked: false };
}

function shellWords(value) {
  return String(value || "").match(/"[^"]*"|'[^']*'|\S+/g)?.map((word) => {
    if ((word.startsWith('"') && word.endsWith('"')) || (word.startsWith("'") && word.endsWith("'"))) {
      return word.slice(1, -1);
    }
    return word;
  }) || [];
}

function ghMergeRequest(command) {
  const match = String(command || "").match(/(?:^|\s)(?:"[^"]*[\\/]gh\.exe"|\S*[\\/]gh(?:\.exe)?|gh(?:\.exe)?)\s+pr\s+merge\b([^;&|]*)/i);
  if (!match) return null;
  const words = shellWords(match[1]);
  const valueFlags = new Set(["--repo", "-R", "--match-head-commit", "--subject", "--body"]);
  let selector = "";
  let repo = "";
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word.startsWith("--repo=")) {
      repo = word.slice("--repo=".length);
      continue;
    }
    if (valueFlags.has(word)) {
      const value = words[index + 1] || "";
      if (word === "--repo" || word === "-R") repo = value;
      index += 1;
      continue;
    }
    if (!word.startsWith("-") && !selector) selector = word;
  }
  return { selector, repo };
}

function ghApiMergeRequest(command) {
  if (!/(?:^|\s)(?:"[^"]*[\\/]gh\.exe"|\S*[\\/]gh(?:\.exe)?|gh(?:\.exe)?)\s+api\b/i.test(String(command || ""))) {
    return null;
  }
  const words = shellWords(command);
  let method = "GET";
  let endpoint = "";
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === "-X" || word === "--method") {
      method = String(words[index + 1] || "").toUpperCase();
      index += 1;
      continue;
    }
    if (word.startsWith("--method=")) {
      method = word.slice("--method=".length).toUpperCase();
      continue;
    }
    if (/^\/?repos\/[^/]+\/[^/]+\/pulls\/\d+\/merge$/i.test(word)) endpoint = word;
  }
  if (method !== "PUT" || !endpoint) return null;
  const match = endpoint.match(/^\/?repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/i);
  return match ? { selector: match[3], repo: `${match[1]}/${match[2]}` } : null;
}

function mcpMergeRequest(toolInput) {
  const selector = toolInput.pull_number ?? toolInput.pullNumber ?? toolInput.pullRequestNumber ?? toolInput.number ?? "";
  const owner = toolInput.owner ?? toolInput.organization ?? "";
  const repository = toolInput.repo ?? toolInput.repository ?? toolInput.repoName ?? "";
  const repo = String(repository).includes("/") ? String(repository) : (owner && repository ? `${owner}/${repository}` : "");
  return { selector: String(selector), repo };
}

function resolvePullRequest({ request, repoDir, runGh }) {
  const args = ["pr", "view"];
  if (request.selector) args.push(request.selector);
  args.push("--json", "baseRefName,headRefName,headRefOid,mergeStateStatus,statusCheckRollup");
  if (request.repo) args.push("--repo", request.repo);
  const data = JSON.parse(runGh(args, repoDir));
  if (!data?.baseRefName || !data?.headRefOid) throw new Error("GitHub did not return baseRefName and headRefOid");
  return data;
}

export function pullRequestChecksGreen(pullRequest) {
  if (String(pullRequest?.mergeStateStatus || "").toUpperCase() !== "CLEAN") return false;
  const checks = pullRequest?.statusCheckRollup;
  if (!Array.isArray(checks) || checks.length === 0) return false;
  return checks.every((check) => {
    if (check?.__typename === "StatusContext") {
      return String(check.state || "").toUpperCase() === "SUCCESS";
    }
    if (check?.__typename === "CheckRun") {
      const status = String(check.status || "").toUpperCase();
      const conclusion = String(check.conclusion || "").toUpperCase();
      return status === "COMPLETED" && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion);
    }
    return false;
  });
}

function gatePullRequestMerge({ request, repoDir, nowMs, runGit, runGh }) {
  let pullRequest;
  try {
    pullRequest = resolvePullRequest({ request, repoDir, runGh });
  } catch (error) {
    return denied(
      `CODEX PRODUCTION GATE: could not determine the pull request's base branch and exact head SHA, so the merge is denied (fail closed). ${error?.message || error}`
    );
  }
  const base = normalize(pullRequest.baseRefName).toLowerCase();
  if (base === "master" || base === "production") {
    return denied(`CODEX PRODUCTION GATE: merges to protected branch ${base} remain blocked.`);
  }
  if (base !== "main") return { blocked: false };
  if (!pullRequestChecksGreen(pullRequest)) {
    return denied(
      "CODEX PRODUCTION GATE: this pull request is not merge-ready with a fully green GitHub pipeline. Wait until mergeStateStatus is CLEAN and every reported check is completed successfully, neutral, or skipped."
    );
  }
  return gateMainChange({ repoDir, sourceSha: pullRequest.headRefOid, nowMs, runGit });
}

export function evaluateProductionAction({
  toolName = "",
  toolInput = {},
  branch = "",
  repoDir = process.cwd(),
  nowMs = Date.now(),
  runGit = defaultRunGit,
  runGh = defaultRunGh,
} = {}) {
  const name = String(toolName);

  if (LIVE_TOOL_ACTIONS.test(name)) {
    return denied("Live migrations, edge-function deployments, and protected-branch deletion remain outside Codex's standing authorization.");
  }

  if (/execute_sql$/i.test(name)) {
    const sql = toolInput.query ?? toolInput.sql ?? "";
    if (!isClearlyReadOnlySql(sql)) {
      return denied("Codex only permits clearly read-only SQL. Live data and schema changes remain blocked.");
    }
  }

  if (GITHUB_MERGE_TOOL.test(name)) {
    return gatePullRequestMerge({
      request: mcpMergeRequest(toolInput),
      repoDir: path.resolve(repoDir),
      nowMs,
      runGit,
      runGh,
    });
  }

  const command = String(toolInput.command ?? toolInput.cmd ?? "").trim();
  if (!command) return { blocked: false };

  const commandSegments = command.split(/(?:&&|\|\||;|\r?\n)/).map((segment) => segment.trim()).filter(Boolean);
  for (const segment of commandSegments) {
    const ghRequest = ghMergeRequest(segment) || ghApiMergeRequest(segment);
    if (!ghRequest) continue;
    const result = gatePullRequestMerge({
      request: ghRequest,
      repoDir: path.resolve(repoDir),
      nowMs,
      runGit,
      runGh,
    });
    if (result.blocked) return result;
  }

  for (const segment of commandSegments.filter((part) => isGitPush(part))) {
    if (/--git-dir|--work-tree/i.test(segment)) {
      return denied("CODEX PRODUCTION GATE: pushes using explicit --git-dir/--work-tree contexts are denied because the guard cannot safely bind them to the inspected worktree. Use `git -C <repo> push` instead.");
    }
    const pushRepoDir = gitPushCwd(segment, repoDir);
    let currentBranch = normalize(branch).toLowerCase();
    if (!currentBranch || pushRepoDir !== path.resolve(repoDir)) {
      try {
        currentBranch = normalize(runGit(["rev-parse", "--abbrev-ref", "HEAD"], pushRepoDir)).toLowerCase();
      } catch (error) {
        return denied(`CODEX PRODUCTION GATE: could not determine the push branch, so the push is denied (fail closed). ${error?.message || error}`);
      }
    }

    if (/\bgit\b[^\r\n;&|]*\bpush\b[^\r\n;&|]*(?:\s|:)(master|production)(?:\s|$)/i.test(segment) ||
        ((currentBranch === "master" || currentBranch === "production") && /\bgit\b[^\r\n;&|]*\bpush\b/i.test(segment))) {
      return denied("CODEX PRODUCTION GATE: pushes to master/production remain blocked.");
    }

    const sourceRef = mainPushSource(segment, currentBranch);
    if (sourceRef === "DELETE") {
      return denied("CODEX PRODUCTION GATE: `git push origin :main` deletes the production branch and is always denied.");
    }
    if (sourceRef) {
      if (mainPushIsForced(segment, currentBranch)) {
        return denied("CODEX PRODUCTION GATE: force-pushing production main rewrites shared history and is always denied.");
      }
      const result = gateMainChange({ repoDir: pushRepoDir, sourceRef, nowMs, runGit });
      if (result.blocked) return result;
    }
  }

  const productionDeploy =
    /\bvercel\b[^\r\n]*(?:--prod|--production)(?:\s|$)/i.test(command) ||
    /\bsupabase\s+functions\s+deploy\b/i.test(command) ||
    /\bsupabase\s+(?:db\s+push|migration\s+up)\b/i.test(command) ||
    /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?deploy\b/i.test(command);
  if (productionDeploy) {
    return denied("Production deployments, edge-function deploys, and live migration commands remain blocked for Codex.");
  }

  return { blocked: false };
}

function readStdin() {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => resolve(input));
  });
}

function writeDenial(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      ...(reason ? { permissionDecisionReason: reason } : {}),
    },
  }));
}

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    writeDenial(`CODEX PRODUCTION GATE: hook input could not be parsed, so the action is denied (fail closed). ${error?.message || error}`);
    return;
  }
  const result = evaluateProductionAction({
    toolName: payload.tool_name ?? payload.toolName ?? "",
    toolInput: payload.tool_input ?? payload.toolInput ?? {},
    repoDir: process.env.CODEX_PROJECT_DIR || process.cwd(),
  });
  // Codex treats allow payloads as noisy/failed hook output. Silence means allow.
  if (!result.blocked) return;
  writeDenial(result.reason);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    writeDenial(`CODEX PRODUCTION GATE: unexpected guard failure; action denied. ${error?.message || error}`);
  });
}
