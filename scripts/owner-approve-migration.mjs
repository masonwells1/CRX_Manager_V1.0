#!/usr/bin/env node
// Ask Mason to approve ONE parked migration by chat reply (Mason, 2026-09-29;
// by reply instead of Windows Hello since 2026-10-09, so he can do it from his phone).
//
// A migration that deletes data, overwrites existing rows or changes who can
// access what is refused by .claude/hooks/migration-apply-lib.mjs until Mason
// approves it. This script builds the REQUEST he approves — computed here from the
// file itself, never from text an agent supplies — saves it in this checkout's
// .claude/session-state/, and prints the plain-English summary and a 6-digit code.
// Show him the summary and ask him to reply exactly `approve <code>`. His reply is
// recorded by .claude/hooks/owner-approval-prompt.mjs and is good for ONE install
// of this exact file, from this exact pull-request head, for 30 minutes.
//
// Never send the reply yourself, in any session: only a message Mason sends counts.
//
// Run it from the pull request's own checkout, in the session that will apply it,
// only once every other proof for the file is fresh. Mason must reply in THAT
// session: the reply hook only looks in the folders of the session he replies in.
//   node scripts/owner-approve-migration.mjs supabase/migrations/<file>.sql
// then, after his reply, apply with:
//   node scripts/apply-migration-file.mjs supabase/migrations/<file>.sql [--confirm]
//
// To check the reply path works (approves nothing):
//   node scripts/owner-approve-migration.mjs --selftest

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { CRX_PRODUCTION_REF } from "../.claude/hooks/migration-apply-lib.mjs";
import { readMigrationHistory } from "../.claude/hooks/migration-access-lib.mjs";
import {
  OWNER_REQUEST_MAX_AGE_MS,
  PARKED_LABELS,
  assertOwnerTrustFilesReviewed,
  buildApprovalPayload,
  buildSelfTestPayload,
  newApprovalCode,
  ownerApprovalSummary,
  parkedCategories,
  writeApprovalRequest,
} from "../.claude/hooks/owner-approval-lib.mjs";

function die(code, msg) {
  console.error(msg);
  process.exit(code);
}

const checkout = process.cwd();
const stateDir = path.join(checkout, ".claude", "session-state");

/** Save the request under a fresh code; retry if that code is already pending here. */
function saveRequest(build) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newApprovalCode();
    const payload = build(code);
    try { return { code, payload, file: writeApprovalRequest(stateDir, payload) }; }
    catch (err) { if (err?.code !== "EEXIST") die(1, `owner-approve-migration: could not save the request (${err?.message || err}).`); }
  }
  return die(1, "owner-approve-migration: could not find a free code; try again.");
}

const argv = process.argv.slice(2);

if (argv.length === 1 && argv[0] === "--selftest") {
  const now = Date.now();
  const { code, payload } = saveRequest((c) => buildSelfTestPayload({
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + OWNER_REQUEST_MAX_AGE_MS).toISOString(),
    nonce: randomBytes(16).toString("hex"),
    code: c,
  }));
  console.log("Show Mason this, word for word:\n");
  for (const line of ownerApprovalSummary(JSON.parse(payload))) console.log(`  ${line}`);
  console.log(`\nWhen he replies "approve ${code}", the approval hook confirms in the next turn that the reply path works.`);
  process.exit(0);
}

const filePath = argv.find((a) => !a.startsWith("--"));
if (!filePath || argv.length !== 1) {
  die(1, "owner-approve-migration: give exactly one migration file (or --selftest).\n  node scripts/owner-approve-migration.mjs supabase/migrations/<file>.sql");
}

const real = (p) => { try { return realpathSync(p); } catch { return null; } };
const key = (p) => (process.platform === "win32" ? String(p).toLowerCase() : String(p));
const absFile = path.resolve(checkout, filePath);
const migDir = real(path.join(checkout, "supabase", "migrations"));
const realFile = real(absFile);
if (!realFile || !migDir || key(path.dirname(realFile)) !== key(migDir) || !/\.sql$/i.test(realFile)) {
  die(1, `owner-approve-migration: ${absFile} is not a migration file directly inside this checkout's supabase/migrations/.`);
}

