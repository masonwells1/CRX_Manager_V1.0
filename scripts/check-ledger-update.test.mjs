#!/usr/bin/env node
// Tests for the pre-commit ledger guard (scripts/check-ledger-update.mjs).
// Run: node scripts/check-ledger-update.test.mjs

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ledgerCheck } from "./check-ledger-update.mjs";
import { scratchHookEnvironment } from "../.claude/hooks/git-test-env.mjs";

let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }
function eq(a, b, m) { assert.equal(a, b, m); pass++; }

const ledgerGuardSource = readFileSync(new URL("./check-ledger-update.mjs", import.meta.url), "utf8");
ok(ledgerGuardSource.includes('"--diff-filter=ACMRTD"'), "CLI includes staged Git type changes");
ok(ledgerGuardSource.includes('"--no-renames"'), "CLI preserves both sides of staged renames");

// ── no triggers → always ok ─────────────────────────────────────────────────
eq(ledgerCheck([]).ok, true, "empty commit is ok");
eq(ledgerCheck(["src/pages/Invoices.tsx", "src/lib/money.ts"]).ok, true, "pure src/ change needs no ledger");
eq(ledgerCheck(["docs/reference/gotchas.md"]).ok, true, "ordinary doc edit is not a trigger");
eq(ledgerCheck(["scripts/smoke/run-smoke.mjs"]).ok, true, "non-guard script is not a trigger");
eq(ledgerCheck(["package.json", "package-lock.json"]).ok, true, "dependency bump alone is not a trigger");

// ── triggers WITHOUT a ledger → blocked ─────────────────────────────────────
eq(ledgerCheck([".claude/hooks/migration-apply-guard.mjs"]).ok, false, "hook change without ledger is blocked");
eq(ledgerCheck([".claude/commands/ship.md"]).ok, false, "command change without ledger is blocked");
eq(ledgerCheck([".claude/skills/codex-review/SKILL.md"]).ok, false, "skill change without ledger is blocked");
eq(ledgerCheck([".claude/workflows/migration-review.js"]).ok, false, "workflow change without ledger is blocked");
eq(ledgerCheck([".claude/settings.json"]).ok, false, "settings change without ledger is blocked");
eq(ledgerCheck([".codex/hooks/production-action-guard.mjs"]).ok, false, "Codex guard change without ledger is blocked");
eq(ledgerCheck([".codex/hooks.json"]).ok, false, "Codex hook manifest change without ledger is blocked");
eq(ledgerCheck(["AGENTS.md"]).ok, false, "shared-contract change without ledger is blocked");
eq(ledgerCheck(["CLAUDE.md"]).ok, false, "CLAUDE.md change without ledger is blocked");
eq(ledgerCheck([".husky/pre-commit"]).ok, false, "pre-commit hook change without ledger is blocked");
eq(ledgerCheck(["scripts/check-doc-drift.mjs"]).ok, false, "guard-script change without ledger is blocked");
eq(ledgerCheck(["scripts/validate-sql.sh"]).ok, false, "validator change without ledger is blocked");
eq(ledgerCheck(["scripts/verify-deps.mjs"]).ok, false, "verifier change without ledger is blocked");
eq(ledgerCheck(["scripts/sync-agent-workflows.mjs"]).ok, false, "workflow-sync change without ledger is blocked");
eq(ledgerCheck(["scripts/run-claude-review.mjs"]).ok, false, "Claude proof wrapper change without ledger is blocked");
eq(ledgerCheck(["scripts/write-codex-push-proof.mjs"]).ok, false, "Codex proof wrapper change without ledger is blocked");
eq(ledgerCheck(["scripts/check-ledger-update.mjs"]).ok, false, "this guard itself is a trigger (self-covering)");
eq(ledgerCheck(["supabase/migrations/20260716000000_add_foo.sql"]).ok, false, "a new migration without a ledger update is blocked (2026-07-16)");
ok(/ledger/i.test(ledgerCheck(["AGENTS.md"]).reason), "block reason explains the ledger requirement");
eq(ledgerCheck([".claude/hooks/guards.test.mjs", "src/lib/db.ts"]).ok, false, "mixed commit with a hook-test change still needs a ledger");

