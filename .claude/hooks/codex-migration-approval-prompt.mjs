#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { APPROVAL_PREFIX, clearMigrationApproval, mintMigrationApproval, parseMigrationApprovalPrompt } from "./codex-migration-approval-lib.mjs";
import { authoredByMason, isMachineGenerated } from "./prompt-source-lib.mjs";

function emit(additionalContext = "") {
  if (!additionalContext) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } }));
}

function currentHead(repoRoot) {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  }).trim();
}

export function handleMigrationApprovalPrompt(payload, {
  repoRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd(),
  surface = process.env.CRX_AGENT_SURFACE || "",
  nowMs = Date.now(),
  runHead = currentHead,
} = {}) {
  if (surface !== "codex") return "";
  if (isMachineGenerated(payload?.prompt)) return "";
  const authored = authoredByMason(payload?.prompt).trim();
  if (!authored) return "";
  const sessionId = String(payload?.session_id || "");
  clearMigrationApproval(repoRoot, sessionId);
  const parsed = parseMigrationApprovalPrompt(authored);
  if (!parsed) {
    if (authored.startsWith(APPROVAL_PREFIX)) {
      return "CRX LIVE MIGRATION APPROVAL NOT ARMED — the approval sentence was malformed. Use the exact plain-text sentence Codex provides; do not wrap it in quotes or a code block.";
    }
    return "";
  }
  try {
    const token = mintMigrationApproval({
      repoRoot,
      sessionId,
      turnId: payload?.turn_id,
      projectId: parsed.projectId,
      migrationName: parsed.migrationName,
      headSha: runHead(repoRoot),
      nowMs,
    });
    return [
      "CRX LIVE MIGRATION APPROVAL ARMED for " + token.migrationName + ".",
      "It is valid for one matching apply_migration call in this Codex turn, expires in five minutes, and is consumed even if another gate or the tool later fails.",
      "Project, migration name, normalized SQL hash, on-disk file, Git HEAD, session, and turn must all still match. Every existing migration review, ordering, and destructiveness gate remains active.",
    ].join(" ");
  } catch (error) {
    return "CRX LIVE MIGRATION APPROVAL NOT ARMED — " + (error?.message || error);
  }
}

async function main() {
  let payload;
  try { payload = JSON.parse(readFileSync(0, "utf8")); } catch { return; }
  emit(handleMigrationApprovalPrompt(payload));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => emit("CRX LIVE MIGRATION APPROVAL NOT ARMED — " + (error?.message || error)));
}
