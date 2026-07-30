#!/usr/bin/env node
// Claude agent-memory off-site snapshot — the deterministic half of the
// /backup-claude-memory flow.
//
// WHY THIS EXISTS: the agent memory notes live ONLY on Mason's machine, under
// ~/.claude/projects/<encoded-project>/memory/. Nothing backs them up. They are
// also the one thing that CANNOT go in this repo: CRX_Manager_V1.0 is PUBLIC and
// the notes carry real commission payouts naming real people. So the memory dir
// is gitignored here (see .gitignore) and the durable copy goes to the PRIVATE
// repo masonwells1/CRX_Backups — the same place the weekly encrypted DB dump goes.
//
// WHY THIS SHAPE: mirrors scripts/backup-db.mjs. That script does everything that
// does NOT need credentials, and the driving Claude session does the part that
// does (there, the MCP dumps; here, the git push to the private repo). This
// script therefore never touches the network and never sees a token — it stages
// and verifies a snapshot on disk, and the session commits it.
//
//   --stage <dir>        copy every *.md from the source memory dir into <dir>,
//                        write <dir>/manifest.json (per-file sha256 + bytes), and
//                        verify the copy byte-for-byte against the source
//   --source <dir>       source memory dir; auto-discovered when omitted
//   --verify <dir>       re-check an existing staged dir against its own manifest
//                        (use before committing, and after a restore)
//
// Safety properties:
//   - read-only against the source: it is only ever opened for reading
//   - never deletes anything outside <dir>, and never recursively force-deletes
//     (`rm -rf` is hard-blocked in this repo); stale *.md in <dir> are removed
//     file-by-file so a shrinking memory set cannot leave orphans behind
//   - every staged file is re-read and hashed AFTER writing — a truncated or
//     partial copy FAILS the run rather than silently shipping a broken backup
//   - refuses to stage an empty source (a wrong --source path must not quietly
//     produce a valid-looking empty backup that overwrites a good one)
//
// Usage:
//   node scripts/backup-claude-memory.mjs --stage <dir> [--source <dir>]
//   node scripts/backup-claude-memory.mjs --verify <dir>
// Exit:   0 = OK, 1 = verification failure, 2 = usage error.
// Deps:   none (node builtins only).

import {
  existsSync, mkdirSync, readdirSync, readFileSync, statSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const MANIFEST = "manifest.json";
const INDEX_FILE = "MEMORY.md";

function usage(msg) {
  if (msg) console.error(`USAGE ERROR: ${msg}\n`);
  console.error(
    `Usage:\n` +
    `  node scripts/backup-claude-memory.mjs --stage <dir> [--source <dir>]\n` +
    `  node scripts/backup-claude-memory.mjs --verify <dir>\n\n` +
    `  --stage <dir>   copy the memory *.md files into <dir>, write ${MANIFEST},\n` +
    `                  and verify every staged file against the source\n` +
    `  --source <dir>  source memory dir (auto-discovered when omitted)\n` +
    `  --verify <dir>  re-check a staged dir against its own ${MANIFEST}`
  );
  process.exit(2);
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const mdFiles = (dir) =>
  readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".md"))
    .filter((f) => statSync(path.join(dir, f)).isFile())
    .sort();

// Claude Code stores memory at ~/.claude/projects/<encoded-project>/memory. The
// encoding is not ours to reproduce, so discover instead of deriving: take every
// memory dir that actually holds the index file, and prefer a CRX one.
function discoverSource() {
  const root = path.join(os.homedir(), ".claude", "projects");
  if (!existsSync(root)) return null;
  const candidates = readdirSync(root)
    .map((name) => ({ name, dir: path.join(root, name, "memory") }))
    .filter(({ dir }) => existsSync(path.join(dir, INDEX_FILE)));
  if (candidates.length === 0) return null;
  const crx = candidates.filter(({ name }) => /crx/i.test(name));
  const pool = crx.length > 0 ? crx : candidates;
  // Deterministic pick: most files wins, name as the tie-break.
  pool.sort((a, b) => {
    const d = mdFiles(b.dir).length - mdFiles(a.dir).length;
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });
  return pool[0].dir;
}

