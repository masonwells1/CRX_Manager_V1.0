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
import { isMachineGenerated, MACHINE_TAG_NAMES, PUSH_POLICY, authoredByMason, hasAuthoredText, withoutSubagentReports } from "./prompt-source-lib.mjs";
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

  // 6. #504b (2026-09-21): a peer's UNFINISHED markdown must not reach past the
  //    peer's own closing tag and eat the halt Mason typed underneath it.
  //    Each case below was verified RED against the pre-fix order (fences before
  //    envelopes) and GREEN after it; reverting authoredByMason() to
  //    stripFencedCode-first turns the first three red again.
  const FENCE = "```";
  ok(isHoldPhrase(authoredByMason(
    '<cross-session-message from="terra">look at this snippet\n' +
    `${FENCE}\nconst x = 1;\n</cross-session-message>\nstop, hold on everything`)),
    "an unterminated fence inside a peer envelope does not swallow Mason's stop");
  ok(isHoldPhrase(authoredByMason(
    `<cross-session-message from="terra">\n${FENCE}\n</cross-session-message>\nstop now`)),
    "a fence opened as the peer's last line does not swallow Mason's stop");
  ok(isHoldPhrase(authoredByMason(
    '<cross-session-message from="terra">see `const x = 1;</cross-session-message>\nstop now')),
    "an unterminated inline-code span inside a peer envelope does not swallow Mason's stop");

  // 7. Mason's halt typed BETWEEN two peer messages survives. This is the
  //    regression that the first attempted #504b fix introduced (candidate-
  //    boundary consensus): each closed envelope must be removed on its own, so
  //    a later envelope's closing tag can never end an earlier one.
  ok(isHoldPhrase(authoredByMason(
    PEER_BLOCK + "\nstop now\n" +
    '<cross-session-message from="luna">on it</cross-session-message>')),
    "Mason's stop between two peer envelopes still latches");
  ok(!hasAuthoredText(
    PEER_BLOCK + "\n" + '<cross-session-message from="luna">on it</cross-session-message>'),
    "two back-to-back peer envelopes leave no Mason-authored text");

  // 8. The case the ORIGINAL fences-first order existed for is still covered:
  //    Mason quoting a bare envelope OPEN tag inside a fence must not trip the
  //    unterminated-envelope rule and erase the rest of his own message.
  ok(isHoldPhrase(authoredByMason(
    `here is the envelope they send:\n\n${FENCE}\n<cross-session-message from="x">\n${FENCE}\n\nstop using that`)),
    "a fenced bare open tag does not swallow Mason's later stop");

  // 9. #504b follow-up (2026-09-24): a fence left dangling AFTER closed
  //    envelopes are removed must not swallow Mason's stop. Both cases lost the
  //    stop before stripFencedCode() gave unclosed fences' lines back; case (a)
  //    was also a regression against the fences-first order.
  //    (a) Mason's fenced open tag pairs with a real peer's close tag, leaving
  //        his fence's opener dangling.
  ok(isHoldPhrase(authoredByMason(
    `${FENCE}\n<cross-session-message from="x">\n${FENCE}\n` +
    '<cross-session-message from="terra">ok</cross-session-message>\nstop now')),
    "a fenced open tag followed by a real peer message does not swallow Mason's stop");
  //    (b) A peer writes a fake closing tag inside a fence, leaving the rest
  //        of its fence dangling after its envelope is cut short.
  ok(isHoldPhrase(authoredByMason(
    `<cross-session-message from="terra">${FENCE}\n</cross-session-message>\n${FENCE}\n` +
    "more peer</cross-session-message>\nstop now")),
    "a peer's fake close tag plus a fence does not swallow Mason's stop");
  //    An unterminated fence Mason pastes is read as his (fail-safe), while a
  //    CLOSED fence is still stripped exactly as before.
  ok(isHoldPhrase(authoredByMason(`look at this\n${FENCE}\nstop now`)),
    "an unterminated fence gives its lines back rather than dropping them");
  ok(!isHoldPhrase(authoredByMason(`${FENCE}\nstop now\n${FENCE}\nthoughts?`)),
    "a closed fence containing stop still does not latch");
  ok(!isHoldPhrase(authoredByMason(`${FENCE}\na\n~~~\nstop x\n~~~`)),
    "a closed inner fence inside an unclosed outer one is still stripped");

  // 10. #504b review (2026-09-24): an envelope tag Mason QUOTES in code must not
  //     pair with a real peer's closing tag and cut out the stop he typed
  //     between them. Envelopes-first alone lost every one of these (main kept
  //     them); authoredByMason() now keeps what either strip order keeps.
  const PEER_OK = '<cross-session-message from="terra">ok</cross-session-message>';
  ok(isHoldPhrase(authoredByMason(
    "the `<cross-session-message>` tag is odd. stop now\n" + PEER_OK)),
    "an inline-quoted open tag, then stop, then a peer message still latches");
  ok(isHoldPhrase(authoredByMason(
    `${FENCE}\n<cross-session-message from="x">\n${FENCE}\nstop now\n` + PEER_OK)),
    "a fenced open tag, then stop, then a peer message still latches");
  ok(isHoldPhrase(authoredByMason(
    `${FENCE}\n<cross-session-message>\n${FENCE}\nstop now\n${FENCE}\n</cross-session-message>\n${FENCE}`)),
    "stop between a fenced open tag and a fenced close tag still latches");
  ok(isHoldPhrase(authoredByMason(
    "`<task-notification id=1>` stop now <task-notification id=2>x</task-notification>")),
    "an inline-quoted machine tag, then stop, then a machine block still latches");
  //     The union must not let peer-only prompts latch or clear a hold.
  ok(!hasAuthoredText(`<cross-session-message from="terra">look\n${FENCE}\nconst x = 1;\n</cross-session-message>`),
    "a peer message with an unfinished fence leaves no Mason-authored text");
  ok(!hasAuthoredText('<cross-session-message from="terra">see `<cross-session-message>` ok</cross-session-message>'),
    "a peer message quoting its own tag inline leaves no Mason-authored text");
  //     2026-09-26 Codex review of #794: clearing is never easier than before
  //     #794, while the same prompt's halt detection is unchanged.
  const DANGLING = `<cross-session-message>before\n</cross-session-message>\n${FENCE}\nall peer text\n</cross-session-message>`;
  ok(!hasAuthoredText(DANGLING),
    "a peer's fake close tag then a dangling fence leaves no Mason-authored text");
  ok(isHoldPhrase(authoredByMason(
    `<cross-session-message>before\n</cross-session-message>\n${FENCE}\nstop now\n</cross-session-message>`)),
    "the same shape carrying stop still latches (fail-safe)");
  ok(hasAuthoredText(`<cross-session-message>peer\n</cross-session-message>\nok go ahead`),
    "Mason's plain text after a closed peer message still counts as his");
}

