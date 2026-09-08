#!/usr/bin/env node
// content-guards-multiedit.test.mjs — the four content guards that judge Write /
// Edit / MultiEdit payloads must see a MultiEdit's `edits[]` array.
//
// Codex gpt-5.6-sol exact-SHA review of PR #605 at 233dbf3c8 (High): money-safety,
// rls-on-new-tables, generated-column-check and env-guard read only
// `content || new_string`, so a MultiEdit produced empty content and each guard
// emitted `allow`. Probe-confirmed before the fix: Edit deny / MultiEdit allow on
// all four. Every deny case below fails against the previous hooks.
//
// Run: node .claude/hooks/content-guards-multiedit.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;

function run(hook, toolName, toolInput) {
  const r = spawnSync(process.execPath, [path.join(here, hook)], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `${hook} exited ${r.status}: ${r.stderr}`);
  const m = /"permissionDecision":"(allow|deny)"/.exec(r.stdout);
  return m ? m[1] : "silent";
}
function deny(hook, toolName, toolInput, why) {
  assert.equal(run(hook, toolName, toolInput), "deny", `must deny (${hook}, ${toolName}): ${why}`);
  pass++;
}
function allow(hook, toolName, toolInput, why) {
  assert.equal(run(hook, toolName, toolInput), "allow", `must allow (${hook}, ${toolName}): ${why}`);
  pass++;
}

// A scratch tree whose paths satisfy each guard's path filter (`/src/` + .ts,
// `supabase/migrations/` + .sql). Unique per run; nothing is deleted.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "crx-content-guards-"));
const tsPath = path.join(root, "src", "lib", "money.ts");
const sqlPath = path.join(root, "supabase", "migrations", "20260909000000_probe.sql");
fs.mkdirSync(path.dirname(tsPath), { recursive: true });
fs.mkdirSync(path.dirname(sqlPath), { recursive: true });
const missingTs = path.join(root, "src", "lib", "does-not-exist.ts");
const missingSql = path.join(root, "supabase", "migrations", "20260909000001_missing.sql");

// ── money-safety ────────────────────────────────────────────────────────────
const floatCents = "const v = parseFloat(totalCents);";
deny("money-safety.mjs", "Edit", { file_path: missingTs, old_string: "a", new_string: floatCents }, "Edit fragment");
deny("money-safety.mjs", "MultiEdit", { file_path: missingTs, edits: [{ old_string: "a", new_string: "const ok = 1;" }, { old_string: "b", new_string: floatCents }] }, "MultiEdit fragment, second edit");
deny("money-safety.mjs", "Write", { file_path: missingTs, content: floatCents }, "Write content");
allow("money-safety.mjs", "MultiEdit", { file_path: missingTs, edits: [{ old_string: "a", new_string: "const cents = Math.round(dollars * 100);" }] }, "clean MultiEdit");
// Reconstruction: the violation only exists once the edits land on the real file.
fs.writeFileSync(tsPath, "export const a = 1;\r\nconst total = parseInt(raw, 10);\r\n");
deny("money-safety.mjs", "MultiEdit", { file_path: tsPath, edits: [{ old_string: "parseInt(raw, 10)", new_string: "parseFloat(rawCents)" }] }, "MultiEdit spliced onto a CRLF file");
allow("money-safety.mjs", "MultiEdit", { file_path: tsPath, edits: [{ old_string: "export const a = 1;", new_string: "export const a = 2;" }] }, "unrelated MultiEdit on a clean file");

// ── rls-on-new-tables ───────────────────────────────────────────────────────
const bareTable = "CREATE TABLE public.probe_t (id uuid primary key);";
deny("rls-on-new-tables.mjs", "MultiEdit", { file_path: missingSql, edits: [{ old_string: "a", new_string: bareTable }] }, "MultiEdit creates a table without RLS");
deny("rls-on-new-tables.mjs", "Edit", { file_path: missingSql, old_string: "a", new_string: bareTable }, "Edit creates a table without RLS");
allow("rls-on-new-tables.mjs", "MultiEdit", { file_path: missingSql, edits: [{ old_string: "a", new_string: bareTable + " ALTER TABLE public.probe_t ENABLE ROW LEVEL SECURITY; CREATE POLICY p ON public.probe_t FOR SELECT USING (true);" }] }, "MultiEdit with RLS + policy");
// Reconstruction: deleting the ENABLE line from a compliant file is a violation;
// a file-level exempt marker elsewhere in the file is visible to a fragment edit.
fs.writeFileSync(sqlPath, bareTable + "\nALTER TABLE public.probe_t ENABLE ROW LEVEL SECURITY;\nCREATE POLICY p ON public.probe_t FOR SELECT USING (true);\n");
deny("rls-on-new-tables.mjs", "MultiEdit", { file_path: sqlPath, edits: [{ old_string: "ALTER TABLE public.probe_t ENABLE ROW LEVEL SECURITY;\n", new_string: "" }] }, "MultiEdit deletes ENABLE ROW LEVEL SECURITY");
deny("rls-on-new-tables.mjs", "Edit", { file_path: sqlPath, old_string: "ALTER TABLE public.probe_t ENABLE ROW LEVEL SECURITY;\n", new_string: "" }, "Edit deletes ENABLE ROW LEVEL SECURITY");
allow("rls-on-new-tables.mjs", "MultiEdit", { file_path: sqlPath, edits: [{ old_string: "FOR SELECT", new_string: "FOR ALL" }] }, "unrelated MultiEdit on a compliant file");
fs.writeFileSync(sqlPath, "-- rls-check: exempt (probe junction table)\n" + bareTable + "\n");
allow("rls-on-new-tables.mjs", "MultiEdit", { file_path: sqlPath, edits: [{ old_string: "id uuid primary key", new_string: "id uuid primary key, note text" }] }, "file-level exempt marker seen through a MultiEdit");

