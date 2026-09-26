#!/usr/bin/env node
// Daily plain-English landing summary for Mason (autonomous-landing rule,
// 2026-09-26). Once agents merge and apply non-destructive migrations on their
// own, this is how Mason keeps sight of what happened: once a day, what merged,
// which database changes the agents recorded as applied, and what is waiting on
// him.
//
// READ-ONLY with respect to the code and the database. It reads GitHub (merged
// and open pull requests) and this checkout's git history. The ONLY write it can
// make is the summary itself, and only with --post: one comment on a single
// "Daily landing summary" issue that @-mentions Mason, so GitHub emails it to
// him. Without --post it prints the summary and changes nothing.
//
// WHERE "APPLIED" COMES FROM — stated plainly because it is the weak point. This
// job holds no database credential (adding one is a secrets decision, which stays
// Mason's), so it cannot read the live migration ledger. It reports applies as
// the agents RECORDED them: every shipped change adds a docs/changelog.d/ entry,
// and an entry that says a migration was "applied live" is listed as an apply.
// The summary says so in its footer rather than presenting it as a database read.
//
// Usage:
//   node scripts/daily-landing-summary.mjs                # print the last 24 hours
//   node scripts/daily-landing-summary.mjs --hours 48     # widen the window
//   node scripts/daily-landing-summary.mjs --post         # post it (GitHub Actions)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { destructiveMigrationCheck } from "../.claude/hooks/live-testdata-lib.mjs";

const ISSUE_TITLE = "Daily landing summary";
const MASON = "masonwells1";
const DEFAULT_REPO = "masonwells1/CRX_Manager_V1.0";
const NEEDS_MASON_LABEL = "needs-mason";

// PR titles and changelog headings are written by anyone who can open a PR on a
// public repo. Neutralise the three things that would let that text act on the
// comment it lands in: an @-mention (notifies strangers), a line break (forges
// structure) and markdown link/emphasis syntax.
export function plainText(value, max = 140) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/@/g, "@​")
    .replace(/[`*_[\]<>|]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Heading of a changelog.d entry: the first "## ..." line, minus the date prefix.
export function changelogHeading(markdown) {
  const line = String(markdown || "").split(/\r?\n/).find((candidate) => /^##\s+/.test(candidate));
  if (!line) return null;
  return line.replace(/^##\s+/, "").replace(/^\d{4}-\d{2}-\d{2}\s*[-—–:]\s*/, "").trim() || null;
}

export function recordsLiveApply(markdown) {
  return /\bappl(?:y|ied)\s+(?:it\s+)?live\b|\bapplied\s+to\s+(?:live\s+)?production\b/i.test(String(markdown || ""));
}

// Which open pull requests need Mason, and why. `files` entries are the REST
// /pulls/{n}/files shape: { filename, patch }.
export function waitingReasons({ labels = [], files = [] }) {
  const reasons = [];
  if (labels.some((label) => String(label?.name || label).toLowerCase() === NEEDS_MASON_LABEL)) {
    reasons.push("an agent marked it as needing your decision");
  }
  if (files.some((file) => String(file?.filename || "").startsWith("supabase/functions/"))) {
    reasons.push("it changes an Edge Function, and deploying one is yours");
  }
  for (const file of files) {
    const name = String(file?.filename || "");
    if (!/^supabase\/migrations\/[^/]+\.sql$/i.test(name)) continue;
    const added = String(file?.patch || "").split(/\r?\n/)
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1))
      .join("\n");
    let verdict;
    try { verdict = destructiveMigrationCheck(added); } catch { verdict = { destructive: true, reason: "could not be classified" }; }
    if (verdict.destructive) {
      reasons.push(`its database change ${path.basename(name)} deletes data (${verdict.reason}), which stays yours to approve`);
    }
  }
  return reasons;
}

export function buildSummary({ now, hours, merged, changes, landedMigrations, waiting }) {
  const day = new Date(now).toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "long", day: "numeric", year: "numeric" });
  const applied = changes.filter((change) => change.appliedLive);
  const lines = [
    `@${MASON} — here is what happened in CRX Manager in the last ${hours} hours (${day}).`,
    "",
    `**Went live (merged): ${merged.length}**`,
    ...(merged.length
      ? merged.map((pr) => `- #${pr.number} ${plainText(pr.title)}`)
      : ["- Nothing merged."]),
    "",
    `**Database changes applied: ${applied.length}**`,
    ...(applied.length
      ? applied.map((change) => `- ${plainText(change.heading)}`)
      : ["- None recorded."]),
  ];
  if (landedMigrations.length) {
    lines.push("", "New database change files that reached the main branch (applied or waiting to be applied):",
      ...landedMigrations.map((name) => `- ${plainText(name, 100)}`));
  }
  lines.push("", `**Waiting on you: ${waiting.length}**`);
  if (waiting.length) {
    lines.push(...waiting.map((pr) => `- #${pr.number} ${plainText(pr.title)} — ${pr.reasons.join("; ")}.`));
  } else {
    lines.push("- Nothing needs you today.");
  }
  const other = changes.filter((change) => !change.appliedLive);
  if (other.length) {
    lines.push("", "Other changes recorded in this window:", ...other.slice(0, 20).map((change) => `- ${plainText(change.heading)}`));
    if (other.length > 20) lines.push(`- …and ${other.length - 20} more.`);
  }
  lines.push("",
    "_How this is put together: merges come straight from GitHub. \"Applied\" lists the database changes the " +
    "agents recorded as applied live in their change notes; this job has no database access, so it cannot " +
    "double-check the live database itself. What stays yours: database changes that delete data, Edge " +
    "Function deploys, and anything about secrets, logins, billing or permissions._");
  return lines.join("\n");
}

