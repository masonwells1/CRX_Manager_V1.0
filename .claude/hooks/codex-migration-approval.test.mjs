import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const config = readFileSync(path.join(process.cwd(), ".codex", "config.toml"), "utf8").replace(/\r\n/g, "\n");

function section(name) {
  const escaped = name.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  const match = new RegExp("^\\[" + escaped + "\\]\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))", "m").exec(config);
  assert.ok(match, `missing Codex config section [${name}]`);
  return match[1];
}

assert.match(config, /^approvals_reviewer\s*=\s*"user"\s*$/m, "tool prompts must route to Mason");

const direct = section("mcp_servers.supabase");
assert.match(direct, /^disabled_tools\s*=\s*\[[^\]]*"apply_migration"[^\]]*"execute_sql"[^\]]*\]\s*$/m,
  "direct Supabase raw SQL write tools must be disabled");

for (const name of ["apps.supabase.tools.apply_migration", "apps.supabase.tools.execute_sql"]) {
  assert.match(section(name), /^enabled\s*=\s*false\s*$/m, `${name} must be disabled`);
}

const bridge = section("mcp_servers.crx_supabase");
assert.match(bridge, /^command\s*=\s*"node"\s*$/m);
assert.match(bridge, /^args\s*=\s*\["scripts\/codex-safe-supabase-mcp\.mjs"\]\s*$/m);
assert.match(bridge, /^required\s*=\s*true\s*$/m);

const apply = section("mcp_servers.crx_supabase.tools.apply_reviewed_migration");
assert.match(apply, /^approval_mode\s*=\s*"prompt"\s*$/m, "reviewed migration apply must prompt Mason");
assert.doesNotMatch(apply, /^approval_mode\s*=\s*"(?:auto|writes|approve)"\s*$/m);

assert.doesNotMatch(config, /codex-migration-approval-prompt\.mjs/, "prompt text must never mint approval");
console.log("codex-migration-approval: raw SQL tools disabled and reviewed wrapper prompts Mason");
