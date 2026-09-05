#!/usr/bin/env node
// SessionStart staleness checks. Surfaces things that have drifted while the
// laptop was closed:
//   - schema-registry.json BEHIND registry-relevant migrations on disk
//     (schema-neutral cron/data-only migrations do not create a false alarm)
//   - Uncommitted files from a prior session
//   - Weekly DB backup missing or stale. Two evidence sources, newest wins:
//     backups/LATEST-OK.json (stamped by a locally-run scripts/backup-db.mjs)
//     and the "Off-site DB backup" GitHub Actions workflow in
//     masonwells1/CRX_Backups, where the SCHEDULED backup actually runs
//     (Supabase FREE plan has no point-in-time recovery).
//
// Returns a "prompt" hookSpecificOutput.additionalContext so Claude sees the
// warnings at session start and can mention them to Mason proactively.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function emit(extra) {
  if (extra) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: extra }
    }));
  }
  process.exit(0);
}

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const warnings = [];

function backupMarkerPath() {
  const localPath = path.join(projectDir, "backups", "LATEST-OK.json");

  // Linked worktrees share the main checkout's Git common directory, but they
  // do not share gitignored backup files, so the marker can legitimately land in
  // either place: `/backup-db` stamps `backups/LATEST-OK.json` relative to the
  // checkout it ran in (scripts/backup-db.mjs), which is a worktree whenever the
  // backup session was started from one.
  //
  // Pick the NEWEST marker rather than preferring one location. Preferring the
  // canonical checkout kept a stale worktree-local marker from masking shared
  // state, but it also meant a backup taken from a worktree was invisible — every
  // later session then warned that a fresh backup was missing or stale, which
  // trains Mason to ignore the one warning that says his only copy of production
  // data died. Newest-wins keeps the original protection (a stale local marker
  // simply loses to the newer canonical one) without inventing the false alarm.
  //
  // Ask Git where the main checkout is rather than deriving it from the common Git
  // directory. `path.dirname(<git-common-dir>)` only lands on the checkout in the
  // default `<checkout>/.git` layout: under `--separate-git-dir` or in a bare repo the
  // Git directory lives somewhere else entirely, and dirname() then points at an
  // unrelated folder that gets probed for — and could genuinely contain — a
  // `backups/LATEST-OK.json` belonging to some other project (CodeRabbit on #369).
  //
  // `git worktree list --porcelain` lists the main worktree first and flags a bare
  // repository outright. It is still not enough on its own: for a `--separate-git-dir`
  // repository Git reports the *Git directory* as the main worktree, because nothing in
  // that layout records the way back to the checkout. So the candidate is accepted only
  // once it proves it is a checkout, by carrying a `.git` entry of its own. An
  // unsupported layout is rejected rather than guessed at — the worktree-local marker
  // then stands alone, which under-reports a shared backup but never invents one.
  const candidates = [localPath];
  try {
    const porcelain = execFileSync(
      "git",
      ["worktree", "list", "--porcelain"],
      {
        cwd: projectDir,
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const firstEntry = porcelain.split(/\r?\n\r?\n/)[0] || "";
    const mainWorktree = /^worktree (.+)$/m.exec(firstEntry)?.[1]?.trim();
    if (mainWorktree && !/^bare$/m.test(firstEntry) && existsSync(path.join(mainWorktree, ".git"))) {
      candidates.push(path.join(mainWorktree, "backups", "LATEST-OK.json"));
    }
  } catch { /* fall back to the worktree-local path */ }

  let best = null;
  let bestAt = -Infinity;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    // An unreadable or undated marker still counts as "a backup exists" — it must
    // not be silently dropped in favour of nothing — it just cannot win on date.
    let completedAt = -Infinity;
    try {
      const parsed = Date.parse(JSON.parse(readFileSync(candidate, "utf8"))?.completed_at);
      if (Number.isFinite(parsed)) completedAt = parsed;
    } catch { /* undated marker: keep it as a last-resort candidate */ }
    if (best === null || completedAt > bestAt) {
      best = candidate;
      bestAt = completedAt;
    }
  }
  return best ?? localPath;
}

function migrationMayAffectSchemaRegistry(sql) {
  const withoutComments = String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\r\n]*/g, " ");
  return /\b(?:create|alter|drop)\s+(?:table|function|type|sequence)\b|\b(?:add|drop)\s+constraint\b/i.test(withoutComments);
}

