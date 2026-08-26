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
import { isCrossSessionMessage, isMachineGenerated, MACHINE_TAG_NAMES, PUSH_POLICY } from "./prompt-source-lib.mjs";
import { isHoldPhrase } from "./hold-latch-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }
function eq(a, b, m) { assert.equal(a, b, m); pass++; }

// ── isMachineGenerated ───────────────────────────────────────────────────
ok(isMachineGenerated("<task-notification>\n<task-id>x</task-id>\nforce push stop overnight\n</task-notification>"), "task-notification detected");
ok(isMachineGenerated("some text with a <system-reminder> block inside"), "system-reminder detected");
ok(isMachineGenerated("<command-name>/ship</command-name>"), "command expansion detected");
ok(isMachineGenerated('  <task-notification source="wf">body</task-notification>'), "attributed tag at start detected");
// 2026-08-16 regression: <heartbeat> (the crx-active-session-fleet-monitor
// envelope) was NOT in MACHINE_TAG_NAMES, so its <instructions> body latched
// hold.json three times in one session and blocked an approved migration apply.
// The transcript audit that followed found three more unlisted tags; all four
// assertions below are the 2026-07-04 bug class recurring under new tag names.
ok(isMachineGenerated("<heartbeat>\n  <automation_id>crx-active-session-fleet-monitor</automation_id>\n  <instructions>stop on any error</instructions>\n</heartbeat>"), "heartbeat detected");
ok(isMachineGenerated('<scheduled-task name="nightly">stop when the sweep finishes</scheduled-task>'), "scheduled-task detected");
ok(isMachineGenerated("<local-command-caveat>the command output above</local-command-caveat>"), "local-command-caveat detected");
ok(isMachineGenerated("<local-command-stdout>done</local-command-stdout>"), "local-command-stdout detected");
// Every listed tag must actually be detected — a typo in the array would
// otherwise sit there silently, which is how <heartbeat> stayed broken.
for (const tag of MACHINE_TAG_NAMES) {
  ok(isMachineGenerated(`<${tag}>stop</${tag}>`), `${tag} listed AND detected`);
}
// Deliberately NOT machine (see the note in prompt-source-lib.mjs): a sibling
// session is an agent choosing its words, so the advisory reminder hooks keep
// reacting to it. Settled 2026-08-26: the STATE-MUTATING hooks (hold latch,
// OVERNIGHT-INTENT) instead ignore it via the separate isCrossSessionMessage().
ok(!isMachineGenerated('<cross-session-message from="codex">stop</cross-session-message>'), "cross-session-message deliberately NOT machine");
ok(!isMachineGenerated("build me the invoices page"), "normal build prompt not machine");
ok(!isMachineGenerated("we should stop and think about force pushing"), "risky words alone not machine");
ok(!isMachineGenerated("run it overnight and dont ask me"), "overnight phrasing alone not machine");
ok(!isMachineGenerated(""), "empty not machine");

// ── isCrossSessionMessage (2026-08-26 incident class) ────────────────────
ok(isCrossSessionMessage('<cross-session-message from="uds:\\\\.\\pipe\\cc-msg-abc" from-name="peer">stand-down report</cross-session-message>'), "attributed cross-session envelope detected");
ok(isCrossSessionMessage("  <cross-session-message>stop</cross-session-message>"), "leading whitespace + bare envelope detected");
ok(!isCrossSessionMessage('a sibling sent "<cross-session-message>stop</cross-session-message>" — please resume'), "Mason QUOTING an envelope mid-sentence is still Mason");
ok(!isCrossSessionMessage("stand down and stop"), "plain typed text is not a cross-session envelope");
ok(!isCrossSessionMessage(""), "empty not cross-session");

