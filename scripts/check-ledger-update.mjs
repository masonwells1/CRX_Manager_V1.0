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
// Anything a session drops in the folder is an ATTEMPTED entry, even when the filename is
// wrong. Kept separate from ENTRY_RE so a malformed path is still noticed rather than
// filtered out before it can be reported (Codex P2, PR #482).
export function isAttemptedEntry(p) {
  const prefix = "docs/changelog.d/";
  const s = String(p ?? "");
  if (!s.startsWith(prefix)) return false;
  const rest = s.slice(prefix.length);
  return rest.length > 0 && rest !== "README.md" && !rest.startsWith(".");
}

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
const NEWLINE = String.fromCharCode(10);

function normalizeBody(s) {
  return String(s ?? "").replace(/\r\n/g, "\n").trim();
}

// Returns true if this changelog.d entry genuinely records THIS commit's change, or a
// reason string explaining why it does not. The guard is the ONLY validator of these
// files, so "exists at the right path" is not enough (Codex P2, PR #482).
function entryVerdict(e, removedBodies) {
  if (!e.status.startsWith("A")) return "is not ADDED by this commit";
  if (typeof e.content !== "string") return "has no readable staged content";
  const body = normalizeBody(e.content);
  if (!body) return "is empty, so it records nothing";
  const first = body.split("\n")[0] || "";
  // The heading must carry a real description, not just a date and punctuation. `\s*\S+`
  // used to accept "## 2026-08-26x" (no separator at all) and "## 2026-08-26 -" (a dash
  // with nothing after it), both of which violate the format the README promises (Codex
  // P2, PR #482). The separator class is deliberately wide: hyphen, en dash and em dash
  // are ALL accepted, because seven of the eight entries written under this convention
  // use an em dash. Narrowing to a literal "-" would have refused the folder's own
  // history, which is how a guard stops being trusted.
  const m = /^##\s+(\d{4}-\d{2}-\d{2})\s+[-\u2013\u2014]\s+\S/.exec(first);
  if (!m) {
    const dated = /^##\s+\d{4}-\d{2}-\d{2}/.exec(first);
    if (!dated) return 'does not start with "## <YYYY-MM-DD> - <what changed>"';
    const rest = first.slice(dated[0].length);
    if (/^\s*$/.test(rest)) {
      return "has only a date heading and no description - a date is not a record of what changed";
    }
    if (/^\s*[-\u2013\u2014]\s*$/.test(rest)) {
      return "has a date and a dash but nothing after it - a separator is not a record of what changed";
    }
    return 'heading must read "## <YYYY-MM-DD> - <what changed>" - a dash (-, en or em) ' +
      "with a description after it";
  }
  const fileDate = (e.path.split("/").pop() || "").slice(0, 10);
  if (m[1] !== fileDate) return `heading date ${m[1]} disagrees with the filename date ${fileDate}`;
  // A heading with nothing beneath it records the title and none of the substance.
  if (body.split("\n").slice(1).join("").trim() === "") return "has a heading but no detail beneath it";
  // A pure rename arrives as D(old) + A(new) under --no-renames. Counting the added
  // half would let a commit satisfy the guard by MOVING someone else's record while
  // writing none of its own. Byte-identical content is what makes that detectable.
  if (e.renamedFrom) {
    return `is a rename of ${e.renamedFrom} — moving an existing record is not writing your own`;
  }
  if (removedBodies.has(body)) {
    return "is byte-identical to an entry this same commit deletes — renaming an existing " +
      "record is not writing your own";
  }
  return true;
}

