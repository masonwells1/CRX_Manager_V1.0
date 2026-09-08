#!/usr/bin/env node
// Env file & service_role key guard for CRX Manager.
// Blocks two classes of mistake:
//   1. Writing/editing any .env* file via Claude (forces Mason to do it manually
//      so secrets aren't echoed back through model context or transcripts).
//   2. Pasting a SUPABASE_SERVICE_ROLE_KEY value (or any "service_role" literal)
//      into ANY file under src/ — service_role must NEVER ship to the frontend.
//
// Rules match the existing hook style: fail-open if no content visible at all; the
// content judged is the FULL post-edit file (Write content, or Edit/MultiEdit spliced
// onto the on-disk file).

import { readFileSync } from "node:fs";
import { judgedContent } from "./edit-splice-lib.mjs";
import { canonicalToolPath } from "./autopilot-lib.mjs";

function out(decision, reason) {
  const payload = decision === "block"
    ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
    : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  out("allow");
}

// Judge the path Windows would OPEN, not the spelling that arrived. Codex gpt-5.6-sol High on
// d1bbf5ac6, probe-confirmed: `.env `, `C:.env` and `.env::$DATA` all passed rule 1 although
// each opens .env (trailing space and period are stripped by the Win32 normaliser, a
// drive-relative prefix lands on the current directory, `::$DATA` is the file's own stream).
// canonicalToolPath() applies those rules; the raw spelling is kept only for the message.
const rawPath = (payload?.tool_input?.file_path || "").replace(/\\/g, "/");
const filePath = canonicalToolPath(rawPath) || rawPath;
if (!filePath) out("allow");

// RULE 1 — block any .env* file edit
// Allow .env.example (template, no secrets) and any *.md file mentioning .env in its name.
const basename = filePath.split("/").pop() || "";
const isEnvFile = /^\.env(\.|$)/.test(basename);
const isExample = /\.example$/.test(basename) || /\.template$/.test(basename) || /\.sample$/.test(basename);

if (isEnvFile && !isExample) {
  out("block",
    `ENV GUARD: Refusing to write/edit ${basename}. Env files contain secrets (Supabase service_role, ` +
    `Resend API key, etc.) that must never pass through model context. Mason: edit this file yourself ` +
    `in your editor. To bypass for a legitimate reason, rename target to .env.example first.`);
}

// RULE 2 — block service_role literals in frontend code
// Full post-edit file for Edit/MultiEdit, the Write content otherwise — a MultiEdit
// `edits[]` array used to read as empty content here and this guard allowed it
// (Codex gpt-5.6-sol High on PR #605 at 233dbf3c8; probe-confirmed).
const { content } = judgedContent(filePath, payload?.tool_input);
if (!content) out("allow");

const inSrc = filePath.includes("/src/");
const isFrontendFile = inSrc && /\.(ts|tsx|js|jsx)$/.test(filePath);

// The service_role scans judge the RAW content, comments included. Three attempts to
// strip comments first were each defeated by valid input during PR #605: the pre-605
// code SUPPRESSED the scan whenever a "// … service_role" comment existed anywhere in
// the file (Codex High at 28bba740b); a string/regex-aware stripper was opened by the
// "/*" inside the character class /[/*]/ (CodeRabbit on 537625b59); the regex-aware one
// was opened by JSX text — `<div>/*</div>` — (Codex High at fdce1aa53) and, by the same
// mechanism, by a nested template literal (`${`/*`}`). Nothing short of a full TSX
// parser can be sound here, and the cost of the sound choice is small: a comment that
// merely names SUPABASE_SERVICE_ROLE_KEY or quotes 'service_role' is refused with a
// message that says so, and the author rewords it (src/ carries no such comment today;
// the JWT-literal scan below was always on the raw content). The failure mode is a
// refusal Mason can read, never code that vanishes before the scan.

if (isFrontendFile) {
  const code = content;
  const violations = [];

  // An env-var lookup or any other reference to the key, comments included (see above).
  if (/SUPABASE_SERVICE_ROLE_KEY/.test(code)) {
    violations.push("SUPABASE_SERVICE_ROLE_KEY referenced in a src/ file (comments count too — the scan is on the raw text; reword a comment that names it).");
  }
  // eyJ... is the JWT prefix all Supabase keys share; flag a long literal that looks like one.
  // Anon keys are also eyJ... but a long literal in source is suspicious regardless — use env vars.
  // Judged on the RAW content: a commented-out key is still a key committed to source.
  if (/['"`]eyJ[A-Za-z0-9_-]{40,}['"`]/.test(content)) {
    violations.push("Hard-coded JWT-shaped literal (eyJ...) in source — keys must come from import.meta.env.");
  }
  // 'service_role' as a string value in code.
  if (/['"`]service_role['"`]/.test(code)) {
    violations.push("'service_role' string literal in src/ — this role belongs only in Edge Functions (a comment quoting it is refused too; reword it).");
  }

  if (violations.length > 0) {
    out("block",
      "ENV GUARD: " + violations.join(" | ") +
      " CRX Manager rule: service_role NEVER leaves Edge Functions. Frontend uses anon key only, " +
      "read from import.meta.env.VITE_SUPABASE_ANON_KEY.");
  }
}

out("allow");
