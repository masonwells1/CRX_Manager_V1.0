#!/usr/bin/env node
// Proves the predicate fingerprint allowance is honest.
//
// The allowance is only as good as the manifest matching the files, so that is
// the first and most important assertion here: if anyone edits a predicate
// without regenerating, this fails, and the guard has already stopped
// recognising that file anyway.
//
// Run: node scripts/db-invariant-sweeps/predicate-fingerprints.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  KNOWN_SWEEP_PREDICATE_SHA256,
  classifySql,
  isKnownSweepPredicate,
} from "../../.claude/hooks/live-testdata-lib.mjs";
import {
  GUARD_PATH,
  PREDICATE_DIR,
  collectPredicates,
  fingerprint,
  normalizePredicateSql,
  renderRegion,
} from "./write-predicate-fingerprints.mjs";

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const eq = (a, b, m) => { assert.equal(a, b, m); pass++; };

const onDisk = collectPredicates();
const diskNames = onDisk.map((p) => p.file);

// 1. No drift, in EITHER direction. The authorised hashes live INSIDE the guard
//    (an approval-gated enforcement surface) rather than in a writable manifest
//    beside the predicates — the manifest version could be bypassed by hashing a
//    destructive statement and appending it with an ordinary edit (Codex, PR
//    #648 round 4). So this compares the files on disk against the guard's own
//    embedded set, and against the exact text the generator would emit.
assert.deepEqual(
  [...KNOWN_SWEEP_PREDICATE_SHA256].sort(),
  onDisk.map((p) => p.sha256).sort(),
  "the guard's embedded fingerprints are not exactly the hashes of the .sql files on disk — run node scripts/db-invariant-sweeps/write-predicate-fingerprints.mjs",
);
pass++;
eq(
  KNOWN_SWEEP_PREDICATE_SHA256.size,
  onDisk.length,
  "the guard authorises exactly as many hashes as there are predicate files — no stale or extra entry",
);
for (const p of onDisk) {
  ok(
    KNOWN_SWEEP_PREDICATE_SHA256.has(p.sha256),
    `${p.file} does not match its recorded fingerprint — the SQL changed, so re-review it and regenerate`,
  );
}
// The generated region must be exactly what the generator produces from the
// current files, so a hand-edited hash inside the guard fails here too.
{
  // Line-ending agnostic, and a substring check — NOT byte-identity. Saying
  // "byte-identical" was wrong: this normalises CRLF and looks for containment
  // (Codex, PR #648 round 6). The load-bearing assertion is the deepEqual above,
  // which compares the guard's LIVE exported Set against the files on disk; this
  // one additionally catches a hand-edited region that happens to agree.
  const lf = (s) => s.replace(/\r\n?/g, "\n");
  const guard = lf(fs.readFileSync(GUARD_PATH, "utf8"));
  ok(
    guard.includes(lf(renderRegion(onDisk))),
    "the generated region in the guard is not what the generator emits — do not hand-edit it; run node scripts/db-invariant-sweeps/write-predicate-fingerprints.mjs",
  );
  // Exactly one marker pair. Two begin markers made a regeneration delete every
  // line between the stray one and the real end marker, taking unrelated guard
  // code with it.
  eq(guard.split("// >>> BEGIN GENERATED PREDICATE FINGERPRINTS").length - 1, 1, "the guard has exactly one begin marker");
  eq(guard.split("// <<< END GENERATED PREDICATE FINGERPRINTS").length - 1, 1, "the guard has exactly one end marker");
}
// PINNED, not a floor. A floor lets a reviewed predicate be deleted from BOTH
// the directory and the manifest without any assertion noticing, once the suite
// grows past it (Codex, PR #648 round 1). Adding or removing a predicate is a
// deliberate act, so it updates this number in the same diff.
eq(diskNames.length, 29, `expected exactly 29 predicates, found ${diskNames.length} — update this number deliberately`);

