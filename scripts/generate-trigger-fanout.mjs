#!/usr/bin/env node
// Generate scripts/trigger-fanout.json — the manifest of live triggers that
// rewrite a DIFFERENT table than the one being written.
//
// WHY THIS FILE EXISTS
// --------------------
// The approved-set gate in scripts/validate-sql-migrations.sh proves that a
// bulk repair rewrote exactly the rows it hashed: capture an id set, hash those
// rows, compare the hash against the approved digest, write, assert the row
// count. That proof is airtight for the table named in the UPDATE — and blind
// to every row a TRIGGER rewrites as a side effect.
//
//   UPDATE public.order_items SET total_price = 0 WHERE id = ANY(v_ids);
//
// looks fully bound. On the live database `trg_recalc_order_totals` fires and
// rewrites public.orders. Those order rows were never captured, never hashed,
// and are not counted by the ROW_COUNT assertion, so an approved repair on a
// child table silently rewrites money on the parent with no proof at all.
//
// The validator is a text scanner; it cannot know the live trigger graph. This
// manifest is that graph, captured from the live catalog and checked in, so the
// gate can fold each cascade target into the set of tables the repair must
// bind.
//
// SCOPE: UPDATE / DELETE / MERGE plus INSERT ... ON CONFLICT DO UPDATE. A plain
// INSERT creates rows that did not exist when the digest was taken, so no
// before-state digest could have covered them; an UPSERT conflict arm rewrites
// a pre-existing row and therefore belongs in the graph.
//
// HOW TO REGENERATE
// -----------------
// Run this query against the live database (read-only), save the single
// `payload` value to a file, and feed it in:
//
//   node scripts/generate-trigger-fanout.mjs --from-introspection payload.json
//   node scripts/generate-trigger-fanout.mjs --from-introspection -   # stdin
//
// The query:
//
//   WITH trg AS (
//     SELECT DISTINCT c.relname AS on_table, p.proname AS fn,
//            lower(coalesce(p.prosrc, '')) AS src,
//            (p.prosrc IS NULL OR btrim(p.prosrc) = '') AS opaque
//     FROM pg_trigger t
//     JOIN pg_class c ON c.oid = t.tgrelid
//     JOIN pg_namespace n ON n.oid = c.relnamespace
//     JOIN pg_proc p ON p.oid = t.tgfoid
//     WHERE NOT t.tgisinternal AND n.nspname = 'public'
//   ), tbl AS (
//     SELECT tablename FROM pg_tables WHERE schemaname = 'public'
//   ), edges AS (
//     SELECT trg.on_table, tbl.tablename AS target, trg.fn AS via
//     FROM trg JOIN tbl ON tbl.tablename <> trg.on_table
//       AND (
//         trg.src ~ ('(^|[^a-z0-9_])(update|delete[[:space:]]+from|merge'
//                    || '[[:space:]]+into)[[:space:]]+(only[[:space:]]+)?'
//                    || '(public\.)?' || tbl.tablename || '([^a-z0-9_]|$)')
//         OR trg.src ~ ('(^|[^a-z0-9_])insert[[:space:]]+into[[:space:]]+'
//                    || '(public\.)?' || tbl.tablename
//                    || '[^;]*on[[:space:]]+conflict[^;]*do[[:space:]]+update'
//                    || '[[:space:]]+set[[:space:]]+')
//       )
//   )
//   SELECT jsonb_pretty(jsonb_build_object(
//     'tables_scanned',   (SELECT jsonb_agg(tablename ORDER BY tablename) FROM tbl),
//     'opaque_on_tables', (SELECT coalesce(jsonb_agg(DISTINCT on_table), '[]'::jsonb)
//                            FROM trg WHERE opaque),
//     'edges',            (SELECT coalesce(jsonb_agg(jsonb_build_object(
//                            'on_table', on_table, 'target', target, 'via', via)
//                            ORDER BY on_table, target, via), '[]'::jsonb) FROM edges)
//   )) AS payload;
//
// `opaque_on_tables` is the fail-closed escape hatch. A trigger function
// compiled with BEGIN ATOMIC stores a parsed body, not source text, so prosrc
// comes back blank and the text scan above cannot see what it writes. Any table
// carrying such a trigger is listed there, and the validator refuses to accept
// an approved-set proof that touches it rather than assuming it is clean. The
// live database has none today; the field exists so that the day one appears,
// the gate tightens instead of quietly going blind.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'trigger-fanout.json');
const SOURCE_PROJECT = 'rhyzpcqhnizqbxphqdkr';

