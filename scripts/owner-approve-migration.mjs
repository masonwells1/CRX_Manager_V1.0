#!/usr/bin/env node
// Ask Mason to approve ONE parked migration with Windows Hello (Mason, 2026-09-29).
//
// A migration that deletes data, overwrites existing rows or changes who can
// access what is refused by .claude/hooks/migration-apply-lib.mjs until Mason
// signs it. This script builds what he signs — computed here from the file
// itself, never from text an agent supplies — shows it to him, and asks Windows
// Hello for his PIN or fingerprint. The signed approval is written to this
// checkout's .claude/session-state/ and is good for ONE install of this exact
// file, from this exact pull-request head, for 30 minutes.
//
// It never replaces Mason's explicit yes in the current conversation (AGENTS.md;
// Codex P1, PR #845): ask him in chat first, then run this. The signature is the
// part the apply gate can verify; the chat yes is the part it cannot.
//
// Run it from the pull request's own checkout, with Mason at the PC, only once
// every other proof for the file is fresh — the approval expires in 30 minutes:
//   node scripts/owner-approve-migration.mjs supabase/migrations/<file>.sql
// then apply with:
//   node scripts/apply-migration-file.mjs supabase/migrations/<file>.sql [--confirm]

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CRX_PRODUCTION_REF } from "../.claude/hooks/migration-apply-lib.mjs";
import { readMigrationHistory } from "../.claude/hooks/migration-access-lib.mjs";
import {
  OWNER_APPROVAL_MAX_AGE_MS,
  PARKED_LABELS,
  approvalFileName,
  assertOwnerTrustFilesReviewed,
  buildApprovalPayload,
  parkedCategories,
  readLiveOwnerKey,
  readPinnedOwnerKey,
  runHello,
  verifyOwnerApproval,
} from "../.claude/hooks/owner-approval-lib.mjs";

function die(code, msg) {
  console.error(msg);
  process.exit(code);
}

const argv = process.argv.slice(2);
const filePath = argv.find((a) => !a.startsWith("--"));
if (!filePath || argv.length !== 1) {
  die(1, "owner-approve-migration: give exactly one migration file.\n  node scripts/owner-approve-migration.mjs supabase/migrations/<file>.sql");
}

const checkout = process.cwd();
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
const safeName = migName.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "unknown";

// What the safety check parks — the same classifiers, the same history.
let history;
try { history = readMigrationHistory(path.dirname(realFile), path.basename(realFile)); } catch { history = undefined; }
const categories = parkedCategories(sql, { history });
if (!categories.length) {
  die(1,
    `owner-approve-migration: ${migName} does not need Mason's approval — the safety check does not park it. ` +
    `It applies through the normal proofs; do not ask him to sign it.`);
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

// The key, the Windows Hello helper and the code building what Mason signs must be
// the reviewed bytes at this head, so he never signs through a locally edited
// helper or summary (Sol HIGH, PR #857). The apply checks the same again.
try { assertOwnerTrustFilesReviewed({ head }); }
catch (err) { die(1, `owner-approve-migration: ${err?.message || err}. Refusing.`); }

// Both halves of the key must agree before Mason is asked anything.
let keys;
try { keys = { pinned: readPinnedOwnerKey(), live: readLiveOwnerKey() }; }
catch (err) { die(1, `owner-approve-migration: ${err?.message || err}.`); }
if (!keys.pinned.equals(keys.live)) {
  die(1, "owner-approve-migration: the committed approval key is not the Windows Hello key on this PC. Refusing.");
}

const now = Date.now();
const payload = buildApprovalPayload({
  project: CRX_PRODUCTION_REF,
  migration: migName,
  queryHash,
  pullRequest: pr.number,
  prHead: head,
  categories,
  issuedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + OWNER_APPROVAL_MAX_AGE_MS).toISOString(),
  nonce: randomBytes(16).toString("hex"),
});

console.log(`Asking Mason to approve ${migName} (PR #${pr.number}, head ${head.slice(0, 12)}):`);
for (const c of categories) console.log(`  - ${PARKED_LABELS[c.category]}`);
console.log("A window will open on his screen, then Windows Hello will ask for his PIN or fingerprint.");

const tmp = mkdtempSync(path.join(os.tmpdir(), "crx-owner-approval-"));
const payloadFile = path.join(tmp, "payload.json");
let result;
try {
  writeFileSync(payloadFile, payload, "utf8");
  result = runHello("Sign", { payloadFile, timeoutMs: 10 * 60 * 1000 });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (!result?.ok || !result.signature) {
  die(3, `NOT APPROVED — ${result?.status === "Declined" ? "Mason clicked No" : `Windows Hello did not sign (${result?.status || "no answer"}${result?.message ? `: ${result.message}` : ""})`}. Nothing was written.`);
}

const approval = { payload, signature: result.signature };
const check = verifyOwnerApproval({
  approval,
  expect: { project: CRX_PRODUCTION_REF, migration: migName, queryHash, pullRequest: pr.number, prHead: head, categories },
  keys,
  now: Date.now(),
});
if (!check.ok) die(2, `owner-approve-migration: the signature did not verify (${check.reason}). Nothing was written.`);

const stateDir = path.join(checkout, ".claude", "session-state");
mkdirSync(stateDir, { recursive: true });
const out = path.join(stateDir, approvalFileName(safeName));
if (existsSync(out)) rmSync(out);
writeFileSync(out, `${JSON.stringify(approval, null, 2)}\n`, "utf8");
console.log("");
console.log(`APPROVED by Mason with Windows Hello. Valid once, until ${check.payload.expiresAt}.`);
console.log(`Saved: ${out}`);
console.log(`Next: node scripts/apply-migration-file.mjs ${rel} (dry run), then again with --confirm.`);