// 2. Every predicate file is recognised, and therefore allowed. This is the
//    behaviour the whole change exists to produce: before it, all 29 were
//    refused by findNonReadFunctionCall reading their header prose as a call.
for (const p of onDisk) {
  ok(isKnownSweepPredicate(p.text), `${p.file} is recognised by fingerprint`);
  eq(classifySql(p.text).block, false, `${p.file} clears the live-data guard`);
  eq(classifySql(p.text).kind, "known-sweep-predicate", `${p.file} is allowed BY FINGERPRINT, not by accident`);
}

// 3. The allowance is byte-exact. One changed character is a different file.
{
  const p = onDisk[0];
  ok(!isKnownSweepPredicate(`${p.text}\nDELETE FROM customers;`), "appending a DELETE breaks the fingerprint");
  ok(classifySql(`${p.text}\nDELETE FROM customers;`).block, "...and the appended DELETE is then blocked normally");
  ok(!isKnownSweepPredicate(p.text.replace("SELECT", "SELECT ")), "a single inserted space breaks the fingerprint");
  ok(!isKnownSweepPredicate(p.text.replace(/./, "x")), "a single changed character breaks the fingerprint");
}

// 4. Normalisation covers only line endings, BOM and trailing whitespace —
//    the three things a checkout can change without changing any SQL.
{
  const p = onDisk[0];
  // Build the variants from the NORMALISED form: the working copy may already
  // be CRLF (git's autocrlf on Windows), and this must pass either way.
  const lf = normalizePredicateSql(p.text);
  ok(isKnownSweepPredicate(lf), "an LF checkout is recognised");
  ok(isKnownSweepPredicate(lf.replace(/\n/g, "\r\n")), "a CRLF checkout is recognised");
  ok(isKnownSweepPredicate(lf.replace(/\n/g, "\r")), "a lone-CR checkout is recognised");
  ok(isKnownSweepPredicate(`﻿${lf}`), "a UTF-8 BOM is recognised");
  ok(isKnownSweepPredicate(`${lf}\n\n  `), "trailing whitespace is recognised");
  // ...and nothing else. Two predicates must never collapse onto one hash.
  const hashes = new Set(onDisk.map((x) => x.sha256));
  eq(hashes.size, onDisk.length, "every predicate has a distinct fingerprint");
  ok(!isKnownSweepPredicate(p.text.toUpperCase()), "case is NOT normalised away");
  ok(!isKnownSweepPredicate(p.text.replace(/\s+/g, " ")), "internal whitespace is NOT normalised away");
}

// 5. The recognition path must not have become a general allowance. Everything
//    the guard blocked before it must still block.
ok(classifySql("DELETE FROM customers WHERE id = 5").block, "a hand-written DELETE is still blocked");
ok(classifySql("UPDATE invoices SET total_cents = 0").block, "a hand-written money UPDATE is still blocked");
ok(classifySql("TRUNCATE customers").block, "TRUNCATE is still blocked");
ok(classifySql("GRANT EXECUTE ON FUNCTION public.f() TO anon;").block, "GRANT is still blocked");
ok(classifySql("SELECT save_customer('{}'::jsonb)").block, "an unknown app function is still blocked");
ok(classifySql("INSERT INTO financial_audit_log (x) VALUES (1)").block, "the audit log is still blocked");
eq(isKnownSweepPredicate(""), false, "empty input is not recognised");
eq(isKnownSweepPredicate(null), false, "null input is not recognised");

// 6. A predicate that is NOT in the manifest gets no allowance, even sitting in
//    the same directory shape.
ok(
  !isKnownSweepPredicate("-- predicate (z): not a real one\nSELECT 1;"),
  "an unlisted predicate-shaped file is not recognised",
);
ok(fingerprint("a") !== fingerprint("b"), "sanity: the fingerprint distinguishes inputs");
eq(normalizePredicateSql("x\r\n"), "x", "sanity: normalisation strips CRLF and trailing whitespace");

// 7. The directory the guard reads is the directory the generator writes.
ok(fs.existsSync(path.join(PREDICATE_DIR, diskNames[0])), "generator and guard agree on the predicate directory");

