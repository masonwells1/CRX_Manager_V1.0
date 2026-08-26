#!/usr/bin/env node
// Pre-commit ledger guard (Mason, 2026-07-13): converts the last SOFT
// documentation rule into a HARD one. If a commit touches the agent surface —
// commands, skills, hooks, workflows, settings, the shared contract, the guard
// scripts themselves, OR a database migration (2026-07-16) — it must ALSO update
// at least one ledger file (CHANGELOG, DECISION_LOG, KNOWN_ISSUES, another
// docs/manual/ file, agent-guardrails.md, or a loop ledger) in the SAME commit.
// Otherwise a policy, guard, or live-database change lands with no written
// record, and Mason (zero code knowledge) has no way to discover what changed or
// why. Migrations were added because the manual layer went stale within 48h of
// shipping — a migration that lands with no ledger line is exactly that failure.
//
// Runs from .husky/pre-commit (BLOCKING). Examines STAGED files only, so a
// dirty working tree doesn't false-positive.

import { execFileSync } from "node:child_process";

// Files whose change means "the agent surface / policy changed".
const TRIGGER_RES = [
  /^\.claude\/(commands|skills|hooks|workflows|agents)\//,
  /^\.claude\/settings\.json$/,
  /^\.codex\//,
  /^AGENTS\.md$/,
  /^CLAUDE\.md$/,
  /^\.husky\//,
  // The deterministic guard layer in scripts/: validators, checkers,
  // verifiers, and the workflow mirror-sync.
  /^scripts\/(check-|validate-|verify-)[^/]+$/,
  /^scripts\/sync-agent-workflows\.mjs$/,
  // Shared by both mirror comparisons: an edit here changes what "in sync"
  // means for the whole agent surface (2026-08-19).
  /^scripts\/normalize-eol\.mjs$/,
  /^scripts\/agent-health-check\.mjs$/,
  /^scripts\/run-claude-review\.mjs$/,
  /^scripts\/write-codex-push-proof\.mjs$/,
  // A new database migration is a live-schema change — it must leave a ledger
  // trail too (2026-07-16 scaffolding review). Existing migrations are immutable
  // so only ADDED files realistically hit this; the /ship flow's CHANGELOG +
  // migration-history update already satisfies it.
  /^supabase\/migrations\/[^/]+\.sql$/,
];

// docs/reference/migration-history.md is the natural ledger companion for a
// migration commit, so it also satisfies the requirement (added 2026-07-16).

// Any ONE of these staged alongside satisfies the ledger requirement.
const LEDGER_RES = [
  /^docs\/CHANGELOG\.md$/,
  /^docs\/manual\/[^/]+\.md$/,
  /^docs\/reference\/agent-guardrails\.md$/,
  /^docs\/reference\/migration-history\.md$/,
  /^docs\/loops\//,
];

// Pure classifier — exported for tests. Takes repo-relative staged paths
// (forward slashes) and returns { ok, triggers, reason? }.
export function ledgerCheck(stagedFiles) {
  const files = (stagedFiles || []).map((f) => String(f).replace(/\\/g, "/"));
  const triggers = files.filter((f) => TRIGGER_RES.some((re) => re.test(f)));
  if (triggers.length === 0) return { ok: true, triggers: [] };
  const hasLedger = files.some((f) => LEDGER_RES.some((re) => re.test(f)));
  if (hasLedger) return { ok: true, triggers };
  return {
    ok: false,
    triggers,
    reason:
      "This commit changes the agent surface (commands / skills / hooks / workflows / settings / " +
      "shared contract / guard scripts) but stages NO ledger update. Every such change must be " +
      "recorded in the same commit so Mason and future agents can discover it.",
  };
}

// ── CLI (pre-commit entry point) ─────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  let staged;
  try {
    staged = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMRTD"], { encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch (e) {
    // Can't read the git index at all — warn LOUDLY but don't brick every
    // commit on a git plumbing error (same loud-fail-open pattern as the
    // schema-registry guards; the failure mode here is a missed ledger line,
    // not data loss).
    console.error(`⚠️  ledger-guard: could not read staged files (${e && e.message}) — skipping check. INVESTIGATE.`);
    process.exit(0);
  }

  const result = ledgerCheck(staged);
  if (result.ok) {
    if (result.triggers.length > 0) {
      console.log(`✅ ledger-guard: agent-surface change is accompanied by a ledger update (${result.triggers.length} trigger file(s)).`);
    }
    process.exit(0);
  }

  console.error("❌ LEDGER UPDATE REQUIRED — commit blocked.");
  console.error("");
  console.error(result.reason);
  console.error("");
  console.error("Agent-surface files staged in this commit:");
  for (const t of result.triggers.slice(0, 20)) console.error(`  • ${t}`);
  if (result.triggers.length > 20) console.error(`  … and ${result.triggers.length - 20} more`);
  console.error("");
  console.error("Fix: stage at least ONE ledger update in the same commit —");
  console.error("  • docs/CHANGELOG.md            (what changed, for shipped work)");
  console.error("  • docs/manual/DECISION_LOG.md  (a settled decision)");
  console.error("  • docs/manual/KNOWN_ISSUES.md  (a finding / parked item)");
  console.error("  • any other docs/manual/*.md, docs/reference/agent-guardrails.md, or a docs/loops/ ledger");
  console.error("");
  console.error("Do NOT write a throwaway line to satisfy the guard — record what actually changed and why.");
  console.error("Never use --no-verify to bypass this.");
  process.exit(1);
}
