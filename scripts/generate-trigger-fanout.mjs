#!/usr/bin/env node
// Generate scripts/trigger-fanout.json from the linked production catalog.
//
// The approved-set migration guard must include rows rewritten by triggers.
// This producer verifies the linked Supabase project and captures trigger plus
// routine bodies itself; it accepts no pasted payload or caller-supplied project
// label. Helper calls are followed transitively. Dynamic SQL, unresolved calls,
// unreadable bodies, or writes outside the scanned public tables make the source
// table opaque so the validator refuses it instead of assuming no fan-out.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyTimeCode, applyTimeWriteTargets } from '../.claude/hooks/apply-time-dml-lib.mjs';
import {
  CRX_SUPABASE_PROJECT_ID,
  LINKED_READ_QUERY_IDS,
  runLinkedRead,
  TRIGGER_FANOUT_SQL,
} from './supabase-linked-read.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'trigger-fanout.json');
export const TRIGGER_FANOUT_FORMAT = 3;
export { TRIGGER_FANOUT_SQL };

function fail(message) {
  throw new Error(`generate-trigger-fanout: ${message}`);
}

function bareName(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9_]+$/.test(value)) {
    fail(`${label} is not a bare lower-case identifier: ${JSON.stringify(value)}`);
  }
  return value;
}

function uniqueNames(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return [...new Set(value.map((name) => bareName(name, label)))].sort();
}

