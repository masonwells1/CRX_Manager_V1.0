#!/usr/bin/env node
// END-TO-END proof that the sanctioned overnight-intent escape hatch actually works.
//
// WHY THIS FILE EXISTS. autopilot-lib.test.mjs asserted for months that
// `rm .claude/session-state/OVERNIGHT-INTENT.flag` returned "allow-through", and it
// passed — while the command was in fact refused by review-proof-guard.mjs, a
// DIFFERENT hook registered on matcher "*". One hook returning allow proves nothing
// about whether a command runs: a PreToolUse chain denies if ANY member denies.
// Because Bash, Write and Edit are all gated during an unarmed latch, that left a
// mis-latched session with no unblocked path except arming autopilot — the exact
// failure the handshake exists to prevent (reproduced live 2026-09-01).
//
// So this test does not import the decision libraries at all. It reads the REAL
// .claude/settings.json, spawns EVERY PreToolUse hook whose matcher matches Bash,
// in the registered order, and fails if any one of them denies the sanctioned
// command. Registering a new hook that blocks this escape hatch breaks this test.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hooksDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(hooksDir, "..", "..");
const settingsPath = path.join(repoRoot, ".claude", "settings.json");
const clearScript = path.join(repoRoot, "scripts", "clear-overnight-intent.mjs");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    process.stdout.write(`  ok  ${name}\n`);
  } catch (e) {
    failures += 1;
    process.stdout.write(`  FAIL ${name}\n       ${e?.message || e}\n`);
  }
}

// ── 1. Collect the real PreToolUse chain for a Bash call ────────────────────
const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
const preToolUse = settings?.hooks?.PreToolUse ?? [];

function matcherCoversBash(matcher) {
  const m = String(matcher ?? "*");
  if (m === "*" || m === "") return true;
  try {
    return new RegExp(`^(?:${m})$`).test("Bash");
  } catch {
    return false; // an unparseable matcher cannot be proven to cover Bash
  }
}

// Hook commands look like: node "$CLAUDE_PROJECT_DIR/.claude/hooks/x.mjs"
function hookScriptPath(command, projectDir) {
  const m = /"?\$(?:\{)?CLAUDE_PROJECT_DIR(?:\})?\/([^"]+)"?/.exec(String(command || ""));
  return m ? path.join(projectDir, m[1]) : null;
}

const bashHooks = [];
for (const group of preToolUse) {
  if (!matcherCoversBash(group?.matcher)) continue;
  for (const hook of group?.hooks ?? []) {
    const script = hookScriptPath(hook?.command, repoRoot);
    if (script) bashHooks.push({ script, name: path.basename(script) });
  }
}

check("settings.json registers a non-trivial PreToolUse chain for Bash", () => {
  assert.ok(bashHooks.length >= 3, `expected >=3 Bash-matching hooks, found ${bashHooks.length}`);
  // The two hooks at the heart of this deadlock must be in the chain we test,
  // otherwise this test is proving nothing about the real failure.
  const names = bashHooks.map((h) => h.name);
  assert.ok(names.includes("review-proof-guard.mjs"), `review-proof-guard.mjs missing from chain: ${names.join(", ")}`);
  assert.ok(names.includes("unattended-autopilot.mjs"), `unattended-autopilot.mjs missing from chain: ${names.join(", ")}`);
});

// ── 2. A fixture project whose latch is FRESH and whose autopilot is UNARMED ──
const fixture = mkdtempSync(path.join(os.tmpdir(), "crx-intent-clear-"));
const fixtureState = path.join(fixture, ".claude", "session-state");

function armLatch() {
  mkdirSync(fixtureState, { recursive: true });
  writeFileSync(
    path.join(fixtureState, "OVERNIGHT-INTENT.flag"),
    JSON.stringify({ created: new Date().toISOString(), source: "overnight-intent-clear.test" })
  );
  // Deliberately NO AUTOPILOT.on: unarmed is the wedged state we are testing.
  rmSync(path.join(fixtureState, "AUTOPILOT.on"), { force: true });
}

function latchExists() {
  return existsSync(path.join(fixtureState, "OVERNIGHT-INTENT.flag"));
}

// Run the whole registered chain against one Bash command. Returns the list of
// hooks that denied it.
function denialsFor(command) {
  const payload = JSON.stringify({
    tool_name: "Bash",
    cwd: fixture,
    tool_input: { command },
  });
  const denied = [];
  for (const { script, name } of bashHooks) {
    const res = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      input: payload,
      timeout: 20000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: fixture },
    });
    if (res.error?.code === "ETIMEDOUT" || res.signal) {
      // Never treat "did not answer" as "allowed" — that is how a guard test
      // silently stops testing anything.
      throw new Error(`hook ${name} did not complete (signal=${res.signal}, err=${res.error?.message})`);
    }
    let decision = null;
    try {
      decision = JSON.parse(res.stdout || "{}")?.hookSpecificOutput?.permissionDecision ?? null;
    } catch { /* non-JSON stdout means no decision */ }
    if (decision === "deny") denied.push(name);
  }
  return denied;
}

const SANCTIONED = "node scripts/clear-overnight-intent.mjs --not-a-hands-free-run";

check("THE POINT: the sanctioned clear command survives the ENTIRE Bash hook chain", () => {
  armLatch();
  const denied = denialsFor(SANCTIONED);
  assert.deepEqual(denied, [], `denied by: ${denied.join(", ")}`);
});

check("the sanctioned command is not blocked by an accidental cwd rule either", () => {
  armLatch();
  const denied = denialsFor("node ./scripts/clear-overnight-intent.mjs --not-a-hands-free-run");
  assert.deepEqual(denied, [], `denied by: ${denied.join(", ")}`);
});

