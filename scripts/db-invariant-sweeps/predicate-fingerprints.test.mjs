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
import { classifySql, isKnownSweepPredicate } from "../../.claude/hooks/live-testdata-lib.mjs";
import {
  MANIFEST_PATH,
  PREDICATE_DIR,
  collectPredicates,
  fingerprint,
  normalizePredicateSql,
} from "./write-predicate-fingerprints.mjs";

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const eq = (a, b, m) => { assert.equal(a, b, m); pass++; };

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const onDisk = collectPredicates();

// 1. No drift, in EITHER direction.
const manifestNames = Object.keys(manifest.predicates).sort();
const diskNames = onDisk.map((p) => p.file);
assert.deepEqual(
  manifestNames,
  diskNames,
  "predicate-fingerprints.json does not list exactly the .sql files on disk — run node scripts/db-invariant-sweeps/write-predicate-fingerprints.mjs",
);
pass++;
for (const p of onDisk) {
  eq(
    manifest.predicates[p.file],
    p.sha256,
    `${p.file} does not match its recorded fingerprint — the SQL changed, so re-review it and regenerate the manifest`,
  );
}
ok(diskNames.length >= 29, `expected at least the 29 known predicates, found ${diskNames.length}`);

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

console.log(`predicate-fingerprints: ${pass} assertions passed (${diskNames.length} predicates)`);
