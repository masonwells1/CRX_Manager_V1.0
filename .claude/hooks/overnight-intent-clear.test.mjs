#!/usr/bin/env node
// Holds the overnight handshake's deny message to remedies that ACTUALLY WORK,
// against the real registered hook chain.
//
// WHY THIS FILE EXISTS. For months `unattended-autopilot.mjs` told agents that if a
// session was latched by mistake, the fix was to delete
// .claude/session-state/OVERNIGHT-INTENT.flag from the shell. That command has never
// worked: review-proof-guard.mjs (matcher "*") refuses every destructive shell
// command touching that directory. autopilot-lib.test.mjs asserted the command was
// allowed and passed the whole time — it tested ONE hook, and a PreToolUse chain
// denies if ANY member denies. Since the handshake also gates Bash, Write and Edit,
// a mis-latched session had no unblocked path left except arming autopilot: exactly
// the failure the handshake exists to prevent (reproduced live 2026-09-01).
//
// A sanctioned `node scripts/clear-overnight-intent.mjs` escape was built to fix
// that, and then REMOVED on Mason's decision (2026-09-01) after two rounds of
// exact-SHA gpt-5.6-sol review found four HIGH bypasses in it — basename-only
// matching, then an exact-string allowance still unbound to the project root, plus a
// helper that could be edited locally before invocation. Each fix was another text
// rule over a command string, the shape this repo has already proven does not
// converge. The disease was a pause of at most 45 minutes; the cure was a fresh way
// to EXECUTE CODE during precisely the window when execution is meant to be paused.
//
// So the contract this file enforces is now:
//   1. the deny message advertises NO shell remedy that the real chain refuses;
//   2. the two true remedies (45-minute expiry, Mason deleting the file) are stated;
//   3. the removed script escape is not quietly reintroduced;
//   4. the expiry actually releases the latch, and a fresh latch actually holds it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { INTENT_FRESH_MS } from "./autopilot-lib.mjs";

const hooksDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(hooksDir, "..", "..");
const settingsPath = path.join(repoRoot, ".claude", "settings.json");
const hookSource = readFileSync(path.join(hooksDir, "unattended-autopilot.mjs"), "utf8");

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

// ── The real PreToolUse chain for a Bash call ───────────────────────────────
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
  const names = bashHooks.map((h) => h.name);
  // The two hooks at the heart of the original deadlock must be in the chain we
  // test, or this file proves nothing about the real failure.
  assert.ok(names.includes("review-proof-guard.mjs"), `review-proof-guard.mjs missing: ${names.join(", ")}`);
  assert.ok(names.includes("unattended-autopilot.mjs"), `unattended-autopilot.mjs missing: ${names.join(", ")}`);
});

// ── Fixture: a latch of a chosen age, autopilot never armed ─────────────────
const fixture = mkdtempSync(path.join(os.tmpdir(), "crx-intent-latch-"));
const fixtureState = path.join(fixture, ".claude", "session-state");

function armLatch(ageMs = 0) {
  mkdirSync(fixtureState, { recursive: true });
  writeFileSync(
    path.join(fixtureState, "OVERNIGHT-INTENT.flag"),
    JSON.stringify({ created: new Date(Date.now() - ageMs).toISOString(), source: "overnight-intent-clear.test" })
  );
  rmSync(path.join(fixtureState, "AUTOPILOT.on"), { force: true });
}

function denialsFor(command, cwdOverride) {
  const payload = JSON.stringify({ tool_name: "Bash", cwd: cwdOverride ?? fixture, tool_input: { command } });
  const denied = [];
  for (const { script, name } of bashHooks) {
    const res = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      input: payload,
      timeout: 20000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: fixture },
    });
    // FAIL CLOSED on anything that is not a clean, completed run. Reading "the
    // hook did not answer" as "the hook allowed it" is precisely how a guard test
    // stops testing anything while staying green — the failure this whole file
    // exists to prevent. An earlier revision only caught timeouts and signals, so
    // a spawn failure (ENOENT, EACCES) or a hook that crashed with a nonzero exit
    // silently counted as "no denial" (Codex gpt-5.6-sol review, 2026-09-01).
    if (res.error) {
      throw new Error(`hook ${name} failed to run (${res.error.code || ""} ${res.error.message})`);
    }
    if (res.signal) {
      throw new Error(`hook ${name} was killed by signal ${res.signal}`);
    }
    if (res.status !== 0) {
      throw new Error(`hook ${name} exited ${res.status} — a crashed hook must not read as "allowed"\n${res.stderr || ""}`);
    }
    // EMPTY stdout is the legitimate "I defer to the normal permission flow"
    // answer — most hooks exit 0 saying nothing. But stdout that is non-empty and
    // UNPARSEABLE is a malformed answer, and swallowing it scored the hook as
    // "allowed" (Codex gpt-5.6-sol review, 2026-09-01 — the third instance of this
    // false-green class in this one file). Only silence may mean "no decision".
    const stdout = String(res.stdout ?? "").trim();
    let decision = null;
    if (stdout !== "") {
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw new Error(
          `hook ${name} emitted unparseable output — a malformed answer must not read as "allowed":\n${stdout.slice(0, 500)}`
        );
      }
      decision = parsed?.hookSpecificOutput?.permissionDecision ?? null;
    }
    if (decision === "deny") denied.push(name);
  }
  return denied;
}

// ── 1. The deny message must not advertise a remedy the chain refuses ───────
const denyMessage = (() => {
  const m = /OVERNIGHT HANDSHAKE:[\s\S]*?this blocks\./.exec(hookSource);
  assert.ok(m, "could not locate the OVERNIGHT HANDSHAKE deny message in unattended-autopilot.mjs");
  return m[0];
})();