// Reality check: the escape the deny message USED to advertise really is refused.
// If this ever stops denying, the guard changed and the docs should be revisited.
check("the old `rm` escape is still refused by the real chain (documents why the script exists)", () => {
  armLatch();
  const denied = denialsFor("rm .claude/session-state/OVERNIGHT-INTENT.flag");
  assert.ok(denied.length > 0, "expected at least one hook to deny the rm form");
  assert.ok(
    denied.includes("review-proof-guard.mjs"),
    `expected review-proof-guard.mjs to deny it, got: ${denied.join(", ")}`
  );
});

check("the latch still gates ordinary building commands (the handshake is not defeated)", () => {
  armLatch();
  const denied = denialsFor("npm run build");
  assert.ok(
    denied.includes("unattended-autopilot.mjs"),
    `expected the handshake to still pause an ordinary build, got: ${denied.join(", ")}`
  );
});

check("the allowance cannot be used as a prefix to smuggle a chained command", () => {
  armLatch();
  const denied = denialsFor(`${SANCTIONED} && npm run build`);
  assert.ok(
    denied.includes("unattended-autopilot.mjs"),
    `chaining after the clear script must stay gated, got: ${denied.join(", ")}`
  );
});

// Codex (gpt-5.6-sol, exact-SHA review 2026-09-01) proved that the first draft of
// this allowance — an anchored regex over the command SHAPE — validated only the
// executable and script BASENAMES. Since Bash is globally allowed and the other
// hooks inspect the visible command rather than the JavaScript it runs, any
// pre-existing attacker-controlled file named clear-overnight-intent.mjs became
// arbitrary code execution during the very pause the latch enforces. The original
// version of this test missed it entirely: it only ever tried sanctioned commands.
// Every entry below is a command that must NOT reach the shell while latched.
for (const [label, command] of [
  ["alternate directory", "node attacker/clear-overnight-intent.mjs --not-a-hands-free-run"],
  ["alternate interpreter + absolute path", '"C:\\attacker\\node.exe" "C:\\attacker\\clear-overnight-intent.mjs" --not-a-hands-free-run'],
  ["parent-directory traversal", "node ../clear-overnight-intent.mjs --not-a-hands-free-run"],
  ["UNC path", "node //server/share/clear-overnight-intent.mjs --not-a-hands-free-run"],
  ["glob in the path", "node scripts/*/clear-overnight-intent.mjs --not-a-hands-free-run"],
  ["shell expansion in the path", "node $DIR/clear-overnight-intent.mjs --not-a-hands-free-run"],
  ["NODE_OPTIONS module injection", "NODE_OPTIONS=--require=./evil.js node scripts/clear-overnight-intent.mjs --not-a-hands-free-run"],
]) {
  check(`PROVEN BYPASS stays gated end-to-end: ${label}`, () => {
    armLatch();
    const denied = denialsFor(command);
    assert.ok(
      denied.includes("unattended-autopilot.mjs"),
      `expected the handshake to still pause this, got: ${denied.join(", ") || "(nothing denied)"}`
    );
  });
}

// ── 3. The script itself does what it claims ────────────────────────────────
function runClear(args, cwd = fixture) {
  return spawnSync(process.execPath, [clearScript, ...args], {
    encoding: "utf8",
    cwd,
    timeout: 20000,
  });
}

check("without the explicit assertion the script refuses and leaves the latch in place", () => {
  armLatch();
  const res = runClear([]);
  assert.notEqual(res.status, 0, "expected a non-zero exit");
  assert.match(res.stderr, /--not-a-hands-free-run/, "expected the usage hint");
  assert.ok(latchExists(), "latch must NOT be removed without the assertion");
});

check("an unknown argument is refused and changes nothing", () => {
  armLatch();
  const res = runClear(["--not-a-hands-free-run", "--force"]);
  assert.notEqual(res.status, 0, "expected a non-zero exit");
  assert.match(res.stderr, /Unknown argument/i);
  assert.ok(latchExists(), "latch must survive a rejected invocation");
});

check("PROOF OF EFFECT: with the assertion the latch is actually gone", () => {
  armLatch();
  assert.ok(latchExists(), "precondition: latch present");
  const res = runClear(["--not-a-hands-free-run"]);
  assert.equal(res.status, 0, `expected success, stderr: ${res.stderr}`);
  assert.ok(!latchExists(), "latch must be removed");
});

check("clearing again is idempotent and never errors", () => {
  const res = runClear(["--not-a-hands-free-run"]);
  assert.equal(res.status, 0, `expected success, stderr: ${res.stderr}`);
  assert.match(res.stdout, /nothing to clear/i);
});

check("the script cannot be aimed at anything but the latch", () => {
  armLatch();
  const ledger = path.join(fixtureState, "applied-source-ledger.json");
  writeFileSync(ledger, JSON.stringify([{ name: "probe_entry" }]));
  // There is no argument that selects a target; a path argument must be rejected.
  const res = runClear(["applied-source-ledger.json"]);
  assert.notEqual(res.status, 0, "a path argument must be rejected");
  assert.ok(existsSync(ledger), "the ledger must be untouched");
  // And a successful clear must leave every other state file alone.
  const ok = runClear(["--not-a-hands-free-run"]);
  assert.equal(ok.status, 0, `expected success, stderr: ${ok.stderr}`);
  assert.ok(existsSync(ledger), "the ledger must survive a successful latch clear");
  assert.ok(!latchExists(), "only the latch is removed");
});

rmSync(fixture, { recursive: true, force: true });

if (failures > 0) {
  process.stderr.write(`\novernight-intent-clear.test.mjs: ${failures} check(s) failed\n`);
  process.exit(1);
}
process.stdout.write("overnight-intent-clear.test.mjs: all checks passed\n");
