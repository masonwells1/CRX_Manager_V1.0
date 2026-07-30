#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  appendFactoryEvent,
  resolveFactoryPaths,
  writeImmutableTicket,
} from "../../scripts/factory-state-lib.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const laneHook = path.join(root, ".claude", "hooks", "factory-lane-guard.mjs");
const integrityHook = path.join(root, ".claude", "hooks", "factory-state-integrity-guard.mjs");
let assertions = 0;

function run(hook, stateDir, payload) {
  return spawnSync(process.execPath, [hook], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: root,
      CRX_FACTORY_TEST_MODE: "1",
      CRX_FACTORY_TEST_STATE_DIR: stateDir,
    },
    input: JSON.stringify(payload),
  });
}

function denied(result, pattern, message) {
  assertions++;
  assert.match(`${result.stdout}\n${result.stderr}`, pattern, message);
}

function hookOutput(result) {
  return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : null;
}

{
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "crx-factory-integrity-"));
  const paths = resolveFactoryPaths(root, { CRX_FACTORY_TEST_MODE: "1", CRX_FACTORY_TEST_STATE_DIR: stateDir });
  denied(run(integrityHook, stateDir, {
    tool_name: "Write",
    tool_input: { file_path: paths.eventsPath, content: "forged" },
  }), /direct edits.*forbidden/i, "direct ledger write is denied");
  denied(run(integrityHook, stateDir, {
    tool_name: "PowerShell",
    tool_input: { command: `Set-Content -LiteralPath "${paths.eventsPath}" -Value forged` },
  }), /shell mutation.*forbidden/i, "shell ledger write is denied");
  denied(run(integrityHook, stateDir, {
    tool_name: "PowerShell",
    tool_input: { command: `git diff origin/main...HEAD --output=${paths.eventsPath}` },
  }), /shell mutation.*forbidden/i, "Git output options cannot overwrite the shared ledger");
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
  }), /trusted factory identity\/owner hooks may run only/i, "agents cannot invoke the trusted owner-input hook as a command");
  denied(run(integrityHook, stateDir, {
    tool_name: "PowerShell",
    tool_input: {
      command: "node .claude/hooks/factory-lane-guard.mjs",
    },
  }), /trusted factory identity\/owner hooks may run only/i, "agents cannot invoke the permit-minting lane hook as a command");
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
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "crx-factory-lane-"));
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
    payload: { ticketHash: ticket.hash, questionText: "Approve?", questionHash: "a".repeat(64), baseSha: "b".repeat(40) },
  });
  denied(run(laneHook, stateDir, {
    thread_id: "fresh-parallel-thread",
    tool_name: "PowerShell",
    tool_input: { command: "node scripts/prebuilt-ledger-writer.mjs" },
  }), /under factory custody/i, "fresh chats cannot execute a prebuilt helper while a ticket decision is pending");
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
      questionHash: "a".repeat(64),
      ownerReply: "yes",
      baseSha: "b".repeat(40),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  denied(run(laneHook, stateDir, {
    thread_id: "fresh-parallel-thread",
    tool_name: "PowerShell",
    tool_input: { command: "node scripts/prebuilt-ledger-writer.mjs" },
  }), /under factory custody/i, "fresh chats cannot execute a prebuilt helper while an approved job is queued");
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
  denied(run(laneHook, stateDir, {
    thread_id: "fresh-parallel-thread",
    tool_name: "Write",
    tool_input: { file_path: path.join(root, "src", "parallel.ts") },
  }), /under factory custody/i, "fresh chats cannot bypass an active factory lane");
  denied(run(laneHook, stateDir, {
    thread_id: "fresh-parallel-thread",
    tool_name: "PowerShell",
    tool_input: { command: "Set-Content src/parallel.ts forged" },
  }), /under factory custody/i, "fresh chats cannot bypass one-lane enforcement with shell writes");
  denied(run(laneHook, stateDir, {
    thread_id: "fresh-parallel-thread",
    tool_name: "mcp__desktop_commander__write_file",
    tool_input: { path: path.join(root, "src", "parallel.ts"), content: "forged" },
  }), /under factory custody/i, "fresh chats cannot bypass one-lane enforcement with MCP writers");

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
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "crx-factory-landing-"));
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
  for (const event of [
    { type: "ticket-drafted", payload: { ticketFile: ticket.filename, ticketHash: ticket.hash, ticketVersion: 1, title: ticket.ticket.title } },
    { type: "ticket-presented", payload: { ticketHash: ticket.hash, questionText: "Approve?", questionHash: "a".repeat(64), baseSha: "b".repeat(40) } },
    { type: "ticket-approved", payload: { ticketHash: ticket.hash, questionHash: "a".repeat(64), ownerReply: "yes", baseSha: "b".repeat(40), expiresAt: new Date(Date.now() + 60_000).toISOString() } },
    { type: "lane-started", payload: { ticketHash: ticket.hash, baseSha: "b".repeat(40), worktree: root } },
    { type: "job-stage", payload: { stage: "approved-to-land", behaviorSummary: "Proof accepted.", blocker: "" } },
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
  assertions++;
  assert.equal(landingWrite.stdout, "", "approved-to-land releases factory custody to the existing ship gates");
}

{
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "crx-factory-corrupt-"));
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
