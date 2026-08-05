#!/usr/bin/env node
/**
 * log-session.mjs regression guards.
 *
 * Four defects were found on 2026-08-04 when the script generated a changelog
 * entry for a docs-only session:
 *
 *   1. `--help` was not handled, fell through as an unknown flag, and WROTE a
 *      live {SUMMARY} stub into docs/CHANGELOG.md.
 *   2. `--author=Mason` never matches agent-authored commits, so every agent
 *      session fell through to `git log -15` and claimed 14 unrelated commits
 *      as "Commits this session".
 *   3. The migrations lookup backfilled from the last 15 commits when the branch
 *      diff was empty, inventing 7 statement migrations for a session that
 *      touched none.
 *   4. The whole --summary string was used as the "## " heading.
 *
 * The behavioural checks below run the real script. The source-level checks
 * assert that the removed fallbacks stay removed — log-session.mjs is a live,
 * mutable file, so re-introducing `git log -15` genuinely fails this test.
 *
 * ⚠️ If you mutation-test defect (1) by disabling the --help guard, the script
 * WILL write a real stub into docs/CHANGELOG.md before this suite catches it.
 * Do that against a scratch copy of the repo, not the working tree, or be ready
 * to `git checkout -- docs/CHANGELOG.md` afterwards.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const script = path.join(here, "log-session.mjs");
const changelog = path.join(root, "docs", "CHANGELOG.md");

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass += 1; };
const eq = (a, b, msg) => { assert.equal(a, b, msg); pass += 1; };

const digest = () => createHash("sha256").update(readFileSync(changelog)).digest("hex");
function run(args, env) {
  return execFileSync("node", [script, ...args], {
    encoding: "utf8", timeout: 30000, cwd: root, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(env || {}) },
  });
}

// This suite runs inside `test:correction-guards`, i.e. the pre-commit gate. It
// must therefore NEVER hard-fail merely because the checkout lacks a local
// origin/main — shallow clones, fresh worktrees and remote containers routinely
// do. Raised by Codex on PR #310: an unguarded `git diff origin/main...HEAD`
// exits 128 there and aborts the whole guard suite, blocking commits.
function git(args) {
  try {
    return {
      ok: true,
      out: execFileSync("git", args, {
        encoding: "utf8", timeout: 15000, cwd: root, stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    };
  } catch {
    return { ok: false, out: "" };
  }
}
const originMain = git(["rev-parse", "--verify", "--quiet", "origin/main^{commit}"]);
const HAS_ORIGIN_MAIN = originMain.ok && Boolean(originMain.out);
let skipped = 0;
function needsOriginMain(label, fn) {
  if (!HAS_ORIGIN_MAIN) {
    console.log(`  SKIP (no local origin/main): ${label}`);
    skipped += 1;
    return;
  }
  fn();
}

// ── 1. --help must print usage and write nothing ───────────────────────────
{
  const before = digest();
  const out = run(["--help"]);
  eq(digest(), before, "--help must not modify docs/CHANGELOG.md");
  ok(/Usage:/.test(out), "--help prints usage");
  ok(!/^## \d{4}-\d{2}-\d{2}/m.test(out), "--help does not emit a changelog entry");

  const beforeShort = digest();
  run(["-h"]);
  eq(digest(), beforeShort, "-h must not modify docs/CHANGELOG.md either");
}

// ── 2. --dry-run must write nothing ─────────────────────────────────────
// Needs origin/main: the script now refuses to run without it (by design), so
// a success-path assertion is only meaningful where the ref exists.
needsOriginMain("--dry-run writes nothing", () => {
  const before = digest();
  const out = run(["--dry-run", "--summary", "Probe entry from the log-session test suite."]);
  eq(digest(), before, "--dry-run must not modify docs/CHANGELOG.md");
  ok(/DRY RUN/.test(out), "--dry-run says so");
});

// ── 3. The heading is a SHORT title, not the whole summary ─────────────────
needsOriginMain("heading is a short derived title", () => {
  const long =
    "First sentence that belongs in the heading. Second sentence that must never " +
    "reach the heading because it makes the table of contents unreadable. Third one too.";
  const out = run(["--dry-run", "--summary", long]);
  const heading = out.split("\n").find((l) => /^## \d{4}-\d{2}-\d{2} — /.test(l));
  ok(heading, "an entry heading is produced");
  ok(heading.length < 120, `heading stays short (was ${heading.length} chars): ${heading}`);
  ok(
    !heading.includes("Second sentence"),
    "the second sentence must not be folded into the heading",
  );
  ok(out.includes("Second sentence"), "the full summary still appears as the lead paragraph");
});

// ── 3b. A checkout without origin/main is REFUSED, not guessed at ──────────
// The mirror of block 6: the script must not fall back to a time window when
// the base ref is simply missing, and must say what to do about it.
if (!HAS_ORIGIN_MAIN) {
  const before = digest();
  let threw = false;
  let stderr = "";
  try {
    run(["--summary", "No origin/main here; this must be refused."]);
  } catch (err) {
    threw = true;
    stderr = String(err.stderr || "");
  }
  ok(threw, "without origin/main the script must exit non-zero");
  eq(digest(), before, "without origin/main docs/CHANGELOG.md must be untouched");
  ok(/git fetch origin main/.test(stderr), "the refusal must tell the reader to fetch");
}

// ── 4. Migrations are never backfilled from unrelated history ──────────────
{
  // Strip `//` comments: the header deliberately DESCRIBES the removed fallbacks,
  // and the guard is about executable code, not the prose explaining the fix.
  const src = readFileSync(script, "utf8")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  ok(
    !/log["'\s,\]]*-15/.test(src),
    "`git log -15` must not return as a commit or migration fallback — it attributes " +
      "unrelated merged work to the current session",
  );
  ok(
    !/--author=Mason/.test(src),
    "the --author=Mason filter must stay removed; it never matched agent commits and " +
      "was what triggered the bad fallback",
  );
  ok(
    /origin\/main\.\.HEAD/.test(src),
    "commits must be scoped to this branch (origin/main..HEAD)",
  );
  ok(
    !/--since=/.test(src),
    "the 12-hour window must stay removed — when HEAD is level with origin/main it " +
      "lists everyone's recent merges to main under 'Commits this session', which is " +
      "the same false attribution as the `git log -15` fallback (Codex, PR #310)",
  );
  ok(
    /origin\/main\.\.\.HEAD/.test(src) && /supabase\/migrations/.test(src),
    "migrations must come from the branch diff",
  );
}

// ── 5. A real run reports migrations honestly for this branch ──────────────
needsOriginMain("reported migrations equal the branch diff", () => {
  const out = run(["--dry-run", "--summary", "Attribution probe."]);
  const migBlock = out.slice(out.indexOf("**Migrations touched**"));
  const claimed = [...migBlock.matchAll(/supabase\/migrations\/[\w.-]+\.sql/g)].map((m) => m[0]);
  const diff = git(["diff", "--name-only", "origin/main...HEAD", "--", "supabase/migrations"]);
  ok(diff.ok, "the reference diff itself must succeed when origin/main exists");
  const actual = diff.out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /\.sql$/.test(l));
  assert.deepEqual(
    claimed.sort(),
    actual.sort(),
    "reported migrations must equal the branch diff exactly — no invented entries",
  );
  pass += 1;
});

// ── 6. A git FAILURE must stop the write path, not fall back ───────────────
// Raised by CodeRabbit on PR #310: runGit() collapsed every git error into "",
// so an unreachable origin/main looked identical to "no commits ahead" — the
// script then used the unrelated 12-hour window and reported no migrations,
// resurrecting the exact false-attribution bug defect (2) was about.
// GIT_DIR is inherited by the script's git calls, so pointing it at a
// nonexistent directory makes every git command fail for real.
{
  const before = digest();
  let threw = false;
  let stderr = "";
  try {
    run(["--summary", "This run must be refused, not written."], {
      GIT_DIR: "/nonexistent-git-dir-for-log-session-test",
    });
  } catch (err) {
    threw = true;
    stderr = String(err.stderr || "");
  }
  ok(threw, "the script must exit non-zero when git cannot resolve origin/main");
  eq(digest(), before, "a git failure must leave docs/CHANGELOG.md untouched");
  ok(
    /ERROR/.test(stderr),
    `the refusal must be explained on stderr (got: ${stderr.slice(0, 200)})`,
  );
  ok(
    !/--since=12\.hours/.test(stderr),
    "a git failure must NOT silently fall back to the temporal window",
  );
}

console.log(
  `log-session.test.mjs — ${pass} assertions passed` +
    (skipped ? ` (${skipped} block(s) skipped: no local origin/main)` : ""),
);
