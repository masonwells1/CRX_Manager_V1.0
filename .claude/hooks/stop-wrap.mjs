#!/usr/bin/env node
// Stop hook — session wrap-up.
// Complements stop-verify.mjs (which forces build+test after code changes).
// This hook surfaces "loose ends" Mason should resolve before closing:
//   - Uncommitted files (so work doesn't get lost)
//   - Migrations written but not applied to live
//   - Edge Functions edited but not redeployed
//   - C10 lessons-to-checks ratchet: a BLOCKER/HIGH closure in docs/audits/*
//     must ship with an executable check in the same working tree
//   - Migrations lacking a fresh migration-review-*.json proof
//   - Prompt to capture learnings to memory if the session was substantive
//
// Returns "block" with the loose-ends list, so Claude is forced to surface it
// before declaring the session done.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

import { withFileLock, normalizedSqlHash } from "./ledger-lock-lib.mjs";
// The dated-fragment pattern is imported, never re-expressed: a second copy here would
// drift from the guard and this hook would start contradicting what pre-commit enforces.
import { ENTRY_RE } from "../../scripts/check-ledger-update.mjs";

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch { /* fine */ }

const sessionId = payload?.session_id || "unknown";
// Payload cwd first, mirroring applied-snapshot-invalidate.mjs: the ledger
// this hook checks must be the one the recorder wrote, even under a harness
// that pins CLAUDE_PROJECT_DIR to the primary checkout while the session runs
// in a worktree (Opus review 2026-08-19).
const candidateDir = String(payload?.cwd || "").trim() || process.env.CLAUDE_PROJECT_DIR || process.cwd();
// Normalize both hooks to the git worktree ROOT so the recorder and this
// checker agree on the ledger location even if the two hooks fire from
// different subdirectories of the same worktree (Opus review 2026-08-19,
// round 3). Fail-safe: a non-git path (or git unavailable) is kept verbatim.
function gitToplevelOr(candidate) {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: candidate, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return top ? top : candidate;
  } catch {
    return candidate;
  }
}
const projectDir = gitToplevelOr(candidateDir);

function runGit(args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
      cwd: projectDir,
    });
  } catch {
    return "";
  }
}

const issues = [];

// ─── Uncommitted files (filtered to meaningful paths) ────────────────────
const porcelain = runGit(["status", "--porcelain"]);
const lines = porcelain.split("\n").filter(l => l.trim());
const meaningful = lines.filter(l => {
  const p = l.slice(3);
  return !p.startsWith(".claude/worktrees/")
    && !p.startsWith(".playwright-mcp/")
    && !p.startsWith(".claude/session-state/")
    && !p.endsWith(".log")
    && !p.startsWith("node_modules/");
});

