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

// A changelog.d entry is `<YYYY-MM-DD>-<slug>.md`, flat in the folder. Exported so
// scripts/assemble-changelog.mjs applies the IDENTICAL predicate — one definition,
// so the guard and the assembler can never disagree about what counts as an entry.
export const ENTRY_RE = /^docs\/changelog\.d\/\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9._-]*\.md$/;

// Any ONE of these staged alongside satisfies the ledger requirement.
const LEDGER_RES = [
  /^docs\/CHANGELOG\.md$/,
  // One file per change (2026-08-25). docs/CHANGELOG.md is a single 15k-line file
  // that every parallel session appends to, so concurrent agent-surface work
  // collided there constantly - 12 of 13 open PRs touched one of the shared ledger
  // docs. A per-change entry file removes the contention by construction: two
  // sessions never write the same path.
  //
  // The DATED filename is ENFORCED, not merely documented (CodeRabbit, PR #482): a
  // bare `notes.md` would otherwise satisfy the guard, and because the assembler
  // sorts lexically in reverse it would splice in as the NEWEST block. The date
  // prefix also excludes README.md by construction, so the folder's own instructions
  // can never stand in for a recorded change.
  ENTRY_RE,
  /^docs\/manual\/[^/]+\.md$/,
  /^docs\/reference\/agent-guardrails\.md$/,
  /^docs\/reference\/migration-history\.md$/,
  /^docs\/loops\//,
];

// Pure classifier — exported for tests. Takes repo-relative staged paths
// (forward slashes) and returns { ok, triggers, reason? }.
// Windows paths arrive with backslashes; the separator is built via char code so no
// codegen or heredoc between here and disk can eat one of the escapes.
function toPosix(v) {
  return String(v ?? "").split(String.fromCharCode(92)).join("/");
}

// Accepts either plain paths ("docs/CHANGELOG.md") or {path, status} entries where
// status is a git name-status letter (A/M/D/R/C). A changelog.d fragment counts ONLY
// when it is ADDED: modifying or deleting an existing fragment alongside an
// agent-surface change would otherwise satisfy the guard while creating no new record
// (Codex P2, PR #482) — i.e. a session could edit someone else's entry instead of
// writing its own. A path supplied WITHOUT a status therefore cannot satisfy the
// changelog.d rule; that direction fails closed on purpose. The older ledger files are
// unaffected: appending to CHANGELOG.md or DECISION_LOG.md is a MODIFY by nature.
export function ledgerCheck(stagedFiles) {
  const entries = (stagedFiles || []).map((e) => {
    if (e && typeof e === "object") {
      return { path: toPosix(e.path), status: String(e.status ?? "").toUpperCase() };
    }
    return { path: toPosix(e), status: "" };
  });
  const files = entries.map((e) => e.path);
  const triggers = files.filter((f) => TRIGGER_RES.some((re) => re.test(f)));
  if (triggers.length === 0) return { ok: true, triggers: [] };

  const hasLedger = entries.some(({ path: p, status }) => {
    if (ENTRY_RE.test(p)) return status.startsWith("A");
    return LEDGER_RES.some((re) => re !== ENTRY_RE && re.test(p));
  });
  if (hasLedger) return { ok: true, triggers };

  // Distinguish "you touched an entry but did not ADD one" from "no ledger at all",
  // so the operator is not told to do something they just did.
  const touchedEntryNotAdded = entries.some(({ path: p, status }) => ENTRY_RE.test(p) && !status.startsWith("A"));
  return {
    ok: false,
    triggers,
    reason: touchedEntryNotAdded
      ? "This commit changes the agent surface but the only docs/changelog.d/ entry it stages is " +
        "MODIFIED or DELETED, not added. An entry file records ONE change: edit your own new file " +
        "rather than someone else's existing one, so this commit leaves its own written record."
      : "This commit changes the agent surface (commands / skills / hooks / workflows / settings / " +
        "shared contract / guard scripts) but stages NO ledger update. Every such change must be " +
        "recorded in the same commit so Mason and future agents can discover it.",
  };
}

// ── CLI (pre-commit entry point) ─────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  let staged;
  try {
    // --name-status, not --name-only: the classifier needs to know whether a
    // changelog.d entry was ADDED, because modifying an existing one records nothing
    // about this commit (Codex P2, PR #482). Rename/copy lines carry a score (R100)
    // and a second path; take the LAST field as the destination path.
    staged = execFileSync("git", ["diff", "--cached", "--name-status", "--diff-filter=ACMRD"], { encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("\t");
        const status = (parts[0] || "").trim();
        const p = parts[parts.length - 1];
        return { path: p, status };
      })
      .filter((e) => e.path);
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
  console.error("  • docs/changelog.d/<date>-<slug>.md   (PREFERRED — one file per change, no merge conflicts)");
  console.error("  • docs/CHANGELOG.md            (what changed, for shipped work)");
  console.error("  • docs/manual/DECISION_LOG.md  (a settled decision)");
  console.error("  • docs/manual/KNOWN_ISSUES.md  (a finding / parked item)");
  console.error("  • any other docs/manual/*.md, docs/reference/agent-guardrails.md, or a docs/loops/ ledger");
  console.error("");
  console.error("Do NOT write a throwaway line to satisfy the guard — record what actually changed and why.");
  console.error("Never use --no-verify to bypass this.");
  process.exit(1);
}
