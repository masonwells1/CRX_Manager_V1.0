#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function normalizeHookOutput(output, warn = (msg) => process.stderr.write(msg)) {
  const trimmed = output.trim();
  if (!trimmed) return "";

  try {
    const parsed = JSON.parse(trimmed);
    const hookOutput = parsed?.hookSpecificOutput;
    if (hookOutput?.permissionDecision === "allow" && hookOutput.updatedInput === undefined) {
      // Swallowing the allow payload must not swallow its loud fail-open
      // warning (Codex P2 2026-07-13 round 5): the schema-registry hooks
      // attach a systemMessage when they had to skip their check — forward
      // it on stderr so the Codex side still hears it.
      const sysMsg = parsed?.systemMessage ?? hookOutput?.systemMessage;
      if (typeof sysMsg === "string" && sysMsg) warn(`${sysMsg}\n`);
      return "";
    }
  } catch {
    return output;
  }

  return output;
}

export function resolveGitRoot(cwd = process.cwd()) {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function resolveSharedHook(root, requestedPath) {
  const hookRoot = path.resolve(root, ".claude", "hooks");
  const target = path.resolve(root, requestedPath);
  const relative = path.relative(hookRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Hook target must be a file under ${hookRoot}.`);
  }
  return target;
}

function readStdin() {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => resolve(input));
  });
}

async function main() {
  const requestedPath = process.argv[2];
  if (!requestedPath) throw new Error("A repository-relative hook script path is required.");

  const root = resolveGitRoot();
  const target = resolveSharedHook(root, requestedPath);
  const input = await readStdin();
  const result = spawnSync(process.execPath, [target], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, CRX_AGENT_SURFACE: "codex" },
    input,
  });

  if (result.stderr) process.stderr.write(result.stderr);
  const normalized = normalizeHookOutput(result.stdout ?? "");
  if (normalized) process.stdout.write(normalized);
  process.exitCode = result.status ?? 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
