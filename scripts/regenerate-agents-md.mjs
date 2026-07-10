#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
console.log("AGENTS.md is now the hand-maintained shared contract; it is not generated from CLAUDE.md.");
const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", "check-agent-guidance.mjs")], {
  cwd: ROOT,
  encoding: "utf8",
  stdio: "inherit",
});
process.exit(result.status ?? 1);
