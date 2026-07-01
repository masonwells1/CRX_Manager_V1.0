#!/usr/bin/env node
// PreToolUse half of the hold latch: while a HOLD is latched (hold.json held:true),
// block "building" tool calls (source Write/Edit, git commit/push, migration/deploy,
// writing SQL). Reads, tests/builds, and writes to session-state/scratchpad/plans stay
// allowed so Claude can still answer, checkpoint, and write a SCOPE.md.
//
// FAIL-OPEN: any error, or no latch → emit nothing (normal flow). The latch is cleared
// by the next user message (hold-latch-prompt.mjs), so it can never stick across turns.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { isBuildActionUnderHold } from "./hold-latch-lib.mjs";

function nothing() { process.exit(0); }

let payload;
try { payload = JSON.parse(readFileSync(0, "utf8")); } catch { nothing(); }

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const holdPath = path.join(projectDir, ".claude", "session-state", "hold.json");

if (!existsSync(holdPath)) nothing();
let held = false;
try { held = JSON.parse(readFileSync(holdPath, "utf8")).held === true; } catch { nothing(); }
if (!held) nothing();

if (isBuildActionUnderHold(payload?.tool_name, payload?.tool_input)) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "HOLD is latched — Mason said stop / pause / scope-only, so building actions (editing source, committing, migrating, deploying, writing SQL) are paused. You may still read, run tests/builds, and write a progress note / SCOPE.md to .claude/session-state. Wait for his next message to resume (that clears the hold automatically).",
    },
  }));
  process.exit(0);
}

nothing();
