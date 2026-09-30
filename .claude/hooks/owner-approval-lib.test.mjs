#!/usr/bin/env node
// Mutation tests for Mason's Windows Hello owner approval (owner-approval-lib.mjs).
//
// A software RSA key stands in for the Windows Hello key: the verifier only ever
// sees a public key and a signature, and Windows Hello signs RSASSA-PKCS1-v1_5
// SHA-256 exactly as node's crypto.sign does here (setup proves that on the real
// key with its self-test). Every case starts from an approval that VERIFIES,
// breaks one thing, and asserts the specific refusal.
//
// Run: node .claude/hooks/owner-approval-lib.test.mjs

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OWNER_APPROVAL_MAX_AGE_MS,
  OWNER_KEY_NAME,
  buildApprovalPayload,
  buildSelfTestPayload,
  findOwnerApprovals,
  ownerApprovalSummary,
  parkedCategories,
  readPinnedOwnerKey,
  readUsedNonces,
  recordUsedApproval,
  signatureValid,
  verifyOwnerApproval,
} from "./owner-approval-lib.mjs";

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const refuses = (verdict, fragment, m) => {
  assert.equal(verdict.ok, false, `${m} — expected a refusal`);
  assert.ok(String(verdict.reason).includes(fragment), `${m} — reason did not mention ${JSON.stringify(fragment)}: ${verdict.reason}`);
  pass++;
};

const mason = generateKeyPairSync("rsa", { modulusLength: 2048 });
const agent = generateKeyPairSync("rsa", { modulusLength: 2048 });
const der = (kp) => kp.publicKey.export({ type: "spki", format: "der" });
const signAs = (kp, text) => sign("sha256", Buffer.from(text, "utf8"), kp.privateKey).toString("base64");

const NOW = Date.parse("2026-10-02T15:00:00.000Z");
const HEAD = "a3acffc80f5d0c8bb946b5e66e85bb059f7f00f8";
const HASH = createHash("sha256").update("select 1;\n").digest("hex");
const CATS = [{ category: "changes-access", reason: "an ALTER FUNCTION ... OWNER TO on an existing function" }];
const base = {
  project: "rhyzpcqhnizqbxphqdkr",
  migration: "20260914101000_field_season_filed_season",
  queryHash: HASH,
  pullRequest: 843,
  prHead: HEAD,
  categories: CATS,
  issuedAt: new Date(NOW - 60_000).toISOString(),
  expiresAt: new Date(NOW - 60_000 + OWNER_APPROVAL_MAX_AGE_MS).toISOString(),
  nonce: "0123456789abcdef0123456789abcdef",
};
const expect = {
  project: base.project,
  migration: base.migration,
  queryHash: HASH,
  pullRequest: 843,
  prHead: HEAD,
  categories: ["changes-access"],
};
const keys = { pinned: der(mason), live: der(mason) };
const approve = (over = {}, signer = mason) => {
  const payload = buildApprovalPayload({ ...base, ...over });
  return { payload, signature: signAs(signer, payload) };
};
const check = (approval, over = {}) => verifyOwnerApproval({ approval, expect, keys, appliedNames: [], usedNonces: new Set(), now: NOW, ...over });

// ── BASELINE: a genuine approval verifies, or every refusal below proves nothing.
{
  const v = check(approve());
  ok(v.ok === true, `a genuine approval verifies: ${v.reason}`);
  ok(v.payload.nonce === base.nonce, "the verified payload is returned");
}

// ── The signature and the key.
refuses(check(approve({}, agent)), "not Mason's", "a signature by any other key is refused");
{
  const a = approve();
  refuses(check({ ...a, payload: a.payload.replace("843", "844") }), "not Mason's", "an approval edited after signing is refused");
  refuses(check({ ...a, signature: "" }), "not Mason's", "an empty signature is refused");
  refuses(check({ payload: a.payload }), "malformed", "a missing signature is refused");
}
refuses(check(approve({}, agent), { keys: { pinned: der(agent), live: der(mason) } }), "not the Windows Hello key",
  "an agent's software key pinned in the repo does not match the Windows Hello key");
refuses(check(approve(), { keys: { pinned: der(mason), live: Buffer.alloc(0) } }), "Windows holds no approval key",
  "no key in Windows refuses");
refuses(check(approve(), { keys: { pinned: undefined, live: der(mason) } }), "committed approval key is missing",
  "no committed key refuses");

// ── What it is bound to.
refuses(check(approve({ migration: "20260914101100_other" })), "not 20260914101000", "another migration's approval is refused");
refuses(check(approve({ queryHash: "0".repeat(64) })), "file changed", "an approval for different SQL is refused");
refuses(check(approve({ pullRequest: 900 })), "pull request #900", "an approval for another PR is refused");
refuses(check(approve({ prHead: "b".repeat(40) })), "not the pull request's current head", "an approval for an older head is refused");
refuses(check(approve(), { expect: { ...expect, prHead: undefined } }), "head is unknown", "an unknown landing head fails closed");
refuses(check(approve({ project: "someotherproject" })), "approves project", "an approval for another project is refused");
refuses(check(approve(), { expect: { ...expect, categories: ["changes-access", "deletes-data"] } }), "deletes data",
  "an approval that never showed Mason a category the check now flags is refused");
{
  const selftest = buildSelfTestPayload({ issuedAt: base.issuedAt, nonce: base.nonce });
  refuses(check({ payload: selftest, signature: signAs(mason, selftest) }), "not a migration approval",
    "the setup test signature can never approve a migration");
}
{
  // What Mason was shown must be what the fields say.
  const p = JSON.parse(buildApprovalPayload(base));
  p.summary = ["Approve a harmless wording change"];
  const text = JSON.stringify(p, null, 2);
  refuses(check({ payload: text, signature: signAs(mason, text) }), "what Mason was shown",
    "a signed payload whose summary misdescribes it is refused");
}

