#!/usr/bin/env node
// Stop hook: "Done = ran and proven" gate.
//
// Only engages when .ts/.tsx/.sql/.mjs/.js files under src/, supabase/migrations/,
// supabase/functions/, or scripts/ changed DURING THIS SESSION (diffed against the
// SessionStart snapshot — not files that were already dirty before the session).
//
// When such changes exist, it BLOCKS the stop unless the session transcript shows the
// change was actually RUN and OBSERVED in reality — a `PROOF —` block (Ran / Saw / Not
// verified) OR real end-state evidence (a browser preview, a WebFetch, a fetch of the
// live site, a SQL query). "npm run build/test passing" is deliberately NOT enough on
// its own: a self-written test can rubber-stamp the same misunderstanding that caused
// the bug. This is the #1 thing Mason corrects ("is it really live?", "the icons still
// aren't there", "are the branches actually merged?").
//
// SAFETY: it can NEVER trap the session. It blocks at most twice per distinct change-set
// (the honest PROOF block satisfies it immediately, and after 2 blocks it fails open), and
// any read error → silent allow.

import { readFileSync, existsSync, writeFileSync, mkdirSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { isWatchedCodeChange, hasVerificationEvidence } from "./stop-verify-lib.mjs";

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch { /* fine — fall through, most reads below fail open */ }

const sessionId = payload?.session_id || "unknown";
const transcriptPath = payload?.transcript_path || "";

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

// SessionStart snapshot: if missing, stay silent (avoid false positives on the
// first run after install / an unknown session).
const snapPath = path.join(os.tmpdir(), "crx-claude-hooks", `session-${sessionId}.snapshot`);
if (!existsSync(snapPath)) process.exit(0);
let porcelainStart = "";
try { porcelainStart = readFileSync(snapPath, "utf8"); } catch { process.exit(0); }

const startLines = new Set(
  porcelainStart.split("\n").map((l) => l.replace(/[\r\n]/g, "")).filter(Boolean)
);

const newCodeChanges = porcelainNow
  .split("\n")
  .map((l) => l.replace(/[\r\n]/g, ""))
  .filter(Boolean)
  .filter((l) => !startLines.has(l))
  .filter(isWatchedCodeChange);

if (newCodeChanges.length === 0) process.exit(0);

// Read the session transcript (tail only, to stay well under the 5s timeout on a
// large file) and check whether it shows real verification.
function readTail(file, maxBytes) {
  try {
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      const start = size > maxBytes ? size - maxBytes : 0;
      const len = size - start;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
      return buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

let transcriptText = "";
if (transcriptPath && existsSync(transcriptPath)) {
  transcriptText = readTail(transcriptPath, 600 * 1024);
}

// If we genuinely cannot read the transcript, fail OPEN — never trap the session
// because of a read problem.
if (!transcriptText) process.exit(0);

if (hasVerificationEvidence(transcriptText)) process.exit(0);

// No proof yet. Block — but bound it to at most 2 blocks per change-set so a
// stubborn/unprovable case can't freeze Mason's session.
const changeKey = newCodeChanges.slice().sort().join("\n");
const markerPath = path.join(os.tmpdir(), "crx-claude-hooks", `session-${sessionId}.proofwarn`);
let marker = { key: "", count: 0 };
if (existsSync(markerPath)) {
  try { marker = JSON.parse(readFileSync(markerPath, "utf8")); } catch { /* ignore */ }
}
const count = marker.key === changeKey ? (marker.count || 0) : 0;

if (count >= 2) {
  // Failed open after 2 nudges. Don't trap the session.
  process.exit(0);
}

try {
  mkdirSync(path.dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, JSON.stringify({ key: changeKey, count: count + 1 }), "utf8");
} catch { /* non-fatal */ }

const reason = `"DONE" NEEDS PROOF — code changed THIS SESSION but the transcript shows no real verification:
${newCodeChanges.slice(0, 5).map((l) => "  " + l).join("\n")}

"Tests pass" or "I changed the code" is NOT proof — a self-written test can rubber-stamp the
same misunderstanding that caused the bug. Before you finish, actually exercise the change and
observe the real end-state, then post a PROOF block:

  PROOF — Ran: <exact command / page / endpoint>
          Saw: <the literal result you observed>
          Not verified: <anything you could NOT check yourself + why>

Concrete proof by change type:
  • UI  → open the page with preview (preview_start + preview_screenshot / preview_inspect) and look
  • deploy → fetch https://croprxsolutions.app and confirm the served build hash changed
             (a 200 on a missing /assets/*.js is the SPA index.html false-positive — check content-type)
  • migration → smoke it: execute_sql  BEGIN; <migration>; ROLLBACK;  (+ plpgsql_check)
  • merge → git branch --merged origin/main  /  gh pr view
  • something only on Mason's machine (a desktop icon) → you CANNOT see it; say so under "Not verified"
    and ask Mason to click it and report — never assert it works.

(This fires at most twice per change-set; the honest PROOF block above clears it immediately.)`;

process.stdout.write(JSON.stringify({ decision: "block", reason }));
