#!/usr/bin/env node
// Mutation tests for the shared migration-apply rule book.
//
// These are deliberately NOT "does it say yes when everything is fine" tests. A
// guard that has only ever been observed passing has not been tested — the thing
// that matters is that each check REFUSES when the condition it exists to detect
// is present. So every case below starts from a known-good fixture, breaks
// exactly one thing, and asserts the refusal.
//
// The one ALLOW assertion per rule-set is load-bearing too: without it a guard
// that refuses everything unconditionally would pass every deny case and still be
// broken (and would quietly make the second door useless).
//
// Run: node .claude/hooks/migration-apply-lib.test.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { evaluateMigrationApply, normalizeMigName, originFetchAgeMs } from "./migration-apply-lib.mjs";
import { checkWrappable } from "./migration-wrappability-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// .claude/hooks/ → repo root → scripts/
const __scriptsDir = path.resolve(__dirname, "..", "..", "scripts");

let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }
function denies(verdict, fragment, m) {
  assert.equal(verdict.decision, "block", `${m} — expected a refusal, got ${verdict.decision}`);
  assert.ok(
    String(verdict.reason || "").includes(fragment),
    `${m} — refusal did not mention ${JSON.stringify(fragment)}; got: ${String(verdict.reason).slice(0, 200)}`);
  pass++;
}
function allows(verdict, m) {
  assert.equal(verdict.decision, "allow", `${m} — expected allow, got block: ${String(verdict.reason).slice(0, 300)}`);
  pass++;
}

const SQL = "CREATE TABLE public.widgets (id bigint primary key);\nALTER TABLE public.widgets ENABLE ROW LEVEL SECURITY;\n";
const HASH = createHash("sha256").update(SQL).digest("hex");
const MIG = "20260816120000_add_widgets";
const SAFE = MIG.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);

const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
// `git worktree list` is stubbed to empty so proof lookup stays inside the
// fixture directory and never touches the real repo.
const noWorktrees = () => "";

const roots = [];
/** Build a fixture project dir. Pass overrides to break exactly one thing. */
function fixture({
  snapshot = { captured_at: iso(0), applied: [{ version: "20260101000000", name: "20260101000000_baseline" }] },
  proof = {
    migration: MIG,
    timestamp: iso(0),
    reviewers: ["rls-security-reviewer", "migration-drift-reviewer"],
    findings: "clean",
    queryHash: HASH,
  },
  codexProof = null,
  autopilot = null,
  // Floor for the pending-set scan. The real value from supabase/baselines/manifest.json;
  // pass null to test the missing-manifest refusal.
  baseline = { format_version: 3, migrations_high_water: "20260727174805" },
} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "crx-applylib-"));
  roots.push(root);
  const stateDir = path.join(root, ".claude", "session-state");
  mkdirSync(stateDir, { recursive: true });
  // A string snapshot is written VERBATIM so a case can supply genuinely
  // unparseable content; JSON.stringify would have turned "not json" into the
  // perfectly valid JSON document "\"not json\"" and tested the wrong branch.
  if (snapshot !== null) {
    writeFileSync(
      path.join(stateDir, "applied-migrations.json"),
      typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot),
      "utf8");
  }
  if (proof !== null) writeFileSync(path.join(stateDir, `migration-review-${SAFE}.json`), JSON.stringify(proof), "utf8");
  if (codexProof !== null) writeFileSync(path.join(stateDir, `codex-review-mig-${SAFE}.json`), JSON.stringify(codexProof), "utf8");
  if (autopilot !== null) writeFileSync(path.join(stateDir, "AUTOPILOT.on"), autopilot, "utf8");
  if (baseline !== null) {
    const baselineDir = path.join(root, "supabase", "baselines");
    mkdirSync(baselineDir, { recursive: true });
    writeFileSync(
      path.join(baselineDir, "manifest.json"),
      typeof baseline === "string" ? baseline : JSON.stringify(baseline),
      "utf8");
  }
  return root;
}

// The pending-set preflight (2026-08-26) reads origin/main. Stubbed to the
// candidate migration alone so the default fixture has nothing older waiting;
// cases that need a queue override it. Left unstubbed it would shell out to git
// inside a bare temp dir, fail, and fail closed — which is correct behaviour but
// tests nothing.
const onlyThisMigration = () => `supabase/migrations/${MIG}.sql\n`;

// GIT_* must not leak from this process into a fixture repo. An inherited GIT_DIR
// points `git init`/`git commit` at the REAL repository — the failure mode that
// once flipped the shared checkout to core.bare and blocked every commit. Every
// git call below, and every subprocess, gets a scrubbed env.
const GIT_ENV_KEYS = Object.keys(process.env).filter((k) => k.startsWith("GIT_"));
const cleanEnv = (extra = {}) => {
  const env = { ...process.env, ...extra };
  for (const key of GIT_ENV_KEYS) delete env[key];
  return env;
};

// The pending-set preflight (2026-08-26) reads origin/main, and the second door is
// a real subprocess with no injection point: those fixtures need an actual ref.
// Stubbing it out would leave the guard's own second door untested — which is how
// the oversized-migration path became a hole in the first place.
function makeOriginMain(root) {
  const git = (...args) => spawnSync("git", [
    "-c", "user.name=fixture",
    "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=",
    "-C", root, ...args,
  ], { encoding: "utf8", env: cleanEnv() });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  const ref = git("update-ref", "refs/remotes/origin/main", "HEAD");
  ok(ref.status === 0, `fixture origin/main is created (git said: ${ref.stderr})`);
  // The freshness gate reads FETCH_HEAD's mtime to answer "when did this checkout
  // last talk to origin?". `git init` never writes one, so without this the
  // fixture looks like a checkout that has never fetched — which the guard
  // correctly refuses. Writing it now stands in for a just-completed fetch.
  writeFileSync(path.join(root, ".git", "FETCH_HEAD"), "fixture\n", "utf8");
}

const evaluate = (root, over = {}) => evaluateMigrationApply({
  name: MIG,
  query: SQL,
  projectId: "rhyzpcqhnizqbxphqdkr",
  projectDir: root,
  cwd: root,
  gitWorktreeList: noWorktrees,
  gitTrackedMigrations: onlyThisMigration,
  originFetchAge: () => 0,
  ...over,
});

// ── BASELINE: the fixture must ALLOW, or every deny below proves nothing ─────
allows(evaluate(fixture()), "known-good interactive fixture is allowed");

// ── CHECK 1: ordering preflight ─────────────────────────────────────────────
// Each case asserts the SPECIFIC message for its condition, not just the guard
// banner. Mutation testing earned this: disabling the missing-snapshot check
// still produced a refusal (the read then threw and the catch failed closed), so
// a banner-only assertion stayed green while the check it named was gone.
denies(evaluate(fixture({ snapshot: null })), "no applied-migration snapshot at",
  "missing applied-migration snapshot");
denies(evaluate(fixture({ snapshot: { captured_at: iso(0), applied: [] } })), "contains no rows",
  "empty snapshot (indistinguishable from 'nothing ever applied')");
