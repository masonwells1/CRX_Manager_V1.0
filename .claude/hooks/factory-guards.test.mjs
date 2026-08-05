#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  appendFactoryEvent,
  loadFactorySnapshot,
  resolveFactoryPaths,
  sha256,
  writeImmutableTicket,
} from "../../scripts/factory-state-lib.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const laneHook = path.join(root, ".claude", "hooks", "factory-lane-guard.mjs");
const integrityHook = path.join(root, ".claude", "hooks", "factory-state-integrity-guard.mjs");
let assertions = 0;
const temporaryStateDirs = new Set();

function temporaryStateDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryStateDirs.add(dir);
  return dir;
}

process.on("exit", () => {
  for (const dir of temporaryStateDirs) rmSync(dir, { recursive: true, force: true });
});

function run(hook, stateDir, payload, projectDir = root) {
  return spawnSync(process.execPath, [hook], {
    cwd: projectDir,
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
      CRX_AGENT_SURFACE: "codex",
      CRX_FACTORY_TEST_MODE: "1",
      CRX_FACTORY_TEST_STATE_DIR: stateDir,
      NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT || "factory-hook-test",
    },
    input: JSON.stringify(payload),
  });
}

function denied(result, pattern, message) {
  assertions++;
  assert.match(
    `${result.stdout}\n${result.stderr}\nstatus=${result.status}\nerror=${result.error?.message || ""}`,
    pattern,
    message,
  );
}

function hookOutput(result) {
  return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : null;
}

function bashExecutable() {
  if (process.platform !== "win32") return "bash";
  const candidates = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Git", "bin", "bash.exe"),
  ];
  const executable = candidates.find((candidate) => candidate && existsSync(candidate));
  assert.ok(executable, "Windows factory proof requires the Git Bash executable used by Claude's Bash tool");
  return executable;
}

{
  const stateDir = temporaryStateDir("crx-factory-integrity-");
  const paths = resolveFactoryPaths(root, { CRX_FACTORY_TEST_MODE: "1", CRX_FACTORY_TEST_STATE_DIR: stateDir });
  denied(run(integrityHook, stateDir, {
    tool_name: "Write",
    tool_input: { file_path: paths.eventsPath, content: "forged" },
  }), /shared factory.*forbidden/i, "direct ledger write is denied");
  denied(run(integrityHook, stateDir, {
    tool_name: "Read",
    tool_input: { file_path: paths.eventsPath },
  }), /shared factory.*forbidden/i, "direct ledger reads are denied in favor of the validated status projection");
  denied(run(integrityHook, stateDir, {
    tool_name: "Write",
    tool_input: { file_path: path.join(paths.harnessRunsDir, "forged.json"), content: "forged" },
  }), /shared factory.*forbidden/i, "agents cannot forge or remove evidence single-flight locks");
  denied(run(integrityHook, stateDir, {
    tool_name: "mcp__filesystem__write_file",
    tool_input: { request: { destination: paths.eventsPath, content: "forged" } },
  }), /shared factory.*forbidden/i, "unknown structured MCP writers cannot pre-seed the ledger");
  denied(run(integrityHook, stateDir, {
    tool_name: "PowerShell",
    tool_input: { command: `Set-Content -LiteralPath "${paths.eventsPath}" -Value forged` },
  }), /shared factory state is forbidden/i, "shell ledger write is denied");
  denied(run(integrityHook, stateDir, {
    tool_name: "PowerShell",
    tool_input: { command: `git diff origin/main...HEAD --output=${paths.eventsPath}` },
  }), /shared factory state is forbidden/i, "Git output options cannot overwrite the shared ledger");
  denied(run(integrityHook, stateDir, {
    tool_name: "PowerShell",
    tool_input: { command: "git rev-parse --git-path crx-factory/events.jsonl" },
  }), /direct shell access.*forbidden/i, "Git path indirection cannot disclose the shared ledger path");
  denied(run(integrityHook, stateDir, {
    tool_name: "PowerShell",
    tool_input: {
      command: "node -e \"import('./scripts/factory-state-lib.mjs').then(m => m.appendFactoryEvent({}))\"",
    },
  }), /direct invocation of factory state internals/i, "dynamic import ledger-forgery route is denied");
  denied(run(integrityHook, stateDir, {
    tool_name: "PowerShell",
    tool_input: {
      command: "node .claude/hooks/factory-owner-input.mjs",
    },
  }), /canonical factory hook entrypoints are reserved/i, "supported commands cannot directly invoke the owner-input hook");
  denied(run(integrityHook, stateDir, {
    tool_name: "PowerShell",
    tool_input: {
      command: "node .claude/hooks/factory-lane-guard.mjs",
    },
  }), /canonical factory hook entrypoints are reserved/i, "supported commands cannot directly invoke the permit-minting lane hook");
  denied(run(integrityHook, stateDir, {
    tool_name: "PowerShell",
    tool_input: { command: "$env:CRX_FACTORY_PERMIT='forged'; node scripts/factory.mjs status" },
  }), /cannot read, set, or forward trusted factory CLI permits/i, "agents cannot inject a forged factory permit");
  const allowed = run(integrityHook, stateDir, {
    tool_name: "PowerShell",
    tool_input: { command: "node scripts/factory.mjs status --json" },
  });
  assertions++;
  assert.equal(allowed.stdout, "", "official read path is allowed");
}

