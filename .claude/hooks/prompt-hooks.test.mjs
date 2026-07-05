#!/usr/bin/env node
// Tests for prompt-source-lib (machine-content detection + single-source push policy)
// and for the 7 UserPromptSubmit phrase hooks staying SILENT on machine-generated
// prompts (the 2026-07-04 false-positive class: a <task-notification> latched the
// hold and tripped four reminders on text Mason never typed).
// Run: node .claude/hooks/prompt-hooks.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isMachineGenerated, PUSH_POLICY } from "./prompt-source-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }
function eq(a, b, m) { assert.equal(a, b, m); pass++; }

// ── isMachineGenerated ───────────────────────────────────────────────────
ok(isMachineGenerated("<task-notification>\n<task-id>x</task-id>\nforce push stop overnight\n</task-notification>"), "task-notification detected");
ok(isMachineGenerated("some text with a <system-reminder> block inside"), "system-reminder detected");
ok(isMachineGenerated("<command-name>/ship</command-name>"), "command expansion detected");
ok(isMachineGenerated('  <task-notification source="wf">body</task-notification>'), "attributed tag at start detected");
ok(!isMachineGenerated("build me the invoices page"), "normal build prompt not machine");
ok(!isMachineGenerated("we should stop and think about force pushing"), "risky words alone not machine");
ok(!isMachineGenerated("run it overnight and dont ask me"), "overnight phrasing alone not machine");
ok(!isMachineGenerated(""), "empty not machine");

// ── PUSH_POLICY is the one canonical, non-contradictory statement ────────
ok(/AUTO-PUSH to main \(2026-06-16\)/.test(PUSH_POLICY), "policy names the authorization");
ok(/HARD GATES/.test(PUSH_POLICY), "policy names the hard gates");
ok(!/never pushes/i.test(PUSH_POLICY), "policy has no stale never-pushes text");

// ── no hook still carries the stale contradictory policy text ────────────
for (const f of readdirSync(__dirname)) {
  if (!f.endsWith(".mjs") || f.endsWith(".test.mjs")) continue;
  const src = readFileSync(path.join(__dirname, f), "utf8");
  ok(!/never pushes autonomously|Claude never pushes/i.test(src), `${f} carries no stale never-pushes policy`);
}

// ── the 7 phrase hooks are SILENT on a machine-generated prompt ──────────
const MACHINE_PROMPT =
  "<task-notification>\n<task-id>t1</task-id>\naudit found: FORCE PUSH risk; hooks block 'stop/pause'; " +
  "run it overnight hands-free; is this safe to ship?; have both claude and codex review it; do it\n</task-notification>";
const PHRASE_HOOKS = [
  "dangerous-phrase-warning.mjs",
  "codex-gauntlet-reminder.mjs",
  "agent-pair-review-reminder.mjs",
  "codex-to-claude-handoff-reminder.mjs",
  "ship-intent-reminder.mjs",
  "autopilot-intent-reminder.mjs",
  "hold-latch-prompt.mjs",
];
const tmpProj = mkdtempSync(path.join(tmpdir(), "crx-prompt-hooks-"));
for (const hook of PHRASE_HOOKS) {
  const r = spawnSync(process.execPath, [path.join(__dirname, hook)], {
    input: JSON.stringify({ prompt: MACHINE_PROMPT }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: tmpProj },
  });
  eq(r.status, 0, `${hook} exits 0 on machine prompt`);
  eq(r.stdout.trim(), "", `${hook} SILENT on machine prompt`);
}
// hold-latch-prompt must not have latched a hold from machine content
ok(!existsSync(path.join(tmpProj, ".claude", "session-state", "hold.json")), "machine prompt did not latch hold.json");
// autopilot-intent-reminder must not have written an overnight-intent flag
ok(!existsSync(path.join(tmpProj, ".claude", "session-state", "OVERNIGHT-INTENT.flag")), "machine prompt did not write OVERNIGHT-INTENT.flag");

// ── and they still FIRE on the same phrasing typed by Mason ──────────────
const typed = spawnSync(process.execPath, [path.join(__dirname, "ship-intent-reminder.mjs")], {
  input: JSON.stringify({ prompt: "build me the vendor page and ship it" }),
  encoding: "utf8",
  env: { ...process.env, CLAUDE_PROJECT_DIR: tmpProj },
});
ok(typed.stdout.includes("additionalContext"), "ship-intent still fires on typed intent");

rmSync(tmpProj, { recursive: true, force: true });
console.log(`prompt-hooks: ${pass} assertions passed`);