// ── Time and single use.
refuses(check(approve(), { now: Date.parse(base.expiresAt) + 1 }), "expired", "an expired approval is refused");
refuses(check(approve(), { now: Date.parse(base.issuedAt) - 1 }), "future", "an approval dated after now is refused");
refuses(check(approve({ expiresAt: new Date(Date.parse(base.issuedAt) + OWNER_APPROVAL_MAX_AGE_MS + 1).toISOString() })),
  "longer than 30 minutes", "a window over 30 minutes is refused");
refuses(check(approve({ expiresAt: base.issuedAt })), "longer than 30 minutes", "an empty window is refused");
refuses(check(approve(), { usedNonces: new Set([base.nonce]) }), "already used", "a used approval is refused");
refuses(check(approve(), { appliedNames: ["20260101000000_x", base.migration] }), "already in the live ledger",
  "an approval for a migration already applied is refused");

// ── The summary Mason reads names what matters, in plain words.
{
  const lines = ownerApprovalSummary(JSON.parse(buildApprovalPayload(base))).join("\n");
  ok(lines.includes(base.migration) && lines.includes("#843") && lines.includes(HEAD.slice(0, 12)), "summary names the migration, PR and head");
  ok(lines.includes("Changes who can access what"), "summary names the category in plain English");
  ok(/Central/.test(lines) && lines.includes("works once"), "summary states the expiry in Central time and single use");
}

// ── The classifiers the approval is bound to (same ones the apply guard uses).
{
  const cats = (sql) => parkedCategories(sql).map((c) => c.category);
  ok(cats("DROP TABLE public.customers;\n").includes("deletes-data"), "DROP TABLE parks as deletes-data");
  ok(cats("UPDATE public.invoices SET total_amount_cents = 0;\n").includes("overwrites-data"), "UPDATE parks as overwrites-data");
  ok(cats("GRANT SELECT ON public.customers TO anon;\n").includes("changes-access"), "GRANT to anon parks as changes-access");
  ok(cats("CREATE TABLE public.w (id bigint primary key);\nALTER TABLE public.w ENABLE ROW LEVEL SECURITY;\n").length === 0,
    "a routine new table parks nothing");
}

// ── Files: pinned key, approvals and used nonces.
{
  const dir = mkdtempSync(path.join(os.tmpdir(), "crx-owner-approval-"));
  try {
    const keyFile = path.join(dir, "owner-approval-key.json");
    const spki = der(mason);
    const good = { keyName: OWNER_KEY_NAME, spki: spki.toString("base64"), fingerprint: createHash("sha256").update(spki).digest("hex") };
    writeFileSync(keyFile, JSON.stringify(good));
    ok(readPinnedOwnerKey(keyFile).equals(spki), "a consistent pinned key reads back");
    writeFileSync(keyFile, JSON.stringify({ ...good, fingerprint: "0".repeat(64) }));
    assert.throws(() => readPinnedOwnerKey(keyFile), /fingerprint/); pass++;
    writeFileSync(keyFile, JSON.stringify({ ...good, keyName: "Other" }));
    assert.throws(() => readPinnedOwnerKey(keyFile), /names key/); pass++;
    assert.throws(() => readPinnedOwnerKey(path.join(dir, "missing.json")), /not set up yet/); pass++;

    const a = approve();
    writeFileSync(path.join(dir, "owner-approval-20260914101000_field_season_filed_season.json"), JSON.stringify(a));
    const found = findOwnerApprovals([dir, path.join(dir, "nope")], "20260914101000_field_season_filed_season");
    ok(found.length === 1 && found[0].approval.signature === a.signature, "the approval file is found by migration name");

    ok(readUsedNonces([dir]).size === 0, "nothing is used at first");
    recordUsedApproval(dir, a.payload, NOW);
    ok(readUsedNonces([dir]).has(base.nonce), "a recorded approval reads back as used");
    refuses(check(a, { usedNonces: readUsedNonces([dir]) }), "already used", "a recorded approval cannot verify again");
    ok(JSON.parse(readFileSync(path.join(dir, "owner-approvals-used.json"), "utf8")).used[0].migration === base.migration,
      "the used record names the migration");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

ok(signatureValid("x", signAs(mason, "x"), der(mason)) && !signatureValid("x", signAs(mason, "x"), der(agent)),
  "signatureValid accepts the signer's key only");

console.log(`owner-approval-lib: ${pass} assertions passed`);