// ─── Live-applied migrations must have committed source (C3) ──────────────
// applied-snapshot-invalidate.mjs records every apply_migration into
// .claude/session-state/applied-source-ledger.json. Any recorded apply with NO
// matching migration file COMMITTED to git (present in HEAD — `ls-tree HEAD`,
// not `ls-files`, so an intent-to-add `git add -N` filename with no content
// cannot satisfy the guard) is a live schema change whose SQL exists nowhere
// in the repo — the exact failure that reached production three times in 30
// days.
//
// Containment is CONTENT-BOUND when the recorder captured a SQL hash (every
// entry written after 2026-08-19): some committed file matching the entry's
// basename or slug must hash to the SQL that actually ran. A right-named file
// with wrong or empty content no longer satisfies — and a parked file
// committed long BEFORE the apply does satisfy, as long as its content is the
// applied SQL (Opus review 2026-08-19, round 2: both directions of the
// name-only check were wrong).
//
// Legacy entries without a hash keep the name rules: exact stamped basename,
// or slug where some committed file with that slug is stamped near or after
// the recorded apply time — the repo holds duplicate slugs years apart, so an
// unrelated old file must not satisfy (and then prune) a fresh apply
// (Opus review 2026-08-19). Satisfied entries are pruned so the nag ends once
// the file is committed; unsatisfied entries persist across sessions (in this
// checkout's .claude/session-state) until resolved. The prune holds the same
// lock as the recorder so a concurrent apply cannot be dropped by the rewrite.
const appliedLedgerPath = path.join(projectDir, ".claude", "session-state", "applied-source-ledger.json");
let appliedUncontained = [];
try {
  if (existsSync(appliedLedgerPath)) {
    // Distinguish "git works and nothing is committed" (block — that IS the
    // uncontained case, including an unborn HEAD in a fresh repo) from "the
    // git call itself failed" (binary missing, 5s timeout): a broken git must
    // not masquerade as an empty repo and raise a block that committing can
    // never clear (CodeRabbit PR #423 round 2). Throwing lands in the outer
    // fail-open catch, skipping both the check and the prune.
    if (runGit(["rev-parse", "--is-inside-work-tree"]).trim() !== "true") {
      throw new Error("git unavailable — containment check skipped");
    }
    // runGit folds failure into "", which here would read as "no committed
    // migrations" — a phantom block one layer deeper (CodeRabbit PR #423
    // round 3). Call ls-tree unwrapped: a throw means EITHER an unborn HEAD
    // (nothing committed — the containment case, keep blocking with an empty
    // set) OR a transient failure despite a valid HEAD (skip via the outer
    // fail-open catch). rev-parse --verify HEAD tells the two apart. A
    // SUCCESSFUL empty listing stays authoritative: commits exist but no
    // migration files do, so a recorded apply is genuinely uncontained.
    // -z output: git C-quotes non-ASCII paths in newline mode, which would
    // mangle a stamped basename and phantom-block a correctly committed file.
    let lsTree;
    try {
      lsTree = execFileSync("git", ["ls-tree", "-r", "-z", "HEAD", "--name-only", "--", "supabase/migrations"], {
        encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"], cwd: projectDir,
      });
    } catch {
      // Tell "unborn HEAD" (nothing committed — containment must block) apart
      // from "git broke" (skip). The probe itself must be failure-aware:
      // folding ANY rev-parse failure into "unborn" would recreate the phantom
      // block one layer deeper (Opus review 2026-08-19) — only git exiting
      // with a revision-resolution error proves an unborn HEAD. A spawn
      // failure, timeout, or localized error text falls through to the skip,
      // which can never phantom-block.
      let headOut = "", headErr = null;
      try {
        // Force the C locale so the unborn-HEAD stderr below is the English
        // Git emits by default. Under a localized LANG, git's "unknown
        // revision" diagnostic is translated, the regex misses, and an unborn
        // HEAD would fall through to the skip instead of blocking — a
        // locale-dependent fail-open (CodeRabbit PR #423). LC_ALL wins over
        // every other locale var.
        headOut = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
          encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"], cwd: projectDir,
          env: { ...process.env, LC_ALL: "C", LANG: "C" },
        });
      } catch (e) { headErr = e; }
      if (headOut.trim()) {
        throw new Error("git ls-tree failed despite a valid HEAD — containment check skipped");
      }
      const unborn = !!headErr && headErr.status === 128 &&
        /(unknown revision|needed a single revision|bad revision|ambiguous argument)/i.test(String(headErr.stderr || ""));
      if (!unborn) {
        throw new Error("git HEAD probe failed — containment check skipped");
      }
      lsTree = ""; // unborn HEAD: nothing is committed, so containment must block
    }
    // Legacy (no-hash) rules: exact stamped basenames pin identity outright;
    // slug matches are gated by stamp time — the committed file must be
    // stamped no earlier than ~7 days before the recorded apply (the
    // legitimate flow stamps the file around apply time). A stampless
    // committed file can't be windowed and matches any time; an entry whose
    // ts won't parse can't be windowed either, and fails toward blocking —
    // the exact-name match still clears it.
    const SLUG_STAMP_SLACK_MS = 7 * 24 * 60 * 60 * 1000;
    const stampToMs = (stamp) => {
      const m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2}))?/.exec(String(stamp || ""));
      if (!m) return null; // no digits to window — stampless
      const [y, mo, d, h, mi, s] = [+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)];
      // An implausible stamp (month 93, year 9999) is NOT treated as
      // stampless — stampless matches unconditionally, so a garbage or
      // far-future stamp would satisfy every window (Opus review 2026-08-19).
      // NaN satisfies no comparison: the file simply cannot window-clear.
      if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return NaN;
      const ms = Date.UTC(y, mo - 1, d, h, mi, s);
      return Number.isFinite(ms) ? ms : NaN;
    };
    const committedFiles = []; // { rel, base, slug, stampMs } per committed migration
    for (const f of lsTree.split("\0")) {
      const rel = f.replace(/\\/g, "/").trim();
      if (!rel.endsWith(".sql")) continue;
      const base = rel.slice(rel.lastIndexOf("/") + 1, -".sql".length);
      const m = /^(\d{8,14})_(.+)$/.exec(base);
      committedFiles.push({ rel, base, slug: m ? m[2] : base, stampMs: m ? stampToMs(m[1]) : null });
    }
    // Read one committed blob. Unwrapped: a git failure here is transient
    // infrastructure, and folding it into "content differs" would phantom-
    // block a correctly committed file — throw to the outer fail-open catch
    // instead, same policy as the ls-tree call above.
    const gitShowBlob = (rel) => {
      try {
        return execFileSync("git", ["show", `HEAD:${rel}`], {
          encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"], cwd: projectDir,
        });
      } catch {
        throw new Error("git show failed — containment check skipped");
      }
    };
    const isContained = (e) => {
      const n = String(e.name).trim().replace(/\.sql$/i, "");
      const slug = n.replace(/^\d{8,14}_/, "");
      const candidates = committedFiles.filter((f) => f.base === n || f.slug === slug);
      if (typeof e.sqlHash === "string" && /^[0-9a-f]{64}$/.test(e.sqlHash)) {
        // Content-bound entry: some name/slug candidate must hash to the SQL
        // that ran. The stamp window is irrelevant here — content identity is
        // strictly stronger evidence than stamp proximity.
        return candidates.some((f) => normalizedSqlHash(gitShowBlob(f.rel)) === e.sqlHash);
      }
      if (candidates.some((f) => f.base === n)) return true;
      const entryMs = Date.parse(String(e.ts || ""));
      if (!Number.isFinite(entryMs)) return false; // undatable entry: a slug alone can't prove it
      return candidates.some((f) => f.stampMs === null || f.stampMs >= entryMs - SLUG_STAMP_SLACK_MS);
    };
    // Composite identity: F1 (recorder) now keeps MULTIPLE rows for one name
    // when their content differs (a distinct-content re-apply must not erase an
    // earlier content-bound row). So prune by (name, sqlHash), never by name
    // alone — else pruning one contained row would drop its still-uncontained
    // same-name sibling (Opus review 2026-08-19, round 3).
    const idOf = (e) => String(e.name).trim() + "\u0000" + String(e.sqlHash || "");
    // Per-entry FAIL-CLOSED. isContained runs `git show` per candidate and can
    // throw on a transient blob-read failure. Letting that reach the OUTER
    // fail-open catch would skip the WHOLE sweep and silently disarm the guard
    // for EVERY recorded apply (Opus review 2026-08-19, round 3). Instead a
    // throw marks only THAT entry uncontained: at worst one entry phantom-
    // blocks (loud, and cleared by committing or by re-running once git
    // recovers), while every other apply is still verified. For a security
    // guard that is the correct trade — a silent skip can pass an uncommitted
    // live apply; a per-entry block never can.
    const classifyUncontained = (e) => {
      try { return !isContained(e); }
      catch { return true; }
    };
    // Classify OUTSIDE the lock. isContained does a git-show per candidate;
    // holding the recorder's lock across all of that risks the 2s lock timeout
    // firing and letting a concurrent recorder append UNLOCKED (lost entry =
    // silent disarm). Read a snapshot here; re-read under the lock only to
    // prune. A corrupt/absent ledger yields an empty classification (fail-open,
    // no block) — matching the corrupt-ledger test.
    let classifyEntries = [];
    try {
      const rawEntries = JSON.parse(readFileSync(appliedLedgerPath, "utf8"));
      classifyEntries = (Array.isArray(rawEntries) ? rawEntries : [])
        .filter(e => e && typeof e.name === "string" && e.name.trim());
    } catch { classifyEntries = []; }
    const classified = classifyEntries.map(e => ({ e, uncontained: classifyUncontained(e) }));
    appliedUncontained = classified.filter(c => c.uncontained).map(c => c.e);
    const containedIds = new Set(classified.filter(c => !c.uncontained).map(c => idOf(c.e)));
    // Prune ONLY rows classified contained, and ONLY while holding the lock (an
    // unlocked rewrite could erase a concurrent recorder's append — CodeRabbit
    // PR #423 round 4). Re-read INSIDE the lock so a row appended AFTER
    // classification is preserved (not in containedIds → kept, evaluated next
    // stop). Junk rows carry nothing the recorder wrote, so drop them too.
    // Write-then-rename so a crash mid-write can't corrupt the ledger.
    try {
      withFileLock(appliedLedgerPath + ".lock", (locked) => {
        if (!locked) return; // skip the prune; the next stop re-prunes
        let current;
        try { current = JSON.parse(readFileSync(appliedLedgerPath, "utf8")); } catch { return; }
        if (!Array.isArray(current)) return;
        const kept = current.filter(e =>
          e && typeof e.name === "string" && e.name.trim() && !containedIds.has(idOf(e))
        );
        if (kept.length !== current.length) {
          const tmpPath = appliedLedgerPath + "." + process.pid + ".tmp";
          writeFileSync(tmpPath, JSON.stringify(kept, null, 2) + "\n");
          renameSync(tmpPath, appliedLedgerPath);
        }
      });
    } catch { /* fail-open on the PRUNE only — classification already stands */ }
  }
} catch (err) {
  // The whole containment check could not run — almost always git being
  // unavailable here (binary missing, not a work tree, transient ls-tree
  // failure). We deliberately do NOT convert this into a block: that was the
  // settled CodeRabbit decision — a down-git session must still be able to end,
  // and committing could never clear a git-outage phantom block. But it must
  // not be SILENT either: a skipped guard the agent can't see is
  // indistinguishable from one that passed (Opus review 2026-08-19, round 3).
  // Surface it on stderr — transcript-visible, non-blocking.
  try {
    process.stderr.write(
      "[stop-wrap] C3 source-containment check SKIPPED (" + String((err && err.message) || err) + "). " +
      "Live-applied migrations were NOT verified against committed source this session.\n"
    );
  } catch { /* stderr unavailable — nothing more we can do */ }
}

