#!/usr/bin/env node
// Prints the authorised-fingerprint block that belongs INSIDE
// .claude/hooks/live-testdata-lib.mjs, computed from the predicate files on
// disk. It NEVER changes the guard — see "WHY THIS ONLY PRINTS" below. (The
// name predates that and is kept so existing references stay valid. It wrote a
// predicate-fingerprints.json beside these predicates until 2026-09-09; that
// file was deleted because a writable manifest outside the gated hook surface
// could be edited to authorise arbitrary SQL.)
//
// The live-data guard refuses every one of the 29 db-invariant-sweep
// predicates. 27 trip its function-call scan, which reads comment prose or an
// unlisted catalog function as a call — `-- predicate (f): overloads` becomes a
// call to `predicate()` in 8 of them, and words like `suite`, `expected` or
// `key` in the rest. The other 2 trip its audit-log write check. (This comment
// used to say all 29 were refused as `predicate()`; Codex, PR #648 round 7,
// counted.) PR #639 tried to fix the scan by teaching the guard to lex SQL —
// strings, comments, dollar-quoting, schema qualification. Six pinned
// gpt-5.6-sol rounds each found real defects, several introduced by the
// previous round's fix, and it was closed unmerged. A PreToolUse hook cannot
// see standard_conforming_strings, cannot resolve a search_path, and cannot
// know which schema a name binds to; it was guessing, and the guesses were the
// bugs.
//
// These 29 predicates are not unknown input. They are fixed, reviewed text in
// this repository. So the guard does not parse them — it recognises them, by a
// fingerprint of their normalised text (the normalisation is described below).
// That can only ever ADD permission for text we have already written and
// reviewed, so it cannot change how any other input is classified.
//
// Changing a predicate changes its fingerprint, so the guard stops recognising
// it until the block inside the guard is updated — and that update lands in the
// diff, where the changed SQL gets re-reviewed. That is the point of the
// design, not a wart.
//
// WHY THIS ONLY PRINTS (2026-09-10).
//
// Until this change the script rewrote the marked region of the guard itself.
// That quietly undid the reason the list moved into the guard. The permission
// config auto-allows `node scripts/...` commands, while edits to
// `.claude/hooks/**` sit in its `ask` tier — so a script that changes the hook
// file on its own is an allowed command doing a gated thing. Edit a predicate
// into destructive SQL, run this, and the guard recognises that SQL on the next
// execute_sql call with no prompt anywhere: the round-4 manifest bypass again,
// through a side door (Codex GitHub review on PR #648).
//
// So this script computes and prints, and whoever changes the list applies the
// printed block with an ordinary edit to the hook file — which is the step the
// hook-edit permission tier sees. predicate-fingerprints.test.mjs runs this
// script against a scratch copy of the tree on every path — current, stale and
// refused — and checks the scratch guard comes back byte-for-byte unchanged.
//
// Run: node scripts/db-invariant-sweeps/write-predicate-fingerprints.mjs
//   exit 0  the guard already matches the files
//   exit 1  it does not (the replacement block is printed to stdout), the
//           guard's markers are ambiguous, or the Set the guard exports
//           disagrees with its own marked block
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_SWEEP_PREDICATE_SHA256, normalizePredicateSql } from "../../.claude/hooks/live-testdata-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PREDICATE_DIR = path.join(HERE, "predicates");
// The hashes live INSIDE the guard, not in a manifest beside these predicates.
// A manifest under scripts/ is an ordinary writable file while `.claude/hooks/**`
// is an approval-gated enforcement surface, so the manifest version could be
// bypassed: hash a destructive statement, append it with an ordinary edit, call
// execute_sql (Codex, PR #648 round 4). Adding an allowance is therefore an edit
// to a hook file, made by whoever applies the block this script prints.
export const GUARD_PATH = path.resolve(HERE, "../../.claude/hooks/live-testdata-lib.mjs");
const BEGIN = ">>> BEGIN GENERATED PREDICATE FINGERPRINTS";
const END = "<<< END GENERATED PREDICATE FINGERPRINTS";
const BEGIN_LINE = `// ${BEGIN} — do not hand-edit`;
const END_LINE = `// ${END}`;