export function ledgerCheck(stagedFiles) {
  const entries = (stagedFiles || []).map((e) => {
    if (e && typeof e === "object") {
      return {
        path: toPosix(e.path),
        status: String(e.status ?? "").toUpperCase(),
        content: e.content,
        renamedFrom: e.renamedFrom,
      };
    }
    return { path: toPosix(e), status: "", content: undefined, renamedFrom: undefined };
  });
  const files = entries.map((e) => e.path);
  const triggers = files.filter((f) => TRIGGER_RES.some((re) => re.test(f)));

  const removedBodies = new Set(
    entries
      .filter((e) => ENTRY_RE.test(e.path) && e.status.startsWith("D") && typeof e.content === "string")
      .map((e) => normalizeBody(e.content)));

  const entryVerdicts = entries
    .filter((e) => ENTRY_RE.test(e.path))
    .map((e) => [e.path, entryVerdict(e, removedBodies)]);

  // A malformed ADDED entry is refused no matter what else the commit stages. This runs
  // AHEAD of the trigger branch on purpose: when it lived inside `triggers.length === 0`,
  // a commit that touched the agent surface AND updated a legacy ledger file satisfied
  // hasLedger and carried an unreadable fragment in with it, contradicting the contract
  // the README states (CodeRabbit Major, PR #482). A src-only commit must not be able to
  // drop an empty or misnamed entry into the folder either (Codex P2, same PR).
  // Only a MALFORMED ADDED entry blocks here; a commit staging no entry at all is
  // unaffected, as is one that merely touches an existing entry without claiming it.
  const badPaths = entries
    .filter((e) => e.status.startsWith("A") && isAttemptedEntry(e.path) && !ENTRY_RE.test(e.path))
    .map((e) => [e.path, "is not named <YYYY-MM-DD>-<slug>.md, so nothing will ever read it as an entry"]);
  const badAdds = entryVerdicts
    .filter(([p, v]) => v !== true && entries.some((e) => e.path === p && e.status.startsWith("A")))
    .concat(badPaths);
  if (badAdds.length > 0) {
    return {
      ok: false,
      triggers,
      reason: "This commit adds docs/changelog.d/ entries that do not record anything:" + NEWLINE +
        badAdds.map(([p, why]) => "  - " + p + " " + why).join(NEWLINE) + NEWLINE +
        "Fix the entry rather than leaving an unreadable record in the folder.",
    };
  }
  if (triggers.length === 0) return { ok: true, triggers: [] };

  const hasLedger =
    entryVerdicts.some(([, v]) => v === true) ||
    entries.some((e) => !ENTRY_RE.test(e.path) && LEDGER_RES.some((re) => re !== ENTRY_RE && re.test(e.path)));
  if (hasLedger) return { ok: true, triggers };

  // Say exactly why a staged entry did not count, so nobody is told to do the thing
  // they just did.
  const rejected = entryVerdicts.filter(([, v]) => v !== true);
  return {
    ok: false,
    triggers,
    reason: rejected.length
      ? "This commit changes the agent surface, and it stages docs/changelog.d/ entries, but " +
        "none of them records THIS change:\n" +
        rejected.map(([p, why]) => `  • ${p} ${why}`).join("\n") +
        "\nAn entry records ONE change: add your own new dated file rather than editing, " +
        "renaming, or emptying someone else's."
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
    // about this commit (Codex P2, PR #482).
    //
    // --no-renames and the T (type-change) filter come from origin/main and are kept:
    // --no-renames splits a rename into a separate D and A, which is what we want here
    // — the added half is a genuine new entry and should count, while an R line would
    // have needed two-path parsing. The last-field read below stays as a defensive
    // measure in case --no-renames is ever dropped.
    // A SECOND pass WITH rename detection. --no-renames above is what makes an added
    // half visible at all, but comparing bodies only catches a byte-identical move:
    // rename an entry and edit one character and the content test passes. Git still
    // reports it as R<score>, so ask git directly rather than inferring from content
    // (Codex P2, PR #482).
    const renameSources = new Map();
    try {
      const out = execFileSync("git", ["diff", "--cached", "-M", "--name-status", "--diff-filter=R"], { encoding: "utf8" });
      for (const line of out.split(NEWLINE)) {
        const parts = line.split("	");
        if (parts.length >= 3 && parts[0].startsWith("R")) renameSources.set(parts[2], parts[1]);
      }
    } catch { /* rename detection unavailable — fall back to the content comparison */ }

    staged = execFileSync("git", ["diff", "--cached", "--no-renames", "--name-status", "--diff-filter=ACMRTD"], { encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("\t");
        const status = (parts[0] || "").trim();
        const p = parts[parts.length - 1];
        const entry = { path: p, status, renamedFrom: renameSources.get(p) };
        // The classifier validates entry CONTENT, so read the blob here: staged for an
        // addition, HEAD for a deletion (a rename's deleted half is what proves the
        // added half is only a move). Unreadable content is left undefined, which the
        // classifier treats as "cannot verify" and therefore does not accept.
        if (ENTRY_RE.test(p)) {
          const ref = status.startsWith("D") ? `HEAD:${p}` : `:${p}`;
          try {
            entry.content = execFileSync("git", ["show", ref], { encoding: "utf8" });
          } catch { /* leave undefined */ }
        }
        return entry;
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