denies(evaluate(fixture({ snapshot: { captured_at: iso(-48 * 3600 * 1000), applied: [{ version: "20260101000000", name: "20260101000000_baseline" }] } })),
  "h old (captured", "snapshot older than 24h");
denies(evaluate(fixture({ snapshot: { applied: [{ version: "20260101000000", name: "20260101000000_baseline" }] } })),
  "no usable captured_at", "snapshot with no captured_at (freshness unknowable)");
denies(evaluate(fixture({ snapshot: { captured_at: iso(0), applied: [{ version: "x", name: "no_timestamp_here" }] } })),
  "not one carries a 14-digit migration timestamp", "snapshot carrying no 14-digit timestamp to compare against");
denies(evaluate(fixture({ snapshot: "not json at all" })), "could not read the applied-migration snapshot",
  "unreadable snapshot fails closed");
// The replay case this guard was built for: candidate OLDER than the high-water.
denies(
  evaluate(fixture({
    snapshot: { captured_at: iso(0), applied: [{ version: "20270101000000", name: "20270101000000_much_newer" }] },
  })),
  "MIGRATION ORDERING GUARD", "out-of-order replay behind the applied high-water");
// An untimestamped (caller-controlled) name must not buy a skip.
denies(
  evaluate(fixture({ proof: { migration: "add_widgets", timestamp: iso(0), reviewers: ["rls-security-reviewer", "migration-drift-reviewer"], findings: "clean", queryHash: HASH } }),
    { name: "add_widgets" }),
  "MIGRATION ORDERING GUARD", "untimestamped migration name is refused, not abstained");

// ── CHECK 1b: pending-set preflight (2026-08-26) ────────────────────────────
// The ordering cases above all ask "is something NEWER already applied?". This
// asks the question that was missing: "is something OLDER still WAITING?".
// Reproduces the incident shape end-to-end through the real gate — an older
// tracked-but-unapplied migration, a newer one being applied.
{
  const PENDING = "20260810120000_pending_security_fix";
  const withQueue = () =>
    `supabase/migrations/${PENDING}.sql\nsupabase/migrations/${MIG}.sql\n`;

  denies(evaluate(fixture(), { gitTrackedMigrations: withQueue }),
    "MIGRATION PENDING-SET GUARD",
    "applying over an older tracked-but-unapplied migration is refused");
  denies(evaluate(fixture(), { gitTrackedMigrations: withQueue }),
    PENDING, "the refusal names the migration it would strand");
  denies(evaluate(fixture(), { gitTrackedMigrations: withQueue }),
    "Apply the older migration(s) FIRST", "the refusal says what to do instead");

  // Once that migration IS applied, the newer one goes in clean. Without this the
  // check could be refusing unconditionally and every deny above would be hollow.
  allows(
    evaluate(
      fixture({ snapshot: { captured_at: iso(0), applied: [
        { version: "20260101000000", name: "20260101000000_baseline" },
        { version: "20260810120000", name: PENDING },
      ] } }),
      { gitTrackedMigrations: withQueue }),
    "with the pending migration applied, the newer one passes");

  // A renumbered ledger row keeps the ORIGINAL stamp in its name, so stamps can
  // never agree — the slug is what matches. Measured against the real ledger:
  // without this, 448 applied migrations read as pending and nothing could apply.
  allows(
    evaluate(
      fixture({ snapshot: { captured_at: iso(0), applied: [
        { version: "20260101000000", name: "20260101000000_baseline" },
        { version: "20260810120000", name: "20260808090000_pending_security_fix" },
      ] } }),
      { gitTrackedMigrations: withQueue }),
    "a renumbered-but-applied migration is not reported as pending");

  // The override is a DIFFERENT marker from intentional-replay, and the replay
  // marker must not unlock this guard — the two decisions are not the same.
  const replaySql = `${SQL}-- ordering-guard: intentional-replay deliberate replay of an older file\n`;
  denies(
    evaluate(
      fixture({ proof: { migration: MIG, timestamp: iso(0), reviewers: ["rls-security-reviewer", "migration-drift-reviewer"], findings: "clean", queryHash: createHash("sha256").update(replaySql).digest("hex") } }),
      { query: replaySql, gitTrackedMigrations: withQueue }),
    "MIGRATION PENDING-SET GUARD",
    "the intentional-replay marker does NOT unlock the pending-set guard");

  const aheadSql = `${SQL}-- ordering-guard: ahead-of-pending the security fix is parked pending Mason's OK\n`;
  allows(
    evaluate(
      fixture({ proof: { migration: MIG, timestamp: iso(0), reviewers: ["rls-security-reviewer", "migration-drift-reviewer"], findings: "clean", queryHash: createHash("sha256").update(aheadSql).digest("hex") } }),
      { query: aheadSql, gitTrackedMigrations: withQueue }),
    "a stated ahead-of-pending reason unlocks the guard");

  // Fail closed on every unknown.
  denies(
    evaluate(fixture(), { gitTrackedMigrations: () => { throw new Error("fatal: not a git repository"); } }),
    "could not list the migrations tracked on origin/main",
    "an unreadable origin/main refuses, it does not skip the check");
  denies(evaluate(fixture(), { gitTrackedMigrations: () => "" }),
    "reached no verdict", "an empty tracked set refuses, it does not pass");
  denies(evaluate(fixture({ baseline: null })),
    "schema-baseline manifest", "a missing baseline manifest refuses");
  denies(evaluate(fixture({ baseline: { format_version: 3 } })),
    "reached no verdict", "a manifest with no high-water refuses");
  denies(evaluate(fixture({ baseline: "{ not json" })),
    "schema-baseline manifest", "an unparseable baseline manifest refuses");

  // ── FRESHNESS OF origin/main (Codex P1, PR #502) ──────────────────────────
  // The ship flow applies at Step 5 and does not fetch until Step 6, so a
  // remote-tracking ref can be arbitrarily behind. A migration merged since the
  // last fetch is invisible, and applying over it strands it — the 2026-08-26
  // shape exactly. Judging the queue from a stale ref must refuse, not proceed.
  denies(evaluate(fixture(), { originFetchAge: () => 31 * 60 * 1000 }),
    "last fetched from origin",
    "a fetch older than the freshness window refuses");
  denies(evaluate(fixture(), { originFetchAge: () => 31 * 60 * 1000 }),
    "git fetch origin", "the stale-fetch refusal says exactly what to run");
  denies(evaluate(fixture(), { originFetchAge: () => null }),
    "cannot establish when this checkout last fetched",
    "an unknowable fetch time refuses — unknown is not a pass");
  // The boundary itself must still pass, or the gate is just 'always refuse'.
  allows(evaluate(fixture(), { originFetchAge: () => 29 * 60 * 1000 }),
    "a fetch inside the freshness window passes");

  // The refusal must name the directory the guard actually MEASURED (CodeRabbit,
  // PR #502). Freshness is read from queueRoot — the session's linked worktree
  // when one resolves — and `git fetch` inside a linked worktree writes THAT
  // worktree's own FETCH_HEAD, which originFetchAgeMs prefers over the common
  // dir. Naming the primary checkout instead sends the operator to fetch in a
  // directory whose FETCH_HEAD this guard never reads: they fetch, retry, and
  // get the identical refusal forever, with nothing in the message to explain
  // why. A guard whose remedy does not work is worse than one that stays quiet.
  // Every other case above has queueRoot === projectDir, which is exactly why
  // this went unnoticed — the two are only distinguishable in a linked worktree.
  {
    const primary = fixture();
    const linked = path.join(primary, "wt-session");
    mkdirSync(linked, { recursive: true });
    const listsLinked = () => `worktree ${primary}\nworktree ${linked}\n`;
    for (const [age, label] of [[31 * 60 * 1000, "stale"], [null, "unknowable"]]) {
      const verdict = evaluate(primary, {
        cwd: linked,
        gitWorktreeList: listsLinked,
        originFetchAge: () => age,
      });
      denies(verdict, linked,
        `the ${label}-fetch refusal names the worktree whose FETCH_HEAD it measured`);
      ok(!String(verdict.reason || "").includes(`in ${primary},`),
        `the ${label}-fetch refusal does not send the operator to the primary checkout`);
    }
  }

  // A FAILED worktree lookup must REFUSE, not fall back (Codex P1, PR #502).
  // resolveSessionWorktree() returns null both when the listing failed and when
  // it succeeded with no match, and only the second makes projectDir correct.
  // `git worktree list` used to be invoked twice — once for the proof dirs, once
  // for the queue root — so the FIRST call could succeed (accepting the reviewer
  // proof from the active worktree) while the SECOND transiently failed, silently
  // scanning the primary checkout for the queue. An older migration living only
  // in the session worktree was then invisible and the apply returned `allow`,
  // stranding it. Codex reproduced that sequence; the comment above the fallback
  // had claimed it "fails closed".
  {
    const root = fixture();
    const boom = () => { throw new Error("git worktree list timed out"); };
    denies(evaluate(root, { cwd: root, gitWorktreeList: boom }),
      "could not determine which checkout holds the migration queue",
      "a failed worktree listing refuses instead of scanning the primary checkout");

    // The listing is now memoised, so the two consumers cannot disagree: the
    // first-succeeds/second-fails sequence is unreachable because there is only
    // ever one call. Counting proves the race is closed structurally rather than
    // patched at one call site.
    let calls = 0;
    const countingList = () => { calls += 1; return ""; };
    evaluate(root, { cwd: root, gitWorktreeList: countingList });
    ok(calls === 1,
      `git worktree list is invoked exactly once per evaluation (was ${calls}) — the two consumers share one result`);
  }

  // ── THE ACTIVE CHECKOUT IS PART OF THE QUEUE (Codex P1, PR #502) ──────────
  // ship.md Step 5 applies a migration while it is still uncommitted and
  // unmerged. An origin/main-only listing cannot see an older SIBLING authored in
  // the same checkout, so the newer one applied clean and stranded it — the
  // defect this guard exists to prevent, in the guard's own normal workflow.
  {
    const root = fixture();
    mkdirSync(path.join(root, "supabase", "migrations"), { recursive: true });
    // Never committed, never merged, invisible to origin/main — and older.
    writeFileSync(
      path.join(root, "supabase", "migrations", "20260810120000_uncommitted_sibling.sql"),
      "select 1;\n", "utf8");
    denies(evaluate(root), "20260810120000_uncommitted_sibling",
      "an UNCOMMITTED older sibling in the working tree is part of the queue");
  }
}