// ─── CHECK 1 — schema registry staleness (content-based, not mtime) ──────
const registryPath = path.join(projectDir, ".claude", "schema-registry.json");
try {
  if (existsSync(registryPath)) {
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    const highWater = registry?._meta?.migrations_high_water;
    const appliedNames = registry?._meta?.applied_migration_names;

    if (Array.isArray(appliedNames) && highWater && /^\d{14}$/.test(String(highWater))) {
      // v2 with Q6 (FIX 1): decide "behind" by NAME membership, not the raw
      // numeric version compare. Migrations applied via the Supabase MCP get a
      // server-assigned `version` that can be LOWER than the timestamp in the
      // migration's filename, which made the numeric compare below false-positive
      // forever on those migrations (e.g. 20260713050000_weekly_db_backup.sql —
      // applied live under a different version number, but disk stamp > high-water).
      // supabase_migrations.schema_migrations.name = disk filename minus .sql.
      //
      // Scope: still use the numeric compare to pick the CANDIDATE window (disk
      // stamp > high-water) — the same window the old check used — then use name
      // membership only to REFUTE false positives inside that window. A pure
      // "not in the applied-name list" check over ALL disk migrations was tried
      // and rejected: a large number of historical migrations were recorded live
      // under a name that drops the timestamp prefix entirely (pre-existing,
      // already-known disk-vs-live drift — see docs — not something this session
      // touched), so a full-history name check trades one false positive for a
      // flood of ~100+ unrelated ones. Restricting the name check to the same
      // "did this look new" window the numeric check already used keeps the fix
      // targeted at the actual bug (recent MCP applies) without resurrecting old
      // drift as new noise.
      const appliedSet = new Set(appliedNames.map(n => String(n).replace(/\.sql$/, "")));
      const inAppliedSet = (baseName) =>
        appliedSet.has(baseName) || appliedSet.has(baseName.replace(/^\d{14}_/, ""));
      // The candidate-window boundary must be the max AUTHORED stamp among applied
      // migrations (the 14-digit prefix of the ledger `name`), NOT the raw
      // migrations_high_water. The server assigns apply-TIME versions, so an MCP
      // apply can stamp a version DAYS AHEAD of every authored filename (the
      // 2026-08-24 barrier apply landed as version 20260824185408 while its name
      // is 20260816110000_...). A boundary read from max(version) then swallows
      // written-but-UNAPPLIED migrations authored in between (20260819232000_...)
      // before the name check ever sees them — the warning this check exists to
      // emit goes silent. Same rule as the migration-drift reviewer's CHECK 6:
      // ordering compares the ledger NAME high-water; `version` is only the
      // fallback when no name carries a stamp.
      let windowBoundary = String(highWater);
      const authoredStamps = appliedNames
        .map(n => (String(n).match(/^(\d{14})_/) || [])[1])
        .filter(Boolean);
      if (authoredStamps.length > 0) {
        windowBoundary = authoredStamps.reduce((a, b) => (b > a ? b : a));
      }
      const migDir = path.join(projectDir, "supabase", "migrations");
      const missing = [];
      if (existsSync(migDir)) {
        for (const f of readdirSync(migDir)) {
          const m = f.match(/^(\d{14})_.+\.sql$/);
          if (!m || m[1] <= windowBoundary) continue;
          const baseName = f.replace(/\.sql$/, "");
          if (inAppliedSet(baseName)) continue; // applied live, just under a different version number
          const sql = readFileSync(path.join(migDir, f), "utf8");
          if (migrationMayAffectSchemaRegistry(sql)) missing.push(f);
        }
      }
      if (missing.length > 0) {
        missing.sort();
        const sample = missing.slice(0, 5).map(f => "      " + f).join("\n");
        warnings.push(
          `📅 Schema registry is BEHIND the migrations on disk: ${missing.length} migration file(s) carry a ` +
          `newer stamp than the applied-migration authored high-water (${windowBoundary}) AND are not in the registry's applied-migration name list:\n` + sample +
          (missing.length > 5 ? `\n      ... and ${missing.length - 5} more` : "") +
          `\n   If these were applied live, the 4 schema-aware hooks are validating against a stale schema —\n` +
          `   invoke /regen-schema-registry. If they are written-but-unapplied, apply (or park) them first.`
        );
      }
    } else if (highWater && /^\d{14}$/.test(String(highWater))) {
      // Fallback (no _meta.applied_migration_names — pre-FIX-1 registry, or
      // introspection run without the Q6 query): compare the registry's
      // applied-migration high water against the highest migration filename
      // stamp on disk. mtime lies (a git checkout refreshes it); content doesn't.
      // NOTE: this numeric compare can false-positive for migrations applied via
      // the Supabase MCP, whose server-assigned `version` may be lower than the
      // filename's timestamp — regenerate the registry with the Q6 applied-names
      // query (see scripts/regenerate-schema-registry.mjs) to get the more
      // reliable name-based check above.
      const migDir = path.join(projectDir, "supabase", "migrations");
      const newer = [];
      if (existsSync(migDir)) {
        for (const f of readdirSync(migDir)) {
          const m = f.match(/^(\d{14})_.+\.sql$/);
          if (m && m[1] > String(highWater)) {
            const sql = readFileSync(path.join(migDir, f), "utf8");
            if (migrationMayAffectSchemaRegistry(sql)) newer.push(f);
          }
        }
      }
      if (newer.length > 0) {
        newer.sort();
        const sample = newer.slice(0, 5).map(f => "      " + f).join("\n");
        warnings.push(
          `📅 Schema registry is BEHIND the migrations on disk: registry high-water is ${highWater}, ` +
          `but ${newer.length} migration file(s) carry a newer stamp:\n` + sample +
          (newer.length > 5 ? `\n      ... and ${newer.length - 5} more` : "") +
          `\n   If these were applied live, the 4 schema-aware hooks are validating against a stale schema —\n` +
          `   invoke /regen-schema-registry. If they are written-but-unapplied, apply (or park) them first.\n` +
          `   (NOTE: version-vs-filename numbering can false-positive for migrations applied via the Supabase MCP — ` +
          `a name-based recheck via the Q6 query would be more reliable.)`
        );
      }
    } else {
      // v1-shaped registry (no high-water mark): fall back to the mtime check.
      const stat = statSync(registryPath);
      const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
      if (ageDays > 7) {
        warnings.push(
          `📅 Schema registry is ${Math.round(ageDays)} days old (last regenerated ${stat.mtime.toISOString().slice(0, 10)}) ` +
          `and has no _meta.migrations_high_water (v1 shape).\n` +
          `   This is the source of truth for 4 PreToolUse hooks and the review subagents.\n` +
          `   Recommend: invoke /regen-schema-registry to refresh from live Supabase (also upgrades it to v2).`
        );
      }
    }
  }
} catch (err) {
  // FIX 2 (loud fail-open): this check exists to catch schema-registry drift —
  // if the registry itself can't be read/parsed, say so instead of silently
  // dropping the check (the caller would otherwise have zero signal that the
  // registry-staleness check never ran this session).
  warnings.push(
    `⚠ session-staleness: schema-registry unreadable/unparseable (${err?.message || err}) — ` +
    `the registry-staleness check SKIPPED. Run /regen-schema-registry.`
  );
}

