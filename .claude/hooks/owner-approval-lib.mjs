// OWNER APPROVAL (Mason, 2026-09-29: "approved all three"; by chat reply since
// 2026-10-09: "remove the windows hello thing ... I do a lot of work from phone",
// then "go - i accept the trade off" once the trade-off below was put to him).
//
// migration-apply-lib.mjs parks three kinds of migration for Mason: one that
// DELETES data, one that OVERWRITES existing rows, and one that CHANGES WHO CAN
// ACCESS WHAT. This module is how he approves one of them.
//
// Until 2026-10-09 he approved with a Windows Hello signature, which needed him
// at the PC. He works mostly from his phone, so the approval is now his reply in
// the chat:
//   1. scripts/owner-approve-migration.mjs builds a REQUEST from the file itself:
//      the exact migration (its name and the sha256 of its LF-normalized SQL), the
//      pull request and its exact head, what the safety check flagged, and a
//      6-digit code. It is saved beside the checkout's other proofs.
//   2. The agent shows Mason the plain-English summary and the exact reply.
//   3. He replies `approve <code>` from anywhere. owner-approval-prompt.mjs, a
//      UserPromptSubmit hook, turns that request into an APPROVAL good for 30
//      minutes. A hook runs on a message sent into the session, never on a tool
//      call, so no command an agent runs produces one through it.
//   4. scripts/apply-migration-file.mjs checks it LAST, after the reviewer proofs,
//      the Sol proof and the landing gate, and uses it up once.
//
// THE TRADE-OFF MASON ACCEPTED. The reply must be the WHOLE message, so a peer
// session's message (always wrapped in an envelope or preamble), a subagent's
// report or a quoted line never matches. That stops a parked migration being
// applied by mistake, on a misread handoff, or on a relayed "Mason said yes". It
// does not stop an agent that deliberately writes the approval file itself:
// agents run on Mason's PC with his permissions, and only Windows Hello could
// rule that out. The file lives in .claude/session-state, which the review proof
// guard protects like every other proof.
//
// It is NOT a general override. It only lets a parked migration continue to the
// SAME checks every other migration must pass; it only works through
// scripts/apply-migration-file.mjs; and it works once.

import { execFileSync } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { destructiveMigrationCheck } from "./live-testdata-lib.mjs";
import { accessChangeCheck, dataRewriteCheck } from "./migration-access-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// v2 = approved by chat reply. A v1 (Windows Hello) payload is refused by purpose.
export const OWNER_APPROVAL_PURPOSE = "crx-owner-migration-approval-v2";
export const OWNER_SELFTEST_PURPOSE = "crx-owner-approval-selftest-v2";
export const OWNER_APPROVAL_VIA = "chat-reply";
// Once Mason replies, the agent has 30 minutes to apply.
export const OWNER_APPROVAL_MAX_AGE_MS = 30 * 60 * 1000;
// He may reply up to a day after the request. Anything that changed meanwhile
// (the file, the pull request head, what the safety check finds) still refuses it.
export const OWNER_REQUEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Mason works in Central time; the deadline he is shown uses it on every machine.
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

/** The same file-safe form of a migration name migration-apply-lib uses. */
export const safeMigrationName = (migName) => String(migName).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "unknown";
export const approvalFileName = (safeName) => `owner-approval-${safeName}.json`;
export const requestFileName = (code) => `owner-approval-request-${code}.json`;
export const selfTestResultName = (code) => `owner-approval-selftest-${code}.json`;

/** A fresh 6-digit code: short enough to type on a phone. */
export const newApprovalCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