// ── generated-column-check (registry lists invoices.balance_cents as GENERATED) ──
const genWrite = 'await db.from("invoices").update({ balance_cents: 0 }).eq("id", id);';
deny("generated-column-check.mjs", "MultiEdit", { file_path: missingTs, edits: [{ old_string: "a", new_string: genWrite }] }, "MultiEdit writes a GENERATED column");
deny("generated-column-check.mjs", "Edit", { file_path: missingTs, old_string: "a", new_string: genWrite }, "Edit writes a GENERATED column");
allow("generated-column-check.mjs", "MultiEdit", { file_path: missingTs, edits: [{ old_string: "a", new_string: 'await db.from("invoices").update({ paid_amount_cents: 0 }).eq("id", id);' }] }, "MultiEdit writes a source column");
fs.writeFileSync(tsPath, 'await db.from("invoices").update({ paid_amount_cents: 0 }).eq("id", id);\n');
deny("generated-column-check.mjs", "MultiEdit", { file_path: tsPath, edits: [{ old_string: "paid_amount_cents", new_string: "balance_cents" }] }, "MultiEdit spliced onto disk turns a source-column write into a GENERATED write");

// ── env-guard ───────────────────────────────────────────────────────────────
const roleKey = "const k = import.meta.env.SUPABASE_SERVICE_ROLE_KEY;";
deny("env-guard.mjs", "MultiEdit", { file_path: missingTs, edits: [{ old_string: "a", new_string: roleKey }] }, "MultiEdit references the service_role key");
deny("env-guard.mjs", "Edit", { file_path: missingTs, old_string: "a", new_string: roleKey }, "Edit references the service_role key");
deny("env-guard.mjs", "MultiEdit", { file_path: missingTs, edits: [{ old_string: "a", new_string: "const role = 'service_role';" }] }, "MultiEdit service_role literal");
allow("env-guard.mjs", "MultiEdit", { file_path: missingTs, edits: [{ old_string: "a", new_string: "const k = import.meta.env.VITE_SUPABASE_ANON_KEY;" }] }, "MultiEdit anon key");
fs.writeFileSync(tsPath, "const k = import.meta.env.VITE_SUPABASE_ANON_KEY;\n");
deny("env-guard.mjs", "MultiEdit", { file_path: tsPath, edits: [{ old_string: "VITE_SUPABASE_ANON_KEY", new_string: "SUPABASE_SERVICE_ROLE_KEY" }] }, "MultiEdit spliced onto disk swaps anon for service_role");
// Rule 1 is path-based and unaffected: any .env write denies regardless of shape.
deny("env-guard.mjs", "MultiEdit", { file_path: path.join(root, ".env"), edits: [{ old_string: "a", new_string: "b" }] }, "MultiEdit on .env");
// Codex gpt-5.6-sol High on PR #605 at 28bba740b: a "never use service_role" comment
// anywhere in the file used to suppress the real scan. Comments are stripped, not obeyed.
const warnedThenUsed = "// never use service_role here\nconst k = import.meta.env.SUPABASE_SERVICE_ROLE_KEY;";
deny("env-guard.mjs", "MultiEdit", { file_path: missingTs, edits: [{ old_string: "a", new_string: warnedThenUsed }] }, "MultiEdit: warning comment does not suppress the key lookup");
deny("env-guard.mjs", "Write", { file_path: missingTs, content: warnedThenUsed }, "Write: warning comment does not suppress the key lookup");
deny("env-guard.mjs", "Edit", { file_path: missingTs, old_string: "a", new_string: "/* service_role is banned */ const r = 'service_role';" }, "Edit: block comment does not suppress the literal");
deny("env-guard.mjs", "Write", { file_path: missingTs, content: "const u = 'https://x.co'; const k = import.meta.env.SUPABASE_SERVICE_ROLE_KEY;" }, "Write: a URL's // is not a comment opener");
deny("env-guard.mjs", "Write", { file_path: missingTs, content: "const re = /\\/\\//; const k = import.meta.env.SUPABASE_SERVICE_ROLE_KEY;" }, "Write: a regex literal's // is not a comment opener");
allow("env-guard.mjs", "Write", { file_path: missingTs, content: "// SUPABASE_SERVICE_ROLE_KEY must never be read here\nconst k = import.meta.env.VITE_SUPABASE_ANON_KEY;" }, "Write: a comment-only mention of the key is fine");
allow("env-guard.mjs", "MultiEdit", { file_path: missingTs, edits: [{ old_string: "a", new_string: "/* 'service_role' belongs in Edge Functions */\nconst role = 'authenticated';" }] }, "MultiEdit: a comment-only mention of the literal is fine");
deny("env-guard.mjs", "Write", { file_path: missingTs, content: "const s = \"see // docs\"; const k = import.meta.env.SUPABASE_SERVICE_ROLE_KEY;" }, "Write: a // inside a string does not hide the key lookup after it");
// CodeRabbit Major on PR #605 at 537625b59 (probe-confirmed): stripComments had no regex
// state, so the "/*" inside a character class opened a block comment that never closed
// and everything after it vanished before the scan.
deny("env-guard.mjs", "Write", { file_path: missingTs, content: "const re = /[/*]/; const k = import.meta.env.SUPABASE_SERVICE_ROLE_KEY;" }, "PROVEN BYPASS: a /[/*]/ character class does not open a block comment before the key lookup");
deny("env-guard.mjs", "Write", { file_path: missingTs, content: "const re = /[/*]/;\nconst role = 'service_role';" }, "a /[/*]/ character class does not hide a service_role literal on the next line");
deny("env-guard.mjs", "Write", { file_path: missingTs, content: "const re = /a\\/*b/; const k = import.meta.env.SUPABASE_SERVICE_ROLE_KEY;" }, "an escaped slash followed by * inside a regex does not open a block comment");
deny("env-guard.mjs", "Edit", { file_path: missingTs, old_string: "a", new_string: "function f() { return /[/*]/; }\nconst k = import.meta.env.SUPABASE_SERVICE_ROLE_KEY;" }, "a regex after the return keyword is a regex, not division then a comment");
deny("env-guard.mjs", "Write", { file_path: missingTs, content: "if (x) /[/*]/.test(y);\nconst k = import.meta.env.SUPABASE_SERVICE_ROLE_KEY;" }, "a regex after an if (…) head is a regex, not division then a comment");
// CodeRabbit Major on 06f0039a2: ")" always counted as a regex start, so a division after a
// parenthesized expression swallowed the line comment after it and refused benign code.
allow("env-guard.mjs", "Write", { file_path: missingTs, content: "const half = (total + fee) / 2; // 'service_role'\nconst k = import.meta.env.VITE_SUPABASE_ANON_KEY;" }, "PROVEN FALSE REFUSAL: division after a parenthesized expression, so the line comment after it is stripped");
allow("env-guard.mjs", "Write", { file_path: missingTs, content: "const avg = arr[0] / 2; // SUPABASE_SERVICE_ROLE_KEY is banned here\nconst k = import.meta.env.VITE_SUPABASE_ANON_KEY;" }, "division after an index expression, so the line comment after it is stripped");
allow("env-guard.mjs", "Write", { file_path: missingTs, content: "const r = f(a, g(b)) / 2; /* 'service_role' */ const k = import.meta.env.VITE_SUPABASE_ANON_KEY;" }, "division after a nested call, so the block comment after it is stripped");
deny("env-guard.mjs", "Write", { file_path: missingTs, content: "while (y) /[/*]/.test(z);\nconst k = import.meta.env.SUPABASE_SERVICE_ROLE_KEY;" }, "a regex after a while (…) head is still a regex, so the key lookup after it is scanned");
deny("env-guard.mjs", "Write", { file_path: missingTs, content: "const t = (a + b) / c; /* x */ const k = import.meta.env.SUPABASE_SERVICE_ROLE_KEY;" }, "division after a group, then a real comment, still exposes the key lookup after it");
deny("env-guard.mjs", "MultiEdit", { file_path: missingTs, edits: [{ old_string: "a", new_string: "const re = /[/*]/; /* real comment */ const k = import.meta.env.SUPABASE_SERVICE_ROLE_KEY;" }] }, "MultiEdit: a class regex followed by a real comment still exposes the key lookup after it");
allow("env-guard.mjs", "Write", { file_path: missingTs, content: "const x = a / b; /* 'service_role' lives in Edge Functions */\nconst k = import.meta.env.VITE_SUPABASE_ANON_KEY;" }, "division after an identifier is not a regex, so the real comment after it is still stripped");
allow("env-guard.mjs", "Write", { file_path: missingTs, content: "const re = /[/*]/; // 'service_role' is banned here\nconst k = import.meta.env.VITE_SUPABASE_ANON_KEY;" }, "a class regex closes cleanly and the line comment after it is still stripped");
allow("env-guard.mjs", "Write", { file_path: missingTs, content: "const re = /x\\/y/; /* 'service_role' */ const k = import.meta.env.VITE_SUPABASE_ANON_KEY;" }, "a regex with an escaped slash closes cleanly and the block comment after it is still stripped");

console.log(`content-guards-multiedit: ${pass} assertions passed`);