// 8. Normalisation must be LINEAR. Every input reaching the guard now passes
//    through it before the classifier, so a super-linear normaliser is a denial
//    of service on the hook itself, not merely slow. `/\s+$/` backtracked here:
//    80,000 leading spaces cost 1.06 s and quadrupled per doubling (Codex, PR
//    #648 round 1). Timing is machine-dependent, so this asserts ONLY the
//    SHAPE — quadrupling the input must not quadruple the time.
//
//    There was also a `large < 250` wall-clock assertion here. It is gone: a
//    fixed millisecond threshold fails on a loaded CI worker for reasons that
//    have nothing to do with this code, and the prose describing this test
//    claimed it avoided exactly that while the line sat right below (Codex, PR
//    #648 round 2 — the claim was wrong, so the claim's subject was removed
//    rather than the sentence reworded).
//
//    Each measurement takes the MINIMUM of several runs rather than the total.
//    A scheduling pause can only ever make a run look slower, so the minimum is
//    the reading least corrupted by noise — which matters in both directions
//    here, since an inflated `small` would let a genuinely quadratic
//    implementation pass the ratio.
{
  const time = (n) => {
    const q = " ".repeat(n) + "x";
    let best = Infinity;
    for (let run = 0; run < 7; run++) {
      const t = process.hrtime.bigint();
      isKnownSweepPredicate(q);
      best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6);
    }
    return best;
  };
  time(20000); // warm up, discard
  const small = time(20000);
  const large = time(80000);
  // 4x the input. Linear is ~4x the time, quadratic ~16x. 8x is comfortably
  // clear of both, and the old `/\s+$/` measured ~16x here.
  ok(
    large < Math.max(small, 0.01) * 8,
    `normalisation must stay near-linear: 20k took ${small.toFixed(3)}ms, 80k took ${large.toFixed(3)}ms (quadratic would be ~16x)`,
  );
}

// 9. Trailing whitespace: ASCII only, and that boundary is the point.
//
//    The trim was `trimEnd()`, which also strips NBSP, U+2028, ideographic
//    space and friends. No checkout introduces those, and PostgreSQL does not
//    treat them as whitespace either — so `SELECT 1;` plus a trailing NBSP
//    shared a fingerprint with `SELECT 1;` while being a syntax error to the
//    server. Harmless in practice, but it made the stated rule ("only what a
//    checkout can change") untrue, so the rule is now what it says (Codex, PR
//    #648 round 6).
//
//    Every character below is built from its CODE POINT. Not a literal byte and
//    not a `\uXXXX` escape — twice this block was written with literal control
//    characters while its own comment claimed otherwise, and an escape is only
//    as reliable as whatever wrote the file. A number cannot be mangled in
//    transit. Section 11 asserts the file really contains no NUL.
{
  const lf = normalizePredicateSql(onDisk[0].text);
  const ch = (code) => String.fromCodePoint(code);
  const NUL = ch(0x00);
  // What a checkout can change — stripped.
  for (const [name, ws] of [
    ["space", ch(0x20)],
    ["tab", ch(0x09)],
    ["newline", ch(0x0a)],
    ["carriage return", ch(0x0d)],
    ["form feed", ch(0x0c)],
    ["vertical tab", ch(0x0b)],
  ]) {
    ok(isKnownSweepPredicate(`${lf}${ws}`), `trailing ${name} is normalised away`);
  }
  ok(isKnownSweepPredicate(`${lf}${ch(0x20)}${ch(0x09)}${ch(0x0a)}${ch(0x20)}`), "a mixed ASCII whitespace tail is normalised away");
  // What it cannot — NOT stripped, because PostgreSQL does not accept these as
  // whitespace and a fingerprint must not span a parse difference.
  for (const [name, ws] of [
    ["NBSP U+00A0", ch(0x00a0)],
    ["ogham space mark U+1680", ch(0x1680)],
    ["en quad U+2000", ch(0x2000)],
    ["line separator U+2028", ch(0x2028)],
    ["paragraph separator U+2029", ch(0x2029)],
    ["narrow no-break space U+202F", ch(0x202f)],
    ["ideographic space U+3000", ch(0x3000)],
    ["zero width no-break space U+FEFF", ch(0xfeff)],
  ]) {
    ok(!isKnownSweepPredicate(`${lf}${ws}`), `trailing ${name} is NOT normalised away`);
    // ...and this is a deliberate divergence from trimEnd(), which would.
    ok(`x${ws}`.trimEnd() === "x", `sanity: trimEnd would have stripped ${name}`);
  }
  ok(!isKnownSweepPredicate(`${lf.slice(0, 5)}${ch(0x00a0)}${lf.slice(5)}`), "an NBSP in the MIDDLE is a different predicate");
  ok(!isKnownSweepPredicate(`${ch(0x00a0)}${lf}`), "a LEADING NBSP is a different predicate");
  ok(!isKnownSweepPredicate(`${lf}${NUL}`), "a trailing NUL is not whitespace and is not recognised");
  ok(!isKnownSweepPredicate(`${lf}${NUL}   `), "a NUL hidden before trailing spaces is not trimmed away");
}

