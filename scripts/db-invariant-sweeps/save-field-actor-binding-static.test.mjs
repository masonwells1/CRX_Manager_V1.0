#!/usr/bin/env node
/**
 * Fast, Docker-free guard that binds the shipped save_field migration body to
 * the standing live-sweep fingerprint. The disposable PostgreSQL proof still
 * exercises database behavior; this guard makes body drift fail in ordinary
 * correction-guard CI even when Docker is unavailable.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20260729222311_bind_save_field_actor.sql');
const PREDICATE = path.join(ROOT, 'scripts', 'db-invariant-sweeps', 'predicates', 'save-field-actor-binding.sql');
const SIGNATURE = 'CREATE OR REPLACE FUNCTION public.save_field(';

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const migration = readFileSync(MIGRATION, 'utf8');
const predicate = readFileSync(PREDICATE, 'utf8');
const start = migration.indexOf(SIGNATURE);
assert.notEqual(start, -1, 'save_field definition is missing from the migration');

const bodyMatch = migration.slice(start).match(/AS \$\$([\s\S]*?)\$\$;/);
assert.ok(bodyMatch, 'save_field dollar-quoted body is missing from the migration');
const body = bodyMatch[1];

const fingerprints = predicate.match(/\b[0-9a-f]{64}\b/g) ?? [];
assert.equal(fingerprints.length, 1, 'predicate must embed exactly one reviewed SHA-256 fingerprint');
assert.equal(
  sha256(body),
  fingerprints[0],
  'checked-in save_field body drifted from the standing live-sweep fingerprint',
);

const alteredBody = body.replace('RETURN v_field_id;', 'RETURN v_field_id ;');
assert.notEqual(alteredBody, body, 'drift fixture must alter the function body');
assert.notEqual(sha256(alteredBody), fingerprints[0], 'cosmetic function-body drift must fail closed');

console.log('SAVE_FIELD_ACTOR_BINDING_STATIC_TEST_PASS');