// ── docs/changelog.d/ entry files (2026-08-25) ──────────────────────────────
// An entry counts ONLY when git reports it as ADDED. Modifying or deleting an
// existing entry records nothing about THIS commit — it would let a session edit
// someone else's entry instead of writing its own (Codex P2, PR #482).
// Entries must now carry CONTENT: the guard validates that a fragment actually records
// something, because with the consolidation tool split out nothing else does.
const NL = String.fromCharCode(10);
const bodyFor = (p) => "## " + (p.split("/").pop() || "").slice(0, 10) + " - a real entry" + NL + NL + "detail" + NL;
const added = (p, content = bodyFor(p)) => ({ path: p, status: "A", content });
const modified = (p) => ({ path: p, status: "M", content: bodyFor(p) });
const deleted = (p, content = bodyFor(p)) => ({ path: p, status: "D", content });

eq(ledgerCheck([".claude/settings.json", added("docs/changelog.d/2026-08-25-thing.md")]).ok, true,
  "an ADDED dated entry satisfies the ledger requirement");
eq(ledgerCheck(["AGENTS.md", added("docs/changelog.d/2026-08-25-a.md")]).ok, true,
  "contract change recorded via an added entry is allowed");
eq(ledgerCheck(["supabase/migrations/20260825000000_x.sql", added("docs/changelog.d/2026-08-25-mig.md")]).ok, true,
  "a migration recorded via an added entry is allowed");

// The hole this closes.
eq(ledgerCheck([".claude/settings.json", modified("docs/changelog.d/2026-08-25-thing.md")]).ok, false,
  "MODIFYING an existing entry does NOT satisfy the guard");
eq(ledgerCheck([".claude/settings.json", { path: "docs/changelog.d/2026-08-25-thing.md", status: "D" }]).ok, false,
  "DELETING an entry does NOT satisfy the guard");
ok(/is not ADDED by this commit/.test(ledgerCheck([".claude/settings.json", modified("docs/changelog.d/2026-08-25-x.md")]).reason || ""),
  "the refusal says the entry was modified rather than claiming no ledger exists");
// A bare path carries no status, so it cannot prove an add — fails closed.
eq(ledgerCheck([".claude/settings.json", "docs/changelog.d/2026-08-25-thing.md"]).ok, false,
  "a path with NO status cannot satisfy the changelog.d rule (fails closed)");

// The dated filename is enforced, not merely documented (CodeRabbit, PR #482).
eq(ledgerCheck([".claude/settings.json", added("docs/changelog.d/notes.md")]).ok, false,
  "an undated notes.md does NOT satisfy the guard");
eq(ledgerCheck([".claude/settings.json", added("docs/changelog.d/README.md")]).ok, false,
  "changelog.d/README.md alone does NOT satisfy the guard");
eq(ledgerCheck(["AGENTS.md", added("docs/changelog.d/README.md")]).ok, false,
  "editing the folder README is not a recorded change");
eq(ledgerCheck([".claude/settings.json", added("docs/changelog.d/2026-8-5-short.md")]).ok, false,
  "a non-zero-padded date is not the documented format");
eq(ledgerCheck([".claude/settings.json", added("docs/changelog.d/sub/2026-08-25-nested.md")]).ok, false,
  "a nested path under changelog.d does not satisfy the guard");
eq(ledgerCheck([".claude/settings.json", added("docs/changelog.d/2026-08-25-notes.txt")]).ok, false,
  "a non-.md file in changelog.d does not satisfy the guard");

// Appending to the older shared ledgers is a MODIFY by nature and stays valid.
eq(ledgerCheck([".claude/settings.json", modified("docs/CHANGELOG.md")]).ok, true,
  "modifying docs/CHANGELOG.md still satisfies the guard");
