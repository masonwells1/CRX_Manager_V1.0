#!/usr/bin/env node
// Sanctioned remediation path for a STALE applied-source ledger entry.
//
// The ledger (.claude/session-state/applied-source-ledger.json) records every
// apply_migration call so stop-wrap.mjs can refuse to end a session while a
// live-applied migration has no committed source (mistake class C3). Direct
// tool writes/deletes naming the ledger are denied by review-proof-guard.mjs —
// an alarm the agent can edit away is not a guard. This script is the one
// deliberate way to clear an entry that is genuinely stale (the apply failed
// and never landed, or the record was verified against the live ledger).
//
// ALWAYS verify against live FIRST:
//   select version, name from supabase_migrations.schema_migrations order by version;
//
// Usage:
//   node scripts/remove-applied-ledger-entry.mjs --list
//   node scripts/remove-applied-ledger-entry.mjs --name <exact-recorded-name>
//
// Removal is exact-name only (no globs, no --all): each entry must be
// consciously cleared one at a time. Runs against the ledger of the checkout
// it is invoked from.

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { withFileLock } from "../.claude/hooks/ledger-lock-lib.mjs";

function fail(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

let root = process.cwd();
try {
  root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
  }).trim() || root;
} catch { /* not a repo — fall back to cwd */ }

const ledgerPath = path.join(root, ".claude", "session-state", "applied-source-ledger.json");

const args = process.argv.slice(2);
const listMode = args.includes("--list");
const nameIdx = args.indexOf("--name");
const name = nameIdx !== -1 ? String(args[nameIdx + 1] || "") : "";

if (!listMode && !name) {
  fail("Usage: node scripts/remove-applied-ledger-entry.mjs --list | --name <exact-recorded-name>");
}

if (!existsSync(ledgerPath)) {
  process.stdout.write("Ledger file does not exist — nothing recorded, nothing to remove.\n");
  process.exit(listMode ? 0 : 1);
}

let entries;
try {
  entries = JSON.parse(readFileSync(ledgerPath, "utf8"));
} catch (e) {
  fail(`Ledger is unreadable/corrupt (${e?.message || e}) — refusing to touch it.`);
}
if (!Array.isArray(entries)) fail("Ledger is not an array — refusing to touch it.");

const printable = (v) => String(v ?? "").replace(/[^\x20-\x7E]/g, "?").slice(0, 100);

if (listMode) {
  if (entries.length === 0) {
    process.stdout.write("Ledger is empty.\n");
  } else {
    for (const e of entries) {
      process.stdout.write(
        `${printable(e?.name)}  (recorded ${printable(e?.ts) || "unknown"})` +
        `${e?.failed ? "  [apply reported an error]" : ""}${e?.sqlHash ? "" : "  [no content hash — legacy entry]"}\n`
      );
    }
  }
  process.exit(0);
}

const remaining = entries.filter((e) => !(e && e.name === name));
if (remaining.length === entries.length) {
  fail(`No ledger entry named exactly "${printable(name)}". Run with --list to see recorded names.`);
}

withFileLock(ledgerPath + ".lock", (locked) => {
  if (!locked) fail("Could not acquire the ledger lock — retry in a few seconds.");
  // Re-read under the lock so a concurrent recorder append is never dropped.
  let current;
  try {
    current = JSON.parse(readFileSync(ledgerPath, "utf8"));
  } catch {
    fail("Ledger changed and became unreadable while locking — refusing to touch it.");
  }
  if (!Array.isArray(current)) fail("Ledger is not an array — refusing to touch it.");
  const kept = current.filter((e) => !(e && e.name === name));
  if (kept.length === current.length) {
    fail(`Entry "${printable(name)}" disappeared before removal (another process pruned it?). Nothing changed.`);
  }
  const tmpPath = ledgerPath + "." + process.pid + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(kept, null, 2) + "\n");
  renameSync(tmpPath, ledgerPath);
  process.stdout.write(
    `Removed ${current.length - kept.length} entry(ies) named "${printable(name)}". ${kept.length} remain.\n` +
    `Reminder: this asserts the apply never landed (or its source is committed) — verified against\n` +
    `supabase_migrations.schema_migrations, not assumed.\n`
  );
});
