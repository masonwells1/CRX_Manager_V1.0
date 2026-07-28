#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { extractPatchTargetPaths } from "./patch-input-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
let pass = 0;
function ok(condition, message) { assert.ok(condition, message); pass++; }

const input = `*** Begin Patch
*** Update File: supabase/migrations/20990101000020_test.sql
@@
-old
+new
*** Add File: src/lib/new-file.ts
+export const value = 1;
*** Update File: docs/old.md
*** Move to: docs/new.md
*** End Patch`;
const targets = extractPatchTargetPaths({ input }, root);
ok(targets.length === 3, "target extraction returns one destination per patch section");
ok(targets.some((target) => target.endsWith("/supabase/migrations/20990101000020_test.sql")), "migration target extracted");
ok(targets.some((target) => target.endsWith("/src/lib/new-file.ts")), "source target extracted");
ok(targets.some((target) => target.endsWith("/docs/new.md")), "move destination extracted");

const result = spawnSync(process.execPath, [path.join(here, "patch-posttool-fanout.mjs")], {
  input: JSON.stringify({
    tool_name: "mcp__codex__apply_patch",
    tool_input: {
      input: `*** Begin Patch
*** Add File: supabase/migrations/20990101000021_test.sql
+SELECT 1;
*** End Patch`,
    },
  }),
  encoding: "utf8",
  env: { ...process.env, CLAUDE_PROJECT_DIR: root },
});
ok(result.status === 0, "posttool patch fanout exits cleanly");
ok(result.stdout.includes("MIGRATION SAFETY CHECK"), "patching a migration emits the existing reminder");
ok(result.stdout.includes("20990101000021_test.sql"), "migration reminder names the patch target");

console.log(`patch-posttool-fanout: ${pass} assertions passed`);