// ── originFetchAgeMs resolves both checkout shapes ──────────────────────────
// A linked worktree's .git is a FILE pointing at .git/worktrees/<name>, and
// FETCH_HEAD lives in the COMMON dir two levels up. Getting this wrong returns
// null, which fails closed — safe, but it would refuse every apply from a
// worktree, and Mason runs dozens of them.
{
  const root = mkdtempSync(path.join(os.tmpdir(), "crx-fetchage-"));
  roots.push(root);

  // Plain checkout: .git is a directory.
  const plain = path.join(root, "plain");
  mkdirSync(path.join(plain, ".git"), { recursive: true });
  writeFileSync(path.join(plain, ".git", "FETCH_HEAD"), "x\n", "utf8");
  const plainAge = originFetchAgeMs(plain, Date.now());
  ok(typeof plainAge === "number" && plainAge >= 0, "a plain checkout resolves FETCH_HEAD");

  // Linked worktree: .git is a file, FETCH_HEAD is in the common dir.
  const common = path.join(root, "common", ".git");
  mkdirSync(path.join(common, "worktrees", "wt"), { recursive: true });
  writeFileSync(path.join(common, "FETCH_HEAD"), "x\n", "utf8");
  const linked = path.join(root, "linked");
  mkdirSync(linked, { recursive: true });
  writeFileSync(path.join(linked, ".git"), `gitdir: ${path.join(common, "worktrees", "wt")}\n`, "utf8");
  const linkedAge = originFetchAgeMs(linked, Date.now());
  ok(typeof linkedAge === "number" && linkedAge >= 0, "a linked worktree resolves the COMMON FETCH_HEAD");

  // Never fetched → null, which the caller turns into a refusal.
  const bare = path.join(root, "never-fetched");
  mkdirSync(path.join(bare, ".git"), { recursive: true });
  ok(originFetchAgeMs(bare, Date.now()) === null, "a checkout that never fetched returns null");
  ok(originFetchAgeMs(path.join(root, "not-a-checkout"), Date.now()) === null,
    "a non-checkout returns null rather than throwing");
}

// ── CHECK 2: autopilot flag state ───────────────────────────────────────────
denies(evaluate(fixture({ autopilot: JSON.stringify({ expires: iso(-60 * 60 * 1000) }) })),
  "LAPSED", "EXPIRED autopilot flag parks ALL applies");
denies(evaluate(fixture({ autopilot: "{ not valid json" })),
  "LAPSED", "malformed autopilot flag parks ALL applies");

// ── CHECK 3: destructive content (hands-free only) ──────────────────────────
const armed = () => JSON.stringify({ expires: iso(4 * 3600 * 1000) });
const goodCodex = { queryHash: HASH, verdict: "clean", model: "gpt-5.6-sol", reasoning_effort: "high", timestamp: iso(0) };
const DESTRUCTIVE = "DROP TABLE public.customers;\n";
const destructiveHash = createHash("sha256").update(DESTRUCTIVE).digest("hex");
denies(
  evaluate(
    fixture({
      autopilot: armed(),
      proof: { migration: MIG, timestamp: iso(0), reviewers: ["rls-security-reviewer", "migration-drift-reviewer"], findings: "clean", queryHash: destructiveHash },
      codexProof: { ...goodCodex, queryHash: destructiveHash },
    }),
    { query: DESTRUCTIVE }),
  "destructive statement", "armed run refuses a destructive migration even with a perfect proof");
