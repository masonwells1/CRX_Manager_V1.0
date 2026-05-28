#!/usr/bin/env node
// PostToolUse migration reminder.
// Reads the actual file path from the tool payload — no hallucinated filenames.

import { readFileSync } from "node:fs";
import path from "node:path";

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
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

Do NOT proceed to other tasks until these steps are complete.`;

process.stdout.write(JSON.stringify({ decision: "block", reason }));
