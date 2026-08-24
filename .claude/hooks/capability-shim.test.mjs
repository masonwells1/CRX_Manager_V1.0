#!/usr/bin/env node
// Tests for the CAPABILITY-LAYER shims in .claude/shims/.
//
// These run REAL non-interactive bash with BASH_ENV pointed at the loader —
// the same way the Bash tool invokes commands. Nothing here inspects a command
// string; the whole point of this layer is that it acts AFTER the shell has
// rewritten the text, so every spelling that defeated
// .claude/hooks/codex-recursion-guard.mjs collapses to one PATH lookup.
//
// THE FAILURE MODE THIS FILE EXISTS FOR: if BASH_ENV points at a missing file,
// bash ignores it SILENTLY. The guard would then be uninstalled while looking
// installed — the exact "reports clean without having run" shape that caused the
// 2026-08-23 incident. A missing or unreachable shim must fail loudly here.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHIM_DIR = path.resolve(HOOK_DIR, "..", "shims");
const LOADER = path.join(SHIM_DIR, "bash-env.sh");
const BIN = path.join(SHIM_DIR, "bin");

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

// Assembled from pieces so this file does not trip the text guard when an agent
// greps or edits it through a shell.
const C = "c" + "odex";
const TK = "task" + "kill";
const KL = "ki" + "ll";

function runBash(command) {
  const r = spawnSync("bash", ["-c", command], {
    encoding: "utf8",
    env: { ...process.env, BASH_ENV: LOADER },
  });
  return {
    status: r.status,
    output: `${r.stdout || ""}${r.stderr || ""}`,
    refused: `${r.stdout || ""}${r.stderr || ""}`.includes("CAPABILITY SHIM"),
  };
}

// ── The layer is actually installed ──────────────────────────────────────────
check("the loader and every shim exist on disk", () => {
  assert.ok(existsSync(LOADER), `missing loader: ${LOADER}`);
  for (const name of [C, TK, "pkill", "killall", KL]) {
    assert.ok(existsSync(path.join(BIN, name)), `missing shim: ${name}`);
  }
});

check("the loader still disables the kill builtin", () => {
  // Without `enable -n`, the builtin wins and the shim is never reached — an
  // invisible uninstall. Pinned as text because the behavioural check below
  // cannot distinguish "builtin ran and did nothing" from "shim missing".
  assert.match(readFileSync(LOADER, "utf8"), /enable -n kill/);
});

// ── Spellings that defeated the text guard ───────────────────────────────────
check("every proven bypass spelling is refused at the capability layer", () => {
  const spellings = [
    [`${C} review --base origin/main`, "plain"],
    [`c"od"ex review --base origin/main`, "quotes inside the word"],
    [`${C}>/tmp/crx-shim-test.log review --base origin/main`, "redirect glued to the name"],
    [`command ${C} review --base origin/main`, "command builtin"],
    [`exec ${C} review --base origin/main`, "exec builtin"],
    [`timeout 90 ${C} review --base origin/main`, "launcher with a numeric argument"],
    [`${TK} /PID 999999 /T /F`, "the verbatim 2026-08-23 incident command"],
    [`ta"sk"${KL} /PID 999999 /F`, "quote-composed termination"],
    [`env X=1 p${KL} -9 nothing-real`, "env-prefixed termination"],
    [`${KL} 999999`, "bare kill, which is a shell builtin"],
  ];
  for (const [command, label] of spellings) {
    const r = runBash(command);
    assert.ok(r.refused, `NOT refused (${label}): ${command}\n${r.output}`);
    assert.equal(r.status, 9, `wrong exit for ${label}`);
  }
});

// ── What it must NOT break ───────────────────────────────────────────────────
check("codex exec still reaches the real binary", () => {
  // The sanctioned wrapper and every one-off prompt depend on this. A shim that
  // swallowed `exec` would break the proof path it exists to protect.
  const r = runBash(`${C} exec --help`);
  assert.equal(r.refused, false, `codex exec was refused:\n${r.output}`);
});

check("ordinary commands are untouched", () => {
  for (const command of ["git status --short", "npm --version", "node --version"]) {
    assert.equal(runBash(command).refused, false, `refused an ordinary command: ${command}`);
  }
});

check("PROSE is not blocked — the over-block the text guard could not avoid", () => {
  // This is the concrete gain over string matching. The text guard refuses these
  // because it cannot tell writing-about from running; the capability layer never
  // has to make that distinction, because nothing is executed.
  for (const command of [`grep -c ${TK} /dev/null`, `echo "never run ${C} review"`]) {
    assert.equal(runBash(command).refused, false, `over-blocked prose: ${command}`);
  }
});

// ── Stated limits, pinned so they are not mistaken for coverage ──────────────
check("KNOWN LIMIT: an absolute path bypasses PATH and therefore the shim", () => {
  // Not a defect to fix here — PATH is the mechanism. This is why
  // codex-recursion-guard.mjs stays: the two layers cover different halves, and
  // a future reader must not delete one believing the other is total.
  const r = runBash(`/usr/bin/${KL} -9 999999`);
  assert.equal(r.refused, false, "absolute-path behaviour changed — re-check the docs");
});

console.log(`\n${passed} checks passed.`);
