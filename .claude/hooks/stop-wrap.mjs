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
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

import { withFileLock } from "./ledger-lock-lib.mjs";

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch { /* fine */ }

const sessionId = payload?.session_id || "unknown";
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

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
// days. Match by full basename or by slug (basename minus the numeric stamp),
// since MCP apply names may omit or differ in the stamp. Satisfied entries are
// pruned so the nag ends once the file is committed; unsatisfied entries
// persist ACROSS sessions until resolved. The prune holds the same lock as the
// recorder so a concurrent apply cannot be dropped by the rewrite.
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
    let lsTree;
    try {
      lsTree = execFileSync("git", ["ls-tree", "-r", "HEAD", "--name-only", "--", "supabase/migrations"], {
        encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], cwd: projectDir,
      });
    } catch {
      if (runGit(["rev-parse", "--verify", "HEAD"]).trim()) {
        throw new Error("git ls-tree failed despite a valid HEAD — containment check skipped");
      }
      lsTree = ""; // unborn HEAD: nothing is committed, so containment must block
    }
    const trackedNames = new Set();
    for (const f of lsTree.split("\n")) {
      const rel = f.replace(/\\/g, "/").trim();
      if (!rel.endsWith(".sql")) continue;
      const base = rel.slice(rel.lastIndexOf("/") + 1, -".sql".length);
      trackedNames.add(base);
      trackedNames.add(base.replace(/^\d{8,14}_/, ""));
    }
    const isContained = (e) => {
      const n = String(e.name).trim().replace(/\.sql$/i, "");
      return trackedNames.has(n) || trackedNames.has(n.replace(/^\d{8,14}_/, ""));
    };
    withFileLock(appliedLedgerPath + ".lock", () => {
      const rawEntries = JSON.parse(readFileSync(appliedLedgerPath, "utf8"));
      const entries = Array.isArray(rawEntries) ? rawEntries.filter(e => e && String(e.name || "").trim()) : [];
      if (entries.length === 0) return;
      appliedUncontained = entries.filter(e => !isContained(e));
      // Prune satisfied entries (best-effort; never block the stop over a write).
      if (appliedUncontained.length < entries.length) {
        try { writeFileSync(appliedLedgerPath, JSON.stringify(appliedUncontained, null, 2) + "\n"); } catch { /* fail-open */ }
      }
    });
  }
} catch { /* fail-open — a corrupt ledger must not brick session end */ }

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
// Unresolved live-applies fold into the signature too: Mason may acknowledge
// one deliberately, but a NEW apply (or a clean tree with an old empty-set ack
// lying around) re-arms the hook rather than slipping through silently.
const ackSignature = [
  ...meaningful.map(l => l.trim() + "\t" + fileContentHash(l)),
  ...appliedUncontained.map(e => "APPLIED-NO-SOURCE\t" + String(e.name).trim()),
]
  .sort()
  .join("\n");
try {
  const ack = JSON.parse(
    readFileSync(path.join(projectDir, ".claude", "session-state", "stop-wrap-ack.json"), "utf8")
  );
  if (ack && ack.signature === ackSignature) {
    process.exit(0);
  }
} catch { /* no/unreadable ack file — fall through and block as usual */ }

if (appliedUncontained.length > 0) {
  issues.push(
    `🚨 ${appliedUncontained.length} migration(s) APPLIED TO LIVE with no committed source file — the SQL is running in production but exists nowhere in the repo. Commit the migration file (supabase/migrations/<stamp>_<name>.sql) before ending the session:\n` +
    appliedUncontained.slice(0, 8).map(e => `     ${e.name}  (applied ${e.ts || "this session"})`).join("\n") +
    (appliedUncontained.length > 8 ? `\n     ... and ${appliedUncontained.length - 8} more` : "")
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
      const touched = [
        ...lines.map(porcelainPath),
        ...runGit(["log", "--name-only", "--pretty=format:", since])
          .split("\n").map(s => s.replace(/\\/g, "/").trim()).filter(Boolean),
      ];
      if (!touched.some(f => LEDGER_RES.some(re => re.test(f)))) {
        issues.push(
          `📓 Commits exist this session but no ledger file was touched —\n` +
          `     record the work where it belongs: docs/manual/*.md (DECISION_LOG for a policy or business\n` +
          `     call, KNOWN_ISSUES for a bug, OWNER_PLAYBOOK for a how-to), docs/reference/migration-history.md\n` +
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
