#!/usr/bin/env node
// Consolidate docs/changelog.d/*.md entry files into docs/CHANGELOG.md.
//
// Deliberately MANUAL and wired into no hook. Consolidation is a moment to read
// what actually shipped; automating it away is how a changelog becomes a pile
// nobody reads. Dry-run by default — pass --write to actually move anything.
//
//   node scripts/assemble-changelog.mjs            # preview
//   node scripts/assemble-changelog.mjs --write    # apply, then delete the entries

import { readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const entryDir = path.join(repo, "docs", "changelog.d");
const changelog = path.join(repo, "docs", "CHANGELOG.md");
const write = process.argv.includes("--write");

let names;
try {
  names = readdirSync(entryDir)
    .filter((n) => n.endsWith(".md") && n !== "README.md")
    .sort();
} catch {
  console.error(`assemble-changelog: ${entryDir} does not exist — nothing to do.`);
  process.exit(0);
}

if (names.length === 0) {
  console.log("assemble-changelog: no entry files to consolidate.");
  process.exit(0);
}

// Newest first, matching CHANGELOG.md's existing top-insertion convention.
names.reverse();

const blocks = names.map((n) => {
  const body = readFileSync(path.join(entryDir, n), "utf8").replace(/\r\n/g, "\n").trim();
  return { name: n, body };
});

console.log(`assemble-changelog: ${blocks.length} entry file(s) would be merged into docs/CHANGELOG.md:`);
for (const b of blocks) console.log(`  • ${b.name}  (${b.body.split("\n").length} lines)`);

if (!write) {
  console.log("");
  console.log("DRY RUN — nothing written. Re-run with --write to apply and delete the entry files.");
  process.exit(0);
}

const raw = readFileSync(changelog, "utf8");
const hadCRLF = raw.includes("\r\n");
const current = raw.replace(/\r\n/g, "\n");
const lines = current.split("\n");

// Insert directly above the first "## " section so the file's newest-first
// ordering and its title/preamble both survive.
let at = lines.findIndex((l) => l.startsWith("## "));
if (at < 0) at = lines.length;

// A blank line before each heading — markdownlint MD022, and the exact seam that
// broke a merge on 2026-08-25.
const inserted = blocks.flatMap((b) => [...b.body.split("\n"), ""]);
const merged = [...lines.slice(0, at), ...inserted, ...lines.slice(at)];

let out = merged.join("\n");
if (hadCRLF) out = out.replace(/\n/g, "\r\n");
writeFileSync(changelog, out, "utf8");
for (const b of blocks) unlinkSync(path.join(entryDir, b.name));

console.log("");
console.log(`✅ Merged ${blocks.length} entr${blocks.length === 1 ? "y" : "ies"} into docs/CHANGELOG.md and removed the entry files.`);
console.log("Review the diff before committing — this rewrote a shared file.");