function routineDefinition(routine, index) {
  let tag = `$crx_fanout_${index}$`;
  while (routine.source.includes(tag)) tag = `$crx_fanout_${index}_x$`;
  return `CREATE FUNCTION public.${routine.name}() RETURNS void LANGUAGE plpgsql AS ${tag}\n${routine.source}\n${tag};`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function buildTriggerFanoutManifest(payload, projectId = CRX_SUPABASE_PROJECT_ID) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('linked query returned an invalid trigger_fanout_capture envelope');
  }
  const expectedKeys = ['captured_at', 'foreign_keys', 'routines', 'tables_scanned', 'triggers'];
  if (JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(expectedKeys)) {
    fail('linked query returned an unexpected trigger_fanout_capture shape');
  }
  if (typeof payload.captured_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(payload.captured_at) ||
      !Number.isFinite(Date.parse(payload.captured_at))) {
    fail('linked query returned an invalid database capture timestamp');
  }

  const tablesScanned = uniqueNames(payload.tables_scanned, 'tables_scanned');
  if (tablesScanned.length < 100) {
    fail(`tables_scanned holds only ${tablesScanned.length} tables; the capture looks truncated`);
  }
  const tableSet = new Set(tablesScanned);
  if (!Array.isArray(payload.routines) || !Array.isArray(payload.triggers) ||
      !Array.isArray(payload.foreign_keys)) {
    fail('routines, triggers, and foreign_keys must be arrays');
  }

  const routines = payload.routines.map((routine) => {
    if (!routine || typeof routine !== 'object' || Array.isArray(routine)) fail('routine is invalid');
    const keys = Object.keys(routine).sort();
    if (JSON.stringify(keys) !== JSON.stringify(['has_sql_body', 'language', 'name', 'oid', 'source'])) {
      fail('routine has an unexpected shape');
    }
    if (typeof routine.oid !== 'string' || !/^\d+$/.test(routine.oid)) fail('routine oid is invalid');
    if (typeof routine.language !== 'string' || !/^[a-z0-9_]+$/.test(routine.language)) {
      fail('routine language is invalid');
    }
    if (typeof routine.source !== 'string' || typeof routine.has_sql_body !== 'boolean') {
      fail('routine body metadata is invalid');
    }
    return { ...routine, name: bareName(routine.name, 'routine name') };
  });
  const routineByOid = new Map(routines.map((routine) => [routine.oid, routine]));
  const routineBodiesByName = new Map();
  for (const routine of routines) {
    const bodies = routineBodiesByName.get(routine.name) || [];
    bodies.push(JSON.stringify({
      language: routine.language,
      has_sql_body: routine.has_sql_body,
      source: routine.source,
    }));
    routineBodiesByName.set(routine.name, bodies);
  }
  const allRoutineHashes = Object.fromEntries(
    [...routineBodiesByName]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, bodies]) => [name, sha256(bodies.sort().join('\n'))]),
  );
  const opaqueRoutineNames = new Set(
    routines
      .filter((routine) =>
        routine.has_sql_body || !routine.source.trim() ||
        !new Set(['plpgsql', 'sql']).has(routine.language))
      .map((routine) => routine.name),
  );
  const nonPublicEffectCallNames = new Set(
    routines
      .filter((routine) => {
        const code = applyTimeCode(`DO $crx_scan$ ${routine.source} $crx_scan$;`).code.toLowerCase();
        return /\b(?:perform|call)\s+(?!public\.)[a-z_][a-z0-9_$]*\s*\./.test(code);
      })
      .map((routine) => routine.name),
  );
  const definitions = routines.map(routineDefinition).join('\n');

  const triggers = payload.triggers.map((trigger) => {
    if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) fail('trigger is invalid');
    const keys = Object.keys(trigger).sort();
    if (JSON.stringify(keys) !== JSON.stringify(['on_table', 'routine_name', 'routine_oid'])) {
      fail('trigger has an unexpected shape');
    }
    const onTable = bareName(trigger.on_table, 'trigger table');
    const routineName = bareName(trigger.routine_name, 'trigger routine');
    if (!tableSet.has(onTable)) fail(`trigger table ${onTable} is not in tables_scanned`);
    if (typeof trigger.routine_oid !== 'string' || !routineByOid.has(trigger.routine_oid)) {
      fail(`trigger routine ${routineName} is absent from the captured routine catalog`);
    }
    if (routineByOid.get(trigger.routine_oid).name !== routineName) {
      fail(`trigger routine oid/name mismatch for ${routineName}`);
    }
    return { onTable, routineName };
  });

  const writeAction = new Set(['c', 'n', 'd']);
  const foreignKeys = payload.foreign_keys.map((foreignKey) => {
    if (!foreignKey || typeof foreignKey !== 'object' || Array.isArray(foreignKey)) {
      fail('foreign key is invalid');
    }
    const keys = Object.keys(foreignKey).sort();
    if (JSON.stringify(keys) !==
        JSON.stringify(['child_table', 'oid', 'on_delete', 'on_update', 'parent_table'])) {
      fail('foreign key has an unexpected shape');
    }
    if (typeof foreignKey.oid !== 'string' || !/^\d+$/.test(foreignKey.oid)) {
      fail('foreign key oid is invalid');
    }
    const parent = bareName(foreignKey.parent_table, 'foreign key parent table');
    const child = bareName(foreignKey.child_table, 'foreign key child table');
    if (!tableSet.has(parent) || !tableSet.has(child)) {
      fail(`foreign key ${foreignKey.oid} names a table outside tables_scanned`);
    }
    if (typeof foreignKey.on_update !== 'string' || !/^[acdnr]$/.test(foreignKey.on_update) ||
        typeof foreignKey.on_delete !== 'string' || !/^[acdnr]$/.test(foreignKey.on_delete)) {
      fail(`foreign key ${foreignKey.oid} has an invalid referential action`);
    }
    return {
      parent,
      child,
      via: `foreign_key_${foreignKey.oid}`,
      writesChild: writeAction.has(foreignKey.on_update) || writeAction.has(foreignKey.on_delete),
    };
  });

  const directFanout = {};
  const directlyOpaque = new Set();
  const directRoutineDependencies = {};
  for (const trigger of triggers) {
    const invokeTag = '$crx_fanout_run$';
    const analysed = applyTimeWriteTargets(
      `${definitions}\nDO ${invokeTag} BEGIN PERFORM public.${trigger.routineName}(); END ${invokeTag};`,
    );
    const unknownTables = [...analysed.tables].filter((table) => !tableSet.has(table));
    const invokedOpaque = analysed.invokedRoutines.some((name) => opaqueRoutineNames.has(name));
    const invokedNonPublic = analysed.invokedRoutines.some((name) => nonPublicEffectCallNames.has(name));
    if (analysed.unresolved || analysed.unknownCalls.length || unknownTables.length ||
        invokedOpaque || invokedNonPublic) {
      directlyOpaque.add(trigger.onTable);
    }
    const dependencies = (directRoutineDependencies[trigger.onTable] ??= new Set());
    for (const name of analysed.invokedRoutines) {
      if (Object.hasOwn(allRoutineHashes, name)) dependencies.add(name);
    }
    for (const target of [...analysed.tables].sort()) {
      if (target === trigger.onTable || !tableSet.has(target)) continue;
      (directFanout[trigger.onTable] ??= []).push({ target, via: trigger.routineName });
    }
  }
  for (const foreignKey of foreignKeys) {
    if (!foreignKey.writesChild || foreignKey.parent === foreignKey.child) continue;
    (directFanout[foreignKey.parent] ??= []).push({
      target: foreignKey.child,
      via: foreignKey.via,
    });
  }

  // A trigger write can fire another captured trigger. Close over the table
  // graph so A -> B -> C is represented as both A -> B and A -> C. Opacity
  // propagates the same way: if any reached table has an unreadable/dynamic
  // trigger, the original source is not safe to approve by a finite edge list.
  const fanout = {};
  const reachableRoutines = {};
  const opaque = new Set(directlyOpaque);
  const sourceTables = new Set([
    ...Object.keys(directFanout),
    ...Object.keys(directRoutineDependencies),
    ...directlyOpaque,
  ]);
  for (const source of sourceTables) {
    const edges = [];
    const queued = [...(directFanout[source] || [])];
    const expandedTables = new Set();
    const dependencies = new Set(directRoutineDependencies[source] || []);
    for (let index = 0; index < queued.length; index += 1) {
      const edge = queued[index];
      edges.push(edge);
      if (expandedTables.has(edge.target)) continue;
      expandedTables.add(edge.target);
      if (directlyOpaque.has(edge.target)) opaque.add(source);
      for (const name of directRoutineDependencies[edge.target] || []) dependencies.add(name);
      for (const downstream of directFanout[edge.target] || []) queued.push(downstream);
    }
    if (edges.length) fanout[source] = edges;
    if (dependencies.size) reachableRoutines[source] = [...dependencies].sort();
  }

  const sorted = {};
  for (const source of Object.keys(fanout).sort()) {
    const seen = new Set();
    sorted[source] = fanout[source]
      .filter((edge) => {
        const key = `${edge.target}\t${edge.via}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.target.localeCompare(b.target) || a.via.localeCompare(b.via));
  }

  const usedRoutineNames = new Set(Object.values(reachableRoutines).flat());
  const routineHashes = Object.fromEntries(
    [...usedRoutineNames].sort().map((name) => [name, allRoutineHashes[name]]),
  );

  return {
    _meta: {
      format_version: TRIGGER_FANOUT_FORMAT,
      captured_at: payload.captured_at,
      generator: 'scripts/generate-trigger-fanout.mjs',
      capture_method: 'supabase-cli-db-query-linked',
      source_project: projectId,
      scope:
        'Transitive trigger and FK referential-action writes; unresolved calls or dynamic targets are opaque.',
      regenerate: 'node scripts/generate-trigger-fanout.mjs',
    },
    tables_scanned: tablesScanned,
    opaque_on_tables: [...opaque].sort(),
    reachable_routines: Object.fromEntries(
      Object.entries(reachableRoutines).sort(([a], [b]) => a.localeCompare(b)),
    ),
    routine_hashes: routineHashes,
    fanout: sorted,
  };
}

export function captureTriggerFanout({
  projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd(),
  linkedRoot,
  run,
  outPath = OUT,
} = {}) {
  const capture = runLinkedRead({
    projectRoot: projectDir,
    linkedRoot,
    queryId: LINKED_READ_QUERY_IDS.TRIGGER_FANOUT,
    ...(run ? { run } : {}),
  });
  if (capture.rows.length !== 1) fail('linked query did not return exactly one row');
  const row = capture.rows[0];
  if (!row || typeof row !== 'object' || Array.isArray(row) ||
      JSON.stringify(Object.keys(row)) !== JSON.stringify(['trigger_fanout_capture'])) {
    fail('linked query returned an unexpected row shape');
  }
  const manifest = buildTriggerFanoutManifest(row.trigger_fanout_capture, capture.projectId);
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifest, outPath };
}

function main() {
  if (process.argv.slice(2).length) {
    fail('usage: node scripts/generate-trigger-fanout.mjs (no arguments or stdin)');
  }
  const { manifest, outPath } = captureTriggerFanout();
  const edgeCount = Object.values(manifest.fanout).reduce((count, rows) => count + rows.length, 0);
  process.stdout.write(
    `generate-trigger-fanout: wrote ${outPath}\n  ${manifest.tables_scanned.length} tables, ` +
    `${edgeCount} cascade edges, ${manifest.opaque_on_tables.length} opaque source tables\n`,
  );
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  }
}