{
  const sessionId = "factory-intent-thread";
  const stateDir = temporaryStateDir("crx-factory-lane-");
  process.env.CRX_FACTORY_TEST_MODE = "1";
  process.env.CRX_FACTORY_TEST_STATE_DIR = stateDir;
  const paths = resolveFactoryPaths(root, { CRX_FACTORY_TEST_MODE: "1", CRX_FACTORY_TEST_STATE_DIR: stateDir });
  appendFactoryEvent(paths, {
    type: "factory-intent",
    jobId: null,
    actorTool: "codex",
    sessionId,
    payload: { prompt: "run autonomously" },
  });
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "apply_patch",
    tool_input: { file_path: path.join(root, "src", "example.ts") },
  }), /no mission ticket/i, "factory intent blocks build edits before ticket approval");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "Set-Content src/example.ts forged" },
  }), /no mission ticket/i, "factory intent blocks PowerShell source writes before ticket approval");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "'forged' > src/example.ts" },
  }), /no mission ticket/i, "factory intent blocks redirected source writes before ticket approval");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "node scripts/custom-writer.mjs" },
  }), /no mission ticket/i, "factory intent treats unknown repository scripts as mutating");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "python scripts/custom-writer.py" },
  }), /no mission ticket/i, "factory intent fails closed on unknown non-Node repository scripts");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "mcp__desktop_commander__write_file",
    tool_input: { path: path.join(root, "src", "example.ts"), content: "forged" },
  }), /no mission ticket/i, "factory intent blocks MCP filesystem writers before approval");
  const readAllowed = run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "Get-Content src/example.ts" },
  });
  assertions++;
  assert.equal(readAllowed.stdout, "", "factory intent keeps shell reads available");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: {
      command: "Get-Content src/example.ts",
      workdir: path.join(root, ".."),
    },
  }), /workdir must be the exact governed repository root/i, "shell reads cannot execute from a caller-selected sibling directory");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "Get-Content .env" },
  }), /secret-bearing paths are not readable/i, "factory intent cannot read ignored environment files");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "Get-Content '.env.local'" },
  }), /secret-bearing paths are not readable/i, "quoting does not bypass the secret-path read guard");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "Get-Content .*" },
  }), /shell reads must use stable paths/i, "wildcard shell reads cannot sweep ignored secrets");
  for (const command of [
    "Get-Content Env:GITHUB_TOKEN",
    "Get-ChildItem Env:",
    "Get-Item 'HKCU:\\Software'",
    "Get-ChildItem Registry::HKEY_CURRENT_USER",
    "Get-ChildItem Cert:\\CurrentUser\\My",
    "Get-Content C:relative-path.txt",
  ]) {
    denied(run(laneHook, stateDir, {
      thread_id: sessionId,
      tool_name: "PowerShell",
      tool_input: { command },
    }), /PowerShell provider paths are not readable/i, `factory intent rejects PowerShell provider read: ${command}`);
  }
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "Read",
    tool_input: { file_path: path.join(root, "..", "outside-worktree.txt") },
  }), /read target escapes the worktree/i, "factory intent cannot read outside the governed worktree");
  const gitReadAllowed = run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "git status --short" },
  });
  assertions++;
  assert.equal(gitReadAllowed.stdout, "", "factory intent keeps fixed Git diagnostics available");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "git -C ..\\other-repository show HEAD:secret.txt" },
  }), /no mission ticket|direct commands and helper-process execution/i, "factory intent cannot redirect Git reads to another repository");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "Get-Content .git/config" },
  }), /Git internals are not readable|inside the worktree/i, "factory intent cannot read Git internals through relative shell paths");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "Get-Content node_modules/react/package.json" },
  }), /ignored paths are not readable|symlink/i, "factory intent cannot read ignored or escaping dependency paths");
  denied(run(integrityHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "node -e \"console.log('dynamic')\"" },
  }), /dynamic inline code execution is disabled/i, "governed sessions deny generic node eval");
  denied(run(integrityHook, stateDir, {
    thread_id: sessionId,
    tool_name: "Write",
    tool_input: { file_path: path.join(root, "scripts", "factory.mjs") },
  }), /cannot modify its own governance/i, "governed sessions cannot rewrite the factory implementation");
  denied(run(integrityHook, stateDir, {
    thread_id: sessionId,
    tool_name: "mcp__filesystem__write_file",
    tool_input: { path: path.join(root, ".claude", "hooks", "factory-lane-guard.mjs"), content: "forged" },
  }), /cannot modify its own governance/i, "governed sessions cannot rewrite factory governance through the filesystem MCP writer");
  denied(run(integrityHook, stateDir, {
    thread_id: sessionId,
    tool_name: "mcp__desktop_commander__write_file",
    tool_input: { file_path: path.join(root, "scripts", "factory.mjs"), content: "forged" },
  }), /cannot modify its own governance/i, "governed sessions cannot rewrite factory governance through the desktop commander MCP writer");
  denied(run(integrityHook, stateDir, {
    thread_id: sessionId,
    tool_name: "apply_patch",
    tool_input: { input: "*** Begin Patch\n*** Update File: scripts/factory.mjs\n@@\n-old\n+new\n*** End Patch\n" },
  }), /cannot modify its own governance/i, "governed sessions cannot hide a governance rewrite in an input patch payload");
  denied(run(integrityHook, stateDir, {
    thread_id: sessionId,
    tool_name: "apply_patch",
    tool_input: "*** Begin Patch\n*** Update File: src/example.ts\n*** Move to: .claude/hooks/factory-lane-guard.mjs\n@@\n-old\n+new\n*** End Patch\n",
  }), /cannot modify its own governance/i, "governed sessions cannot move an approved file over a governance target");
  denied(run(integrityHook, stateDir, {
    thread_id: sessionId,
    tool_name: "Edit",
    tool_input: { file_path: path.join(root, "package.json") },
  }), /cannot modify its own governance/i, "governed sessions cannot rewrite npm harness definitions");
  denied(run(integrityHook, stateDir, {
    thread_id: sessionId,
    tool_name: "Edit",
    tool_input: { file_path: path.join(root, ".claude", "hooks", "ship-intent-reminder.mjs") },
  }), /cannot modify its own governance/i, "governed sessions cannot rewrite a trusted ledger-writer hook");
  denied(run(integrityHook, stateDir, {
    thread_id: sessionId,
    tool_name: "Write",
    tool_input: { file_path: path.join(root, "scripts", "write-codex-push-proof.mjs") },
  }), /cannot modify its own governance/i, "governed sessions cannot rewrite the independent reviewer wrapper");
  denied(run(integrityHook, stateDir, {
    thread_id: sessionId,
    tool_name: "Write",
    tool_input: { file_path: path.join(root, ".claude", "settings.json") },
  }), /cannot modify its own governance/i, "governed sessions cannot remove Claude guard wiring");
  denied(run(integrityHook, stateDir, {
    thread_id: sessionId,
    tool_name: "Write",
    tool_input: { file_path: path.join(root, ".claude", "settings.local.json") },
  }), /cannot modify its own governance/i, "governed sessions cannot disable hooks through local Claude settings");
  denied(run(integrityHook, stateDir, {
    thread_id: sessionId,
    tool_name: "Write",
    tool_input: { file_path: path.join(root, ".codex", "hooks.json") },
  }), /cannot modify its own governance/i, "governed sessions cannot remove Codex guard wiring");
  denied(run(integrityHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "Set-Content .claude/hooks/ship-intent-reminder.mjs forged" },
  }), /cannot mutate its governance implementation through the shell/i, "governed sessions cannot shell-rewrite a trusted writer");
  denied(run(integrityHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "Set-Item -Path .claude/hooks/factory-lane-guard.mjs -Value forged" },
  }), /cannot mutate its governance implementation through the shell/i, "governed sessions cannot use alternate PowerShell writers against governance");
  denied(run(integrityHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "si -Path .claude/hooks/factory-lane-guard.mjs -Value forged" },
  }), /cannot mutate its governance implementation through the shell/i, "governed sessions cannot use PowerShell writer aliases against governance");
  denied(run(integrityHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "Get-Content package.json\nSet-Item -Path .claude/hooks/factory-lane-guard.mjs -Value forged" },
  }), /multiline shell commands are disabled/i, "governed sessions reject literal-newline read-then-write commands");
  denied(run(integrityHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "Set-Content scripts/write-codex-push-proof.mjs forged" },
  }), /cannot mutate its governance implementation through the shell/i, "governed sessions cannot shell-rewrite the independent reviewer wrapper");
  denied(run(integrityHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "sed -i 's/factory/forged/' package.json" },
  }), /cannot mutate its governance implementation through the shell/i, "governed sessions cannot use sed in-place against governance");
  denied(run(integrityHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "perl -i -pe 's/factory/forged/' .claude/settings.local.json" },
  }), /cannot mutate its governance implementation through the shell/i, "governed sessions cannot use perl in-place against governance");
  denied(run(integrityHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "'{}' | tee .claude/settings.local.json" },
  }), /cannot mutate its governance implementation through the shell/i, "governed sessions cannot use tee against governance");
  denied(run(integrityHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "git apply proposed-change.patch" },
  }), /cannot mutate its governance implementation through the shell/i, "governed sessions cannot apply an opaque patch that may rewrite governance");
  denied(run(integrityHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "git checkout -- .claude/settings.json" },
  }), /cannot mutate its governance implementation through the shell/i, "governed sessions cannot use shell checkout to rewrite governance");
  denied(run(integrityHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "git restore package.json" },
  }), /cannot mutate its governance implementation through the shell/i, "governed sessions cannot use shell restore to rewrite governance");

  const ticket = writeImmutableTicket(paths, {
    id: "lane-job",
    title: "Guard the lane",
    goal: "Prove one governed lane.",
    definitionOfDone: ["Approved lane can write."],
    mustNotChange: ["Production."],
    allowedPaths: ["src/example.ts"],
    proofRequirements: ["Hook output."],
    proofHarnesses: ["verify-deps"],
    deliveryGate: "Stop before commit.",
    riskAreas: [],
  });
  appendFactoryEvent(paths, {
    type: "ticket-drafted",
    jobId: ticket.ticket.id,
    actorTool: "codex",
    sessionId,
    payload: { ticketFile: ticket.filename, ticketHash: ticket.hash, ticketVersion: 1, title: ticket.ticket.title },
  });
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "Write",
    tool_input: { file_path: path.join(root, "src", "example.ts") },
  }), /waiting for Mason's exact chat approval/i, "drafted but unpresented ticket still blocks writes");

  appendFactoryEvent(paths, {
    type: "ticket-presented",
    jobId: ticket.ticket.id,
    actorTool: "codex",
    sessionId,
    payload: { ticketHash: ticket.hash, questionText: "Approve?", questionHash: sha256("Approve?"), baseSha: "b".repeat(40) },
  });
  const pendingParallel = run(laneHook, stateDir, {
    thread_id: "fresh-parallel-thread",
    tool_name: "PowerShell",
    tool_input: { command: "node scripts/prebuilt-ledger-writer.mjs" },
  });
  assertions++;
  assert.equal(pendingParallel.stdout, "", "a pending ticket does not globally lock unrelated chats");
  denied(run(laneHook, stateDir, {
    thread_id: "fresh-parallel-thread",
    tool_name: "PowerShell",
    tool_input: { command: `node scripts/factory.mjs ticket present --job ${ticket.ticket.id}` },
  }), /cannot seize or rewind|belongs to another chat/i, "fresh chats cannot obtain a permit to re-present another session's ticket");
  appendFactoryEvent(paths, {
    type: "ticket-approved",
    jobId: ticket.ticket.id,
    actorTool: "codex",
    sessionId,
    payload: {
      ticketHash: ticket.hash,
      questionHash: sha256("Approve?"),
      ownerReply: "yes",
      baseSha: "b".repeat(40),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  const queuedParallel = run(laneHook, stateDir, {
    thread_id: "fresh-parallel-thread",
    tool_name: "PowerShell",
    tool_input: { command: "node scripts/prebuilt-ledger-writer.mjs" },
  });
  assertions++;
  assert.equal(queuedParallel.stdout, "", "a queued ticket does not globally lock unrelated chats");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "Edit",
    tool_input: { file_path: path.join(root, "src", "example.ts") },
  }), /lane-start check has not run/i, "approved ticket still requires deterministic lane start");

  appendFactoryEvent(paths, {
    type: "lane-started",
    jobId: ticket.ticket.id,
    actorTool: "codex",
    sessionId,
    payload: { ticketHash: ticket.hash, baseSha: "b".repeat(40), worktree: root },
  });
  const allowed = run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "apply_patch",
    tool_input: { file_path: path.join(root, "src", "example.ts") },
  });
  assertions++;
  assert.equal(allowed.stdout, "", "started governed lane permits scoped build edits");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "Write",
    tool_input: { file_path: path.join(root, "src", "outside-ticket.ts") },
  }), /outside the approved ticket paths/i, "active lane cannot widen its approved file scope");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "mcp__filesystem__write_file",
    tool_input: { path: path.join(root, "src", "outside-ticket.ts"), content: "forged" },
  }), /outside the approved ticket paths/i, "active lane MCP writers cannot widen the approved file scope");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "Edit",
    tool_input: { file_path: path.join(root, ".git", "config") },
  }), /Git internals are not mutable/i, "active lane cannot edit Git configuration");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "Write",
    tool_input: { file_path: path.join(root, "node_modules", "factory-bypass.js") },
  }), /ignored paths are outside factory proof|resolves outside the worktree through a symlink/i, "active lane cannot persist changes in ignored dependency paths");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "Read",
    tool_input: { file_path: path.join(root, ".env.local") },
  }), /secret-bearing paths are not readable/i, "active lane cannot read secret-bearing structured paths");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "Grep",
    tool_input: { pattern: "token", path: root, glob: ".env", output_mode: "content" },
  }), /secret-bearing paths are not readable/i, "active lane validates Grep glob selectors against secret paths");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "Grep",
    tool_input: { pattern: "token", path: root, glob: "**/{.env,*.ts}", output_mode: "content" },
  }), /secret-bearing paths are not readable/i, "glob metacharacters cannot disguise a secret Grep selector");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "Grep",
    tool_input: { pattern: "PRIVATE", path: root, include: "*.key", output_mode: "content" },
  }), /secret-bearing paths are not readable/i, "active lane validates every Grep include selector against key files");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "Grep",
    tool_input: { pattern: "token", path: root, no_ignore: true, output_mode: "content" },
  }), /may expose hidden, ignored, or symlinked files/i, "active lane rejects Grep no-ignore visibility overrides");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "Grep",
    tool_input: { pattern: "token", path: root, no_ignore_global: true, output_mode: "content" },
  }), /may expose hidden, ignored, or symlinked files/i, "active lane rejects every Grep no-ignore variant");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "Grep",
    tool_input: { pattern: "token", path: root, hidden: true, output_mode: "content" },
  }), /may expose hidden, ignored, or symlinked files/i, "active lane rejects Grep hidden-file visibility overrides");
  const knownMcpRead = run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "mcp__filesystem__read_file",
    tool_input: { path: path.join(root, "package.json") },
  });
  assertions++;
  assert.equal(knownMcpRead.stdout, "", "the exact allowlisted MCP file reader may read a tracked in-worktree file");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "mcp__filesystem__read_file",
    tool_input: { path: path.join(root, ".env.local") },
  }), /secret-bearing paths are not readable/i, "allowlisted MCP readers cannot read secret-bearing paths");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "mcp__desktop_commander__read_file",
    tool_input: { path: path.join(root, "..", "outside-worktree.txt") },
  }), /read target escapes the worktree/i, "allowlisted MCP readers cannot escape the governed worktree");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "mcp__unknown_server__read_file",
    tool_input: { path: path.join(root, "package.json") },
  }), /direct commands and helper-process execution/i, "unknown MCP readers remain opaque and denied");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "Get-Content ..\\outside-worktree.txt" },
  }), /shell reads must use stable paths inside the worktree/i, "active lane cannot escape through a shell read");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "Write",
    tool_input: {
      file_path: path.join(root, "src", "example.ts"),
      content: "-----BEGIN PRIVATE KEY-----\nforged-secret-material\n-----END PRIVATE KEY-----",
    },
  }), /credential or secret material/i, "active lane cannot copy secret-shaped content into an approved source file");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "apply_patch",
    tool_input: { patch: "*** Begin Patch\n*** End Patch\n" },
  }), /did not expose an exact file target/i, "active lane fails closed when a structured mutation hides its target");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "Write",
    tool_input: { file_path: path.join(root, "..", "outside-worktree.txt") },
  }), /escapes the worktree/i, "active lane cannot write outside its worktree");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "Set-Content src/example.ts repaired" },
  }), /direct commands and helper-process execution/i, "active lane refuses shell writers whose actual file targets are not broker-visible");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "Get-Content package.json\r\nSet-Item -Path .claude/hooks/factory-lane-guard.mjs -Value forged" },
  }), /direct commands and helper-process execution|exactly one command/i, "active lane rejects literal-newline commands before read-only classification");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "node scripts/generated-helper.mjs" },
  }), /direct commands and helper-process execution/i, "active lane cannot execute an agent-authored helper script");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "mcp__desktop_commander__start_process",
    tool_input: { command: "node scripts/generated-helper.mjs" },
  }), /direct commands and helper-process execution/i, "active lane cannot launch an opaque MCP helper process");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "exec",
    tool_input: { code: "await tools.shell_command({command:'write something'})" },
  }), /direct commands and helper-process execution/i, "active lane treats raw orchestration exec as opaque execution");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "node_repl",
    tool_input: { code: "writeFileSync('src/forged.ts','forged')" },
  }), /direct commands and helper-process execution/i, "active lane treats node_repl as opaque execution");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "git diff origin/main...HEAD --output=src/forged.ts" },
  }), /direct commands and helper-process execution/i, "active lane rejects output-writing options on otherwise read-only Git commands");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "node --check --require=./src/example.ts" },
  }), /direct commands and helper-process execution/i, "node syntax checking cannot smuggle an executable preload option");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: {
      command: "node --check scripts/factory.mjs",
      env: { NODE_OPTIONS: "--require=./src/example.ts" },
    },
  }), /environment overrides are forbidden/i, "node syntax checking cannot receive a preload through tool-level environment overrides");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "node --check ../outside.mjs" },
  }), /read target escapes the worktree/i, "node syntax checking cannot escape the governed worktree");
  const nodeCheckAllowed = run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "node --check scripts/factory.mjs" },
  });
  assertions++;
  assert.equal(nodeCheckAllowed.stdout, "", "node syntax checking accepts one literal repository JavaScript target");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "git show HEAD~1:.env" },
  }), /direct commands and helper-process execution/i, "active lane cannot read secret-bearing historical Git objects with show");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: `git cat-file -p ${"a".repeat(40)}` },
  }), /direct commands and helper-process execution/i, "active lane cannot read arbitrary Git blobs with cat-file");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "git log -p -n1" },
  }), /direct commands and helper-process execution/i, "active lane cannot dump historical patch content through Git log");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "git diff --stat origin/main...HEAD" },
  }), /direct commands and helper-process execution/i, "active lane denies Git diff entirely because filters and historical operands are not target-visible");
  const gitMetadataAllowed = run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "git status --short" },
  });
  assertions++;
  assert.equal(gitMetadataAllowed.stdout, "", "active lane retains non-content Git status metadata");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "rg --pre=node.exe pattern scripts/generated-helper.mjs" },
  }), /direct commands and helper-process execution/i, "active lane cannot use ripgrep preprocessor execution");
  const structuredReadAllowed = run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "Read",
    tool_input: { file_path: path.join(root, "src", "example.ts") },
  });
  assertions++;
  assert.equal(structuredReadAllowed.stdout, "", "explicit structured read tools remain available in an active lane");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "npm run test:factory" },
  }), /permit-bound factory CLI/i, "active lane runs fixed harnesses only through the trusted factory broker");
  const factoryCommand = run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "node scripts/factory.mjs stage --job lane-job --stage verifying" },
  });
  const factoryCommandHook = hookOutput(factoryCommand);
  assertions++;
  assert.equal(factoryCommandHook.permissionDecision, "allow", "mutating factory CLI command receives an explicit allow");
  assertions++;
  assert.match(factoryCommandHook.updatedInput.command, /CRX_FACTORY_PERMIT/, "mutating factory CLI identity comes from the real hook session");
  assertions++;
  assert.match(
    factoryCommandHook.updatedInput.command.replace(/\\/g, "/"),
    new RegExp(path.join(root, "scripts", "factory.mjs").replace(/\\/g, "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "permit-bearing factory commands are rewritten to the canonical absolute broker path",
  );
  assertions++;
  assert.match(factoryCommandHook.updatedInput.command, /Set-Location -LiteralPath/i, "factory commands force the exact governed working directory");
  const gitBashFactoryCommand = run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "Bash",
    tool_input: { command: "node scripts/factory.mjs stage --job lane-job --stage verifying" },
  });
  const gitBashFactoryHook = hookOutput(gitBashFactoryCommand);
  assertions++;
  assert.equal(gitBashFactoryHook.permissionDecision, "allow", "Git Bash factory commands receive an explicit allow");
  assertions++;
  assert.match(
    gitBashFactoryHook.updatedInput.command,
    new RegExp(
      `^cd -- '${root.replace(/\\/g, "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`
      + " && CRX_FACTORY_PERMIT='[a-f0-9-]{36}' node ",
      "i",
    ),
    "Windows Git Bash receives POSIX cwd and permit syntax",
  );
  assertions++;
  assert.doesNotMatch(
    gitBashFactoryHook.updatedInput.command,
    /Set-Location|\$env:/i,
    "Windows Git Bash never receives PowerShell syntax",
  );
  const gitBashExecution = spawnSync(bashExecutable(), ["-lc", gitBashFactoryHook.updatedInput.command], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: root,
      CRX_AGENT_SURFACE: "codex",
      CRX_FACTORY_TEST_MODE: "1",
      CRX_FACTORY_TEST_STATE_DIR: stateDir,
    },
  });
  assertions++;
  assert.equal(
    gitBashExecution.status,
    0,
    `Git Bash executes the permit-bearing factory command: ${gitBashExecution.stderr || gitBashExecution.stdout}`,
  );
  assertions++;
  assert.equal(
    loadFactorySnapshot(paths).jobs.find((job) => job.id === ticket.ticket.id)?.stage,
    "verifying",
    "the Git Bash permit handoff performs the governed ledger transition",
  );
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: {
      command: "node scripts/factory.mjs stage --job lane-job --stage verifying",
      cwd: path.join(root, ".."),
    },
  }), /cwd must be the exact governed repository root/i, "factory CLI permits reject a caller-selected sibling working directory");
  const canonicalStatus = run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "node scripts/factory.mjs status", workdir: root },
  });
  assertions++;
  assert.match(
    hookOutput(canonicalStatus).updatedInput.command.replace(/\\/g, "/"),
    new RegExp(path.join(root, "scripts", "factory.mjs").replace(/\\/g, "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "read-only factory status is also rewritten to the canonical absolute broker path",
  );
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "node scripts/factory.mjs stage --job $(node scripts/generated-helper.mjs) --stage verifying" },
  }), /direct commands and helper-process execution/i, "factory CLI permit rejects command substitution before the shell can execute it");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "node scripts/factory.mjs stage --job lane-job`nnode scripts/generated-helper.mjs --stage verifying" },
  }), /direct commands and helper-process execution/i, "factory CLI permit rejects multiline command injection");
  const parallelTicket = Buffer.from(JSON.stringify({
    id: "parallel-lane-job",
    title: "Parallel lane",
    goal: "Prove the hook admits another governed job.",
    definitionOfDone: ["Lane starts."],
    mustNotChange: ["Production."],
    allowedPaths: ["src/parallel.ts"],
    proofRequirements: ["Factory tests pass."],
    proofHarnesses: ["test:factory"],
    deliveryGate: "Stop before commit.",
    riskAreas: [],
  }), "utf8").toString("base64");
  const parallelDraft = run(laneHook, stateDir, {
    thread_id: "fresh-parallel-thread",
    tool_name: "PowerShell",
    tool_input: { command: `node scripts/factory.mjs ticket draft --ticket-base64 ${parallelTicket}` },
  });
  assertions++;
  assert.equal(
    hookOutput(parallelDraft).permissionDecision,
    "allow",
    "an active lane does not globally block a second chat from drafting its own governed job",
  );
  denied(run(laneHook, stateDir, {
    thread_id: "fresh-parallel-thread",
    tool_name: "Write",
    tool_input: { file_path: path.join(root, "src", "parallel.ts") },
  }), /owns this governed worktree/i, "fresh chats cannot write into another active lane's worktree");
  denied(run(laneHook, stateDir, {
    thread_id: "fresh-parallel-thread",
    tool_name: "PowerShell",
    tool_input: { command: "Set-Content src/parallel.ts forged" },
  }), /destinations cannot be custody-checked/i, "fresh chats cannot use shell writes while another active lane holds worktree custody");
  denied(run(laneHook, stateDir, {
    thread_id: "fresh-parallel-thread",
    tool_name: "mcp__desktop_commander__write_file",
    tool_input: { path: path.join(root, "src", "parallel.ts"), content: "forged" },
  }), /owns this governed worktree/i, "fresh chats cannot use MCP writers in another active lane's worktree");
  const wrongWorktree = temporaryStateDir("crx-factory-wrong-worktree-");
  denied(run(laneHook, stateDir, {
    thread_id: "fresh-cross-checkout-thread",
    tool_name: "Write",
    tool_input: { file_path: path.join(root, "src", "example.ts"), content: "forged" },
  }, wrongWorktree), /owns this governed worktree.*mutation targets/i, "a chat in another checkout cannot target an active lane's worktree");
  denied(run(laneHook, stateDir, {
    thread_id: "fresh-cross-checkout-thread",
    tool_name: "mcp__desktop_commander__write_file",
    tool_input: { path: path.join(root, "src", "example.ts"), content: "forged" },
  }, wrongWorktree), /owns this governed worktree.*mutation targets/i, "a cross-checkout MCP writer cannot target an active lane's worktree");
  denied(run(laneHook, stateDir, {
    thread_id: "fresh-cross-checkout-thread",
    tool_name: "mcp__filesystem__write_file",
    tool_input: { request: { destination: path.join(root, "src", "example.ts"), content: "forged" } },
  }, wrongWorktree), /destinations cannot be custody-checked/i, "an MCP writer with an unrecognized target shape fails closed while another lane has custody");
  denied(run(laneHook, stateDir, {
    thread_id: "fresh-cross-checkout-thread",
    tool_name: "PowerShell",
    tool_input: { command: `Set-Content -LiteralPath "${path.join(root, "src", "example.ts")}" -Value forged` },
  }, wrongWorktree), /destinations cannot be custody-checked/i, "cross-checkout shell mutations fail closed while another lane has custody");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "Write",
    tool_input: { file_path: path.join(wrongWorktree, "src", "example.ts") },
  }, wrongWorktree), /bound to a different governed worktree/i, "the owning chat cannot move its active lane into another checkout");

  appendFactoryEvent(paths, {
    type: "factory-held",
    jobId: null,
    actorTool: "codex",
    sessionId,
    payload: { reason: "Mason paused it." },
  });
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "Write",
    tool_input: { file_path: path.join(root, "src", "example.ts") },
  }), /globally paused/i, "global hold blocks an active lane");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "Set-Content src/example.ts forged" },
  }), /globally paused/i, "global hold blocks shell source writes");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "npm run test:factory" },
  }), /globally paused/i, "global hold blocks direct harness execution; status and read-only inspection remain available");
}

