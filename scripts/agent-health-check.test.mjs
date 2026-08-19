#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeEol } from "./normalize-eol.mjs";

import {
  checkClaudeAuth,
  checkCodexAuth,
  checkBranchStaleness,
  checkCodexHookPortability,
  checkFilesPresent,
  compareSyncedFiles,
  summarizeChecks,
} from "./agent-health-check.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "crx-agent-health-"));

try {
  for (const dir of [
    ".claude/commands",
    ".claude/skills/claude-review",
    ".agents/skills/claude-review",
    ".codex",
  ]) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }

  writeFileSync(path.join(root, ".claude/commands/claude-review.md"), "review command");
  writeFileSync(path.join(root, ".claude/skills/claude-review/SKILL.md"), "same");
  writeFileSync(path.join(root, ".agents/skills/claude-review/SKILL.md"), "same");

  const present = checkFilesPresent(root, [
    ".claude/commands/claude-review.md",
    ".claude/skills/claude-review/SKILL.md",
    ".agents/skills/claude-review/SKILL.md",
  ]);
  assert.equal(present.every((check) => check.status === "PASS"), true);

  const synced = compareSyncedFiles(root, [
    [".claude/skills/claude-review/SKILL.md", ".agents/skills/claude-review/SKILL.md"],
  ]);
  assert.equal(synced[0].status, "PASS");

  // A CRLF-vs-LF difference is NOT drift. sync-agent-workflows.mjs has normalized line
  // endings before comparing since 2026-07-16; this check still compared raw bytes, so
  // one commit could FAIL here while the generator reported everything in sync. Both
  // now share scripts/normalize-eol.mjs.
  const syncedPair = [".claude/skills/claude-review/SKILL.md", ".agents/skills/claude-review/SKILL.md"];
  writeFileSync(path.join(root, syncedPair[0]), "line one\r\nline two\r\n");
  writeFileSync(path.join(root, syncedPair[1]), "line one\nline two\n");
  assert.equal(compareSyncedFiles(root, [syncedPair])[0].status, "PASS");

  // ...but a real content difference must still FAIL, EOL style notwithstanding.
  writeFileSync(path.join(root, syncedPair[1]), "line one\nline two CHANGED\n");
  assert.equal(compareSyncedFiles(root, [syncedPair])[0].status, "FAIL");

  writeFileSync(path.join(root, syncedPair[0]), "same");
  writeFileSync(path.join(root, syncedPair[1]), "same");

  // The shared normalizer is deliberately narrow, and that narrowness is the
  // safety argument: it can only turn a real difference into a false alarm,
  // never a real difference into a false pass.
  assert.equal(normalizeEol("a\r\nb"), "a\nb");
  assert.equal(normalizeEol("a\rb"), "a\rb", "a lone CR is left alone, so it still reads as drift");
  assert.throws(() => normalizeEol(undefined), TypeError, "non-string input must throw, not coerce");

  // HARD guard on the single definition. Both mirror comparisons must import
  // normalizeEol from the one module: a local copy in either script is exactly
  // how the two checks diverged between 2026-07-16 and 2026-08-19, and nothing
  // else in this suite would notice it happening again.
  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  for (const caller of ["agent-health-check.mjs", "sync-agent-workflows.mjs"]) {
    const source = readFileSync(path.join(scriptsDir, caller), "utf8");
    assert.match(
      source,
      /import \{ normalizeEol \} from "\.\/normalize-eol\.mjs";/,
      `${caller} must import the shared normalizeEol`,
    );
    assert.equal(
      /(?:const|let|function)\s+normalizeEol\b/.test(source),
      false,
      `${caller} must not define its own normalizeEol`,
    );
  }

  const staleHooks = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: "node C:\\CRX_Manager\\.codex\\hooks\\copied-hook.mjs",
            },
          ],
        },
      ],
    },
  };
  const freshHooks = {
    hooks: {
      PreToolUse: [
        {
          hooks: [
            {
              type: "command",
              command: "node \"$(git rev-parse --show-toplevel)/.codex/hooks/codex-hook-adapter.mjs\" \".claude/hooks/sql-safety.mjs\"",
              commandWindows: "powershell -Command shared-hook",
            },
            {
              type: "command",
              command: "node \"$(git rev-parse --show-toplevel)/.codex/hooks/production-action-guard.mjs\"",
              commandWindows: "powershell -Command production-action-guard.mjs",
            },
            {
              type: "command",
              command: "node \"$(git rev-parse --show-toplevel)/.codex/hooks/codex-hook-adapter.mjs\" \".claude/hooks/review-proof-guard.mjs\"",
              commandWindows: "powershell -Command review-proof-guard.mjs",
            },
          ],
        },
      ],
    },
  };

  assert.equal(checkCodexHookPortability(staleHooks).status, "FAIL");
  assert.equal(checkCodexHookPortability(freshHooks).status, "PASS");
  assert.equal(checkBranchStaleness(() => "0 2").status, "PASS");
  assert.equal(checkBranchStaleness(() => "3 1").status, "WARN");
  assert.equal(checkBranchStaleness(() => "bad output").status, "WARN");

  assert.equal(
    summarizeChecks([
      { name: "a", status: "PASS" },
      { name: "b", status: "WARN" },
    ]).exitCode,
    0,
  );
  assert.equal(
    summarizeChecks([
      { name: "a", status: "PASS" },
      { name: "b", status: "FAIL" },
    ]).exitCode,
    1,
  );

  // ── CLI auth smokes (delegate to the CLI's own authoritative status command) ──
  // The checks shell out to `codex login status` / `claude auth status`; tests inject a
  // fake runner so every outcome (logged in / out / malformed / CLI-missing) is deterministic.

  // Codex: PASS on exit 0 (codex prints "Logged in" to STDERR and signals success via the
  // exit code — so the check must not depend on stdout content); everything else FAILs.
  assert.equal(checkCodexAuth(() => ({ ok: true, stdout: "", stderr: "Logged in using ChatGPT" })).status, "PASS");
  assert.equal(checkCodexAuth(() => ({ ok: false, stdout: "Not logged in", stderr: "" })).status, "FAIL");
  // Malformed/expired tokens — codex exits non-zero with "missing field id_token" → FAIL (the
  // exact case a JSON-shape smoke would have falsely PASSed).
  assert.equal(checkCodexAuth(() => ({ ok: false, stdout: "", stderr: "Error checking login status: missing field `id_token`" })).status, "FAIL");
  // Binary not found → FAIL.
  assert.equal(checkCodexAuth(() => ({ ok: false, stdout: "", stderr: "newest OpenAI Codex binary not found" })).status, "FAIL");

  // Claude: PASS only on loggedIn:true; logged-out/unparseable/CLI-missing → WARN (env or
  // apiKeyHelper auth may still work for non-interactive `claude -p`).
  assert.equal(checkClaudeAuth(() => ({ ok: true, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), stderr: "" })).status, "PASS");
  assert.equal(checkClaudeAuth(() => ({ ok: true, stdout: JSON.stringify({ loggedIn: false }), stderr: "" })).status, "WARN");
  // Empty/malformed claudeAiOauth would make a shape-check PASS, but `claude auth status` reports
  // loggedIn:false → WARN (the round-2 P3 case).
  assert.equal(checkClaudeAuth(() => ({ ok: true, stdout: JSON.stringify({ loggedIn: false, claudeAiOauth: {} }), stderr: "" })).status, "WARN");
  assert.equal(checkClaudeAuth(() => ({ ok: true, stdout: "not json", stderr: "" })).status, "WARN");
  assert.equal(checkClaudeAuth(() => ({ ok: false, stdout: "", stderr: "unknown command 'auth'" })).status, "WARN");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("OK - agent-health-check helpers passed.");