function centralTime(iso) {
  return `${new Date(iso).toLocaleString("en-US", { timeZone: OWNER_TIME_ZONE, dateStyle: "medium", timeStyle: "short" })} Central`;
}

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 3)}...` : String(s));

/** The lines Mason sees before he replies. Derived only from payload fields. */
export function ownerApprovalSummary(p) {
  if (p.purpose === OWNER_SELFTEST_PURPOSE) {
    return [
      "This is a TEST of approving by chat reply.",
      "It approves nothing and changes nothing.",
      "",
      `To answer it, reply exactly: approve ${p.code}`,
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
    ...(p.categories || []).map((c) => `- ${PARKED_LABELS[c.category] || c.category}: ${c.reason}`),
    "",
    `To approve, reply exactly: approve ${p.code} (before ${centralTime(p.expiresAt)}).`,
    "It then works once, for 30 minutes, only for this exact file and version.",
    "Every other safety check still has to pass before it runs.",
  ];
}

/** The request Mason approves. Field order is fixed; expiresAt is his reply deadline. */
export function buildApprovalPayload({ project, migration, queryHash, pullRequest, prHead, categories, issuedAt, expiresAt, nonce, code }) {
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
    code,
  };
  return JSON.stringify({ ...p, summary: ownerApprovalSummary(p) }, null, 2);
}

export function buildSelfTestPayload({ issuedAt, expiresAt, nonce, code }) {
  const p = { purpose: OWNER_SELFTEST_PURPOSE, issuedAt, expiresAt, nonce, code };
  return JSON.stringify({ ...p, summary: ownerApprovalSummary(p) }, null, 2);
}

/** Save a request where the reply hook will look. "wx": a code already pending in this checkout throws. */
export function writeApprovalRequest(stateDir, payloadText) {
  const p = JSON.parse(payloadText);
  if (!/^\d{6}$/.test(String(p.code || ""))) throw new Error("the request has no usable code");
  mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, requestFileName(p.code));
  writeFileSync(file, `${JSON.stringify({ payload: payloadText }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return file;
}

// The WHOLE message must be the reply. A phone may capitalise the first letter
// and Mason may end with a period; anything more (other words, a quote, a peer's
// envelope or preamble) is not an approval.
const REPLY_RE = /^\s*approve\s+(\d{6})\s*[.!]?\s*$/i;

/** The code in Mason's reply, or null when the message is not exactly `approve <code>`. */
export function approvalCodeFromReply(prompt) {
  const m = REPLY_RE.exec(String(prompt ?? ""));
  return m ? m[1] : null;
}

/**
 * The session-state directories a request may be in: ONLY the folders of the
 * session Mason is replying in. A request another session built in another
 * worktree is never found, so his reply in one conversation cannot approve an
 * apply that a different conversation runs (Codex P1, PR #894: AGENTS.md wants
 * his approval in the applying conversation).
 */
export function ownerRequestDirs(sessionFolders) {
  return [...new Set((sessionFolders || []).filter(Boolean).map((s) => path.resolve(s)))]
    .map((r) => path.join(r, ".claude", "session-state"));
}

/**
 * Turn Mason's reply into an approval: the pending request with this code becomes
 * an approval file beside it, stamped with when he replied. Only the reply hook
 * calls this.
 *
 * @returns {{ok: true, kind: "migration"|"selftest", payload: object, file: string, requestLeft: boolean}|{ok: false, reason: string}}
 */
export function recordReplyApproval({ code, dirs, reply, now = Date.now(), removeRequest = (f) => rmSync(f, { force: true }) }) {
  const no = (reason) => ({ ok: false, reason });
  const hits = [];
  for (const dir of new Set(dirs || [])) {
    const file = path.join(dir, requestFileName(code));
    if (existsSync(file)) hits.push({ dir, file });
  }
  if (!hits.length) return no(`no pending approval request has the code ${code}`);
  if (hits.length > 1) return no(`${hits.length} pending requests share the code ${code}, so it is ambiguous`);
  const { dir, file } = hits[0];
  let payloadText;
  let p;
  try {
    payloadText = JSON.parse(readFileSync(file, "utf8")).payload;
    p = JSON.parse(payloadText);
  } catch {
    return no(`the request for code ${code} is unreadable`);
  }
  if (String(p?.code) !== code) return no(`the request file does not carry the code ${code}`);
  const selftest = p.purpose === OWNER_SELFTEST_PURPOSE;
  if (!selftest && p.purpose !== OWNER_APPROVAL_PURPOSE) return no(`the request for code ${code} is not a migration approval request`);
  const deadline = Date.parse(p.expiresAt);
  if (!Number.isFinite(deadline) || now > deadline) return no(`the request for code ${code} expired at ${p.expiresAt}`);
  const approval = { payload: payloadText, approvedAt: new Date(now).toISOString(), via: OWNER_APPROVAL_VIA, reply: clip(String(reply ?? "").trim(), 40) };
  const out = path.join(dir, selftest ? selfTestResultName(code) : approvalFileName(safeMigrationName(p.migration)));
  try { writeFileSync(out, `${JSON.stringify(approval, null, 2)}\n`, "utf8"); }
  catch (e) { return no(`the approval could not be saved (${errText(e)})`); }
  // Once the approval file exists it IS the authorization, so a failure to remove
  // the request afterwards (a Windows file lock) still reports success; saying
  // "nothing was approved" would misstate what the apply gate will accept (Codex
  // P2, PR #894). A leftover request can only be re-approved by another reply.
  let requestLeft = false;
  try { removeRequest(file); } catch { requestLeft = true; }
  return { ok: true, kind: selftest ? "selftest" : "migration", payload: p, file: out, requestLeft };
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

/**
 * SQL placed at the start of an owner-approved apply's transaction (Luna HIGH,
 * round 2): lock on the migration's name, then refuse if the ledger already holds
 * it. Local "used" markers are files an agent could delete; this is enforced by the
 * database, and two racing applies serialize on the lock so the second rolls back.
 * `tag` is the apply script's dollar-quote tag; both tags are checked absent.
 */
export function ownerOnceGuardSql({ tag, migName, sql }) {
  const dq = `$${tag}$`;
  const guardTag = `$${tag}_guard$`;
  for (const t of [dq, guardTag]) {
    if (String(sql).includes(t) || String(migName).includes(t)) throw new Error(`dollar-quote tag ${t} collides with the payload`);
  }
  return `SELECT pg_advisory_xact_lock(hashtext(${dq}crx-owner-approved:${migName}${dq}));\n` +
    `DO ${guardTag} BEGIN\n` +
    `  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = ${dq}${migName}${dq}) THEN\n` +
    `    RAISE EXCEPTION 'OWNER_APPROVAL_ALREADY_APPLIED: % is already in the ledger; one approval covers one install', ${dq}${migName}${dq};\n` +
    `  END IF;\n` +
    `END ${guardTag};\n`;
}

// The files an owner approval is created and verified with, repo-relative. They
// are read from this checkout, so an uncommitted edit to any of them (a reply
// hook that approves any message, a classifier that stops parking) could launder
// an approval while the migration and PR head stay reviewed (Sol HIGH, PR #857).
// They must match the reviewed commit byte for byte before a request is built or
// an approval honoured.
export const OWNER_TRUST_FILES = Object.freeze([
  ".claude/hooks/owner-approval-lib.mjs",
  ".claude/hooks/owner-approval-prompt.mjs",
  ".claude/hooks/live-testdata-lib.mjs",
  ".claude/hooks/migration-access-lib.mjs",
  ".claude/hooks/migration-apply-lib.mjs",
  ".claude/hooks/migration-landing-gate-lib.mjs",
  ".claude/hooks/codex-push-lib.mjs",
  "scripts/apply-migration-file.mjs",
  "scripts/owner-approve-migration.mjs",
]);
// The checkout these files were loaded from: this module lives in <root>/.claude/hooks.
export const OWNER_TRUST_ROOT = path.resolve(HERE, "..", "..");

const lfHash = (bytes) => createHash("sha256").update(String(bytes).replace(/\r\n/g, "\n")).digest("hex");

/**
 * Throws unless every OWNER_TRUST_FILES file on disk is byte-identical (CRLF→LF,
 * the repository's line-ending normalization) to that file in the reviewed
 * commit `head`. Compares file bytes directly, never `git status`, which trusts
 * the index's cached file times and the assume-unchanged / skip-worktree flags.
 */
export function assertOwnerTrustFilesReviewed({
  head,
  root = OWNER_TRUST_ROOT,
  files = OWNER_TRUST_FILES,
  showCommitted = (rel) => execFileSync("git", ["show", `${head}:${rel}`], {
    cwd: root, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024,
  }),
  readOnDisk = (rel) => readFileSync(path.join(root, ...rel.split("/")), "utf8"),
} = {}) {
  if (!/^[0-9a-f]{40}$/i.test(String(head || ""))) throw new Error("no reviewed commit to compare the approval files against");
  const changed = [];
  for (const rel of files) {
    let committed;
    try { committed = showCommitted(rel); }
    catch { changed.push(`${rel} (not in the reviewed commit)`); continue; }
    let disk;
    try { disk = readOnDisk(rel); }
    catch { changed.push(`${rel} (missing on disk)`); continue; }
    if (lfHash(disk) !== lfHash(committed)) changed.push(rel);
  }
  if (changed.length) {
    throw new Error(
      `these approval files differ from the reviewed commit ${String(head).slice(0, 12)}: ${changed.join(", ")}. ` +
      "Only the reviewed bytes may create or check Mason's approval; restore them (git checkout -- <file>) and do not edit them locally");
  }
}

/** The approval must still be inside its 30 minutes at the moment of transmission. */
export function assertApprovalStillValid(expiresAt, now = Date.now()) {
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires) || now > expires) throw new Error(`Mason's approval expired at ${expiresAt}`);
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
 * @param {{payload: string, approvedAt: string, via: string}} args.approval
 * @param {object} args.expect  project, migration, queryHash, pullRequest, prHead,
 *   categories ([{category, reason}] exactly as parkedCategories returns them now)
 * @param {string[]|null} [args.appliedNames]  the live ledger snapshot; null skips that check
 * @param {Set<string>} [args.usedNonces]
 * @returns {{ok: true, payload: object, expiresAt: string}|{ok: false, reason: string}}
 */
export function verifyOwnerApproval({ approval, expect, appliedNames = null, usedNonces = new Set(), now = Date.now() }) {
  const no = (reason) => ({ ok: false, reason });
  const payloadText = approval?.payload;
  if (typeof payloadText !== "string" || approval?.via !== OWNER_APPROVAL_VIA) return no("the approval file is malformed");

  let p;
  try { p = JSON.parse(payloadText); } catch { return no("the approval is unreadable"); }
  if (p.purpose !== OWNER_APPROVAL_PURPOSE) return no(`the approval is for "${p.purpose}", not a migration approval`);
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
  // hand-built request keep the category and soften the reason he reads.
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
  const deadline = Date.parse(p.expiresAt);
  const approved = Date.parse(approval.approvedAt);
  if (!Number.isFinite(issued) || !Number.isFinite(deadline) || !Number.isFinite(approved)) return no("the approval has no usable time window");
  if (deadline <= issued || deadline - issued > OWNER_REQUEST_MAX_AGE_MS) return no("the request gave Mason more than 24 hours to reply");
  if (approved < issued) return no("the approval is dated before the request was made");
  if (approved > deadline) return no(`Mason replied after the request expired at ${p.expiresAt}`);
  if (now < approved) return no("the approval is dated in the future");
  const expires = approved + OWNER_APPROVAL_MAX_AGE_MS;
  if (now > expires) return no(`the approval expired at ${new Date(expires).toISOString()}, 30 minutes after Mason replied; ask him again`);
  if (!/^[0-9A-Za-z_-]{1,128}$/.test(String(p.nonce || ""))) return no("the approval has no usable one-time code");
  if (usedNonces.has(String(p.nonce))) return no("this approval was already used; each one works once");
  if (Array.isArray(appliedNames) && appliedNames.includes(expect.migration)) {
    return no(`${expect.migration} is already in the live ledger; an approval covers one install`);
  }
  return { ok: true, payload: p, expiresAt: new Date(expires).toISOString() };
}