const ESCAPED_DESTRUCTIVE = "COMMENT ON TABLE public.customers IS E'escaped\\' quote /*'; DELETE FROM public.customers;";
const escapedDestructiveHash = createHash("sha256").update(ESCAPED_DESTRUCTIVE).digest("hex");
denies(
  evaluate(
    fixture({
      autopilot: armed(),
      proof: { migration: MIG, timestamp: iso(0), reviewers: ["rls-security-reviewer", "migration-drift-reviewer"], findings: "clean", queryHash: escapedDestructiveHash },
      codexProof: { ...goodCodex, queryHash: escapedDestructiveHash },
    }),
    { query: ESCAPED_DESTRUCTIVE }),
  "destructive statement", "armed run refuses DELETE after an escaped E-string even with perfect proof");
const ESCAPED_DOLLAR_QUOTE_DESTRUCTIVE = "COMMENT ON TABLE public.customers IS E'foo\\' AS $x$ junk'; DELETE FROM public.customers; -- $x$\nSELECT 1;";
const escapedDollarQuoteDestructiveHash = createHash("sha256").update(ESCAPED_DOLLAR_QUOTE_DESTRUCTIVE).digest("hex");
denies(
  evaluate(
    fixture({
      autopilot: armed(),
      proof: { migration: MIG, timestamp: iso(0), reviewers: ["rls-security-reviewer", "migration-drift-reviewer"], findings: "clean", queryHash: escapedDollarQuoteDestructiveHash },
      codexProof: { ...goodCodex, queryHash: escapedDollarQuoteDestructiveHash },
    }),
    { query: ESCAPED_DOLLAR_QUOTE_DESTRUCTIVE }),
  "destructive statement", "armed run refuses DELETE after a dollar-quote marker inside an escaped E-string");

// ── CHECK 4: reviewer proof ─────────────────────────────────────────────────
denies(evaluate(fixture({ proof: null })), "without subagent review proof",
  "no reviewer proof at all");
denies(evaluate(fixture({ proof: { migration: MIG, timestamp: iso(-31 * 60 * 1000), reviewers: ["rls-security-reviewer", "migration-drift-reviewer"], findings: "clean", queryHash: HASH } })),
  "without subagent review proof", "reviewer proof older than 30 minutes");
denies(evaluate(fixture({ proof: { migration: MIG, timestamp: iso(60 * 60 * 1000), reviewers: ["rls-security-reviewer", "migration-drift-reviewer"], findings: "clean", queryHash: HASH } })),
  "without subagent review proof", "FUTURE-dated reviewer proof is not 'fresh forever'");
denies(evaluate(fixture({ proof: { migration: MIG, timestamp: iso(0), reviewers: ["rls-security-reviewer", "migration-drift-reviewer"], findings: "blockers", queryHash: HASH } })),
  "without subagent review proof", "reviewer proof whose findings are not clean/blockers-fixed");
// The edited-after-review case: proof is fresh and clean but bound to other SQL.
denies(evaluate(fixture({ proof: { migration: MIG, timestamp: iso(0), reviewers: ["rls-security-reviewer", "migration-drift-reviewer"], findings: "clean", queryHash: "0".repeat(64) } })),
  "without subagent review proof", "reviewer proof bound to DIFFERENT SQL (edited after review)");

// ── CHECK 5: hands-free extras (content binding, reviewers, Codex gate) ─────
allows(evaluate(fixture({ autopilot: armed(), codexProof: goodCodex })),
  "known-good ARMED fixture is allowed");

denies(
  evaluate(fixture({
    autopilot: armed(),
    proof: { migration: MIG, timestamp: iso(0), reviewers: ["rls-security-reviewer", "migration-drift-reviewer"], findings: "clean" },
    codexProof: goodCodex,
  })),
  "not content-bound", "armed run refuses a reviewer proof with no queryHash");

denies(
  evaluate(fixture({
    autopilot: armed(),
    proof: { migration: MIG, timestamp: iso(0), reviewers: ["rls-security-reviewer", "migration-drift-reviewer"], findings: "clean", queryHash: "0".repeat(64) },
    codexProof: goodCodex,
  })),
  "not content-bound", "armed run identifies a reviewer proof bound to different SQL");

denies(
  evaluate(fixture({
    autopilot: armed(),
    proof: { migration: MIG, timestamp: iso(0), reviewers: ["rls-security-reviewer"], findings: "clean", queryHash: HASH },
    codexProof: goodCodex,
  })),
  "does not record the required reviewers", "armed run refuses when only one reviewer is named");

denies(evaluate(fixture({ autopilot: armed(), codexProof: null })),
  "Sol high-effort gate", "armed run refuses with no Codex proof file");
denies(evaluate(fixture({ autopilot: armed(), codexProof: { ...goodCodex, verdict: "blockers" } })),
  "Sol high-effort gate", "armed run refuses a non-clean Codex verdict");
denies(evaluate(fixture({ autopilot: armed(), codexProof: { ...goodCodex, queryHash: "0".repeat(64) } })),
  "Sol high-effort gate", "armed run refuses a Codex proof bound to different SQL");
denies(evaluate(fixture({ autopilot: armed(), codexProof: { ...goodCodex, model: "gpt-5.6-terra" } })),
  "Sol high-effort gate", "armed run refuses the wrong Codex model");
denies(evaluate(fixture({ autopilot: armed(), codexProof: { ...goodCodex, reasoning_effort: "medium" } })),
  "Sol high-effort gate", "armed run refuses the wrong reasoning effort");
denies(evaluate(fixture({ autopilot: armed(), codexProof: { ...goodCodex, timestamp: iso(-31 * 60 * 1000) } })),
  "Sol high-effort gate", "armed run refuses a stale Codex proof");
denies(evaluate(fixture({ autopilot: armed(), codexProof: { ...goodCodex, timestamp: iso(60 * 60 * 1000) } })),
  "Sol high-effort gate", "armed run refuses a FUTURE-dated Codex proof");

// ── The second door must not be a weaker door ───────────────────────────────
// Same inputs the PreToolUse hook would pass vs. what apply-migration-file.mjs
// passes: identical verdicts, because it is the same function. Guards against a
// future refactor quietly special-casing one caller.
{
  const root = fixture();
  const viaHookShape = evaluate(root);
  const viaScriptShape = evaluateMigrationApply({
    name: MIG, query: SQL, projectId: "rhyzpcqhnizqbxphqdkr",
    projectDir: root, cwd: root, gitWorktreeList: noWorktrees,
    gitTrackedMigrations: onlyThisMigration,
    originFetchAge: () => 0,
  });
  ok(viaHookShape.decision === viaScriptShape.decision, "both doors reach the identical verdict");
}

