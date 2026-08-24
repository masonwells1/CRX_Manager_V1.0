#!/usr/bin/env node
// Generate scripts/trigger-fanout.json from the linked production catalog.
//
// The approved-set migration guard must include rows rewritten by triggers.
// This producer verifies the linked Supabase project and captures trigger plus
// routine bodies itself; it accepts no pasted payload or caller-supplied project
// label. Helper calls are followed transitively. Dynamic SQL, unresolved calls,
// unreadable bodies, or writes outside the scanned public tables make the source
// table opaque so the validator refuses it instead of assuming no fan-out.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
const REPO_ROOT = path.resolve(HERE, '..');
const OUT = path.join(HERE, 'trigger-fanout.json');
const ATTESTATION = path.join(REPO_ROOT, '.claude', 'session-state', 'trigger-fanout-attestation.json');
export const TRIGGER_FANOUT_FORMAT = 6;
export const TRIGGER_FANOUT_ATTESTATION_FORMAT = 1;
export const TRIGGER_FANOUT_PRODUCER_SOURCES = Object.freeze([
  'scripts/generate-trigger-fanout.mjs',
  'scripts/supabase-linked-read.mjs',
  '.claude/hooks/apply-time-dml-lib.mjs',
]);
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

function relationName(schema, table, label) {
  const schemaName = bareName(schema, `${label} schema`);
  const tableName = bareName(table, `${label} table`);
  return schemaName === 'public' ? tableName : `${schemaName}.${tableName}`;
}

function capturedRelationName(value, label) {
  if (typeof value !== 'string' ||
      !/^[a-z0-9_]+(?:\.[a-z0-9_]+)?$/.test(value)) {
    fail(`${label} is not a lower-case relation identity: ${JSON.stringify(value)}`);
  }
  return value;
}

function uniqueNames(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return [...new Set(value.map((name) => bareName(name, label)))].sort();
}

const EVENT_METADATA_HELPERS = Object.freeze([
  'pg_event_trigger_ddl_commands',
  'pg_event_trigger_dropped_objects',
  'pg_event_trigger_table_rewrite_oid',
  'pg_event_trigger_table_rewrite_reason',
]);
const EVENT_READONLY_BUILTINS = Object.freeze([
  'jsonb_build_array',
  'jsonb_build_object',
  'split_part',
  'version',
]);

function routineConfig(value) {
  if (!Array.isArray(value) || value.some((entry) =>
    typeof entry !== 'string' || /[\r\n\0]/.test(entry))) {
    fail('event trigger routine_config is invalid');
  }
  const config = [...value].sort();
  if (config.filter((entry) => /^search_path\s*=/.test(entry)).length > 1) {
    fail('event trigger routine_config repeats search_path');
  }
  return config;
}

// PostgreSQL implicitly searches pg_catalog first unless it is explicitly
// placed later in search_path. Event routines without a pinned search_path are
// caller-dependent, so they do not receive this narrow builtin exemption.
function eventCatalogBinding(config) {
  const setting = [...config].reverse().find((entry) => /^search_path\s*=/.test(entry));
  if (!setting) return 'session';
  const schemas = setting.slice(setting.indexOf('=') + 1)
    .split(',')
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1').toLowerCase())
    .filter(Boolean);
  const catalogIndex = schemas.indexOf('pg_catalog');
  return catalogIndex === -1 || catalogIndex === 0 ? 'pinned' : 'unsafe';
}

function usesUnqualifiedEventMetadataHelper(source) {
  const code = applyTimeCode(`DO $crx_event_helper$ ${source} $crx_event_helper$;`).code.toLowerCase();
  return EVENT_METADATA_HELPERS.some((name) =>
    new RegExp(`(?<![a-z0-9_.])${name}\\s*\\(`).test(code));
}