// ─── Acknowledgment escape valve ──────────────────────────────────────────
// Implements the hook's own promise ("If Mason confirms each item is
// intentional or already done, you can stop"). When
// .claude/session-state/stop-wrap-ack.json records a signature that matches
// the CURRENT uncommitted set, the session is allowed to end. Any new or
// changed file shifts the signature and re-arms the hook, so genuinely new
// loose ends still block. This stops the infinite re-fire loop that occurs
// when the main checkout legitimately holds a PARALLEL session's WIP that the
// current (worktree) session must not touch.
// See memory: project_worktree-stop-hook-reports-main.
//
// Codex round-4 P2: the signature folds in a CONTENT HASH per file, not just
// the porcelain status line. A file that is already modified keeps the same
// `M path` status line, so a line-only signature would NOT change when the file
// is edited again — meaning once a set was acknowledged, any further edits to
// those same files stayed silently acknowledged and the hook never re-armed.
// Hashing the working-tree bytes makes every content change shift the signature.
// (Untracked directories git collapses to one entry can't be cheaply hashed →
// "dir" sentinel; deleted/unreadable → "na". The primary case — re-editing a
// tracked modified file — is fully covered.)
function fileContentHash(statusLine) {
  // Porcelain is "XY PATH"; renames render as "old -> new" (hash falls back to "na").
  const rel = statusLine.slice(3);
  try {
    const abs = path.join(projectDir, rel);
    const st = statSync(abs);
    if (!st.isFile()) return "dir";
    return createHash("sha1").update(readFileSync(abs)).digest("hex").slice(0, 12);
  } catch {
    return "na";
  }
}
// Unresolved live-applies still fold into the signature (a NEW apply shifts
// it, so an old ack can never describe the new state) — but the valve itself
// NEVER opens while one exists: an alarm the agent can self-acknowledge is
// not a guard (Opus review 2026-08-19 — a single ack would have silenced the
// C3 alarm in every later session once the tree was clean). Resolution is
// committing the file or clearing a stale ledger entry, both spelled out in
// the block message below.
// Entry names and timestamps are ledger content (tool input / file bytes):
// strip non-printables and cap length before they reach any output — the
// signature is echoed verbatim in the block message, and a crafted ts could
// otherwise inject fake report lines (Opus review 2026-08-19, round 2).
const sanitizedAppliedName = (e) => String(e.name).replace(/[^\x20-\x7E]/g, "?").slice(0, 80);
const sanitizedAppliedTs = (e) => String(e.ts || "this session").replace(/[^\x20-\x7E]/g, "?").slice(0, 40);
const ackSignature = [
  ...meaningful.map(l => l.trim() + "\t" + fileContentHash(l)),
  ...appliedUncontained.map(e => "APPLIED-NO-SOURCE\t" + sanitizedAppliedName(e).trim()),
]
  .sort()
  .join("\n");
