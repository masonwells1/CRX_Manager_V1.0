#!/usr/bin/env node
// PreToolUse launcher for pr-merge-guard.mjs: runs the merge guard as a CHILD
// process and denies anything that could merge a pull request when the guard
// does not finish its job.
//
// Why (Sol, 2026-09-27; Mason's "No prompt", 2026-09-28): `gh pr merge` sits in
// the `allow` tier, so the merge guard is the only local check that enforces the
// exact-SHA Sol proof before a merge. A PreToolUse hook that crashes, fails to
// load a module, or is killed at its timeout prints nothing, and a hook that
// prints nothing ALLOWS the tool call. The guard's own time budget
// (createHardGateBudget in codex-push-lib.mjs) bounds its network calls but
// cannot help when the process itself dies.
//
// This file imports only node built-ins, so a bug in the guard or in any library
// the guard loads cannot stop this launcher from answering. When the guard exits
// normally its verdict is forwarded unchanged. When it crashes, exits non-zero,
// prints something that is not a verdict, exits silently without reporting that
// it finished, or is still running at the launcher's deadline, or when the tool
// call itself cannot be read, a call that could merge is denied and every other
// call is allowed
// (@proven-by .claude/hooks/merge-guard-launcher.test.mjs).
//
// The launcher always exits 0. The hook entry in .claude/settings.json adds a
// shell fallback after it (`|| printf <denial>`), so if node cannot start the
// launcher at all, or the launcher dies before answering, every shell and MCP
// call is denied until that is fixed; file edits still work (Luna, 2026-09-28).

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LABEL = "PR MERGE GATE";

// Timing, measured from this launcher's process start. pr-merge-guard.mjs keeps
// its own 30-second budget (HOOK_TIMEOUT_MS minus a 3-second reserve), so it has
// said everything it will say about 27 seconds after it starts. The launcher stops
// waiting at 36 seconds, and the hook entry in .claude/settings.json allows 45,
// leaving the launcher about 9 seconds to answer, including the Windows launcher
// shell that process.uptime() cannot see. The test pins all three numbers.
export const GUARD_BUDGET_MS = 30_000;
export const KILL_AFTER_MS = 36_000;
export const HARNESS_TIMEOUT_S = 45;
const MAX_OUTPUT_BYTES = 1024 * 1024;
// A tool call larger than this is refused unread rather than buffered without
// limit (Luna, 2026-09-28); real Bash, PowerShell and MCP calls are far smaller.
const MAX_INPUT_BYTES = 64 * 1024 * 1024;

// Could this tool call merge a pull request? Deliberately broad and simple: it
// decides only what happens when the real guard FAILED, so it over-denies rather
// than parse. Ordinary work (npm, git status, file reads) keeps running while the
// guard is broken; anything naming a merge, the gh CLI, GitHub's API or GraphQL
// waits until the guard is fixed. Its reach matches the guard's own: the guard
// reads command TEXT, so a merge assembled at run time (decoded, or built from
// separate strings) passes the working guard too — the honest limit recorded in
// docs/reference/agent-guardrails.md. The test checks this list against every
// merge form the guard denies.
export function mayMerge(input) {
  let text = String(input || "");
  try {
    const payload = JSON.parse(text);
    // Only a well-formed call is narrowed to its name and input; anything else is
    // judged on its whole text (Luna, 2026-09-28).
    if (payload?.tool_input && typeof payload.tool_input === "object") {
      text = `${payload.tool_name || ""} ${JSON.stringify(payload.tool_input)}`;
    }
  } catch { /* unparseable: judge the raw text */ }
  return /merge|graphql|api\.github|\bgh(?:\.(?:exe|cmd|bat|ps1))?\b/i.test(text);
}

function denial(reason) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  });
}

// A guard that exited normally either says nothing (allow) or prints one
// PreToolUse decision. Any other output, including JSON without a decision
// (which the harness would treat as an allow), means it did not finish its job
// (Luna, 2026-09-28).
export function isVerdict(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return true;
  try {
    const decision = JSON.parse(text)?.hookSpecificOutput;
    return decision?.hookEventName === "PreToolUse" && ["allow", "deny", "ask"].includes(decision?.permissionDecision);
  } catch {
    return false;
  }
}

// What to print when the guard did not finish: a denial for anything that could
// merge, silence (allow) for everything else, and a note on stderr either way.
// `input` is null when the tool call itself could not be read; nothing is known
// about it, so it is treated as a possible merge (Luna, 2026-09-28).
export function failureVerdict(input, detail) {
  const note = `${LABEL}: the merge check did not finish (${detail}).`;
  if (input !== null && !mayMerge(input)) return { stdout: "", stderr: `${note} This call cannot merge, so it is allowed.\n` };
  return {
    stdout: denial(
      `${note} This call could merge a pull request, so it is denied (fail closed) — a check that ` +
      "stops mid-way says nothing, and saying nothing would allow the merge " +
      "(@proven-by .claude/hooks/merge-guard-launcher.test.mjs). Retry once; if it keeps happening, the " +
      "merge check itself needs fixing. Do not merge by another route.",
    ),
    stderr: "",
  };
}

