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

// docs/audits variant: parked audit drafts are *draft*.sql OR PARKED-*.sql
// (e.g. docs/audits/nightly-debug/parked-migrations/PARKED-01-....sql —
// Codex 2026-07-05: the draft-only match missed those).
export function isDraftSqlName(name) {
  return isParkedMigrationFile(name) && /draft|^parked[-_]/i.test(String(name || ""));
}

// A normal forward migration under supabase/migrations is not pending merely because
// a feature branch added it. It is surfaced as parked only when its leading SQL
// comment block says so explicitly. This permits a local, review-ready migration to
// appear in /fleet without turning every ordinary feature migration into an owner
// approval item.
export function hasExplicitParkedMigrationHeader(sqlText) {
  const header = [];
  for (const raw of String(sqlText || "").split("\n")) {
    const line = raw.replace(/\r/g, "").trim();
    if (!line) continue;
    if (!line.startsWith("--")) break;
    header.push(line.replace(/^--\s?/, ""));
  }
  return header.some((line) => /^(?:status:\s*)?(?:PARKED(?:\s+DRAFT)?(?:\s*$|\s*(?:\/|—|:|-)\s*(?:NOT\s+APPLIED|DO\s+NOT\s+APPLY)\b)|NOT\s+APPLIED(?=\s*$|\s*(?:\/|—|:|-)\s*DO\s+NOT\s+APPLY\b)|DO\s+NOT\s+APPLY(?=\s*$|\s*[—:-]))/i.test(line));
}

// Repo-relative path, normalized for comparison (forward slashes, no leading "./",
// lowercased — Windows paths are case-insensitive and git reports forward slashes).
export function normRepoPath(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .toLowerCase();
}

// The two folders a parked draft can live in, and the filename rule for each.
// scripts/.staging-migrations holds only migrations, so any .sql there is a draft;
// docs/audits holds ordinary audit prose too, so a .sql there must look like a draft.
const DRAFT_ROOTS = [
  { root: "scripts/.staging-migrations/", isDraft: isParkedMigrationFile },
  { root: "docs/audits/", isDraft: isDraftSqlName },
  { root: "supabase/migrations/", isDraft: (name, sqlText) => isParkedMigrationFile(name) && hasExplicitParkedMigrationHeader(sqlText) },
];

// Is this repo-relative path a parked migration draft? A normal forward migration
// requires its leading SQL-comment header as a second, deliberate safety signal.
export function isParkedDraftPath(repoRelPath, sqlText = "") {
  const p = normRepoPath(repoRelPath);
  if (!p) return false;
  const base = p.slice(p.lastIndexOf("/") + 1);
  const root = DRAFT_ROOTS.find((r) => p.startsWith(r.root));
  return root ? root.isDraft(base, sqlText) : false;
}

// Full-disk fallback scans encounter many ordinary files. Reject non-SQL names
// before reading them, then use the same explicit-header rule as the normal
// branch-owned reader. Both /fleet and SessionStart call this helper.
export function isParkedFallbackFile(repoRelPath, name, loadText = () => "") {
  if (!/\.sql$/i.test(String(name || ""))) return false;
  const p = normRepoPath(repoRelPath);
  return isParkedDraftPath(p, p.startsWith("supabase/migrations/") ? loadText() : "");
}

