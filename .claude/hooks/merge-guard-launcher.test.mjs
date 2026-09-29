#!/usr/bin/env node
// Tests for merge-guard-launcher.mjs: a merge guard that crashes, fails to load,
// exits abnormally, prints garbage or hangs must end in a DENIAL for anything that
// could merge, and in an allow for everything else; a guard that finishes
// normally must have its verdict forwarded unchanged.

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GUARD_BUDGET_MS,
  HARNESS_TIMEOUT_S,
  KILL_AFTER_MS,
  failureVerdict,
  guardPathAllowed,
  isVerdict,
  mayMerge,
  superviseGuard,
} from "./merge-guard-launcher.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER = path.join(__dirname, "merge-guard-launcher.mjs");
const REAL_GUARD = path.join(__dirname, "pr-merge-guard.mjs");
const ROOT = path.resolve(__dirname, "..", "..");

let pass = 0;
function ok(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  pass += 1;
}

const payload = (command) => JSON.stringify({ tool_name: "Bash", tool_input: { command } });
const MERGE = payload("gh pr merge 812 --squash --match-head-commit abc");
const PLAIN = payload("npm run build");
const DENY_JSON_FOR_VERDICT = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" } });
const decisionOf = (stdout) => {
  try { return JSON.parse(stdout).hookSpecificOutput; } catch { return null; }
};

// ── which calls count as "could merge" when the guard failed ─────────────────
for (const command of [
  "gh pr merge 812 --squash",
  "gh.cmd pr merge 812",
  "C:\\Tools\\gh.exe pr merge 812",
  "git merge origin/main",
  "curl -X PUT https://api.github.com/repos/o/r/pulls/9/merge",
  "gh api graphql -f query='mutation { x }'",
  "gh pr view 812",
]) {
  ok(mayMerge(payload(command)), `treated as a possible merge when the guard fails: ${command}`);
}
ok(mayMerge(JSON.stringify({ tool_name: "mcp__github__merge_pull_request", tool_input: { pullNumber: 9 } })),
  "the GitHub MCP merge tool is a possible merge");
ok(mayMerge("not json but says gh pr merge"), "unparseable input is judged on its raw text");
for (const command of ["npm run build", "git status --short", "ls -la", "node scripts/check-agent-guidance.mjs"]) {
  ok(!mayMerge(payload(command)), `ordinary work keeps running while the guard is broken: ${command}`);
}
ok(!mayMerge(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: "C:\\merge-fix\\gh" })),
  "only the tool call is judged, not the working directory around it");

// Parity with the working guard (Luna, 2026-09-28): every merge form the real
// guard denies without GitHub must also count as a possible merge here, so a
// broken guard is never weaker than a working one. Forms the guard cannot see
// (a merge decoded at run time) are allowed by the working guard too.
const realGuardDenies = (command) => {
  const res = spawnSync(process.execPath, [REAL_GUARD], { input: payload(command), encoding: "utf8", timeout: 30_000 });
  try { return JSON.parse(res.stdout).hookSpecificOutput?.permissionDecision === "deny"; } catch { return false; }
};
const guardForms = [
  "gh api graphql -f query='mutation { mergePullRequest(input: {}) }'",
  "curl -X PUT -H 'Authorization: token x' https://api.github.com/repos/o/r/pulls/12/merge",
  "Invoke-RestMethod -Method Put -Uri https://api.github.com/repos/o/r/pulls/12/merge",
  "curl https://api.github.com/graphql -d '{\"query\":\"mutation{mergePullRequest(input:{}){id}}\"}'",
  "gh pr merge 1 --body \"${SNEAKY}\"",
  "gh pr merge 5 --admin",
  "gh.cmd pr merge 625 --admin",
  "node -e \"require('child_process').execSync(Buffer.from('Z2ggcHIgbWVyZ2UgODEy','base64').toString())\"",
];
let deniedForms = 0;
for (const command of guardForms) {
  if (!realGuardDenies(command)) continue;
  deniedForms += 1;
  ok(mayMerge(payload(command)), `a form the working guard denies is a possible merge here too: ${command}`);
}
ok(deniedForms >= 7, `the parity sample reached the real guard's denials (${deniedForms} denied)`);