try {
  const ack = JSON.parse(
    readFileSync(path.join(projectDir, ".claude", "session-state", "stop-wrap-ack.json"), "utf8")
  );
  if (ack && ack.signature === ackSignature && appliedUncontained.length === 0) {
    process.exit(0);
  }
} catch { /* no/unreadable ack file — fall through and block as usual */ }

if (appliedUncontained.length > 0) {
  issues.push(
    `🚨 ${appliedUncontained.length} migration(s) recorded as APPLIED TO LIVE with no committed source file:\n` +
    appliedUncontained.slice(0, 8).map(e => `     ${sanitizedAppliedName(e)}${e.failed ? "  [the apply REPORTED an error — it may still have partially landed]" : ""}  (recorded ${sanitizedAppliedTs(e)})`).join("\n") +
    (appliedUncontained.length > 8 ? `\n     ... and ${appliedUncontained.length - 8} more` : "") +
    `\n     If the apply really ran: commit the migration file (supabase/migrations/<stamp>_<name>.sql) whose CONTENT is the SQL that was applied — a right-named file with different content does not count.` +
    `\n     If the entry is stale (verify FIRST against the live ledger: select version, name from supabase_migrations.schema_migrations): remove it with node scripts/remove-applied-ledger-entry.mjs --name <name> --i-verified-against-live (the script refuses without that flag and prints the verify steps). Direct edits to the ledger file are guard-blocked.`
  );
}

