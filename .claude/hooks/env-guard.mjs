#!/usr/bin/env node
// Env file & service_role key guard for CRX Manager.
// Blocks two classes of mistake:
//   1. Writing/editing any .env* file via Claude (forces Mason to do it manually
//      so secrets aren't echoed back through model context or transcripts).
//   2. Pasting a SUPABASE_SERVICE_ROLE_KEY value (or any "service_role" literal)
//      into ANY file under src/ — service_role must NEVER ship to the frontend.
//
// Rules match the existing hook style: fail-open if no content visible.

import { readFileSync } from "node:fs";

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

const filePath = (payload?.tool_input?.file_path || "").replace(/\\/g, "/");
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
const content = payload?.tool_input?.content || payload?.tool_input?.new_string || "";
if (!content) out("allow");

const inSrc = filePath.includes("/src/");
const isFrontendFile = inSrc && /\.(ts|tsx|js|jsx)$/.test(filePath);

if (isFrontendFile) {
  // Look for the service_role token. Allow comments explaining "do not use service_role" — the
  // pattern that's dangerous is an actual env-var lookup or string literal.
  const violations = [];

  if (/SUPABASE_SERVICE_ROLE_KEY/.test(content) && !/\/\/.*never.*service_role/i.test(content)) {
    violations.push("SUPABASE_SERVICE_ROLE_KEY referenced in a src/ file.");
  }
  // eyJ... is the JWT prefix all Supabase keys share; flag a long literal that looks like one.
  // Anon keys are also eyJ... but a long literal in source is suspicious regardless — use env vars.
  if (/['"`]eyJ[A-Za-z0-9_-]{40,}['"`]/.test(content)) {
    violations.push("Hard-coded JWT-shaped literal (eyJ...) in source — keys must come from import.meta.env.");
  }
  // 'service_role' as a string value (not a comment) — heuristic
  if (/['"`]service_role['"`]/.test(content) && !/\/\/.*service_role/i.test(content)) {
    violations.push("'service_role' string literal in src/ — this role belongs only in Edge Functions.");
  }

  if (violations.length > 0) {
    out("block",
      "ENV GUARD: " + violations.join(" | ") +
      " CRX Manager rule: service_role NEVER leaves Edge Functions. Frontend uses anon key only, " +
      "read from import.meta.env.VITE_SUPABASE_ANON_KEY.");
  }
}

out("allow");