const sql = readFileSync(realFile, "utf8").replace(/\r\n/g, "\n");
const migName = path.basename(realFile).replace(/\.sql$/i, "");
const queryHash = createHash("sha256").update(sql).digest("hex");

// What the safety check parks — the same classifiers, the same history.
let history;
try { history = readMigrationHistory(path.dirname(realFile), path.basename(realFile)); } catch { history = undefined; }
const categories = parkedCategories(sql, { history });
if (!categories.length) {
  die(1,
    `owner-approve-migration: ${migName} does not need Mason's approval — the safety check does not park it. ` +
    `It applies through the normal proofs; do not ask him to approve it.`);
}

// The pull request the approval is bound to: this checkout's branch, open, at this exact head.
const git = (args) => String(execFileSync("git", args, { cwd: checkout, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] })).trim();
let head;
let branch;
try {
  head = git(["rev-parse", "HEAD"]);
  branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
} catch (err) {
  die(1, `owner-approve-migration: could not read this checkout's HEAD (${err?.message || err}).`);
}
const rel = path.relative(checkout, realFile).split(path.sep).join("/");
try {
  git(["cat-file", "-e", `HEAD:${rel}`]);
  if (git(["status", "--porcelain", "--untracked-files=all", "--", rel])) throw new Error("uncommitted changes");
} catch {
  die(1, `owner-approve-migration: ${rel} must be committed at HEAD with no local changes, or the apply will refuse the approval.`);
}
let pr;
try {
  pr = JSON.parse(String(execFileSync("gh", ["pr", "view", branch, "--json", "number,state,headRefOid,baseRefName"], {
    cwd: checkout, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
  })));
} catch (err) {
  die(1, `owner-approve-migration: could not find the open pull request for branch "${branch}" (${err?.message || err}).`);
}
if (String(pr?.state).toUpperCase() !== "OPEN" || String(pr?.baseRefName) !== "main" || String(pr?.headRefOid).toLowerCase() !== head.toLowerCase()) {
  die(1,
    `owner-approve-migration: pull request #${pr?.number ?? "?"} must be open against main with head ${head.slice(0, 12)} ` +
    `(GitHub: state ${pr?.state}, base ${pr?.baseRefName}, head ${String(pr?.headRefOid || "?").slice(0, 12)}). Push first.`);
}

// The reply hook and the code building what Mason reads must be the reviewed
// bytes at this head, so he never approves through a locally edited summary or
// hook (Sol HIGH, PR #857). The apply checks the same again.
try { assertOwnerTrustFilesReviewed({ head }); }
catch (err) { die(1, `owner-approve-migration: ${err?.message || err}. Refusing.`); }

const now = Date.now();
const { code, payload } = saveRequest((c) => buildApprovalPayload({
  project: CRX_PRODUCTION_REF,
  migration: migName,
  queryHash,
  pullRequest: pr.number,
  prHead: head,
  categories,
  issuedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + OWNER_REQUEST_MAX_AGE_MS).toISOString(),
  nonce: randomBytes(16).toString("hex"),
  code: c,
}));

console.log(`Approval request saved for ${migName} (PR #${pr.number}, head ${head.slice(0, 12)}):`);
for (const c of categories) console.log(`  - ${PARKED_LABELS[c.category]}`);
console.log("\nShow Mason this, word for word, with a one-line plain-English note on what the change does:\n");
for (const line of ownerApprovalSummary(JSON.parse(payload))) console.log(`  ${line}`);
console.log(`\nThen wait for HIS reply "approve ${code}" in this session — never send or relay it for him. The approval hook confirms it in the next turn.`);
console.log(`After that: node scripts/apply-migration-file.mjs ${rel} (dry run), then again with --confirm, within 30 minutes.`);
