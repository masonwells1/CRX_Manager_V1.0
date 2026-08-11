#!/usr/bin/env node
// PreToolUse guard for Supabase MCP `apply_migration` calls.
// Refuses to let Claude apply a migration to live unless proof exists that the
// review subagents (rls-security-reviewer + migration-drift-reviewer) have run
// THIS SESSION on that specific migration and returned clean.
//
// Proof = a file at .claude/session-state/migration-review-<safe-name>.json
// with structure:
//   { "migration": "<filename or migration name>",
//     "timestamp": "<ISO-8601>",
//     "reviewers": ["rls-security-reviewer", "migration-drift-reviewer"],
//     "findings": "clean" | "blockers-fixed" }
//
// The file is written by Claude after subagents return clean. Without it, this
// hook blocks the apply_migration call with explicit instructions.
//
// Setup matcher: this hook is registered against matcher "*" and filters
// in-script for tool names containing "apply_migration".

import { readFileSync, existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { flagActive } from "./autopilot-lib.mjs";
import { destructiveMigrationCheck } from "./live-testdata-lib.mjs";
import { sessionProofDirs } from "./codex-push-lib.mjs";
import { checkMigrationOrdering } from "./migration-ordering-lib.mjs";

const REQUIRED_CODEX_MODEL = "gpt-5.6-sol";
const REQUIRED_CODEX_EFFORT = "high";

function out(decision, reason) {
  const payload = decision === "block"
    ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
    : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  out("allow");
}

const toolName = (payload?.tool_name || "").toLowerCase();
// Only act on apply_migration tool calls; allow everything else instantly.
if (!toolName.includes("apply_migration")) out("allow");

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const stateDir = path.join(projectDir, ".claude", "session-state");

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
// authorize the identical merge. This proof is weaker: interactively `queryHash`
// is enforced only when the proof carries one, and migration names match by
// substring. Scanning all worktrees would therefore let a proof minted by a
// DIFFERENT concurrent session authorize a live apply this session never
// reviewed — against the settled "proof from THIS session" rule
// (docs/manual/DECISION_LOG.md, 2026-07-13) and squarely in Mason's way of
// working, where dozens of worktrees run at once.
//
// So the lookup follows the session's actual working directory, honoured only
// after `git worktree list` confirms it is a checkout of this repository. An
// unrecognised cwd falls back to the primary directory alone — the old
// behaviour, which fails closed.
//
// The AUTOPILOT.on flag above is deliberately narrower still: it stays pinned to
// the primary checkout. It is authorization state for this project, not evidence
// about a migration; reading it from any other checkout would let a flag Mason
// never armed here change the rule-set.
const hookCwd = payload?.cwd || payload?.tool_input?.cwd || process.cwd();
const proofDirs = sessionProofDirs(projectDir, hookCwd, () => execFileSync(
  "git",
  ["worktree", "list", "--porcelain"],
  { cwd: projectDir, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] },
));

