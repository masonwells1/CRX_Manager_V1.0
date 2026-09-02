#!/usr/bin/env node
// Sanctioned remediation path for a FALSE-POSITIVE overnight-intent latch.
//
// autopilot-intent-reminder.mjs writes .claude/session-state/OVERNIGHT-INTENT.flag
// whenever Mason's prompt LOOKS like a request for a hands-free run. While that
// flag is fresh (45 min) and AUTOPILOT.on is not armed, unattended-autopilot.mjs
// pauses every building/mutating tool call — Bash, Write, Edit — until the agent
// either arms autopilot or clears the flag. That handshake is deliberate: it stops
// an agent from reassuring Mason "it's safe to run overnight" without actually
// arming anything.
//
// The flag latches on a HEURISTIC, so it also fires on prompts that merely discuss
// autopilot (e.g. a task to fix the autopilot hooks). When that happens the session
// is wedged: the documented escape — deleting the flag from the shell — is refused
// by review-proof-guard.mjs, which blocks every destructive shell command touching
// .claude/session-state. Write and Edit are blocked by the handshake itself, so
// the ONLY unblocked path left was arming autopilot, which is precisely the
// failure the handshake exists to prevent. This script is the way out.
//
// WHY A SCRIPT AND NOT A GUARD CARVE-OUT: teaching review-proof-guard to permit
// `rm <this one file>` means parsing shell arguments exactly, or a command like
// `rm OVERNIGHT-INTENT.flag applied-source-ledger.json` rides through on one
// allowed word. That is command-spelling enumeration — the shape that failed
// across six rounds on the `git clean` carve-out and five on the worktree-prefix
// carve-out. Here the allowlist is ONE FILE, not a command grammar: this script
// builds the path internally and never names it in the tool command, exactly like
// scripts/remove-applied-ledger-entry.mjs. review-proof-guard needs no change.
//
// WHY IT TAKES AN EXPLICIT FLAG: commit c352fec6 (2026-08-08) removed a blanket
// `rm -f OVERNIGHT-INTENT.flag` permission after CodeRabbit flagged it as a
// guard-bypass risk; the settled intent was that clearing stays possible but
// DELIBERATE, never a reflex. --not-a-hands-free-run is that deliberation: the
// agent must state, in the transcript Mason can read, that he did not ask for an
// unattended run. The flag verifies nothing by itself — it records a conscious
// assertion and gates the clear behind a step an agent will not take by accident.
//
// SAFETY: clearing this flag GRANTS NOTHING. It removes a pause, after which the
// session falls back to the NORMAL permission flow — every other hook, the
// autopilot deny-set, and Mason's own approval prompts all still apply. The
// dangerous direction is ARMING (which auto-approves ordinary calls for N hours);
// clearing is strictly the safe direction, which is why this needs no proof
// bundle the way a migration apply does.
//
// Usage:
//   node scripts/clear-overnight-intent.mjs                          # explains, changes nothing
//   node scripts/clear-overnight-intent.mjs --not-a-hands-free-run   # clears the latch
//
// There is deliberately NO argument that selects a target: this script can only
// ever remove that one filename, so it cannot be aimed at the applied-source
// ledger, a review proof, or anything else in the state directory.
//
// PROTECTED MACHINERY. autopilot-lib.mjs allows this exact command through the
// overnight handshake while every other build/mutate call is paused, so an
// unreviewed edit to this file would turn the sanctioned command into arbitrary
// code execution during that pause (Codex gpt-5.6-sol exact-SHA review 2026-09-01,
// HIGH). It is therefore registered alongside run-claude-review.mjs and
// write-codex-push-proof.mjs in codex-push-lib.mjs's RISKY_PATH_RES, the Codex
// PROTECTED_HARNESS set, and .claude/settings.json's protected-path rules.
// Changing this file requires the independent review gate. Keep it that way.

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

function fail(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

let root = process.cwd();
try {
  root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
  }).trim() || root;
} catch { /* not a repo — fall back to cwd */ }

// Built internally and never accepted from argv, so the tool command that invokes
// this script never names a protected path (that is what keeps it past
// review-proof-guard) and no caller can retarget it.
const stateDir = path.join(root, ".claude", "session-state");
const intentPath = path.join(stateDir, "OVERNIGHT-INTENT.flag");
const armedPath = path.join(stateDir, "AUTOPILOT.on");

const args = process.argv.slice(2);
const KNOWN_FLAGS = new Set(["--not-a-hands-free-run"]);
const unknown = args.filter((a) => !KNOWN_FLAGS.has(a));
if (unknown.length > 0) {
  fail(
    `Unknown argument(s): ${unknown.map((a) => JSON.stringify(a)).join(", ")}\n` +
    `This script takes only --not-a-hands-free-run and never accepts a target path.`
  );
}
const asserted = args.includes("--not-a-hands-free-run");

// Report whether autopilot is currently armed, so the operator can see which
// situation they are actually in before clearing anything.
let armedNote = "autopilot is NOT armed";
if (existsSync(armedPath)) {
  try {
    const expires = Date.parse(JSON.parse(readFileSync(armedPath, "utf8"))?.expires ?? "");
    if (Number.isFinite(expires)) {
      armedNote = Date.now() < expires
        ? `autopilot IS armed until ${new Date(expires).toISOString()}`
        : `autopilot flag present but EXPIRED at ${new Date(expires).toISOString()} (inert)`;
    } else {
      armedNote = "autopilot flag present but has no readable expiry (treated as disarmed)";
    }
  } catch {
    armedNote = "autopilot flag present but unreadable (treated as disarmed)";
  }
}

if (!existsSync(intentPath)) {
  process.stdout.write(
    `No overnight-intent latch is set — nothing to clear (${armedNote}).\n`
  );
  process.exit(0);
}

let created = "unknown";
try {
  const parsed = Date.parse(JSON.parse(readFileSync(intentPath, "utf8"))?.created ?? "");
  if (Number.isFinite(parsed)) created = new Date(parsed).toISOString();
} catch { /* keep "unknown" — a malformed latch is still clearable */ }

if (!asserted) {
  fail(
    `An overnight-intent latch is set (recorded ${created}; ${armedNote}).\n` +
    `\n` +
    `Clear it ONLY if Mason did NOT actually ask for an unattended/hands-free run —\n` +
    `for example the latch fired on a prompt that merely DISCUSSED autopilot.\n` +
    `\n` +
    `If he DID ask for a hands-free run, do not clear it. Arm autopilot instead:\n` +
    `  node .claude/hooks/autopilot-arm.mjs --hours <N>\n` +
    `\n` +
    `Otherwise re-run with the explicit assertion:\n` +
    `  node scripts/clear-overnight-intent.mjs --not-a-hands-free-run`
  );
}

try {
  unlinkSync(intentPath);
} catch (e) {
  if (e?.code === "ENOENT") {
    process.stdout.write("Latch disappeared before removal (another process cleared it). Nothing to do.\n");
    process.exit(0);
  }
  fail(`Could not clear the overnight-intent latch (${e?.message || e}). Nothing changed.`);
}

process.stdout.write(
  `Cleared the overnight-intent latch (was recorded ${created}; ${armedNote}).\n` +
  `You asserted this is NOT a hands-free run, so the session returns to the normal\n` +
  `permission flow. No permission was granted — autopilot remains unarmed.\n`
);