check("THE POINT: the deny message advertises no shell delete of the flag", () => {
  // This exact advice is what made the hatch a lie for months.
  assert.ok(
    !/\b(rm|del|Remove-Item|unlink)\b[^.]*OVERNIGHT-INTENT/i.test(denyMessage) &&
    !/delete\s+\.?[\w/\\.-]*session-state[\w/\\.-]*OVERNIGHT-INTENT\.flag/i.test(denyMessage),
    `deny message still tells the agent to delete the flag from the shell:\n${denyMessage}`
  );
});

check("the deny message states the two remedies that actually work", () => {
  assert.match(denyMessage, /45 minutes|expires by itself/i, "must state the self-expiry");
  assert.match(denyMessage, /Mason can delete/i, "must state that Mason can delete it himself");
  assert.match(denyMessage, /worktree/i, "must point at the worktree copy, not the main checkout");
  assert.match(denyMessage, /do NOT arm autopilot/i, "must forbid arming as an escape");
});

check("every shell command the deny message advertises survives the real chain", () => {
  armLatch();
  // Pull `node ...` invocations out of the message and prove each one is runnable.
  // Stop at a closing paren: the message names the arm command inside a
  // parenthetical, and `)` is not part of the command.
  const commands = [...denyMessage.matchAll(/\bnode\s+[^\s,;()]+(?:\s+--[\w-]+(?:\s+[^\s,;()]+)?)*/g)]
    .map((m) => m[0].replace(/[.,]+$/, ""))
    // The message writes `--hours N` as a documentation placeholder. Fill it with a
    // real value before checking: the contract is that the advertised command runs
    // once the operator substitutes the obvious argument, not that the literal
    // letter N is accepted by the guard (it must not be).
    .map((c) => c.replace(/--hours\s+N\b/, "--hours 8"));
  assert.ok(commands.length > 0, "expected the message to advertise at least the arm command");
  for (const command of commands) {
    const denied = denialsFor(command);
    assert.deepEqual(denied, [], `advertised command "${command}" is denied by: ${denied.join(", ")}`);
  }
});

// ── 2. Reality checks on what is and is not gated ───────────────────────────
check("the `rm` form really is refused by the chain (why it is not advertised)", () => {
  armLatch();
  const denied = denialsFor("rm .claude/session-state/OVERNIGHT-INTENT.flag");
  assert.ok(denied.includes("review-proof-guard.mjs"), `expected review-proof-guard to deny it, got: ${denied.join(", ")}`);
});

check("the removed clear-script escape is not quietly reintroduced", () => {
  armLatch();
  for (const command of [
    "node scripts/clear-overnight-intent.mjs --not-a-hands-free-run",
    "node attacker/clear-overnight-intent.mjs --not-a-hands-free-run",
  ]) {
    const denied = denialsFor(command);
    assert.ok(
      denied.includes("unattended-autopilot.mjs"),
      `"${command}" must stay gated, got: ${denied.join(", ") || "(nothing denied)"}`
    );
  }
});

// Codex (gpt-5.6-sol, exact-SHA review 2026-09-02, HIGH): the arm allowance
// matched command TEXT, so the same relative path run from a directory holding a
// planted `.claude/hooks/autopilot-arm.mjs` executed attacker JavaScript during
// the pause — past every later tool-call guard. The allowance is now bound to the
// trusted project root, so the BYTE-IDENTICAL command is allowed from the repo and
// denied from anywhere else. This is the end-to-end half of that proof: same text,
// real hooks, only the working directory differs.
check("PROVEN BYPASS end-to-end: the arm command is cwd-bound, not text-matched", () => {
  armLatch();
  const armCommand = "node .claude/hooks/autopilot-arm.mjs --hours 8";

  const fromRoot = denialsFor(armCommand);
  assert.deepEqual(fromRoot, [], `the arm command must work from the project root, denied by: ${fromRoot.join(", ")}`);

  // A directory with a planted arm script at the same relative path.
  const planted = mkdtempSync(path.join(os.tmpdir(), "crx-planted-"));
  mkdirSync(path.join(planted, ".claude", "hooks"), { recursive: true });
  writeFileSync(path.join(planted, ".claude", "hooks", "autopilot-arm.mjs"), "// attacker payload\n");
  try {
    const fromPlanted = denialsFor(armCommand, planted);
    assert.ok(
      fromPlanted.includes("unattended-autopilot.mjs"),
      `the identical command from a planted cwd must be denied, got: ${fromPlanted.join(", ") || "(nothing denied)"}`
    );
  } finally {
    rmSync(planted, { recursive: true, force: true });
  }
});

check("a FRESH latch really does pause ordinary building", () => {
  armLatch(0);
  const denied = denialsFor("npm run build");
  assert.ok(denied.includes("unattended-autopilot.mjs"), `expected the handshake to pause a build, got: ${denied.join(", ")}`);
});

// ── 3. The advertised remedy is real: expiry releases the latch ─────────────
check("PROOF OF REMEDY: a latch older than the freshness window stops gating", () => {
  armLatch(INTENT_FRESH_MS + 60_000);
  const denied = denialsFor("npm run build");
  assert.ok(
    !denied.includes("unattended-autopilot.mjs"),
    `an expired latch must release the session, but it was still denied by: ${denied.join(", ")}`
  );
});

check("the freshness window the message quotes matches the code", () => {
  assert.equal(INTENT_FRESH_MS, 45 * 60 * 1000, "deny message says 45 minutes — keep INTENT_FRESH_MS in step with it");
});

rmSync(fixture, { recursive: true, force: true });

if (failures > 0) {
  process.stderr.write(`\novernight-intent-clear.test.mjs: ${failures} check(s) failed\n`);
  process.exit(1);
}
process.stdout.write("overnight-intent-clear.test.mjs: all checks passed\n");