if (meaningful.length > 0) {
  issues.push(
    `📝 ${meaningful.length} uncommitted file(s):\n` +
    meaningful.slice(0, 8).map(l => "     " + l).join("\n") +
    (meaningful.length > 8 ? `\n     ... and ${meaningful.length - 8} more` : "")
  );
}

// ─── Migrations written but not yet applied to live ──────────────────────
// Heuristic: any *.sql file in supabase/migrations/ that appears in
// `git status` as untracked or modified AND is newer than the last
// successful Supabase apply (we can't see Supabase MCP state from here,
// so we just flag any uncommitted migration as "needs attention").
const migrationLines = lines.filter(l => /supabase\/migrations\/.+\.sql$/.test(l));
if (migrationLines.length > 0) {
  issues.push(
    `🗄️  ${migrationLines.length} migration file(s) uncommitted — confirm each is APPLIED to live (via Supabase MCP apply_migration) before committing:\n` +
    migrationLines.map(l => "     " + l).join("\n")
  );
}

// ─── Edge Functions edited but possibly not redeployed ───────────────────
const edgeFnLines = lines.filter(l => /supabase\/functions\/.+\.ts$/.test(l));
if (edgeFnLines.length > 0) {
  issues.push(
    `⚡ ${edgeFnLines.length} Edge Function file(s) modified — confirm each was redeployed via /deploy-edge-function:\n` +
    edgeFnLines.map(l => "     " + l).join("\n")
  );
}

