#!/usr/bin/env node
// Tests for scripts/assemble-changelog.mjs.
//
// This script DELETES files, so its refusal paths are the ones that matter: a
// malformed or untracked fragment must be left on disk, never consumed. Each case
// runs the real script against a throwaway git repo.
//
// Run: node scripts/assemble-changelog.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, copyFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }

const roots = [];
function makeRepo(files, { track = [] } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "crx-asm-"));
  roots.push(root);
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "docs", "changelog.d"), { recursive: true });
  for (const f of ["assemble-changelog.mjs", "check-ledger-update.mjs"]) {
    copyFileSync(path.join(here, f), path.join(root, "scripts", f));
  }
  writeFileSync(path.join(root, "docs", "CHANGELOG.md"),
    "# Changelog\n\n## 2026-08-26 — existing newer\n\nbody\n", "utf8");
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(root, "docs", "changelog.d", name), body, "utf8");
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "scripts", "docs/CHANGELOG.md", ...track.map((t) => `docs/changelog.d/${t}`)], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: root });
  return root;
}
const run = (root) => spawnSync(process.execPath, ["scripts/assemble-changelog.mjs", "--write"],
  { cwd: root, encoding: "utf8" });
const stillThere = (root, n) => existsSync(path.join(root, "docs", "changelog.d", n));

// ── an untracked fragment is somebody else's draft: skip it, never consume it ──
{
  const root = makeRepo({
    "2026-08-25-good.md": "## 2026-08-25 — good\n\nbody\n",
    "2026-08-25-draft.md": "## 2026-08-25 — still typing\n\ndraft\n",
  }, { track: ["2026-08-25-good.md"] });
  const r = run(root);
  ok(/SKIPPING 1 untracked/.test(r.stderr), "an untracked fragment is reported as skipped");
  ok(stillThere(root, "2026-08-25-draft.md"), "the untracked draft is NOT deleted");
  ok(!stillThere(root, "2026-08-25-good.md"), "the tracked, valid fragment IS consumed");
}

// ── malformed fragments are refused and left on disk ──────────────────────────
{
  const files = {
    "2026-08-25-good.md": "## 2026-08-25 — good\n\nbody\n",
    "2026-08-25-empty.md": "",
    "2026-08-25-prose.md": "no heading at all\n",
    "2026-08-25-baddate.md": "## 2026-08-24 — mismatched\n\nbody\n",
  };
  const root = makeRepo(files, { track: Object.keys(files) });
  const r = run(root);
  ok(/REFUSING 3 malformed/.test(r.stderr), "all three malformed shapes are refused");
  for (const n of ["2026-08-25-empty.md", "2026-08-25-prose.md", "2026-08-25-baddate.md"]) {
    ok(stillThere(root, n), `${n} is left on disk, not consumed`);
  }
  ok(!stillThere(root, "2026-08-25-good.md"), "the valid fragment is still consumed alongside them");
}

// ── a late fragment lands by DATE, not at the top ──────────────────────────────
{
  const root = makeRepo({ "2026-08-25-late.md": "## 2026-08-25 — late\n\nbody\n" },
    { track: ["2026-08-25-late.md"] });
  run(root);
  const headings = readFileSync(path.join(root, "docs", "CHANGELOG.md"), "utf8")
    .split("\n").filter((l) => l.startsWith("## "));
  ok(/2026-08-26/.test(headings[0]) && /2026-08-25/.test(headings[1]),
    "an older fragment is inserted BELOW the newer existing section");
}

// ── nothing consumable is not a silent success ────────────────────────────────
{
  const root = makeRepo({ "2026-08-25-empty.md": "" }, { track: ["2026-08-25-empty.md"] });
  const r = run(root);
  ok(r.status !== 0, "a run where every fragment was refused exits non-zero");
  ok(stillThere(root, "2026-08-25-empty.md"), "and it deletes nothing");
}

for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } }
console.log(`assemble-changelog: ${pass} assertions passed`);