{
  const sessionId = "landing-thread";
  const stateDir = temporaryStateDir("crx-factory-landing-");
  process.env.CRX_FACTORY_TEST_MODE = "1";
  process.env.CRX_FACTORY_TEST_STATE_DIR = stateDir;
  const paths = resolveFactoryPaths(root, { CRX_FACTORY_TEST_MODE: "1", CRX_FACTORY_TEST_STATE_DIR: stateDir });
  const ticket = writeImmutableTicket(paths, {
    id: "landing-job",
    title: "Release factory custody",
    goal: "Enter existing ship gates after morning acceptance.",
    definitionOfDone: ["Normal landing workflow can proceed."],
    mustNotChange: ["Production without its existing gates."],
    allowedPaths: ["src/landing.ts"],
    proofRequirements: ["Factory guard result."],
    proofHarnesses: ["verify-deps"],
    deliveryGate: "Use existing ship gates.",
    riskAreas: [],
  });
  const landingReviewQuestion = "Accept exact result?";
  for (const event of [
    { type: "ticket-drafted", payload: { ticketFile: ticket.filename, ticketHash: ticket.hash, ticketVersion: 1, title: ticket.ticket.title } },
    { type: "ticket-presented", payload: { ticketHash: ticket.hash, questionText: "Approve?", questionHash: sha256("Approve?"), baseSha: "b".repeat(40) } },
    { type: "ticket-approved", payload: { ticketHash: ticket.hash, questionHash: sha256("Approve?"), ownerReply: "yes", baseSha: "b".repeat(40), expiresAt: new Date(Date.now() + 60_000).toISOString() } },
    { type: "lane-started", payload: { ticketHash: ticket.hash, baseSha: "b".repeat(40), worktree: root } },
    { type: "job-stage", payload: { stage: "in-review", behaviorSummary: "", blocker: "" } },
    { type: "job-stage", payload: { stage: "awaiting-morning-review", behaviorSummary: "Proof accepted.", blocker: "" } },
    { type: "review-presented", payload: { ticketHash: ticket.hash, questionText: landingReviewQuestion, questionHash: sha256(landingReviewQuestion), baseSha: "b".repeat(40), expiresAt: new Date(Date.now() + 60_000).toISOString() } },
    {
      type: "job-stage",
      payload: {
        stage: "approved-to-land",
        behaviorSummary: "Proof accepted.",
        blocker: "",
        ownerReply: "approved",
        ownerDecision: "approve",
        ticketHash: ticket.hash,
        reviewQuestionHash: sha256(landingReviewQuestion),
        acceptedRepositoryContentHash: "d".repeat(64),
        acceptedRepositoryFileCount: 1,
      },
    },
  ]) {
    appendFactoryEvent(paths, {
      ...event,
      jobId: ticket.ticket.id,
      actorTool: "codex",
      sessionId,
    });
  }
  const landingWrite = run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "Write",
    tool_input: { file_path: path.join(root, "src", "landing.ts") },
  });
  denied(landingWrite, /only exact-byte.*landing commands/i, "approved-to-land retains custody and blocks post-acceptance source edits");
  denied(run(laneHook, stateDir, {
    thread_id: "different-landing-thread",
    tool_name: "Write",
    tool_input: { file_path: path.join(root, "src", "landing.ts") },
  }), /owns this governed worktree/i, "approved-to-land preserves its own worktree against parallel writes");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "git push origin other-ref:factory-result" },
  }), /only exact-byte.*landing commands|alternate local refs/i, "approved-to-land rejects pushes sourced from alternate local refs");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "git push origin HEAD:production" },
  }), /only exact-byte.*landing commands/i, "approved-to-land cannot grant a push to a protected production branch");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "git commit -F .env" },
  }), /only exact-byte.*landing commands/i, "approved-to-land rejects commit messages read from ignored files");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "git commit --template=.env -m release" },
  }), /only exact-byte.*landing commands/i, "approved-to-land rejects commit templates read from ignored files");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "gh pr create -H other-ref" },
  }), /only exact-byte.*landing commands/i, "approved-to-land rejects the short PR head override alias");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "gh pr create -B release" },
  }), /only exact-byte.*landing commands/i, "approved-to-land rejects the short PR base override alias");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "gh pr create --template .env" },
  }), /only exact-byte.*landing commands/i, "approved-to-land rejects PR bodies read from ignored templates");
  denied(run(laneHook, stateDir, {
    thread_id: sessionId,
    tool_name: "PowerShell",
    tool_input: { command: "gh pr create --fill" },
  }), /only exact-byte.*landing commands/i, "approved-to-land rejects PR bodies synthesized from unreviewed commit metadata");
  appendFactoryEvent(paths, {
    type: "job-stage",
    jobId: ticket.ticket.id,
    actorTool: "codex",
    sessionId,
    payload: { stage: "parked", behaviorSummary: "Landing paused.", blocker: "Tested terminal custody." },
  });
  const unrelatedWorktree = temporaryStateDir("crx-factory-parked-unrelated-");
  denied(run(laneHook, stateDir, {
    thread_id: "unrelated-parked-thread",
    tool_name: "Write",
    tool_input: { file_path: path.join(root, "src", "landing.ts"), content: "forged" },
  }, unrelatedWorktree), /owns this governed worktree.*mutation targets/i, "parked custody still blocks targeted writes into its worktree");
}