eq(ledgerCheck([".claude/settings.json", "docs/manual/DECISION_LOG.md"]).ok, true,
  "a bare path still works for the non-entry ledger files");

// ── content must actually record something (Codex P2, PR #482) ──────────────
eq(ledgerCheck([".claude/settings.json", added("docs/changelog.d/2026-08-25-x.md", "")]).ok, false,
  "an EMPTY entry does not satisfy the guard");
eq(ledgerCheck([".claude/settings.json", added("docs/changelog.d/2026-08-25-x.md", "just prose" + NL)]).ok, false,
  "a prose-first entry does not satisfy the guard");
eq(ledgerCheck([".claude/settings.json", added("docs/changelog.d/2026-08-25-x.md", "## 2026-08-24 - wrong" + NL + NL + "body" + NL)]).ok, false,
  "an entry whose heading date disagrees with its filename does not satisfy the guard");
eq(ledgerCheck([".claude/settings.json", { path: "docs/changelog.d/2026-08-25-x.md", status: "A" }]).ok, false,
  "an entry whose content cannot be read fails closed");
ok(/is empty/.test(ledgerCheck([".claude/settings.json", added("docs/changelog.d/2026-08-25-x.md", "")]).reason || ""),
  "the refusal names the empty entry rather than claiming no ledger exists");

// ── a rename is not a new record (Codex P2, reproduced against the real hook) ─
// --no-renames reports a rename as D(old) + A(new); counting the added half would let a
// commit satisfy the guard by MOVING someone else's entry and writing none of its own.
{
  const shared = "## 2026-08-25 - someone else's record" + NL + NL + "their detail" + NL;
  const renameCommit = [
    ".claude/settings.json",
    deleted("docs/changelog.d/2026-08-25-old.md", shared),
    { path: "docs/changelog.d/2026-08-25-renamed.md", status: "A", content: shared },
  ];
  eq(ledgerCheck(renameCommit).ok, false, "a pure RENAME of an existing entry does not satisfy the guard");
  ok(/rename/i.test(ledgerCheck(renameCommit).reason || ""),
    "the refusal explains that renaming is not writing your own record");
  eq(ledgerCheck([
    ".claude/settings.json",
    deleted("docs/changelog.d/2026-08-25-old.md", shared),
    added("docs/changelog.d/2026-08-26-genuinely-new.md"),
  ]).ok, true, "a genuinely new entry still counts even when an old one is deleted alongside");
}

// ── a date is not a record, and a heading is not detail (Codex P2, PR #482) ──
eq(ledgerCheck([".claude/settings.json", added("docs/changelog.d/2026-08-25-x.md", "## 2026-08-25" + NL)]).ok, false,
  "a bare date heading with no description does not satisfy the guard");
ok(/only a date heading/.test(ledgerCheck([".claude/settings.json", added("docs/changelog.d/2026-08-25-x.md", "## 2026-08-25" + NL)]).reason || ""),
  "the refusal says a date is not a record of what changed");
eq(ledgerCheck([".claude/settings.json", added("docs/changelog.d/2026-08-25-x.md", "## 2026-08-25 - a title and nothing else" + NL)]).ok, false,
  "a heading with no detail beneath it does not satisfy the guard");
eq(ledgerCheck([".claude/settings.json", added("docs/changelog.d/2026-08-25-x.md", "## 2026-08-25 - real" + NL + NL + "detail" + NL)]).ok, true,
  "a heading WITH detail beneath it does satisfy the guard");

// ── malformed fragments are caught even with no agent-surface trigger ────────
// A src-only commit must not be able to drop an unreadable entry into the folder.
eq(ledgerCheck(["src/pages/Invoices.tsx", added("docs/changelog.d/2026-08-25-x.md", "")]).ok, false,
  "a src-only commit adding an EMPTY entry is refused");
eq(ledgerCheck(["src/pages/Invoices.tsx", added("docs/changelog.d/2026-08-25-x.md")]).ok, true,
  "a src-only commit adding a WELL-FORMED entry is fine");