// The normalisation is IMPORTED from the guard, not restated here. Two copies
// could drift into hashing different bytes, and then the list would stop
// matching what the guard computes — the one failure this design cannot detect
// from the inside. It covers line endings, a UTF-8 BOM, and trailing whitespace
// at end of file: a checkout can change all three without a single SQL
// character differing, and a fingerprint that flipped on `core.autocrlf` would
// be useless on Windows.
export { normalizePredicateSql };

export function fingerprint(text) {
  return createHash("sha256").update(normalizePredicateSql(text), "utf8").digest("hex");
}

// A KEYWORD SHAPE CHECK WAS TRIED HERE AND DELIBERATELY REMOVED (2026-09-09).
//
// The idea was belt and braces: a fingerprint proves the bytes are the ones we
// reviewed, but not that those bytes are a read, so refuse to fingerprint a file
// whose text contains `INSERT INTO`, `TRUNCATE `, `REVOKE `, `CREATE TRIGGER`
// and so on. Run against the real predicates it rejected ELEVEN of the 29, and
// every single hit was a false positive — these predicates inspect privileges,
// so they legitimately say `TRUNCATE` inside a `has_table_privilege(...)`
// literal and discuss `REVOKE` in their header comments.
//
// Making it pass would mean skipping comments and string literals — which is a
// SQL lexer, which is exactly the thing PR #639 spent six adversarial review
// rounds failing to get right. A check that can only be satisfied by rebuilding
// the component we just deleted is worse than no check: it applies pressure to
// weaken itself until it goes quiet.
//
// What actually establishes these are reads: the text is pinned, so any change
// beyond line endings, a BOM or trailing whitespace shows up as a fingerprint
// change in a reviewed diff, and the sweep executes them read-only against live
// where their behaviour is observed. Both of those look at the real thing. A
// regex looking for scary words does not.
export function collectPredicates() {
  return fs
    .readdirSync(PREDICATE_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => {
      const text = fs.readFileSync(path.join(PREDICATE_DIR, file), "utf8");
      return { file, text, sha256: fingerprint(text) };
    });
}

// Renders the block that belongs between the two markers, and nothing else, so
// an update shows up in review as a list of hashes.
export function renderRegion(predicates) {
  // The printed block is JavaScript destined for the guard, so every value it
  // interpolates is validated first. A filename is attacker-influenced input on
  // any filesystem that permits newlines: `x\n  "<hash>", // y.sql` would close
  // the trailing comment and inject a line into the authorised Set — code
  // injection straight into the enforcement surface that round 4 just moved
  // these hashes into. Windows forbids newlines in names, which is exactly the
  // kind of accident-of-platform that should not be load-bearing.
  //
  // Each value is converted to a string ONCE, and that one string is both
  // validated and printed. Validating one conversion and printing another let a
  // value whose toString changes between calls slip past the check (Codex, PR
  // #648 round 7). collectPredicates() hands over plain strings, so that was not
  // reachable from the command line, but this function is exported.
  const seen = new Map();
  const lines = predicates.map((p) => {
    const file = String(p.file);
    const sha256 = String(p.sha256);
    if (!/^[A-Za-z0-9._-]+$/.test(file)) {
      throw new Error(`refusing to embed an unexpected predicate filename in the guard: ${JSON.stringify(file)}`);
    }
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`refusing to embed a malformed fingerprint for ${file}: ${JSON.stringify(sha256)}`);
    }
    // Two files with one fingerprint become ONE entry in the Set, so the block
    // could never match the files and the suite would fail once it was applied.
    // Ordinary work reaches this: a new predicate that differs from an existing
    // one only in line endings or trailing whitespace. Refuse before printing
    // (Codex, PR #648 round 7).
    if (seen.has(sha256)) {
      throw new Error(`refusing to embed a duplicate fingerprint: ${file} and ${seen.get(sha256)} normalise to the same text`);
    }
    seen.set(sha256, file);
    return `  "${sha256}", // ${file}`;
  });
  return [
    BEGIN_LINE,
    "export const KNOWN_SWEEP_PREDICATE_SHA256 = new Set([",
    ...lines,
    "]);",
    END_LINE,
  ].join("\n");
}

