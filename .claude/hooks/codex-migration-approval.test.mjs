import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const config = readFileSync(path.join(root, ".codex", "config.toml"), "utf8").replace(/\r\n/g, "\n");

function section(name) {
  const escaped = name.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  const expression = "^\\[" + escaped + "\\]\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))";
  const match = new RegExp(expression, "m").exec(config);
  assert.ok(match, "missing Codex config section [" + name + "]");
  return match[1];
}

const directMcp = section("mcp_servers.supabase.tools.apply_migration");
const supabaseApp = section("apps.supabase");
const appTool = section("apps.supabase.tools.apply_migration");

assert.match(directMcp, /^approval_mode\s*=\s*"prompt"\s*$/m, "direct Supabase MCP apply_migration must prompt");
assert.match(supabaseApp, /^approvals_reviewer\s*=\s*"user"\s*$/m, "Supabase app prompts must route to Mason, not auto-review");
assert.match(appTool, /^approval_mode\s*=\s*"prompt"\s*$/m, "Supabase app apply_migration must prompt");

for (const body of [directMcp, appTool]) {
  assert.doesNotMatch(body, /^approval_mode\s*=\s*"(?:auto|writes|approve)"\s*$/m, "migration apply may not auto-approve");
}

assert.doesNotMatch(config, /codex-migration-approval-prompt\.mjs/, "prompt text must never mint migration approval");
console.log("codex-migration-approval: native user-prompt config verified");
