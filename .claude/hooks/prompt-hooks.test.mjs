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
import { isMachineGenerated, MACHINE_TAG_NAMES, PUSH_POLICY, authoredByMason, hasAuthoredText } from "./prompt-source-lib.mjs";
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
// session is an agent choosing its words, and whether it may halt this session
// is Mason's call. If this ever flips, it must be a decision, not a drift.
ok(!isMachineGenerated('<cross-session-message from="codex">stop</cross-session-message>'), "cross-session-message deliberately NOT suppressed");
ok(!isMachineGenerated("build me the invoices page"), "normal build prompt not machine");
ok(!isMachineGenerated("we should stop and think about force pushing"), "risky words alone not machine");
ok(!isMachineGenerated("run it overnight and dont ask me"), "overnight phrasing alone not machine");
ok(!isMachineGenerated(""), "empty not machine");

// ── authoredByMason: the 2026-08-26 cross-session false-positive ─────────
// A peer session's <cross-session-message> saying "stand down ... no need to
// stop the other lane" latched the RECEIVER's hold; the quoted reply latched the
// SENDER's; then merely naming `stop-wrap.mjs` latched it again, because the
// filename contains "stop" between word boundaries. Two sessions spent multiple
// round-trips inventing substitute vocabulary just to discuss the guard.
//
// Every case below was verified RED against the pre-fix code (isHoldPhrase on
// the raw prompt returned true for the peer block, the blockquote report and the
// filename) — deleting authoredByMason from hold-latch-prompt.mjs, or the
// identifier lookarounds from HOLD_RE, turns them red again.
{
  const PEER_BLOCK =
    '<cross-session-message from="coordinator">stand down on the PR escalation path; ' +
    "no need to stop the other lane</cross-session-message>";

  // 1. Mason's own words are untouched — the regression guard for the whole change.
  ok(isHoldPhrase(authoredByMason("stop - do not push that")), "Mason typing stop still latches");
  ok(isHoldPhrase(authoredByMason("pause this loop")), "Mason typing pause still latches");
  ok(isHoldPhrase(authoredByMason("please stop.")), "a trailing period is not an extension");
  ok(isHoldPhrase(authoredByMason("hold on, dont build that yet")), "hold on still latches");
  ok(isHoldPhrase(authoredByMason("im just scoping a future session")), "scope-only still latches");
  ok(isHoldPhrase(authoredByMason("does stop/pause still work?")), "slash form keeps its vocabulary");

  // 2. A peer session's message is DATA — it cannot halt this session.
  ok(!isHoldPhrase(authoredByMason(PEER_BLOCK)), "peer cross-session message does not latch");
  ok(!hasAuthoredText(PEER_BLOCK), "a bare peer message leaves no Mason-authored text");
  ok(!isHoldPhrase(authoredByMason('<cross-session-message from="sol">pause the loop')),
    "an unterminated peer envelope is stripped to the end");

  // 3. Mason REPORTING a phrase (quoting it back) must not latch.
  ok(!isHoldPhrase(authoredByMason(
    "reporting what happened, quoting it:\n\n> stand down and stop the escalation\n\nwhat should we do?")),
    "a blockquoted phrase does not latch");
  ok(!isHoldPhrase(authoredByMason(
    "here is the message we got:\n\n```\nstop the other lane\n```\n\nthoughts?")),
    "a fenced code block does not latch");

  // 4. Naming the guard by filename must not latch — the escalation that made
  //    the two sessions unable to discuss the hook at all.
  ok(!isHoldPhrase(authoredByMason("take a look at .claude/hooks/stop-wrap.mjs and the stop-verify.mjs twin")),
    "naming stop-wrap.mjs does not latch");
  ok(!isHoldPhrase(authoredByMason("the culprit is `stop-wrap.mjs` I think")),
    "a backticked filename does not latch");
  ok(!isHoldPhrase(authoredByMason("the loop ran non-stop all night")), "non-stop is not a hold");

  // 5. Mason's words WIN when they share a message with a stripped block.
  ok(isHoldPhrase(authoredByMason("pause here.\n" + PEER_BLOCK)),
    "Mason's pause still latches alongside a peer block");
  ok(isHoldPhrase(authoredByMason(PEER_BLOCK + "\nstop what you are doing")),
    "Mason's stop after a peer block still latches");
  ok(isHoldPhrase(authoredByMason("stop.\n\n> quoting the peer here\n")),
    "Mason's stop still latches alongside a blockquote");

  // The negation guard added after "going to bed don't stop" is untouched.
  ok(!isHoldPhrase(authoredByMason("going to bed, don't stop")), "negated stop still not a hold");
  ok(!isHoldPhrase(authoredByMason("build me the invoices page")), "normal build still not a hold");
}

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