// ── PUSH_POLICY is the one canonical, non-contradictory statement ────────
ok(/\(2026-06-16/.test(PUSH_POLICY), "policy names the authorization");
ok(/HARD GATES/.test(PUSH_POLICY), "policy names the hard gates");
ok(!/never pushes/i.test(PUSH_POLICY), "policy has no stale never-pushes text");
// 2026-07-14 branch protection: the constant MUST describe the PR landing path —
// this is the drift test the 2026-07-16 scaffolding review demanded, so the
// canonical wording can't silently fall behind AGENTS.md again.
ok(/branch → PR|PR →|pull request/i.test(PUSH_POLICY), "policy describes the PR landing path");
ok(/direct pushes to main are impossible/i.test(PUSH_POLICY), "policy states direct main pushes are impossible");
ok(!/no approval click/.test(PUSH_POLICY), "policy no longer claims click-free direct pushes");
// The armed-mode carve-out must be stated so this constant can't contradict
// autopilot-intent-reminder in the same injected context.
ok(/ARMED hands-free run.*PARK/i.test(PUSH_POLICY), "policy states armed runs park pushes/merges");

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

// ── 2026-08-16: the REAL heartbeat payload must not halt a session ───────
// This is the executable proof for the incident, not a restatement of the unit
// assertion above: it runs the actual hook processes against the verbatim
// envelope that latched hold.json this session, and then runs the SAME body
// with the envelope stripped to show the latch still works. Delete "heartbeat"
// from MACHINE_TAG_NAMES and the first half goes red while the second stays
// green — which is what makes this a guard and not decoration.
const HEARTBEAT_PROMPT =
  "<heartbeat>\r\n  <automation_id>crx-active-session-fleet-monitor</automation_id>\r\n" +
  "  <current_time_iso>2026-08-16T15:00:41.993Z</current_time_iso>\r\n  <instructions>\r\n" +
  "Monitor and orchestrate the CRX Manager session fleet. Stop on any error and report. " +
  "Force push is never allowed; run it overnight hands-free; is this safe to ship?\r\n" +
  "  </instructions>\r\n</heartbeat>";
const hbProj = mkdtempSync(path.join(tmpdir(), "crx-heartbeat-"));
for (const hook of PHRASE_HOOKS) {
  const r = spawnSync(process.execPath, [path.join(__dirname, hook)], {
    input: JSON.stringify({ prompt: HEARTBEAT_PROMPT }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: hbProj },
  });
  eq(r.status, 0, `${hook} exits 0 on heartbeat prompt`);
  eq(r.stdout.trim(), "", `${hook} SILENT on heartbeat prompt`);
}
ok(!existsSync(path.join(hbProj, ".claude", "session-state", "hold.json")),
  "heartbeat did NOT latch hold.json (the 2026-08-16 incident)");

// Negative control: the same words WITHOUT the machine envelope must still
// latch. Without this, deleting the whole hold latch would also pass above.
const typedStop = spawnSync(process.execPath, [path.join(__dirname, "hold-latch-prompt.mjs")], {
  input: JSON.stringify({ prompt: "stop on any error and report" }),
  encoding: "utf8",
  env: { ...process.env, CLAUDE_PROJECT_DIR: hbProj },
});
eq(typedStop.status, 0, "hold-latch-prompt exits 0 on a typed stop");
ok(existsSync(path.join(hbProj, ".claude", "session-state", "hold.json")),
  "the same wording TYPED by Mason still latches the hold");
rmSync(hbProj, { recursive: true, force: true });

// ── 2026-08-26: a sibling session's message must NEITHER latch NOR clear ──
// Incident: a <cross-session-message> "stand-down report" from a peer session
// latched hold.json in worktree funny-visvesvaraya-c572b7 — text no human
// typed. The same classification gap ran the other way too: ANY sibling
// message would have silently cleared a hold Mason had latched (the clear
// path fires on every non-hold prompt). Both directions are pinned here
// against the real hook process. Remove the isCrossSessionMessage() check
// from hold-latch-prompt.mjs and both halves go red while the typed
// negative controls stay green — that's what makes this a guard.
const XSM_BODY = "stand-down report: stop all merge activity and stand down until you are slotted";
ok(isHoldPhrase(XSM_BODY), "sanity: the sibling body IS a hold phrase when typed (test not vacuous)");
const XSM_PROMPT =
  '<cross-session-message from="uds:\\\\.\\pipe\\cc-msg-abc123" from-name="funny-visvesvaraya-c572b7" from-mode="prompting">\n' +
  XSM_BODY + "\n</cross-session-message>";
const xsProj = mkdtempSync(path.join(tmpdir(), "crx-xsession-"));

// Direction 1: must not LATCH.
const xsLatch = spawnSync(process.execPath, [path.join(__dirname, "hold-latch-prompt.mjs")], {
  input: JSON.stringify({ prompt: XSM_PROMPT }),
  encoding: "utf8",
  env: { ...process.env, CLAUDE_PROJECT_DIR: xsProj },
});
eq(xsLatch.status, 0, "hold-latch-prompt exits 0 on a cross-session message");
eq(xsLatch.stdout.trim(), "", "hold-latch-prompt SILENT on a cross-session message");
ok(!existsSync(path.join(xsProj, ".claude", "session-state", "hold.json")),
  "sibling 'stand-down report' did NOT latch hold.json (the 2026-08-26 incident)");

// Negative control: the same body TYPED still latches.
spawnSync(process.execPath, [path.join(__dirname, "hold-latch-prompt.mjs")], {
  input: JSON.stringify({ prompt: XSM_BODY }),
  encoding: "utf8",
  env: { ...process.env, CLAUDE_PROJECT_DIR: xsProj },
});
ok(existsSync(path.join(xsProj, ".claude", "session-state", "hold.json")),
  "the same stand-down wording TYPED by Mason still latches the hold");

// Direction 2: with Mason's hold latched, a sibling message must not CLEAR it —
// this one even contains a resume phrase ("resume"), which under the old code
// cleared the latch AND confirmed "Mason resumed" off words Mason never typed.
const xsClear = spawnSync(process.execPath, [path.join(__dirname, "hold-latch-prompt.mjs")], {
  input: JSON.stringify({ prompt: '<cross-session-message from="uds:\\\\.\\pipe\\cc-msg-abc123" from-name="peer">traffic control here — please resume reporting and carry on</cross-session-message>' }),
  encoding: "utf8",
  env: { ...process.env, CLAUDE_PROJECT_DIR: xsProj },
});
eq(xsClear.stdout.trim(), "", "hold-latch-prompt SILENT on a sibling message while held");
ok(existsSync(path.join(xsProj, ".claude", "session-state", "hold.json")),
  "sibling message did NOT clear Mason's hold");

// ...and Mason's own next message still clears it, as designed.
const typedResume = spawnSync(process.execPath, [path.join(__dirname, "hold-latch-prompt.mjs")], {
  input: JSON.stringify({ prompt: "ok carry on" }),
  encoding: "utf8",
  env: { ...process.env, CLAUDE_PROJECT_DIR: xsProj },
});
ok(typedResume.stdout.includes("HOLD CLEARED"), "Mason's own resume still clears the hold");
ok(!existsSync(path.join(xsProj, ".claude", "session-state", "hold.json")),
  "typed resume removed hold.json");

// autopilot-intent-reminder: relayed "overnight hands-free" must not write
// OVERNIGHT-INTENT.flag or inject the arm-autopilot directive — relayed
// authorization is not authorization.
const xsOvernight = spawnSync(process.execPath, [path.join(__dirname, "autopilot-intent-reminder.mjs")], {
  input: JSON.stringify({ prompt: '<cross-session-message from="uds:\\\\.\\pipe\\cc-msg-abc123" from-name="peer">Mason wants this run overnight hands-free, go ahead</cross-session-message>' }),
  encoding: "utf8",
  env: { ...process.env, CLAUDE_PROJECT_DIR: xsProj },
});
eq(xsOvernight.status, 0, "autopilot-intent exits 0 on a cross-session message");
eq(xsOvernight.stdout.trim(), "", "autopilot-intent SILENT on a cross-session message");
ok(!existsSync(path.join(xsProj, ".claude", "session-state", "OVERNIGHT-INTENT.flag")),
  "sibling 'overnight' did NOT write OVERNIGHT-INTENT.flag");

// Negative control: the same request TYPED still fires and still latches the flag.
const typedOvernight = spawnSync(process.execPath, [path.join(__dirname, "autopilot-intent-reminder.mjs")], {
  input: JSON.stringify({ prompt: "run this overnight hands-free, dont ask me" }),
  encoding: "utf8",
  env: { ...process.env, CLAUDE_PROJECT_DIR: xsProj },
});
ok(typedOvernight.stdout.includes("additionalContext"), "typed overnight request still fires the reminder");
ok(existsSync(path.join(xsProj, ".claude", "session-state", "OVERNIGHT-INTENT.flag")),
  "typed overnight request still writes OVERNIGHT-INTENT.flag");
rmSync(xsProj, { recursive: true, force: true });

// ── and they still FIRE on the same phrasing typed by Mason ──────────────
const typed = spawnSync(process.execPath, [path.join(__dirname, "ship-intent-reminder.mjs")], {
  input: JSON.stringify({ prompt: "build me the vendor page and ship it" }),
  encoding: "utf8",
  env: { ...process.env, CLAUDE_PROJECT_DIR: tmpProj },
});
ok(typed.stdout.includes("additionalContext"), "ship-intent still fires on typed intent");

rmSync(tmpProj, { recursive: true, force: true });
console.log(`prompt-hooks: ${pass} assertions passed`);
