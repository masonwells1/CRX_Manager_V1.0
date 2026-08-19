#!/usr/bin/env node
// Regression test for the --write repair path of scripts/sync-agent-workflows.mjs.
//
// Why this file exists: on 2026-08-19 the write path was "fixed" to normalize the
// target before comparing it, which is a no-op on the only case that matters. A
// CRLF mirror normalizes to the canonical LF form, so the write was skipped, the
// file stayed CRLF, and --write still printed "Synced". Two independent reviewers
// and a live proof against a CRLF *source* all missed it, because the source case
// and the mirror case fail differently. CodeRabbit caught it on PR #425.
//
// writeExpected() takes an explicit targetRoot so this runs against a temp
// directory and never touches the real .agents/** tree.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeExpected } from "./sync-agent-workflows.mjs";

const targetRoot = mkdtempSync(path.join(os.tmpdir(), "crx-sync-write-"));

try {
  // The two entries writeExpected() subtracts from its count (README + manifest)
  // are irrelevant here; any Map of relative-path -> content exercises the loop.
  const expected = new Map([
    ["skills/demo/SKILL.md", "line one\nline two\n"],
    ["README.md", "readme\n"],
    ["generated-manifest.json", '{"version":1,"managed":[]}\n'],
  ]);

  // A mirror smudged to CRLF must be repaired to LF. This is the assertion the
  // normalize-before-compare version silently failed.
  mkdirSync(path.join(targetRoot, "skills", "demo"), { recursive: true });
  const smudged = path.join(targetRoot, "skills", "demo", "SKILL.md");
  writeFileSync(smudged, "line one\r\nline two\r\n");
  assert.ok(readFileSync(smudged, "utf8").includes("\r\n"), "fixture must start out CRLF");

  writeExpected(expected, targetRoot);

  assert.equal(
    readFileSync(smudged, "utf8"),
    "line one\nline two\n",
    "--write must rewrite a CRLF mirror to LF, not skip it as already in sync",
  );

  // ...and it must be idempotent: a second run over an already-LF tree leaves the
  // bytes untouched. (Raw comparison is what keeps this true — the canonical form
  // equals the file byte for byte, so nothing is rewritten.)
  writeExpected(expected, targetRoot);
  assert.equal(readFileSync(smudged, "utf8"), "line one\nline two\n");

  // A source carrying CRLF must still land as LF in the mirror. This is the case
  // the original fix DID cover; keep it pinned so a future edit cannot trade one
  // half of the repair for the other.
  const crlfSource = new Map([
    ["skills/demo/SKILL.md", "alpha\r\nbeta\r\n"],
    ["README.md", "readme\n"],
    ["generated-manifest.json", '{"version":1,"managed":[]}\n'],
  ]);
  writeExpected(crlfSource, targetRoot);
  assert.equal(
    readFileSync(smudged, "utf8"),
    "alpha\nbeta\n",
    "a CRLF source must be normalized to LF on the way into the mirror",
  );

  // Real content drift is still written through, EOL handling notwithstanding.
  const changed = new Map([
    ["skills/demo/SKILL.md", "alpha\nCHANGED\n"],
    ["README.md", "readme\n"],
    ["generated-manifest.json", '{"version":1,"managed":[]}\n'],
  ]);
  writeExpected(changed, targetRoot);
  assert.equal(readFileSync(smudged, "utf8"), "alpha\nCHANGED\n");
} finally {
  rmSync(targetRoot, { recursive: true, force: true });
}

console.log("OK - sync-agent-workflows --write repairs CRLF mirrors.");
