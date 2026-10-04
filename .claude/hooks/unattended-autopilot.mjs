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

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { autopilotDecision, flagActive } from "./autopilot-lib.mjs";

function nothing() { process.exit(0); }               // defer to normal flow
function allow() {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "autopilot: unattended run armed" } }));
  process.exit(0);
}
function deny(name) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `AUTOPILOT: "${name}" is in the never-auto-approve set (push / merge / deploy / destructive delete / secret write). Autopilot suppresses ordinary permission prompts but NOT these — they need Mason's explicit OK. Landing work is the one exception: a plain \`git push origin <work-branch>\` and a plain \`gh pr merge <number> --squash\` pass on to codex-push-guard and pr-merge-guard, which enforce Mason's 2026-09-26 landing rule; any other spelling of a push or merge lands here. (Live migrations are gated separately: migration-apply-guard's proof gate, which hard-refuses DESTRUCTIVE migrations for agents in every session.) Disarm with: node .claude/hooks/autopilot-arm.mjs --off` } }));
  process.exit(0);
}

let payload;
try { payload = JSON.parse(readFileSync(0, "utf8")); } catch { nothing(); }

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const stateDir = path.join(projectDir, ".claude", "session-state");
const flagPath = path.join(stateDir, "AUTOPILOT.on");

let armed = false;
if (existsSync(flagPath)) {
  try { armed = flagActive(readFileSync(flagPath, "utf8"), Date.now()).active; } catch { armed = false; }
}

if (!armed) nothing();   // no active autopilot → normal permission flow

const decision = autopilotDecision(payload?.tool_name, payload?.tool_input);
if (decision === "deny") deny(payload?.tool_name || "(tool)");
allow();
