#!/usr/bin/env node
// Bind changed trigger/helper routines to the exact live source tables that
// transitively depend on them. Prints a space-delimited stale-source list.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function changedTriggerInputs(sqlFiles) {
  const changedRoutines = new Set();
  const changedTriggerRoutines = new Set();
  const triggerTables = new Set();
  let unparsedTriggerDefinition = false;
  for (const file of sqlFiles) {
    const sql = readFileSync(file, 'utf8');
    const routinePattern = /\bcreate\s+(?:or\s+replace\s+)?(?:function|procedure)\s+(?:public\.)?([a-z_][a-z0-9_$]*)\s*\(/gi;
    for (const match of sql.matchAll(routinePattern)) changedRoutines.add(match[1].toLowerCase());
    const triggerRoutinePattern = /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z_][a-z0-9_$]*)\s*\([\s\S]*?\breturns\s+(?:event_)?trigger\b/gi;
    for (const match of sql.matchAll(triggerRoutinePattern)) {
      changedTriggerRoutines.add(match[1].toLowerCase());
    }
    const triggerPattern = /\bcreate\s+(?:constraint\s+)?trigger\b[\s\S]*?\bon\s+(?:public\.)?([a-z_][a-z0-9_$]*)\b/gi;
    let parsedTrigger = false;
    for (const match of sql.matchAll(triggerPattern)) {
      parsedTrigger = true;
      triggerTables.add(match[1].toLowerCase());
    }
    if (/\bcreate\s+(?:constraint\s+)?trigger\b/i.test(sql) && !parsedTrigger) {
      unparsedTriggerDefinition = true;
    }
  }
  return { changedRoutines, changedTriggerRoutines, triggerTables, unparsedTriggerDefinition };
}

export function staleTriggerSources(before, after, changed) {
  const affected = new Map();
  const add = (source, reason) => {
    if (!affected.has(source)) affected.set(source, new Set());
    affected.get(source).add(reason);
  };
  for (const [source, names] of Object.entries(before.reachable_routines || {})) {
    for (const name of names || []) if (changed.changedRoutines.has(name)) add(source, name);
  }
  for (const table of changed.triggerTables) add(table, '__trigger_attachment__');
  for (const name of changed.changedTriggerRoutines) {
    const owners = Object.entries(before.reachable_routines || {})
      .filter(([, names]) => (names || []).includes(name));
    if (!owners.length && !changed.triggerTables.size) add('__unmapped_trigger_routine__', name);
  }
  if (changed.unparsedTriggerDefinition) add('__unparsed_trigger_definition__', 'unknown');

  const opaque = new Set(after.opaque_on_tables || []);
  const stale = [];
  for (const [source, reasons] of affected) {
    if (opaque.has(source)) continue;
    if (source.startsWith('__')) { stale.push(source); continue; }
    const routineReasons = [...reasons].filter((name) => !name.startsWith('__'));
    const routineRefreshed = routineReasons.length > 0 && routineReasons.every((name) =>
      (after.reachable_routines?.[source] || []).includes(name) &&
      typeof before.routine_hashes?.[name] === 'string' &&
      typeof after.routine_hashes?.[name] === 'string' &&
      before.routine_hashes[name] !== after.routine_hashes[name]);
    const attachmentRefreshed = reasons.has('__trigger_attachment__') &&
      JSON.stringify(before.reachable_routines?.[source] || []) !==
        JSON.stringify(after.reachable_routines?.[source] || []);
    if (!routineRefreshed && !attachmentRefreshed) stale.push(source);
  }
  return stale.sort();
}

function main() {
  const [base, manifestPath, ...sqlFiles] = process.argv.slice(2);
  if (!base || !manifestPath) throw new Error('usage: check-trigger-fanout-staleness <base> <manifest> [sql...]');
  const changed = changedTriggerInputs(sqlFiles);
  if (!changed.changedRoutines.size && !changed.triggerTables.size &&
      !changed.unparsedTriggerDefinition) return;
  const before = JSON.parse(execFileSync(
    'git', ['show', `${base}:${manifestPath.replaceAll('\\', '/')}`], { encoding: 'utf8' },
  ));
  const after = JSON.parse(readFileSync(path.resolve(manifestPath), 'utf8'));
  process.stdout.write(staleTriggerSources(before, after, changed).join(' '));
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch {
    process.stdout.write('__manifest_or_analysis_unreadable__');
    process.exitCode = 1;
  }
}
