#!/usr/bin/env node
// Session → changelog scaffold.
// CLAUDE.md ("Keeping Docs In Sync") mandates a docs/CHANGELOG.md entry every
// session, and it's the item Mason most often has to chase. This script does
// the MECHANICAL part: it derives this session's commits + touched migrations
// from git, inserts a dated section at the TOP of docs/CHANGELOG.md in the
// file's existing entry format ("## YYYY-MM-DD — Title" + prose paragraph +
// bullets), and prints the live pages/migrations counts so the driving
// session can spot CLAUDE.md Snapshot drift.
//
// The PROSE stays Claude's/Mason's job: without --summary the entry carries a
// literal {SUMMARY} placeholder to fill in; with --summary "text" the text is
// used as the title + lead paragraph.
//
// This script NEVER edits CLAUDE.md — it only prints the counts to compare.
//
// Usage:
//   node scripts/log-session.mjs --summary "Plain-English what shipped + why"
//   node scripts/log-session.mjs --dry-run          # print the entry, write nothing
//   node scripts/log-session.mjs --dry-run --summary "..."
//
// Commit sources (first non-empty wins):
//   1. git log --since=12.hours --oneline --author=Mason   (this session's work)
//   2. git log -15 --oneline                               (fallback: recent commits)
// Migration sources (first non-empty wins):
//   1. git diff --name-only origin/main...HEAD -- supabase/migrations
//   2. names touched in the last 15 commits under supabase/migrations
//
// Exit:   0 = entry written (or printed in --dry-run; or an identical heading
//             already exists — skipped, nothing to do)
//         1 = docs/CHANGELOG.md missing/unreadable or git unusable
// Deps:   none (node builtins only).

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

// ─── Args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
let summary = null;
const si = argv.indexOf("--summary");
if (si !== -1) {
  summary = (argv[si + 1] || "").trim() || null;
}

function runGit(args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"], cwd: root,
    }).trim();
  } catch {
    return "";
  }
}

// ─── This session's commits ───────────────────────────────────────────────
let commitSource = "git log --since=12.hours --author=Mason";
let commitsRaw = runGit(["log", "--since=12.hours", "--oneline", "--author=Mason"]);
if (!commitsRaw) {
  commitSource = "git log -15 (fallback — no author-matched commits in the last 12h)";
  commitsRaw = runGit(["log", "-15", "--oneline"]);
}
const commits = commitsRaw.split("\n").map(l => l.trim()).filter(Boolean);

// ─── Migrations touched ────────────────────────────────────────────────────
let migSource = "git diff --name-only origin/main...HEAD";
let migsRaw = runGit(["diff", "--name-only", "origin/main...HEAD", "--", "supabase/migrations"]);
if (!migsRaw) {
  migSource = "last 15 commits (fallback)";
  migsRaw = runGit(["log", "-15", "--name-only", "--pretty=format:", "--", "supabase/migrations"]);
}
const migrationsTouched = [...new Set(
  migsRaw.split("\n").map(l => l.trim()).filter(l => /supabase\/migrations\/.+\.sql$/.test(l))
)];

// ─── Mechanical counts (print-only — compare to the CLAUDE.md Snapshot) ───
function countFiles(rel, ext) {
  try {
    return readdirSync(path.join(root, rel)).filter(f => f.endsWith(ext)).length;
  } catch {
    return null;
  }
}
const pageCount = countFiles("src/pages", ".tsx");
const migCount = countFiles(path.join("supabase", "migrations"), ".sql");

// ─── Build the entry (matches the existing "## YYYY-MM-DD — Title" format) ─
const now = new Date();
const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

const title = summary || "{SUMMARY}";
const lead = summary
  ? summary
  : "{SUMMARY — replace with one plain-English paragraph: what shipped, why it matters, and the proof it ran (PROOF — Ran: … · Saw: …).}";

const commitLines = commits.length
  ? commits.slice(0, 15).map(c => `  - \`${c}\``).join("\n")
  : "  - (none found)";
const migLines = migrationsTouched.length
  ? migrationsTouched.map(m => `  - \`${m}\``).join("\n")
  : "  - none";

const entry =
  `## ${date} — ${title}\n` +
  `\n` +
  `${lead}\n` +
  `\n` +
  `- **Commits this session** (${commitSource}):\n` +
  `${commitLines}\n` +
  `- **Migrations touched** (${migSource}):\n` +
  `${migLines}\n`;

// ─── Insert at the TOP of docs/CHANGELOG.md (before the first "## " entry) ─
const changelogPath = path.join(root, "docs", "CHANGELOG.md");
let changelog;
try {
  changelog = readFileSync(changelogPath, "utf8");
} catch {
  console.error(`ERROR — cannot read ${changelogPath}`);
  process.exit(1);
}

console.log("── log-session — derived changelog entry ─────────────────────────");
console.log(entry);
console.log("── mechanical counts (compare to the CLAUDE.md Snapshot — update it");
console.log("   in the driving session if drifted; this script NEVER edits CLAUDE.md) ──");
console.log(`   pages (src/pages/*.tsx):            ${pageCount === null ? "(src/pages unreadable)" : pageCount}`);
console.log(`   migrations (supabase/migrations):   ${migCount === null ? "(dir unreadable)" : migCount}`);
console.log("───────────────────────────────────────────────────────────────────");

if (dryRun) {
  console.log("DRY RUN — docs/CHANGELOG.md NOT modified.");
  process.exit(0);
}

const headingLine = `## ${date} — ${title}`;
if (changelog.includes(headingLine)) {
  console.log(`SKIP — an identical entry heading already exists in docs/CHANGELOG.md: "${headingLine}".`);
  console.log("Nothing written (edit that entry directly, or pass a different --summary).");
  process.exit(0);
}

const firstEntry = changelog.search(/^## /m);
let updated;
if (firstEntry === -1) {
  updated = changelog.replace(/\s*$/, "\n\n") + entry;
} else {
  updated = changelog.slice(0, firstEntry) + entry + "\n" + changelog.slice(firstEntry);
}

try {
  writeFileSync(changelogPath, updated, "utf8");
} catch {
  console.error(`ERROR — cannot write ${changelogPath}`);
  process.exit(1);
}

console.log(`WROTE docs/CHANGELOG.md — new "${date}" section inserted at the top.`);
if (!summary) {
  console.log("NOTE — the entry contains {SUMMARY} placeholders: fill them in now (or re-run with --summary \"text\").");
}
process.exit(0);
