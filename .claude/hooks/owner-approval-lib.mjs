// OWNER APPROVAL (Mason, 2026-09-29: "approved all three").
//
// migration-apply-lib.mjs parks three kinds of migration for Mason: one that
// DELETES data, one that OVERWRITES existing rows, and one that CHANGES WHO CAN
// ACCESS WHAT. Until now nothing could apply them — no agent, and no route Mason
// could use either, short of pasting SQL into the Supabase Dashboard, which
// DATABASE_CHANGE_CHECKLIST forbids. An approval flag, label, comment or GitHub
// review cannot fix that: agents act through Mason's own GitHub token, so any of
// those can be forged (Sol HIGH, PR #804, 2026-09-26).
//
// This module is the one thing an agent cannot forge: a signature made by a key
// that lives in this PC's security chip and that Windows Hello releases only
// after Mason's PIN or fingerprint (owner-approval-hello.ps1). Each signature
// covers ONE payload:
//   * the exact migration (its name and the sha256 of its LF-normalized SQL),
//   * the pull request number and its exact head commit,
//   * what the safety check flagged (the categories below),
//   * a 30-minute window and a one-time nonce,
//   * the plain-English summary Mason was shown — recomputed here from the
//     payload's own fields, so what he read is what he signed.
//
// It is NOT a general override. It only lets a parked migration continue to the
// SAME checks every other migration must pass (reviewer proofs, the Sol proof,
// the pull-request landing gate); it only works through
// scripts/apply-migration-file.mjs; and it works once.
//
// The key is checked twice: the public key pinned in owner-approval-key.json
// (reviewed, committed) must equal the one Windows holds under OWNER_KEY_NAME
// right now. A software key an agent generated and pinned would not match the
// Windows Hello key; replacing that key needs Mason's Windows Hello prompt.

import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { destructiveMigrationCheck } from "./live-testdata-lib.mjs";
import { accessChangeCheck, dataRewriteCheck } from "./migration-access-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const OWNER_KEY_NAME = "CRX-Owner-Migration-Approval";
export const OWNER_KEY_FILE = path.join(HERE, "owner-approval-key.json");
export const OWNER_HELLO_SCRIPT = path.join(HERE, "owner-approval-hello.ps1");
export const OWNER_APPROVAL_PURPOSE = "crx-owner-migration-approval-v1";
export const OWNER_SELFTEST_PURPOSE = "crx-owner-approval-selftest-v1";
export const OWNER_APPROVAL_MAX_AGE_MS = 30 * 60 * 1000;
// Mason works in Central time; the window he is shown uses it on every machine.
const OWNER_TIME_ZONE = "America/Chicago";

export const PARKED_LABELS = {
  "deletes-data": "Deletes data",
  "overwrites-data": "Overwrites existing data",
  "changes-access": "Changes who can access what",
};

const errText = (e) => (e && e.message ? e.message : e);

/**
 * What the safety check parks for Mason, in a fixed order. A classifier error
 * counts as a hit (fail closed), with the same reason text migration-apply-lib
 * has always used.
 */
export function parkedCategories(query, { history } = {}) {
  const out = [];
  let d;
  try { d = destructiveMigrationCheck(query); }
  catch (e) { d = { destructive: true, reason: `destructive-check error (${errText(e)}) — failing closed` }; }
  if (d.destructive) out.push({ category: "deletes-data", reason: String(d.reason) });
  let rewrite;
  try { rewrite = dataRewriteCheck(query, { history }); }
  catch (e) { rewrite = { rewrites: true, reason: `data-rewrite check error (${errText(e)}) — failing closed` }; }
  if (rewrite.rewrites) out.push({ category: "overwrites-data", reason: String(rewrite.reason) });
  let access;
  try { access = accessChangeCheck(query, { history }); }
  catch (e) { access = { changesAccess: true, reason: `access-check error (${errText(e)}) — failing closed` }; }
  if (access.changesAccess) out.push({ category: "changes-access", reason: String(access.reason) });
  return out;
}

