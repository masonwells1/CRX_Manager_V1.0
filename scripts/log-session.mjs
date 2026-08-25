#!/usr/bin/env node
// Session → changelog scaffold.
// A session that lands commits should leave a ledger record. Two layers apply:
// scripts/check-ledger-update.mjs HARD-blocks a commit that stages agent-surface
// or migration files without one, and the stop hook raises the broader
// per-session reminder. docs/CHANGELOG.md is the right home for
// general work, while a policy call goes to docs/manual/DECISION_LOG.md and a
// schema change to docs/reference/migration-history.md. Since 2026-08-17 the
// CHANGELOG is no longer demanded every session — use this script when the
// CHANGELOG is genuinely the right ledger. This script does
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
//   node scripts/log-session.mjs --help             # print usage, write nothing
//
// Commits come from ONE source, genuinely scoped to this session's work:
//   git log origin/main..HEAD --oneline   (commits on this branch and not on main)
// There is deliberately NO "recent commits" fallback. A window of arbitrary recent
// history attributes other people's merged work to this session (observed
// 2026-08-04: 14 unrelated commits and 7 migrations credited to a docs-only
// session). An empty result means there are no commits ahead of origin/main — the
// work is still uncommitted, or the branch is level with main — and is reported as
// "none". A 12-hour window guarded by `HEAD === origin/main` was tried here and
// REMOVED (Codex, PR #310): level with main, the last 12 hours of main is still
// other people's merged work, so the guard narrowed the bug without fixing it.
// Migrations touched:
//   git diff --name-only origin/main...HEAD -- supabase/migrations
// An empty result means NO migrations were touched and is reported as such. It is
// never backfilled from unrelated history.
//
// origin/main MUST resolve locally. Without it these ranges are meaningless, so
// the script refuses to write and tells you to fetch, rather than guessing. A git
// command that FAILS is likewise never treated as an empty result.
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

// --help must NEVER write. It previously fell through as an unrecognised flag and
// inserted a live {SUMMARY} stub into docs/CHANGELOG.md (observed 2026-08-04).
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(
    [
      "log-session — insert a dated entry at the top of docs/CHANGELOG.md.",
      "",
      "Usage:",
      '  node scripts/log-session.mjs --summary "Plain-English what shipped + why"',
      "  node scripts/log-session.mjs --dry-run          print the entry, write nothing",
      "  node scripts/log-session.mjs --help             this message, write nothing",
      "",
      "Without --summary the entry carries a literal {SUMMARY} placeholder to fill in.",
      "The heading is a short title derived from the first sentence of --summary; the",
      "full text becomes the lead paragraph.",
      "",
      "Commits are scoped to origin/main..HEAD (this branch's work). Migrations come",
      "from the same range; an empty result means none were touched. origin/main must",
      "resolve locally — if it does not, the script refuses rather than guessing.",
      "",
      "ALWAYS read the generated entry before committing it.",
    ].join("\n"),
  );
  process.exit(0);
}

const dryRun = argv.includes("--dry-run");
let summary = null;
const si = argv.indexOf("--summary");
if (si !== -1) {
  summary = (argv[si + 1] || "").trim() || null;
}

// Returns {ok, out}. A git FAILURE and a git success with EMPTY output are
// different facts: the first means attribution is unknowable, the second means
// there is genuinely nothing to report. Collapsing both to "" is what let the
// old code silently fall back to unrelated history.
function runGit(args) {
  try {
    const out = execFileSync("git", args, {
      encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"], cwd: root,
    }).trim();
    return { ok: true, out };
  } catch {
    return { ok: false, out: "" };
  }
}

function gitOrDie(args, what) {
  const res = runGit(args);
  if (!res.ok) {
    console.error(
      `ERROR — git failed while resolving ${what} (\`git ${args.join(" ")}\`).\n` +
      "Refusing to write docs/CHANGELOG.md: without this the entry could claim\n" +
      "commits or migrations that are not this session's work.",
    );
    process.exit(1);
  }
  return res.out;
}

// ─── This session's commits ────────────────────────────────────────────────
// Commits on this branch and not yet on main ARE this session's work. The old
// --author=Mason filter never matched agent-authored commits, so every agent
// session fell through to `git log -15` and claimed unrelated merged work.
//
// origin/main must actually resolve. If it does not, attribution is unknowable
// and the script fails loudly rather than guessing from a time window.
//
// Probed with runGit, NOT gitOrDie: `rev-parse --verify --quiet` exits 1 on a
// missing ref, so gitOrDie would report it as "git failed" and bury the one
// thing the reader can act on — a shallow or un-fetched checkout just needs a
// fetch, which is a different problem from git being broken.
const baseProbe = runGit(["rev-parse", "--verify", "--quiet", "origin/main^{commit}"]);
const baseSha = baseProbe.ok ? baseProbe.out : "";
if (!baseSha) {
  console.error(
    "ERROR — origin/main does not resolve in this checkout, so this session's\n" +
    "commits and migrations cannot be told apart from anyone else's work.\n" +
    "Run `git fetch origin main`, then re-run. Nothing was written.",
  );
  process.exit(1);
}

// No fallback of any kind. If this range is empty, this session has no commits
// yet and the entry says so — borrowing recent history to fill the gap is the
// exact bug this script was rewritten to end.
const commitsRaw = gitOrDie(["log", "origin/main..HEAD", "--oneline"], "this branch's commits");
const commits = commitsRaw.split("\n").map(l => l.trim()).filter(Boolean);
const commitSource = commits.length
  ? "git log origin/main..HEAD"
  : "git log origin/main..HEAD (no commits ahead of origin/main — nothing committed this session yet)";

// ─── Migrations touched ────────────────────────────────────────────────────
// No fallback: an empty diff means this branch touched no migrations. Backfilling
// from recent history invented migrations that the session never went near. A
// FAILED diff is not an empty diff and stops the write path above.
const migSource = "git diff --name-only origin/main...HEAD";
const migsRaw = gitOrDie(
  ["diff", "--name-only", "origin/main...HEAD", "--", "supabase/migrations"],
  "migrations touched",
);
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

// The heading is a SHORT title. Folding a whole multi-sentence summary into the
// "## " line produced an unreadable table of contents and duplicated the prose.
const MAX_TITLE = 72;
function deriveTitle(text) {
  // First sentence, stopping at a sentence-ending period/em-dash/newline.
  const firstSentence = text.split(/(?:\.\s|\n|\s—\s)/)[0].trim().replace(/[.:;,]$/, "");
  if (firstSentence.length <= MAX_TITLE) return firstSentence;
  const clipped = firstSentence.slice(0, MAX_TITLE);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > 20 ? clipped.slice(0, lastSpace) : clipped).trim()}…`;
}

const title = summary ? deriveTitle(summary) : "{SUMMARY}";
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