// ── THE SECOND DOOR ITSELF: scripts/apply-migration-file.mjs ────────────────
// The lib cases above prove the RULES. These prove the file-bytes caller obeys
// them: that it refuses when the gate refuses, and — the branch that actually
// matters — that on a PASSING gate it stops at the edge without transmitting
// unless --confirm was given. A dry run that silently applied would be the worst
// possible bug in this script, so it gets an explicit assertion.
{
  const scriptPath = path.resolve(__scriptsDir, "apply-migration-file.mjs");

  const runScript = (root, args = []) => {
    const migFile = path.join(root, "supabase", "migrations", `${MIG}.sql`);
    return spawnSync(process.execPath, [scriptPath, migFile, ...args], {
      encoding: "utf8",
      env: cleanEnv({ CLAUDE_PROJECT_DIR: root, SUPABASE_ACCESS_TOKEN: "" }),
    });
  };

  // Gate passes → dry run stops before the network, exit 0.
  const okRoot = fixture();
  mkdirSync(path.join(okRoot, "supabase", "migrations"), { recursive: true });
  writeFileSync(path.join(okRoot, "supabase", "migrations", `${MIG}.sql`), SQL, "utf8");
  makeOriginMain(okRoot);
  const dry = runScript(okRoot);
  ok(dry.status === 0, `dry run on a passing gate exits 0 (got ${dry.status}: ${dry.stderr})`);
  ok(dry.stdout.includes("APPLY GATE PASSED"), "dry run reports the gate passed");
  ok(dry.stdout.includes("DRY RUN"), "dry run says it is a dry run");
  ok(!dry.stdout.includes("Transmitting"), "dry run does NOT transmit without --confirm");
  ok(!dry.stdout.includes("APPLY OK"), "dry run does not report an apply");

  // Gate refuses → the script refuses too, non-zero, and never reaches the network.
  const badRoot = fixture({ proof: null });
  mkdirSync(path.join(badRoot, "supabase", "migrations"), { recursive: true });
  writeFileSync(path.join(badRoot, "supabase", "migrations", `${MIG}.sql`), SQL, "utf8");
  makeOriginMain(badRoot);
  const refused = runScript(badRoot);
  ok(refused.status === 2, `refused apply exits 2 (got ${refused.status})`);
  ok(refused.stderr.includes("APPLY GATE REFUSED"), "refusal is reported as a gate refusal");
  ok(!refused.stdout.includes("Transmitting"), "a refused apply never transmits");

  // Even WITH --confirm, a refused gate must not transmit.
  const refusedConfirm = runScript(badRoot, ["--confirm"]);
  ok(refusedConfirm.status === 2, "--confirm does not override a gate refusal");
  ok(!refusedConfirm.stdout.includes("Transmitting"), "--confirm on a refused gate never transmits");

  // --project is refused outright. The snapshot, the proofs and the autopilot flag
  // are all checkout-wide and assume ONE project; pointing this script at another
  // ref would overwrite the snapshot production ordering is judged against with a
  // foreign ledger, and CRX-local proofs would authorize a target they never
  // reviewed. (Codex P1, PR #460 round 4.)
  const otherProject = runScript(okRoot, ["--project", "someotherprojectref"]);
  ok(otherProject.status === 1, `--project is refused (got ${otherProject.status})`);
  ok(otherProject.stderr.includes("--project is not supported"), "the refusal names the flag");
  ok(!otherProject.stdout.includes("Transmitting"), "--project never reaches transmission");
  const otherProjectConfirm = runScript(okRoot, ["--project", "someotherprojectref", "--confirm"]);
  ok(otherProjectConfirm.status === 1, "--project is refused even with --confirm");

  // --name is refused for the same reason: it was caller-controlled input that TWO
  // checks trusted. An alias like `99999999999999_alias_<oldstamp>_old_migration`
  // still matches the reviewer proof by substring, while the ordering gate reads the
  // FIRST 14-digit stamp and rules the stale SQL newer than everything applied —
  // the out-of-order replay the gate exists to stop. (Codex P1, PR #460 round 5.)
  const aliased = runScript(okRoot, ["--name", `99999999999999_alias_${MIG}`]);
  ok(aliased.status === 1, `--name is refused (got ${aliased.status})`);
  ok(aliased.stderr.includes("--name is not supported"), "the refusal names the flag");
  ok(!aliased.stdout.includes("Transmitting"), "--name never reaches transmission");
  const aliasedConfirm = runScript(okRoot, ["--name", `99999999999999_alias_${MIG}`, "--confirm"]);
  ok(aliasedConfirm.status === 1, "--name is refused even with --confirm");
  // `argv.includes` matched only a standalone token, so the `=` spelling slipped
  // through; and the check ran after file resolution, so a missing file reported a
  // path error instead of the refusal. (CodeRabbit, PR #470.)
  const aliasedEquals = runScript(okRoot, [`--name=99999999999999_alias_${MIG}`]);
  ok(aliasedEquals.status === 1, "--name=alias is refused too");
  ok(aliasedEquals.stderr.includes("--name is not supported"), "the = spelling gets the same refusal");
  const projectEquals = runScript(okRoot, ["--project=someotherref"]);
  ok(projectEquals.status === 1, "--project=ref is refused too");
  const nameNoFile = spawnSync(process.execPath, [
    path.resolve(__scriptsDir, "apply-migration-file.mjs"), "--name", "whatever",
  ], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: okRoot, SUPABASE_ACCESS_TOKEN: "" } });
  ok(nameNoFile.stderr.includes("--name is not supported"),
    "the flag refusal fires BEFORE file resolution, not a path error");

  // REMOVING THE FLAG WAS HALF A FIX. The filename is caller-controlled too: copy an
  // old reviewed migration to `99999999999999_alias_<old-name>.sql` and the proof
  // still matches by substring, the queryHash still matches, and ordering reads the
  // alias's FIRST stamp as newest. Codex reproduced the full replay (P1, PR #470).
  // A canonical name — exactly one 14-digit stamp, at the start — kills it by
  // construction, because an alias needs a second stamp to carry the original name.
  {
    const aliasRoot = fixture();
    mkdirSync(path.join(aliasRoot, "supabase", "migrations"), { recursive: true });
    const aliasName = `99999999999999_alias_${MIG}`;
    writeFileSync(path.join(aliasRoot, "supabase", "migrations", `${aliasName}.sql`), SQL, "utf8");
    const res = spawnSync(process.execPath, [
      path.resolve(__scriptsDir, "apply-migration-file.mjs"),
      path.join(aliasRoot, "supabase", "migrations", `${aliasName}.sql`),
      "--confirm",
    ], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: aliasRoot, SUPABASE_ACCESS_TOKEN: "" } });
    ok(res.status === 1, `an aliased FILENAME is refused (got ${res.status})`);
    ok(res.stderr.includes("not a canonical migration name"), "the refusal names the canonical-name rule");
    ok(!res.stdout.includes("Transmitting"), "an aliased filename never transmits");
    ok(existsSync(path.join(aliasRoot, ".claude", "session-state", "applied-migrations.json")),
      "a refused aliased filename leaves the snapshot intact");
  }
  // A real repository migration name still passes unchanged.
  ok(dry.status === 0, "the canonical-name rule does not reject a real migration filename");

  // ROUND 7: the stamp-count rule closed a SHAPE, not the mechanism. A legacy
  // 8-digit name (`20260210_fix_rls_critical_issues`) aliased to
  // `99999999999999_alias_20260210_fix_rls_critical_issues` has exactly ONE 14-digit
  // stamp, so it passed — while substring proof-matching still handed it the old
  // migration's proof. Codex reproduced APPLY GATE PASSED. Exact proof-name equality
  // is the actual fix.
  {
    const legacy = "20260210_fix_rls_critical_issues";
    const alias = `99999999999999_alias_${legacy}`;
    const legacySql = "ALTER TABLE public.t ENABLE ROW LEVEL SECURITY;\n";
    const legacyHash = createHash("sha256").update(legacySql).digest("hex");
    const root = mkdtempSync(path.join(os.tmpdir(), "crx-alias8-"));
    roots.push(root);
    const stateDir = path.join(root, ".claude", "session-state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "applied-migrations.json"),
      JSON.stringify({ captured_at: iso(0), applied: [{ version: "20270101000000", name: "20270101000000_much_newer" }] }), "utf8");
    mkdirSync(path.join(root, "supabase", "baselines"), { recursive: true });
    writeFileSync(path.join(root, "supabase", "baselines", "manifest.json"),
      JSON.stringify({ format_version: 3, migrations_high_water: "20260727174805" }), "utf8");
    // Nothing older is waiting here; this block is about proof-name matching.
    const aliasTracked = () => `supabase/migrations/${alias}.sql\n`;
    // A genuine, fresh, clean proof for the LEGACY migration — nothing forged.
    writeFileSync(path.join(stateDir, `migration-review-${legacy}.json`),
      JSON.stringify({ migration: legacy, timestamp: iso(0), reviewers: ["rls-security-reviewer", "migration-drift-reviewer"], findings: "clean", queryHash: legacyHash }), "utf8");

    // FIXED (PR: exact proof-name on the MCP path). requireExactProofName now
    // DEFAULTS to true, so the hook — which passes no such flag — refuses the alias.
    // This assertion used to read "substring matching DOES let the alias inherit the
    // proof (the bug)" and was a characterization test for a known-open hole.
    const byDefault = evaluateMigrationApply({
      name: alias, query: legacySql, projectId: "rhyzpcqhnizqbxphqdkr",
      projectDir: root, cwd: root, gitWorktreeList: noWorktrees,
      gitTrackedMigrations: aliasTracked,
      originFetchAge: () => 0,
    });
    denies(byDefault, "without subagent review proof", "the DEFAULT now refuses the aliased legacy name (was the bug)");

    // The lenient mode still behaves the old way when a caller explicitly opts in.
    // Kept deliberately: it documents WHY the default was flipped, and it fails loudly
    // if anyone ever reintroduces substring matching as the default.
    const lenient = evaluateMigrationApply({
      name: alias, query: legacySql, projectId: "rhyzpcqhnizqbxphqdkr",
      projectDir: root, cwd: root, gitWorktreeList: noWorktrees,
      gitTrackedMigrations: aliasTracked,
      originFetchAge: () => 0,
      requireExactProofName: false,
    });
    ok(lenient.decision === "allow", "opt-in substring matching is still the vulnerable behaviour (no longer the default)");

    // Exact matching refuses it.
    const strict = evaluateMigrationApply({
      name: alias, query: legacySql, projectId: "rhyzpcqhnizqbxphqdkr",
      projectDir: root, cwd: root, gitWorktreeList: noWorktrees,
      gitTrackedMigrations: aliasTracked,
      originFetchAge: () => 0,
      requireExactProofName: true,
    });
    denies(strict, "without subagent review proof", "exact proof-name matching refuses the aliased legacy name");

    // Worth stating plainly, because it sharpens the bug: the legacy name cannot be
    // applied HONESTLY either — the ordering guard refuses any candidate without a
    // 14-digit stamp. So the only thing its proof was ever good for was being
    // inherited by an alias that DID carry one. Exact matching removes that.
    const honest = evaluateMigrationApply({
      name: legacy, query: legacySql, projectId: "rhyzpcqhnizqbxphqdkr",
      projectDir: root, cwd: root, gitWorktreeList: noWorktrees,
      gitTrackedMigrations: aliasTracked,
      originFetchAge: () => 0,
      requireExactProofName: true,
    });
    denies(honest, "MIGRATION ORDERING GUARD",
      "the legacy 8-digit name is refused by ordering regardless — its proof was only ever useful to an alias");

    // Exact matching must not break the ordinary case: a canonical name whose proof
    // names it exactly still passes.
    allows(evaluate(fixture(), { requireExactProofName: true }),
      "exact proof-name matching still allows a normal, correctly-named migration");
  }
  // The derived name still works — the removal must not break the normal path.
  ok(dry.stdout.includes(`migration : ${MIG}`), "the ledger name is derived from the filename");
}

