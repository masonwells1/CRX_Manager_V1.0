#!/usr/bin/env node
// PostToolUse migration reminder.
// Reads the actual file path from the tool payload — no hallucinated filenames.

import { readFileSync } from "node:fs";
import path from "node:path";

let payload;
try {
  payload = globalThis.__CRX_ROUTED_HOOK_PAYLOAD ?? JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

const fp = (payload?.tool_input?.file_path || payload?.tool_response?.filePath || "").replace(/\\/g, "/");
if (!/supabase\/migrations\/.+\.sql$/.test(fp)) {
  process.exit(0);
}

const filename = path.posix.basename(fp);

const reason = `MIGRATION SAFETY CHECK — You just created/edited ${filename}.

Before continuing, you MUST:
1. Update src/types/index.ts to match any schema changes
2. Check whether existing components need updates for the new/changed columns
3. Run \`npm run typecheck\` to verify everything compiles
4. BEFORE suggesting \`apply_migration\` to Mason, dispatch in PARALLEL (single message, multiple Agent calls):
   - Agent: rls-security-reviewer  (scope: this migration)
   - Agent: migration-drift-reviewer (scope: this migration)
   - Agent: typescript-types-drift-reviewer (if types were updated)
5. If any subagent returns BLOCKER findings, fix them before suggesting apply_migration.
6. If Mason is non-technical (which he is), also offer to run /explain-migration so he understands what's about to change live.
7. If this migration changes an RPC signature, a status/CHECK enum, or a table, offer to run /map-drift-audit AFTER it's applied — it reconciles the app-workflow-map against the live DB and catches app-wide drift (missing/renamed RPCs, UI statuses the new CHECK would now reject) that the per-migration reviewers don't look for.
8. AFTER the migration is applied to live, run the DB invariant sweeps:
   Run this in Bash: node scripts/db-invariant-sweeps/run-sweeps.mjs
   It prints SQL queries — execute each one via Supabase MCP execute_sql on project rhyzpcqhnizqbxphqdkr.
   Each query should return ZERO rows. Any rows = a security or schema problem to fix before the next session.
   (Sweeps check: ungated SECDEF mutators, actor-forgery, missing search_path, overloads, anon-exec SECDEF.)

Do NOT proceed to other tasks until these steps are complete.`;

process.stdout.write(JSON.stringify({ decision: "block", reason }));