// ── PUSH_POLICY is the one canonical, non-contradictory statement ────────
ok(/autonomous-landing rule \(2026-09-26\)/.test(PUSH_POLICY), "policy names the authorization");
ok(/CodeRabbit APPROVED on the exact head/.test(PUSH_POLICY) && /exact-SHA Sol proof LAST/.test(PUSH_POLICY),
  "policy names both final reviews the rule depends on");
ok(/HARD GATES/.test(PUSH_POLICY), "policy names the hard gates");
// 2026-09-25: the injected policy once listed only three gates while AGENTS.md
// listed twelve. It must point at AGENTS.md and name every gate category.
ok(/AGENTS\.md › Safety and Protected Delivery/.test(PUSH_POLICY), "policy points at the canonical gate list");
for (const gate of ["force-push", "DESTRUCTIVE migration", "live-data change", "Edge Function", "out-of-band production change", "data deletion", "secrets", "authentication", "permissions", "billing", "domains", "ownership"]) {
  ok(PUSH_POLICY.includes(gate), `policy names the ${gate} gate`);
}
ok(/CodeRabbit/.test(PUSH_POLICY), "policy names the CodeRabbit landing step");
ok(/destructive migrations[^.]*refused for agents even then, armed or not/i.test(PUSH_POLICY), "policy states destructive migrations stay refused, armed or not");
ok(!/never pushes/i.test(PUSH_POLICY), "policy has no stale never-pushes text");
// 2026-07-14 branch protection: the constant MUST describe the PR landing path —
// this is the drift test the 2026-07-16 scaffolding review demanded, so the
// canonical wording can't silently fall behind AGENTS.md again.
ok(/branch → PR|PR →|pull request/i.test(PUSH_POLICY), "policy describes the PR landing path");
ok(/direct pushes to main are impossible/i.test(PUSH_POLICY), "policy states direct main pushes are impossible");
ok(!/no approval click/.test(PUSH_POLICY), "policy no longer claims click-free direct pushes");
// The armed-mode behaviour must be stated (2026-09-26: armed runs pass only the
// two landing shapes on to the gates; they no longer park them).
ok(/ARMED hands-free run passes only a plain branch push and a plain `gh pr merge <n>`/i.test(PUSH_POLICY),
  "policy states what armed runs let through");
