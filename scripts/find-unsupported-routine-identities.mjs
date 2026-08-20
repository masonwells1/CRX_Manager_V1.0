#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { applyTimeWriteTargets } from "../.claude/hooks/apply-time-dml-lib.mjs";

// File paths arrive one per line. Migration basenames are already constrained
// to the repository's ASCII/no-whitespace convention before this helper runs.
// This began as the Unicode-identity boundary. It now also reports event-
// trigger DDL so the Bash lane consumes the shared SQL lexer instead of growing
// a second comments/strings parser. Output is `<path>\t<reason>`.
const paths = readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean);

for (const file of paths) {
  const sql = readFileSync(file, "utf8");
  const analysed = applyTimeWriteTargets(sql);
  if (analysed.unsupportedRoutineIdentity) process.stdout.write(`${file}\troutine-identity\n`);
  if (analysed.eventTriggerChange) process.stdout.write(`${file}\tevent-trigger\n`);
  if (analysed.searchPathChange || analysed.unresolved) {
    process.stdout.write(`${file}\tevent-catalog-risk\n`);
  }
}
