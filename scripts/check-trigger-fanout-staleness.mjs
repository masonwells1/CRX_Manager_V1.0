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
  let unparsedRoutineDefinition = false;
  const ident = '(?:"(?:[^"]|"")*"|[a-z_][a-z0-9_$]*)';
  const publicPrefix = '(?:(?:public|"public")\\s*\\.\\s*)?';
  const canonical = (raw) => {
    const text = String(raw || '').trim();
    const name = text.startsWith('"') && text.endsWith('"')
      ? text.slice(1, -1).replaceAll('""', '"')
      : text.toLowerCase();
    return /^[a-z0-9_]+$/.test(name) ? name : null;
  };
  for (const file of sqlFiles) {
    const sql = readFileSync(file, 'utf8');
    const routinePattern = new RegExp(
      `\\bcreate\\s+(?:or\\s+replace\\s+)?(?:function|procedure)\\s+${publicPrefix}(${ident})\\s*\\(`,
      'gi',
    );
    for (const match of sql.matchAll(routinePattern)) {
      const name = canonical(match[1]);
      if (name) changedRoutines.add(name); else unparsedRoutineDefinition = true;
    }
    const triggerRoutinePattern = new RegExp(
      `\\bcreate\\s+(?:or\\s+replace\\s+)?function\\s+${publicPrefix}(${ident})\\s*\\([\\s\\S]*?\\breturns\\s+(?:event_)?trigger\\b`,
      'gi',
    );
    for (const match of sql.matchAll(triggerRoutinePattern)) {
      const name = canonical(match[1]);
      if (name) changedTriggerRoutines.add(name); else unparsedRoutineDefinition = true;
    }
    const triggerPattern = new RegExp(
      `\\bcreate\\s+(?:constraint\\s+)?trigger\\b[\\s\\S]*?\\bon\\s+${publicPrefix}(${ident})`,
      'gi',
    );
    let parsedTrigger = false;
    for (const match of sql.matchAll(triggerPattern)) {
      parsedTrigger = true;
      const table = canonical(match[1]);
      if (table) triggerTables.add(table); else unparsedTriggerDefinition = true;
    }
    if (/\bcreate\s+(?:constraint\s+)?trigger\b/i.test(sql) && !parsedTrigger) {
      unparsedTriggerDefinition = true;
    }
  }
  return {
    changedRoutines,
    changedTriggerRoutines,
    triggerTables,
    unparsedTriggerDefinition,
    unparsedRoutineDefinition,
  };
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
  if (changed.unparsedRoutineDefinition) add('__unparsed_routine_definition__', 'unknown');

  const opaque = new Set(after.opaque_on_tables || []);
  const stale = [];
  for (const [source, reasons] of affected) {
    if (opaque.has(source)) continue;
    if (source.startsWith('__')) { stale.push(source); continue; }
    // A branch-authored hash or edge change is self-asserted, not proof of a
    // linked live capture. Without an external exact-artifact attestation the
    // only honest pre-apply state is explicit opacity for every affected source.
    void reasons;
    stale.push(source);
  }
  return stale.sort();
}

function main() {
  const [base, manifestPath, ...sqlFiles] = process.argv.slice(2);
  if (!base || !manifestPath) throw new Error('usage: check-trigger-fanout-staleness <base> <manifest> [sql...]');
  const changed = changedTriggerInputs(sqlFiles);
  if (!changed.changedRoutines.size && !changed.triggerTables.size &&
      !changed.unparsedTriggerDefinition && !changed.unparsedRoutineDefinition) return;
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