ok(isVerdict("") && isVerdict(DENY_JSON_FOR_VERDICT), "silence and a PreToolUse denial are verdicts");
ok(!isVerdict('{"error":"check failed"}'), "JSON without a decision is not a verdict (the harness would allow it)");
ok(!isVerdict(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", permissionDecision: "deny" } })),
  "a decision for the wrong event is not a verdict");
ok(!isVerdict(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "maybe" } })),
  "an unknown decision is not a verdict");

const failed = failureVerdict(MERGE, "exited with code 1");
ok(decisionOf(failed.stdout)?.permissionDecision === "deny", "a failed guard denies a merge");
ok(/did not finish \(exited with code 1\)/.test(decisionOf(failed.stdout)?.permissionDecisionReason || ""),
  "the denial says why the check did not finish");
const allowed = failureVerdict(PLAIN, "exited with code 1");
ok(allowed.stdout === "" && /cannot merge, so it is allowed/.test(allowed.stderr),
  "a failed guard allows a call that cannot merge, and says so on stderr");

// ── the supervisor, against guards that misbehave on purpose ─────────────────
const tmp = mkdtempSync(path.join(os.tmpdir(), "merge-guard-launcher-"));
const fake = (name, source) => {
  const file = path.join(tmp, name);
  writeFileSync(file, source);
  return file;
};
const DENY_JSON = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "fake guard says no" } });
// An allowing guard reports the launcher's token, as pr-merge-guard.mjs's passthrough() does.
const REPORTS_FINISHED = "writeSync(2, `merge-guard finished ${process.env.CRX_MERGE_GUARD_TOKEN}\\n`);";
const guards = {
  allow: fake("allow.mjs", `import { readFileSync, writeSync } from 'node:fs'; readFileSync(0); ${REPORTS_FINISHED} process.exit(0);\n`),
  silentAllow: fake("silent-allow.mjs", "import { readFileSync } from 'node:fs'; readFileSync(0); process.exit(0);\n"),
  empty: fake("empty.mjs", ""),
  wrongToken: fake("wrong-token.mjs", "process.stderr.write('merge-guard finished 0123456789abcdef\\n'); process.exit(0);\n"),
  deny: fake("deny.mjs", `import { readFileSync } from 'node:fs'; readFileSync(0); process.stdout.write(${JSON.stringify(DENY_JSON)}); process.exit(0);\n`),
  crash: fake("crash.mjs", "import { readFileSync } from 'node:fs'; readFileSync(0); throw new Error('boom from the fake guard');\n"),
  missingModule: fake("missing-module.mjs", "import './does-not-exist.mjs';\n"),
  exitThree: fake("exit-three.mjs", "process.exit(3);\n"),
  garbage: fake("garbage.mjs", "process.stdout.write('hello, not a verdict'); process.exit(0);\n"),
  noDecision: fake("no-decision.mjs", "process.stdout.write('{\"error\":\"check failed\"}'); process.exit(0);\n"),
  earlyExit: fake("early-exit.mjs", "process.exit(0);\n"),
  // A synchronous block, like the guard's execFileSync calls: the event loop is
  // stuck, so nothing inside the guard can react to time passing.
  hang: fake("hang.mjs", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);\n"),
};
const run = (guardPath, input, ms = 20_000) => superviseGuard({ guardPath, input, deadlineMs: Date.now() + ms });

