#!/usr/bin/env node
// Status-enum guard for CRX Manager.
// Bug pattern: writing 'void' when the DB requires 'voided' (commit 4a25aea).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

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

const isTs = /\.tsx?$/.test(filePath);
const isTest = /\.(test|spec)\.tsx?$/.test(filePath);
const inSrc = filePath.includes("/src/");
if (!isTs || isTest || !inSrc) out("allow");

const content = payload?.tool_input?.content || payload?.tool_input?.new_string || "";
if (!content) out("allow");

if (/\/\/\s*status-enum-check:\s*exempt/.test(content)) out("allow");

const here = path.dirname(fileURLToPath(import.meta.url));
const registryPath = path.join(here, "..", "schema-registry.json");
let registry;
try {
  registry = JSON.parse(readFileSync(registryPath, "utf8"));
} catch {
  out("allow");
}

const enums = registry.status_enums || {};

const violations = [];

const fromRe = /\.from\s*\(\s*['"`]([\w]+)['"`]\s*\)/g;
let fm;
while ((fm = fromRe.exec(content)) !== null) {
  const table = fm[1];
  const after = content.slice(fm.index, fm.index + 800);

  const eqRe = /\.eq\s*\(\s*['"`]([\w]*status)['"`]\s*,\s*['"`]([^'"`]+)['"`]\s*\)/g;
  let em;
  while ((em = eqRe.exec(after)) !== null) {
    const col = em[1];
    const val = em[2];
    const key = `${table}.${col}`;
    if (enums[key] && !enums[key].includes(val)) {
      violations.push(`${table}.${col} = '${val}' (allowed: ${enums[key].map(v => `'${v}'`).join(", ")})`);
    }
  }

  const objRe = /\.(?:update|insert|upsert)\s*\(\s*\{[^}]*?\b([\w]*status)\s*:\s*['"`]([^'"`]+)['"`]/g;
  let om;
  while ((om = objRe.exec(after)) !== null) {
    const col = om[1];
    const val = om[2];
    const key = `${table}.${col}`;
    if (enums[key] && !enums[key].includes(val)) {
      violations.push(`${table}.${col} = '${val}' (allowed: ${enums[key].map(v => `'${v}'`).join(", ")})`);
    }
  }
}

if (violations.length > 0) {
  out("block",
    "STATUS ENUM VIOLATION: " + violations.join(" | ") +
    ". The DB CHECK constraint will reject this at runtime. " +
    "If the CHECK constraint is intentionally being expanded in this change, " +
    "add // status-enum-check: exempt near the top of the file and refresh " +
    ".claude/schema-registry.json after the migration lands.");
}

out("allow");
