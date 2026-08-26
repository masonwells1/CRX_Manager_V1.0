// changelog-entry-lib.mjs — the ONE definition of what a docs/changelog.d/ entry is.
//
// Shared by the pre-commit ledger guard (scripts/check-ledger-update.mjs), the
// session-wrap stop hook (.claude/hooks/stop-wrap.mjs), and the assembler
// (scripts/assemble-changelog.mjs, via the guard's re-export). It lives in
// .claude/hooks/ because that directory is the single source of truth for shared
// guard logic (AGENTS.md; CodeRabbit Major, PR #482) — the stop hook importing
// guard logic FROM scripts/ inverted that. One definition, so the guard, the stop
// hook, and any future consolidation tool can never disagree about what counts as
// an entry by re-expressing the predicate and drifting.

import { statSync } from "node:fs";

// The folder's own furniture, by exact name. This is an ALLOWLIST on purpose: the
// previous version excluded every dotfile, so `docs/changelog.d/.bad.md` was not even
// an attempted entry and slipped past the malformed-path refusal (Codex P2, PR #482).
// Enumerating what is legitimate closes that, where enumerating what is forbidden
// would have to be reopened for every new way of hiding a file.
export const FOLDER_META = new Set(["README.md", ".markdownlint.yaml", ".gitkeep"]);

// Anything a session drops in the folder is an ATTEMPTED entry, even when the
// filename is wrong. Kept separate from ENTRY_RE so a malformed path is still
// noticed rather than filtered out before it can be reported (Codex P2, PR #482).
export function isAttemptedEntry(p) {
  const prefix = "docs/changelog.d/";
  const s = String(p ?? "");
  if (!s.startsWith(prefix)) return false;
  const rest = s.slice(prefix.length);
  return rest.length > 0 && !FOLDER_META.has(rest);
}

// A changelog.d entry is `<YYYY-MM-DD>-<slug>.md`, flat in the folder. Month and day
// are range-checked in the pattern itself, so 2026-13-01 and 2026-01-32 never read as
// entries. A regex cannot express "February has 28 days", so the impossible-but-
// well-shaped dates are caught by isRealCalendarDate below (CodeRabbit, PR #482).
// Anything importing this gets the range check for free.
export const ENTRY_RE = /^docs\/changelog\.d\/\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])-[a-z0-9][a-z0-9._-]*\.md$/;

// 2026-02-31 has the right shape and does not exist. Round-tripping through Date is the
// cheapest honest check: JS normalises Feb 31 to Mar 3, so the fields stop matching.
export function isRealCalendarDate(iso) {
  const parts = String(iso ?? "").split("-");
  if (parts.length !== 3) return false;
  const [y, m, d] = parts.map(Number);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function normalizeBody(s) {
  return String(s ?? "").replace(/\r\n/g, "\n").trim();
}

// Returns true when this entry's CONTENT genuinely records a change, or a reason
// string explaining why it does not. The guard is the ONLY validator of these files,
// so "exists at the right path" is not enough (Codex P2, PR #482) — and the stop hook
// applies the SAME rules to the file that survives the session, so an entry that was
// valid when added but truncated or emptied later no longer counts (Codex P2, PR #482
// round 3: counted-without-validated, the same class as the quotePath fail-open).
export function entryContentVerdict(entryPath, content) {
  if (typeof content !== "string") return "has no readable staged content";
  const body = normalizeBody(content);
  if (!body) return "is empty, so it records nothing";
  const first = body.split("\n")[0] || "";
  // The heading must carry a real description, not just a date and punctuation. `\s*\S+`
  // used to accept "## 2026-08-26x" (no separator at all) and "## 2026-08-26 -" (a dash
  // with nothing after it), both of which violate the format the README promises (Codex
  // P2, PR #482). The separator class is deliberately wide: hyphen, en dash and em dash
  // are ALL accepted, because seven of the eight entries written under this convention
  // use an em dash. Narrowing to a literal "-" would have refused the folder's own
  // history, which is how a guard stops being trusted.
  const m = new RegExp("^##\\s+(\\d{4}-\\d{2}-\\d{2})\\s+[-\\u2013\\u2014]\\s+\\S").exec(first);
  if (!m) {
    const dated = /^##\s+\d{4}-\d{2}-\d{2}/.exec(first);
    if (!dated) return 'does not start with "## <YYYY-MM-DD> - <what changed>"';
    const rest = first.slice(dated[0].length);
    if (/^\s*$/.test(rest)) {
      return "has only a date heading and no description - a date is not a record of what changed";
    }
    if (new RegExp("^\\s*[-\\u2013\\u2014]\\s*$").test(rest)) {
      return "has a date and a dash but nothing after it - a separator is not a record of what changed";
    }
    return 'heading must read "## <YYYY-MM-DD> - <what changed>" - a dash (-, en or em) ' +
      "with a description after it";
  }
  const fileDate = (String(entryPath).split("/").pop() || "").slice(0, 10);
  if (m[1] !== fileDate) return `heading date ${m[1]} disagrees with the filename date ${fileDate}`;
  if (!isRealCalendarDate(fileDate)) {
    return `is dated ${fileDate}, which is not a real calendar date`;
  }
  // A heading with nothing beneath it records the title and none of the substance.
  if (body.split("\n").slice(1).join("").trim() === "") return "has a heading but no detail beneath it";
  return true;
}

// True only for a real FILE at absPath. `existsSync` alone accepted a DIRECTORY named
// like a fragment (CodeRabbit Minor, PR #482, reproduced by its static analysis), so a
// `mkdir docs/changelog.d/2026-08-26-x.md` would have satisfied an existence-only
// check. A stat failure and a content failure are different diagnoses, so callers
// check this FIRST and validate content second.
export function isCountableFragmentFile(absPath, statSyncFn = statSync) {
  try {
    return statSyncFn(absPath).isFile();
  } catch {
    return false;
  }
}
