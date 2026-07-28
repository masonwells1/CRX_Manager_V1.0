#!/usr/bin/env node

// Normalize a raw `pg_dump` capture into the public-schema baseline artifact.
//
// Capture with:
//   pg_dump --schema=public --schema-only --quote-all-identifiers --no-owner
//
// `supabase db dump` is not used here: it post-processes the dump and strips `--`
// comment lines out of function bodies, so three production functions came back
// from a restore with different source than live. Raw pg_dump preserves them.
//
// Raw pg_dump output is deterministic except for the `\restrict`/`\unrestrict`
// meta-commands, whose token is randomised per run. Those are psql-side guards
// against a hostile dump being sourced interactively; the restore here is a
// scripted `psql -f` of a file this repo hashes, so removing them costs nothing
// and makes the artifact byte-stable.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg) {
  console.error('Usage: node scripts/build-schema-baseline-public.mjs <raw-pg_dump.sql> <output.sql>');
  process.exit(1);
}

const sourcePath = path.resolve(sourceArg);
const outputPath = path.resolve(outputArg);
const raw = readFileSync(sourcePath, 'utf8');

const RESTRICT_LINE = /^\\(?:un)?restrict \S+$/;
// Default privileges are owned by the ACL lockdown artifact, which captures them
// from live and re-applies them after resetting the target. Two of pg_dump's
// copies are `FOR ROLE "supabase_admin"`, which the project owner cannot execute —
// leaving them here aborts the restore outright.
const DEFAULT_ACL_LINE = /^ALTER DEFAULT PRIVILEGES /;
const lines = raw.split(/\r?\n/);
const restrictLines = lines.filter((line) => RESTRICT_LINE.test(line)).length;
if (restrictLines === 0) {
  throw new Error('no \\restrict/\\unrestrict markers found; this does not look like a pg_dump 17 capture');
}
const defaultAclLines = lines.filter((line) => DEFAULT_ACL_LINE.test(line)).length;
if (defaultAclLines === 0) {
  throw new Error('no ALTER DEFAULT PRIVILEGES found; the capture is missing the default ACL section');
}

let schemaCreates = 0;
const normalized = lines
  .filter((line) => !RESTRICT_LINE.test(line) && !DEFAULT_ACL_LINE.test(line))
  .map((line) => {
    // The target of a restore is a platform-initialised Supabase project, which
    // already has a public schema. Plain CREATE SCHEMA would abort the restore.
    if (line === 'CREATE SCHEMA "public";') {
      schemaCreates += 1;
      return 'CREATE SCHEMA IF NOT EXISTS "public";';
    }
    return line;
  })
  .join('\n')
  .replace(/\n*$/, '\n');

if (schemaCreates !== 1) {
  throw new Error(`expected exactly one CREATE SCHEMA "public"; found ${schemaCreates}`);
}

const countMatches = (pattern) => [...normalized.matchAll(pattern)].length;
const counts = {
  public_tables: countMatches(/^CREATE TABLE /gm),
  public_app_functions: countMatches(/^CREATE (?:OR REPLACE )?FUNCTION /gm),
  public_policies: countMatches(/^CREATE POLICY /gm),
};
for (const [key, value] of Object.entries(counts)) {
  if (value === 0) {
    throw new Error(`${key} came back as 0; the capture is incomplete`);
  }
}

// A schema baseline must never carry business rows or a credential. Both checks
// are also enforced by verify-schema-baseline.mjs; failing here means the bad
// artifact is never written in the first place.
if (/^(?:COPY|INSERT INTO) "public"/m.test(normalized)) {
  throw new Error('capture contains business data');
}
if (/^CREATE EXTENSION/m.test(normalized)) {
  throw new Error('capture contains CREATE EXTENSION; extensions belong in the extensions artifact');
}
for (const pattern of [
  /postgres(?:ql)?:\/\//i,
  /SUPABASE_(?:SERVICE_ROLE|ANON)_KEY/i,
  /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}/,
]) {
  if (pattern.test(normalized)) {
    throw new Error(`capture contains a credential-shaped value matching ${pattern}`);
  }
}

writeFileSync(outputPath, normalized, 'utf8');
console.log(
  JSON.stringify(
    {
      source: sourcePath,
      output: outputPath,
      bytes: Buffer.byteLength(normalized, 'utf8'),
      restrict_markers_removed: restrictLines,
      default_privilege_statements_removed: defaultAclLines,
      ...counts,
    },
    null,
    2,
  ),
);