export function routineDelimiter(source, index) {
  let suffix = 0;
  while (true) {
    const tag = suffix === 0
      ? `$crx_fanout_${index}$`
      : `$crx_fanout_${index}_x${suffix}$`;
    if (!source.includes(tag)) return tag;
    suffix += 1;
  }
}

function routineDefinition(routine, index) {
  const tag = routineDelimiter(routine.source, index);
  return `CREATE FUNCTION public.${routine.name}() RETURNS void LANGUAGE plpgsql AS ${tag}\n${routine.source}\n${tag};`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function git(args, cwd) {
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toUpperCase().startsWith('GIT_')) delete env[key];
    }
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env,
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim();
    fail(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
}

function samePath(a, b) {
  const normalize = (value) => {
    let resolved;
    try {
      resolved = realpathSync.native(value);
    } catch {
      resolved = path.resolve(value);
    }
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}

export function committedProducerSources(projectRoot = REPO_ROOT) {
  const root = path.resolve(projectRoot);
  const topLevel = git(['rev-parse', '--show-toplevel'], root);
  if (!samePath(topLevel, root)) {
    fail(`producer root ${root} is not the active Git worktree root ${topLevel}`);
  }
  const dirty = git([
    'status', '--porcelain=v1', '--untracked-files=all', '--', ...TRIGGER_FANOUT_PRODUCER_SOURCES,
  ], root);
  if (dirty) {
    fail('producer sources are dirty or untracked; commit the reviewed generator and helpers first');
  }
  return TRIGGER_FANOUT_PRODUCER_SOURCES.map((relativePath) => {
    const absolutePath = path.join(root, ...relativePath.split('/'));
    const bytes = readFileSync(absolutePath);
    const headBlob = git(['rev-parse', `HEAD:${relativePath}`], root);
    const currentBlob = git(['hash-object', absolutePath], root);
    if (!/^[0-9a-f]{40,64}$/.test(headBlob) || currentBlob !== headBlob) {
      fail(`${relativePath} does not match its committed HEAD blob`);
    }
    return {
      path: relativePath,
      git_blob: headBlob,
      sha256: sha256(bytes),
    };
  });
}

function writeAtomically(filePath, text) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  try {
    writeFileSync(tempPath, text, { encoding: 'utf8', flag: 'wx' });
    renameSync(tempPath, filePath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export function buildTriggerFanoutAttestation({ manifestBytes, manifest, producerSources }) {
  return {
    format_version: TRIGGER_FANOUT_ATTESTATION_FORMAT,
    kind: 'crx-trigger-fanout-attestation',
    manifest: {
      path: 'scripts/trigger-fanout.json',
      sha256: sha256(manifestBytes),
    },
    source_project: manifest._meta.source_project,
    captured_at: manifest._meta.captured_at,
    producer: {
      wrapper: 'scripts/generate-trigger-fanout.mjs',
      sources: producerSources,
    },
  };
}

export function buildTriggerFanoutManifest(payload, projectId = CRX_SUPABASE_PROJECT_ID) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('linked query returned an invalid trigger_fanout_capture envelope');
  }
  const expectedKeys = [
    'captured_at', 'check_constraints', 'event_triggers', 'foreign_keys', 'routines', 'rules',
    'tables_scanned', 'triggers',
  ];
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
      !Array.isArray(payload.event_triggers) ||
      !Array.isArray(payload.foreign_keys) || !Array.isArray(payload.rules) ||
      !Array.isArray(payload.check_constraints)) {
    fail('routines, triggers, event_triggers, rules, check_constraints, and foreign_keys must be arrays');
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
      .map((routine) => `public.${routine.name}`),
  );
  const nonPublicEffectCallNames = new Set(
    routines
      .filter((routine) => {
        const code = applyTimeCode(`DO $crx_scan$ ${routine.source} $crx_scan$;`).code.toLowerCase();
        return /\b(?:perform|call)\s+(?!public\.)[a-z_][a-z0-9_$]*\s*\./.test(code);
      })
      .map((routine) => `public.${routine.name}`),
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

  // Event triggers are database-wide DDL hooks, not table fan-out edges. Bind
  // their event, enabled mode, routine identity, language and body hash into the
  // linked capture. Consumers refuse any enabled entry until DDL-event effects
  // can be modeled as precisely as ordinary row triggers.
  const eventTriggers = payload.event_triggers.map((trigger) => {
    if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) {
      fail('event trigger is invalid');
    }
    const keys = Object.keys(trigger).sort();
    if (JSON.stringify(keys) !== JSON.stringify([
      'enabled', 'enabled_mode', 'event', 'has_sql_body', 'language', 'name',
      'routine_config', 'routine_name', 'routine_oid', 'routine_schema', 'source',
    ])) {
      fail('event trigger has an unexpected shape');
    }
    if (typeof trigger.enabled !== 'boolean' ||
        typeof trigger.enabled_mode !== 'string' || !/^[ODRA]$/.test(trigger.enabled_mode) ||
        trigger.enabled !== (trigger.enabled_mode !== 'D')) {
      fail('event trigger enabled state is invalid');
    }
    if (typeof trigger.routine_oid !== 'string' || !/^\d+$/.test(trigger.routine_oid) ||
        typeof trigger.source !== 'string' || typeof trigger.has_sql_body !== 'boolean') {
      fail('event trigger routine metadata is invalid');
    }
    const name = bareName(trigger.name, 'event trigger name');
    const event = bareName(trigger.event, 'event trigger event');
    const routineSchema = bareName(trigger.routine_schema, 'event trigger routine schema');
    const routineName = bareName(trigger.routine_name, 'event trigger routine name');
    const language = bareName(trigger.language, 'event trigger routine language');
    const config = routineConfig(trigger.routine_config);
    const catalogBinding = eventCatalogBinding(config);
    const readablePlpgsqlBody = language === 'plpgsql' &&
      !trigger.has_sql_body && Boolean(trigger.source.trim());
    const sessionCatalogRequired =
      readablePlpgsqlBody && catalogBinding === 'session' &&
      usesUnqualifiedEventMetadataHelper(trigger.source);
    const effect = applyTimeWriteTargets(
      `DO $crx_event$ ${trigger.source} $crx_event$;`,
      {
        trustedUnqualifiedRoutines: catalogBinding !== 'unsafe'
          ? [...EVENT_METADATA_HELPERS, ...EVENT_READONLY_BUILTINS]
          : [],
      },
    );
    const noWriteProof = readablePlpgsqlBody &&
      !effect.unresolved && !effect.unsupportedRoutineIdentity &&
      effect.unknownCalls.length === 0 && effect.dynamicWrites.length === 0 &&
      effect.targets.size === 0 && effect.tables.size === 0;
    const effectSummary = {
      safe: noWriteProof && !sessionCatalogRequired,
      session_catalog_required: sessionCatalogRequired,
      unresolved: effect.unresolved || !readablePlpgsqlBody,
      unsupported_routine_identity: effect.unsupportedRoutineIdentity,
      unknown_calls: [...effect.unknownCalls].sort(),
      targets: [...effect.targets].sort(),
      tables: [...effect.tables].sort(),
      dynamic_write_count: effect.dynamicWrites.length,
    };
    return {
      name,
      event,
      enabled: trigger.enabled,
      enabled_mode: trigger.enabled_mode,
      routine_oid: trigger.routine_oid,
      routine_schema: routineSchema,
      routine_name: routineName,
      routine_config: config,
      language,
      has_sql_body: trigger.has_sql_body,
      effect: effectSummary,
      routine_hash: sha256(JSON.stringify({
        language,
        has_sql_body: trigger.has_sql_body,
        routine_config: config,
        source: trigger.source,
      })),
    };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.routine_oid.localeCompare(b.routine_oid));

  // Rewrite rules are persisted executable catalog state. Their actions can
  // call resident mutators, and a rule created by an older migration can fire
  // while a later migration is applying. Bind the exact live definition into
  // the capture; the guard conservatively treats a fired rule as unresolved.
  const rules = payload.rules.map((rule) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule) ||
        JSON.stringify(Object.keys(rule).sort()) !==
          JSON.stringify(['definition', 'event', 'name', 'oid', 'relation'])) {
      fail('rule has an unexpected shape');
    }
    if (typeof rule.oid !== 'string' || !/^\d+$/.test(rule.oid) ||
        typeof rule.definition !== 'string' || !rule.definition.trim()) {
      fail('rule identity or definition is invalid');
    }
    if (typeof rule.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(rule.name)) {
      fail('rule name is invalid');
    }
    const name = rule.name;
    const relation = capturedRelationName(rule.relation, 'rule relation');
    const event = bareName(rule.event, 'rule event');
    if (!new Set(['select', 'insert', 'update', 'delete']).has(event)) {
      fail(`rule ${name} has an invalid event`);
    }
    return {
      oid: rule.oid,
      name,
      relation,
      event,
      definition_hash: sha256(rule.definition),
    };
  }).sort((a, b) => a.relation.localeCompare(b.relation) ||
    a.event.localeCompare(b.event) || a.name.localeCompare(b.name) || a.oid.localeCompare(b.oid));

  // Table CHECK expressions are persisted executable catalog state. PostgreSQL
  // reevaluates them on later INSERT/UPDATE statements, and a user-defined
  // routine referenced by the expression can itself mutate authoritative rows.
  // Bind each constraint-to-routine dependency and keep its table opaque.
  const checkConstraints = payload.check_constraints.map((constraint) => {
    if (!constraint || typeof constraint !== 'object' || Array.isArray(constraint) ||
        JSON.stringify(Object.keys(constraint).sort()) !==
          JSON.stringify([
            'definition', 'name', 'oid', 'relation', 'routine_name', 'routine_oid', 'routine_schema',
          ])) {
      fail('check constraint has an unexpected shape');
    }
    if (typeof constraint.oid !== 'string' || !/^\d+$/.test(constraint.oid) ||
        typeof constraint.routine_oid !== 'string' || !/^\d+$/.test(constraint.routine_oid) ||
        typeof constraint.definition !== 'string' || !constraint.definition.trim()) {
      fail('check constraint identity, routine, or definition is invalid');
    }
    if (typeof constraint.name !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(constraint.name)) {
      fail('check constraint name is invalid');
    }
    const relation = capturedRelationName(constraint.relation, 'check constraint relation');
    if (relation.includes('.') || !tableSet.has(relation)) {
      fail(`check constraint ${constraint.name} is outside the captured public table universe`);
    }
    const routineSchema = bareName(constraint.routine_schema, 'check constraint routine schema');
    const routineName = bareName(constraint.routine_name, 'check constraint routine name');
    return {
      oid: constraint.oid,
      name: constraint.name,
      relation,
      routine_schema: routineSchema,
      routine_name: routineName,
      routine_oid: constraint.routine_oid,
      definition_hash: sha256(constraint.definition),
    };
  }).sort((a, b) => a.relation.localeCompare(b.relation) ||
    a.name.localeCompare(b.name) || a.oid.localeCompare(b.oid) ||
    a.routine_oid.localeCompare(b.routine_oid));

  const writeAction = new Set(['c', 'n', 'd']);
  const foreignKeys = payload.foreign_keys.map((foreignKey) => {
    if (!foreignKey || typeof foreignKey !== 'object' || Array.isArray(foreignKey)) {
      fail('foreign key is invalid');
    }
    const keys = Object.keys(foreignKey).sort();
    if (JSON.stringify(keys) !==
        JSON.stringify([
          'child_schema', 'child_table', 'oid', 'on_delete', 'on_update',
          'parent_schema', 'parent_table',
        ])) {
      fail('foreign key has an unexpected shape');
    }
    if (typeof foreignKey.oid !== 'string' || !/^\d+$/.test(foreignKey.oid)) {
      fail('foreign key oid is invalid');
    }
    const parent = relationName(
      foreignKey.parent_schema,
      foreignKey.parent_table,
      'foreign key parent',
    );
    const childSchema = bareName(foreignKey.child_schema, 'foreign key child schema');
    const child = bareName(foreignKey.child_table, 'foreign key child table');
    if (childSchema !== 'public' || !tableSet.has(child) ||
        (!parent.includes('.') && !tableSet.has(parent))) {
      fail(`foreign key ${foreignKey.oid} is outside the captured public-child boundary`);
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
    for (const identity of analysed.invokedRoutines) {
      const name = identity.startsWith('public.') ? identity.slice('public.'.length) : identity;
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

  // This PR introduces the first checked-in live fan-out artifact, so there is
  // no independently trusted base graph against which omissions can be judged.
  // Preserve the captured edges for review, but fail closed operationally by
  // marking every captured source opaque, including a schema-qualified
  // non-public FK parent whose referential action writes a public child. A
  // later change may narrow this only
  // after adding an independently bound live-capture attestation; the staleness
  // checker rejects simply deleting these opacity markers.
  const bootstrapOpaque = [...new Set([
    ...tablesScanned,
    ...Object.keys(sorted),
    ...checkConstraints.map((constraint) => constraint.relation),
  ])].sort();

  return {
    _meta: {
      format_version: TRIGGER_FANOUT_FORMAT,
      captured_at: payload.captured_at,
      generator: 'scripts/generate-trigger-fanout.mjs',
      capture_method: 'supabase-cli-db-query-linked',
      source_project: projectId,
      scope:
        'Transitive trigger and FK writes plus bound event-trigger, rewrite-rule, and CHECK-routine state; unresolved effects are opaque.',
      bootstrap_policy: 'all-captured-sources-opaque-until-independent-attestation',
      regenerate: 'node scripts/generate-trigger-fanout.mjs',
    },
    tables_scanned: tablesScanned,
    event_triggers: eventTriggers,
    rules,
    check_constraints: checkConstraints,
    opaque_on_tables: bootstrapOpaque,
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
  writeAtomically(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, outPath };
}

export function mintTriggerFanoutEvidence({
  projectRoot = REPO_ROOT,
  linkedRoot,
  run,
  outPath = path.join(projectRoot, 'scripts', 'trigger-fanout.json'),
  attestationPath = path.join(projectRoot, '.claude', 'session-state', 'trigger-fanout-attestation.json'),
} = {}) {
  const producerSources = committedProducerSources(projectRoot);
  const result = captureTriggerFanout({
    projectDir: projectRoot,
    linkedRoot,
    run,
    outPath,
  });
  const manifestBytes = readFileSync(result.outPath);
  const attestation = buildTriggerFanoutAttestation({
    manifestBytes,
    manifest: result.manifest,
    producerSources,
  });
  writeAtomically(attestationPath, `${JSON.stringify(attestation, null, 2)}\n`);
  return { ...result, attestation, attestationPath };
}

function main() {
  if (process.argv.slice(2).length) {
    fail('usage: node scripts/generate-trigger-fanout.mjs (no arguments or stdin)');
  }
  const { manifest, outPath } = mintTriggerFanoutEvidence({
    projectRoot: REPO_ROOT,
    outPath: OUT,
    attestationPath: ATTESTATION,
  });
  const edgeCount = Object.values(manifest.fanout).reduce((count, rows) => count + rows.length, 0);
  process.stdout.write(
    `generate-trigger-fanout: wrote ${outPath}\n  ${manifest.tables_scanned.length} tables, ` +
    `${edgeCount} cascade edges, ${manifest.opaque_on_tables.length} opaque source tables, ` +
    `${manifest.event_triggers.length} event triggers, ` +
    `${manifest.check_constraints.length} custom-routine CHECK dependencies\n`,
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
