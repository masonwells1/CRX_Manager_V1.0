#!/usr/bin/env node
// Regression tests for the Codex Review Gauntlet reminder hook.
// Spawns the real hook so it tests the shipped artifact, not a copy of the regex.
//
// SHOULD_FIRE  — plain-English review/ship/safety wording must inject the reminder.
// SHOULD_NOT_FIRE — farm/business decoys (and ordinary build/bug prompts) must stay silent.
// Cases are drawn from the phrasing corpora used to tune + validate the trigger; the decoys
// in particular lock in the precision fixes (good-to-go on a delivery, tank-mix, "ship the
// load", commission payouts, "create an rpc", "production ready to haul", etc.).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hookPath = path.join(__dirname, "codex-gauntlet-reminder.mjs");

function runHook(prompt) {
  return spawnSync(process.execPath, [hookPath], { input: JSON.stringify({ prompt }), encoding: "utf8" });
}
function fires(prompt) {
  const r = runHook(prompt);
  assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
  return r.stdout.trim().length > 0;
}

// Mason's canonical phrases + a spread that exercises each pattern group, including the
// curly-apostrophe variant and indirect/terse real-world wording.
const SHOULD_FIRE = [
  // Mason's six canonical prompts
  "Is this safe to ship?",
  "Review this before I push.",
  "Check Claude's work.",
  "Are we ready to merge?",
  "Run preflight.",
  "Double-check this change.",
  // curly/smart apostrophe must also work
  "Check Claude’s work.",
  // ship/push/merge/deploy readiness
  "is it good to push",
  "ok to ship this to prod?",
  "ready to merge?",
  "safe to deploy this yet?",
  "we good to push?",
  "is everything good to go before i merge",
  "is this good to go?",
  "good to go live with the partial order thing?",
  // review / check / second opinion
  "review the migration before it goes live",
  "can you sanity check the migration",
  "second set of eyes on this before i merge",
  "look this over before i push",
  "has this been reviewed yet",
  "did claude break anything?",
  // code anchors / novel phrasings
  "any bugs in this?",
  "is this production ready",
  "is the new commission rpc safe, dont want it paying wrong",
  "i'm nervous about this db change, can you vet it",
  "should i be worried about pushing this to croprxsolutions",
  "are the commission calcs still right after that refactor?",
  "can we deploy this without breaking customer statements?",
  "is this clean?",
  "u sure this works",
];

// Farm/business decoys + ordinary build/bug prompts that must NOT fire.
const SHOULD_NOT_FIRE = [
  "Please make the invoice table easier to scan.",
  "review the meeting notes from the agronomy call",
  "is roundup safe to spray on soybeans this week",
  "is it safe to tank-mix this adjuvant with the insecticide",
  "check the inventory count for the herbicide",
  "double check the math on this invoice",
  "merge these two duplicate invoices into one for the customer",
  "push the delivery date out a few days for farm beta",
  "deploy the second sprayer to the east quarter",
  "review this contract before i sign it",
  "vet this new supplier before i order from them",
  "is the herbicide delivery good to go for tomorrow?",
  "is the new applicator certified and good to go on routes",
  "is this delivery good to go?",
  "is this load good to go?",
  "check if that customer's credit is good before we ship the load",
  "sanity check these commission payouts before i cut the checks",
  "create an rpc to generate the sales report",
  "is this load production ready to haul out",
  "did the driver break anything on the truck",
  "did we break the lease terms with the landlord",
  "is everything okay with the orders coming in this week",
  "we ready to ship grain out of bin 3 this week",
  "the invoice total is showing wrong on the customer statement",
  "why is the deliveries page blank when i log in as a driver",
  "build me a report of overdue invoices",
  "whats the status of the partial draw-down feature",
];

let failures = 0;
for (const p of SHOULD_FIRE) {
  if (!fires(p)) { console.error(`FAIL (should fire): ${p}`); failures++; }
}
for (const p of SHOULD_NOT_FIRE) {
  if (fires(p)) { console.error(`FAIL (should NOT fire): ${p}`); failures++; }
}

// The reminder payload must be well-formed when it does fire.
{
  const out = JSON.parse(runHook("Is this safe to ship?").stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(out.hookSpecificOutput.additionalContext, /Codex Review Gauntlet/);
  assert.match(out.hookSpecificOutput.additionalContext, /per-change/i);
}

assert.equal(failures, 0, `${failures} trigger classification failure(s)`);
console.log(`OK — ${SHOULD_FIRE.length} fire + ${SHOULD_NOT_FIRE.length} no-fire cases passed.`);
