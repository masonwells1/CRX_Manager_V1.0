#!/usr/bin/env node

// Mason's switch for the guarded-surface lock.
//
//     node scripts/guard-unlock.mjs --minutes 30
//     node scripts/guard-unlock.mjs --status
//     node scripts/guard-unlock.mjs --lock
//
// WHY A TTY IS REQUIRED — AND WHAT IT IS AND IS NOT
// -------------------------------------------------
// The lock exists because an agent that can edit a guard can disable it, and the
// same reasoning applies to the unlock. Requiring an interactive terminal plus a
// typed phrase stops the ORDINARY agent path: a non-interactive tool shell fails
// `isTTY` and cannot answer the prompt, so a prompt-injected "unlock the guards"
// hidden in a file gets nowhere.
//
// It is NOT a human-only gate, and must not be described as one (corrected
// 2026-08-31 after an exact-SHA review): an agent able to allocate a PTY
// satisfies `isTTY` and can supply stdin, and the phrase below is a literal in
// this file, not a secret. Treat this as a deliberate speed bump.
//
// The real protection for these paths is layered, not this switch alone: the
// `ask` entries in the permission manifest (a genuine denial for Edit/Write
// under `dontAsk`), this lock for tool-call writes including Bash, and — the
// only durable boundary — GitHub branch protection plus review. A guard that
// inspects tool arguments cannot stop code that an agent writes and then runs,
// because those writes happen inside that process with no tool call to inspect.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { UNLOCK_PHRASE, unlockValid } from "../.claude/hooks/guarded-surface-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, "..", ".claude", "session-state");
const UNLOCK_PATH = path.join(STATE_DIR, "guard-unlock.json");
const DEFAULT_MINUTES = 30;
const MAX_MINUTES = 240;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readUnlock() {
  try {
    return JSON.parse(readFileSync(UNLOCK_PATH, "utf8"));
  } catch {
    return null;
  }
}

function reportStatus() {
  const unlock = readUnlock();
  if (unlockValid(unlock, Date.now())) {
    const left = Math.max(0, Math.round((Date.parse(unlock.expiresAt) - Date.now()) / 60000));
    process.stdout.write(`UNLOCKED — guarded files are editable for ~${left} more minute(s) (until ${unlock.expiresAt}).\n`);
  } else {
    process.stdout.write("LOCKED — guarded enforcement files cannot be edited by an agent.\n");
  }
}

const args = process.argv.slice(2);

if (args.includes("--status")) {
  reportStatus();
  process.exit(0);
}

if (args.includes("--lock")) {
  try {
    rmSync(UNLOCK_PATH, { force: true });
  } catch { /* already gone */ }
  process.stdout.write("Re-locked. Guarded enforcement files are protected again.\n");
  process.exit(0);
}

const minutesFlagIndex = args.findIndex((a) => a === "--minutes" || a === "-m");
let minutes = DEFAULT_MINUTES;
if (minutesFlagIndex !== -1) {
  const raw = args[minutesFlagIndex + 1];
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) fail(`--minutes needs a positive whole number of minutes; got ${JSON.stringify(raw)}.`);
  if (parsed > MAX_MINUTES) fail(`--minutes is capped at ${MAX_MINUTES}; an unlock is meant to be short.`);
  minutes = parsed;
}

// The human gate. Both halves matter: isTTY rejects every agent shell, and the
// typed phrase rejects a stray `yes |` pipe into an interactive session.
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  fail([
    "REFUSED: guard-unlock needs a real interactive terminal.",
    "",
    "This is not a permission error you can retry or approve around — it is the",
    "whole mechanism. The guarded files protect live database and push access, so",
    "the switch that opens them is reserved for a human at a keyboard.",
    "",
    "Mason: open PowerShell or Git Bash in the repo and run:",
    "    node scripts/guard-unlock.mjs --minutes 30",
  ].join("\n"));
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
process.stdout.write([
  "",
  "You are about to UNLOCK the enforcement files for this repository:",
  "  .claude/hooks/**, .codex/hooks/**, hook registration and permission manifests,",
  "  .husky/**, .github/workflows/**, .coderabbit.yaml, package.json,",
  "  and the check/validate/verify and proof-generation scripts.",
  "",
  "While unlocked, an agent can change the code that guards your live database,",
  "your migrations, and your pushes. Unlock only while you are watching the work.",
  "",
  `This unlock will expire automatically after ${minutes} minute(s).`,
  "",
].join("\n"));

rl.question(`Type "${UNLOCK_PHRASE}" to confirm (anything else cancels): `, (answer) => {
  rl.close();
  if (String(answer).trim().toLowerCase() !== UNLOCK_PHRASE) {
    process.stdout.write("Cancelled — nothing was unlocked.\n");
    process.exit(1);
  }
  const now = Date.now();
  const record = {
    kind: "guarded-surface-unlock",
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + minutes * 60_000).toISOString(),
    minutes,
  };
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(UNLOCK_PATH, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  process.stdout.write([
    "",
    `UNLOCKED until ${record.expiresAt} (${minutes} minute(s)).`,
    "Re-lock early at any time with:  node scripts/guard-unlock.mjs --lock",
    "",
  ].join("\n"));
});