{
  const sessionId = "parked-dirty-custody-thread";
  const stateDir = temporaryStateDir("crx-factory-parked-dirty-state-");
  const parkedRepo = temporaryStateDir("crx-factory-parked-dirty-repo-");
  const unrelatedWorktree = temporaryStateDir("crx-factory-parked-dirty-unrelated-");
  process.env.CRX_FACTORY_TEST_MODE = "1";
  process.env.CRX_FACTORY_TEST_STATE_DIR = stateDir;
  const gitEnv = { ...process.env };
  for (const name of Object.keys(gitEnv)) {
    if (/^GIT_/i.test(name)) delete gitEnv[name];
  }
  gitEnv.GIT_CONFIG_NOSYSTEM = "1";
  gitEnv.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  const git = (args) => spawnSync("git", args, { cwd: parkedRepo, encoding: "utf8", env: gitEnv });
  assert.equal(git(["init", "-q"]).status, 0, "parked custody fixture initializes");
  writeFileSync(path.join(parkedRepo, "tracked.txt"), "clean\n");
  assert.equal(git(["add", "tracked.txt"]).status, 0, "parked custody fixture stages its tracked file");
  assert.equal(git(["-c", "user.name=Factory Test", "-c", "user.email=factory@example.invalid", "commit", "-qm", "fixture"]).status, 0, "parked custody fixture commits cleanly");
  const baseSha = git(["rev-parse", "HEAD"]).stdout.trim();
  const paths = resolveFactoryPaths(root, { CRX_FACTORY_TEST_MODE: "1", CRX_FACTORY_TEST_STATE_DIR: stateDir });
  const ticket = writeImmutableTicket(paths, {
    id: "parked-dirty-custody-job",
    title: "Preserve parked local work",
    goal: "Keep dirty parked bytes under cross-chat shell custody.",
    definitionOfDone: ["Dirty parked bytes cannot be overwritten from another chat."],
    mustNotChange: ["Unrelated clean worktrees."],
    allowedPaths: ["tracked.txt"],
    proofRequirements: ["Guard regression."],
    proofHarnesses: ["verify-deps"],
    deliveryGate: "Use existing ship gates.",
    riskAreas: [],
  });
  for (const event of [
    { type: "ticket-drafted", payload: { ticketFile: ticket.filename, ticketHash: ticket.hash, ticketVersion: 1, title: ticket.ticket.title } },
    { type: "ticket-presented", payload: { ticketHash: ticket.hash, questionText: "Approve parked custody?", questionHash: sha256("Approve parked custody?"), baseSha } },
    { type: "ticket-approved", payload: { ticketHash: ticket.hash, questionHash: sha256("Approve parked custody?"), ownerReply: "yes", baseSha, expiresAt: new Date(Date.now() + 60_000).toISOString() } },
    { type: "lane-started", payload: { ticketHash: ticket.hash, baseSha, worktree: parkedRepo } },
    { type: "job-stage", payload: { stage: "parked", behaviorSummary: "Local work is parked.", blocker: "Waiting for revision." } },
  ]) {
    appendFactoryEvent(paths, {
      ...event,
      jobId: ticket.ticket.id,
      actorTool: "codex",
      sessionId,
    });
  }
  const cleanParkedShell = run(laneHook, stateDir, {
    thread_id: "unrelated-clean-parked-thread",
    tool_name: "PowerShell",
    tool_input: { command: "Set-Content unrelated.txt allowed" },
  }, unrelatedWorktree);
  assertions++;
  assert.equal(cleanParkedShell.stdout, "", "a clean terminal parked worktree does not globally block unrelated shell mutations");
  writeFileSync(path.join(parkedRepo, "tracked.txt"), "dirty local work\n");
  denied(run(laneHook, stateDir, {
    thread_id: "unrelated-dirty-parked-thread",
    tool_name: "PowerShell",
    tool_input: { command: `Set-Content -LiteralPath "${path.join(parkedRepo, "tracked.txt")}" -Value forged` },
  }, unrelatedWorktree), /destinations cannot be custody-checked/i, "dirty parked worktrees fail closed against cross-chat shell writes");
  assert.equal(git(["add", "tracked.txt"]).status, 0, "parked custody fixture stages its local commit");
  assert.equal(git(["-c", "user.name=Factory Test", "-c", "user.email=factory@example.invalid", "commit", "-qm", "unpushed parked work"]).status, 0, "parked custody fixture records an unpushed local commit");
  denied(run(laneHook, stateDir, {
    thread_id: "unrelated-unpushed-parked-thread",
    tool_name: "PowerShell",
    tool_input: { command: `Set-Content -LiteralPath "${path.join(parkedRepo, "tracked.txt")}" -Value forged` },
  }, unrelatedWorktree), /destinations cannot be custody-checked/i, "clean parked worktrees with unpushed commits retain cross-chat shell custody");
  rmSync(parkedRepo, { recursive: true, force: true });
  const removedParkedShell = run(laneHook, stateDir, {
    thread_id: "unrelated-removed-parked-thread",
    tool_name: "PowerShell",
    tool_input: { command: "Set-Content unrelated.txt allowed" },
  }, unrelatedWorktree);
  assertions++;
  assert.equal(removedParkedShell.stdout, "", "a removed parked worktree cannot recreate the global orphan shell lock");
}