let r = await run(guards.allow, MERGE);
ok(r.stdout === "", "a guard that allows and reports the token is forwarded as an allow");
ok(!/merge-guard finished/.test(r.stderr), "the token line is not passed on to the harness");
r = await run(guards.deny, MERGE);
ok(r.stdout === DENY_JSON, "a guard's own denial is forwarded unchanged");
r = await run(guards.deny, PLAIN);
ok(r.stdout === DENY_JSON, "a guard's verdict is forwarded whatever the call is");

for (const [name, reason] of [
  ["crash", /exited with code 1: .*boom from the fake guard/],
  ["missingModule", /exited with code 1/],
  ["exitThree", /exited with code 3/],
  ["garbage", /not a verdict/],
  ["noDecision", /not a verdict/],
  // Luna, 2026-09-28: an emptied or no-op guard file exits 0 silently.
  ["silentAllow", /without reporting that it finished/],
  ["empty", /without reporting that it finished/],
  ["wrongToken", /without reporting that it finished/],
]) {
  r = await run(guards[name], MERGE);
  ok(decisionOf(r.stdout)?.permissionDecision === "deny", `${name}: a merge is DENIED when the guard fails`);
  ok(reason.test(decisionOf(r.stdout)?.permissionDecisionReason || ""), `${name}: the denial names the failure`);
  r = await run(guards[name], PLAIN);
  ok(r.stdout === "", `${name}: a call that cannot merge is still allowed`);
}

r = await run(guards.earlyExit, "x".repeat(4 * 1024 * 1024));
ok(r.stdout === "", "a guard that exits before reading a large input does not crash the launcher");

let started = Date.now();
r = await run(guards.hang, MERGE, 1_500);
let elapsed = Date.now() - started;
ok(decisionOf(r.stdout)?.permissionDecision === "deny", "a HANGING guard: the merge is denied at the deadline");
ok(/still running at the launcher's deadline/.test(decisionOf(r.stdout)?.permissionDecisionReason || ""),
  "the denial says the guard ran out of time");
ok(elapsed >= 1_400 && elapsed < 5_000, `the launcher answers at its deadline, not the guard's (${elapsed}ms)`);
r = await run(guards.hang, PLAIN, 1_000);
ok(r.stdout === "", "a hanging guard does not block a call that cannot merge");

r = await run(path.join(tmp, "no-such-guard.mjs"), MERGE);
ok(decisionOf(r.stdout)?.permissionDecision === "deny", "a guard file that does not exist denies a merge");

// ── only a guard file next to the launcher may be launched ───────────────────
ok(guardPathAllowed(REAL_GUARD), "pr-merge-guard.mjs next to the launcher is accepted");
ok(!guardPathAllowed(LAUNCHER), "the launcher does not launch itself");
ok(!guardPathAllowed(guards.allow), "a file outside the hooks directory is refused");
ok(!guardPathAllowed(path.join(__dirname, "no-such-guard.mjs")), "a missing file is refused");
ok(!guardPathAllowed(""), "an empty path is refused");

// The real guard reports the token when it allows. A plain command is allowed
// either way, so check that the launcher saw a FINISHED guard, not a failure.
r = await run(REAL_GUARD, PLAIN);
ok(r.stdout === "" && !/did not finish/.test(r.stderr), "the real guard reports that it finished when it allows");

// ── end to end: the real launcher process ────────────────────────────────────
const launch = (launcher, guardArg, input) => spawnSync(process.execPath, [launcher, guardArg], {
  input, encoding: "utf8", timeout: 60_000,
});
let res = launch(LAUNCHER, REAL_GUARD, PLAIN);
ok(res.status === 0 && res.stdout === "", "real launcher + real guard: an ordinary command passes silently");
res = launch(LAUNCHER, REAL_GUARD, payload("gh api graphql -f query='mutation { mergePullRequest(input: {}) }'"));
ok(decisionOf(res.stdout)?.permissionDecision === "deny" && /mergePullRequest/.test(decisionOf(res.stdout)?.permissionDecisionReason || ""),
  "real launcher + real guard: the guard's own GraphQL-merge denial comes through");
