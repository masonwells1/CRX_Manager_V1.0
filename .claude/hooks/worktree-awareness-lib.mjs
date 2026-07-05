// Pure helpers for worktree-awareness.mjs — the `git worktree list --porcelain`
// parser, isolated so it can be unit-tested without a real multi-worktree repo.

// Parse `git worktree list --porcelain` output into structured entries.
// Each record is a block of lines separated by a blank line, e.g.:
//   worktree C:/CRX_Manager
//   HEAD abc123...
//   branch refs/heads/main
// A detached worktree has a `detached` line instead of `branch`.
export function parseWorktreePorcelain(text) {
  const out = [];
  let cur = null;
  for (const rawLine of String(text || "").split("\n")) {
    const line = rawLine.replace(/[\r]/g, "");
    if (line.startsWith("worktree ")) {
      if (cur) out.push(cur);
      cur = { path: line.slice("worktree ".length).trim(), head: "", branch: null, detached: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      cur.detached = true;
    } else if (line === "" && cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Normalize a filesystem path for comparison (forward slashes, no trailing
// slash, lowercased — Windows paths are case-insensitive).
export function normPath(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

// Given parsed entries and the current worktree path, return the siblings
// (everything that isn't the current worktree).
export function siblingsOf(entries, currentPath) {
  const cur = normPath(currentPath);
  return entries.filter((e) => normPath(e.path) !== cur);
}

// ── Fleet helpers (shared by scripts/fleet-status.mjs and the SessionStart hook) ──

// Classify a `git merge-base --is-ancestor <sha> origin/main` exit status into the
// plain-English label both the hook and the fleet report use.
// status 0 = ancestor (merged), 1 = not an ancestor, anything else = git error.
export function mergedLabelFromStatus(status, hasOriginMain = true) {
  if (!hasOriginMain) return "merge-state unknown";
  if (status === 0) return "MERGED into origin/main";
  if (status === 1) return "UNMERGED (not in origin/main)";
  return "merge-state unknown";
}

// Is this filename a loop LEDGER doc (docs/loops/*ledger*.md)?
export function isLedgerDoc(name) {
  const n = String(name || "");
  return /\.md$/i.test(n) && /ledger/i.test(n);
}

// Is this filename a parked migration awaiting apply? (.sql, and not one that a
// session already marked SUPERSEDED — those are replaced, not waiting on anyone.)
export function isParkedMigrationFile(name) {
  const n = String(name || "");
  return /\.sql$/i.test(n) && !/^superseded/i.test(n);
}

// docs/audits variant: only *draft*.sql files there count as parked migrations.
export function isDraftSqlName(name) {
  return isParkedMigrationFile(name) && /draft/i.test(String(name || ""));
}

function truncateLine(s, maxLen) {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
}

// Last non-empty line of a text file (e.g. a ledger's most recent entry),
// trimmed and truncated so it fits on one report line.
export function lastNonEmptyLine(text, maxLen = 120) {
  const lines = String(text || "").split("\n").map((l) => l.replace(/\r/g, "").trim()).filter(Boolean);
  if (lines.length === 0) return "";
  return truncateLine(lines[lines.length - 1], maxLen);
}

// First `--` comment line of a SQL file (what the migration says it does),
// falling back to the first non-empty line when there is no comment.
export function firstCommentLine(sqlText, maxLen = 120) {
  const lines = String(sqlText || "").split("\n").map((l) => l.replace(/\r/g, "").trim()).filter(Boolean);
  if (lines.length === 0) return "";
  const comment = lines.find((l) => l.startsWith("--"));
  return truncateLine(comment ? comment.replace(/^-+\s*/, "") : lines[0], maxLen);
}

// The one-line fleet summary the SessionStart hook appends after the sibling list.
export function fleetSummaryLine(ledgerCount, parkedCount) {
  const l = Number(ledgerCount) || 0;
  const p = Number(parkedCount) || 0;
  return `Fleet: ${l} loop ledger${l === 1 ? "" : "s"} active · ${p} parked migration${p === 1 ? "" : "s"} awaiting apply — run /fleet for the full picture`;
}