// ─── C10 lessons-to-checks ratchet ────────────────────────────────────────
// RC4 (docs/audits/2026-06-10-error-prevention-review.md §2): lessons land in
// CLAUDE.md/audit prose and never become executable checks (actor-forgery
// recurred across six dates). Heuristic: if this working tree adds/modifies a
// docs/audits/* doc whose NEW content mentions a BLOCKER or HIGH finding
// (i.e. a closure/disposition), the same tree must also carry an executable
// check — a predicate sweep (scripts/db-invariant-sweeps/), a hook
// (.claude/hooks/), a *.test.* file, or a smoke script (scripts/smoke/).
// Otherwise it's a loose end (WARNING in the list — same block-by-listing
// semantics as every other item here).
const auditDocLines = lines.filter(l => /docs\/audits\/.+\.md$/.test(l.slice(3)));
let closesHighFinding = null; // first audit doc whose new content matches
for (const l of auditDocLines) {
  const status = l.slice(0, 2);
  const p = l.slice(3);
  let added = "";
  if (status.includes("?")) {
    // Untracked: the whole file is new content.
    try { added = readFileSync(path.join(projectDir, p), "utf8"); } catch { /* ignore */ }
  } else {
    // Modified: only count lines ADDED in this working tree, not prior text.
    added = runGit(["diff", "HEAD", "--", p])
      .split("\n")
      .filter(d => d.startsWith("+") && !d.startsWith("+++"))
      .join("\n");
  }
  if (/\b(BLOCKER|HIGH)\b/.test(added)) { closesHighFinding = p; break; }
}
if (closesHighFinding) {
  const hasExecutableCheck = lines.some(l => {
    const p = l.slice(3);
    return p.startsWith("scripts/db-invariant-sweeps/")
      || p.startsWith(".claude/hooks/")
      || p.startsWith("scripts/smoke/")
      || /\.test\.[^/]+$/.test(p);
  });
  if (!hasExecutableCheck) {
    issues.push(
      `🔧 WARNING — HIGH+ finding closed without an executable check (the lessons-to-checks ratchet) — add a predicate/hook/test or document why not in the disposition.\n` +
      `     (audit doc in this tree: ${closesHighFinding} mentions BLOCKER/HIGH, but no sibling change under\n` +
      `     scripts/db-invariant-sweeps/, .claude/hooks/, scripts/smoke/, or a *.test.* file)`
    );
  }
}

// ─── Migrations without a fresh review proof ──────────────────────────────
// migration-apply-guard.mjs requires .claude/session-state/
// migration-review-<name>.json before apply_migration; this closes the loop
// at session end: any uncommitted supabase/migrations/*.sql with NO matching
// proof newer than the file itself (missing review, or file edited AFTER the
// review) gets listed. Proof stamps can differ from disk stamps (B7 renames
// to the MCP stamp), so matching falls back to the slug — the filename minus
// the leading numeric stamp.
const stateDir = path.join(projectDir, ".claude", "session-state");
let proofFiles = [];
try {
  proofFiles = readdirSync(stateDir).filter(f => /^migration-review-.+\.json$/.test(f));
} catch { /* no session-state dir — every migration below will be flagged */ }

