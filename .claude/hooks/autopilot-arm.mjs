#!/usr/bin/env node
// Arm / disarm the overnight autopilot flag that unattended-autopilot.mjs reads.
//
//   node .claude/hooks/autopilot-arm.mjs --hours 10   # arm for 10 hours
//   node .claude/hooks/autopilot-arm.mjs --off        # disarm now
//   node .claude/hooks/autopilot-arm.mjs --status      # show current state
//
// Writing the flag is what actually stops the permission prompts — never tell
// Mason "it's safe to run" without running this and confirming the flag exists.

import { writeFileSync, existsSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { flagActive } from "./autopilot-lib.mjs";

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const stateDir = path.join(projectDir, ".claude", "session-state");
const flagPath = path.join(stateDir, "AUTOPILOT.on");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
function argVal(f, dflt) {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}

if (has("--off")) {
  try { if (existsSync(flagPath)) rmSync(flagPath); } catch { /* ignore */ }
  console.log("AUTOPILOT: OFF (flag removed). Normal permission prompts are back on.");
  process.exit(0);
}

if (has("--status")) {
  if (!existsSync(flagPath)) { console.log("AUTOPILOT: OFF (no flag)."); process.exit(0); }
  const state = flagActive(readFileSync(flagPath, "utf8"), Date.now());
  console.log(state.active ? `AUTOPILOT: ON until ${state.expires}` : `AUTOPILOT: OFF (${state.reason}).`);
  process.exit(0);
}

// default action: arm
const hours = Math.max(0.25, Math.min(24, Number(argVal("--hours", "10")) || 10));
const expiresMs = Date.now() + hours * 3600 * 1000;
const expires = new Date(expiresMs).toISOString();
try {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(flagPath, JSON.stringify({ expires, armed_at: new Date().toISOString(), hours }, null, 2), "utf8");
} catch (e) {
  console.error("FAILED to arm autopilot:", e && e.message);
  process.exit(1);
}
// Verify the flag actually took (prove it, don't assume).
const ok = existsSync(flagPath) && flagActive(readFileSync(flagPath, "utf8"), Date.now()).active;
if (!ok) { console.error("Arm wrote the flag but verification failed — do NOT tell Mason it's armed."); process.exit(1); }
console.log(`AUTOPILOT: ON until ${expires} (${hours}h). Loops won't stall on ordinary permission prompts; feature-branch pushes and protected green-PR merges continue through their existing guards without another confirmation. Force-push/history rewrite, out-of-band deploy, destructive actions, secret/auth changes, bypasses, and direct remote writes remain blocked or gated. Live migrations may apply hands-free through the full proof gate (hash-bound reviewer proof + hash-bound Codex proof codex-review-mig-<name>.json — settled 2026-07-13 policy); DESTRUCTIVE migrations are refused while armed, and if this arming EXPIRES all applies park until Mason returns.`);
