#!/usr/bin/env node
// Shared decision logic for live migration applies.
//
// WHY THIS FILE EXISTS (2026-08-24). Every gate that protects a live migration
// apply used to live inside migration-apply-guard.mjs, the PreToolUse hook that
// watches `mcp__supabase__apply_migration`. That tool transmits the migration as
// a *pasted string*, and the guard binds the reviewer proof to
// sha256(tool_input.query). A migration too large to re-emit byte-exact in one
// tool call therefore could not be applied at all — not because it was unsafe,
// but because the only door with a lock on it was too small to fit through
// (hit by 20260816120000_draw_down_split_order_lines_by_price_tier, 162,022
// bytes / 2,891 lines).
//
// The fix is a second door, NOT a second lock. This module holds the rules; the
// hook and scripts/apply-migration-file.mjs both ask it for a verdict. There is
// deliberately ONE implementation: a copy of these checks living beside the
// file-bytes path would drift, and the looser copy would become the way in.
//
// The rules themselves are unchanged from the hook's straight-line version —
// this is a mechanical transform where `out(decision, reason)` became
// `return block(reason)` / `return allow()`. Block message text is preserved
// verbatim; migration-apply-guard.test.mjs asserts on it.

import { readFileSync, existsSync, readdirSync, mkdirSync, statSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { flagActive } from "./autopilot-lib.mjs";
import { destructiveMigrationCheck } from "./live-testdata-lib.mjs";
import { sessionCheckoutRoots, resolveSessionWorktree } from "./codex-push-lib.mjs";
import { checkMigrationOrdering } from "./migration-ordering-lib.mjs";
import { checkPendingMigrations } from "./migration-pending-lib.mjs";
import { migrationProofEvidenceHash } from "../../scripts/migration-proof-evidence-hash.mjs";
import { fixedGitExecutable } from "../../scripts/write-codex-push-proof.mjs";
import { checkWrappable } from "./migration-wrappability-lib.mjs";

export const REQUIRED_CODEX_MODEL = "gpt-5.6-sol";
export const REQUIRED_CODEX_EFFORT = "high";
export const PROOF_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
export const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CRX_PRODUCTION_REF = "rhyzpcqhnizqbxphqdkr";
// How current origin/main must be for the pending-set scan to trust it. Matched to
// PROOF_MAX_AGE_MS deliberately: an apply already requires a proof minted in the
// last 30 minutes and a live ledger read, so a fetch in the same window is one more
// step in a sequence the operator is already performing, not a new chore.
export const MAIN_REF_MAX_AGE_MS = PROOF_MAX_AGE_MS;
// Every git call this module makes shares one small budget. The Codex harness
// allows this hook 5 seconds and Claude's allows 15; a hook killed mid-call emits
// nothing, and a PreToolUse hook that emits nothing does NOT deny. Long git
// timeouts are therefore a fail-open on a live migration apply, not a courtesy.
// (CodeRabbit, PR #502.)
export const GIT_CALL_TIMEOUT_MS = 1_500;

function protectedGitEnv() {
  const env = {};
  for (const name of ["SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "never";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_ATTR_NOSYSTEM = "1";
  const systemPath = process.platform === "win32"
    ? path.join(env.SystemRoot || env.WINDIR || "C:\\Windows", "System32")
    : "/usr/bin:/bin";
  env.PATH = `${path.dirname(fixedGitExecutable())}${path.delimiter}${systemPath}`;
  return env;
}

/**
 * Milliseconds since this checkout last fetched from origin, or null when that
 * cannot be established. Read from the filesystem rather than by shelling out:
 * FETCH_HEAD is rewritten by every fetch, and the guard's git budget is already
 * spent on the two listings that actually answer the question.
 */
export function originFetchAgeMs(projectDir, now = Date.now(), readMtime = null) {
  const stat = readMtime || ((p) => statSync(p).mtimeMs);
  // A linked worktree's .git is a FILE containing `gitdir: <path>`; FETCH_HEAD
  // lives in the common dir, which is that path's ../.. for a worktree.
  const dotGit = path.join(projectDir, ".git");
  const candidates = [];
  try {
    if (statSync(dotGit).isDirectory()) {
      candidates.push(path.join(dotGit, "FETCH_HEAD"));
    } else {
      const pointer = readFileSync(dotGit, "utf8").trim();
      const m = pointer.match(/^gitdir:\s*(.+)$/m);
      if (m) {
        const gitdir = path.resolve(projectDir, m[1].trim());
        candidates.push(path.join(gitdir, "FETCH_HEAD"));
        // .../<common>/worktrees/<name> → <common>
        candidates.push(path.join(gitdir, "..", "..", "FETCH_HEAD"));
      }
    }
  } catch { return null; }

  for (const candidate of candidates) {
    try { return Math.max(0, now - stat(candidate)); } catch { /* try the next */ }
  }
  return null;
}

const allow = () => ({ decision: "allow" });
const block = (reason) => ({ decision: "block", reason });

/**
 * Decide whether a live migration apply may proceed.
 *
 * Pure with respect to the database: it reads proof/snapshot files and the
 * autopilot flag, and never contacts Supabase. Callers transmit only on
 * `decision === "allow"`.
 *
 * @param {object} args
 * @param {string} args.name        migration name (the ledger `name`)
 * @param {string} args.query       the EXACT SQL that will be transmitted
 * @param {string} [args.projectId] Supabase project ref the apply targets
 * @param {string} args.projectDir  CLAUDE_PROJECT_DIR (primary checkout)
 * @param {string} [args.cwd]       the session's working directory
 * @param {number} [args.now]       clock injection point for tests
 * @param {Function} [args.gitWorktreeList] injection point for `git worktree list`
 * @returns {{decision: "allow"|"block", reason?: string}}
 */
// Compare migration identities, not raw strings. A proof records the name passed to
// write-apply-proofs.mjs (no .sql); an apply_migration call may carry the bare name,
// a basename with .sql, or a repo-relative path. Substring matching used to absorb
// that variation — and absorbed the alias attack with it. Normalizing both sides
// keeps the tolerance without the hole: an alias differs in its STEM, which survives
// normalization, so `99999999999999_alias_<old>` still cannot equal `<old>`.
export function normalizeMigName(v) {
  // The backslash separator is built rather than written as an escape, so this line
  // survives any future codegen or heredoc that would otherwise eat one of them.
  const BACKSLASH = String.fromCharCode(92);
  return String(v ?? "")
    .trim()
    .split(BACKSLASH)
    .join("/")
    .split("/")
    .pop()
    .replace(/\.sql$/i, "")
    .trim();
}

// ── SOURCE PROVENANCE ───────────────────────────────────────────────────────
// Every check above this point reasons about caller-supplied values: `name`,
// `query`, and proof files keyed off them. None of them ever asked the question
// underneath all of it — IS THIS SQL A MIGRATION THIS REPOSITORY ACTUALLY HOLDS?
// A caller could paste the body of a parked, superseded or REJECTED draft under
// a canonical-looking name, mint matching proofs against that same text, and every
// binding would agree with itself. The bindings were sound; they were binding to
// nothing anchored on disk. (CodeRabbit Major, PR #525 — ruled out of scope there,
// real and pre-existing.)
//
// THIS IS AN ALLOWLIST, DELIBERATELY. The obvious shape — reject
// scripts/.staging-migrations/, reject a `.REJECTED` suffix — is a blocklist, and
// this repo has paid for blocklists repeatedly: the PR #401 guard region reopened
// on a new PL/pgSQL assignment form every round until it was pinned as a closed
// region (DECISION_LOG 2026-08-25), and three successive hand-written parsers in
// bash-safety-lib each left a real destructive bypass before an allowlist held
// (KNOWN_ISSUES, 2026-08-31: eight holes across five rounds). A suffix rule closes
// `.REJECTED` and leaves `.rejected`, `.REJECTED.sql`, a copy in the scratchpad,
// a temp directory, and text that was never a file at all.
//
// So the rule states the permitted case instead: the transmitted SQL must be the
// exact content of `<checkout>/supabase/migrations/<name>.sql`. One directory, and
// one filename inside it derived from the ledger name the apply itself declares.
// Everything else fails by construction, including sources nobody has enumerated.
//
// The name→file→content chain is what makes it worth having. It binds the ordering
// gate's input (`name`) to the bytes being transmitted (`query`) through an artifact
// that is tracked, reviewable, and diffable — so "which migration is this?" and
// "what will actually run?" can no longer disagree.
//
// SCOPE, matching the proof lookup exactly: this session's own checkout and the
// primary one, never a sibling worktree. Same reasoning as the proof directories
// above — a file sitting in a DIFFERENT concurrent session's worktree is not this
// session's reviewed work, and Mason runs dozens of worktrees at once.
export const MIGRATION_SOURCE_SUBDIR = path.join("supabase", "migrations");

// CRLF→LF on BOTH sides. write-apply-proofs.mjs hashes the file LF-normalized and
// scripts/apply-migration-file.mjs transmits it LF-normalized, but a worktree
// checked out before the .gitattributes eol=lf pin still holds CRLF on disk
// (KNOWN_ISSUES: stale-worktree CRLF). Comparing raw bytes would refuse a
// legitimate apply for a line-ending difference. This cannot loosen anything: the
// reviewer proof's queryHash is still computed over the RAW transmitted query, so
// a CRLF-transmitted body passes provenance and then fails content binding.
const lfNormalize = (s) => String(s ?? "").replace(/\r\n/g, "\n");

// The stem must be a plain filename. normalizeMigName() already reduces to a
// basename, so `../` cannot survive it — this is the second lock on the same door,
// and it also refuses `.`/`..`, an empty stem, and a leading dot.
const PLAIN_FILENAME_STEM = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const pathKey = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
// A `withinDir` containment helper lived here until the direct-child rule replaced
// it. It is deliberately NOT kept "in case it is useful": an unused containment
// predicate in a security file is an invitation for a later edit to reach for the
// looser of two rules, and its looseness is precisely what this PR spent a round
// removing (Codex, exact-SHA review of b7ac7a8f). Parent-equality is inline at the
// one place that needs it.

/**
 * Locate the repository migration file whose content is exactly `query`.
 *
 * Read-only. Never contacts the database and never writes.
 *
 * @returns {{ok: true, file: string, dirs: string[]}
 *          |{ok: false, code: "bad-name"|"not-found"|"content-differs"|"escapes-dir",
 *            stem: string, dirs: string[], searched: string[]}}
 */
export function resolveMigrationSource({
  name,
  query,
  projectDir,
  cwd,
  gitWorktreeList,
} = {}) {
  const stem = normalizeMigName(name);
  // GIT_CALL_TIMEOUT_MS, not a longer one of this function's own. Every git call
  // in this module shares one budget because the Codex harness allows the hook 5
  // seconds and Claude's 15: a hook killed mid-call emits nothing, and a PreToolUse
  // hook that emits nothing does NOT deny — so a generous timeout here is a
  // fail-open on a live migration apply, not a courtesy (PR #502).
  //
  // This default is the fallback only. evaluateMigrationApply() injects its MEMOISED
  // listing, so the hot path makes one git call for provenance, proof dirs and the
  // pending queue combined rather than three that can disagree with each other.
  const listWorktrees = gitWorktreeList || (() => execFileSync(
    "git",
    ["worktree", "list", "--porcelain"],
    { cwd: projectDir, encoding: "utf8", timeout: GIT_CALL_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] },
  ));
  const roots = sessionCheckoutRoots(projectDir, cwd || process.cwd(), listWorktrees);
  const dirs = roots.map((root) => path.resolve(root, MIGRATION_SOURCE_SUBDIR));

  if (!stem || stem === "." || stem === ".." || !PLAIN_FILENAME_STEM.test(stem)) {
    return { ok: false, code: "bad-name", stem, dirs, searched: [] };
  }

  const want = lfNormalize(query);
  const searched = [];
  const validated = [];
  let sawName = false;
  let escaped = false;
  for (const root of roots) {
    const dir = path.resolve(root, MIGRATION_SOURCE_SUBDIR);
    const file = path.join(dir, `${stem}.sql`);
    searched.push(file);
    let st;
    try { st = statSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    sawName = true;
    // ANCHOR THE BOUNDARY AT THE CHECKOUT ROOT, NOT AT THE DIRECTORY.
    //
    // The first version resolved the directory AND the file and asked whether the
    // file sat inside the directory. Codex found the hole (High, exact-SHA review
    // of 6be98280): make `supabase/migrations` ITSELF a symlink or junction to an
    // outside directory and both sides resolve outside *together*, so containment
    // holds and the check passes. The comment that used to sit here defended
    // resolving both sides as junction-tolerance — and that tolerance was the hole.
    // It is the DECISION_LOG 2026-08-26 lesson exactly: a closed allowlist is only
    // as good as its boundaries, and the first question is not what the region
    // contains but where the trusted chain actually begins.
    //
    // It begins at the CHECKOUT ROOT. Resolve that (which is what genuinely absorbs
    // a junctioned worktree — the layout on this machine), then require the real
    // migration directory to be exactly <real-root>/supabase/migrations. A
    // redirected migrations directory now fails, while a junctioned checkout still
    // passes, because the junction is resolved on the root where it actually is.
    let realRoot;
    let realDir;
    let realFile;
    try {
      realRoot = realpathSync(root);
      realDir = realpathSync(dir);
      realFile = realpathSync(file);
    } catch { continue; }
    const expectedDir = path.resolve(realRoot, MIGRATION_SOURCE_SUBDIR);
    if (pathKey(realDir) !== pathKey(expectedDir)) { escaped = true; continue; }
    // The file must sit DIRECTLY inside that directory — this refuses a per-file
    // symlink pointing out, which the directory check above does not cover.
    //
    // Parent-equality, not containment. Codex (minor, exact-SHA review of a8efe218)
    // observed that `withinDir` also admitted a symlink whose target was a
    // DESCENDANT of the permitted directory, while this comment claimed "directly
    // inside". That was not a bypass — the target stayed inside the allowlisted tree
    // and the content binding still held — but a check that is looser than the
    // sentence describing it is how the next reader inherits a wrong mental model,
    // and this file has already been reopened twice on exactly that pattern.
    // Every candidate is built as path.join(dir, `${stem}.sql`), so a real migration
    // is always a direct child and nothing legitimate is lost by saying so in code.
    if (pathKey(path.dirname(realFile)) !== pathKey(realDir)) { escaped = true; continue; }
    let content;
    try { content = readFileSync(realFile, "utf8"); } catch { continue; }
    // COLLECT every validated file; do NOT stop at the first.
    //
    // Returning on the first match made the caller's identity check unsound in BOTH
    // directions, and the two reviewers found one direction each on the same line:
    //   * Codex (P2): too STRICT — with the migration present in the primary checkout
    //     and in the session's worktree, `file` named the primary, so applying the
    //     worktree's own file was refused. Reproduced at exit code 2.
    //   * CodeRabbit (minor): too LOOSE — the caller compensated by comparing against
    //     every `dirs` candidate, including roots this loop never validated. A
    //     same-named symlink to an external file in a second checkout then resolved to
    //     the same target and was accepted, though this very loop would have rejected
    //     it as `escapes-dir`.
    // Both are the same defect: the authorized SET was being decided somewhere other
    // than where the validation happens. Returning the validated list settles
    // strictness and looseness in one place, under one rule.
    if (lfNormalize(content) === want) validated.push(file);
  }
  if (validated.length) return { ok: true, file: validated[0], files: validated, dirs };
  return {
    ok: false,
    code: escaped ? "escapes-dir" : sawName ? "content-differs" : "not-found",
    stem,
    dirs,
    files: [],
    searched,
  };
}

export function evaluateMigrationApply({
  name,
  query,
  projectId,
  projectDir,
  cwd,
  now = Date.now(),
  gitWorktreeList,
  // Injection points for the pending-set preflight. `gitTrackedMigrations` stands
  // for the whole GIT-VISIBLE queue (origin/main plus this branch); when supplied,
  // the per-ref listings are skipped. `originFetchAge` returns ms since the last
  // fetch, or null when unknowable. Both real callers leave them unset.
  gitTrackedMigrations,
  originFetchAge,
  // Tests may pass null when their temporary repositories intentionally lack a
  // protected origin/main policy ref. Real callers omit this and fail closed.
  reviewerPolicyCommit,
  // Defaults to TRUE so a caller that forgets it inherits the safe behaviour.
  // It was introduced (PR #470) opt-in for scripts/apply-migration-file.mjs only,
  // which left the MCP apply_migration path — the door used for ROUTINE migrations —
  // still matching by substring. Flipping the default closes that; both known callers
  // are the PreToolUse hook and apply-migration-file.mjs, and both want exact.
  requireExactProofName = true,
} = {}) {
  const stateDir = path.join(projectDir, ".claude", "session-state");
  const targetProject = String(projectId || "").trim();
  if (targetProject !== CRX_PRODUCTION_REF) {
    return block(
      `MIGRATION APPLY GUARD: project_id must exactly equal the CRX production project ` +
      `(${CRX_PRODUCTION_REF}); received ${targetProject || "(missing)"}. Refusing the apply.`);
  }

  const migName = (name || "").toString().trim();
  const migQuery = (query || "").toString();
  if (!migQuery.trim()) {
    return block("MIGRATION APPLY GUARD: transmitted SQL is missing or empty. Refusing an unbound migration apply.");
  }
  // The file-based apply path rejects top-level transaction control before it
  // calls this shared rule book. The MCP path calls evaluateMigrationApply()
  // directly, so enforce the same precondition here: SAVEPOINT/ROLLBACK can
  // otherwise undo an ACL revoke that the source-only SECURITY DEFINER guard
  // records as effective.
  const wrappability = checkWrappable(migQuery);
  if (!wrappability.wrappable) {
    return block(
      `MIGRATION APPLY GUARD: migration "${migName || "(unnamed)"}" is not safely wrappable ` +
      `(${wrappability.reason}). Refusing transaction control that could invalidate a reviewed migration state.`);
  }
  const currentHash = createHash("sha256").update(migQuery).digest("hex");
  const safeName = migName.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "unknown";

  // Make sure the directory exists so future writes work.
  try { mkdirSync(stateDir, { recursive: true }); } catch { /* ignore */ }

  // The session-state directories this apply may draw evidence from: THIS
  // session's own checkout, plus the primary one. Nothing else.
  //
  // Why (2026-07-29): the harness pins CLAUDE_PROJECT_DIR to the PRIMARY checkout
  // even when the session's cwd is a linked worktree, while
  // scripts/write-apply-proofs.mjs writes its output under `process.cwd()` — the
  // worktree that actually holds the migration file. A migration built in a
  // worktree therefore minted perfectly valid proofs somewhere this guard never
  // looked, and the apply was denied no matter how many clean reviews ran. Same
  // root cause pr-merge-guard hit in PR #252/#255.
  //
  // The merge guard's answer — scan every sibling checkout — is NOT safe here, and
  // Codex blocked the first version of this fix for taking it. Its proof is bound
  // to the exact head and base SHAs GitHub reports, so a sibling's proof can only
  // authorize the identical merge. Migration evidence stays session-local even
  // though exact names and exact SQL hashes are now mandatory in every mode.
  // Scanning all worktrees would let a proof minted by a DIFFERENT concurrent
  // session authorize a live apply this session never
  // reviewed — against the settled "proof from THIS session" rule
  // (docs/manual/DECISION_LOG.md, 2026-07-13) and squarely in Mason's way of
  // working, where dozens of worktrees run at once.
  //
  // So the lookup follows the session's actual working directory, honoured only
  // after `git worktree list` confirms it is a checkout of this repository. An
  // unrecognised cwd falls back to the primary directory alone — the old
  // behaviour, which fails closed.
  //
  // The AUTOPILOT.on flag below is deliberately narrower still: it stays pinned to
  // the primary checkout. It is authorization state for this project, not evidence
  // about a migration; reading it from any other checkout would let a flag Mason
  // never armed here change the rule-set.
  const hookCwd = cwd || process.cwd();
  const rawListWorktrees = gitWorktreeList || (() => execFileSync(
    "git",
    ["worktree", "list", "--porcelain"],
    { cwd: projectDir, encoding: "utf8", timeout: GIT_CALL_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] },
  ));
  // ONE listing, shared by both consumers, and its failure is REMEMBERED
  // (Codex P1, PR #502). `git worktree list` was previously invoked twice —
  // once for the proof-dir lookup below, once for the pending-queue root. The
  // first call succeeding while the second transiently failed made
  // resolveSessionWorktree() return null, which silently fell back to the
  // PRIMARY checkout: the guard then accepted the reviewer proof from the
  // active worktree while scanning a different tree for the queue, so an older
  // migration present only in the session worktree was invisible and the apply
  // was allowed to strand it. Codex reproduced that exact
  // first-call-success/second-call-failure sequence and got `allow`.
  //
  // Memoising collapses the race — there is now only one call to disagree with
  // itself — and `worktreeListError` records a failure so the queue scan can
  // REFUSE rather than guess. resolveSessionWorktree() swallows its own errors
  // and returns null, so the caller cannot tell "lookup failed" from "no
  // worktree matched"; this flag is what restores that distinction without
  // touching the blob-pinned shared library.
  let worktreeListError = null;
  let worktreeListing;
  let worktreeListed = false;
  const listWorktrees = () => {
    if (worktreeListed) {
      if (worktreeListError) throw worktreeListError;
      return worktreeListing;
    }
    worktreeListed = true;
    try {
      worktreeListing = rawListWorktrees();
      return worktreeListing;
    } catch (err) {
      worktreeListError = err;
      throw err;
    }
  };
  // Evidence is session-owned: a proof may be discovered in a sibling state
  // directory for diagnosis, but it can NEVER authorize the checkout that is
  // applying the migration. Never validate a primary-checkout proof against
  // primary bytes while the active worktree supplies different callers, schema,
  // history, or reviewer policy. A proof must live in the active worktree's
  // session state; do not fall back to sibling proof directories.
  const activeProofRoot = resolveSessionWorktree(projectDir, hookCwd, listWorktrees) || projectDir;
  const activeProofStateDir = path.join(activeProofRoot, ".claude", "session-state");
  const authorizedProofDirs = [activeProofStateDir];

  // SOURCE PROVENANCE PREFLIGHT. Runs before ordering, autopilot, destructive
  // classification and the proof scan, because it answers the question those all
  // presuppose: this SQL is a migration this repository holds, under the name the
  // apply is declaring. See the block comment above resolveMigrationSource().
  //
  // A throw is a refusal, never a pass — the same rule the ordering and Codex
  // gates already follow. An unknown provenance state is exactly when not to
  // transmit.
  {
    let source;
    try {
      source = resolveMigrationSource({
        name: migName,
        query: migQuery,
        projectDir,
        cwd: hookCwd,
        gitWorktreeList: listWorktrees,
      });
    } catch (err) {
      return block(
        `MIGRATION SOURCE GUARD failed to evaluate the provenance of "${safeName}": ` +
        `${err?.message || err}. Refusing the apply rather than transmitting SQL of unknown origin.`);
    }
    if (!source?.ok) {
      const permitted = (source?.dirs || []).map((d) => `  ${path.join(d, `${source?.stem || migName}.sql`)}\n`).join("");
      const why =
        source?.code === "bad-name"
          ? `the migration name "${migName}" does not reduce to a plain migration filename, so it cannot ` +
            `identify a file in the permitted directory`
          : source?.code === "content-differs"
          ? `a file with that name EXISTS in the permitted directory, but its content is not the SQL being ` +
            `transmitted. The apply is presenting one migration's name with another migration's body`
          : source?.code === "escapes-dir"
          ? `the file at that path resolves OUTSIDE the permitted directory (a link pointing elsewhere), so ` +
            `its content is not governed by the repository's migration review`
          : `no such file exists in the permitted directory`;
      return block(
        `MIGRATION SOURCE GUARD: refusing to apply "${migName || "(unnamed)"}" — ${why}.\n\n` +
        `A live apply may only transmit the exact content of a migration file that this repository ` +
        `actually holds. The permitted source is the ONE directory below (this session's checkout and ` +
        `the primary one, never a sibling worktree):\n` +
        (permitted || `  ${path.join(MIGRATION_SOURCE_SUBDIR, `${migName}.sql`)}\n`) +
        `\nThis is an allowlist, not a list of banned locations. Parked, superseded and REJECTED drafts ` +
        `under scripts/.staging-migrations/ are deliberately outside it and can never be applied from ` +
        `there — that is what parking a migration means. Scratch copies, temp directories and pasted SQL ` +
        `that was never a file fail for the same reason.\n\n` +
        `If this migration is genuinely meant to ship, MOVE THE FILE into supabase/migrations/ as a ` +
        `tracked, reviewable change and take it through review — do not route around this by pasting the ` +
        `body under a canonical-looking name. If it is parked or rejected, it is not meant to ship: check ` +
        `docs/manual/DECISION_LOG.md and docs/manual/KNOWN_ISSUES.md before doing anything else.`);
    }
  }

  // ORDERING PREFLIGHT (2026-08-08). Refuse a migration that is OLDER than one
  // already applied — the mechanism that silently reverted the
  // batch_apply_prepayments actor guard on 2026-07-15 with nothing detecting it.
  //
  // The comparison set is the APPLIED ledger, never the files on disk: a file on
  // disk is not proof it ran, and comparing against disk would block a correct
  // ascending batch of new migrations. The snapshot is written by
  // scripts/refresh-applied-migrations.mjs from
  // supabase_migrations.schema_migrations.
  //
  // MISSING EVIDENCE IS A BLOCK, NOT A PASS. The snapshot is gitignored, so a
  // clean checkout has none — if that abstained, the guard would be absent
  // exactly when it is most needed, recreating the incident it exists to stop
  // (Codex P1, PR #348). A missing, unreadable, or stale snapshot therefore
  // refuses the apply and tells the operator how to produce one. Only the
  // library's internal "this name has no timestamp" case abstains.
  {
    const snapPath = path.join(stateDir, "applied-migrations.json");
    // The recapture target must be the project THIS apply is aimed at. Reading it
    // from the environment printed a literal `<your project ref>` in every normal
    // hook run — neither manifest exports SUPABASE_PROJECT_REF — and a stray env
    // value could have pointed the operator at a different project's ledger, which
    // the snapshot format cannot detect. The apply call itself is authoritative.
    // (Codex P2, PR #354.)
    const targetRef =
      (projectId || "").toString().trim() ||
      (process.env.SUPABASE_PROJECT_REF || "").toString().trim() ||
      CRX_PRODUCTION_REF;
    const howTo =
      `Refresh it first (read-only):\n` +
      `  1. Via Supabase MCP execute_sql on ${targetRef}:\n` +
      `       select version, name from supabase_migrations.schema_migrations order by version;\n` +
      `  2. Pipe that JSON into: node scripts/refresh-applied-migrations.mjs\n` +
      `The snapshot is gitignored and per-checkout, so a fresh clone or a newer apply elsewhere ` +
      `means it must be regenerated. Do NOT hand-write it.`;

    let appliedNames = [];
    let snapshotAgeMs = null;
    try {
      if (!existsSync(snapPath)) {
        return block(
          `MIGRATION ORDERING GUARD: no applied-migration snapshot at ${snapPath}, so there is no ` +
          `evidence of what the database has already run and an out-of-order replay could not be ` +
          `detected. Refusing the apply.\n\n${howTo}`);
      }
      const parsed = JSON.parse(readFileSync(snapPath, "utf8"));
      const rows = Array.isArray(parsed) ? parsed : parsed?.applied;
      if (!Array.isArray(rows) || rows.length === 0) {
        return block(
          `MIGRATION ORDERING GUARD: the applied-migration snapshot at ${snapPath} contains no rows. ` +
          `An empty snapshot is indistinguishable from "nothing has ever been applied" and would ` +
          `silently disable this check. Refusing the apply.\n\n${howTo}`);
      }
      // Same mapping rule as scripts/refresh-applied-migrations.mjs. Preferring
      // `name` alone drops the timestamp for the many ledger rows whose name has
      // none (e.g. version 20260727174805 / name deactivation_revokes_auth_access),
      // and a row that cannot be timestamped cannot constrain ordering.
      appliedNames = rows
        .map((r) => {
          if (typeof r === "string") return r;
          const rowName = (r?.name ?? "").toString().trim();
          const version = (r?.version ?? "").toString().trim();
          if (rowName && /\d{14}/.test(rowName)) return rowName;
          if (version && rowName) return `${version}_${rowName}`;
          return version || rowName || "";
        })
        .filter(Boolean);

      // A snapshot can be present, fresh and non-empty yet contain not one
      // parseable timestamp — in which case the ordering check has nothing to
      // compare against and abstains, and the apply would sail through a gate
      // that looks satisfied. Refuse instead: this is the silent gap the whole
      // mechanism exists to close (CodeRabbit, PR #348).
      if (!appliedNames.some((n) => /\d{14}/.test(n))) {
        return block(
          `MIGRATION ORDERING GUARD: the applied-migration snapshot at ${snapPath} has ` +
          `${appliedNames.length} row(s) but not one carries a 14-digit migration timestamp, so no ` +
          `ordering comparison is possible. A snapshot that cannot answer the question must not be ` +
          `treated as answering it. Refusing the apply.\n\n${howTo}`);
      }

      const capturedAt = Date.parse(parsed?.captured_at ?? "");
      if (Number.isFinite(capturedAt)) {
        snapshotAgeMs = now - capturedAt;
        if (snapshotAgeMs > SNAPSHOT_MAX_AGE_MS) {
          return block(
            `MIGRATION ORDERING GUARD: the applied-migration snapshot is ` +
            `${Math.floor(snapshotAgeMs / 3600000)}h old (captured ${parsed.captured_at}). Migrations ` +
            `applied since then are invisible to this check, so it could pass a replay that is ` +
            `actually behind the live high-water mark. Refusing the apply.\n\n${howTo}`);
        }
      } else {
        return block(
          `MIGRATION ORDERING GUARD: the applied-migration snapshot has no usable captured_at ` +
          `timestamp, so its freshness cannot be established. Refusing the apply.\n\n${howTo}`);
      }
    } catch (err) {
      return block(
        `MIGRATION ORDERING GUARD: could not read the applied-migration snapshot at ${snapPath} ` +
        `(${err?.message || err}). Refusing the apply rather than proceeding without ordering ` +
        `evidence.\n\n${howTo}`);
    }

    try {
      const ordering = checkMigrationOrdering({ name: migName, sql: migQuery, appliedNames });
      if (!ordering.ok) return block(ordering.reason);
      // Belt-and-braces: an abstention is "no verdict", and `ok: true` there means
      // "unknown", not "fine".
      //
      // This used to fire only when `migName` carried a 14-digit timestamp, which
      // was exactly backwards: `apply_migration`'s name is CALLER-CONTROLLED, and
      // an untimestamped name is the one abstention cause the snapshot checks
      // above cannot catch (they constrain the ledger, not the candidate). So
      // stripping the timestamp off an out-of-order migration bought an
      // unconditional pass through this guard — the same replay class that
      // removed the prepayment actor guard. Verified by probe: identical SQL,
      // "20260101000000_old_mig" denied, "old_mig" allowed. (Codex High, PR #354.)
      //
      // Every repository migration is timestamped, so refusing an untimestamped
      // candidate costs nothing real and closes the hole. Deny on ANY abstention.
      if (ordering.abstained) {
        const untimestamped = !/\d{14}/.test(migName || "");
        return block(
          `MIGRATION ORDERING GUARD: the ordering check reached no verdict for "${safeName}", so ` +
          `whether this is an out-of-order replay is UNKNOWN` +
          (untimestamped
            ? `, because the migration name carries no 14-digit timestamp to compare against the ` +
              `applied-migration snapshot. Every repository migration is timestamped, and this name ` +
              `is caller-supplied, so an untimestamped name must not skip the ordering comparison. ` +
              `Re-issue the migration under its real timestamped name.`
            : `.`) +
          ` An unknown verdict is not a pass. Refusing the apply.\n\n${howTo}`);
      }
    } catch (err) {
      // A crash in the ordering check must not silently wave a migration through.
      return block(
        `MIGRATION ORDERING GUARD failed to evaluate "${safeName}": ${err?.message || err}. ` +
        `Refusing the apply rather than skipping the check. Fix the guard, or state an explicit ` +
        `intentional replay in the migration SQL if that is genuinely what this is.`);
    }

    // PENDING-SET PREFLIGHT (2026-08-26). The ordering check above asks only
    // "is anything NEWER already applied?". It never asks "is anything OLDER
    // still WAITING?" — so an apply could legally advance the live high-water
    // past a tracked, unapplied migration, and the refusal surfaced weeks later
    // aimed at the innocent party. That is how
    // 20260825190000_quote_version_restore_trust_boundary was stranded by
    // 20260826150000_fix_save_job_comment_refusal_count. See
    // ./migration-pending-lib.mjs for the full account and the measured reasons
    // behind its two scoping rules.
    //
    // Same fail-closed contract as everything else in this block: an abstention
    // is "no verdict", and an unknown verdict is not a pass.
    // WHERE "TRACKED" COMES FROM (Codex P1, PR #502).
    //
    // origin/main ALONE is not the queue. The routine .claude/commands/ship.md
    // flow applies a migration at Step 5, while it is still uncommitted and
    // unmerged, and does not `git fetch origin` until Step 6. So an origin/main-only
    // listing misses two whole classes of waiting migration:
    //
    //   1. An older sibling authored in THIS checkout — the ship flow's own normal
    //      state. Applying the newer one returns allow and strands the sibling.
    //   2. Anything merged to main since the last fetch, which a stale
    //      remote-tracking ref simply cannot see.
    //
    // The queue is therefore the UNION of origin/main, the active branch's commit,
    // and the working tree — a file waiting in any of them is waiting. And because
    // (2) is invisible by construction, main's freshness is CHECKED rather than
    // hoped for: an unfetched ref refuses, with the command to fix it.
    try {
      // WHICH CHECKOUT HOLDS THE QUEUE (Codex P1 round 3, PR #502).
      //
      // The harness pins CLAUDE_PROJECT_DIR to the PRIMARY checkout even when the
      // session runs in a linked worktree — the same trap that once made this file
      // look for reviewer proofs in the wrong place. Reading HEAD and the working
      // tree from `projectDir` therefore reads the PRIMARY branch, so a migration
      // authored in the active worktree stayed invisible and the union added in the
      // previous round fixed nothing for worktree sessions. Mason runs dozens of
      // them, so this is the normal case, not the edge.
      //
      // Resolution reuses codex-push-lib's validated lookup rather than a second
      // copy. That lookup returns null for two DIFFERENT reasons — the listing
      // failed, or it succeeded and no worktree contained the cwd — and only the
      // second makes projectDir the right answer. Falling back on both was a
      // fail-OPEN, not the "fails closed" an earlier revision of this comment
      // claimed: see the memoised listWorktrees above. So the listing failure is
      // checked explicitly and refuses; a clean listing with no match still
      // legitimately means the primary checkout.
      const resolvedQueueRoot = resolveSessionWorktree(projectDir, hookCwd, listWorktrees);
      if (worktreeListError) {
        return block(
          `MIGRATION PENDING-SET GUARD: could not determine which checkout holds the migration ` +
          `queue — \`git worktree list\` failed (${worktreeListError?.message || worktreeListError}). ` +
          `The session may be running in a linked worktree whose migrations this guard cannot see, ` +
          `so whether an OLDER migration is still waiting is UNKNOWN. Refusing rather than scanning ` +
          `the primary checkout and stepping over a queue that lives somewhere else.\n\n` +
          `Retry once \`git worktree list --porcelain\` succeeds in ${projectDir}.`);
      }
      const queueRoot = resolvedQueueRoot || projectDir;
      const gitOut = (args) => execFileSync("git", args, {
        cwd: queueRoot,
        encoding: "utf8",
        // Well inside the tightest harness budget (Codex hooks allow 5s, Claude
        // 15s). A hook killed mid-flight emits NOTHING, and a PreToolUse hook that
        // emits nothing does not deny — so an over-long git call is a fail-OPEN on
        // a live apply. (CodeRabbit, PR #502.)
        timeout: GIT_CALL_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const sqlLines = (out) => String(out ?? "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /\.sql$/i.test(l));

      const listTracked = gitTrackedMigrations
        || (() => gitOut(["ls-tree", "-r", "--name-only", "origin/main", "--", "supabase/migrations"]));

      let trackedFiles;
      try {
        trackedFiles = sqlLines(listTracked());
      } catch (err) {
        return block(
          `MIGRATION PENDING-SET GUARD: could not list the migrations tracked on origin/main ` +
          `(${err?.message || err}), so whether an OLDER migration is still waiting to be applied ` +
          `is UNKNOWN. Refusing the apply rather than stepping over a queue this guard cannot see.\n\n` +
          `Run \`git fetch origin\` in ${queueRoot} so origin/main resolves, then retry.`);
      }

      // The active branch's committed migrations. Skipped when the caller injected
      // the listing — an injected `gitTrackedMigrations` IS the git-visible queue,
      // and tests supply it whole rather than per-ref.
      if (!gitTrackedMigrations) {
        try {
          trackedFiles = trackedFiles.concat(
            sqlLines(gitOut(["ls-tree", "-r", "--name-only", "HEAD", "--", "supabase/migrations"])));
        } catch (err) {
          return block(
            `MIGRATION PENDING-SET GUARD: could not list the migrations committed on this branch ` +
            `(${err?.message || err}). The active checkout is part of the queue — the ship flow ` +
            `applies a migration before it is merged — so without it an older sibling on this branch ` +
            `would be invisible and could be stranded. An unknown verdict is not a pass.`);
        }
      }
      try {
        const migDir = path.join(queueRoot, "supabase", "migrations");
        if (existsSync(migDir)) {
          for (const entry of readdirSync(migDir)) {
            if (/\.sql$/i.test(entry)) trackedFiles.push(`supabase/migrations/${entry}`);
          }
        }
      } catch { /* additive only; git sources above already carry the committed queue */ }
      trackedFiles = [...new Set(trackedFiles)];

      // FRESHNESS OF main. A remote-tracking ref is only as current as the last
      // fetch, and the ship flow fetches AFTER applying. An unfetched ref cannot
      // see a migration merged minutes ago, and that invisibility is exactly the
      // 2026-08-26 shape. So this is checked, not assumed.
      let mainSha = "unknown";
      try {
        mainSha = gitOut(["rev-parse", "--short", "origin/main"]).trim() || "unknown";
      } catch { /* reported as unknown; the listing above already refused if broken */ }

      const fetchAgeMs = originFetchAge
        ? originFetchAge(queueRoot, now)
        : originFetchAgeMs(queueRoot, now);
      if (fetchAgeMs === null) {
        return block(
          `MIGRATION PENDING-SET GUARD: cannot establish when this checkout last fetched from ` +
          `origin, so whether origin/main is current is UNKNOWN. A stale ref cannot see a migration ` +
          `merged since the last fetch, which is precisely how a waiting migration gets stranded. ` +
          `An unknown verdict is not a pass.\n\n` +
          `Run \`git fetch origin\` in ${queueRoot}, then retry.`);
      }
      if (fetchAgeMs > MAIN_REF_MAX_AGE_MS) {
        return block(
          `MIGRATION PENDING-SET GUARD: this checkout last fetched from origin ` +
          `${Math.floor(fetchAgeMs / 60000)} minutes ago, so origin/main (@ ${mainSha}) may be behind. ` +
          `A migration merged since then is invisible to this check, and applying over it strands ` +
          `it permanently — the 2026-08-26 defect exactly. Refusing rather than judging the queue ` +
          `from a stale ref.\n\n` +
          `Run \`git fetch origin\` in ${queueRoot}, then retry.`);
      }

      let baselineHighWater = null;
      try {
        const manifest = JSON.parse(
          readFileSync(path.join(queueRoot, "supabase", "baselines", "manifest.json"), "utf8"));
        baselineHighWater = manifest?.migrations_high_water ?? null;
      } catch (err) {
        return block(
          `MIGRATION PENDING-SET GUARD: could not read the schema-baseline manifest at ` +
          `${path.join("supabase", "baselines", "manifest.json")} (${err?.message || err}). Its ` +
          `\`migrations_high_water\` is the floor for the pending scan — without it the scan would ` +
          `have to judge pre-baseline history it cannot reconstruct, so it has no verdict. An ` +
          `unknown verdict is not a pass. Refusing the apply.`);
      }

      const pendingCheck = checkPendingMigrations({
        name: migName,
        sql: migQuery,
        appliedNames,
        trackedFiles,
        baselineHighWater,
      });

      if (!pendingCheck.ok) {
        return block(`${pendingCheck.reason}\n\n(Pending set computed against origin/main @ ${mainSha}. ` +
          `If that ref is stale, \`git fetch origin\` and retry.)`);
      }
      if (pendingCheck.abstained) {
        return block(
          `MIGRATION PENDING-SET GUARD: the pending-set check reached no verdict for "${safeName}", ` +
          `so whether an OLDER tracked migration is still waiting is UNKNOWN — because ` +
          `${pendingCheck.abstainReason}. An unknown verdict is not a pass. Refusing the apply.\n\n` +
          `(Checked against origin/main @ ${mainSha}.)`);
      }
    } catch (err) {
      // A crash in the pending check must not silently wave a migration through.
      return block(
        `MIGRATION PENDING-SET GUARD failed to evaluate "${safeName}": ${err?.message || err}. ` +
        `Refusing the apply rather than skipping the check. Fix ` +
        `${path.join(".claude", "hooks", "migration-pending-lib.mjs")} — do not route around this ` +
        `by applying through another channel.`);
    }
  }

  // HARD carve-out (Mason's settled 2026-07-13 policy): in a hands-free run, a
  // DESTRUCTIVE migration — apply-time DELETE/TRUNCATE/DROP of data — NEVER
  // applies autonomously, review proof or not. Deleted data has no PITR on the
  // free Supabase plan. Checked BEFORE the proof gate so a clean review cannot
  // override it.
  //
  // Autopilot flag state drives which rule-set applies (Codex P1s, 2026-07-13
  // rounds 2-3):
  //   absent → interactive rules (Mason present; his in-chat OK is the gate).
  //   active → hands-free rules below (destructive refused; Codex gate + exact
  //            queryHash binding required).
  //   stale (file exists but EXPIRED or malformed) → the authorization has
  //            LAPSED with nobody watching: block ALL applies, benign or not,
  //            until Mason re-arms (a fresh explicit authorization) or disarms
  //            (--off deletes the flag, restoring interactive rules in person).
  const apFlagPath = path.join(stateDir, "AUTOPILOT.on");
  let flagState = "absent";
  try {
    if (existsSync(apFlagPath)) {
      try { flagState = flagActive(readFileSync(apFlagPath, "utf8"), now).active ? "active" : "stale"; }
      catch { flagState = "stale"; }
    }
  } catch { flagState = "stale"; } // can't even inspect the flag → fail closed

  if (flagState === "stale") {
    return block(
      `MIGRATION APPLY GUARD: an autopilot flag exists but is EXPIRED or malformed — the hands-free ` +
      `authorization for this run has LAPSED, and no one is confirmed present. ALL migration applies ` +
      `are parked (benign ones too). PARK the migration (scripts/.staging-migrations/ + a ` +
      `docs/manual/KNOWN_ISSUES.md note) and wait for Mason: he can re-arm ` +
      `(node .claude/hooks/autopilot-arm.mjs --hours N) or disarm in person (--off). ` +
      `Do NOT delete or rewrite the flag yourself to get past this.`);
  }

  const handsFree = flagState === "active";

  if (handsFree && migQuery) {
    // Fail CLOSED in hands-free mode: a classifier error counts as destructive.
    let d;
    try { d = destructiveMigrationCheck(migQuery); }
    catch (e) { d = { destructive: true, reason: `destructive-check error (${e && e.message ? e.message : e}) — failing closed hands-free` }; }
    if (d.destructive) {
      return block(
        `MIGRATION APPLY GUARD (hands-free run): migration "${migName || "(unnamed)"}" contains a ` +
        `destructive statement (${d.reason}). Destructive migrations NEVER apply autonomously — ` +
        `Mason's settled 2026-07-13 policy — because deleted data has no point-in-time recovery on ` +
        `this Supabase plan. PARK it (scripts/.staging-migrations/ + a docs/manual/KNOWN_ISSUES.md ` +
        `entry with the plain-English risk) and leave it for Mason's explicit in-chat OK in the morning. ` +
        `Do NOT disarm autopilot to route around this. (This rule also fires on an EXPIRED autopilot ` +
        `flag — deliberate fail-closed. If Mason IS present and approves in chat, HE can ask you to ` +
        `disarm first: node .claude/hooks/autopilot-arm.mjs --off.)`);
    }
  }

  // Look at all proof files in stateDir and find a recent one for this migration.
  const MAX_AGE_MS = PROOF_MAX_AGE_MS;

  let validProof = null;
  let contentMismatchedProof = null;
  let evidenceMismatchedProof = null;
  let activeEvidenceHash = null;
  let protectedReviewerPolicyCommit = reviewerPolicyCommit ?? null;
  try {
    activeEvidenceHash = migrationProofEvidenceHash({
      projectDir: activeProofRoot,
      stateDir: activeProofStateDir,
    });
  } catch { /* unreadable active evidence is never a valid proof */ }
  if (reviewerPolicyCommit === undefined) try {
    protectedReviewerPolicyCommit = execFileSync(fixedGitExecutable(), ["--no-replace-objects", "rev-parse", "origin/main^{commit}"], {
      cwd: activeProofRoot, encoding: "utf8", timeout: GIT_CALL_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"], env: protectedGitEnv(),
    }).trim();
  } catch { /* an unverifiable protected policy never authorizes an apply */ }
  const freshCleanProofNames = [];
  for (const dir of authorizedProofDirs) {
    if (validProof) break;
    try {
      const files = readdirSync(dir).filter(f => f.startsWith("migration-review-") && f.endsWith(".json"));
      for (const f of files) {
        const full = path.join(dir, f);
        let data;
        try { data = JSON.parse(readFileSync(full, "utf8")); } catch { continue; }
        let ageMs;
        try { ageMs = now - new Date(data.timestamp).getTime(); } catch { continue; }
        // Age must be a real value inside [0, 30min] — a FUTURE-dated timestamp
        // (clock skew, typo, or a fabricated far-future stamp) must not stay
        // "fresh" forever (Codex P2 2026-07-13 round 5). NaN fails this too.
        if (!(ageMs >= 0 && ageMs <= MAX_AGE_MS)) continue;
        // Match if proof migration name appears in the apply_migration `name` field
        // or if the apply_migration name matches.
        // SUBSTRING MATCHING IS THE REPLAY MECHANISM (Codex P1, PR #470 round 7).
        // A name that CONTAINS another migration's name inherits its reviewer proof:
        // copy reviewed bytes to `99999999999999_alias_<old-name>.sql` and the proof
        // for `<old-name>` still matches, the queryHash still matches (same SQL), and
        // the ordering check reads the alias's leading stamp as newest. Codex
        // reproduced `APPLY GATE PASSED` on a real dry run. Two earlier fixes — removing
        // `--name`, then requiring one 14-digit stamp — each closed a SHAPE of the alias
        // and left the mechanism intact; a legacy 8-digit name like
        // `20260210_fix_rls_critical_issues` defeated the stamp-count rule outright.
        //
        // `requireExactProofName` binds a proof to exactly one migration, and it now
        // DEFAULTS TO TRUE — so both doors are closed: scripts/apply-migration-file.mjs
        // (which set it explicitly from PR #470) and the PreToolUse hook covering MCP
        // `apply_migration`, which passes no flag and therefore inherits the safe value.
        // The MCP path is the door used for ROUTINE migrations, so leaving it lenient
        // meant the earlier fix hardened the rare door and left the common one open.
        //
        // Comparison is on NORMALIZED names (basename, `.sql` stripped), not raw strings.
        // Substring matching had been absorbing a real difference — write-apply-proofs.mjs
        // records a bare name while an apply call may carry `<name>.sql` or a repo path —
        // so naive equality would have refused legitimate applies. Normalizing keeps that
        // tolerance and still refuses every alias, because an alias differs in its STEM,
        // which survives normalization.
        const proofName = (data.migration || "").toString();
        const nameMatches = requireExactProofName
          ? normalizeMigName(proofName) === normalizeMigName(migName)
          : (migName.includes(proofName) || proofName.includes(migName) || migName === proofName);
        // Remember a fresh, clean proof that failed ONLY on identity, so the refusal
        // can say "the proof names a DIFFERENT migration" instead of "no proof found".
        // Without this the operator sees a missing-proof message while a proof sits
        // right there, and the natural next move is to re-mint — which will not help.
        if (proofName && !nameMatches) {
          const fnd = (data.findings || "").toString();
          if (fnd === "clean" || fnd === "blockers-fixed") freshCleanProofNames.push(proofName);
        }
        if (proofName && nameMatches) {
          const findings = (data.findings || "").toString();
          if (findings === "clean" || findings === "blockers-fixed") {
            // Exact content binding is mandatory in every mode. A missing hash
            // or any mismatch means the proof does not attest to the SQL being
            // transmitted and cannot authorize this apply.
            if (!data.queryHash || data.queryHash !== currentHash) {
              if (!contentMismatchedProof) contentMismatchedProof = { file: f, dir, data };
              continue;
            }
            // The reviewer also judges registry, ledger, prior declarations,
            // application callers, its charter, and the wrapper prompt. A
            // migration-only hash would let any of those inputs move after a
            // clean verdict. This is required in every mode: Mason's presence
            // is authorization, not a reason to accept stale evidence.
            const expectedEvidenceHash = activeEvidenceHash;
            if (!data.evidenceHash || !expectedEvidenceHash || data.evidenceHash !== expectedEvidenceHash
              || (reviewerPolicyCommit !== null && (!protectedReviewerPolicyCommit || data.reviewerPolicyCommit !== protectedReviewerPolicyCommit))) {
              if (!evidenceMismatchedProof) evidenceMismatchedProof = { file: f, dir, data, expectedEvidenceHash };
              continue;
            }
            validProof = { file: f, dir, data };
            break;
          }
        }
      }
    } catch { /* directory unreadable — try the next one, then fall through to block */ }
  }

  if (!validProof && handsFree && contentMismatchedProof) {
    const proofHash = String(contentMismatchedProof.data.queryHash || "");
    return block(
      `MIGRATION APPLY GUARD (hands-free run): the reviewer proof for "${migName || "(unnamed)"}" ` +
      `is not content-bound — autonomous applies require "queryHash" in the proof to be present and ` +
      `exactly match the SHA-256 of the transmitted SQL (expected: ${currentHash || "(no query text)"}; ` +
      `received: ${proofHash || "(missing)"}). Re-confirm the reviewers against the CURRENT SQL, ` +
      `update the proof's queryHash, and retry.`);
  }

  if (!validProof && evidenceMismatchedProof) {
    const proofHash = String(evidenceMismatchedProof.data.evidenceHash || "");
    return block(
      `MIGRATION APPLY GUARD: the reviewer proof for "${migName || "(unnamed)"}" is not evidence-bound — ` +
      `proofs require "evidenceHash" to match every repository input and reviewer charter that the ` +
      `verdict saw (expected: ${evidenceMismatchedProof.expectedEvidenceHash || "(unreadable evidence)"}; ` +
      `received: ${proofHash || "(missing)"}). Re-run node scripts/write-apply-proofs.mjs against the ` +
      `CURRENT checkout; never edit proof JSON by hand.`);
  }

  if (validProof) {
    // Hands-free applies carry three EXTRA requirements (Codex P1s 2026-07-13
    // rounds 2-3) — with Mason absent, the proof must be maximally bound:
    //   1. Exact content binding is already mandatory for every apply above;
    //      the hands-free branch repeats it as defense in depth.
    //   2. A recorded Codex Sol/high verdict (separate reviewer gate actually ran — Mason's
    //      "ran, not queued" rule).
    //   3. A FRESH Codex output artifact on disk (<30 min): /codex-review tees
    //      its output to .claude/session-state/codex-review-latest.txt. A
    //      verdict field with no fresh artifact means Codex was not actually
    //      run this session. (Honest-mistake net: a determined agent could
    //      forge the artifact — that residual is documented in
    //      docs/manual/KNOWN_ISSUES.md §4b proof self-attestation.)
    if (handsFree) {
      const proofHash = String(validProof.data.queryHash || "");
      if (!proofHash || !currentHash || proofHash !== currentHash) {
        return block(
          `MIGRATION APPLY GUARD (hands-free run): the reviewer proof for "${migName || "(unnamed)"}" ` +
          `is not content-bound — autonomous applies require "queryHash" in the proof to be present and ` +
          `exactly match the SHA-256 of the transmitted SQL (expected: ${currentHash || "(no query text)"}). ` +
          `Re-confirm the reviewers against the CURRENT SQL, update the proof's queryHash, and retry.`);
      }
      // The proof must name BOTH required reviewers (Codex P1 2026-07-13 round
      // 5: a minimal hand-written proof with no reviewers array reached allow).
      // Still self-attestable — the residual documented in KNOWN_ISSUES §4b —
      // but it forces the /migration-review flow, which only writes the array
      // after the reviewer subagents actually returned clean.
      const reviewers = Array.isArray(validProof.data.reviewers) ? validProof.data.reviewers.map(String) : [];
      const missing = ["rls-security-reviewer", "migration-drift-reviewer"].filter(r => !reviewers.includes(r));
      if (missing.length) {
        return block(
          `MIGRATION APPLY GUARD (hands-free run): the reviewer proof for "${migName || "(unnamed)"}" ` +
          `does not record the required reviewers (missing: ${missing.join(", ")}). Autonomous applies ` +
          `require BOTH rls-security-reviewer and migration-drift-reviewer to have actually run clean ` +
          `this session (dispatch them via /migration-review, then write the proof with its "reviewers" ` +
          `array). Never add names for reviewers that did not run.`);
      }
      // The Codex gate is its own content-bound proof file — NOT a field in the
      // reviewer proof, NOT the mtime of a tee'd log (Codex P1 2026-07-13 round
      // 4: a stray codex-review-latest.txt from an unrelated or FAILED run
      // satisfied an mtime check). Required shape at
      // .claude/session-state/codex-review-mig-<safeName>.json:
      //   { "queryHash": <sha256 of the EXACT transmitted SQL>,
      //     "verdict": "clean" | "ship" | "ship-with-followups",
      //     "model": "gpt-5.6-sol",
      //     "reasoning_effort": "high",
      //     "timestamp": <ISO-8601, <30 min old> }
      // Write it ONLY after an ACTUAL /codex-review run on this migration this
      // session — a fabricated file violates Mason's codex-gate rule and is the
      // documented self-attestation residual (KNOWN_ISSUES §4b). Searched only
      // in the active worktree's proof directory, just like reviewer proof above:
      // a sibling proof is evidence for a different checkout. A candidate only
      // WINS by satisfying
      // every criterion the single-directory version demanded — clean verdict,
      // exact queryHash, age inside [0, 30min]; the first parseable file is kept
      // only so the block message below can say which criterion failed.
      let codexProof = null;
      let codexProofEvidenceHash = null;
      for (const dir of authorizedProofDirs) {
        let candidate = null;
        try { candidate = JSON.parse(readFileSync(path.join(dir, `codex-review-mig-${safeName}.json`), "utf8")); } catch { continue; }
        if (!candidate) continue;
        const candidateEvidenceHash = activeEvidenceHash;
        if (!codexProof) {
          codexProof = candidate;
          codexProofEvidenceHash = candidateEvidenceHash;
        }
        const okVerdict = ["clean", "ship", "ship-with-followups"].includes(String(candidate.verdict || "").toLowerCase());
        const okHash = !!currentHash && String(candidate.queryHash || "") === currentHash;
        const okEvidenceHash = !!candidateEvidenceHash && String(candidate.evidenceHash || "") === candidateEvidenceHash;
        const okIdentity = candidate.model === REQUIRED_CODEX_MODEL
          && candidate.reasoning_effort === REQUIRED_CODEX_EFFORT;
        let okFresh = false;
        try {
          const candidateAge = now - new Date(candidate.timestamp).getTime();
          okFresh = candidateAge >= 0 && candidateAge <= MAX_AGE_MS;
        } catch { okFresh = false; }
        if (okVerdict && okHash && okEvidenceHash && okIdentity && okFresh) {
          codexProof = candidate;
          codexProofEvidenceHash = candidateEvidenceHash;
          break;
        }
      }
      const cvOk = codexProof && ["clean", "ship", "ship-with-followups"].includes(String(codexProof.verdict || "").toLowerCase());
      const cvHashOk = codexProof && currentHash && String(codexProof.queryHash || "") === currentHash;
      const cvEvidenceHashOk = codexProof && codexProofEvidenceHash
        && String(codexProof.evidenceHash || "") === codexProofEvidenceHash;
      const cvIdentityOk = codexProof
        && codexProof.model === REQUIRED_CODEX_MODEL
        && codexProof.reasoning_effort === REQUIRED_CODEX_EFFORT;
      // Freshness = age inside [0, 30min]; a FUTURE-dated timestamp must not
      // count as fresh (Codex P2 round 5 — clock skew / typo / fabrication).
      let cvFresh = false;
      try {
        const cvAge = now - new Date(codexProof.timestamp).getTime();
        cvFresh = !!codexProof && cvAge >= 0 && cvAge <= MAX_AGE_MS;
      } catch { cvFresh = false; }
      if (!cvOk || !cvHashOk || !cvEvidenceHashOk || !cvIdentityOk || !cvFresh) {
        return block(
          `MIGRATION APPLY GUARD (hands-free run): the Sol high-effort gate is not satisfied for ` +
          `"${migName || "(unnamed)"}" (${!codexProof ? "no Codex proof file" : !cvOk ? "verdict is not clean/ship" : !cvHashOk ? "queryHash does not match the transmitted SQL" : !cvEvidenceHashOk ? "evidenceHash does not match the reviewed source surface" : !cvIdentityOk ? `proof must record model=${REQUIRED_CODEX_MODEL} and reasoning_effort=${REQUIRED_CODEX_EFFORT}` : "proof timestamp is not within the last 30 minutes"}). ` +
          `Autonomous applies require a fresh, content-bound Codex verdict (Mason's settled 2026-07-13 ` +
          `policy). Run: node scripts/write-apply-proofs.mjs ${migName || "<migName>"} — it runs the ` +
          `trusted Codex CLI itself and mints the content-bound proof ONLY on a CLEAN machine verdict. ` +
          `Do NOT hand-write the proof JSON (review-proof-guard blocks any command naming it, by design). ` +
          `A BLOCKERS verdict or a failed Codex run does NOT qualify — fix the findings or PARK the ` +
          `migration for Mason. Never self-certify.`);
      }
    }
    return allow();
  }

  // No valid proof — block with explicit instructions.
  return block(
    `MIGRATION APPLY GUARD: Cannot apply migration "${migName || "(unnamed)"}" without subagent review proof.\n\n` +
    (freshCleanProofNames.length
      ? `Fresh, clean proof(s) ARE present, but none of them names this migration:\n` +
        freshCleanProofNames.slice(0, 6).map((n) => `  proof names: "${n}"\n`).join("") +
        (freshCleanProofNames.length > 6 ? `  … and ${freshCleanProofNames.length - 6} more\n` : "") +
        `  you applied: "${migName}"\n` +
        `A proof binds to exactly ONE migration, so a proof for another one cannot authorise\n` +
        `this apply — which is normal and expected while applying a BATCH. If one of the names\n` +
        `above should be identical to yours, the file being applied is not the file that was\n` +
        `reviewed: check the filename. Re-minting will NOT help until the names agree.\n\n`
      : "") +
    `REQUIRED STEPS before retrying this call:\n` +
    `  1. Dispatch in PARALLEL (single message with two Agent tool calls):\n` +
    `       Agent: rls-security-reviewer    (scope: this migration)\n` +
    `       Agent: migration-drift-reviewer (scope: this migration)\n` +
    `  2. If either returns BLOCKER findings, FIX them and re-dispatch until clean.\n` +
    `  3. Once both return clean (or "blockers-fixed"), stamp the proof with the wrapper\n` +
    `     (it computes the content hash itself — do not hand-write the JSON):\n` +
    `       node scripts/write-apply-proofs.mjs ${migName || "<migName>"}\n` +
    `     (The wrapper ALWAYS runs a real Codex review of the file and mints nothing\n` +
    `      without a CLEAN machine verdict — a BLOCKERS or failed run means fix or park.)\n` +
    `  4. AUTHORIZATION — the proof gate is a floor, NOT the authorization: in an\n` +
    `     ordinary interactive session, get Mason's explicit in-chat OK before applying.\n` +
    `     (Only a Mason-pre-authorized hands-free run with autopilot armed may apply\n` +
    `      without the per-migration ask — settled 2026-07-13; destructive migrations never.)\n` +
    `  5. Retry the apply_migration call.\n\n` +
    `The proof file expires after 30 minutes — this catches stale reviews on long sessions.\n` +
    `The "queryHash" above is the SHA-256 of the exact SQL being applied; it binds this proof to\n` +
    `this content. If the migration is edited after review, the hash changes and this guard blocks\n` +
    `again — re-confirm the reviewers, then update queryHash to the new value printed here.\n` +
    `This guard exists because of the B7/B8/B9 incidents (2026-05-26) where migrations were\n` +
    `applied without the parallel-session reviewers catching anon-EXECUTE-able SECDEF DML.`
  );
}