export const approvalFileName = (safeName) => `owner-approval-${safeName}.json`;

function centralTime(iso) {
  return `${new Date(iso).toLocaleString("en-US", { timeZone: OWNER_TIME_ZONE, dateStyle: "medium", timeStyle: "short" })} Central`;
}

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 3)}...` : String(s));

/** The lines Mason sees before he signs. Derived only from payload fields. */
export function ownerApprovalSummary(p) {
  if (p.purpose === OWNER_SELFTEST_PURPOSE) {
    return [
      "This is a one-time TEST of your new approval key.",
      "It approves nothing and changes nothing.",
      "",
      `Test code: ${String(p.nonce).slice(0, 8)}`,
    ];
  }
  return [
    "Approve this ONE change to the live CRX Manager database:",
    "",
    `Migration: ${p.migration}`,
    `Pull request: #${p.pullRequest} (version ${String(p.prHead).slice(0, 12)})`,
    `File fingerprint: ${String(p.queryHash).slice(0, 16)}`,
    "",
    "The safety check stopped it for you because it:",
    ...(p.categories || []).map((c) => `- ${PARKED_LABELS[c.category] || c.category}: ${clip(c.reason, 300)}`),
    "",
    `This approval works once, only for this exact file and version, until ${centralTime(p.expiresAt)}.`,
    "Every other safety check still has to pass before it runs.",
  ];
}

/** The exact text Mason signs. Field order is fixed. */
export function buildApprovalPayload({ project, migration, queryHash, pullRequest, prHead, categories, issuedAt, expiresAt, nonce }) {
  const p = {
    purpose: OWNER_APPROVAL_PURPOSE,
    project,
    migration,
    queryHash,
    pullRequest,
    prHead,
    categories: categories.map((c) => ({ category: c.category, reason: c.reason })),
    issuedAt,
    expiresAt,
    nonce,
  };
  return JSON.stringify({ ...p, summary: ownerApprovalSummary(p) }, null, 2);
}

export function buildSelfTestPayload({ issuedAt, nonce }) {
  const p = { purpose: OWNER_SELFTEST_PURPOSE, issuedAt, nonce };
  return JSON.stringify({ ...p, summary: ownerApprovalSummary(p) }, null, 2);
}

/** True when `signature` (base64) is the owner key's signature of `payload`. */
export function signatureValid(payload, signature, spkiDer) {
  try {
    const key = createPublicKey({ key: spkiDer, format: "der", type: "spki" });
    return cryptoVerify("sha256", Buffer.from(String(payload), "utf8"), key, Buffer.from(String(signature), "base64"));
  } catch {
    return false;
  }
}

/** The committed public key. Throws with a plain reason when it is missing or inconsistent. */
export function readPinnedOwnerKey(file = OWNER_KEY_FILE) {
  if (!existsSync(file)) throw new Error(`Mason's approval key is not set up yet (no ${path.basename(file)}); run node scripts/owner-approval-setup.mjs with Mason at the PC`);
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (data?.keyName !== OWNER_KEY_NAME) throw new Error(`${path.basename(file)} names key "${data?.keyName}", not ${OWNER_KEY_NAME}`);
  const der = Buffer.from(String(data?.spki || ""), "base64");
  if (!der.length) throw new Error(`${path.basename(file)} holds no public key`);
  const fingerprint = createHash("sha256").update(der).digest("hex");
  if (fingerprint !== String(data?.fingerprint || "").toLowerCase()) {
    throw new Error(`${path.basename(file)}'s fingerprint does not match its public key`);
  }
  createPublicKey({ key: der, format: "der", type: "spki" });
  return der;
}