// ─── CHECK 2 — uncommitted files from prior session ──────────────────────
try {
  const porcelain = execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
    cwd: projectDir,
  });
  const lines = porcelain.split("\n").filter(l => l.trim());
  // Filter out the well-known untracked dirs from the SessionStart context.
  const meaningfulLines = lines.filter(l => {
    const p = l.slice(3);
    return !p.startsWith(".claude/worktrees/")
      && !p.startsWith(".playwright-mcp/")
      && !p.startsWith("docs/audits/")  // audit-prompt scratch
      ;
  });
  if (meaningfulLines.length > 0) {
    const sample = meaningfulLines.slice(0, 6).map(l => "      " + l).join("\n");
    warnings.push(
      `📝 You have ${meaningfulLines.length} uncommitted file(s) from before this session:\n` +
      sample +
      (meaningfulLines.length > 6 ? `\n      ... and ${meaningfulLines.length - 6} more` : "") +
      `\n   Recommend: run /preflight before continuing — these might be in-progress work or forgotten changes.`
    );
  }
} catch { /* ignore */ }

// ─── CHECK 4 — weekly DB backup freshness ─────────────────────────────────
// Two evidence sources, newest wins:
//   1. backups/LATEST-OK.json — stamped only by a locally-run /backup-db
//      (scripts/backup-db.mjs), so it is per-checkout and goes stale in every
//      fresh worktree.
//   2. The "Off-site DB backup" GitHub Actions workflow in masonwells1/CRX_Backups,
//      where the SCHEDULED backup actually runs. It never stamps a local marker,
//      which made the marker-only check cry wolf in fresh worktrees (2026-08-18:
//      claimed 9 days stale while the workflow had succeeded on schedule two days
//      earlier). gh is consulted only when the marker alone would alarm, and the
//      answer is cached with a TTL so the hook stays inside its ~2s budget.
// When gh is unreachable (offline, unauthenticated), the marker-only verdict
// stands but is labeled unverified, so a false alarm reads as one.
const OFFSITE_REPO = "masonwells1/CRX_Backups";
const OFFSITE_WORKFLOW = "Off-site DB backup";
const OFFSITE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;   // fresh answer: ask gh at most ~4x/day
const OFFSITE_FAILURE_TTL_MS = 10 * 60 * 1000;     // offline: don't stall every session start
const OFFSITE_GH_TIMEOUT_MS = 1500;
const STALE_AFTER_DAYS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