// Which of the paths a worktree CHANGED since its branch point are parked drafts?
//
// 2026-07-29: the count was permanently wrong. It scanned the working tree of EVERY
// checkout, and ~30 of Mason's worktrees are frozen review snapshots pinned to old
// commits. Once a draft file had ever existed, those snapshots kept reporting it forever —
// retiring it on main (the SUPERSEDED- rename) could never clear the count. Proven:
// renaming the last dead draft left the banner reading "2", unchanged, because 42 other
// checkouts still held the pre-rename filename.
//
// So a worktree now contributes only what IT changed since leaving origin/main, which the
// caller reads straight out of git:
//   `git diff --name-only <merge-base>`      — drafts this branch added OR edited, and
//   `git ls-files --others --exclude-standard` — drafts not yet under version control.
// Everything else in the checkout is inherited history: if main has since retired one,
// this checkout simply has not pulled the rename. Asking git also means an in-place EDIT
// of an inherited draft still counts (Codex HIGH on #279 — a path-existence test alone
// suppressed it), and eol/filemode normalization is git's problem, not ours.
//
// Detached checkouts go through the same test rather than being skipped wholesale: their
// frozen trees change nothing, so they contribute nothing, but a genuinely new draft
// written inside one is still surfaced (Codex MEDIUM on #279).
//
// Identity is the full path, never the basename — draft names repeat across hunts
// (PARKED-01-…, …-draft.sql), so a filename test would let a retired staging draft mask a
// brand-new audit one, and would also collapse two distinct pending drafts into one entry.
// `existsOnDisk(repoRelPath)` keeps deletions out: retiring a draft (the SUPERSEDED-
// rename) shows up in the diff as a change to the OLD path, and counting that would
// re-report the very file the rename retired.
//
// Returns a Map of normalized path → the path as git spelled it, so the count dedupes
// case-insensitively while /fleet still shows Mason the real filename.
export function parkedDraftPathsFrom(changedPaths, existsOnDisk = () => true, readText = () => "") {
  const out = new Map();
  for (const raw of changedPaths || []) {
    const p = String(raw || "").trim();
    if (!existsOnDisk(p)) continue;
    const normalized = normRepoPath(p);
    if (!isParkedDraftPath(p, normalized.startsWith("supabase/migrations/") ? readText(p) : "")) continue;
    const key = normRepoPath(p);
    if (!out.has(key)) out.set(key, p);
  }
  return out;
}

// The pathspec restricting git's diff/ls-files to draft folders and explicitly
// marked, local-only forward migrations. The content predicate above keeps ordinary
// supabase migrations out of the parked report.
export function draftPathspec() {
  return DRAFT_ROOTS.map((r) => r.root.replace(/\/$/, ""));
}

// Injected tree reader used when a worktree's merge-base is unreadable. With a
// usable origin/main tree, callers compare each fallback worktree's content to
// that tree before opening a file or evaluating its parked header. A null return
// means callers must retain conservative all-disk discovery and say so loudly.
export function originMainDraftPathSet(run) {
  const lines = run(["ls-tree", "-r", "--name-only", "origin/main", "--", ...draftPathspec()]);
  if (lines === null) return null;
  return new Set((lines || []).map(normRepoPath).filter(Boolean));
}

// A merge-base fallback cannot use path identity alone: a worktree may have changed
// an inherited parked draft in place. Callers obtain `changedPaths` with one exact
// `git diff --name-only origin/main -- <draft roots>` against that worktree. That
// content/blob comparison excludes only byte-identical inherited files; a failed
// comparison is UNKNOWN and conservatively retains every scanned path.
export function fallbackPathsAgainstOrigin(paths, originMainPaths, changedPaths) {
  const allPaths = [...(paths || [])].map((p) => String(p || "").trim()).filter(Boolean);
  if (!originMainPaths) {
    return { state: "unknown", paths: allPaths, reason: "origin/main draft tree is unavailable" };
  }
  if (changedPaths === null) {
    return { state: "unknown", paths: allPaths, reason: "origin/main content comparison is unreadable" };
  }
  const changed = new Set((changedPaths || []).map(normRepoPath).filter(Boolean));
  return {
    state: "known",
    paths: allPaths.filter((p) => !originMainPaths.has(normRepoPath(p)) || changed.has(normRepoPath(p))),
    reason: "",
  };
}

// Mainline can retain historical PARKED prose after an apply. It contributes
// only staging/audit draft paths in this cheap first pass. Forward migrations
// need the history-and-blob cross-reference below.
export function parkedMainlinePathsFrom(paths) {
  return [...(paths || [])].filter((raw) => {
    const p = String(raw || "").trim();
    return p && !normRepoPath(p).startsWith("supabase/migrations/") && isParkedDraftPath(p);
  });
}

