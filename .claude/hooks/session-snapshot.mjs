#!/usr/bin/env node
// SessionStart hook: snapshot git status so the Stop hook can tell
// session-scoped changes from pre-existing WIP.

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch { /* no input — fine */ }

const sessionId = payload?.session_id || "unknown";

let porcelain = "";
try {
  porcelain = execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  });
} catch {
  process.exit(0);
}

const dir = path.join(os.tmpdir(), "crx-claude-hooks");
try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }

const snapPath = path.join(dir, `session-${sessionId}.snapshot`);
try {
  writeFileSync(snapPath, porcelain, "utf8");
} catch { /* ignore */ }

process.exit(0);
