#!/usr/bin/env node
// Tests for stop-verify's proof-detection + change-scope logic.
// Run: node .claude/hooks/stop-verify-lib.test.mjs

import assert from "node:assert/strict";
import { hasVerificationEvidence, isWatchedCodeChange } from "./stop-verify-lib.mjs";

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; }

// ── hasVerificationEvidence: a PROOF block satisfies it ──────────────────
ok(hasVerificationEvidence("PROOF — Ran: npm test  Saw: 2222 pass  Not verified: nothing"), "PROOF em-dash");
ok(hasVerificationEvidence("PROOF: opened /invoices and saw the new total"), "PROOF colon");
ok(hasVerificationEvidence("PROOF Ran: opened the page"), "PROOF Ran");
ok(hasVerificationEvidence("proof — saw the row"), "lowercase proof");

// ── hasVerificationEvidence: real end-state evidence satisfies it ────────
ok(hasVerificationEvidence('assistant called preview_screenshot on the page'), "preview_screenshot");
ok(hasVerificationEvidence('{"name":"mcp__Claude_Preview__preview_inspect"}'), "preview inspect tool");
ok(hasVerificationEvidence('{"name":"WebFetch","input":{}}'), "WebFetch");
ok(hasVerificationEvidence("fetched https://croprxsolutions.app and hash changed"), "prod url fetch");
ok(hasVerificationEvidence("execute_sql  BEGIN; <mig>; ROLLBACK;"), "sql smoke");

// ── hasVerificationEvidence: MUST be false for tests-pass-only / no proof ─
ok(!hasVerificationEvidence("I ran npm run build and npm run test — all 2222 pass"), "tests-pass alone is NOT proof");
ok(!hasVerificationEvidence("the code looks correct and should work"), "assertion is not proof");
ok(!hasVerificationEvidence("build is clean"), "build-clean is not proof");
ok(!hasVerificationEvidence(""), "empty");
ok(!hasVerificationEvidence(null), "null");

// ── isWatchedCodeChange: fires on real code in watched dirs ──────────────
ok(isWatchedCodeChange(" M src/pages/Invoices.tsx"), "src tsx");
ok(isWatchedCodeChange("?? supabase/migrations/20260101_x.sql"), "new migration");
ok(isWatchedCodeChange(" M supabase/functions/send-email/index.ts"), "edge fn ts");
ok(isWatchedCodeChange(" M scripts/foo.mjs"), "scripts mjs");
ok(isWatchedCodeChange("MM src/lib/db.ts"), "MM transition");

// ── isWatchedCodeChange: silent on out-of-scope / non-code ───────────────
ok(!isWatchedCodeChange(" M docs/readme.md"), "docs not watched");
ok(!isWatchedCodeChange(" M .claude/hooks/x.mjs"), ".claude not watched");
ok(!isWatchedCodeChange(" M src/styles.css"), "css is not code ext");
ok(!isWatchedCodeChange(" M package.json"), "root json not watched");
ok(!isWatchedCodeChange(""), "empty line");
ok(!isWatchedCodeChange(" M x"), "too short");

console.log(`stop-verify-lib: ${pass} assertions passed`);
