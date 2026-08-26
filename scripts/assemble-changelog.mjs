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

const blocks = names.map((n) => ({
  name: n,
  date: dateOf(n),
  body: readFileSync(path.join(entryDir, n), "utf8").replace(/\r\n/g, "\n").trim(),
}));

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