res = launch(LAUNCHER, path.join(__dirname, "no-such-guard.mjs"), MERGE);
ok(decisionOf(res.stdout)?.permissionDecision === "deny", "real launcher, missing guard: a merge is denied");
res = launch(LAUNCHER, path.join(__dirname, "no-such-guard.mjs"), PLAIN);
ok(res.status === 0 && res.stdout === "", "real launcher, missing guard: ordinary work continues");
res = launch(LAUNCHER, guards.allow, MERGE);
ok(decisionOf(res.stdout)?.permissionDecision === "deny", "real launcher refuses a guard outside its own directory");

// The deadline path through main(): a copy of the launcher with a short deadline,
// next to a hanging guard. Only the one timing constant differs from the real file.
const source = readFileSync(LAUNCHER, "utf8");
ok(/export const KILL_AFTER_MS = 36_000;/.test(source), "the launcher's deadline constant is where the copy expects it");
const shortLauncher = path.join(tmp, "merge-guard-launcher.mjs");
writeFileSync(shortLauncher, source.replace("export const KILL_AFTER_MS = 36_000;", "export const KILL_AFTER_MS = 2_000;"));
started = Date.now();
res = launch(shortLauncher, guards.hang, MERGE);
elapsed = Date.now() - started;
ok(decisionOf(res.stdout)?.permissionDecision === "deny", "end to end: a hanging guard's merge is denied at the deadline");
ok(elapsed < 10_000, `end to end: the launcher answered in ${elapsed}ms, long before the guard would have`);
copyFileSync(guards.crash, path.join(tmp, "crash-guard.mjs"));
res = launch(shortLauncher, path.join(tmp, "crash-guard.mjs"), MERGE);
ok(decisionOf(res.stdout)?.permissionDecision === "deny", "end to end: a crashing guard's merge is denied");

// A tool call that cannot be read is unknown, so it is treated as a possible
// merge (Luna, 2026-09-28): here the input never finishes arriving.
ok(decisionOf(failureVerdict(null, "unreadable").stdout)?.permissionDecision === "deny",
  "an unreadable tool call is denied, whatever it was");