eq(ledgerCheck(["src/pages/Invoices.tsx", "src/lib/money.ts"]).ok, true,
  "a src-only commit staging no entry at all is unaffected");
eq(ledgerCheck(["src/pages/Invoices.tsx", modified("docs/changelog.d/2026-08-25-x.md")]).ok, true,
  "merely touching an existing entry without claiming it is not blocked");

// ── rename STATUS beats content comparison (Codex P2, PR #482) ──────────────
// Renaming an entry and editing one character defeats a byte-identical test, so the
// guard asks git for rename status instead of inferring it from content.
eq(ledgerCheck([
  ".claude/settings.json",
  { path: "docs/changelog.d/2026-08-26-renamed.md", status: "A",
    content: "## 2026-08-26 - theirs" + NL + NL + "old detail!" + NL,
    renamedFrom: "docs/changelog.d/2026-08-25-old.md" },
]).ok, false, "a renamed-and-edited entry does NOT satisfy the guard");
ok(/is a rename of/.test(ledgerCheck([
  ".claude/settings.json",
  { path: "docs/changelog.d/2026-08-26-renamed.md", status: "A",
    content: "## 2026-08-26 - theirs" + NL + NL + "old detail!" + NL,
    renamedFrom: "docs/changelog.d/2026-08-25-old.md" },
]).reason || ""), "the refusal names the file it was renamed from");

// ── malformed PATHS are caught on trigger-free commits too ──────────────────
eq(ledgerCheck(["src/pages/Invoices.tsx", added("docs/changelog.d/notes.md")]).ok, false,
  "a src-only commit adding an undated notes.md is refused");
eq(ledgerCheck(["src/pages/Invoices.tsx", added("docs/changelog.d/2026-8-5-x.md")]).ok, false,
  "a src-only commit adding a non-padded date is refused");
eq(ledgerCheck(["src/pages/Invoices.tsx", added("docs/changelog.d/sub/nested.md")]).ok, false,
  "a src-only commit adding a nested fragment is refused");
ok(/read it as an entry/.test(ledgerCheck(["src/pages/Invoices.tsx", added("docs/changelog.d/notes.md")]).reason || ""),
  "the refusal explains the filename will never be read as an entry");
eq(ledgerCheck(["src/pages/Invoices.tsx", { path: "docs/changelog.d/README.md", status: "M", content: "x" }]).ok, true,
  "editing the folder README on a src-only commit is not an attempted entry");

// The entry file alone is not a trigger — it needs no ledger of its own.
eq(ledgerCheck([added("docs/changelog.d/2026-08-25-solo.md")]).ok, true,
  "an entry file on its own is not an agent-surface trigger");
// ── triggers WITH a ledger → ok (any one ledger file satisfies) ─────────────
eq(ledgerCheck([".claude/hooks/migration-apply-guard.mjs", "docs/CHANGELOG.md"]).ok, true, "CHANGELOG satisfies");
eq(ledgerCheck([".codex/hooks/production-action-guard.mjs", "docs/CHANGELOG.md"]).ok, true, "CHANGELOG satisfies a Codex guard change");
eq(ledgerCheck(["AGENTS.md", "docs/manual/DECISION_LOG.md"]).ok, true, "DECISION_LOG satisfies");
eq(ledgerCheck([".claude/settings.json", "docs/manual/KNOWN_ISSUES.md"]).ok, true, "KNOWN_ISSUES satisfies");
eq(ledgerCheck([".claude/commands/ship.md", "docs/manual/OWNER_PLAYBOOK.md"]).ok, true, "another docs/manual file satisfies");
eq(ledgerCheck([".husky/pre-commit", "docs/reference/agent-guardrails.md"]).ok, true, "agent-guardrails.md satisfies");
eq(ledgerCheck(["scripts/check-doc-drift.mjs", "docs/loops/tooling-loop-ledger.md"]).ok, true, "a loop ledger satisfies");
eq(ledgerCheck(["scripts/run-claude-review.mjs", "docs/CHANGELOG.md"]).ok, true, "CHANGELOG satisfies a Claude proof-wrapper change");
eq(ledgerCheck(["scripts/write-codex-push-proof.mjs", "docs/CHANGELOG.md"]).ok, true, "CHANGELOG satisfies a Codex proof-wrapper change");
eq(ledgerCheck(["supabase/migrations/20260716000000_add_foo.sql", "docs/CHANGELOG.md"]).ok, true, "CHANGELOG satisfies a migration commit");
eq(ledgerCheck(["supabase/migrations/20260716000000_add_foo.sql", "docs/reference/migration-history.md"]).ok, true, "migration-history.md satisfies a migration commit (its natural ledger companion)");