// ── WRAPPABILITY: the precondition the atomicity promise depends on ─────────
// CodeRabbit (Major) and Codex (P2) both caught that the first revision only
// DOCUMENTED "no transaction control, nothing non-transactional" and never
// enforced it. These pin the enforcement, including the false positives that
// would make it useless: a PL/pgSQL body legitimately contains BEGIN/END, and a
// comment or string literal naming COMMIT is not transaction control.
{
  const wrappable = (sql, m) => { ok(checkWrappable(sql).wrappable === true, `${m} — expected wrappable, got: ${checkWrappable(sql).reason}`); };
  const notWrappable = (sql, fragment, m) => {
    const v = checkWrappable(sql);
    assert.equal(v.wrappable, false, `${m} — expected NOT wrappable`);
    assert.ok(String(v.reason).includes(fragment), `${m} — reason did not mention ${JSON.stringify(fragment)}; got: ${v.reason}`);
    pass++;
  };

  wrappable("CREATE TABLE public.t (id bigint);\nALTER TABLE public.t ENABLE ROW LEVEL SECURITY;\n",
    "an ordinary additive migration is wrappable");

  notWrappable("CREATE TABLE public.t (id bigint);\nCOMMIT;\n", "COMMIT", "a top-level COMMIT is refused");
  notWrappable("BEGIN;\nCREATE TABLE public.t (id bigint);\n", "BEGIN", "a top-level BEGIN is refused");
  notWrappable("START TRANSACTION;\nCREATE TABLE public.t (id bigint);\n", "START TRANSACTION", "START TRANSACTION is refused");
  notWrappable("CREATE TABLE public.t (id bigint);\nROLLBACK;\n", "ROLLBACK", "a top-level ROLLBACK is refused");
  notWrappable("SAVEPOINT s1;\nCREATE TABLE public.t (id bigint);\n", "SAVEPOINT", "a SAVEPOINT is refused");
  notWrappable("CREATE INDEX CONCURRENTLY idx_t ON public.t (id);\n", "CONCURRENTLY",
    "CREATE INDEX CONCURRENTLY is refused — Postgres cannot run it in a transaction block");
  notWrappable("DROP INDEX CONCURRENTLY idx_t;\n", "CONCURRENTLY", "DROP INDEX CONCURRENTLY is refused");
  notWrappable("VACUUM ANALYZE public.t;\n", "VACUUM", "VACUUM is refused");
  notWrappable("ALTER SYSTEM SET work_mem = '64MB';\n", "ALTER SYSTEM", "ALTER SYSTEM is refused");
  notWrappable("CLUSTER public.t USING idx_t;\n", "CLUSTER", "CLUSTER is refused");
  // ALTER TYPE … ADD VALUE has been transaction-safe since PostgreSQL 12 (live
  // server verified: 17.6). The blanket rejection was wrong and its advice was
  // impossible — the "split it out" file hit the same rule. (Codex P2, round 3.)
  wrappable("ALTER TYPE public.order_status ADD VALUE 'archived';\n",
    "an isolated enum addition is wrappable on PostgreSQL 12+");
  // DROP OWNED is destructive but perfectly transactional; destruction is the
  // destructive-content gate's job, not a transaction-block restriction.
  wrappable("DROP OWNED BY some_role;\n", "DROP OWNED is transactional, so wrappability does not reject it");
  notWrappable("   \n", "empty", "an empty migration is refused");
  // Each TXN_CONTROL rule gets a standalone case so it is exercised on its own
  // rather than only via a rule that happens to match first (CodeRabbit round 2).
  notWrappable("CREATE TABLE public.t (id bigint);\nEND;\n", "END", "a top-level END is refused");
  notWrappable("PREPARE TRANSACTION 'tx1';\n", "PREPARE TRANSACTION", "PREPARE TRANSACTION is refused");
  notWrappable("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;\nCREATE TABLE public.t (id bigint);\n",
    "SET TRANSACTION", "SET TRANSACTION is refused");
  notWrappable("COMMIT TRANSACTION;\n", "COMMIT", "COMMIT TRANSACTION is refused");
  notWrappable("COMMIT AND CHAIN;\n", "COMMIT", "COMMIT AND CHAIN is refused");
  notWrappable("COMMIT WORK AND NO CHAIN;\n", "COMMIT", "COMMIT WORK AND NO CHAIN is refused");
  notWrappable("ROLLBACK AND CHAIN;\n", "ROLLBACK", "ROLLBACK AND CHAIN is refused");
  notWrappable("ABORT TRANSACTION AND NO CHAIN;\n", "ROLLBACK", "ABORT transaction syntax is refused");
  notWrappable("END AND CHAIN;\n", "END", "END AND CHAIN is refused");
  notWrappable("END WORK AND NO CHAIN;\n", "END", "END WORK AND NO CHAIN is refused");
  notWrappable("ROLLBACK TO SAVEPOINT s1;\n", "ROLLBACK", "ROLLBACK TO SAVEPOINT is refused");
  notWrappable("BEGIN TRANSACTION;\nCREATE TABLE public.t (id bigint);\n", "BEGIN", "BEGIN TRANSACTION is refused");
  notWrappable("RELEASE SAVEPOINT s1;\n", "SAVEPOINT", "RELEASE SAVEPOINT is refused");
  // A migration with no statements is a no-op that would still write a ledger row.
  notWrappable("-- just a comment, no statements\n", "no SQL statements", "a comment-only migration is refused");
  notWrappable(";;;\n", "no SQL statements", "a semicolon-only migration is refused");
  notWrappable("/* block comment only */\n", "no SQL statements", "a block-comment-only migration is refused");

  // The false positives that would make this check unusable.
  wrappable(
    "CREATE OR REPLACE FUNCTION public.f() RETURNS void AS $$\nBEGIN\n  INSERT INTO public.t VALUES (1);\nEND\n$$ LANGUAGE plpgsql;\n",
    "a PL/pgSQL body's BEGIN/END is not transaction control");
  wrappable(
    "DO $do$\nBEGIN\n  PERFORM 1;\nEND\n$do$;\n",
    "a DO block's BEGIN/END is not transaction control");
  // REGRESSION (found by running the real 162KB migration, not by a unit test):
  // the first implementation reused live-testdata-lib's stripDollarQuoted, which
  // strips DO bodies but deliberately KEEPS CREATE FUNCTION bodies visible. A
  // body ending `END;` therefore read as top-level transaction control and the
  // real migration was refused. These pin the terminated-`END;` forms — the
  // earlier "$$ BEGIN … END $$" case passed only because no `;` followed END.
  wrappable(
    "CREATE OR REPLACE FUNCTION public.f() RETURNS void AS $function$\nBEGIN\n  PERFORM 1;\nEND;\n$function$ LANGUAGE plpgsql;\n",
    "a function body ending END; is not transaction control");
  wrappable(
    "CREATE OR REPLACE FUNCTION public.f() RETURNS void AS $function$\nBEGIN\n  BEGIN\n    PERFORM 1;\n  EXCEPTION WHEN others THEN\n    RAISE;\n  END;\nEND;\n$function$ LANGUAGE plpgsql;\n",
    "nested PL/pgSQL BEGIN/EXCEPTION/END; blocks are not transaction control");
  wrappable(
    "DO $preflight$\nBEGIN\n  IF true THEN\n    RAISE NOTICE 'ok';\n  END IF;\nEND;\n$preflight$;\nDO $postflight$\nBEGIN\n  PERFORM 1;\nEND;\n$postflight$;\n",
    "custom-tagged DO blocks with END; are not transaction control");
  wrappable(
    "CREATE FUNCTION public.g() RETURNS void AS $qty_check$\nBEGIN\n  -- COMMIT; ROLLBACK; inside a body comment\n  PERFORM 1;\nEND;\n$qty_check$ LANGUAGE plpgsql;\n",
    "transaction keywords inside a function body are not top-level");
  // Unterminated bodies cannot be classified, so they must refuse.
  notWrappable("CREATE FUNCTION public.f() RETURNS void AS $function$\nBEGIN\n  PERFORM 1;\n", "UNKNOWN",
    "an unterminated dollar-quoted body is refused, not assumed safe");
  notWrappable("SELECT 'unterminated;\n", "UNKNOWN", "an unterminated string literal is refused");
  wrappable(
    "-- this migration does not COMMIT on its own; the caller wraps it\nCREATE TABLE public.t (id bigint);\n",
    "a comment naming COMMIT is not transaction control");
  wrappable(
    "INSERT INTO public.audit (note) VALUES ('COMMIT was requested');\n",
    "a string literal naming COMMIT is not transaction control");
  wrappable(
    "INSERT INTO public.audit (note) VALUES (E'escaped\\' quote; COMMIT is text');\nSELECT 1;\n",
    "an escape-string literal cannot desynchronize transaction-control scanning");
  notWrappable(
    "INSERT INTO public.audit (note) VALUES (E'escaped\\' quote');\nCOMMIT AND CHAIN;\n",
    "COMMIT",
    "a real COMMIT after an escape-string literal is still refused");
  wrappable(
    "CREATE TABLE public.commit_log (id bigint, rollback_reason text);\n",
    "identifiers containing commit/rollback are not transaction control");

  // And the script must refuse a non-wrappable file end-to-end, before the gate.
  const wRoot = fixture();
  mkdirSync(path.join(wRoot, "supabase", "migrations"), { recursive: true });
  writeFileSync(path.join(wRoot, "supabase", "migrations", `${MIG}.sql`), "CREATE TABLE public.t (id bigint);\nCOMMIT;\n", "utf8");
  const res = spawnSync(process.execPath, [
    path.resolve(__scriptsDir, "apply-migration-file.mjs"),
    path.join(wRoot, "supabase", "migrations", `${MIG}.sql`),
    "--confirm",
  ], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: wRoot, SUPABASE_ACCESS_TOKEN: "" } });
  ok(res.status === 2, `a transaction-managing migration is refused by the script (got ${res.status})`);
  ok(res.stderr.includes("NOT WRAPPABLE"), "the script names the wrappability precondition in its refusal");
  ok(!res.stdout.includes("Transmitting"), "a non-wrappable migration is never transmitted");

  // The snapshot must survive a REFUSAL — invalidation belongs to an apply that
  // actually transmits, not to every invocation.
  ok(existsSync(path.join(wRoot, ".claude", "session-state", "applied-migrations.json")),
    "a refused run leaves the applied-migration snapshot intact");
}

