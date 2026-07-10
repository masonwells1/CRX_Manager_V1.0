#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { evaluateProductionAction, isClearlyReadOnlySql } from "./production-action-guard.mjs";

assert.equal(isClearlyReadOnlySql("select count(*) from invoices"), true);
assert.equal(isClearlyReadOnlySql("with totals as (select 1) select * from totals"), true);
assert.equal(isClearlyReadOnlySql("update invoices set status = 'paid'"), false);
assert.equal(isClearlyReadOnlySql("with changed as (delete from invoices returning *) select * from changed"), false);

assert.equal(evaluateProductionAction({ toolName: "mcp__supabase__execute_sql", toolInput: { query: "select 1" } }).blocked, false);
assert.equal(evaluateProductionAction({ toolName: "mcp__supabase__execute_sql", toolInput: { query: "delete from invoices" } }).blocked, true);
assert.equal(evaluateProductionAction({ toolName: "mcp__supabase__execute_sql", toolInput: { sql: "update invoices set status = 'paid'" } }).blocked, true);
assert.equal(evaluateProductionAction({ toolName: "mcp__supabase__apply_migration" }).blocked, true);
assert.equal(evaluateProductionAction({ toolName: "mcp__supabase__delete_branch" }).blocked, true);
assert.equal(evaluateProductionAction({ toolName: "Bash", toolInput: { command: "git push" }, branch: "main" }).blocked, true);
assert.equal(evaluateProductionAction({ toolName: "Bash", toolInput: { command: "cd app && git push" }, branch: "main" }).blocked, true);
assert.equal(evaluateProductionAction({ toolName: "Bash", toolInput: { command: "git push origin main" }, branch: "feature/setup" }).blocked, true);
assert.equal(evaluateProductionAction({ toolName: "Bash", toolInput: { command: "git push origin feature/setup" }, branch: "feature/setup" }).blocked, false);
assert.equal(evaluateProductionAction({ toolName: "Bash", toolInput: { command: "vercel --prod" } }).blocked, true);
assert.equal(evaluateProductionAction({ toolName: "Bash", toolInput: { command: "npm run build" } }).blocked, false);

const safeProcess = spawnSync(process.execPath, [".codex/hooks/production-action-guard.mjs"], {
  cwd: process.cwd(),
  encoding: "utf8",
  input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm run build" } }),
});
assert.equal(safeProcess.status, 0);
assert.equal(safeProcess.stdout, "");

const blockedProcess = spawnSync(process.execPath, [".codex/hooks/production-action-guard.mjs"], {
  cwd: process.cwd(),
  encoding: "utf8",
  input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "vercel --prod" } }),
});
assert.equal(blockedProcess.status, 0);
assert.match(blockedProcess.stdout, /"permissionDecision":"deny"/);

console.log("OK - production action guard checks passed.");