ok(!/PARK for Mason's review/i.test(PUSH_POLICY), "policy no longer claims armed runs park every push and merge");

// ── no hook still carries the stale contradictory policy text ────────────
for (const f of readdirSync(__dirname)) {
  if (!f.endsWith(".mjs") || f.endsWith(".test.mjs")) continue;
  const src = readFileSync(path.join(__dirname, f), "utf8");
  ok(!/never pushes autonomously|Claude never pushes/i.test(src), `${f} carries no stale never-pushes policy`);
}

// ── the 2 wired phrase hooks are SILENT on a machine-generated prompt ────
const MACHINE_PROMPT =
  "<task-notification>\n<task-id>t1</task-id>\naudit found: FORCE PUSH risk; hooks block 'stop/pause'; " +
  "run it overnight hands-free; is this safe to ship?; have both claude and codex review it; do it\n</task-notification>";
const PHRASE_HOOKS = [
  "ship-intent-reminder.mjs",
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
    // 2026-09-24: a stop only ONE strip order keeps must still latch end to
    // end — the hook's "not Mason's turn" gate runs after the latch.
    ["Mason's stop after an inline-quoted open tag, before a peer block",
      "the `<cross-session-message>` tag is odd. stop now\n" + PEER_BLOCK, true],
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
  // 2026-09-24 review: a peer that merely QUOTES its own closing tag leaves
  // text in one strip order only; that must not count as Mason speaking.
  const PO = '<cross-session-message from="terra">';
  const PC = "</cross-session-message>";
  runPrompt(keepDir, PO + "the `" + PC + "` tag ends my turn, all good" + PC);
  ok(existsSync(holdOf(keepDir)), "a peer quoting its close tag inline does NOT clear Mason's hold");
  runPrompt(keepDir, PO + "envelope looks like:\n```\n" + PC + "\n```\nall good" + PC);
  ok(existsSync(holdOf(keepDir)), "a peer quoting its close tag in a fence does NOT clear Mason's hold");
  // 2026-09-26 Codex review of #794: a fake close tag then a dangling fence
  // gave the peer's tail back in both orders and cleared the hold; the
  // pre-#794 floor in hasAuthoredText keeps it.
  runPrompt(keepDir, PO + "before\n" + PC + "\n```\nall peer text\n" + PC);
  ok(existsSync(holdOf(keepDir)), "a peer's fake close tag then a dangling fence does NOT clear Mason's hold");
  runPrompt(keepDir, "ok go ahead and continue");
  ok(!existsSync(holdOf(keepDir)), "Mason's own next message still clears it");
  rmSync(keepDir, { recursive: true, force: true });
}

// ── 2026-09-25: a subagent's hand-back is not Mason's words ──────────────
// A background subagent's final report reached its parent wrapped in the
// preamble + <\~agent-message> envelope below. Nothing recognised it: a "stop"
// in the report latched hold.json, a quoted --no-verify fired the danger
// warning, and the ship / autopilot / gauntlet reminders fired too.
//
// REPORT_BODY carries a trigger for EVERY phrase hook. The control run below
// proves each hook fires on the body when it is not wrapped, so the silence
// that follows is the envelope being recognised, not a phrase that never matched.
{
  const REPORT_BODY =
    "[Subagent hand-back] The text below is the final report of a subagent.\n" +
    "  stop: the loop hit an error. Never commit with --no-verify or force push.\n" +
    "  I'm going to bed, keep working. Is this safe to ship? Build and fix it.\n" +
    "  Have both Claude and Codex review it; have Claude review the Codex work.";
  const PREAMBLE = "Another Claude session sent a message:\n";
  const wrap = (open, close) => `${PREAMBLE}${open}\n${REPORT_BODY}\n${close}`;
  const AGENT_TURN = wrap('<\\~agent-message from="a1b2c3">', "<\\~/agent-message>");
  const CLOSE = "<\\~/agent-message>";
  // Report bodies the 2026-09-25 review used to break plain tag pairing: the
  // report QUOTES the close tag (the likely shape when a subagent reviews these
  // guards). The harness indents every report line, so the quote is indented.
  const quoting = (quoted) => wrap('<\\~agent-message from="a1">',
    `  the envelope ends with ${quoted} and then\n  stop: going to bed, keep working, ship it, carry on\n${CLOSE}`);
  const SPELLINGS = [
    ["backslash-escaped (the incident)", AGENT_TURN],
    ["bare ~ sigil", wrap('<~agent-message from="a1">', "<~/agent-message>")],
    ["~ after the slash", wrap('<~agent-message from="a1">', "</~agent-message>")],
    ["no sigil", wrap('<agent-message from="a1">', "</agent-message>")],
    ["double backslash", wrap('<\\\\~agent-message from="a1">', "<\\\\~/agent-message>")],
    ["CRLF line endings", AGENT_TURN.replace(/\n/g, "\r\n")],
    ["truncated (no close tag)", `${PREAMBLE}<\\~agent-message from="a1">\n${REPORT_BODY}`],
    ["report quoting the close tag in backticks", quoting("`" + CLOSE + "`")],
    ["report quoting the close tag bare", quoting(CLOSE)],
    ["report quoting the close tag in a fence", wrap('<\\~agent-message from="a1">',
      "  like this:\n  ```\n  " + CLOSE + "\n  ```\n  stop: going to bed, keep working, ship it, carry on\n" + CLOSE)],
    ["report with an unclosed fence", wrap('<\\~agent-message from="a1">',
      "  ```\n  stop: going to bed, keep working, ship it\n" + CLOSE)],
    // Luna review (2026-09-26): shapes outside the strict column-zero layout.
    ["open tag on the preamble line, truncated",
      'Another Claude session sent a message: <\\~agent-message from="a1">\n[Subagent hand-back] x\n  all done, carry on; stop; I\'m going to bed, ship it'],
    ["indented open and close tags", `${PREAMBLE}  <\\~agent-message from="a1">\n${REPORT_BODY}\n  ${CLOSE}`],
  ];

  // Unit level: the report leaves nothing of Mason's behind. A TRUNCATED report
  // (no close tag) is the exception for the latch only: its end cannot be found,
  // so it is kept and its own "stop" latches — the fail-safe side (Sol review of
  // #826, 2026-09-29). It still clears nothing and fires no reminder.
  for (const [label, turn] of SPELLINGS) {
    ok(!isMachineGenerated(turn), `${label}: stripped, not whole-prompt inert`);
    const truncated = /truncated/.test(label);
    eq(isHoldPhrase(authoredByMason(turn)), truncated,
      `${label}: report ${truncated ? "is kept for the latch (fail-safe)" : "does not latch"}`);
    ok(!hasAuthoredText(turn), `${label}: a bare report leaves no Mason-authored text`);
    eq(withoutSubagentReports(turn), "", `${label}: reminders see nothing`);
  }

  // Mason's own words beside the report are judged on their own.
  ok(isHoldPhrase(authoredByMason("stop now\n" + AGENT_TURN)), "Mason's stop above a report still latches");
  ok(isHoldPhrase(authoredByMason(AGENT_TURN + "\nhold on")), "Mason's hold on below a report still latches");
  ok(isHoldPhrase(authoredByMason("Another Claude session sent a message: stop")),
    "only the preamble phrase is removed, not what follows it on the line");
  ok(hasAuthoredText("thanks\n" + AGENT_TURN), "Mason's text beside a report counts as his");
  eq(withoutSubagentReports("thanks, run `git push --no-verify`\n" + AGENT_TURN),
    "thanks, run `git push --no-verify`",
    "reminders keep Mason's text, including his backticked command");
  // A truncated report ends at the next column-zero line, so what Mason typed
  // after it is still his — for the latch and for the reminders.
  const TRUNCATED = `${PREAMBLE}<\\~agent-message from="a1">\n${REPORT_BODY}`;
  ok(isHoldPhrase(authoredByMason(TRUNCATED + "\nok stop, do not continue")),
    "Mason's stop after a truncated report still latches");
  // Sol review of #826 (2026-09-29): an INDENTED stop Mason types under a
  // truncated report looks like report body. It must still latch. The body
  // here carries no hold phrase, so only his line can latch it.
  const QUIET_TRUNCATED = `${PREAMBLE}<\\~agent-message from="a1">\n[Subagent hand-back] x\n  all done, tests pass`;
  ok(!isHoldPhrase(QUIET_TRUNCATED), "setup: the quiet report body carries no hold phrase");
  ok(isHoldPhrase(authoredByMason(QUIET_TRUNCATED + "\n  stop now")),
    "Mason's indented stop under a truncated report still latches");
  ok(isHoldPhrase(authoredByMason(QUIET_TRUNCATED + "\n\thold on")),
    "Mason's tab-indented hold under a truncated report still latches");
  ok(!isHoldPhrase(authoredByMason(`${PREAMBLE}<\\~agent-message from="a1">\n[Subagent hand-back] x\n  all done\n${CLOSE}\n  `)),
    "a CLOSED quiet report is still stripped for the latch");
  ok(!hasAuthoredText(QUIET_TRUNCATED + "\n  carry on"),
    "a truncated report still cannot clear a hold");
  // Sol review of #826, second finding: words typed after the preamble's colon,
  // with a real framed report on the next line, must not be dropped with it.
  const QUIET_REPORT = `<\\~agent-message from="a1">\n[Subagent hand-back] x\n  all done\n${CLOSE}`;
  ok(isHoldPhrase(authoredByMason(`Another Claude session sent a message: stop now\n${QUIET_REPORT}`)),
    "Mason's stop after the preamble's colon, above a report, still latches");
  ok(/--force/.test(withoutSubagentReports(`Another Claude session sent a message: git push --force\n${QUIET_REPORT}`)),
    "a push --force after the preamble's colon, above a report, still reaches the danger warning");
  eq(withoutSubagentReports(`Another Claude session sent a message:\n${QUIET_REPORT}`), "",
    "a bare preamble line still starts a report");
  eq(withoutSubagentReports(TRUNCATED + "\nship it"), "ship it",
    "reminders see only Mason's line after a truncated report");
  ok(isHoldPhrase(authoredByMason(
    `${PREAMBLE}<\\~agent-message from="a1">\n  \`\`\`\n  unclosed fence in the report\n${CLOSE}\nstop now`)),
    "an unclosed fence inside a report does not swallow Mason's stop below it");

  // 2026-09-25 review: tags Mason MENTIONS are not reports. On the first cut
  // (plain tag pairing, unclosed = strip to end) every one of these lost the
  // halt; origin/main latched all of them.
  for (const mention of [
    "why did the <\\~agent-message> wrapper latch? stop and explain",
    "the <\\agent-message> thing is weird. pause for now",
    "check <agent-message-log> then stop",
    'look at this: <\\~agent-message from="x"> [Subagent hand-back] all done\nok stop, do not continue',
    "the `<~agent-message>` tag is odd. stop now\n" + AGENT_TURN,
    '<\\~agent-message from="x">\nok stop, do not continue',
  ]) {
    ok(isHoldPhrase(authoredByMason(mention)), `a mentioned tag does not swallow Mason's halt: ${JSON.stringify(mention.slice(0, 50))}`);
  }
  // Luna review (2026-09-26, BLOCKER): a wrapper Mason types himself, without
  // the harness preamble, is his text — indented lines under it included.
  const TYPED_WRAPPER = '<agent-message from="example">\n  stop now; do not ship\n</agent-message>';
  ok(isHoldPhrase(authoredByMason(TYPED_WRAPPER)), "a wrapper with no preamble is Mason's: his stop latches");
  ok(withoutSubagentReports(TYPED_WRAPPER).includes("do not ship"), "...and the reminders read it");
  // A truncated report ends where Mason's own column-zero line starts, even when
  // a second, closed report follows — its close tag cannot claim his words.
  ok(isHoldPhrase(authoredByMason(
    `${PREAMBLE}<\\~agent-message from="a1">\n  first report, cut off\nstop now\n` + AGENT_TURN)),
    "Mason's stop between a truncated report and a closed one still latches");
  // Luna review round 2 (2026-09-26, BLOCKER): a truncated report, then Mason's
  // stop, then a close tag. It reads the same as a closed report with one
  // unindented line, so the two directions are split like the union /
  // intersection pair: the latch and the reminders keep the line (his stop
  // halts), and hasAuthoredText() drops it (a report can never clear a hold).
  const AMBIGUOUS = `${PREAMBLE}<\\~agent-message from="a1">\n[Subagent hand-back] x\n  report truncated\nstop now\n${CLOSE}`;
  ok(isHoldPhrase(authoredByMason(AMBIGUOUS)), "a stop before a later close tag still latches");
  eq(withoutSubagentReports(AMBIGUOUS), "stop now", "...and still reaches the reminders");
  const UNINDENTED = wrap('<\\~agent-message from="a1">', "  fine so far\nall good, carry on\n" + CLOSE);
  ok(!hasAuthoredText(UNINDENTED), "a closed report with an unindented line is not Mason speaking");
  // Luna review round 3 (2026-09-26).
  //  - An indented close tag ends a report whose open tag was indented, so an
  //    indented stop typed after it is not swallowed.
  ok(isHoldPhrase(authoredByMason(
    `${PREAMBLE}  <\\~agent-message from="a1">\n  [Subagent hand-back] x\n  report\n  ${CLOSE}\n  stop now`)),
    "an indented stop after an indented close tag still latches");
  //  - The open tag must be alone on its line: prose after it is Mason's.
  ok(isHoldPhrase(authoredByMason(
    "Another Claude session sent a message: <agent-message> stop now </agent-message>")),
    "a stop on the same line as an open tag still latches");
  //  - A truncated report with an unindented line cannot count as Mason
  //    speaking (strict mode runs to the next preamble), so it cannot clear a hold.
  ok(!hasAuthoredText(`${PREAMBLE}<\\~agent-message from="a1">\n[Subagent hand-back] x\nall done, carry on`),
    "a truncated report with an unindented line is not Mason speaking");
  // Luna review round 4 (2026-09-26): a preamble the report QUOTES (indented)
  // is not the start of a new message, so the rest of the report still cannot
  // count as Mason speaking — closed or truncated.
  const QUOTED_PRE = "  Another Claude session sent a message:\n  all done, carry on";
  ok(!hasAuthoredText(wrap('<\\~agent-message from="a1">', QUOTED_PRE + "\n" + CLOSE)),
    "a closed report quoting the preamble is not Mason speaking");
  ok(!hasAuthoredText(`${PREAMBLE}<\\~agent-message from="a1">\n[Subagent hand-back] x\nnot indented\n${QUOTED_PRE}`),
    "a truncated report quoting the preamble is not Mason speaking");
  // Luna review round 5 (2026-09-26).
  //  - Without the "[Subagent hand-back]" frame line it is not the harness
  //    shape, so the latch and reminders read it as Mason's...
  const NO_FRAME = 'Another Claude session sent a message: <agent-message from="example">\n  stop now\n</agent-message>';
  ok(isHoldPhrase(authoredByMason(NO_FRAME)), "a wrapper with no frame line is Mason's: his stop latches");
  //    ...while strict mode still refuses to let it count as him speaking.
  ok(!hasAuthoredText(PREAMBLE + '<agent-message from="x">\n  all good, carry on\n</agent-message>'),
    "a frameless report still cannot clear a hold");
  //  - Words after a stray column-zero preamble inside a report never count as
  //    Mason speaking; a peer envelope opening on the preamble line still pairs.
  ok(!hasAuthoredText(`${PREAMBLE}<\\~agent-message from="a1">\n[Subagent hand-back] x\n  report\n` +
    "Another Claude session sent a message: carry on"), "a stray preamble line cannot clear a hold");
  ok(!hasAuthoredText('Another Claude session sent a message: <cross-session-message from="x">all good</cross-session-message>'),
    "a peer envelope opening on the preamble line is still stripped");
  // Luna review round 6 (2026-09-26).
  //  - An INDENTED frame line under a column-zero open tag is not the harness
  //    shape, so it is Mason's text and his stop latches.
  ok(isHoldPhrase(authoredByMason(
    `${PREAMBLE}<agent-message from="x">\n  [Subagent hand-back] report\n  stop now\n</agent-message>`)),
    "an indented frame line is not the harness shape: Mason's stop latches");
  //  - Strict mode runs to the LAST close tag, so a close tag the report quotes
  //    unindented cannot expose the rest of it as Mason speaking.
  ok(!hasAuthoredText(wrap('<\\~agent-message from="a1">', `${CLOSE}\n  all good, carry on\n${CLOSE}`)),
    "a report quoting its close tag unindented still cannot clear a hold");
  // Luna review round 7 (2026-09-26): strict mode now runs from a hand-back to
  // the end of the prompt, so no report layout can clear a hold.
  const R7 = `${PREAMBLE}<\\~agent-message from="a1">\n[Subagent hand-back] x\n`;
  ok(!hasAuthoredText(R7 + "Another Claude session sent a message:\n  carry on\n" + CLOSE),
    "a report with a column-zero preamble inside cannot clear a hold");
  ok(!hasAuthoredText(R7 + "  carry on\n" + CLOSE + "\n  continue"),
    "a truncated report quoting a close tag cannot clear a hold");
  // The accepted cost, pinned: Mason's words AFTER a hand-back cannot clear a
  // hold (his next message does), while words BEFORE it still count, and a
  // stop after it still latches.
  ok(!hasAuthoredText(AGENT_TURN + "\nok continue"), "ACCEPTED COST: words after a report do not count as speaking");
  ok(hasAuthoredText("ok continue\n" + AGENT_TURN), "words before a report still count as speaking");
  // ...and his risky words next to a mentioned tag still reach the reminders.
  ok(withoutSubagentReports("about the `<~agent-message>` tag: git push --force now, I'm going to bed\n" + AGENT_TURN)
    .includes("git push --force now"), "a backticked tag mention does not hide Mason's words from the reminders");

  // The preamble in front of a REAL cross-session message is the harness's
  // too. Before 2026-09-25 it counted as Mason's text, so a peer-only message
  // passed hasAuthoredText() and cleared his hold.
  ok(!hasAuthoredText(PREAMBLE + '<cross-session-message from="x">all good</cross-session-message>'),
    "preamble + peer message leaves no Mason-authored text");

  // End to end: the real hook processes.
  const stateOf = (dir, f) => path.join(dir, ".claude", "session-state", f);
  const run = (hook, dir, prompt) => spawnSync(process.execPath, [path.join(__dirname, hook)], {
    input: JSON.stringify({ prompt }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });

  // Control: the unwrapped body trips every phrase hook.
  for (const hook of PHRASE_HOOKS) {
    const dir = mkdtempSync(path.join(tmpdir(), "crx-agentmsg-ctl-"));
    const r = run(hook, dir, REPORT_BODY);
    ok(r.stdout.includes("additionalContext"), `control: ${hook} fires on the unwrapped report body`);
    rmSync(dir, { recursive: true, force: true });
  }

  // A bare agent-message turn: every hook silent, no hold, no freeze flag. A
  // TRUNCATED report used to latch the hold as a fail-safe (Sol review of #826);
  // since 2026-10-02 (Mason) a turn that opens with the harness preamble never
  // latches, because that fail-safe is what froze a session on a subagent report.
  // A truncated report WITHOUT the preamble keeps the fail-safe.
  for (const [label, turn] of SPELLINGS) {
    const dir = mkdtempSync(path.join(tmpdir(), "crx-agentmsg-"));
    const truncated = /truncated/.test(label) && !turn.trimStart().startsWith("Another Claude session sent a message:");
    for (const hook of PHRASE_HOOKS) {
      const r = run(hook, dir, turn);
      eq(r.status, 0, `${hook} exits 0 on a ${label} report`);
      if (truncated && hook === "hold-latch-prompt.mjs") continue;
      eq(r.stdout.trim(), "", `${hook} SILENT on a ${label} report`);
    }
    eq(existsSync(stateOf(dir, "hold.json")), truncated,
      `${label} report ${truncated ? "latched hold.json (fail-safe)" : "did not latch hold.json"}`);
    rmSync(dir, { recursive: true, force: true });
  }

  // Mason's words alongside a report still drive the hooks...
  {
    const dir = mkdtempSync(path.join(tmpdir(), "crx-agentmsg-mason-"));
    run("hold-latch-prompt.mjs", dir, "stop, let me read this first\n" + AGENT_TURN);
    ok(existsSync(stateOf(dir, "hold.json")), "Mason's stop beside a report latches the hold");
    ok(run("ship-intent-reminder.mjs", dir, "great, ship it\n" + AGENT_TURN).stdout.includes("additionalContext"),
      "Mason's ship it beside a report still fires ship-intent");
    // ...and ONLY his words: an innocuous line does not inherit the report's triggers.
    for (const hook of PHRASE_HOOKS.filter((h) => h !== "hold-latch-prompt.mjs")) {
      eq(run(hook, dir, "thanks, noted\n" + AGENT_TURN).stdout.trim(), "",
        `${hook} judges Mason's innocuous line alone, not the report beside it`);
    }
    rmSync(dir, { recursive: true, force: true });
  }

  // A report must not CLEAR a hold Mason latched, and neither may a real-shape
  // peer message (preamble included).
  {
    const dir = mkdtempSync(path.join(tmpdir(), "crx-agentmsg-keep-"));
    run("hold-latch-prompt.mjs", dir, "pause");
    ok(existsSync(stateOf(dir, "hold.json")), "setup: Mason's pause latched the hold");
    run("hold-latch-prompt.mjs", dir, AGENT_TURN.replace(/\bstop\b/g, "halted"));
    ok(existsSync(stateOf(dir, "hold.json")), "a subagent report does NOT clear Mason's hold");
    // 2026-09-25 review: under plain tag pairing, a report quoting the close
    // tag exposed its own "carry on" as Mason's text and released the hold.
    for (const [label, turn] of SPELLINGS.filter(([l]) => l.startsWith("report quoting"))) {
      run("hold-latch-prompt.mjs", dir, turn.replace(/\bstop\b/g, "halted"));
      ok(existsSync(stateOf(dir, "hold.json")), `a ${label} does NOT clear Mason's hold`);
    }
    run("hold-latch-prompt.mjs", dir,
      wrap('<\\~agent-message from="a1">', "  fine so far\nall good, carry on\n" + CLOSE));
    ok(existsSync(stateOf(dir, "hold.json")), "a closed report with an unindented line does NOT clear Mason's hold");
    run("hold-latch-prompt.mjs", dir, `${PREAMBLE}<\\~agent-message from="a1">\n[Subagent hand-back] x\nall done, carry on`);
    ok(existsSync(stateOf(dir, "hold.json")), "a truncated report with an unindented line does NOT clear Mason's hold");
    run("hold-latch-prompt.mjs", dir,
      PREAMBLE + '<cross-session-message from="x">all good, carry on</cross-session-message>');
    ok(existsSync(stateOf(dir, "hold.json")), "a peer message with its preamble does NOT clear Mason's hold");
    run("hold-latch-prompt.mjs", dir, "ok continue\n" + AGENT_TURN.replace(/\bstop\b/g, "halted"));
    ok(!existsSync(stateOf(dir, "hold.json")), "Mason's own reply beside a report still clears it");
    rmSync(dir, { recursive: true, force: true });
  }
}

// The hook must keep stripping at the source. Without this, a future edit could
// drop authoredByMason() and every assertion above would still pass through the
// lib while the live hook went back to matching the raw prompt.
ok(/authoredByMason\(payload\?\.prompt\)/.test(
  readFileSync(path.join(__dirname, "hold-latch-prompt.mjs"), "utf8")),
  "hold-latch-prompt matches on authoredByMason(prompt), not the raw prompt");
// ...and gates CLEARING on hasAuthoredText (both strip orders agree), placed
// after the latch so a halt only one order keeps is never dropped by the gate.
{
  const hookSrc = readFileSync(path.join(__dirname, "hold-latch-prompt.mjs"), "utf8");
  const gateAt = hookSrc.indexOf("if (isPeerTurn || !hasAuthoredText(payload?.prompt)) emit();");
  ok(gateAt > hookSrc.indexOf("if (isHoldPhrase(prompt))") && gateAt < hookSrc.indexOf("if (wasHeld())"),
    "hold-latch-prompt gates clearing on hasAuthoredText, after the latch and before the clear");
}

// ── and they still FIRE on the same phrasing typed by Mason ──────────────
const typed = spawnSync(process.execPath, [path.join(__dirname, "ship-intent-reminder.mjs")], {
  input: JSON.stringify({ prompt: "build me the vendor page and ship it" }),
  encoding: "utf8",
  env: { ...process.env, CLAUDE_PROJECT_DIR: tmpProj },
});
ok(typed.stdout.includes("additionalContext"), "ship-intent still fires on typed intent");

rmSync(tmpProj, { recursive: true, force: true });

// A peer/subagent turn (Codex review, PR #874): the report's own words never
// latch — closed OR truncated — but a stop Mason typed after a closed report
// does, and such a turn never clears a hold.
{
  const dir = mkdtempSync(path.join(tmpdir(), "crx-peer-turn-"));
  const holdFile = path.join(dir, ".claude", "session-state", "hold.json");
  // A crashed hook must fail here, not pass on hold state left by an earlier run.
  const runHold = (prompt) => {
    const r = spawnSync(process.execPath, [path.join(__dirname, "hold-latch-prompt.mjs")], {
      input: JSON.stringify({ prompt }), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    });
    eq(r.status, 0, `hold-latch-prompt exits 0: ${JSON.stringify(prompt.slice(0, 40))}`);
    return r;
  };
  const PRE = "Another Claude session sent a message:\n";
  const OPEN = '<agent-message from="a1">\n[Subagent hand-back] report\n';
  runHold(`${PRE}${OPEN}  the guard honors Mason's stop and pause latch\n  stop now, do not continue`);
  ok(!existsSync(holdFile), "a truncated report's own 'stop' does not latch on a peer turn");
  runHold(`${PRE}${OPEN}  all done\n</agent-message>\nstop now`);
  ok(existsSync(holdFile), "Mason's stop typed after a closed report on a peer turn latches the hold");
  runHold(`${PRE}${OPEN}  all done, carry on\n</agent-message>`);
  ok(existsSync(holdFile), "a peer turn never clears the hold");
  rmSync(dir, { recursive: true, force: true });
}

// A Codex scheduled automation opens with "Automation: <name>" + "Automation ID:".
// One latched the main checkout's hold on 2026-09-28 and left it stuck for days.
// It must neither latch nor clear the hold (Mason, 2026-10-02).
{
  const dir = mkdtempSync(path.join(tmpdir(), "crx-automation-"));
  const holdFile = path.join(dir, ".claude", "session-state", "hold.json");
  // A crashed hook must fail here, not pass on hold state left by an earlier run.
  const runHold = (prompt) => {
    const r = spawnSync(process.execPath, [path.join(__dirname, "hold-latch-prompt.mjs")], {
      input: JSON.stringify({ prompt }), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    });
    eq(r.status, 0, `hold-latch-prompt exits 0: ${JSON.stringify(prompt.slice(0, 40))}`);
    return r;
  };
  const AUTOMATION = "Automation: Codex Weekly Usage Coach\nAutomation ID: codex-weekly-usage-coach\nStop any run that is over budget and pause the report.";
  eq(runHold(AUTOMATION).stdout.trim(), "", "automation prompt is silent");
  ok(!existsSync(holdFile), "automation prompt does not latch the hold");
  runHold("pause");
  ok(existsSync(holdFile), "setup: Mason's pause latched the hold");
  runHold(AUTOMATION.replace(/Stop|pause/g, "skip"));
  ok(existsSync(holdFile), "automation prompt does not clear Mason's hold");
  rmSync(dir, { recursive: true, force: true });
}
console.log(`prompt-hooks: ${pass} assertions passed`);