// ── path normalization ───────────────────────────────────────────────────────
eq(ledgerCheck([".claude\\hooks\\bash-safety.mjs"]).ok, false, "backslash paths are normalized (still a trigger)");
eq(ledgerCheck([".claude\\hooks\\bash-safety.mjs", "docs\\CHANGELOG.md"]).ok, true, "backslash ledger path is normalized too");

// ── non-ledger docs do NOT satisfy ───────────────────────────────────────────
eq(ledgerCheck([".claude/hooks/bash-safety.mjs", "docs/reference/gotchas.md"]).ok, false, "gotchas.md is not a ledger — still blocked");
eq(ledgerCheck([".claude/hooks/bash-safety.mjs", "README.md"]).ok, false, "README is not a ledger — still blocked");

// A rename must expose both the protected source and unprotected destination.
// Without --no-renames, --name-only reports only src/moved.mjs and the CLI exits 0.
const renameRepo = mkdtempSync(join(tmpdir(), "crx-ledger-rename-"));
// Git exports GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE/GIT_PREFIX to hook children, and a child of
// .husky/pre-commit inherits them. `cwd` does NOT override an absolute GIT_DIR, so without this
// scrub every git call below — and the guard spawned at the end — targets the REAL repository
// instead of the temp fixture. That failure mode is invisible to CI (which runs this test with no
// GIT_* set) while blocking every commit in the repo. Keep the scrub on both child processes.
// Upgraded from a hand-written GIT_ prefix filter to the repo's shared sanitizer. It
// derives the variable list from `git rev-parse --local-env-vars` — authoritative, where
// a prefix test is a guess — and also clears the indexed GIT_CONFIG_KEY_n/VALUE_n payload
// that a prefix filter catches only by luck. Every other git-spawning test in this repo
// already used it; this file opting out is what made it the one that corrupted the repo.
const fixtureEnv = scratchHookEnvironment(renameRepo);
try {
  const git = (...args) => execFileSync("git", args, { cwd: renameRepo, stdio: "ignore", env: fixtureEnv });
  git("init", "--quiet");
  git("config", "user.email", "ledger-test@example.invalid");
  git("config", "user.name", "Ledger Test");
  mkdirSync(join(renameRepo, ".claude", "hooks"), { recursive: true });
  writeFileSync(join(renameRepo, ".claude", "hooks", "protected.mjs"), "export default true;\n");
  git("add", ".claude/hooks/protected.mjs");
  git("commit", "--quiet", "-m", "fixture");
  mkdirSync(join(renameRepo, "src"), { recursive: true });
  git("mv", ".claude/hooks/protected.mjs", "src/moved.mjs");
  const run = spawnSync(process.execPath, [fileURLToPath(new URL("./check-ledger-update.mjs", import.meta.url))], {
    cwd: renameRepo,
    env: fixtureEnv,
    encoding: "utf8",
    env: fixtureEnv,
  });
  eq(run.status, 1, "protected file renamed to an unprotected path is still blocked");
  ok(`${run.stdout}${run.stderr}`.includes("LEDGER UPDATE REQUIRED"), "rename block explains the ledger requirement");
} finally {
  rmSync(renameRepo, { recursive: true, force: true });
}

console.log(`check-ledger-update: ${pass} assertions passed`);