function stage(outDir, sourceArg) {
  const source = sourceArg || discoverSource();
  if (!source) {
    console.error(
      `FAIL: no memory dir found under ~/.claude/projects/*/memory (looked for ${INDEX_FILE}).\n` +
      `      Pass --source <dir> explicitly.`
    );
    return 1;
  }
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    console.error(`FAIL: source is not a directory: ${source}`);
    return 1;
  }

  const names = mdFiles(source);
  if (names.length === 0) {
    // A typo'd --source must never overwrite a good backup with an empty one.
    console.error(`FAIL: source has no .md files — refusing to stage an empty snapshot: ${source}`);
    return 1;
  }
  if (!names.includes(INDEX_FILE)) {
    console.error(`FAIL: source is missing ${INDEX_FILE} — that is not a memory dir: ${source}`);
    return 1;
  }

  mkdirSync(outDir, { recursive: true });

  const files = [];
  let totalBytes = 0;
  for (const name of names) {
    const buf = readFileSync(path.join(source, name));
    const dest = path.join(outDir, name);
    writeFileSync(dest, buf);
    // Re-read what actually landed: a short write must fail the run, not ship.
    const wrote = readFileSync(dest);
    const digest = sha256(buf);
    if (sha256(wrote) !== digest || wrote.length !== buf.length) {
      console.error(`FAIL: staged copy does not match source: ${name}`);
      return 1;
    }
    files.push({ name, bytes: buf.length, sha256: digest });
    totalBytes += buf.length;
  }

  // Drop staged files the source no longer has, one by one — never a recursive
  // delete. Without this, a renamed or deleted memory would linger forever.
  const keep = new Set(names);
  let pruned = 0;
  for (const stale of mdFiles(outDir)) {
    if (!keep.has(stale)) {
      unlinkSync(path.join(outDir, stale));
      pruned += 1;
    }
  }

  writeFileSync(
    path.join(outDir, MANIFEST),
    `${JSON.stringify(
      {
        kind: "claude-agent-memory-snapshot",
        source,
        completed_at: new Date().toISOString(),
        file_count: files.length,
        total_bytes: totalBytes,
        files,
      },
      null,
      2
    )}\n`
  );

  console.log(`Source:  ${source}`);
  console.log(`Staged:  ${outDir}`);
  console.log(`Files:   ${files.length} (${(totalBytes / 1024).toFixed(1)} KB)${pruned ? `, pruned ${pruned} stale` : ""}`);
  console.log(`Verified every staged file against the source. OK.`);
  return 0;
}

function verify(dir) {
  const manifestPath = path.join(dir, MANIFEST);
  if (!existsSync(manifestPath)) {
    console.error(`FAIL: no ${MANIFEST} in ${dir}`);
    return 1;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    console.error(`FAIL: ${MANIFEST} is not valid JSON`);
    return 1;
  }

  const problems = [];
  for (const entry of manifest.files ?? []) {
    const file = path.join(dir, entry.name);
    if (!existsSync(file)) {
      problems.push(`missing: ${entry.name}`);
      continue;
    }
    const buf = readFileSync(file);
    if (buf.length !== entry.bytes) problems.push(`size differs: ${entry.name}`);
    else if (sha256(buf) !== entry.sha256) problems.push(`content differs: ${entry.name}`);
  }
  const extra = mdFiles(dir).filter(
    (n) => !(manifest.files ?? []).some((e) => e.name === n)
  );
  for (const name of extra) problems.push(`not in manifest: ${name}`);

  if (problems.length > 0) {
    console.error(`FAIL: ${problems.length} problem(s) in ${dir}`);
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  console.log(
    `OK: ${(manifest.files ?? []).length} files match ${MANIFEST} ` +
    `(snapshot taken ${manifest.completed_at}).`
  );
  return 0;
}

function main(argv) {
  // A flag's value must not be another flag. Without this, `--stage --source x`
  // reads "--source" as the destination and this script happily creates a
  // directory literally named `--source`, reporting success — the worst outcome
  // for a backup tool, because the real destination is left stale and untouched.
  const flag = (name) => {
    const i = argv.indexOf(name);
    if (i === -1) return null;
    const value = argv[i + 1];
    return value === undefined || value.startsWith("--") ? null : value;
  };

  const stageDir = flag("--stage");
  const verifyDir = flag("--verify");
  if (stageDir && verifyDir) usage("pass either --stage or --verify, not both");
  if (!stageDir && !verifyDir) usage("nothing to do");
  if (stageDir === null && argv.includes("--stage")) usage("--stage needs a directory");
  if (verifyDir === null && argv.includes("--verify")) usage("--verify needs a directory");

  return stageDir ? stage(stageDir, flag("--source")) : verify(verifyDir);
}

// Exit 1 means "the snapshot is not trustworthy" — a check ran and failed. An
// unexpected crash (permissions, a dangling symlink, a short read) is a
// different thing and must not wear the same code, or the runbook's exit
// contract is a lie and a broken environment reads as a failed verification.
try {
  process.exit(main(process.argv.slice(2)));
} catch (error) {
  console.error(`FAIL: ${error?.message ?? error}`);
  process.exit(3);
}
