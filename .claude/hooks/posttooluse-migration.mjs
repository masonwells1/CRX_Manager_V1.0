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

Do NOT proceed to other tasks until these steps are complete.`;

process.stdout.write(JSON.stringify({ decision: "block", reason }));
