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
import { fileURLToPath } from "node:url";

const MANIFEST = "manifest.json";
const INDEX_FILE = "MEMORY.md";
// One spelling of the manifest kind, shared by the writer and both readers, so a
// rename can never leave a validator silently accepting the old value.
const SNAPSHOT_KIND = "claude-agent-memory-snapshot";

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

// Is `child` inside `parent` (or the same directory)? Path-string comparison
// with a separator so `/docs` is not read as a parent of `/docs-archive`.
function isInside(child, parent) {
  const a = path.resolve(child);
  const b = path.resolve(parent);
  if (a === b) return true;
  return a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

// The DESTINATION is the dangerous argument here, because staging PRUNES: it
// deletes top-level .md files the source no longer has. Codex's 2026-07-30
// pre-push review pointed out that `--stage .` would therefore delete the
// repository's own documentation. So a destination is only accepted when it is
// new, empty, or a previous snapshot written by THIS script — and pruning is
// limited to files that snapshot's own manifest recorded. Anything else fails
// BEFORE a single byte is written or deleted.
function assertSafeDestination(outDir, source) {
  if (isInside(source, outDir)) {
    return `FAIL: refusing to stage into ${outDir} — the memory source lives inside it. Pick a dedicated directory.`;
  }
  if (isInside(outDir, source)) {
    return `FAIL: refusing to stage into ${outDir} — it is inside the memory source. Pick a dedicated directory.`;
  }
  if (!existsSync(outDir)) return null;                       // new directory: nothing to clobber
  if (!statSync(outDir).isDirectory()) return `FAIL: destination is not a directory: ${outDir}`;
  if (readdirSync(outDir).length === 0) return null;          // empty directory: nothing to clobber

  const manifestPath = path.join(outDir, MANIFEST);
  if (!existsSync(manifestPath)) {
    return (
      `FAIL: destination is not empty and holds no ${MANIFEST}: ${outDir}\n` +
      `      Staging deletes stale .md files, so it only ever writes into a new,\n` +
      `      empty, or previously-staged directory. Nothing was changed.`
    );
  }
  let previous;
  try {
    previous = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return `FAIL: ${MANIFEST} in ${outDir} is not valid JSON — refusing to treat it as a snapshot. Nothing was changed.`;
  }
  if (previous?.kind !== SNAPSHOT_KIND || !Array.isArray(previous.files)) {
    return `FAIL: ${MANIFEST} in ${outDir} is not a memory snapshot manifest. Nothing was changed.`;
  }
  return { previous };
}

// Credential shapes that must never be snapshotted. Deliberately narrow: these
// match the STRUCTURE of a real key, not the word "key", so an agent note that
// merely discusses secrets does not fail the run. A false negative is possible;
// this is a backstop under the human read, not a replacement for it.
const SECRET_RES = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, "private key block"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/, "GitHub fine-grained PAT"],
  [/\bsbp_[a-f0-9]{40,}\b/, "Supabase access token"],
  [/\bsb_secret_[A-Za-z0-9_-]{20,}\b/, "Supabase secret key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}\b/, "API secret key"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/, "Slack token"],
  // A service_role JWT is the single most dangerous string in this project: it
  // bypasses every RLS policy. Match the JWT header shape, not the word.
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, "JWT (possible service_role key)"],
  // Agent notes legitimately record connection-string SHAPES with the password
  // written as a placeholder (`<pw>`, `${VAR}`, `…`). Those are documentation, not
  // credentials, so the password segment must not start with a placeholder
  // delimiter and must not contain one.
  [/\bpostgres(?:ql)?:\/\/[^:\s]+:(?![<{$])[^@\s<>{}$]{6,}@/, "database URL with inline password"],
];
// Scans BUFFERS, not paths. Codex's fourth 2026-07-30 review found a race in the
// earlier path-based version: staging read every file once to scan it and a
// second time to copy it, so a memory written between those two reads could land
// in the permanent snapshot having never been scanned. The caller now reads each
// file exactly once and hands the same bytes to this scan and to the writer.
function scanForSecrets(entries) {
  const hits = [];
  for (const { name, buf } of entries) {
    const lines = buf.toString("utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const [re, label] of SECRET_RES) {
        // Never echo the matched text — printing it would copy the credential
        // into a terminal log, which is the thing this check exists to prevent.
        if (re.test(line)) hits.push({ name, line: index + 1, label });
      }
    });
  }
  return hits;
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

  // Codex's 2026-07-30 review, second finding: the notes are copied verbatim into
  // git history, and a private repo is access control, not content control — git
  // history is permanent and readable to anyone who ever gets the repo. The notes
  // are deliberately NOT encrypted (a cloud session has to be able to read them,
  // which was the whole point), so the compensating control is that a credential
  // must never enter the snapshot in the first place. This scan runs BEFORE any
  // file is written and aborts the whole staging run, so nothing reaches a commit.
  //
  // Read every note ONCE, here, and carry those exact bytes through the scan and
  // the copy below. Reading again at copy time would leave a window in which a
  // concurrent session could add a credential to a note after it was cleared
  // (Codex round-4, 2026-07-30). The notes are a few hundred KB; holding them in
  // memory costs nothing and closes the window completely.
  const entries = names.map((name) => ({ name, buf: readFileSync(path.join(source, name)) }));
  const secrets = scanForSecrets(entries);
  if (secrets.length > 0) {
    console.error(
      `FAIL: refusing to stage — ${secrets.length} possible secret(s) found in the memory notes.\n` +
      secrets.slice(0, 10).map((hit) => `      ${hit.name}:${hit.line} — ${hit.label}`).join("\n") +
      (secrets.length > 10 ? `\n      ... and ${secrets.length - 10} more` : "") +
      `\n      Remove the credential from the note (and rotate it), then re-run. Nothing was written.`
    );
    return 1;
  }

  const destination = assertSafeDestination(outDir, source);
  if (typeof destination === "string") {
    console.error(destination);
    return 1;
  }
  const prunable = new Set((destination?.previous?.files ?? []).map((entry) => entry.name));

  mkdirSync(outDir, { recursive: true });

  const files = [];
  let totalBytes = 0;
  for (const { name, buf } of entries) {
    // `buf` is the SAME buffer the secret scan above inspected — not a re-read.
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
  // Only files the PREVIOUS manifest recorded are eligible: this script deletes
  // nothing it did not itself write, so a stray .md that a human put in the
  // staging directory survives instead of being silently destroyed.
  const keep = new Set(names);
  let pruned = 0;
  for (const stale of mdFiles(outDir)) {
    if (!keep.has(stale) && prunable.has(stale)) {
      unlinkSync(path.join(outDir, stale));
      pruned += 1;
    }
  }

  writeFileSync(
    path.join(outDir, MANIFEST),
    `${JSON.stringify(
      {
        kind: SNAPSHOT_KIND,
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

  // Validate the manifest ITSELF before trusting anything it says. Codex's
  // fourth 2026-07-30 review pointed out that a directory containing nothing but
  // `{}` as its manifest passed: `manifest.files ?? []` made the comparison loop
  // run zero times and the run reported OK. "Verified" then meant "there was
  // nothing to check", which is the opposite of what this command is for.
  if (manifest?.kind !== SNAPSHOT_KIND) {
    console.error(`FAIL: ${MANIFEST} is not a ${SNAPSHOT_KIND} manifest (kind: ${JSON.stringify(manifest?.kind)})`);
    return 1;
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    console.error(`FAIL: ${MANIFEST} lists no files — an empty snapshot is never valid.`);
    return 1;
  }
  const malformed = manifest.files.filter(
    (entry) => !entry || typeof entry.name !== "string" || !Number.isInteger(entry.bytes) || typeof entry.sha256 !== "string",
  );
  if (malformed.length > 0) {
    console.error(`FAIL: ${MANIFEST} has ${malformed.length} entr(ies) missing name/bytes/sha256.`);
    return 1;
  }
  if (!manifest.files.some((entry) => entry.name === INDEX_FILE)) {
    console.error(`FAIL: ${MANIFEST} does not list ${INDEX_FILE} — that is not a memory snapshot.`);
    return 1;
  }
  if (manifest.file_count !== manifest.files.length) {
    console.error(`FAIL: ${MANIFEST} says file_count=${manifest.file_count} but lists ${manifest.files.length} files.`);
    return 1;
  }
  const declaredBytes = manifest.files.reduce((sum, entry) => sum + entry.bytes, 0);
  if (manifest.total_bytes !== declaredBytes) {
    console.error(`FAIL: ${MANIFEST} says total_bytes=${manifest.total_bytes} but its entries sum to ${declaredBytes}.`);
    return 1;
  }

  const problems = [];
  for (const entry of manifest.files) {
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
    (n) => !manifest.files.some((e) => e.name === n)
  );
  for (const name of extra) problems.push(`not in manifest: ${name}`);

  if (problems.length > 0) {
    console.error(`FAIL: ${problems.length} problem(s) in ${dir}`);
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  console.log(
    `OK: ${manifest.files.length} files match ${MANIFEST} ` +
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

// Exported so the tests can call the real functions rather than re-implementing
// them. Importing this file must therefore NOT run the CLI, hence the
// invoked-directly check below.
export { scanForSecrets, stage, verify, SNAPSHOT_KIND, MANIFEST, INDEX_FILE };

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// Exit 1 means "the snapshot is not trustworthy" — a check ran and failed. An
// unexpected crash (permissions, a dangling symlink, a short read) is a
// different thing and must not wear the same code, or the runbook's exit
// contract is a lie and a broken environment reads as a failed verification.
if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`FAIL: ${error?.message ?? error}`);
    process.exit(3);
  }
}