const unprovenMigrations = [];
for (const l of migrationLines) {
  const p = l.slice(3);
  const migPath = path.join(projectDir, p);
  if (!existsSync(migPath)) continue; // deleted in tree — nothing to prove
  const base = path.basename(p, ".sql");
  const slug = base.replace(/^\d{8,14}_/, "");
  const proven = proofFiles.some(f => {
    const name = f.slice("migration-review-".length, -".json".length);
    const proofSlug = name.replace(/^\d{8,14}_/, "");
    if (name !== base && proofSlug !== slug) return false;
    try {
      return statSync(path.join(stateDir, f)).mtimeMs >= statSync(migPath).mtimeMs;
    } catch {
      return false;
    }
  });
  if (!proven) unprovenMigrations.push(p);
}
if (unprovenMigrations.length > 0) {
  issues.push(
    `🛡️  ${unprovenMigrations.length} migration file(s) with NO fresh review proof (.claude/session-state/migration-review-*.json newer than the file) — review missing, or the file was edited after its review:\n` +
    unprovenMigrations.map(p => "     " + p).join("\n")
  );
}

// ─── Learnings capture prompt (only on substantive sessions) ─────────────
// Heuristic: if 5+ files changed this session, prompt to capture a learning.
let priorPorcelain = "";
const snapPath = path.join(os.tmpdir(), "crx-claude-hooks", `session-${sessionId}.snapshot`);
if (existsSync(snapPath)) {
  try { priorPorcelain = readFileSync(snapPath, "utf8"); } catch { /* ignore */ }
}
const priorSet = new Set(priorPorcelain.split("\n").map(l => l.trim()).filter(Boolean));
const newOrChanged = lines.filter(l => !priorSet.has(l.trim()));
if (newOrChanged.length >= 5) {
  issues.push(
    `🧠 Substantive session (${newOrChanged.length} new/changed files).\n` +
    `     Did Mason learn or decide something non-obvious that should outlive this session?\n` +
    `     If yes — save a memory file under C:\\Users\\mason\\.claude\\projects\\C--CRX-Manager\\memory\\\n` +
    `     (feedback memory, project memory, or reference memory — whichever fits).\n` +
    `     Don't save what's already derivable from code/docs/git history.`
  );
}

