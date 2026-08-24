#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  applyTimeCode,
  applyTimeWriteTargets,
  ruleAttachmentIdentity,
  ruleAttachments,
} from "../.claude/hooks/apply-time-dml-lib.mjs";

// File paths arrive one per line. Migration basenames are already constrained
// to the repository's ASCII/no-whitespace convention before this helper runs.
// This began as the Unicode-identity boundary. It now also reports event-
// trigger DDL so the Bash lane consumes the shared SQL lexer instead of growing
// a second comments/strings parser. Output is `<path>\t<reason>`.
const paths = readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean);
const ruleCache = new Map();

function priorRules(file) {
  const dir = path.dirname(file);
  if (!ruleCache.has(dir)) {
    const catalog = [];
    for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".sql")).sort()) {
      const sql = readFileSync(path.join(dir, name), "utf8");
      const code = applyTimeCode(sql).code;
      catalog.push({ name, rules: ruleAttachments(code) });
    }
    ruleCache.set(dir, catalog);
  }
  const basename = path.basename(file);
  return ruleCache.get(dir)
    .filter((entry) => entry.name < basename)
    .flatMap((entry) => entry.rules);
}

for (const file of paths) {
  const sql = readFileSync(file, "utf8");
  const knownRules = priorRules(file);
  const analysed = applyTimeWriteTargets(sql, { knownRules });
  if (analysed.unsupportedRoutineIdentity) process.stdout.write(`${file}\troutine-identity\n`);
  if (analysed.eventTriggerChange) process.stdout.write(`${file}\tevent-trigger\n`);
  if (analysed.searchPathChange || analysed.unresolved) {
    process.stdout.write(`${file}\tevent-catalog-risk\n`);
  }
  if (knownRules.length && analysed.firedRules.length) {
    const localFiredRules = new Set(
      applyTimeWriteTargets(sql).firedRules.map(ruleAttachmentIdentity),
    );
    if (analysed.firedRules.some((rule) => !localFiredRules.has(ruleAttachmentIdentity(rule)))) {
      process.stdout.write(`${file}\tpersisted-rule\n`);
    }
  }
}