/** Run the Windows Hello helper. Returns its parsed JSON line. */
export function runHello(mode, { payloadFile, timeoutMs = 60_000 } = {}) {
  if (process.platform !== "win32") {
    return { ok: false, status: "NotWindows", message: "Windows Hello is only available on Mason's Windows PC" };
  }
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", OWNER_HELLO_SCRIPT, "-Mode", mode];
  if (payloadFile) args.push("-PayloadFile", payloadFile);
  const run = spawnSync("powershell.exe", args, { encoding: "utf8", timeout: timeoutMs, windowsHide: false });
  if (run.error) return { ok: false, status: "Error", message: String(errText(run.error)) };
  const line = String(run.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
  try { return JSON.parse(line); }
  catch { return { ok: false, status: "Error", message: `unreadable helper output: ${clip(line || run.stderr || "(none)", 200)}` }; }
}

/** The public key Windows holds for Mason right now. Throws when it cannot be read. */
export function readLiveOwnerKey() {
  const r = runHello("PublicKey", { timeoutMs: 30_000 });
  if (!r?.ok || !r.publicKey) {
    throw new Error(`could not read Mason's approval key from Windows (${r?.status || "no answer"}${r?.message ? `: ${r.message}` : ""})`);
  }
  return Buffer.from(String(r.publicKey), "base64");
}

export function defaultOwnerKeys() {
  return { pinned: readPinnedOwnerKey(), live: readLiveOwnerKey() };
}

// One marker FILE per used approval, created exclusively ("wx"): two applies
// racing on the same approval cannot both create it, so only one transmits
// (Luna HIGH, 2026-09-29). Its existence is what counts, so a damaged marker still
// reads as used; an unreadable directory refuses (Luna MED: fail closed).
const USED_MARKER_RE = /^owner-approval-used-([0-9A-Za-z_-]{1,128})\.json$/;
export const usedMarkerName = (nonce) => `owner-approval-used-${nonce}.json`;

/** Nonces already used, from every directory approvals may come from. Throws if one cannot be read. */
export function readUsedNonces(dirs) {
  const used = new Set();
  for (const dir of dirs || []) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const m = name.match(USED_MARKER_RE);
      if (m) used.add(m[1]);
    }
  }
  return used;
}

/**
 * Claim an approval BEFORE the apply transmits. Throws if it was already claimed
 * (by this or a concurrent run) or cannot be recorded.
 */
export function recordUsedApproval(dir, payloadText, now = Date.now()) {
  const p = JSON.parse(payloadText);
  if (!/^[0-9A-Za-z_-]{1,128}$/.test(String(p.nonce || ""))) throw new Error("the approval's nonce is malformed");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, usedMarkerName(p.nonce)),
    `${JSON.stringify({ nonce: p.nonce, migration: p.migration, prHead: p.prHead, usedAt: new Date(now).toISOString() }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" });
}

/** The approval must still be inside its window at the moment of transmission. */
export function assertApprovalStillValid(payloadText, now = Date.now()) {
  const p = JSON.parse(payloadText);
  const expires = Date.parse(p.expiresAt);
  if (!Number.isFinite(expires) || now > expires) throw new Error(`Mason's approval expired at ${p.expiresAt}`);
}

/** Every approval file for this migration in the given directories. */
export function findOwnerApprovals(dirs, safeName) {
  const found = [];
  for (const dir of dirs || []) {
    const file = path.join(dir, approvalFileName(safeName));
    try { found.push({ dir, file, approval: JSON.parse(readFileSync(file, "utf8")) }); } catch { /* none here */ }
  }
  return found;
}

/**
 * Check one approval against what is about to be applied.
 *
 * @param {object} args
 * @param {{payload: string, signature: string}} args.approval
 * @param {object} args.expect  project, migration, queryHash, pullRequest, prHead,
 *   categories ([{category, reason}] exactly as parkedCategories returns them now)
 * @param {{pinned: Buffer, live: Buffer}} args.keys
 * @param {string[]|null} [args.appliedNames]  the live ledger snapshot; null skips that check
 * @param {Set<string>} [args.usedNonces]
 * @returns {{ok: true, payload: object}|{ok: false, reason: string}}
 */
