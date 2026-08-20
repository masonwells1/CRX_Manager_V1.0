#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { applyTimeWriteTargets } from "../.claude/hooks/apply-time-dml-lib.mjs";

// File paths arrive one per line. Migration basenames are already constrained
// to the repository's ASCII/no-whitespace convention before this helper runs.
const paths = readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean);

for (const file of paths) {
  const sql = readFileSync(file, "utf8");
  if (applyTimeWriteTargets(sql).unsupportedRoutineIdentity) {
    process.stdout.write(`${file}\n`);
  }
}