// Extract the migration identifier from the MCP call. Supabase MCP apply_migration
// shape is { project_id, name, query }. We use `name` if present, otherwise fall
// back to the first matching migration file from the SQL query content.
const input = payload?.tool_input || {};
const migName = (input.name || "").toString().trim();
const migQuery = (input.query || "").toString();
const currentHash = migQuery ? createHash("sha256").update(migQuery).digest("hex") : "";
const safeName = migName.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "unknown";

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
const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
{
  const snapPath = path.join(stateDir, "applied-migrations.json");
  // The recapture target must be the project THIS apply is aimed at. Reading it
  // from the environment printed a literal `<your project ref>` in every normal
  // hook run — neither manifest exports SUPABASE_PROJECT_REF — and a stray env
  // value could have pointed the operator at a different project's ledger, which
  // the snapshot format cannot detect. The apply call itself is authoritative.
  // (Codex P2, PR #354.)
  const CRX_PRODUCTION_REF = "rhyzpcqhnizqbxphqdkr";
  const targetRef =
    (input.project_id || "").toString().trim() ||
    (process.env.SUPABASE_PROJECT_REF || "").toString().trim() ||
    CRX_PRODUCTION_REF;
  const howTo =
    `Refresh it first (read-only):\n` +
    `  1. Via Supabase MCP execute_sql on ${targetRef}:\n` +
    `       select version, name from supabase_migrations.schema_migrations order by version;\n` +
    `  2. Pipe that JSON into: node scripts/refresh-applied-migrations.mjs --project=${targetRef}\n` +
    `The snapshot is gitignored and per-checkout, so a fresh clone or a newer apply elsewhere ` +
    `means it must be regenerated. Do NOT hand-write it.`;

  let appliedNames = [];
  let snapshotAgeMs = null;
  try {
    if (!existsSync(snapPath)) {
      out("block",
        `MIGRATION ORDERING GUARD: no applied-migration snapshot at ${snapPath}, so there is no ` +
        `evidence of what the database has already run and an out-of-order replay could not be ` +
        `detected. Refusing the apply.\n\n${howTo}`);
    }
    const parsed = JSON.parse(readFileSync(snapPath, "utf8"));

    // The snapshot must name the database it was read from, and that database
    // must be the one this apply is aimed at. Time, count and names alone are
    // portable: production's ledger carried to a restored copy or a staging
    // branch reads as that database's own history, and `ledgerHas()` below then
    // reports a one-shot money migration as already applied against a database
    // that has never run it — switching the replay guard off exactly where it
    // is needed (Codex High, PR #364 round 10). A bare-array snapshot cannot
    // carry the field at all, so it is no longer accepted.
    const snapProject = (Array.isArray(parsed) ? "" : (parsed?.project_id ?? ""))
      .toString().trim().toLowerCase();
    if (!snapProject) {
      out("block",
        `MIGRATION ORDERING GUARD: the applied-migration snapshot at ${snapPath} does not record ` +
        `which database it was captured from, so it cannot be shown to describe ${targetRef}. An ` +
        `unbound ledger is replayable against any database, which would disable the one-shot ` +
        `replay check. Refusing the apply.\n\n${howTo}`);
    }
    if (snapProject !== targetRef.toLowerCase()) {
      out("block",
        `MIGRATION ORDERING GUARD: the applied-migration snapshot was captured from project ` +
        `"${snapProject}" but this apply targets "${targetRef}". A ledger is evidence about one ` +
        `database only — reading another database's applied list here would both mis-order this ` +
        `migration and mark one-shot data repairs as already run. Refusing the apply.\n\n${howTo}`);
    }

    const rows = Array.isArray(parsed) ? parsed : parsed?.applied;
    if (!Array.isArray(rows) || rows.length === 0) {
      out("block",
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
        const name = (r?.name ?? "").toString().trim();
        const version = (r?.version ?? "").toString().trim();
        if (name && /\d{14}/.test(name)) return name;
        if (version && name) return `${version}_${name}`;
        return version || name || "";
      })
      .filter(Boolean);

    // A snapshot can be present, fresh and non-empty yet contain not one
    // parseable timestamp — in which case the ordering check has nothing to
    // compare against and abstains, and the apply would sail through a gate
    // that looks satisfied. Refuse instead: this is the silent gap the whole
    // mechanism exists to close (CodeRabbit, PR #348).
    if (!appliedNames.some((n) => /\d{14}/.test(n))) {
      out("block",
        `MIGRATION ORDERING GUARD: the applied-migration snapshot at ${snapPath} has ` +
        `${appliedNames.length} row(s) but not one carries a 14-digit migration timestamp, so no ` +
        `ordering comparison is possible. A snapshot that cannot answer the question must not be ` +
        `treated as answering it. Refusing the apply.\n\n${howTo}`);
    }

    const capturedAt = Date.parse(parsed?.captured_at ?? "");
    if (Number.isFinite(capturedAt)) {
      snapshotAgeMs = Date.now() - capturedAt;
      if (snapshotAgeMs > SNAPSHOT_MAX_AGE_MS) {
        out("block",
          `MIGRATION ORDERING GUARD: the applied-migration snapshot is ` +
          `${Math.floor(snapshotAgeMs / 3600000)}h old (captured ${parsed.captured_at}). Migrations ` +
          `applied since then are invisible to this check, so it could pass a replay that is ` +
          `actually behind the live high-water mark. Refusing the apply.\n\n${howTo}`);
      }
    } else {
      out("block",
        `MIGRATION ORDERING GUARD: the applied-migration snapshot has no usable captured_at ` +
        `timestamp, so its freshness cannot be established. Refusing the apply.\n\n${howTo}`);
    }
  } catch (err) {
    // out() exits the process, so a genuine block above never lands here.
    out("block",
      `MIGRATION ORDERING GUARD: could not read the applied-migration snapshot at ${snapPath} ` +
      `(${err?.message || err}). Refusing the apply rather than proceeding without ordering ` +
      `evidence.\n\n${howTo}`);
  }

  try {
    const ordering = checkMigrationOrdering({ name: migName, sql: migQuery, appliedNames });
    if (!ordering.ok) out("block", ordering.reason);
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
      out("block",
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
    out("block",
      `MIGRATION ORDERING GUARD failed to evaluate "${safeName}": ${err?.message || err}. ` +
      `Refusing the apply rather than skipping the check. Fix the guard, or state an explicit ` +
      `intentional replay in the migration SQL if that is genuinely what this is.`);
  }

  // ONE-SHOT REPLAY GUARD (2026-08-10, Codex High round 8).
  //
  // supabase/baselines/one-shot-migrations.json registers data migrations whose
  // authorization was bound to the live population at the moment they were
  // written — counts, not row identity. Replaying one onto a database whose
  // ledger does not already contain it rewrites rows nobody approved.
  //
  // Registering them only taught scripts/list-post-baseline-migrations.mjs to
  // withhold them from the replay plan. That is one path. This is the other:
  // the SQL file is still sitting on disk, and an ordinary apply against a
  // restored or drifted database still sees it, so the containment was
  // advisory. It is now enforced at the apply itself.
  //
  // "Ledger lacks it" is the trigger, because a ledger that HAS it is by
  // definition the population the migration was approved against — and a
  // duplicate apply there is an ordering problem, already handled above.
  {
    const registryPath = path.join(projectDir, "supabase", "baselines", "one-shot-migrations.json");
    let oneShot = null;
    try {
      const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
      oneShot = parsed?.one_shot;
      if (!oneShot || typeof oneShot !== "object") throw new Error("no `one_shot` map");
    } catch (err) {
      // Fail closed. The registry is tracked in git and ships beside this hook,
      // so an unreadable one means the checkout is broken or the file was
      // removed — the two states in which a silent pass is most dangerous.
      out("block",
        `ONE-SHOT REPLAY GUARD: could not read the one-shot migration registry at ${registryPath} ` +
        `(${err?.message || err}). Without it there is no way to tell an idempotent schema ` +
        `migration from a population-bound data repair, so this apply is refused. Restore the ` +
        `file from git (it is tracked) and retry.`);
    }

    // Normalize for comparison: lowercase, strip `--` line comments, collapse
    // whitespace. Enough to catch a reformatted copy-paste of the same body;
    // NOT enough to catch a materially rewritten one — but a materially
    // rewritten body is a new migration that needs its own review anyway.
    const norm = (s) => s
      .toLowerCase()
      .replace(/--[^\n]*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const normQuery = norm(migQuery);
    const ledgerHas = (stem) => {
      const version = (stem.match(/\d{14}/) || [])[0];
      return appliedNames.some((n) => n.includes(stem) || (version && n.includes(version)));
    };

    for (const [stem, reason] of Object.entries(oneShot)) {
      if (ledgerHas(stem)) continue;

      const version = (stem.match(/\d{14}/) || [])[0] || "";
      let matched = "";
      // The MCP `name` is caller-controlled, so a name match is a convenience,
      // not the whole test — the body is checked too.
      if (migName && (migName.includes(stem) || (version && migName.includes(version)))) {
        matched = `the migration name "${safeName}"`;
      } else if (normQuery) {
        try {
          const filePath = path.join(projectDir, "supabase", "migrations", `${stem}.sql`);
          if (existsSync(filePath)) {
            const normFile = norm(readFileSync(filePath, "utf8"));
            if (normFile && (normQuery.includes(normFile) || normFile.includes(normQuery))) {
              matched = `the SQL body (it matches ${stem}.sql on disk)`;
            }
          }
        } catch { /* a missing or unreadable file just means no body match */ }
      }
      if (!matched) continue;

      // Digest-bound override: an operator who genuinely means to replay this
      // must hash the EXACT SQL they are about to run and record it. A named
      // flag would be a wave-through for any body; binding to `currentHash`
      // means the override authorizes this text and nothing else.
      const ovPath = path.join(stateDir, "one-shot-replay-override.json");
      let overrideOk = false;
      try {
        if (existsSync(ovPath)) {
          const ov = JSON.parse(readFileSync(ovPath, "utf8"));
          overrideOk =
            (ov?.migration || "").toString().trim() === stem &&
            currentHash !== "" &&
            (ov?.queryHash || "").toString().trim().toLowerCase() === currentHash;
        }
      } catch { overrideOk = false; }
      if (overrideOk) continue;

      out("block",
        `ONE-SHOT REPLAY GUARD: this apply matches ${matched}, which is registered as a one-shot ` +
        `DATA migration in supabase/baselines/one-shot-migrations.json, and the applied-migration ` +
        `ledger for this database does NOT contain it.\n\n` +
        `Why it is registered: ${reason}\n\n` +
        `Its authorization was bound to the live population at the time it was written, so running ` +
        `it against a database that never had it rewrites rows nobody approved. After a restore, ` +
        `the corrected values come back with the DATA — not by re-running the edit.\n\n` +
        `If this really is a deliberate, reviewed replay, bind the override to the exact SQL:\n` +
        `  node -e "const c=require('node:crypto'),f=require('node:fs');` +
        `const q=f.readFileSync('supabase/migrations/${stem}.sql','utf8');` +
        `f.writeFileSync('.claude/session-state/one-shot-replay-override.json',` +
        `JSON.stringify({migration:'${stem}',queryHash:c.createHash('sha256').update(q).digest('hex')}))"\n` +
        `That override authorizes that exact text and nothing else. Get Mason's explicit OK first — ` +
        `this is a live money write.`);
    }
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
    try { flagState = flagActive(readFileSync(apFlagPath, "utf8"), Date.now()).active ? "active" : "stale"; }
    catch { flagState = "stale"; }
  }
} catch { flagState = "stale"; } // can't even inspect the flag → fail closed

if (flagState === "stale") {
  out("block",
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
    out("block",
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
const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const now = Date.now();

let validProof = null;
for (const dir of proofDirs) {
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
    const proofName = (data.migration || "").toString();
    if (
      proofName &&
      (migName.includes(proofName) || proofName.includes(migName) || migName === proofName)
    ) {
      const findings = (data.findings || "").toString();
      if (findings === "clean" || findings === "blockers-fixed") {
        // Content-binding: if the proof recorded a queryHash, it must match the SQL
        // actually being applied. A mismatch means the migration was edited AFTER it
        // was reviewed, so the proof no longer attests to this content — skip it.
        if (data.queryHash && currentHash && data.queryHash !== currentHash) continue;
        validProof = { file: f, dir, data };
        break;
      }
    }
  }
  } catch { /* directory unreadable — try the next one, then fall through to block */ }
}

if (validProof) {
  // Hands-free applies carry three EXTRA requirements (Codex P1s 2026-07-13
  // rounds 2-3) — with Mason absent, the proof must be maximally bound:
  //   1. Exact content binding: the proof's queryHash must be present and
  //      match the transmitted SQL (interactively it's optional-but-checked;
  //      unattended, an unbound proof could apply edited-after-review SQL).
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
      out("block",
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
      out("block",
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
    // documented self-attestation residual (KNOWN_ISSUES §4b).
    // Searched across the same session-scoped directories as the reviewer proof
    // above, for the same reason. A candidate only WINS by satisfying
    // every criterion the single-directory version demanded — clean verdict,
    // exact queryHash, age inside [0, 30min]; the first parseable file is kept
    // only so the block message below can say which criterion failed.
    let codexProof = null;
    for (const dir of proofDirs) {
      let candidate = null;
      try { candidate = JSON.parse(readFileSync(path.join(dir, `codex-review-mig-${safeName}.json`), "utf8")); } catch { continue; }
      if (!candidate) continue;
      if (!codexProof) codexProof = candidate;
      const okVerdict = ["clean", "ship", "ship-with-followups"].includes(String(candidate.verdict || "").toLowerCase());
      const okHash = !!currentHash && String(candidate.queryHash || "") === currentHash;
      const okIdentity = candidate.model === REQUIRED_CODEX_MODEL
        && candidate.reasoning_effort === REQUIRED_CODEX_EFFORT;
      let okFresh = false;
      try {
        const candidateAge = now - new Date(candidate.timestamp).getTime();
        okFresh = candidateAge >= 0 && candidateAge <= MAX_AGE_MS;
      } catch { okFresh = false; }
      if (okVerdict && okHash && okIdentity && okFresh) { codexProof = candidate; break; }
    }
    const cvOk = codexProof && ["clean", "ship", "ship-with-followups"].includes(String(codexProof.verdict || "").toLowerCase());
    const cvHashOk = codexProof && currentHash && String(codexProof.queryHash || "") === currentHash;
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
    if (!cvOk || !cvHashOk || !cvIdentityOk || !cvFresh) {
      out("block",
        `MIGRATION APPLY GUARD (hands-free run): the Sol high-effort gate is not satisfied for ` +
        `"${migName || "(unnamed)"}" (${!codexProof ? "no Codex proof file" : !cvOk ? "verdict is not clean/ship" : !cvHashOk ? "queryHash does not match the transmitted SQL" : !cvIdentityOk ? `proof must record model=${REQUIRED_CODEX_MODEL} and reasoning_effort=${REQUIRED_CODEX_EFFORT}` : "proof timestamp is not within the last 30 minutes"}). ` +
        `Autonomous applies require a fresh, content-bound Codex verdict (Mason's settled 2026-07-13 ` +
        `policy). Run: node scripts/write-apply-proofs.mjs ${migName || "<migName>"} — it runs the ` +
        `trusted Codex CLI itself and mints the content-bound proof ONLY on a CLEAN machine verdict. ` +
        `Do NOT hand-write the proof JSON (review-proof-guard blocks any command naming it, by design). ` +
        `A BLOCKERS verdict or a failed Codex run does NOT qualify — fix the findings or PARK the ` +
        `migration for Mason. Never self-certify.`);
    }
  }
  out("allow");
}

// No valid proof — block with explicit instructions.
out("block",
  `MIGRATION APPLY GUARD: Cannot apply migration "${migName || "(unnamed)"}" without subagent review proof.\n\n` +
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