export function verifyOwnerApproval({ approval, expect, keys, appliedNames = null, usedNonces = new Set(), now = Date.now() }) {
  const no = (reason) => ({ ok: false, reason });
  const payloadText = approval?.payload;
  if (typeof payloadText !== "string" || typeof approval?.signature !== "string") return no("the approval file is malformed");
  const pinned = keys?.pinned;
  const live = keys?.live;
  if (!Buffer.isBuffer(pinned) || !pinned.length) return no("the committed approval key is missing");
  if (!Buffer.isBuffer(live) || !live.length) return no("Windows holds no approval key for Mason");
  if (!pinned.equals(live)) return no("the committed approval key is not the Windows Hello key on this PC");
  if (!signatureValid(payloadText, approval.signature, pinned)) return no("the signature is not Mason's (or the approval was edited after he signed it)");

  let p;
  try { p = JSON.parse(payloadText); } catch { return no("the signed approval is unreadable"); }
  if (p.purpose !== OWNER_APPROVAL_PURPOSE) return no(`the signature is for "${p.purpose}", not a migration approval`);
  if (p.project !== expect.project) return no(`it approves project ${p.project}, not ${expect.project}`);
  if (p.migration !== expect.migration) return no(`it approves ${p.migration}, not ${expect.migration}`);
  if (p.queryHash !== expect.queryHash) return no("the migration file changed after Mason approved it (different fingerprint)");
  if (!/^[0-9a-f]{40}$/i.test(String(expect.prHead || "")) || !Number.isInteger(Number(expect.pullRequest)) || !(Number(expect.pullRequest) > 0)) {
    return no("the pull request or its head is unknown (fail closed)");
  }
  if (Number(p.pullRequest) !== Number(expect.pullRequest)) return no(`it approves pull request #${p.pullRequest}, not #${expect.pullRequest}`);
  if (String(p.prHead).toLowerCase() !== String(expect.prHead).toLowerCase()) {
    return no(`it approves version ${String(p.prHead).slice(0, 12)}, not the pull request's current head ${String(expect.prHead).slice(0, 12)}`);
  }
  // What Mason was told the check found must be EXACTLY what it finds now — the
  // categories and their reasons, in order. Comparing names alone would let a
  // hand-built payload keep the category and soften the reason he reads.
  const shown = (p.categories || []).map((c) => `${c?.category}\u0000${c?.reason}`);
  const actual = (expect.categories || []).map((c) => `${c?.category}\u0000${c?.reason}`);
  const missing = (expect.categories || []).filter((c) => !shown.includes(`${c?.category}\u0000${c?.reason}`));
  if (missing.length) {
    return no(`Mason was not shown that it ${missing.map((c) => PARKED_LABELS[c?.category] || c?.category).join(" and ").toLowerCase()}, in the words the safety check uses`);
  }
  if (shown.length !== actual.length || shown.some((s, i) => s !== actual[i])) {
    return no("what Mason was told the safety check found is not what it finds now");
  }
  if (JSON.stringify(p.summary) !== JSON.stringify(ownerApprovalSummary(p))) return no("what Mason was shown does not match what the approval covers");

  const issued = Date.parse(p.issuedAt);
  const expires = Date.parse(p.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) return no("the approval has no usable time window");
  if (expires <= issued || expires - issued > OWNER_APPROVAL_MAX_AGE_MS) return no("the approval window is longer than 30 minutes");
  if (now < issued) return no("the approval is dated in the future");
  if (now > expires) return no(`the approval expired at ${p.expiresAt}; ask Mason again`);
  if (!/^[0-9A-Za-z_-]{1,128}$/.test(String(p.nonce || ""))) return no("the approval has no usable one-time code");
  if (usedNonces.has(String(p.nonce))) return no("this approval was already used; each one works once");
  if (Array.isArray(appliedNames) && appliedNames.includes(expect.migration)) {
    return no(`${expect.migration} is already in the live ledger; an approval covers one install`);
  }
  return { ok: true, payload: p };
}
