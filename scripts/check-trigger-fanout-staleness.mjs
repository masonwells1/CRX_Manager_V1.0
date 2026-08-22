#!/usr/bin/env node
// Bind changed trigger/helper routines to the exact live source tables that
// transitively depend on them. Prints a space-delimited stale-source list.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routineIdentityChanges } from '../.claude/hooks/apply-time-dml-lib.mjs';

function canonicalManifestIdentity(raw) {
  const text = String(raw || '').trim();
  const name = text.startsWith('"') && text.endsWith('"')
    ? text.slice(1, -1).replaceAll('""', '"')
    : text.toLowerCase();
  const normalized = name.replaceAll('$', '_dollar_');
  return /^[a-z0-9_]+$/.test(normalized) ? normalized : null;
}

export function changedTriggerInputs(sqlFiles) {
  const changedRoutines = new Set();
  const changedRoutineIdentities = new Set();
  const changedTriggerRoutines = new Set();
  const triggerTables = new Set();
  const foreignKeyParents = new Set();
  let unparsedTriggerDefinition = false;
  let eventTriggerChange = false;
  let unparsedRoutineDefinition = false;
  let unparsedForeignKeyDefinition = false;
  const ident = '(?:"(?:[^"]|"")*"|[a-z_][a-z0-9_$]*)';
  const publicPrefix = '(?:(?:public|"public")\\s*\\.\\s*)?';
  const canonical = canonicalManifestIdentity;
  for (const file of sqlFiles) {
    const sql = readFileSync(file, 'utf8');
    if (/\b(?:create|alter|drop)\s+event\s+trigger\b/i.test(sql)) eventTriggerChange = true;
    const routineCatalog = routineIdentityChanges(sql);
    if (routineCatalog.unparsed) unparsedRoutineDefinition = true;
    for (const change of routineCatalog.changes) {
      const name = canonical(change.name);
      const schema = change.schema ? canonical(change.schema) : '';
      if (!name || (change.schema && !schema)) {
        unparsedRoutineDefinition = true;
        continue;
      }
      changedRoutines.add(name);
      changedRoutineIdentities.add(`${schema || '*'}\0${name}`);
    }
    const triggerRoutinePattern = new RegExp(
      `\\bcreate\\s+(?:or\\s+replace\\s+)?function\\s+(?:(?:${ident})\\s*\\.\\s*)*(${ident})\\s*\\([\\s\\S]*?\\breturns\\s+(?:event_)?trigger\\b`,
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
    const referencePattern = new RegExp(`\\breferences\\s+${publicPrefix}(${ident})`, 'gi');
    let parsedReference = false;
    for (const match of sql.matchAll(referencePattern)) {
      parsedReference = true;
      const parent = canonical(match[1]);
      if (parent) foreignKeyParents.add(parent); else unparsedForeignKeyDefinition = true;
    }
    // A declared FK always has a REFERENCES clause. If that clause could not be
    // mapped to a public relation, the graph impact is unknown and must fail
    // closed. DROP CONSTRAINT removes a possible cascade and is covered by the
    // before/after graph-weakening comparison below.
    if (/\bforeign\s+key\b/i.test(sql) && !parsedReference) {
      unparsedForeignKeyDefinition = true;
    }
  }
  return {
    changedRoutines,
    changedRoutineIdentities,
    changedTriggerRoutines,
    triggerTables,
    foreignKeyParents,
    unparsedTriggerDefinition,
    eventTriggerChange,
    unparsedRoutineDefinition,
    unparsedForeignKeyDefinition,
  };
}

function manifestWeakeningSources(before, after) {
  const weakened = new Set();
  const afterScanned = new Set(after.tables_scanned || []);
  if (!(before.tables_scanned || []).length) {
    // No base artifact means there is no trusted graph to compare. The first
    // manifest is useful only as review evidence; operationally every declared
    // source must remain opaque so an omitted edge cannot become a permanent
    // false negative. The schema-registry equality check in the shell validator
    // prevents a candidate from shrinking this declared source universe.
    const opaque = new Set(after.opaque_on_tables || []);
    for (const table of afterScanned) if (!opaque.has(table)) weakened.add(table);
  }
  for (const table of before.tables_scanned || []) {
    if (!afterScanned.has(table)) weakened.add(`__removed_scanned_table_${table}`);
  }

  const edgeKey = (edge) => `${edge?.target || ''}\u0000${edge?.via || ''}`;
  for (const [source, edges] of Object.entries(before.fanout || {})) {
    const afterEdges = new Set((after.fanout?.[source] || []).map(edgeKey));
    if ((edges || []).some((edge) => !afterEdges.has(edgeKey(edge)))) weakened.add(source);
  }

  const afterOpaque = new Set(after.opaque_on_tables || []);
  for (const source of before.opaque_on_tables || []) {
    if (!afterOpaque.has(source)) weakened.add(source);
  }

  for (const [source, routines] of Object.entries(before.reachable_routines || {})) {
    const afterRoutines = new Set(after.reachable_routines?.[source] || []);
    if ((routines || []).some((name) => !afterRoutines.has(name))) weakened.add(source);
  }

  const owners = new Map();
  for (const [source, routines] of Object.entries(before.reachable_routines || {})) {
    for (const name of routines || []) {
      if (!owners.has(name)) owners.set(name, new Set());
      owners.get(name).add(source);
    }
  }
  for (const [name, hash] of Object.entries(before.routine_hashes || {})) {
    if (after.routine_hashes?.[name] === hash) continue;
    const routineOwners = owners.get(name);
    if (routineOwners?.size) for (const source of routineOwners) weakened.add(source);
    else weakened.add(`__changed_unowned_routine_${name}`);
  }
  // Introducing the first bound event-trigger capture strengthens an older or
  // absent manifest. Once the field exists, any later state/body/config drift
  // is stale and requires a fresh linked recapture.
  if (Array.isArray(before.event_triggers) &&
      JSON.stringify(before.event_triggers) !== JSON.stringify(after.event_triggers || [])) {
    weakened.add('__event_trigger_state_changed__');
  }
  // A new captured rule is additional fail-closed evidence. Removing or
  // changing an already bound OID/name/relation/event/definition hash can make
  // later migration SQL look harmless, so a candidate-authored manifest is
  // not allowed to erase that live catalog fact silently.
  if (Array.isArray(before.rules)) {
    const afterRules = new Set((after.rules || []).map((rule) => JSON.stringify(rule)));
    if (before.rules.some((rule) => !afterRules.has(JSON.stringify(rule)))) {
      weakened.add('__rewrite_rule_state_changed__');
    }
  }
  // Persisted table CHECK expressions can dispatch custom routines on later
  // writes. Removing or changing a bound dependency is a graph weakening just
  // like erasing a trigger edge or rewrite rule.
  if (Array.isArray(before.check_constraints)) {
    const afterChecks = new Set((after.check_constraints || []).map((constraint) =>
      JSON.stringify(constraint)));
    if (before.check_constraints.some((constraint) =>
      !afterChecks.has(JSON.stringify(constraint)))) {
      weakened.add('__check_constraint_state_changed__');
    }
  }
  return weakened;
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
  for (const table of changed.foreignKeyParents || []) add(table, '__foreign_key_change__');
  for (const name of changed.changedTriggerRoutines) {
    const owners = Object.entries(before.reachable_routines || {})
      .filter(([, names]) => (names || []).includes(name));
    if (!owners.length && !changed.triggerTables.size) add('__unmapped_trigger_routine__', name);
  }
  for (const trigger of before.event_triggers || []) {
    if (!trigger?.enabled) continue;
    const schema = canonicalManifestIdentity(trigger.routine_schema);
    const name = canonicalManifestIdentity(trigger.routine_name);
    if (!schema || !name) {
      add('__event_trigger_routine_identity_unreadable__', 'unknown');
      continue;
    }
    if (changed.changedRoutineIdentities?.has(`${schema}\0${name}`) ||
        changed.changedRoutineIdentities?.has(`*\0${name}`)) {
      add('__event_trigger_routine_changed__',
        `${schema}.${name}:${trigger.routine_oid || 'unknown'}:${trigger.routine_hash || 'unknown'}`);
    }
  }
  for (const constraint of before.check_constraints || []) {
    const schema = canonicalManifestIdentity(constraint.routine_schema);
    const name = canonicalManifestIdentity(constraint.routine_name);
    const relation = canonicalManifestIdentity(constraint.relation);
    if (!schema || !name || !relation) {
      add('__check_constraint_routine_identity_unreadable__', 'unknown');
      continue;
    }
    if (changed.changedRoutineIdentities?.has(`${schema}\0${name}`) ||
        changed.changedRoutineIdentities?.has(`*\0${name}`)) {
      add(relation,
        `${schema}.${name}:${constraint.routine_oid || 'unknown'}:${constraint.definition_hash || 'unknown'}`);
    }
  }
  if (changed.unparsedTriggerDefinition) add('__unparsed_trigger_definition__', 'unknown');
  if (changed.eventTriggerChange) add('__event_trigger_change__', 'database-wide');
  if (changed.unparsedRoutineDefinition) add('__unparsed_routine_definition__', 'unknown');
  if (changed.unparsedForeignKeyDefinition) add('__unparsed_foreign_key_definition__', 'unknown');
  for (const source of manifestWeakeningSources(before, after)) add(source, '__manifest_weakened__');

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
  const gitPath = manifestPath.replaceAll('\\', '/');
  let before;
  try {
    before = JSON.parse(execFileSync(
      'git', ['show', `${base}:${gitPath}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ));
  } catch (error) {
    // A manifest introduced by this branch has no base artifact to weaken. That
    // is distinct from an unreadable base: prove the commit exists and the path
    // is genuinely absent before accepting an empty comparison baseline.
    const listed = execFileSync(
      'git', ['ls-tree', '--name-only', base, '--', gitPath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    if (listed) throw error;
    before = {};
  }
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