// ── STALE SNAPSHOT CANNOT SURVIVE AN APPLY ──────────────────────────────────
// Codex exercised the hole (apply 200, ledger re-read 503): the script exited 0
// and the OLD snapshot survived, still "fresh" by the clock but missing the row
// just written — so the next apply could pass the ordering gate for a migration
// older than the one just applied. The snapshot is now deleted BEFORE the fetch,
// so no apply outcome, network failure, or crash can leave a stale one.
{
  const root = fixture();
  mkdirSync(path.join(root, "supabase", "migrations"), { recursive: true });
  writeFileSync(path.join(root, "supabase", "migrations", `${MIG}.sql`), SQL, "utf8");
  makeOriginMain(root);
  const snapshot = path.join(root, ".claude", "session-state", "applied-migrations.json");
  ok(existsSync(snapshot), "fixture starts with a snapshot present");

  // --confirm with an unreachable endpoint: the gate passes, wrappability passes,
  // the snapshot is invalidated, and transmission then fails. The snapshot must
  // NOT come back.
  const res = spawnSync(process.execPath, [
    path.resolve(__scriptsDir, "apply-migration-file.mjs"),
    path.join(root, "supabase", "migrations", `${MIG}.sql`),
    "--confirm",
  ], {
    encoding: "utf8",
    env: cleanEnv({
      CLAUDE_PROJECT_DIR: root,
      SUPABASE_ACCESS_TOKEN: "not-a-real-token-transmission-must-fail",
      // Force the request through a dead local proxy so this test NEVER touches
      // the real management API. Node's fetch ignores proxy env vars unless
      // NODE_USE_ENV_PROXY is set (Node 24), so without this the run would have
      // gone out to api.supabase.com with a junk token — offline-by-accident is
      // not offline.
      NODE_USE_ENV_PROXY: "1",
      https_proxy: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
      NO_PROXY: "",
      no_proxy: "",
    }),
  });
  ok(res.stdout.includes("Invalidated the applied-migration snapshot"),
    "the snapshot is invalidated before transmission");
  ok(!existsSync(snapshot),
    "after an apply attempt the stale snapshot is GONE — the next apply blocks on missing evidence");
  ok(res.status !== 0, `a failed transmission exits non-zero (got ${res.status})`);
}