// `migration-history.md` is the canonical B7 state record after a migration has
// landed. A parked forward migration on origin/main therefore needs two facts from
// the SAME immutable tree: an exact LOCAL CANDIDATE / NOT APPLIED history row and
// an explicit leading status header in that exact SQL blob. Parsing the timestamp
// column and a full backticked basename avoids fuzzy prose/timestamp matches.
export function localCandidateMigrationPathsFromHistory(historyText) {
  if (typeof historyText !== "string" || !historyText.trim()) {
    return { state: "unknown", paths: new Set(), reason: "migration history is unreadable" };
  }

  const paths = new Set();
  for (const raw of historyText.split("\n")) {
    const line = raw.replace(/\r/g, "").trim();
    if (!/^\|/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 3) continue;
    const detail = cells.slice(2).join(" | ");
    if (!/\bLOCAL\s+CANDIDATE\b[\s\S]*\bNOT\s+APPLIED\b/i.test(detail)) continue;

    const version = cells[1];
    if (!/^\d{14}$/.test(version)) {
      return { state: "unknown", paths: new Set(), reason: "LOCAL CANDIDATE history row has no exact migration timestamp column" };
    }
    const filenames = [...detail.matchAll(/`(\d{14}_[a-z0-9_]+\.sql)`/gi)].map((match) => match[1]);
    if (filenames.length !== 1 || !filenames[0].startsWith(`${version}_`)) {
      return { state: "unknown", paths: new Set(), reason: "LOCAL CANDIDATE history row has no single exact migration basename" };
    }
    const repoPath = normRepoPath(`supabase/migrations/${filenames[0]}`);
    if (paths.has(repoPath)) {
      return { state: "unknown", paths: new Set(), reason: "duplicate LOCAL CANDIDATE history rows name the same migration" };
    }
    paths.add(repoPath);
  }
  return { state: "known", paths, reason: "" };
}

// Mainline discovery intentionally reads SQL only for filenames the canonical
// origin/main history has already marked LOCAL CANDIDATE / NOT APPLIED. A stale
// applied header therefore cannot resurrect the old migration list. Broken links
// are fail-loud rather than a confident zero; staging/audit name-based drafts remain
// visible in the returned partial set.
export function parkedMainlineDiscoveryFrom(paths, historyText, loadText = () => null) {
  const mainlinePaths = [...(paths || [])].map((p) => String(p || "").trim()).filter(Boolean);
  const discovered = parkedMainlinePathsFrom(mainlinePaths);
  const history = localCandidateMigrationPathsFromHistory(historyText);
  if (history.state !== "known") return { ...history, paths: new Set(discovered) };

  const treeByPath = new Map();
  for (const p of mainlinePaths) {
    const key = normRepoPath(p);
    const list = treeByPath.get(key) || [];
    list.push(p);
    treeByPath.set(key, list);
  }
  for (const candidate of history.paths) {
    const matches = treeByPath.get(candidate) || [];
    if (matches.length !== 1) {
      return { state: "unknown", paths: new Set(discovered), reason: "LOCAL CANDIDATE history row does not map one-to-one to origin/main SQL" };
    }
    const sqlText = loadText(matches[0]);
    if (typeof sqlText !== "string") {
      return { state: "unknown", paths: new Set(discovered), reason: "LOCAL CANDIDATE SQL blob is unreadable from origin/main" };
    }
    if (!hasExplicitParkedMigrationHeader(sqlText)) {
      return { state: "unknown", paths: new Set(discovered), reason: "LOCAL CANDIDATE SQL lacks an explicit parked status header" };
    }
    discovered.push(matches[0]);
  }
  return { state: "known", paths: new Set(discovered), reason: "" };
}