// ─── Ledger entry per session ─────────────────────────────────────────────
// A session that lands commits should leave a written record Mason can find.
// This mirrors the HARD pre-commit guard (scripts/check-ledger-update.mjs) and
// accepts the SAME ledger set rather than demanding docs/CHANGELOG.md
// specifically (2026-08-17, Mason). Two reasons: a policy call belongs in
// docs/manual/DECISION_LOG.md and a schema change in migration-history.md, so
// insisting on CHANGELOG.md misfiles the record; and it churned the one file
// every single session, which is noise in the file Mason is most likely to
// actually read. The prior comment cited a CLAUDE.md section ("Keeping Docs In
// Sync") that no longer exists — the live requirement is the hard guard's.
//
// Heuristic: commits landed during THIS session (git log since the session-start
// snapshot's mtime) but no ledger file was touched — neither still dirty in the
// working tree nor already committed during the session. Fail-open: no snapshot
// / git error → skip silently (parallel sessions share tmpdir snapshots, so this
// is a prompt, not a proof — same block-by-listing semantics as the items above).
const LEDGER_RES = [
  ENTRY_RE,
  /^docs\/CHANGELOG\.md$/,
  /^docs\/manual\/[^/]+\.md$/,
  /^docs\/reference\/agent-guardrails\.md$/,
  /^docs\/reference\/migration-history\.md$/,
  /^docs\/loops\//,
];
// Normalize one `git status --porcelain` record to its path. Rename and copy
// records read `R  old -> new`; the DESTINATION is the file that now carries the
// ledger entry, so match on that, not on the whole rename expression.
const porcelainPath = (l) => {
  const rel = l.slice(3).replace(/\\/g, "/").trim();
  const arrow = rel.lastIndexOf(" -> ");
  return (arrow === -1 ? rel : rel.slice(arrow + 4)).replace(/^"|"$/g, "").trim();
};
try {
  if (existsSync(snapPath)) {
    const sessionStartMs = statSync(snapPath).mtimeMs;
    const since = `--since=${new Date(sessionStartMs).toISOString()}`;
    const sessionCommits = runGit(["log", "--oneline", since]).trim();
    if (sessionCommits) {
      // Two sources, which together cover the whole accepted set: files still
      // dirty in the working tree, plus files already COMMITTED this session —
      // those have left the status listing entirely. An earlier version stat'd
      // a hardcoded file list instead, so committing a docs/manual/ file beyond
      // that list, or a docs/loops/ ledger — both accepted here and by the hard
      // guard — still produced a false "no ledger" warning.
      // A changelog.d fragment counts ONLY when this session ADDED it. Modifying,
      // renaming or deleting an existing entry records nothing about the work just
      // done — it rides on someone else's record, which is exactly what pre-commit
      // refuses. The legacy ledgers stay status-blind on purpose: appending to
      // CHANGELOG.md or DECISION_LOG.md IS a modify (Codex P2, PR #482). Without this
      // split, adding ENTRY_RE here would have made the hook LOOSER than before.
      const BACKSLASH = String.fromCharCode(92);
      const toPosixPath = (s) => s.split(BACKSLASH).join("/").trim();
      const fromLog = runGit(["log", "--name-status", "-M", "--pretty=format:", since])
        .split("\n").map(s => s.trim()).filter(Boolean)
        .map((s) => {
          const parts = s.split("\t");
          if (parts.length < 2) return null;
          return { path: toPosixPath(parts[parts.length - 1]), status: parts[0].trim() };
        }).filter(Boolean);
      const touched = [
        ...lines.map((l) => ({ path: porcelainPath(l), status: l.slice(0, 2) })),
        ...fromLog,
      ];
      // "A" or an untracked "?" is an addition; a rename destination ("R100") is not.
      const isAdded = (st) => !/^R/.test(st) && /[A?]/.test(st);
      // An added fragment must also SURVIVE the session: adding an entry and later
      // deleting or reverting it leaves the historical "A" in the session log while
      // no record remains for anyone to read (CodeRabbit, PR #482). Existence is
      // checked against the working tree — the state the next session inherits.
      const counts = ({ path: p, status }) =>
        LEDGER_RES.some((re) => re.test(p) &&
          (re !== ENTRY_RE || (isAdded(status) && existsSync(path.join(projectDir, p)))));
      if (!touched.some(counts)) {
        issues.push(
          `📓 Commits exist this session but no ledger file was touched —\n` +
          `     record the work where it belongs. PREFERRED: add docs/changelog.d/<YYYY-MM-DD>-<slug>.md,\n` +
          `     a new dated file of your own — two sessions never write the same path, so it cannot\n` +
          `     conflict. Otherwise docs/manual/*.md (DECISION_LOG for a policy or business call,\n` +
          `     KNOWN_ISSUES for a bug, OWNER_PLAYBOOK for a how-to), docs/reference/migration-history.md\n` +
          `     (a schema change), docs/reference/agent-guardrails.md (guard or hook behavior), a docs/loops/\n` +
          `     ledger, or docs/CHANGELOG.md for general work (node scripts/log-session.mjs --summary '...').`
        );
      }
    }
  }
} catch { /* fail-open — never block the stop over this heuristic */ }

if (issues.length === 0) {
  process.exit(0);
}

const reason =
  `═══ SESSION WRAP — LOOSE ENDS ═══\n\n` +
  issues.join("\n\n") +
  `\n\nBefore declaring the session done, surface these to Mason. He may want to:\n` +
  `  • Run /preflight, then commit (catches subagent-review gaps too)\n` +
  `  • Apply any pending migration via Supabase MCP\n` +
  `  • Run /deploy-edge-function on each modified function\n` +
  `  • Capture a learning to memory\n` +
  `\nIf Mason confirms each item is intentional or already done, you can stop.\n` +
  // Codex round-4 P2: emit the EXACT current signature so the acknowledgment is
  // written by copying this value (not by re-deriving the algorithm) — eliminates
  // drift between how the hook computes it and how the ack is recorded. To
  // acknowledge: write {"signature": "<below>"} to
  // .claude/session-state/stop-wrap-ack.json. Any later content change re-arms it.
  `\n──\nAck signature (copy verbatim into .claude/session-state/stop-wrap-ack.json as {"signature": ...}):\n` +
  JSON.stringify(ackSignature);

process.stdout.write(JSON.stringify({ decision: "block", reason }));
