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
// Full post-edit file for Edit/MultiEdit, the Write content otherwise — a MultiEdit
// `edits[]` array used to read as empty content here and this guard allowed it
// (Codex gpt-5.6-sol High on PR #605 at 233dbf3c8; probe-confirmed).
const { content } = judgedContent(filePath, payload?.tool_input);
if (!content) out("allow");

const inSrc = filePath.includes("/src/");
const isFrontendFile = inSrc && /\.(ts|tsx|js|jsx)$/.test(filePath);

// Remove JS/TS comments so the service_role scans judge CODE only. Until PR #605
// (Codex gpt-5.6-sol High at 28bba740b, probe-confirmed) the two scans were instead
// SUPPRESSED by a file-global "no // … service_role comment" test: one comment reading
// "// never use service_role here" anywhere in the file, and a real
// import.meta.env.SUPABASE_SERVICE_ROLE_KEY on the next line was allowed — the comment
// meant to warn about the mistake was the exact string that hid it.
//
// A small state machine rather than a regex: string literals are tracked so a URL
// ("https://…") or a "/* … */" inside quotes is never treated as a comment, and a
// "//" only opens a line comment after start-of-line, whitespace, or one of ;{}), so a
// regex literal such as /\/\// does not swallow the rest of its line. Every branch
// keeps MORE text on doubt: the failure mode of a wrong guess here is a comment that
// survives and produces a refusal Mason can read, never code that vanishes.
function stripComments(src) {
  let out = "";
  let state = "code"; // code | sq | dq | bt | line | block
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    if (state === "line") {
      if (ch === "\n") { state = "code"; out += ch; }
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") { state = "code"; i += 1; out += " "; }
      else if (ch === "\n") out += ch;
      continue;
    }
    if (state !== "code") {
      out += ch;
      if (ch === "\\") { out += next ?? ""; i += 1; continue; }
      if ((state === "sq" && ch === "'") || (state === "dq" && ch === '"') || (state === "bt" && ch === "`")) state = "code";
      continue;
    }
    if (ch === "'") { state = "sq"; out += ch; continue; }
    if (ch === '"') { state = "dq"; out += ch; continue; }
    if (ch === "`") { state = "bt"; out += ch; continue; }
    if (ch === "/" && next === "/") {
      const prev = i === 0 ? "\n" : src[i - 1];
      if (/[\s;{}),]/.test(prev)) { state = "line"; i += 1; continue; }
    }
    if (ch === "/" && next === "*") { state = "block"; i += 1; continue; }
    out += ch;
  }
  return out;
}

if (isFrontendFile) {
  const code = stripComments(content);
  const violations = [];

  // An env-var lookup or any other CODE reference to the key. A comment may say the name.
  if (/SUPABASE_SERVICE_ROLE_KEY/.test(code)) {
    violations.push("SUPABASE_SERVICE_ROLE_KEY referenced in a src/ file (comments are not counted; this is code).");
  }
  // eyJ... is the JWT prefix all Supabase keys share; flag a long literal that looks like one.
  // Anon keys are also eyJ... but a long literal in source is suspicious regardless — use env vars.
  // Judged on the RAW content: a commented-out key is still a key committed to source.
  if (/['"`]eyJ[A-Za-z0-9_-]{40,}['"`]/.test(content)) {
    violations.push("Hard-coded JWT-shaped literal (eyJ...) in source — keys must come from import.meta.env.");
  }
  // 'service_role' as a string value in code.
  if (/['"`]service_role['"`]/.test(code)) {
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