// 9b. The generator writes JavaScript INTO the guard, so it must refuse to
//     interpolate anything it has not validated. A predicate filename is
//     attacker-influenced on any filesystem that permits newlines, and
//     `x\n  "<hash>", // y.sql` would close the trailing comment and inject a
//     line straight into the authorised Set. Windows forbidding newlines in
//     filenames is an accident of platform, not a control.
for (const bad of [
  'evil\n  "0000000000000000000000000000000000000000000000000000000000000000", // x.sql',
  "evil.sql\r// x",
  "../escape.sql",
  "quote\".sql",
  "back`tick.sql",
  "dollar${x}.sql",
]) {
  assert.throws(
    () => renderRegion([{ file: bad, sha256: "a".repeat(64) }]),
    /refusing to embed an unexpected predicate filename/,
    `the generator refuses the filename ${JSON.stringify(bad)}`,
  );
  pass++;
}
assert.throws(
  () => renderRegion([{ file: "ok.sql", sha256: "nope" }]),
  /refusing to embed a malformed fingerprint/,
  "the generator refuses a malformed fingerprint",
);
pass++;
// ...and still accepts every real one.
ok(renderRegion(onDisk).includes(onDisk[0].sha256), "the generator accepts the real predicate filenames");

// 10. The generator hashes what the guard hashes. They import ONE normaliser
//     now; this pins that they cannot silently diverge, which is the single
//     failure this design cannot detect from the inside.
for (const p of onDisk.slice(0, 3)) {
  eq(fingerprint(p.text), fingerprint(normalizePredicateSql(p.text)), `${p.file}: hashing is normalisation-stable`);
}

// 11. THIS FILE must stay reviewable in a diff.
//
//     The control this whole change rests on is that a predicate cannot move
//     without the manifest moving, and a person then reads the combined diff.
//     A test file containing a NUL byte is classified binary by git, which
//     renders zero additions and no patch — so the test enforcing that control
//     becomes unreadable in exactly the place it needs to be read. It happened
//     twice on PR #648: once inside git's 8,000-byte sniff window (the file went
//     binary) and once past it (the file rendered by luck). Both are the same
//     defect; only one was visible. This asserts the property directly.
{
  const selfPath = fileURLToPath(import.meta.url);
  const bytes = fs.readFileSync(selfPath);
  eq(bytes.indexOf(0), -1, "this test file must contain no NUL byte — write control characters as \\uXXXX escapes");
  // EVERY predicate, not just the first. Checking one left the hole open: a NUL
  // inside a leading comment of any other predicate would let git render that
  // SQL as binary, so the reviewer sees a hash change with no readable diff —
  // defeating the "review the changed SQL and its hash together" control that
  // this whole design rests on (Codex, PR #648 round 6).
  eq(fs.readFileSync(GUARD_PATH).indexOf(0), -1, "the guard must contain no NUL byte");
  for (const name of diskNames) {
    eq(fs.readFileSync(path.join(PREDICATE_DIR, name)).indexOf(0), -1, `${name} must contain no NUL byte`);
  }
}

console.log(`predicate-fingerprints: ${pass} assertions passed (${diskNames.length} predicates)`);