const die = (msg) => {
  process.stderr.write(`generate-trigger-fanout: ${msg}\n`);
  process.exit(1);
};

const argv = process.argv.slice(2);
const flag = argv.indexOf('--from-introspection');
if (flag === -1 || !argv[flag + 1]) {
  die('usage: generate-trigger-fanout.mjs --from-introspection <file.json | ->');
}
const src = argv[flag + 1];
const stampArg = argv.indexOf('--generated-at');
const generatedAt = stampArg === -1 ? null : argv[stampArg + 1];
if (stampArg !== -1 && !generatedAt) die('--generated-at needs a value');

let raw;
try {
  raw = readFileSync(src === '-' ? 0 : src, 'utf8');
} catch (err) {
  die(`cannot read ${src}: ${err.message}`);
}

let payload;
try {
  payload = JSON.parse(raw);
} catch (err) {
  die(`introspection payload is not JSON: ${err.message}`);
}
// jsonb_pretty returns the object as a string when it arrives through a JSON
// transport, so one extra unwrap keeps a copy-pasted result usable as-is.
if (typeof payload === 'string') {
  try {
    payload = JSON.parse(payload);
  } catch (err) {
    die(`introspection payload is a string that is not JSON: ${err.message}`);
  }
}

const names = (v, what) => {
  if (!Array.isArray(v)) die(`${what} must be an array`);
  for (const n of v) {
    if (typeof n !== 'string' || !/^[a-z0-9_]+$/.test(n)) {
      die(`${what} contains a name that is not a bare identifier: ${JSON.stringify(n)}`);
    }
  }
  return [...new Set(v)].sort();
};

const tablesScanned = names(payload.tables_scanned, 'tables_scanned');
// The manifest drives a fail-closed staleness check: the validator refuses
// every approved-set proof when a protected table is missing from this list.
// A truncated scan would therefore wedge the gate, so catch it here instead.
if (tablesScanned.length < 100) {
  die(`tables_scanned holds only ${tablesScanned.length} tables — the scan looks truncated`);
}
const opaqueOnTables = names(payload.opaque_on_tables ?? [], 'opaque_on_tables');

if (!Array.isArray(payload.edges)) die('edges must be an array');
const fanout = {};
for (const e of payload.edges) {
  for (const k of ['on_table', 'target', 'via']) {
    if (typeof e?.[k] !== 'string' || !/^[a-z0-9_]+$/.test(e[k])) {
      die(`edge field ${k} is not a bare identifier: ${JSON.stringify(e)}`);
    }
  }
  if (e.on_table === e.target) continue; // self-writes are already bound
  if (!tablesScanned.includes(e.on_table)) die(`edge source ${e.on_table} is not in tables_scanned`);
  if (!tablesScanned.includes(e.target)) die(`edge target ${e.target} is not in tables_scanned`);
  (fanout[e.on_table] ??= []).push({ target: e.target, via: e.via });
}
// Deterministic output: regenerating without a schema change must produce a
// byte-identical file, or every regeneration shows up as noise in review.
const sorted = {};
for (const t of Object.keys(fanout).sort()) {
  const seen = new Set();
  sorted[t] = fanout[t]
    .filter((r) => {
      const k = `${r.target}\t${r.via}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.target.localeCompare(b.target) || a.via.localeCompare(b.via));
}

const manifest = {
  _meta: {
    generated_at: generatedAt ?? new Date().toISOString(),
    generator: 'scripts/generate-trigger-fanout.mjs',
    source_project: SOURCE_PROJECT,
    purpose:
      'Live triggers that rewrite a different table than the one written. The approved-set ' +
      'gate in scripts/validate-sql-migrations.sh folds each target into the set of tables a ' +
      'bulk repair must capture, hash and count.',
    scope:
      'UPDATE/DELETE/MERGE plus INSERT ... ON CONFLICT DO UPDATE. Plain INSERT is excluded.',
    regenerate: 'node scripts/generate-trigger-fanout.mjs --from-introspection <payload.json>',
  },
  tables_scanned: tablesScanned,
  opaque_on_tables: opaqueOnTables,
  fanout: sorted,
};

writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
const edgeCount = Object.values(sorted).reduce((n, r) => n + r.length, 0);
process.stdout.write(
  `wrote ${OUT}\n  ${tablesScanned.length} tables scanned, ` +
    `${Object.keys(sorted).length} source tables, ${edgeCount} cascade edges, ` +
    `${opaqueOnTables.length} unreadable trigger bodies\n`
);