{
  const stateDir = temporaryStateDir("crx-factory-corrupt-");
  const paths = resolveFactoryPaths(root, { CRX_FACTORY_TEST_MODE: "1", CRX_FACTORY_TEST_STATE_DIR: stateDir });
  writeFileSync(paths.eventsPath, "{not-valid-json}\n");
  const readResult = run(laneHook, stateDir, {
    thread_id: "diagnostic-thread",
    tool_name: "Read",
    tool_input: { file_path: path.join(root, "docs", "workflows", "GOVERNED_DELIVERY_PIPELINE.md") },
  });
  assertions++;
  assert.equal(readResult.stdout, "", "corrupt factory state leaves read-only diagnosis available");
  denied(run(laneHook, stateDir, {
    thread_id: "diagnostic-thread",
    tool_name: "Write",
    tool_input: { file_path: path.join(root, "src", "example.ts") },
  }), /build writes fail closed/i, "corrupt factory state still denies repository mutation");
  const recoveryResult = run(laneHook, stateDir, {
    thread_id: "diagnostic-thread",
    tool_name: "PowerShell",
    tool_input: { command: "node scripts/factory.mjs recover torn-tail --reason-base64 cmVjb3Zlcnk= --session diagnostic-thread --tool codex" },
  });
  assertions++;
  const recoveryHook = hookOutput(recoveryResult);
  assert.equal(recoveryHook.permissionDecision, "allow", "corrupt factory state leaves canonical recovery reachable");
  assertions++;
  assert.match(recoveryHook.updatedInput.command, /CRX_FACTORY_PERMIT/, "recovery receives a trusted one-time permit");
}

console.log(`factory-guards: ${assertions} assertions passed`);