// Pure: compares the guard's text with what the files produce. Reads nothing
// and changes nothing, so the suite can drive every outcome without touching
// the real guard.
//
// EXACTLY ONE marker of each kind, in order, or the answer is "ambiguous".
// Taking the first occurrence of each was destructive back when this script
// rewrote the region: a stray duplicate begin marker made a regeneration delete
// everything between it and the real end marker, including unrelated guard
// code (Codex, PR #648 round 6). Nothing is rewritten now, but an ambiguous
// file is still a refusal, never a guess about which list the guard uses.
//
// A marker is a whole LINE. Every line that merely contains a marker phrase
// counts toward "exactly one", and the one found must be the canonical line
// exactly — so a near miss like `...FINGERPRINTSX` is refused rather than taken
// as the marker. Line endings are folded to LF first, lone CR included, the
// same set the predicate normaliser folds (Codex, PR #648 round 7).
//
// The text comparison covers the marked block only, and code after the block
// could still change the Set when the module loads. So when the caller passes
// the Set the guard actually exports, a matching block with a different
// runtime Set is "overridden", never "current" (Codex, PR #648 round 7).
export function planRegeneration(guardText, predicates, loadedSet) {
  const lines = String(guardText).replace(/\r\n?/g, "\n").split("\n");
  const at = (phrase) => lines.flatMap((line, i) => (line.includes(phrase) ? [i] : []));
  const beginAt = at(BEGIN);
  const endAt = at(END);
  const begins = beginAt.length;
  const ends = endAt.length;
  if (
    begins !== 1 ||
    ends !== 1 ||
    lines[beginAt[0]] !== BEGIN_LINE ||
    lines[endAt[0]] !== END_LINE ||
    endAt[0] < beginAt[0]
  ) {
    return { status: "ambiguous", begins, ends };
  }
  const region = renderRegion(predicates);
  const current = lines.slice(beginAt[0], endAt[0] + 1).join("\n");
  if (current !== region) return { status: "stale", region };
  if (loadedSet) {
    const want = predicates.map((p) => String(p.sha256)).sort();
    const got = [...loadedSet].sort();
    if (want.length !== got.length || want.some((h, i) => h !== got[i])) {
      return { status: "overridden", region };
    }
  }
  return { status: "current", region };
}

function main() {
  const predicates = collectPredicates();
  const rel = path.relative(process.cwd(), GUARD_PATH);
  const plan = planRegeneration(fs.readFileSync(GUARD_PATH, "utf8"), predicates, KNOWN_SWEEP_PREDICATE_SHA256);
  if (plan.status === "ambiguous") {
    console.error(`Refusing: ${rel} must contain exactly one well-formed marker line of each kind, in order; found ${plan.begins} begin and ${plan.ends} end.`);
    console.error("Restore a single well-formed marker pair; this script will not guess which list the guard uses.");
    process.exit(1);
  }
  if (plan.status === "overridden") {
    console.error(`Refusing: the marked block in ${rel} matches the files, but the Set the guard exports does not.`);
    console.error("Code outside the markers changes the list when the guard loads. Remove it; this script will not.");
    process.exit(1);
  }
  if (plan.status === "current") {
    console.log(`${predicates.length} fingerprints already current in ${rel}`);
    return;
  }
  console.error(`The fingerprint list in ${rel} does not match the ${predicates.length} predicate files.`);
  console.error("This script does not change the guard. Review the changed SQL first, then replace everything");
  console.error("from the BEGIN marker line through the END marker line in the guard with the block below,");
  console.error("using an ordinary edit to that file:");
  console.error("");
  console.log(plan.region);
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
