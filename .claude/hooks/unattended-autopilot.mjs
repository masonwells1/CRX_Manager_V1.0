#!/usr/bin/env node
// PreToolUse hook: overnight / unattended autopilot.
//
// PROBLEM (Mason's recurring complaint): when he wants a loop to run hands-free
// overnight, the session keeps stopping to ask him to approve each write/action,
// because settings.json's allow-list is a fixed enumeration and any un-enumerated
// tool variant falls through to a prompt. Telling him "it's safe to run" doesn't
// help — the grant was never actually configured.
//
// FIX: when an unexpired flag file exists (.claude/session-state/AUTOPILOT.on),
// this hook AUTO-APPROVES tool calls so the loop never stalls — EXCEPT a deny-set
// of destructive / prod-touching actions (see autopilot-lib.mjs), which stay
// blocked. The dangerous set is ALSO protected by settings.json permissions.deny
// and bash-safety/migration-apply-guard, so autopilot only removes the *prompt*
// friction for otherwise-safe calls.
//
// Arm it:   node .claude/hooks/autopilot-arm.mjs --hours 10
// Disarm:   node .claude/hooks/autopilot-arm.mjs --off   (also auto-expires)
//
// FAIL-SAFE: the flag is OFF by default, and ANY error here → emit nothing (defer
// to the normal permission flow / prompt). It never auto-allows on uncertainty.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { autopilotDecision, flagActive, intentFresh, overnightGateDecision, protectedUnattendedExecutorPaths, UNATTENDED_INTEGRITY_PATHS } from "./autopilot-lib.mjs";
import { fixedGitExecutable } from "./codex-push-lib.mjs";

function nothing() { process.exit(0); }               // defer to normal flow
function allow() {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "autopilot: unattended run armed" } }));
  process.exit(0);
}
function deny(name) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `AUTOPILOT: "${name}" is in the never-auto-approve set (out-of-band deploy / force-push or history rewrite / destructive delete / secret or auth change / direct remote file write). Autopilot suppresses ordinary permission prompts but never bypasses these boundaries. Continue safe preparation automatically; ask Mason only if the exact hard-gated action is still required. Feature-branch pushes and protected green-PR merges are judged by their normal guards and do not need another confirmation. (Live migrations are gated separately: migration-apply-guard's proof gate, which also hard-refuses DESTRUCTIVE migrations while armed — Mason's settled 2026-07-13 policy.) Disarm with: node .claude/hooks/autopilot-arm.mjs --off` } }));
  process.exit(0);
}

function denyUnarmed(name) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `OVERNIGHT HANDSHAKE: Mason asked for a hands-free run but autopilot is NOT armed, so "${name}" is paused. Arm it FIRST (node .claude/hooks/autopilot-arm.mjs --hours N), confirm to Mason in one plain-English line, then continue. If this is NOT actually a hands-free run, delete .claude/session-state/OVERNIGHT-INTENT.flag and continue normally. Reassurance without arming is the exact repeated failure this blocks.` } }));
  process.exit(0);
}

function integrityBoundaryMatchesHead(projectDir, command) {
  if (protectedUnattendedExecutorPaths(command).length === 0) return false;
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR"]) delete env[key];
  const git = (args) => execFileSync(fixedGitExecutable(), args, {
    cwd: projectDir,
    env,
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  }).trim();
  try {
    git(["rev-parse", "--verify", "HEAD^{commit}"]);
    git(["ls-files", "--error-unmatch", "--", ...UNATTENDED_INTEGRITY_PATHS]);
    const status = git(["status", "--porcelain=v1", "--untracked-files=all", "--", ...UNATTENDED_INTEGRITY_PATHS]);
    if (status) return false;
    git(["diff", "--quiet", "HEAD", "--", ...UNATTENDED_INTEGRITY_PATHS]);
    return true;
  } catch {
    return false;
  }
}

let payload;
try { payload = JSON.parse(readFileSync(0, "utf8")); } catch { nothing(); }

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const stateDir = path.join(projectDir, ".claude", "session-state");
const flagPath = path.join(stateDir, "AUTOPILOT.on");
const intentPath = path.join(stateDir, "OVERNIGHT-INTENT.flag");

let armed = false;
if (existsSync(flagPath)) {
  try { armed = flagActive(readFileSync(flagPath, "utf8"), Date.now()).active; } catch { armed = false; }
}

if (!armed) {
  // Handshake: overnight intent recorded but autopilot never armed → force the arm
  // before any building/mutating call proceeds. (Fail-open on any error.)
  try {
    if (existsSync(intentPath) && intentFresh(readFileSync(intentPath, "utf8"), Date.now())) {
      const gate = overnightGateDecision(payload?.tool_name, payload?.tool_input);
      if (gate === "deny-until-armed") denyUnarmed(payload?.tool_name || "(tool)");
    }
  } catch { /* fail open */ }
  nothing();   // no active autopilot → normal permission flow
}

// Armed: the intent is satisfied — clear the handshake flag (best effort).
try { if (existsSync(intentPath)) unlinkSync(intentPath); } catch { /* ignore */ }

const decision = autopilotDecision(payload?.tool_name, payload?.tool_input);
if (decision === "deny") deny(payload?.tool_name || "(tool)");
if (decision === "verify-integrity") {
  const command = String(payload?.tool_input?.command ?? payload?.tool_input?.cmd ?? "");
  if (!integrityBoundaryMatchesHead(projectDir, command)) deny(payload?.tool_name || "(tool)");
}
allow();
