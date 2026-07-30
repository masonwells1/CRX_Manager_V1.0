#!/usr/bin/env node
// Tests for the agent-memory off-site snapshot (scripts/backup-claude-memory.mjs).
// Codex's fourth 2026-07-30 review asked for manifest and scan/copy-race coverage
// after finding that `verify()` passed a directory whose manifest was just `{}`.
// Run: node scripts/backup-claude-memory.test.mjs

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  INDEX_FILE,
  MANIFEST,
  SNAPSHOT_KIND,
  scanForSecrets,
  stage,
  verify,
} from "./backup-claude-memory.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "backup-claude-memory.mjs");
let pass = 0;
const ok = (condition, message) => { assert.ok(condition, message); pass += 1; };
const eq = (actual, expected, message) => { assert.equal(actual, expected, message); pass += 1; };

const root = mkdtempSync(path.join(os.tmpdir(), "backup-memory-test-"));
const fresh = (name) => { const dir = path.join(root, name); mkdirSync(dir, { recursive: true }); return dir; };
const quiet = (fn) => {
  // These functions report to the console by design; a passing suite should not
  // print their expected failure messages.
  const { log, error } = console;
  console.log = () => {}; console.error = () => {};
  try { return fn(); } finally { console.log = log; console.error = error; }
};
const readManifest = (dir) => JSON.parse(readFileSync(path.join(dir, MANIFEST), "utf8"));
const writeManifest = (dir, manifest) => writeFileSync(path.join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);

function makeSource(name, notes) {
  const dir = fresh(name);
  for (const [file, body] of Object.entries(notes)) writeFileSync(path.join(dir, file), body);
  return dir;
}