// Is `guardPath` a guard file next to this launcher (and not the launcher)?
export function guardPathAllowed(guardPath, dir = HERE) {
  if (!guardPath || !guardPath.endsWith(".mjs") || !existsSync(guardPath)) return false;
  const relative = path.relative(dir, guardPath);
  return relative === path.basename(guardPath) && relative !== path.basename(fileURLToPath(import.meta.url));
}

// Run the guard with `input` on its stdin and resolve { stdout, stderr } for the
// launcher to print. Never rejects.
//
// Silence is the guard's allow, but an emptied or truncated guard file is silent
// too. So the guard gets a per-run token and must report it on stderr when it
// allows (pr-merge-guard.mjs passthrough()); silence without it is a failure.
export function superviseGuard({ guardPath, input, deadlineMs }) {
  return new Promise((resolve) => {
    const stdout = [];
    const stderr = [];
    const token = randomBytes(16).toString("hex");
    const finishedLine = `merge-guard finished ${token}`;
    let bytes = 0;
    let overflow = false;
    let settled = false;
    let child = null;
    let timer = null;
    const errText = () => Buffer.concat(stderr).toString("utf8");
    const finish = (failure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!failure) {
        const notes = errText().split(/\r?\n/).filter((line) => line.trim() !== finishedLine).join("\n");
        resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: notes.trim() ? `${notes.trimEnd()}\n` : "" });
        return;
      }
      // Node ends a crash report with its version line; the error itself is the
      // first line that names one.
      const lines = errText().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const lastError = lines.find((line) => /^\w*Error\b/.test(line)) ||
        lines.filter((line) => !/^Node\.js v/.test(line)).pop() || "";
      const detail = lastError ? `${failure}: ${lastError.slice(0, 300)}` : failure;
      const verdict = failureVerdict(input, detail);
      resolve({ stdout: verdict.stdout, stderr: `${errText()}${verdict.stderr}` });
    };
    const collect = (sink) => (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) overflow = true;
      else sink.push(chunk);
    };

    timer = setTimeout(() => {
      try { child?.kill(); } catch { /* already gone */ }
      finish("still running at the launcher's deadline");
    }, Math.max(0, deadlineMs - Date.now()));

    try {
      child = spawn(process.execPath, [guardPath], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, CRX_MERGE_GUARD_TOKEN: token },
      });
    } catch (error) {
      finish(`could not start: ${error?.message || error}`);
      return;
    }
    child.on("error", (error) => finish(`could not run: ${error?.message || error}`));
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("close", (code, signal) => {
      if (signal) return finish(`stopped by ${signal}`);
      if (code !== 0) return finish(`exited with code ${code}`);
      if (overflow) return finish("printed more than a verdict");
      const printed = Buffer.concat(stdout).toString("utf8");
      if (!isVerdict(printed)) return finish("printed something that is not a verdict");
      if (!printed.trim() && !errText().split(/\r?\n/).some((line) => line.trim() === finishedLine)) {
        return finish("exited silently without reporting that it finished");
      }
      return finish(null);
    });
    child.stdin.on("error", () => { /* the guard exited before reading its input; close reports it */ });
    child.stdin.end(input);
  });
}

// The tool call arrives on stdin. Read as a stream, not readFileSync(0), which
// can throw EAGAIN on a non-blocking pipe; a read error, or input still open at
// the deadline, rejects, and main() then treats the unread call as a possible merge.
function readInput(deadlineMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(
      () => reject(new Error("the tool call had not finished arriving at the launcher's deadline")),
      Math.max(0, deadlineMs - Date.now()),
    );
    process.stdin.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) {
        clearTimeout(timer);
        process.stdin.pause();
        reject(new Error(`the tool call is larger than ${MAX_INPUT_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on("end", () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString("utf8")); });
    process.stdin.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

async function main() {
  const startedAtMs = Date.now() - Math.round(process.uptime() * 1000);
  const deadlineMs = startedAtMs + KILL_AFTER_MS;
  let input = null;
  try {
    input = await readInput(deadlineMs);
    const guardPath = path.resolve(process.argv[2] || "");
    const result = guardPathAllowed(guardPath)
      ? await superviseGuard({ guardPath, input, deadlineMs })
      : failureVerdict(input, `no guard file next to the launcher at "${process.argv[2] || ""}"`);
    if (result.stderr) process.stderr.write(result.stderr);
    process.stdout.write(result.stdout, () => process.exit(0));
  } catch (error) {
    const verdict = failureVerdict(input, `the launcher failed: ${error?.message || error}`);
    if (verdict.stderr) process.stderr.write(verdict.stderr);
    process.stdout.write(verdict.stdout, () => process.exit(0));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main();
}