// ── name normalization: tolerate .sql and paths, never tolerate an alias ─────
// Substring matching used to absorb the ".sql vs no .sql" difference between what
// write-apply-proofs.mjs records and what an apply_migration call carries. Naive
// exact equality would have broken those legitimate applies, which is why the fix
// normalizes both sides instead of comparing raw strings.
ok(normalizeMigName("20260820120000_foo") === "20260820120000_foo", "bare name is unchanged");
ok(normalizeMigName("20260820120000_foo.sql") === "20260820120000_foo", "a .sql suffix is stripped");
ok(normalizeMigName("20260820120000_foo.SQL") === "20260820120000_foo", "the suffix strip is case-insensitive");
ok(normalizeMigName("supabase/migrations/20260820120000_foo.sql") === "20260820120000_foo", "a posix path is reduced to its stem");
ok(normalizeMigName("supabase" + String.fromCharCode(92) + "migrations" + String.fromCharCode(92) + "20260820120000_foo.sql")
  === "20260820120000_foo", "a windows path is reduced to its stem");
ok(normalizeMigName("  20260820120000_foo.sql  ") === "20260820120000_foo", "surrounding whitespace is ignored");
ok(normalizeMigName(null) === "", "null normalizes to empty, never throws");
ok(normalizeMigName(undefined) === "", "undefined normalizes to empty, never throws");
// The whole point: an alias differs in its STEM, so normalization cannot rescue it.
ok(normalizeMigName("99999999999999_alias_20260820120000_foo") !== normalizeMigName("20260820120000_foo"),
  "an aliased name never normalizes onto the migration it wraps");
ok(normalizeMigName("99999999999999_alias_20260210_fix_rls.sql") !== normalizeMigName("20260210_fix_rls"),
  "the legacy 8-digit alias shape never normalizes onto its target either");

// ── the widening is bounded and INTENTIONAL, and is pinned here ─────────────
// The first draft of this change claimed it could "only refuse, never permit".
// That was false: normalization ACCEPTS spelling variants that substring matching
// refused, because substring matching fails once the case differs. These cases are
// the widening. They are safe only because the proof must still be <30min old, carry
// clean findings, and match the transmitted SQL by queryHash — so a widened NAME
// match can never authorise different CONTENT. If anyone narrows normalizeMigName
// again, these go red and the changelog's claim must be revisited with them.
{
  const oldMatch = (mig, proof) => mig.includes(proof) || proof.includes(mig) || mig === proof;
  const widened = [
    ["20260820120000_foo.sql", "20260820120000_foo.SQL"],
    ["20260820120000_foo.sql", "supabase/migrations/20260820120000_foo"],
    ["20260820120000_foo.SQL", "20260820120000_foo.Sql"],
  ];
  for (const [mig, proof] of widened) {
    ok(!oldMatch(mig, proof), `substring matching REFUSED ${JSON.stringify(mig)} vs ${JSON.stringify(proof)}`);
    ok(normalizeMigName(mig) === normalizeMigName(proof),
      `normalization ACCEPTS it — a deliberate, bounded widening, not a fail-closed change`);
  }
}

for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } }
console.log(`migration-apply-lib: ${pass} assertions passed`);