function readArgs(argv) {
  const hoursIndex = argv.indexOf("--hours");
  const hours = hoursIndex >= 0 ? Number(argv[hoursIndex + 1]) : 24;
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 14) throw new Error("--hours must be a number of hours between 1 and 336");
  return { hours, post: argv.includes("--post") };
}

function main() {
  const { hours, post } = readArgs(process.argv.slice(2));
  const repo = process.env.GITHUB_REPOSITORY || DEFAULT_REPO;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const now = Date.now();
  const since = new Date(now - hours * 3600_000);
  const gh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

  const merged = JSON.parse(gh(["pr", "list", "--repo", repo, "--state", "merged", "--limit", "200",
    "--search", `merged:>=${since.toISOString().slice(0, 10)}`, "--json", "number,title,mergedAt"]))
    .filter((pr) => Date.parse(pr.mergedAt) >= since.getTime())
    .sort((left, right) => Date.parse(left.mergedAt) - Date.parse(right.mergedAt));

  const added = (dir) => git(["log", `--since=${since.toISOString()}`, "--diff-filter=A", "--name-only", "--format=", "HEAD", "--", dir])
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const changes = [...new Set(added("docs/changelog.d"))].filter((file) => file.endsWith(".md") && !file.endsWith("README.md"))
    .flatMap((file) => {
      let text;
      try { text = readFileSync(path.join(root, file), "utf8"); } catch { return []; }
      const heading = changelogHeading(text);
      return heading ? [{ heading, appliedLive: recordsLiveApply(text) }] : [];
    });
  const landedMigrations = [...new Set(added("supabase/migrations"))].filter((file) => file.endsWith(".sql")).map((file) => path.basename(file));

  const open = JSON.parse(gh(["pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", "number,title,labels,isDraft"]))
    .filter((pr) => !pr.isDraft);
  const waiting = [];
  for (const pr of open) {
    const files = JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${pr.number}/files?per_page=100`])).flat();
    const reasons = waitingReasons({ labels: pr.labels, files });
    if (reasons.length) waiting.push({ number: pr.number, title: pr.title, reasons });
  }

  const summary = buildSummary({ now, hours, merged, changes, landedMigrations, waiting });
  if (!post) {
    process.stdout.write(`${summary}\n\n(dry run — nothing was posted; pass --post to post it)\n`);
    return;
  }
  const issues = JSON.parse(gh(["issue", "list", "--repo", repo, "--state", "open", "--limit", "20",
    "--search", `"${ISSUE_TITLE}" in:title`, "--json", "number,title"]))
    .filter((issue) => issue.title === ISSUE_TITLE);
  let issueNumber = issues[0]?.number;
  if (!issueNumber) {
    const url = gh(["issue", "create", "--repo", repo, "--title", ISSUE_TITLE, "--body",
      "One comment a day: what merged, which database changes were applied, and what is waiting on Mason. " +
      "Posted by .github/workflows/daily-landing-summary.yml (scripts/daily-landing-summary.mjs)."]).trim();
    issueNumber = Number(url.split("/").pop());
  }
  gh(["issue", "comment", String(issueNumber), "--repo", repo, "--body", summary]);
  process.stdout.write(`Posted the daily landing summary to issue #${issueNumber}.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write(`daily-landing-summary: ${error?.message || error}\n`);
    process.exit(1);
  }
}