// CI/correction guard used by the injected regression suite. Unlike the runtime
// discovery above, it may inspect the supplied forward-migration set to prove the
// candidate registry is one-to-one in both directions. Runtime deliberately avoids
// that broad blob scan so 76 historical headers cannot become a latency or false-list
// regression.
export function validateParkedMigrationCrossReferences(paths, historyText, loadText = () => null) {
  const history = localCandidateMigrationPathsFromHistory(historyText);
  if (history.state !== "known") return history;
  const historyRowsByVersion = new Map();
  for (const raw of String(historyText).split("\n")) {
    const line = raw.replace(/\r/g, "").trim();
    if (!/^\|/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 3 || !/^\d{14}$/.test(cells[1])) continue;
    const rows = historyRowsByVersion.get(cells[1]) || [];
    rows.push(cells.slice(2).join(" | "));
    historyRowsByVersion.set(cells[1], rows);
  }
  const headers = new Set();
  for (const raw of paths || []) {
    const p = String(raw || "").trim();
    const normalized = normRepoPath(p);
    if (!normalized.startsWith("supabase/migrations/") || !isParkedMigrationFile(p.slice(p.lastIndexOf("/") + 1))) continue;
    const sqlText = loadText(p);
    if (typeof sqlText !== "string") return { state: "unknown", paths: new Set(), reason: "forward migration SQL blob is unreadable" };
    if (!hasExplicitParkedMigrationHeader(sqlText)) continue;
    if (history.paths.has(normalized)) {
      headers.add(normalized);
      continue;
    }
    const version = p.slice(p.lastIndexOf("/") + 1).match(/^(\d{14})_/);
    const rows = version ? historyRowsByVersion.get(version[1]) || [] : [];
    if (!rows.some((row) => /\b(?:APPLIED\s+LIVE|RETIRED\s+CODE-ONLY\s+ARTIFACT|SUPERSEDED)\b/i.test(row))) {
      return { state: "unknown", paths: new Set(), reason: "parked header has no applied/retired history record for its migration version" };
    }
  }
  if (headers.size !== history.paths.size || [...headers].some((p) => !history.paths.has(p))) {
    return { state: "unknown", paths: new Set(), reason: "parked header and LOCAL CANDIDATE history registry are not one-to-one" };
  }
  return { state: "known", paths: history.paths, reason: "" };
}

// Builds the "what is THIS worktree pending?" reader that both the SessionStart hook and
// scripts/fleet-status.mjs use. It lives here, not in each reader, because the whole point
// of the 2026-07-29 fix is that the two report the same number — two copies differing only
// in a cwd variable would drift the moment either is touched (CodeRabbit on #279).
//
// Injected, so this file stays free of node:fs / node:child_process and stays unit-testable:
//   run(args, cwd)   → array of stdout lines, or null if git failed
//   repoRoot         → the main checkout; a clean worktree's diff is computed HERE
//   dirtyCount(path) → number of changed files, or null if unreadable
//   exists(wtPath, repoRelPath) → is the file still on disk in that worktree?
//   hasOriginMain    → false short-circuits everything to the caller's fallback scan
//
// Returns ownDraftPaths(entry) → Map(normalized path → git-spelled path), or null when the
// branch point cannot be read. null means "I don't know", and every caller must then scan
// the whole checkout rather than report nothing — under-reporting hides real pending work.
export function createOwnDraftPathsReader({ run, repoRoot, dirtyCount, exists, readText = () => "", hasOriginMain = true }) {
  // Where a worktree's branch left origin/main. Cached by HEAD sha — the ~30 frozen
  // snapshots share a handful of shas between them.
  const baseCache = new Map(); // sha → base sha | null
  function branchPoint(sha) {
    if (!hasOriginMain || !sha) return null;
    if (baseCache.has(sha)) return baseCache.get(sha);
    const out = run(["merge-base", "origin/main", sha], repoRoot);
    const base = out === null ? "" : String(out[0] || "").trim();
    const result = base || null;
    baseCache.set(sha, result);
    return result;
  }

  const cleanCache = new Map(); // head sha → changed paths | null

  return function ownDraftPaths(entry) {
    const base = branchPoint(entry.head);
    if (!base) return null;
    const spec = draftPathspec();
    const onDisk = (p) => exists(entry.path, p);
    const textOnDisk = (p) => readText(entry.path, p);

    // A CLEAN checkout holds nothing but its commits, so its pending set is fully
    // determined by base..HEAD — computable once per sha in the MAIN repo instead of
    // spawning git inside all 42 checkouts. That is what keeps the hook fast.
    if (dirtyCount(entry.path) === 0) {
      if (!cleanCache.has(entry.head)) {
        cleanCache.set(entry.head, run(["diff", "--name-only", base, entry.head, "--", ...spec], repoRoot));
      }
      const changed = cleanCache.get(entry.head);
      return changed === null ? null : parkedDraftPathsFrom(changed, onDisk, textOnDisk);
    }

    const changed = run(["diff", "--name-only", base, "--", ...spec], entry.path);
    const untracked = run(["ls-files", "--others", "--exclude-standard", "--", ...spec], entry.path);
    if (changed === null || untracked === null) return null;
    return parkedDraftPathsFrom([...changed, ...untracked], onDisk, textOnDisk);
  };
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