// Returns { available: true, completedAt: <ms epoch | null> } when gh (or a
// fresh cache of it) answered — null completedAt means the workflow has NO
// successful run on record — or { available: false } when gh could not be
// consulted, in which case the caller falls back to the local marker alone.
// Test seams: CRX_OFFSITE_BACKUP_DISABLE=1 skips the check entirely,
// CRX_OFFSITE_BACKUP_CACHE overrides the cache file, CRX_OFFSITE_BACKUP_GH
// overrides the gh executable. The cache deliberately lives in the user's HOME
// directory, not the checkout (one fleet-wide answer instead of one per
// worktree) and not the shared temp dir (another local user must not be able
// to plant a fake answer that suppresses or triggers the backup warning).
function offsiteBackupEvidence() {
  if (process.env.CRX_OFFSITE_BACKUP_DISABLE === "1") return { available: false };
  const cachePath = process.env.CRX_OFFSITE_BACKUP_CACHE ||
    path.join(os.homedir(), ".crx-offsite-backup-check.json");

  try {
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    const age = Date.now() - Date.parse(cached?.fetched_at);
    const ttl = cached?.ok ? OFFSITE_CACHE_TTL_MS : OFFSITE_FAILURE_TTL_MS;
    if (Number.isFinite(age) && age >= 0 && age < ttl) {
      if (!cached.ok) return { available: false };
      const at = Date.parse(cached.completed_at);
      return { available: true, completedAt: Number.isFinite(at) ? at : null };
    }
  } catch { /* no cache yet, or unreadable: ask gh */ }

  let entry;
  try {
    const out = execFileSync(process.env.CRX_OFFSITE_BACKUP_GH || "gh", [
      "run", "list",
      "--repo", OFFSITE_REPO,
      "--workflow", OFFSITE_WORKFLOW,
      "--status", "success",
      "--limit", "1",
      "--json", "updatedAt",
    ], {
      encoding: "utf8",
      timeout: OFFSITE_GH_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const runs = JSON.parse(out);
    if (!Array.isArray(runs)) throw new Error("unexpected gh output shape");
    entry = { ok: true, completed_at: runs[0]?.updatedAt ?? null };
  } catch {
    entry = { ok: false };
  }
  try {
    writeFileSync(cachePath, JSON.stringify({ fetched_at: new Date().toISOString(), ...entry }), { mode: 0o600 });
  } catch { /* the cache is an optimization; failing to write it is not an error */ }
  if (!entry.ok) return { available: false };
  const at = Date.parse(entry.completed_at);
  return { available: true, completedAt: Number.isFinite(at) ? at : null };
}

try {
  const latestOkPath = backupMarkerPath();
  const markerExists = existsSync(latestOkPath);
  let markerAt = null;
  if (markerExists) {
    const parsed = Date.parse(JSON.parse(readFileSync(latestOkPath, "utf8"))?.completed_at);
    if (Number.isFinite(parsed)) markerAt = parsed;
  }

  const markerFresh = markerAt !== null && (Date.now() - markerAt) / DAY_MS <= STALE_AFTER_DAYS;
  if (!markerFresh) {
    // The marker alone would alarm — consult the real evidence first.
    const offsite = offsiteBackupEvidence();
    const offsiteAt = offsite.available ? offsite.completedAt : null;
    const newestAt = Math.max(markerAt ?? -Infinity, offsiteAt ?? -Infinity);

    if (!markerExists && offsiteAt === null) {
      warnings.push(
        offsite.available
          ? `💾 No successful DB backup on record — no local backup marker, and the "${OFFSITE_WORKFLOW}" workflow in ${OFFSITE_REPO} has never succeeded.\n` +
            `   (Supabase FREE plan = no point-in-time recovery.) Say "back up the database" to create the first one.`
          : `💾 No database backup exists yet — say "back up the database" to create the first one.\n` +
            `   (Supabase FREE plan = no point-in-time recovery; the weekly /backup-db dump is the only copy.)\n` +
            `   (Could not verify the off-site "${OFFSITE_WORKFLOW}" workflow — gh unavailable — so this may be a false alarm.)`
      );
    } else if (Number.isFinite(newestAt)) {
      const ageDays = (Date.now() - newestAt) / DAY_MS;
      if (ageDays > STALE_AFTER_DAYS) {
        warnings.push(
          `💾 Last DB backup is ${Math.round(ageDays)} days old (weekly expected) — the scheduled backup may have died.\n` +
          (offsite.available
            ? (offsiteAt !== null
                ? `   (Verified against real evidence: the "${OFFSITE_WORKFLOW}" workflow in ${OFFSITE_REPO} last succeeded ${Math.round((Date.now() - offsiteAt) / DAY_MS)} days ago.)\n`
                : `   (Real evidence: the "${OFFSITE_WORKFLOW}" workflow in ${OFFSITE_REPO} has NO successful run on record.)\n`)
            : `   (Local marker only — could not verify the off-site "${OFFSITE_WORKFLOW}" workflow (gh unavailable), so this may be a stale-worktree false alarm.)\n`) +
          `   Recommend: run /backup-db now, then check why the weekly scheduled session stopped.`
        );
      }
    }
    // A marker that exists but has no parseable date, with no off-site timestamp,
    // keeps the historical silence — an undated marker has never been treated as
    // a missing backup.
  }
} catch { /* ignore */ }

if (warnings.length === 0) emit();

emit(
  `═══ SESSION STALENESS CHECK ═══\n\n` +
  warnings.join("\n\n") +
  `\n\n   (These warnings come from .claude/hooks/session-staleness.mjs.\n` +
  `    Mention them to Mason if relevant to the task he asks about.)`
);
