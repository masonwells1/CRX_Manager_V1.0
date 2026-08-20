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
  // A UTF-8 BOM is an encoding marker, not migration content. Tolerate it only
  // at byte zero so PowerShell-written SQL cannot disappear from the parked scan.
  const text = String(sqlText || "").replace(/^\uFEFF/, "");
  for (const raw of text.split("\n")) {
    // Keep the parser and the Git prefilter on portable whitespace: a status line
    // may indent or pad with ASCII space/tab, never Unicode whitespace such as NBSP.
    const line = raw.replace(/\r/g, "").replace(/^[ \t]+|[ \t]+$/g, "");
    if (!line) continue;
    if (!line.startsWith("--")) break;
    header.push(line.replace(/^--[ \t]*/, ""));
  }
  return header.some((line) => /^(?:status:[ \t]*)?(?:PARKED(?:[ \t]+DRAFT)?(?:[ \t]*$|[ \t]*(?:\/|—|-)[ \t]*(?:NOT[ \t]+APPLIED|DO[ \t]+NOT[ \t]+APPLY)\b|[ \t]*:[ \t]*(?=[^\r\n]*\b(?:NOT[ \t]+APPLIED|DO[ \t]+NOT[ \t]+APPLY)\b))|NOT[ \t]+APPLIED(?=[ \t]*$|[ \t]*(?:\/|—|:|-)[ \t]*DO[ \t]+NOT[ \t]+APPLY\b)|DO[ \t]+NOT[ \t]+APPLY(?=[ \t]*$|[ \t]*[—:-]))/i.test(line));
}

// This is a safe, anchored superset of parser-accepted leading SQL status lines.
// Git cannot enforce the parser's first-comment-block window, so the SQL blob is
// still opened and passed through hasExplicitParkedMigrationHeader before it counts.
// POSIX blank means portable ASCII space/tab, matching the parser exactly.
export const ORIGIN_MAIN_PARKED_MIGRATION_GREP_ARGS = [
  "grep", "-l", "-i", "-E",
  "-e", "^(\uFEFF)?[[:blank:]]*--[[:blank:]]*(STATUS:[[:blank:]]*)?(PARKED|NOT[[:blank:]]+APPLIED|DO[[:blank:]]+NOT[[:blank:]]+APPLY)",
  "origin/main", "--", "supabase/migrations",
];

// `git grep` uses exit code 1 for the healthy case where no file matched. Both
// runtime consumers share this wrapper so only a real error/timeout falls back
// to a complete forward scan.
export function originMainParkedMigrationPrefilter(runGrep) {
  try {
    const output = String(runGrep() || "");
    return {
      state: "known",
      paths: output.split("\n").filter(Boolean).map((p) => p.replace(/^origin\/main:/i, "")),
    };
  } catch (error) {
    if (Number(error?.status) === 1) return { state: "known", paths: [] };
    return { state: "unknown", paths: null };
  }
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

// `git cat-file --batch` buffers every requested blob before returning. The full
// forward-migration fallback is currently about 10.5 MiB, so 32 MiB leaves room
// for normal growth while retaining a deliberate finite fail-closed ceiling.
export const ORIGIN_MAIN_CAT_FILE_MAX_BUFFER = 32 * 1024 * 1024;

// Keep the batch input and output framing in one testable helper. `%(rest)`
// echoes this exact path after Git's object header, so every returned record is
// bound to the expected path and order instead of being assigned positionally.
function originMainBatchPaths(paths) {
  const unique = [];
  const seen = new Set();
  for (const raw of paths || []) {
    const p = String(raw || "").trim();
    const key = normRepoPath(p);
    // The line-oriented Git batch protocol cannot safely represent these names.
    // Treat them as unreadable rather than silently scanning a different path.
    if (!p || !key || /\s/.test(p) || seen.has(key)) return null;
    seen.add(key);
    unique.push(p);
  }
  return unique;
}

export function originMainSqlBlobMap(paths, runBatch, maxBuffer = ORIGIN_MAIN_CAT_FILE_MAX_BUFFER) {
  const uniquePaths = originMainBatchPaths(paths);
  if (uniquePaths === null || !Number.isSafeInteger(maxBuffer) || maxBuffer < 1) return null;
  if (uniquePaths.length === 0) return new Map();

  let output;
  try {
    // The tab splits the object expression from `%(rest)`; the latter is checked
    // below before a blob can be associated with a requested path.
    const input = Buffer.from(`${uniquePaths.map((p) => `origin/main:${p}\t${p}`).join("\n")}\n`, "utf8");
    output = runBatch(input, uniquePaths);
  } catch {
    return null;
  }
  if (!Buffer.isBuffer(output) || output.length > maxBuffer) return null;

  const blobs = new Map();
  let offset = 0;
  for (const expectedPath of uniquePaths) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) return null;
    const header = output.subarray(offset, headerEnd).toString("utf8");
    const match = header.match(/^([0-9a-f]{40,64}) blob (\d+) (.+)$/);
    if (!match || match[3] !== expectedPath) return null;
    const size = Number(match[2]);
    const bodyStart = headerEnd + 1;
    const bodyEnd = bodyStart + size;
    // A complete batch record is header LF, exactly `size` body bytes, then LF.
    if (!Number.isSafeInteger(size) || bodyEnd >= output.length || output[bodyEnd] !== 0x0a) return null;
    blobs.set(normRepoPath(expectedPath), output.subarray(bodyStart, bodyEnd).toString("utf8"));
    offset = bodyEnd + 1;
  }
  // No extra, truncated, or unframed data may be ignored after the final record.
  return offset === output.length ? blobs : null;
}