try {
  // ── happy path: stage then verify ─────────────────────────────────────────
  const source = makeSource("source", {
    [INDEX_FILE]: "# Memory Index\n- [a](a.md) — hook\n",
    "a.md": "---\nname: a\n---\n\nA note about a commission split.\n",
    "b.md": "---\nname: b\n---\n\nAnother note.\n",
  });
  const staged = path.join(root, "staged");
  eq(quiet(() => stage(staged, source)), 0, "staging a real memory dir succeeds");

  const manifest = readManifest(staged);
  eq(manifest.kind, SNAPSHOT_KIND, "manifest records the snapshot kind");
  eq(manifest.file_count, 3, "manifest counts every .md file");
  eq(manifest.files.length, manifest.file_count, "file_count matches the entry list");
  eq(
    manifest.total_bytes,
    manifest.files.reduce((sum, entry) => sum + entry.bytes, 0),
    "total_bytes is the sum of the entries",
  );
  eq(quiet(() => verify(staged)), 0, "a freshly staged snapshot verifies");

  // The bytes recorded in the manifest are the bytes on disk in the source —
  // this is the property the single-read change protects.
  for (const entry of manifest.files) {
    eq(
      readFileSync(path.join(staged, entry.name)).length,
      readFileSync(path.join(source, entry.name)).length,
      `staged copy is byte-identical in length: ${entry.name}`,
    );
  }

  // ── the round-4 finding: an empty/whatever manifest must NOT verify ───────
  {
    const bogus = fresh("bogus-empty-manifest");
    writeManifest(bogus, {});
    eq(quiet(() => verify(bogus)), 1, "a directory whose manifest is `{}` fails verification");
  }
  {
    const wrongKind = fresh("bogus-kind");
    writeManifest(wrongKind, { kind: "something-else", files: [], file_count: 0, total_bytes: 0 });
    eq(quiet(() => verify(wrongKind)), 1, "a manifest of the wrong kind fails verification");
  }
  {
    const emptyList = fresh("bogus-empty-list");
    writeManifest(emptyList, { kind: SNAPSHOT_KIND, files: [], file_count: 0, total_bytes: 0 });
    eq(quiet(() => verify(emptyList)), 1, "a snapshot listing zero files fails verification");
  }
  {
    // Every note present and hashed correctly, but MEMORY.md is not among them:
    // that is not a memory snapshot, it is a directory of loose notes.
    const noIndex = fresh("bogus-no-index");
    const kept = manifest.files.filter((entry) => entry.name !== INDEX_FILE);
    for (const entry of kept) writeFileSync(path.join(noIndex, entry.name), readFileSync(path.join(staged, entry.name)));
    writeManifest(noIndex, {
      kind: SNAPSHOT_KIND,
      files: kept,
      file_count: kept.length,
      total_bytes: kept.reduce((sum, entry) => sum + entry.bytes, 0),
    });
    eq(quiet(() => verify(noIndex)), 1, `a snapshot without ${INDEX_FILE} fails verification`);
  }
  {
    const badCount = fresh("bogus-count");
    for (const entry of manifest.files) writeFileSync(path.join(badCount, entry.name), readFileSync(path.join(staged, entry.name)));
    writeManifest(badCount, { ...manifest, file_count: manifest.file_count + 1 });
    eq(quiet(() => verify(badCount)), 1, "a file_count that disagrees with the entry list fails verification");
  }
  {
    const badTotal = fresh("bogus-total");
    for (const entry of manifest.files) writeFileSync(path.join(badTotal, entry.name), readFileSync(path.join(staged, entry.name)));
    writeManifest(badTotal, { ...manifest, total_bytes: manifest.total_bytes + 1 });
    eq(quiet(() => verify(badTotal)), 1, "a total_bytes that disagrees with the entries fails verification");
  }
  {
    const malformed = fresh("bogus-entry");
    writeManifest(malformed, { kind: SNAPSHOT_KIND, files: [{ name: "a.md" }], file_count: 1, total_bytes: 0 });
    eq(quiet(() => verify(malformed)), 1, "an entry missing bytes/sha256 fails verification");
  }

  // ── tamper detection still works ──────────────────────────────────────────
  {
    const tampered = fresh("tampered");
    for (const entry of manifest.files) writeFileSync(path.join(tampered, entry.name), readFileSync(path.join(staged, entry.name)));
    writeManifest(tampered, manifest);
    eq(quiet(() => verify(tampered)), 0, "control: the copied snapshot verifies before tampering");
    writeFileSync(path.join(tampered, "a.md"), "edited after the snapshot was taken\n");
    eq(quiet(() => verify(tampered)), 1, "an edited note fails verification");
  }
  {
    const extra = fresh("extra-file");
    for (const entry of manifest.files) writeFileSync(path.join(extra, entry.name), readFileSync(path.join(staged, entry.name)));
    writeManifest(extra, manifest);
    writeFileSync(path.join(extra, "unlisted.md"), "not in the manifest\n");
    eq(quiet(() => verify(extra)), 1, "a note that is not in the manifest fails verification");
  }

  // ── secret scan: scans BUFFERS, not paths (the race fix) ──────────────────
  // A true concurrent-modification race cannot be scripted deterministically
  // here, so this asserts the mechanism that removes it: the scanner is handed
  // bytes and reports on THOSE bytes. Under the previous path-based signature
  // this call could not be written at all — it would have re-read the clean file
  // from disk and reported nothing, which is exactly the gap Codex found.
  {
    const decoy = makeSource("decoy", { [INDEX_FILE]: "clean\n", "a.md": "clean on disk\n" });
    const token = `gh${"p"}_${"A".repeat(36)}`;              // shape only, not a real token
    const hits = scanForSecrets([
      { name: "a.md", buf: Buffer.from(`notes\n${token}\n`) },
      { name: INDEX_FILE, buf: readFileSync(path.join(decoy, INDEX_FILE)) },
    ]);
    eq(hits.length, 1, "the scan follows the buffer it was given, not the file on disk");
    eq(hits[0].name, "a.md", "the hit names the right note");
    eq(hits[0].line, 2, "the hit names the right line");
    ok(!JSON.stringify(hits).includes(token), "a hit never echoes the matched credential");
  }

  // ── staging aborts on a secret, and writes nothing ────────────────────────
  {
    const dirty = makeSource("dirty-source", {
      [INDEX_FILE]: "# Memory Index\n",
      "leak.md": `key: sb${"p"}_${"a".repeat(40)}\n`,
    });
    const target = path.join(root, "never-written");
    eq(quiet(() => stage(target, dirty)), 1, "staging refuses a source containing a credential shape");
    ok(!readdirSafe(target), "nothing is written when the scan trips");
  }

  // ── documentation shapes are not credentials ──────────────────────────────
  {
    const documented = makeSource("documented-source", {
      [INDEX_FILE]: "# Memory Index\n",
      "shape.md": "connection string shape: postgresql://user:<password>@host:5432/db\n",
    });
    const target = path.join(root, "documented-staged");
    eq(quiet(() => stage(target, documented)), 0, "a placeholder password is documentation, not a credential");
  }

  // ── refuses an empty or non-memory source ─────────────────────────────────
  {
    const empty = fresh("empty-source");
    eq(quiet(() => stage(path.join(root, "from-empty"), empty)), 1, "an empty source is refused");
    const noIndex = makeSource("no-index-source", { "a.md": "note\n" });
    eq(quiet(() => stage(path.join(root, "from-no-index"), noIndex)), 1, `a source without ${INDEX_FILE} is refused`);
  }

  // ── the CLI still runs when invoked directly ──────────────────────────────
  // The module now exports its functions, which required suppressing the CLI on
  // import. Prove the command Mason actually runs did not become a no-op.
  {
    const result = spawnSync(process.execPath, [SCRIPT, "--verify", staged], { encoding: "utf8" });
    eq(result.status, 0, `CLI --verify exits 0 on a good snapshot: ${result.stderr}`);
    ok(/OK: 3 files match/.test(result.stdout), "CLI --verify reports the file count");
    const bad = spawnSync(process.execPath, [SCRIPT, "--verify", path.join(root, "bogus-empty-manifest")], { encoding: "utf8" });
    eq(bad.status, 1, "CLI --verify exits 1 on the empty-manifest directory");
  }

  console.log(`OK - backup-claude-memory checks passed (${pass} assertions).`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

// True when `dir` exists and holds anything at all.
function readdirSafe(dir) {
  try { return readdirSync(dir).length > 0; } catch { return false; }
}
