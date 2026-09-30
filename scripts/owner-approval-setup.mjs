#!/usr/bin/env node
// One-time setup of Mason's approval key (Mason, 2026-09-29).
//
// Creates the key with Windows Hello (the private half stays in this PC's
// security chip), then proves it end to end: Mason signs a harmless TEST payload,
// this script checks the signature with the public half, and checks that an
// edited payload is rejected. Only then is the public half written to
// .claude/hooks/owner-approval-key.json, which must be committed and reviewed.
//
//   node scripts/owner-approval-setup.mjs      (Mason at the PC: two Windows Hello prompts)
//
// Replacing an existing key is deliberately not a flag here: delete the committed
// key file in a reviewed pull request first, so the change is visible.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OWNER_KEY_FILE,
  OWNER_KEY_NAME,
  buildSelfTestPayload,
  runHello,
  signatureValid,
} from "../.claude/hooks/owner-approval-lib.mjs";

function die(code, msg) {
  console.error(msg);
  process.exit(code);
}

if (existsSync(OWNER_KEY_FILE)) {
  die(1, `owner-approval-setup: ${OWNER_KEY_FILE} already exists. Replacing Mason's key takes a reviewed pull request that deletes it first.`);
}

console.log("Step 1 of 2: creating Mason's approval key (Windows Hello prompt)...");
let created = runHello("Create", { timeoutMs: 10 * 60 * 1000 });
if (!created?.ok && created?.status === "CredentialAlreadyExists") {
  console.log("A key from an earlier setup attempt already exists in Windows; using it.");
  created = runHello("PublicKey", { timeoutMs: 30_000 });
}
if (!created?.ok || !created.publicKey) {
  die(3, `owner-approval-setup: no key was created (${created?.status || "no answer"}${created?.message ? `: ${created.message}` : ""}).`);
}
const spki = Buffer.from(created.publicKey, "base64");

console.log("Step 2 of 2: test signature (a second Windows Hello prompt; it approves nothing)...");
const payload = buildSelfTestPayload({ issuedAt: new Date().toISOString(), nonce: randomBytes(16).toString("hex") });
const tmp = mkdtempSync(path.join(os.tmpdir(), "crx-owner-setup-"));
let signed;
try {
  writeFileSync(path.join(tmp, "payload.json"), payload, "utf8");
  signed = runHello("Sign", { payloadFile: path.join(tmp, "payload.json"), timeoutMs: 10 * 60 * 1000 });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (!signed?.ok || !signed.signature) {
  die(3, `owner-approval-setup: the test signature was not made (${signed?.status || "no answer"}${signed?.message ? `: ${signed.message}` : ""}). Nothing was written.`);
}
if (!signatureValid(payload, signed.signature, spki)) {
  die(2, "owner-approval-setup: the test signature did NOT verify against the new key. Nothing was written.");
}
if (signatureValid(payload.replace("TEST", "TEXT"), signed.signature, spki)) {
  die(2, "owner-approval-setup: an EDITED payload still verified — the check is not binding. Nothing was written.");
}
console.log("Test signature verified; an edited copy was rejected.");

const fingerprint = createHash("sha256").update(spki).digest("hex");
writeFileSync(OWNER_KEY_FILE, `${JSON.stringify({
  keyName: OWNER_KEY_NAME,
  algorithm: "RSASSA-PKCS1-v1_5 SHA-256 (Windows Hello KeyCredential)",
  spki: spki.toString("base64"),
  fingerprint,
  createdAt: new Date().toISOString(),
  note: "Public half of Mason's Windows Hello approval key. The private half never leaves his PC's security chip. Changing this file changes who can approve parked migrations: review it like a guard.",
}, null, 2)}\n`, "utf8");
console.log("");
console.log(`DONE. Public key written to ${OWNER_KEY_FILE}`);
console.log(`Fingerprint: ${fingerprint}`);