export function originMainForwardBlobPaths(treePaths, prefilterPaths, localCandidatePaths = []) {
  // Exact LOCAL CANDIDATE paths must be read even if their SQL lacks a parked
  // header; otherwise that actionable cross-reference defect looks like an
  // unreadable blob merely because the prefilter did not select it.
  const candidates = prefilterPaths === null
    ? treePaths
    : [...(prefilterPaths || []), ...(localCandidatePaths || [])];
  const seen = new Set();
  return (candidates || []).filter((p) => {
    const normalized = normRepoPath(p);
    const name = String(p || "").slice(String(p || "").lastIndexOf("/") + 1);
    if (!normalized.startsWith("supabase/migrations/") || !isParkedMigrationFile(name) || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
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
// before reading them, then use the same explicit-header or verified history-pin
// rule as the normal branch-owned reader. Both /fleet and SessionStart call this.
export function parkedFallbackFileDiscovery(
  repoRelPath,
  name,
  loadText = () => "",
  historyText = null,
  sha256Text = null,
  parsedHistory = null,
) {
  if (!/\.sql$/i.test(String(name || ""))) {
    return { state: "known", parked: false, reason: "" };
  }
  const p = normRepoPath(repoRelPath);
  if (!p.startsWith("supabase/migrations/")) {
    return { state: "known", parked: isParkedDraftPath(p), reason: "" };
  }
  const parked = parkedDraftPathsFrom(
    [p],
    () => true,
    () => loadText(),
    historyText,
    sha256Text,
    parsedHistory,
  );
  return {
    state: parked.unknownReason ? "unknown" : "known",
    parked: parked.has(p),
    reason: parked.unknownReason || "",
  };
}

// A degraded worktree may contain hundreds of migrations. Parse its history once,
// then reuse that immutable result for every file classification; reparsing the
// 600+ KiB history per SQL file can consume the SessionStart hook's entire budget.
export function createParkedFallbackClassifier(
  historyText = null,
  sha256Text = null,
  parseHistory = localCandidateMigrationPathsFromHistory,
) {
  const parsedHistory = parseHistory(historyText);
  return (repoRelPath, name, loadText = () => "") => parkedFallbackFileDiscovery(
    repoRelPath,
    name,
    loadText,
    historyText,
    sha256Text,
    parsedHistory,
  );
}

export function isParkedFallbackFile(
  repoRelPath,
  name,
  loadText = () => "",
  historyText = null,
  sha256Text = null,
  parsedHistory = null,
) {
  return parkedFallbackFileDiscovery(
    repoRelPath,
    name,
    loadText,
    historyText,
    sha256Text,
    parsedHistory,
  ).parked;
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
export function parkedDraftPathsFrom(
  changedPaths,
  existsOnDisk = () => true,
  readText = () => "",
  historyText = null,
  sha256Text = null,
  parsedHistory = null,
  originMainCandidatePaths = null,
) {
  const out = new Map();
  const history = parsedHistory ?? localCandidateMigrationPathsFromHistory(historyText);
  let unknownReason = "";
  // Every normalized path the loop actually looked at. The registry reconciliation
  // below needs it: a LOCAL CANDIDATE row whose SQL never entered this diff at all
  // is invisible to a loop that only walks changed paths.
  const visited = new Set();
  for (const raw of changedPaths || []) {
    const p = String(raw || "").trim();
    visited.add(normRepoPath(p));
    if (!existsOnDisk(p)) {
      // A vanished path is normally just a retired draft — the SUPERSEDED- rename
      // shows up in the diff as a change to the OLD path, and counting it would
      // re-report the very file the rename retired. But if this branch's own
      // migration-history still registers that path as a LOCAL CANDIDATE, the
      // registry now points at SQL nobody can read, and skipping it silently makes
      // /fleet report a confident zero over a dangling pin. Say UNKNOWN instead;
      // "I don't know" sends the caller to a full scan, and under-reporting hides
      // real pending work. This is an O(1) set lookup on a path already in hand,
      // not the broad blob scan runtime deliberately avoids.
      if (history?.state === "known" && history.paths.has(normRepoPath(p))) {
        unknownReason ||= "branch-owned LOCAL CANDIDATE SQL named by migration history is missing from disk";
      }
      continue;
    }
    const normalized = normRepoPath(p);
    const isForwardMigration = normalized.startsWith("supabase/migrations/");
    const sqlText = isForwardMigration ? readText(p) : "";
    let isParked = isParkedDraftPath(p, sqlText);

    // A branch can deliberately park an ordinary forward migration without adding a
    // comment-only SQL diff. In that case its own migration-history row is the second
    // signal, exactly as it is after the branch lands on origin/main. Verify the pin
    // before surfacing it; an unreadable or mismatched candidate makes the branch state
    // UNKNOWN instead of silently disappearing from /fleet.
    if (isForwardMigration) {
      if (history?.state !== "known") {
        unknownReason ||= history?.reason || "worktree migration history is unreadable";
      } else if (history.paths.has(normalized)) {
        const expectedSha256 = history.sha256ByPath?.get(normalized);
        if (!expectedSha256 && !isParked) {
          unknownReason ||= "branch-owned LOCAL CANDIDATE SQL lacks an explicit parked status header or SQL sha256 pin";
        } else if (expectedSha256 && typeof sha256Text !== "function") {
          unknownReason ||= "branch-owned LOCAL CANDIDATE SQL sha256 pin cannot be verified";
        } else if (expectedSha256 && sha256Text(sqlText) !== expectedSha256) {
          unknownReason ||= "branch-owned LOCAL CANDIDATE SQL sha256 does not match migration history";
        } else if (expectedSha256) {
          isParked = true;
        }
      }
    }
    if (!isParked) continue;
    const key = normRepoPath(p);
    if (!out.has(key)) out.set(key, p);
  }

  // Reconcile the branch's own history additions against the diff OUTSIDE the loop.
  // Both checks above only fire for a path the diff already handed us, so a caller
  // whose changed-path list is empty — or whose list simply never mentions a
  // registered candidate — got a confident zero over a claim this code never read
  // (Codex on #369). If the diff cannot account for every branch-owned row, the
  // honest answer is UNKNOWN, which sends the caller to a full scan. Under-reporting
  // hides real pending work; an extra scan only costs time.
  if (historyText !== null) {
    if (history?.state !== "known") {
      unknownReason ||= history?.reason || "worktree migration history is unreadable";
    } else {
      for (const candidate of history.paths) {
        // A candidate already present on origin/main is reconciled by the
        // mainline discovery path shared by /fleet and SessionStart. Requiring
        // every branch to repeat that mainline path in its own diff is
        // unsatisfiable, because a path inherited from origin/main cannot be
        // branch-owned. Only exact, successfully-read origin/main paths are
        // exempt; an absent or unreadable mainline path remains fail-closed.
        if (visited.has(candidate) || originMainCandidatePaths?.has(candidate)) continue;
        unknownReason ||= "branch-owned LOCAL CANDIDATE SQL named by migration history is absent from this branch's own-draft diff";
        break;
      }
    }
  }

  Object.defineProperty(out, "unknownReason", { value: unknownReason, enumerable: false });
  return out;
}

// A SUPERSEDED draft is not waiting for apply, but /fleet must count branch-owned
// replacements that it intentionally ignores. Apply the identical changed-path and
// on-disk rules so frozen historical worktrees cannot inflate this healthy-path count.
export function supersededDraftPathsFrom(changedPaths, existsOnDisk = () => true) {
  const out = new Map();
  for (const raw of changedPaths || []) {
    const p = String(raw || "").trim();
    const normalized = normRepoPath(p);
    const name = p.slice(p.lastIndexOf("/") + 1);
    if (!p || !existsOnDisk(p) || !/^superseded.*\.sql$/i.test(name)) continue;
    if (!DRAFT_ROOTS.some((root) => normalized.startsWith(root.root))) continue;
    if (!out.has(normalized)) out.set(normalized, p);
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
// either an explicit leading status header or a matching SQL sha256 pin in that row.
// The hash form classifies an already-reviewed candidate without creating a
// comment-only migration diff. Parsing the timestamp column and a full backticked
// basename avoids fuzzy prose/timestamp matches.
export function localCandidateMigrationPathsFromHistory(historyText) {
  if (typeof historyText !== "string" || !historyText.trim()) {
    return { state: "unknown", paths: new Set(), reason: "migration history is unreadable" };
  }

  const paths = new Set();
  const sha256ByPath = new Map();
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
    const sha256Pins = [...detail.matchAll(/\bSQL\s+sha256\s*:?\s*`([a-f0-9]{64})`/gi)]
      .map((match) => match[1].toLowerCase());
    if (sha256Pins.length > 1) {
      return { state: "unknown", paths: new Set(), reason: "LOCAL CANDIDATE history row has multiple SQL sha256 pins" };
    }
    paths.add(repoPath);
    if (sha256Pins.length === 1) sha256ByPath.set(repoPath, sha256Pins[0]);
  }
  return { state: "known", paths, sha256ByPath, reason: "" };
}

function historyRowsByMigrationBasename(historyText) {
  const rowsByBasename = new Map();
  for (const raw of String(historyText).split("\n")) {
    const line = raw.replace(/\r/g, "").trim();
    if (!/^\|/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 3 || !/^\d{14}$/.test(cells[1])) continue;
    const detail = cells.slice(2).join(" | ");
    const basenames = new Set([...detail.matchAll(/`(\d{14}_[a-z0-9_]+\.sql)`/gi)]
      .map((match) => match[1].toLowerCase())
      .filter((basename) => basename.startsWith(`${cells[1]}_`)));
    if (basenames.size !== 1) continue;
    const basename = [...basenames][0];
    const rows = rowsByBasename.get(basename) || [];
    rows.push(detail);
    rowsByBasename.set(basename, rows);
  }
  return rowsByBasename;
}

// Mainline discovery reads the exact LOCAL CANDIDATE blobs plus a complete, cheap
// prefilter of origin/main forward migrations whose content contains "PARKED". That
// makes an orphaned explicit parked header fail loud without opening every migration.
// A stale header with an exact APPLIED/RETIRED/SUPERSEDED history row still self-clears;
// staging/audit name-based drafts remain visible in every partial result.
export function parkedMainlineDiscoveryFrom(
  paths,
  historyText,
  loadText = () => null,
  possibleParkedMigrationPaths = null,
  sha256Text = null,
) {
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
    const expectedSha256 = history.sha256ByPath?.get(candidate);
    if (expectedSha256) {
      if (typeof sha256Text !== "function") {
        return { state: "unknown", paths: new Set(discovered), reason: "LOCAL CANDIDATE SQL sha256 pin cannot be verified" };
      }
      if (sha256Text(sqlText) !== expectedSha256) {
        return { state: "unknown", paths: new Set(discovered), reason: "LOCAL CANDIDATE SQL sha256 does not match migration history" };
      }
    } else if (!hasExplicitParkedMigrationHeader(sqlText)) {
      return { state: "unknown", paths: new Set(discovered), reason: "LOCAL CANDIDATE SQL lacks an explicit parked status header or SQL sha256 pin" };
    }
    discovered.push(matches[0]);
  }

  const historyRowsByBasename = historyRowsByMigrationBasename(historyText);

  // `null` is the conservative unit-test/fallback mode: inspect every forward
  // migration. Production passes the complete shared origin/main grep prefilter,
  // which covers every explicit status form accepted by the parser.
  const headerProbePaths = possibleParkedMigrationPaths === null ? mainlinePaths : possibleParkedMigrationPaths;
  const seenProbePaths = new Set();
  for (const raw of headerProbePaths || []) {
    const normalized = normRepoPath(raw);
    if (seenProbePaths.has(normalized)) continue;
    seenProbePaths.add(normalized);
    if (!normalized.startsWith("supabase/migrations/") || !isParkedMigrationFile(String(raw).slice(String(raw).lastIndexOf("/") + 1))) continue;
    if (history.paths.has(normalized)) continue; // already read and verified above
    const matches = treeByPath.get(normalized) || [];
    if (matches.length !== 1) {
      return { state: "unknown", paths: new Set(discovered), reason: "possible parked forward migration does not map one-to-one to origin/main SQL" };
    }
    const sqlText = loadText(matches[0]);
    if (typeof sqlText !== "string") {
      return { state: "unknown", paths: new Set(discovered), reason: "possible parked forward migration SQL blob is unreadable from origin/main" };
    }
    if (!hasExplicitParkedMigrationHeader(sqlText)) continue;
    const basename = matches[0].slice(matches[0].lastIndexOf("/") + 1).toLowerCase();
    const rows = historyRowsByBasename.get(basename) || [];
    if (!rows.some((row) => /\b(?:APPLIED\s+LIVE|RETIRED\s+CODE-ONLY\s+ARTIFACT|SUPERSEDED)\b/i.test(row))) {
      return { state: "unknown", paths: new Set(discovered), reason: "parked forward header has no LOCAL CANDIDATE or applied/retired history record" };
    }
  }
  return { state: "known", paths: new Set(discovered), reason: "" };
}

// CI/correction guard used by the injected regression suite. Unlike the runtime
// discovery above, it may inspect the supplied forward-migration set to prove the
// candidate registry is one-to-one in both directions. Runtime deliberately avoids
// that broad blob scan so 76 historical headers cannot become a latency or false-list
// regression.
export function validateParkedMigrationCrossReferences(paths, historyText, loadText = () => null, sha256Text = null) {
  const history = localCandidateMigrationPathsFromHistory(historyText);
  if (history.state !== "known") return history;
  const historyRowsByBasename = historyRowsByMigrationBasename(historyText);
  const verifiedCandidates = new Set();
  for (const raw of paths || []) {
    const p = String(raw || "").trim();
    const normalized = normRepoPath(p);
    if (!normalized.startsWith("supabase/migrations/") || !isParkedMigrationFile(p.slice(p.lastIndexOf("/") + 1))) continue;
    const sqlText = loadText(p);
    if (typeof sqlText !== "string") return { state: "unknown", paths: new Set(), reason: "forward migration SQL blob is unreadable" };
    if (history.paths.has(normalized)) {
      const expectedSha256 = history.sha256ByPath?.get(normalized);
      if (expectedSha256) {
        if (typeof sha256Text !== "function") {
          return { state: "unknown", paths: new Set(), reason: "LOCAL CANDIDATE SQL sha256 pin cannot be verified" };
        }
        if (sha256Text(sqlText) !== expectedSha256) {
          return { state: "unknown", paths: new Set(), reason: "LOCAL CANDIDATE SQL sha256 does not match migration history" };
        }
        verifiedCandidates.add(normalized);
      } else if (hasExplicitParkedMigrationHeader(sqlText)) {
        verifiedCandidates.add(normalized);
      }
      continue;
    }
    if (!hasExplicitParkedMigrationHeader(sqlText)) continue;
    const basename = p.slice(p.lastIndexOf("/") + 1).toLowerCase();
    const rows = historyRowsByBasename.get(basename) || [];
    if (!rows.some((row) => /\b(?:APPLIED\s+LIVE|RETIRED\s+CODE-ONLY\s+ARTIFACT|SUPERSEDED)\b/i.test(row))) {
      return { state: "unknown", paths: new Set(), reason: "parked header has no applied/retired history record for its migration version" };
    }
  }
  if (verifiedCandidates.size !== history.paths.size || [...verifiedCandidates].some((p) => !history.paths.has(p))) {
    return { state: "unknown", paths: new Set(), reason: "parked marker and LOCAL CANDIDATE history registry are not one-to-one" };
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
// branch point cannot be read. The returned Map also exposes a non-enumerable
// `supersededPaths` Map for the fleet's ignored-draft diagnostic. null means "I don't know",
// and every caller must then scan the whole checkout rather than report nothing —
// under-reporting hides real pending work.
export function createOwnDraftPathsReader({
  run,
  repoRoot,
  dirtyCount,
  exists,
  readText = () => "",
  sha256Text = null,
  hasOriginMain = true,
}) {
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
  const cleanHistoryCache = new Map(); // head sha → added migration-history rows | null
  // The same LOCAL CANDIDATE rows appear in every inherited copy of the shared
  // history document. Resolve each exact origin/main path once, then reuse that
  // attribution across the whole fleet instead of spawning one Git process per
  // worktree. `null` is deliberately retained as non-exempt: an unreadable
  // origin/main must still leave the per-worktree reconciliation UNKNOWN.
  const originMainCandidateCache = new Map(); // normalized candidate → true | false | null

  function originMainCandidatePaths(history) {
    const accounted = new Set();
    if (history?.state !== "known") return accounted;
    for (const candidate of history.paths) {
      let known = originMainCandidateCache.get(candidate);
      if (known === undefined) {
        const listed = run(["ls-tree", "-r", "--name-only", "origin/main", "--", candidate], repoRoot);
        known = listed === null
          ? null
          : listed.some((path) => normRepoPath(path) === candidate);
        originMainCandidateCache.set(candidate, known);
      }
      if (known === true) accounted.add(candidate);
    }
    return accounted;
  }

  // `migration-history.md` is shared mainline state, not a branch-owned claim.
  // Reconcile only rows this branch added since its merge base. This keeps an
  // inherited mainline candidate from demanding an impossible appearance in
  // every descendant branch's own-draft diff, while leaving a branch's actual
  // unaccounted candidate fail-closed below.
  function ownHistoryText(entry, base) {
    const args = dirtyCount(entry.path) === 0
      ? ["diff", "--unified=0", base, entry.head, "--", "docs/reference/migration-history.md"]
      : ["diff", "--unified=0", base, "--", "docs/reference/migration-history.md"];
    let patch;
    if (dirtyCount(entry.path) === 0) {
      if (!cleanHistoryCache.has(entry.head)) cleanHistoryCache.set(entry.head, run(args, repoRoot));
      patch = cleanHistoryCache.get(entry.head);
    } else {
      patch = run(args, entry.path);
    }
    if (patch === null) return null;
    return patch
      .filter((line) => String(line).startsWith("+|"))
      .map((line) => String(line).slice(1))
      .join("\n");
  }

  function resultFrom(changed, onDisk, textOnDisk, historyText) {
    // An empty patch is a known empty set, not an unreadable history file.
    const history = historyText === ""
      ? { state: "known", paths: new Set(), sha256ByPath: new Map(), reason: "" }
      : localCandidateMigrationPathsFromHistory(historyText);
    const parked = parkedDraftPathsFrom(
      changed,
      onDisk,
      textOnDisk,
      historyText,
      sha256Text,
      history,
      originMainCandidatePaths(history),
    );
    Object.defineProperty(parked, "supersededPaths", {
      value: supersededDraftPathsFrom(changed, onDisk),
      enumerable: false,
    });
    return parked;
  }

  return function ownDraftPaths(entry) {
    const base = branchPoint(entry.head);
    if (!base) return null;
    const spec = draftPathspec();
    const onDisk = (p) => exists(entry.path, p);
    const textOnDisk = (p) => readText(entry.path, p);
    const historyText = ownHistoryText(entry, base);
    if (historyText === null) return null;

    // A CLEAN checkout holds nothing but its commits, so its pending set is fully
    // determined by base..HEAD — computable once per sha in the MAIN repo instead of
    // spawning git inside all 42 checkouts. That is what keeps the hook fast.
    if (dirtyCount(entry.path) === 0) {
      if (!cleanCache.has(entry.head)) {
        cleanCache.set(entry.head, run(["diff", "--name-only", base, entry.head, "--", ...spec], repoRoot));
      }
      const changed = cleanCache.get(entry.head);
      return changed === null ? null : resultFrom(changed, onDisk, textOnDisk, historyText);
    }

    const changed = run(["diff", "--name-only", base, "--", ...spec], entry.path);
    const untracked = run(["ls-files", "--others", "--exclude-standard", "--", ...spec], entry.path);
    if (changed === null || untracked === null) return null;
    return resultFrom([...changed, ...untracked], onDisk, textOnDisk, historyText);
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