// ── 2026-09-02: naming autopilot must not FREEZE the session ─────────────
// autopilot-intent-reminder.mjs latches OVERNIGHT-INTENT.flag on a "strong"
// phrase, and unattended-autopilot.mjs then blocks Bash/Write/Edit for 45
// minutes. review-proof-guard.mjs refuses every command that would clear the
// flag (PR #548 confirmed there is deliberately no shell escape), so a false
// latch leaves arming autopilot as the only unblocked path — the exact failure
// the handshake exists to prevent.
//
// `/overnight/` was a bare topic word in that list. It froze a session twice in
// ten minutes: on a request to INVESTIGATE the flag, and on the approval to
// remove it. Both verbatim prompts are pinned below.
//
// The negative controls are what make this a guard rather than a deletion: put
// /overnight/ back and case 1 goes red; delete the `strong` list entirely and
// cases 2-4 go red. Neither mutation can pass both halves.
{
  const flagOf = (dir) => path.join(dir, ".claude", "session-state", "OVERNIGHT-INTENT.flag");
  const latches = (prompt) => {
    const dir = mkdtempSync(path.join(tmpdir(), "crx-intent-"));
    const r = spawnSync(process.execPath, [path.join(__dirname, "autopilot-intent-reminder.mjs")], {
      input: JSON.stringify({ prompt }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    });
    eq(r.status, 0, `autopilot-intent-reminder exits 0 on: ${prompt.slice(0, 40)}`);
    const latched = existsSync(flagOf(dir));
    const reminded = r.stdout.includes("autopilot-arm.mjs");
    rmSync(dir, { recursive: true, force: true });
    return { latched, reminded };
  };

  // 1. Mason NAMING the feature — the two verbatim prompts that froze the
  //    session on 2026-09-02. Must not latch, and must still remind: the topic
  //    is autopilot, so surfacing the arm instructions is still correct.
  for (const naming of [
    "yes fix codex folder , and i think the overnight flag is gettign worked on you might investigate",
    "yes drop the word overnight from the freeze list",
  ]) {
    const got = latches(naming);
    ok(!got.latched, `naming the feature must not FREEZE the session: "${naming.slice(0, 45)}..."`);
    ok(got.reminded, "...but the arm-autopilot reminder still fires");
  }

  // 2. Negative controls: Mason USING the feature must still latch. These are
  //    first-person/imperative phrases that cannot appear in a question ABOUT
  //    autopilot, which is the admission rule the `strong` list documents.
  for (const using of [
    "im going to bed, keep working",
    "run this hands-free until morning",
    "run it all night and dont stop",
    "keep going while im asleep",
  ]) {
    ok(latches(using).latched, `a real hands-free request must still latch: "${using}"`);
  }

  // 3. The word itself is not banned — it is split by grammar. Adverbial
  //    `overnight` (ending its phrase) is a real request and MUST still latch;
  //    hook-router.test.mjs pins the first of these end to end. Deleting the
  //    replacement pattern instead of narrowing it turns this block red, which
  //    is what stops "drop the word" being implemented as "drop the coverage".
  for (const adverbial of [
    "run this overnight",
    "keep going overnight, ill check in the morning",
    "run it overnight and dont ask me",
    "work on this overnight please",
  ]) {
    ok(latches(adverbial).latched, `adverbial overnight is a real request: "${adverbial}"`);
  }

  // 4. ...while `overnight` modifying a noun is naming a thing, and must not
  //    freeze. These are the shapes that appear in questions about the feature.
  for (const naming of [
    "why does the overnight flag keep firing",
    "explain the overnight handshake to me",
    "run the overnight bug hunt report past me first",
  ]) {
    ok(!latches(naming).latched, `overnight as a noun modifier must not freeze: "${naming}"`);
  }
}

// ── 2026-08-26: the REAL cross-session payloads, end to end ──────────────
// The unit assertions above prove the predicate; this runs the ACTUAL hook
// process against the verbatim shapes from the incident and checks the real
// hold.json on disk — latched, not latched, and (case 5) latched anyway
// because Mason's own word rode along in the same message.
{
  const PEER_BLOCK =
    '<cross-session-message from="coordinator">stand down on the PR escalation path; ' +
    "no need to stop the other lane</cross-session-message>";
  const holdOf = (dir) => path.join(dir, ".claude", "session-state", "hold.json");
  const runPrompt = (dir, prompt) =>
    spawnSync(process.execPath, [path.join(__dirname, "hold-latch-prompt.mjs")], {
      input: JSON.stringify({ prompt }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    });

  const XS = [
    // [label, prompt, must the hold be latched afterwards?]
    ["Mason typed stop", "stop - do not push that", true],
    ["peer cross-session block", PEER_BLOCK, false],
    ["Mason reporting a quoted phrase",
      "the hook fired on this, quoting it:\n\n> stand down and stop the escalation\n\nwhy?", false],
    ["a message naming the hook file",
      "take a look at .claude/hooks/stop-wrap.mjs — that is the one, right?", false],
    ["Mason's pause beside a peer block", "pause here.\n" + PEER_BLOCK, true],
  ];
  for (const [label, prompt, shouldLatch] of XS) {
    const dir = mkdtempSync(path.join(tmpdir(), "crx-xsession-"));
    const r = runPrompt(dir, prompt);
    eq(r.status, 0, `hold-latch-prompt exits 0: ${label}`);
    eq(existsSync(holdOf(dir)), shouldLatch,
      `${label} → hold ${shouldLatch ? "LATCHED" : "not latched"}`);
    rmSync(dir, { recursive: true, force: true });
  }

  // A peer message must not CLEAR a hold Mason latched either — only he speaks
  // for the latch, in both directions.
  const keepDir = mkdtempSync(path.join(tmpdir(), "crx-xsession-keep-"));
  runPrompt(keepDir, "stop everything");
  ok(existsSync(holdOf(keepDir)), "setup: Mason's stop latched the hold");
  runPrompt(keepDir, PEER_BLOCK);
  ok(existsSync(holdOf(keepDir)), "a peer message does NOT clear Mason's hold");
  runPrompt(keepDir, "ok go ahead and continue");
  ok(!existsSync(holdOf(keepDir)), "Mason's own next message still clears it");
  rmSync(keepDir, { recursive: true, force: true });
}

// The hook must keep stripping at the source. Without this, a future edit could
// drop authoredByMason() and every assertion above would still pass through the
// lib while the live hook went back to matching the raw prompt.
ok(/authoredByMason\(payload\?\.prompt\)/.test(
  readFileSync(path.join(__dirname, "hold-latch-prompt.mjs"), "utf8")),
  "hold-latch-prompt matches on authoredByMason(prompt), not the raw prompt");

// ── and they still FIRE on the same phrasing typed by Mason ──────────────
const typed = spawnSync(process.execPath, [path.join(__dirname, "ship-intent-reminder.mjs")], {
  input: JSON.stringify({ prompt: "build me the vendor page and ship it" }),
  encoding: "utf8",
  env: { ...process.env, CLAUDE_PROJECT_DIR: tmpProj },
});
ok(typed.stdout.includes("additionalContext"), "ship-intent still fires on typed intent");

rmSync(tmpProj, { recursive: true, force: true });
console.log(`prompt-hooks: ${pass} assertions passed`);
