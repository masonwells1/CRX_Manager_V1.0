#!/usr/bin/env node
// Stop hook verification gate.
// Only emits the verification reminder if .ts/.tsx/.sql/.mjs/.js files in
// src/, supabase/migrations/, supabase/functions/, or scripts/ changed
// DURING THIS SESSION (not just dirty from before session start).

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch { /* fine */ }

const sessionId = payload?.session_id || "unknown";

let porcelainNow = "";
try {
  porcelainNow = execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  });
} catch {
  process.exit(0);
}

// Load the SessionStart snapshot (if any). If missing, fail closed = silent allow,
// to avoid false positives.
const snapPath = path.join(os.tmpdir(), "crx-claude-hooks", `session-${sessionId}.snapshot`);
let porcelainStart = "";
if (existsSync(snapPath)) {
  try { porcelainStart = readFileSync(snapPath, "utf8"); } catch { /* ignore */ }
} else {
  // No snapshot — first run after install or unknown session — stay silent
  process.exit(0);
}

// Build a set of "lines present at session start" so we only flag NEW lines.
// Porcelain lines look like "XY filename" — keying on the whole line catches
// both new files and status transitions (e.g. "M file" -> "MM file").
const startLines = new Set(porcelainStart.split("\n").map(l => l.replace(/[\r\n]/g, "")).filter(Boolean));

const codePathRe = /\.(ts|tsx|sql|mjs|js)\b/;
const watchedDirRe = /\b(src|supabase\/migrations|supabase\/functions|scripts)\//;

const newCodeChanges = porcelainNow
  .split("\n")
  .map(l => l.replace(/[\r\n]/g, ""))
  .filter(Boolean)
  .filter(l => !startLines.has(l))
  .filter(l => {
    const pathPart = l.length >= 4 ? l.slice(3) : "";
    const norm = pathPart.replace(/\\/g, "/").replace(/^"|"$/g, "");
    return codePathRe.test(norm) && watchedDirRe.test(norm);
  });

if (newCodeChanges.length === 0) {
  process.exit(0);
}

// Warn at most ONCE per distinct set of changes, so we don't block every turn
// in an infinite loop. We persist a marker keyed on the current change-set.
// If the change-set is unchanged since we last warned (i.e. the model already
// saw the reminder and presumably ran build/test), allow the stop to proceed.
// Only when NEW/different code changes appear do we warn again.
const changeKey = newCodeChanges.slice().sort().join("\n");
const markerPath = path.join(os.tmpdir(), "crx-claude-hooks", `session-${sessionId}.warned`);
let alreadyWarned = "";
if (existsSync(markerPath)) {
  try { alreadyWarned = readFileSync(markerPath, "utf8"); } catch { /* ignore */ }
}

if (alreadyWarned === changeKey) {
  // Same change-set we already warned about — don't re-block.
  process.exit(0);
}

// New or changed set — record it, then warn once.
try {
  mkdirSync(path.dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, changeKey, "utf8");
} catch { /* non-fatal: worst case we warn again next turn */ }

const reason = `Code files changed THIS SESSION in src/, supabase/migrations/, supabase/functions/, or scripts/:
${newCodeChanges.slice(0, 5).map(l => "  " + l).join("\n")}

Before declaring the work complete, run:
  npm run build
  npm run test

(This reminder fires once per change-set; it will not repeat unless new code changes appear.)`;

process.stdout.write(JSON.stringify({ decision: "block", reason }));