const unread = await new Promise((resolve) => {
  const child = spawn(process.execPath, [shortLauncher, guards.allow], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stdin.write('{"tool_name":"Bash","tool_input":{"command":"npm run build"');
  const kill = setTimeout(() => child.kill(), 15_000);
  child.on("close", () => { clearTimeout(kill); resolve(out); });
});
ok(decisionOf(unread)?.permissionDecision === "deny" && /had not finished arriving/.test(decisionOf(unread)?.permissionDecisionReason || ""),
  "end to end: input still open at the deadline is denied, even when it looks harmless");
ok(!/import\s*\{[^}]*\breadFileSync\b/.test(source), "the launcher reads its input as a stream, not readFileSync(0)");

// Input is capped rather than buffered without limit (Luna, 2026-09-28). A copy
// with a 1 KB cap stands in for the real 64 MB one.
ok(/const MAX_INPUT_BYTES = 64 \* 1024 \* 1024;/.test(source), "the input cap constant is where the copy expects it");
const cappedLauncher = path.join(tmp, "capped", "merge-guard-launcher.mjs");
mkdirSync(path.dirname(cappedLauncher));
writeFileSync(cappedLauncher, source.replace("const MAX_INPUT_BYTES = 64 * 1024 * 1024;", "const MAX_INPUT_BYTES = 1024;"));
copyFileSync(guards.allow, path.join(tmp, "capped", "allow.mjs"));
res = launch(cappedLauncher, path.join(tmp, "capped", "allow.mjs"), payload(`echo ${"x".repeat(4096)}`));
ok(decisionOf(res.stdout)?.permissionDecision === "deny" && /larger than 1024 bytes/.test(decisionOf(res.stdout)?.permissionDecisionReason || ""),
  "an oversized tool call is refused unread");
res = launch(cappedLauncher, path.join(tmp, "capped", "allow.mjs"), PLAIN);
ok(res.status === 0 && res.stdout === "", "a normal-sized call still passes under the cap");

// ── wiring and timing ───────────────────────────────────────────────────────
const settings = JSON.parse(readFileSync(path.join(ROOT, ".claude", "settings.json"), "utf8"));
const commands = (settings.hooks?.PreToolUse || []).flatMap((group) =>
  (group.hooks || []).map((hook) => ({ matcher: group.matcher, command: String(hook.command || ""), timeout: hook.timeout })));
const mergeWiring = commands.filter((hook) => hook.command.includes("pr-merge-guard.mjs"));
ok(mergeWiring.length === 1, "the merge guard is wired exactly once");
ok(/merge-guard-launcher\.mjs["']?\s+["']?[^"']*pr-merge-guard\.mjs/.test(mergeWiring[0]?.command || ""),
  "the merge guard runs THROUGH the launcher, never directly");
ok(mergeWiring[0]?.timeout === HARNESS_TIMEOUT_S, `the hook entry's timeout is ${HARNESS_TIMEOUT_S}s, matching the launcher`);
ok(/Bash/.test(mergeWiring[0]?.matcher || "") && /mcp__/.test(mergeWiring[0]?.matcher || ""),
  "the launcher sees shell and MCP calls, like the guard did");
// If node cannot start the launcher, the shell fallback denies (Luna, 2026-09-28).
const fallback = (mergeWiring[0]?.command || "").match(/\|\|\s*printf '%s' '([^']+)'\s*$/);
ok(fallback, "the hook entry ends with a shell fallback that prints a verdict");
ok(isVerdict(fallback?.[1] || "") && decisionOf(fallback?.[1] || "")?.permissionDecision === "deny",
  "the fallback's verdict is a real PreToolUse denial");
const bashProbe = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" });
if (bashProbe.status === 0 && bashProbe.stdout.trim() === "ok") {
  // PATH is emptied INSIDE the shell: Windows finds bash itself on the child's PATH.
  const noNode = spawnSync("bash", ["-c", `PATH=/nonexistent-crx-path; ${mergeWiring[0].command}`], {
    input: PLAIN, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT.replace(/\\/g, "/") },
  });
  ok(decisionOf(noNode.stdout)?.permissionDecision === "deny", "the wired command with no node on PATH denies");
  const withNode = spawnSync("bash", ["-c", mergeWiring[0].command], {
    input: PLAIN, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT.replace(/\\/g, "/") },
  });
  ok(withNode.status === 0 && withNode.stdout === "", "the wired command with node allows an ordinary call and never reaches the fallback");
} else {
  console.log("merge-guard-launcher: bash unavailable, wired-command fallback run skipped");
}
ok(mayMerge(JSON.stringify({ tool_name: "Bash", command: "gh pr merge 812" })),
  "a call with no tool_input object is judged on its whole text");

const guardSource = readFileSync(REAL_GUARD, "utf8");
const budget = guardSource.match(/const HOOK_TIMEOUT_MS = ([\d_]+);/);
ok(budget && Number(budget[1].replace(/_/g, "")) === GUARD_BUDGET_MS, "the guard's own budget matches what the launcher assumes");
ok(KILL_AFTER_MS > GUARD_BUDGET_MS, "the launcher waits longer than the guard's own budget, so a slow-but-working guard still answers");
ok(HARNESS_TIMEOUT_S * 1000 - KILL_AFTER_MS >= 5_000, "the launcher answers at least 5s before the harness would kill it");
ok(!/from\s+["'](?!node:)/.test(source) && !/import\s*\(/.test(source),
  "the launcher imports only node built-ins, so a broken library cannot silence it");

rmSync(tmp, { recursive: true, force: true });
console.log(`merge-guard-launcher: ${pass} assertions passed`);
