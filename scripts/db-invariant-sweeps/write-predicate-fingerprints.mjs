#!/usr/bin/env node
// Regenerates predicate-fingerprints.json from the predicate files on disk.
//
// The live-data guard refuses every one of the 29 db-invariant-sweep predicates,
// because each opens with prose like `-- predicate (f): overloads` and the
// guard's function-call scan reads that as a call to a function named
// `predicate`. PR #639 tried to fix this by teaching the guard to lex SQL —
// strings, comments, dollar-quoting, schema qualification. Six pinned
// gpt-5.6-sol rounds each found real defects, several introduced by the
// previous round's fix, and it was closed unmerged. A PreToolUse hook cannot
// see standard_conforming_strings, cannot resolve a search_path, and cannot
// know which schema a name binds to; it was guessing, and the guesses were the
// bugs.
//
// These 29 predicates are not unknown input. They are fixed, reviewed text in
// this repository. So the guard does not parse them — it recognises them, by
// exact content fingerprint. That can only ever ADD permission for bytes we
// have already written and reviewed, so it cannot change how any other input is
// classified.
//
// Changing a predicate changes its fingerprint, so the guard stops recognising
// it until this file is regenerated — and that regeneration lands in the diff,
// where the changed SQL gets re-reviewed. That is the point of the design, not
// a wart.
//
// Run: node scripts/db-invariant-sweeps/write-predicate-fingerprints.mjs
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePredicateSql } from "../../.claude/hooks/live-testdata-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PREDICATE_DIR = path.join(HERE, "predicates");
// The hashes live INSIDE the guard, not in a manifest beside these predicates.
// A manifest under scripts/ is an ordinary writable file while `.claude/hooks/**`
// is an approval-gated enforcement surface, so the manifest version could be
// bypassed: hash a destructive statement, append it with an ordinary edit, call
// execute_sql (Codex, PR #648 round 4). This script therefore rewrites a marked
// region of the guard, and adding an allowance is an edit to a hook file.
export const GUARD_PATH = path.resolve(HERE, "../../.claude/hooks/live-testdata-lib.mjs");
const BEGIN = ">>> BEGIN GENERATED PREDICATE FINGERPRINTS";
const END = "<<< END GENERATED PREDICATE FINGERPRINTS";

// The normalisation is IMPORTED from the guard, not restated here. Two copies
// could drift into hashing different bytes, and then the manifest would stop
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
// What actually establishes these are reads: the bytes are pinned, so any
// change shows up as a fingerprint change in a reviewed diff, and the sweep
// executes them read-only against live where their behaviour is observed. Both
// of those look at the real thing. A regex looking for scary words does not.
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

// Rewrites ONLY the region between the two markers. Everything else in the
// guard is left byte-for-byte alone, so a regeneration shows up in review as a
// list of hashes and nothing else.
export function renderRegion(predicates) {
  const lines = predicates.map((p) => `  "${p.sha256}", // ${p.file}`);
  return [
    `// ${BEGIN} — do not hand-edit`,
    "export const KNOWN_SWEEP_PREDICATE_SHA256 = new Set([",
    ...lines,
    "]);",
    `// ${END}`,
  ].join("\n");
}

function main() {
  const predicates = collectPredicates();
  const guard = fs.readFileSync(GUARD_PATH, "utf8");
  const start = guard.indexOf(`// ${BEGIN}`);
  const endMarker = `// ${END}`;
  const end = guard.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    console.error(`Could not find the generated region in ${GUARD_PATH}.`);
    console.error("Restore the two marker comments before regenerating; this script will not guess.");
    process.exit(1);
  }
  // Emit the region with whatever line ending the file already uses, so a
  // regeneration on a CRLF checkout does not rewrite the file's convention and
  // show up as a whole-file diff.
  const eol = guard.includes("\r\n") ? "\r\n" : "\n";
  const region = renderRegion(predicates).replace(/\n/g, eol);
  const next = guard.slice(0, start) + region + guard.slice(end + endMarker.length);
  if (next === guard) {
    console.log(`${predicates.length} fingerprints already current in ${path.relative(process.cwd(), GUARD_PATH)}`);
    return;
  }
  fs.writeFileSync(GUARD_PATH, next, "utf8");
  console.log(`Wrote ${predicates.length} fingerprints into ${path.relative(process.cwd(), GUARD_PATH)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
