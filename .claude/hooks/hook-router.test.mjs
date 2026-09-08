#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promptModulesFor } from "./prompt-router.mjs";
import { postToolModulesFor } from "./posttool-router.mjs";
import { dedupeContextBlocks } from "./hook-router-runtime.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PROMPT = path.join(ROOT, ".claude", "hooks", "prompt-router.mjs");
const POST = path.join(ROOT, ".claude", "hooks", "posttool-router.mjs");
let pass = 0;
const ok = (condition, message) => { assert.ok(condition, message); pass++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); pass++; };

function run(script, payload, { surface = "claude", projectDir } = {}) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir || ROOT };
  if (surface === "codex") env.CRX_AGENT_SURFACE = "codex";
  else delete env.CRX_AGENT_SURFACE;
  const result = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    env,
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  eq(result.status, 0, `${path.basename(script)} exits zero: ${result.stderr}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

const promptCases = [
  ["drop this migration", "DELETE/DROP MIGRATION"],
  ["review this code", "Codex Review Gauntlet"],
  ["have claude and codex review this code", "Agent Pair Review"],
  ["ask claude to review the codex work", "Codex-to-Claude Handoff/Review"],
  ["implement this fix", "Ship-It reminder"],
];
for (const [prompt, marker] of promptCases) {
  const output = run(PROMPT, { prompt });
  ok(output?.hookSpecificOutput?.additionalContext.includes(marker), `prompt router preserves ${marker}`);
}

// The landing policy is embedded by BOTH the gauntlet and the ship-intent
// reminders; one prompt that trips both must carry it once (2026-09-04).
{
  const both = run(PROMPT, { prompt: "review this code, then ship it" });
  const context = both?.hookSpecificOutput?.additionalContext || "";
  ok(context.includes("Codex Review Gauntlet") && context.includes("Ship-It reminder"), "one prompt trips both reminders");
  eq((context.match(/LANDING POLICY: Mason authorized/g) || []).length, 1, "the full landing policy appears exactly once");
  ok(context.includes("LANDING POLICY: as stated above (unchanged)."), "the second reminder points at the policy instead of repeating it");
  const shipOnly = run(PROMPT, { prompt: "implement this fix" });
  eq((shipOnly?.hookSpecificOutput?.additionalContext.match(/LANDING POLICY: Mason authorized/g) || []).length, 1, "a single reminder still carries the full policy");
  ok(!shipOnly?.hookSpecificOutput?.additionalContext.includes("as stated above"), "nothing is replaced when the policy appears once");
  // Pure helper, mutation-pinned: only an exact whole-block repeat is replaced.
  eq(dedupeContextBlocks(["A\n\nPOLICY\n\nB", "C\n\nPOLICY"], [{ text: "POLICY", replacement: "P2" }]), ["A\n\nPOLICY\n\nB", "C\n\nP2"], "second occurrence replaced, first kept");
  eq(dedupeContextBlocks(["POLICY-ish", "POLICY"], [{ text: "POLICY", replacement: "P2" }]), ["POLICY-ish", "P2"], "a superstring counts as carrying the block (exact substring match)");
  eq(dedupeContextBlocks(["A", "B"], [{ text: "POLICY", replacement: "P2" }]), ["A", "B"], "contexts without the block are untouched");
  eq(dedupeContextBlocks(["A\n\nPOLICY", "B\n\nPOLICY"], []), ["A\n\nPOLICY", "B\n\nPOLICY"], "no blocks configured → no rewriting");
  // A context in which nothing was replaced comes back byte-for-byte — leading
  // and trailing whitespace and runs of blank lines included (CodeRabbit review
  // of #613 at ebebfc34d: the first cut trimmed and collapsed every context).
  const untouched = "  lead\n\n\n\nmiddle\n\n\ntrail  \n";
  eq(dedupeContextBlocks([untouched], []), [untouched], "no blocks configured → whitespace preserved exactly");
  eq(dedupeContextBlocks([untouched], [{ text: "POLICY", replacement: "P2" }]), [untouched], "block configured but absent → whitespace preserved exactly");
  eq(dedupeContextBlocks([`${untouched}POLICY`], [{ text: "POLICY", replacement: "P2" }]), [`${untouched}POLICY`], "first occurrence kept → whitespace preserved exactly");
  // Only the rewritten context is normalised, and only after the replacement.
  eq(dedupeContextBlocks(["POLICY", `${untouched}POLICY\n\n\n`], [{ text: "POLICY", replacement: "P2" }]), ["POLICY", "lead\n\nmiddle\n\ntrail  \nP2"], "the replaced context is trimmed and its blank-line runs collapsed");
}

const temp = mkdtempSync(path.join(os.tmpdir(), "crx-hook-router-"));
try {
  let output = run(PROMPT, { prompt: "pause now" }, { projectDir: temp });
  ok(output?.hookSpecificOutput?.additionalContext.includes("HOLD LATCHED"), "hold rule remains stateful and visible");
  ok(existsSync(path.join(temp, ".claude", "session-state", "hold.json")), "hold router writes the original latch");

  // `overnight` REMINDS but never LATCHES (Mason, 2026-09-02, after five review
  // rounds on PR #565 — the narrowed pattern kept freezing ordinary questions,
  // ending with `what is overnight?`). The reminder half is the part that still
  // matters here: a genuine "run this overnight" is still told to arm autopilot.
  output = run(PROMPT, { prompt: "run this overnight" }, { projectDir: temp });
  ok(output?.hookSpecificOutput?.additionalContext.includes("autopilot reminder"), "Claude prompt router preserves autopilot reminder");
  ok(!existsSync(path.join(temp, ".claude", "session-state", "OVERNIGHT-INTENT.flag")), "the word overnight must NOT latch the intent flag");

  // ...but the router must still carry the latch for an unambiguous request, or
  // removing the word would have quietly disabled the handshake end to end.
  output = run(PROMPT, { prompt: "im going to bed, keep working" }, { projectDir: temp });
  ok(output?.hookSpecificOutput?.additionalContext.includes("autopilot reminder"), "Claude prompt router reminds on a real hands-free request");
  ok(existsSync(path.join(temp, ".claude", "session-state", "OVERNIGHT-INTENT.flag")), "Claude autopilot reminder preserves intent flag for a real request");

  output = run(PROMPT, { prompt: "run this overnight" }, { surface: "codex", projectDir: temp });
  eq(output, null, "Codex router does not acquire Claude-only autopilot behavior");

  output = run(PROMPT, { prompt: "<task-notification>review this code</task-notification>" }, { projectDir: temp });
  eq(output, null, "machine-generated prompt remains silent across the router");

  output = run(POST, {
    tool_name: "Edit",
    tool_input: { file_path: path.join(temp, "supabase", "migrations", "20260827000000_router.sql") },
  }, { projectDir: temp });
  eq(output?.decision, "block", "migration edit still returns the original blocking decision");
  ok(output?.reason.includes("MIGRATION SAFETY CHECK"), "migration edit reason is preserved");
  ok(existsSync(path.join(temp, ".claude", "session-state", "SESSION-HEARTBEAT")), "Claude PostToolUse router preserves heartbeat");

  const stateDir = path.join(temp, ".claude", "session-state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, "applied-migrations.json"), "{}\n");
  output = run(POST, {
    tool_name: "mcp__supabase__apply_migration",
    tool_input: { name: "router_contract", query: "CREATE TABLE router_contract (id bigint);" },
  }, { projectDir: temp });
  const context = output?.hookSpecificOutput?.additionalContext || "";
  ok(context.includes("REGISTRY FRESHNESS"), "apply path preserves registry invalidation");
  ok(context.includes("Applied-migration snapshot invalidated"), "apply path preserves snapshot invalidation");
  ok(existsSync(path.join(stateDir, "applied-source-ledger.json")), "apply path preserves source ledger recording");
  ok(!existsSync(path.join(stateDir, "applied-migrations.json")), "apply path removes the stale applied snapshot");

  rmSync(path.join(stateDir, "SESSION-HEARTBEAT"), { force: true });
  output = run(POST, { tool_name: "Read", tool_input: {} }, { surface: "codex", projectDir: temp });
  eq(output, null, "irrelevant Codex PostToolUse event stays silent");
  ok(!existsSync(path.join(stateDir, "SESSION-HEARTBEAT")), "Codex router does not acquire Claude worktree heartbeat behavior");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

eq(promptModulesFor("codex").length, 6, "Codex prompt router has six shared modules");
eq(promptModulesFor("claude").length, 7, "Claude prompt router adds exactly one Claude-only module");
eq(postToolModulesFor({ tool_name: "Edit" }, "claude"), ["./posttooluse-migration.mjs", "./eslint-autofix.mjs", "./session-heartbeat.mjs"], "write/edit path is explicit");
eq(postToolModulesFor({ tool_name: "mcp__supabase__apply_migration" }, "codex"), ["./registry-freshness.mjs", "./applied-snapshot-invalidate.mjs"], "Codex apply path is explicit");

const claude = JSON.parse(readFileSync(path.join(ROOT, ".claude", "settings.json"), "utf8"));
const codex = JSON.parse(readFileSync(path.join(ROOT, ".codex", "hooks.json"), "utf8"));
eq(claude.hooks.UserPromptSubmit[0].hooks.length, 1, "Claude prompt event launches one configured process");
eq(claude.hooks.PostToolUse[0].hooks.length, 1, "Claude post event launches one configured process");
eq(codex.hooks.UserPromptSubmit[0].hooks.length, 1, "Codex prompt event launches one configured adapter");
eq(codex.hooks.PostToolUse[0].hooks.length, 1, "Codex post event launches one configured adapter");

function matcherFor(manifest, needle) {
  return manifest.hooks.PreToolUse.find((group) => group.hooks.some((hook) => `${hook.command} ${hook.commandWindows || ""}`.includes(needle)))?.matcher;
}
function configuredHooksFor(manifest, toolName) {
  return manifest.hooks.PreToolUse
    .filter((group) => group.matcher === "*" || new RegExp(`^(?:${group.matcher})$`, "i").test(toolName))
    .flatMap((group) => group.hooks);
}
for (const hook of ["migration-apply-guard.mjs", "live-testdata-guard.mjs", "mcp-tool-guard.mjs"]) {
  eq(matcherFor(codex, hook), "mcp__.*", `${hook} is MCP-only on Codex`);
}
for (const [surface, manifest] of [["Claude", claude], ["Codex", codex]]) {
  ok(
    configuredHooksFor(manifest, "MultiEdit").some((hook) => `${hook.command} ${hook.commandWindows || ""}`.includes("actor-binding-check.mjs")),
    `${surface} MultiEdit path invokes the actor-binding guard`,
  );
}
eq(matcherFor(codex, "production-action-guard.mjs"), "*", "production guard remains reachable for native Write, Edit, and apply_patch calls");
for (const toolName of ["Write", "Edit", "apply_patch"]) {
  ok(
    configuredHooksFor(codex, toolName).some((hook) => `${hook.command} ${hook.commandWindows || ""}`.includes("production-action-guard.mjs")),
    `configured Codex ${toolName} path invokes the production guard`,
  );
}

console.log(`hook-router: ${pass} assertions passed`);
