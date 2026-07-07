#!/usr/bin/env node
// Mission-doc validator — enforces Mason's recorded loop-harness spec
// (memory: feedback_capture-loop-harness-spec): every loop/mission doc must
// fill FIVE slots before any session runs it — no ad-hoc variants:
//
//   Driver · Granularity · Worktree · Definition of done · Delivery gate
//
// A slot counts as PRESENT when its label appears (case-insensitive) in a
// markdown heading (`# ...` through `###### ...`) or inside a **bold label**
// on one line. That matches how the existing docs/loops/ mission specs are
// written ("## Definition of done", "**You are:** ... worktree ...").
//
// Extra (warn-only, never fails the doc): if the doc names a worktree path,
// warn when that path doesn't exist on disk, or when `git worktree list`
// shows it checked out on a DIFFERENT branch than the doc states — another
// session may own it.
//
// Usage:  node scripts/validate-mission-doc.mjs docs/loops/<mission>.md
// Exit:   0 = all five slots found ("MISSION DOC OK"; warnings don't fail)
//         1 = one or more slots missing (prints a fill-in template)
//         2 = usage error / unreadable file
// Deps:   none (node builtins only).

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

const docArg = process.argv[2];
if (!docArg) {
  console.error("Usage: node scripts/validate-mission-doc.mjs <path-to-mission-doc.md>");
  process.exit(2);
}
const docPath = path.isAbsolute(docArg) ? docArg : path.join(root, docArg);

let text;
try {
  text = readFileSync(docPath, "utf8");
} catch {
  console.error(`ERROR — cannot read mission doc: ${docPath}`);
  process.exit(2);
}

// ─── The five required slots (label + fill-in hint for the template) ──────
const SLOTS = [
  {
    label: "Driver",
    hint: "who drives each cycle (Claude autonomous? Codex as driver? Mason gates?) — quote Mason's words — and what triggers the next cycle",
  },
  {
    label: "Granularity",
    hint: "how big one reviewed unit of work is (per item / per section / per migration / per commit) before the next Codex review + ledger update",
  },
  {
    label: "Worktree",
    hint: "the dedicated worktree path + branch this loop OWNS (e.g. C:\\CRX_Foo, branch fix/foo-2026-07) — never a shared tree; check `git worktree list` first",
  },
  {
    label: "Definition of done",
    hint: "the condition that ENDS the loop — e.g. every worklist item DONE (proven + Codex-clean + committed) or PARKED with reason, ledger complete with a handoff for Mason",
  },
  {
    label: "Delivery gate",
    hint: "what NEVER happens without Mason's explicit OK — live migration apply, edge-function deploy, data deletion, merge/push to main",
  },
];

// A slot is present when its label appears in a heading line or a bold span.
// Whitespace inside multi-word labels is flexible ("Definition of Done" etc.).
function slotPresent(label) {
  const esc = label
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  const heading = new RegExp(`^#{1,6}[^\\n]*\\b${esc}\\b`, "im");
  const bold = new RegExp(`\\*\\*[^*\\n]*\\b${esc}\\b[^*\\n]*\\*\\*`, "i");
  return heading.test(text) || bold.test(text);
}

const found = SLOTS.filter(s => slotPresent(s.label));
const missing = SLOTS.filter(s => !slotPresent(s.label));

// ─── Warn-only worktree sanity (fail-open — a warning never blocks) ───────
const warnings = [];
let statedPath = null;
for (const line of text.split("\n")) {
  if (!/worktree/i.test(line)) continue;
  const m = line.match(/([A-Za-z]:[\\/][^\s`"'),;|]+)/);
  if (m) {
    statedPath = m[1].replace(/[.,:]+$/, "");
    break;
  }
}
const branchMatch = text.match(/branch[^\n`]*`([^`\n]+)`/i);
const statedBranch = branchMatch ? branchMatch[1].trim() : null;

if (statedPath) {
  if (!existsSync(statedPath)) {
    warnings.push(
      `stated worktree path does not exist on disk yet: ${statedPath} ` +
      `(fine if the loop's Step 0 creates it — otherwise create it before launching)`
    );
  }
  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], cwd: root,
    });
    // Porcelain entries: "worktree <path>" then "HEAD <sha>" then
    // "branch refs/heads/<name>" (or "detached").
    const entries = [];
    let cur = null;
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) {
        cur = { path: line.slice("worktree ".length).trim(), branch: null };
        entries.push(cur);
      } else if (cur && line.startsWith("branch ")) {
        cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
      }
    }
    const norm = p => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const entry = entries.find(e => norm(e.path) === norm(statedPath));
    if (entry && statedBranch && entry.branch && entry.branch !== statedBranch) {
      warnings.push(
        `worktree ${statedPath} is checked out on branch '${entry.branch}' but the doc states ` +
        `'${statedBranch}' — another session may own that tree; check with Mason before launching`
      );
    }
  } catch { /* no git / timeout — warn-only feature, skip silently */ }
}

// ─── Report ────────────────────────────────────────────────────────────────
const rel = path.relative(root, docPath) || docPath;
console.log(`── validate-mission-doc ── ${rel}`);
for (const s of SLOTS) {
  console.log(`  ${missing.includes(s) ? "✗ MISSING" : "✓ found  "}  ${s.label}`);
}
for (const w of warnings) {
  console.log(`  ⚠ WARNING  ${w}`);
}

if (missing.length === 0) {
  console.log(`MISSION DOC OK — all 5 loop-harness slots present (${found.map(s => s.label).join(", ")}).`);
  process.exit(0);
}

console.log("");
console.log(`MISSION DOC INCOMPLETE — missing ${missing.length} of the 5 required slots: ${missing.map(s => s.label).join(", ")}.`);
console.log("Mason's loop-harness spec: every loop confirms DRIVER / GRANULARITY / WORKTREE /");
console.log("DEFINITION OF DONE / DELIVERY GATE before any code runs — no ad-hoc variants.");
console.log("Fix the mission doc WITH Mason, then re-run. Fill-in template for the missing slot(s):");
console.log("");
for (const s of missing) {
  console.log(`## ${s.label}`);
  console.log(`<${s.hint}>`);
  console.log("");
}
process.exit(1);
