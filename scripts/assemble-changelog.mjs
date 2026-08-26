#!/usr/bin/env node
// Consolidate docs/changelog.d/*.md entry files into docs/CHANGELOG.md.
//
// Deliberately MANUAL and wired into no hook. Consolidation is a moment to read what
// actually shipped; automating it away is how a changelog becomes a pile nobody reads.
// Dry-run by default — pass --write to actually move anything.
//
//   node scripts/assemble-changelog.mjs            # preview
//   node scripts/assemble-changelog.mjs --write    # apply, then delete the entries

import { readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENTRY_RE } from "./check-ledger-update.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const entryDir = path.join(repo, "docs", "changelog.d");
const changelog = path.join(repo, "docs", "CHANGELOG.md");
const write = process.argv.includes("--write");

// The SAME predicate the ledger guard enforces, imported rather than re-expressed, so
// the two can never disagree about what an entry is (CodeRabbit, PR #482). An undated
// `notes.md` is not an entry: it would sort ahead of dated names and splice in as the
// newest block while never having satisfied the guard.
const isEntry = (name) => ENTRY_RE.test(`docs/changelog.d/${name}`);
const dateOf = (name) => name.slice(0, 10);

let names;
try {
  names = readdirSync(entryDir).filter(isEntry);
} catch {
  console.error(`assemble-changelog: ${entryDir} does not exist — nothing to do.`);
  process.exit(0);
}

// Only consolidate fragments git already TRACKS. With several sessions sharing a
// checkout, an untracked file is somebody's draft in progress — consuming it would
// splice half-written text into the changelog and then DELETE the original, which is
// the one unrecoverable thing this script could do (Codex P2, PR #482).
let tracked = new Set();
try {
  tracked = new Set(
    execFileSync("git", ["ls-files", "--", "docs/changelog.d"], { cwd: repo, encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean)
      .map((p) => p.split("/").pop()));
} catch (e) {
  console.error(`assemble-changelog: could not list tracked files (${e && e.message}). Refusing to ` +
    "consolidate — an untracked draft from another session could otherwise be consumed and deleted.");
  process.exit(1);
}
const untracked = names.filter((n) => !tracked.has(n));
if (untracked.length) {
  console.error(`assemble-changelog: SKIPPING ${untracked.length} untracked fragment(s) — commit them first:`);
  for (const n of untracked) console.error(`  • ${n}`);
}
names = names.filter((n) => tracked.has(n));

let skipped = [];
try {
  skipped = readdirSync(entryDir).filter((n) => n !== "README.md" && !isEntry(n));
} catch { /* already reported above */ }
if (skipped.length) {
  console.error(`assemble-changelog: IGNORING ${skipped.length} file(s) that are not <YYYY-MM-DD>-<slug>.md:`);
  for (const n of skipped) console.error(`  • ${n}`);
  console.error("  Rename them to the dated form or delete them — they satisfy no ledger requirement.");
}

if (names.length === 0) {
  console.log("assemble-changelog: no entry files to consolidate.");
  process.exit(0);
}

// Newest first, matching CHANGELOG.md's reverse-chronological contract.
names.sort().reverse();

const candidates = names.map((n) => ({
  name: n,
  date: dateOf(n),
  body: readFileSync(path.join(entryDir, n), "utf8").replace(/\r\n/g, "\n").trim(),
}));

// A fragment must actually BE a dated section before it is spliced in and its source
// deleted. Empty, prose-first, or a heading whose date disagrees with the filename all
// mean the file is not what the convention promises (Codex P2 + CodeRabbit, PR #482).
// Rejected fragments are reported and LEFT ON DISK — never silently consumed.
const rejected = [];
const blocks = [];
for (const c of candidates) {
  const first = c.body.split("\n")[0] || "";
  const m = /^##\s+(\d{4}-\d{2}-\d{2})\b/.exec(first);
  if (!c.body) rejected.push([c.name, "file is empty — consuming it would delete a fragment while adding nothing"]);
  else if (!m) rejected.push([c.name, `must start with "## <YYYY-MM-DD> - ..." (found ${JSON.stringify(first.slice(0, 40))})`]);
  else if (m[1] !== c.date) rejected.push([c.name, `heading date ${m[1]} disagrees with the filename date ${c.date}`]);
  else blocks.push(c);
}
if (rejected.length) {
  console.error(`assemble-changelog: REFUSING ${rejected.length} malformed fragment(s) (left on disk, nothing deleted):`);
  for (const [n, why] of rejected) console.error(`  • ${n} — ${why}`);
}

if (blocks.length === 0) {
  console.log("assemble-changelog: no consolidatable entry files (see any skips above).");
  process.exit(rejected.length ? 1 : 0);
}

console.log(`assemble-changelog: ${blocks.length} entry file(s) would be merged into docs/CHANGELOG.md:`);
for (const b of blocks) console.log(`  • ${b.name}  (${b.body.split("\n").length} lines)`);

if (!write) {
  console.log("");
  console.log("DRY RUN — nothing written. Re-run with --write to apply and delete the entry files.");
  process.exit(0);
}

const raw = readFileSync(changelog, "utf8");
const hadCRLF = raw.includes("\r\n");
let lines = raw.replace(/\r\n/g, "\n").split("\n");

// Insert each block by DATE, not always at the top. A fragment from an older or
// delayed PR consolidated after a newer entry already exists would otherwise be
// placed above it, contradicting the file's reverse-chronological contract
// (Codex P2, PR #482).
const HEADING_DATE = /^##\s+(\d{4}-\d{2}-\d{2})\b/;

for (const b of blocks) {
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_DATE.exec(lines[i]);
    if (m && m[1] <= b.date) { at = i; break; }
  }
  if (at < 0) {
    // No dated heading is older — append after the last section instead of the top.
    let last = -1;
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].startsWith("## ")) { last = i; break; }
    at = last < 0 ? lines.length : lines.length;
  }
  // A blank line before the heading — markdownlint MD022, and the exact seam that
  // broke a merge on 2026-08-25.
  lines = [...lines.slice(0, at), ...b.body.split("\n"), "", ...lines.slice(at)];
}

let out = lines.join("\n");
if (hadCRLF) out = out.replace(/\n/g, "\r\n");
writeFileSync(changelog, out, "utf8");
for (const b of blocks) unlinkSync(path.join(entryDir, b.name));

console.log("");
console.log(`✅ Merged ${blocks.length} entr${blocks.length === 1 ? "y" : "ies"} into docs/CHANGELOG.md and removed the entry files.`);
console.log("Review the diff before committing — this rewrote a shared file.");
