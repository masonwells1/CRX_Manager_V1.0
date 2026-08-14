#!/usr/bin/env node
// Generate scripts/trigger-fanout.json from the linked production catalog.
//
// The approved-set migration guard must include rows rewritten by triggers.
// This producer verifies the linked Supabase project and captures trigger plus
// routine bodies itself; it accepts no pasted payload or caller-supplied project
// label. Helper calls are followed transitively. Dynamic SQL, unresolved calls,
// unreadable bodies, or writes outside the scanned public tables make the source
// table opaque so the validator refuses it instead of assuming no fan-out.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyTimeCode, applyTimeWriteTargets } from '../.claude/hooks/apply-time-dml-lib.mjs';
import {
  CRX_SUPABASE_PROJECT_ID,
  runLinkedRead,
} from './supabase-linked-read.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'trigger-fanout.json');
export const TRIGGER_FANOUT_FORMAT = 2;

export const TRIGGER_FANOUT_SQL = `
WITH tables AS (
  SELECT tablename
  FROM pg_tables
  WHERE schemaname = 'public'
  ORDER BY tablename
), routines AS (
  SELECT
    p.oid::text AS oid,
    p.proname AS name,
    l.lanname AS language,
    COALESCE(p.prosrc, '') AS source,
    (p.prosqlbody IS NOT NULL) AS has_sql_body
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
  ORDER BY p.oid
), triggers AS (
  SELECT DISTINCT
    c.relname AS on_table,
    p.oid::text AS routine_oid,
    p.proname AS routine_name
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE NOT t.tgisinternal AND n.nspname = 'public'
  ORDER BY on_table, routine_name, routine_oid
)
SELECT jsonb_build_object(
  'captured_at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'tables_scanned', COALESCE((SELECT jsonb_agg(tablename) FROM tables), '[]'::jsonb),
  'routines', COALESCE((SELECT jsonb_agg(to_jsonb(routines)) FROM routines), '[]'::jsonb),
  'triggers', COALESCE((SELECT jsonb_agg(to_jsonb(triggers)) FROM triggers), '[]'::jsonb)
) AS trigger_fanout_capture;
`.trim();

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

export function buildTriggerFanoutManifest(payload, projectId = CRX_SUPABASE_PROJECT_ID) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('linked query returned an invalid trigger_fanout_capture envelope');
  }
  const expectedKeys = ['captured_at', 'routines', 'tables_scanned', 'triggers'];
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
  if (!Array.isArray(payload.routines) || !Array.isArray(payload.triggers)) {
    fail('routines and triggers must be arrays');
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

  const directFanout = {};
  const directlyOpaque = new Set();
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
    for (const target of [...analysed.tables].sort()) {
      if (target === trigger.onTable || !tableSet.has(target)) continue;
      (directFanout[trigger.onTable] ??= []).push({ target, via: trigger.routineName });
    }
  }

  // A trigger write can fire another captured trigger. Close over the table
  // graph so A -> B -> C is represented as both A -> B and A -> C. Opacity
  // propagates the same way: if any reached table has an unreadable/dynamic
  // trigger, the original source is not safe to approve by a finite edge list.
  const fanout = {};
  const opaque = new Set(directlyOpaque);
  const sourceTables = new Set([
    ...Object.keys(directFanout),
    ...directlyOpaque,
  ]);
  for (const source of sourceTables) {
    const edges = [];
    const queued = [...(directFanout[source] || [])];
    const expandedTables = new Set();
    for (let index = 0; index < queued.length; index += 1) {
      const edge = queued[index];
      edges.push(edge);
      if (expandedTables.has(edge.target)) continue;
      expandedTables.add(edge.target);
      if (directlyOpaque.has(edge.target)) opaque.add(source);
      for (const downstream of directFanout[edge.target] || []) queued.push(downstream);
    }
    if (edges.length) fanout[source] = edges;
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

  return {
    _meta: {
      format_version: TRIGGER_FANOUT_FORMAT,
      captured_at: payload.captured_at,
      generator: 'scripts/generate-trigger-fanout.mjs',
      capture_method: 'supabase-cli-db-query-linked',
      source_project: projectId,
      scope:
        'Transitive UPDATE/DELETE/MERGE and UPSERT-conflict writes; unresolved calls or dynamic targets are opaque.',
      regenerate: 'node scripts/generate-trigger-fanout.mjs',
    },
    tables_scanned: tablesScanned,
    opaque_on_tables: [...opaque].sort(),
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
    sql: TRIGGER_FANOUT_SQL,
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
