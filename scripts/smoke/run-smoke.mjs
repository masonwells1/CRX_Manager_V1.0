#!/usr/bin/env node
/**
 * run-smoke.mjs - rolled-back e2e smoke-chain runner (C2 control, minimal slice)
 *
 * THE HARD RULE: a fix is "fixed" only when its full business-chain spec
 * passes end-to-end - never an isolated probe. (See README.md and
 * docs/audits/2026-06-10-error-prevention-review.md sections 2/RC3 and 4/C2.)
 *
 * Zero dependencies. Two execution modes:
 *
 *   1. Claude-first (default, no SUPABASE_DB_URL): prints each selected chain
 *      with banners + instructions so Claude (or a human) executes the SQL as
 *      ONE statement via Supabase MCP execute_sql and interprets the result.
 *
 *   2. psql (SUPABASE_DB_URL set): executes each chain via `psql -1 -f` and
 *      interprets the result itself.
 *
 * Result contract (both modes): every chain is a single DO block that ALWAYS
 * raises. Error text containing SMOKE_PASS_ROLLBACK = PASS (and proves the
 * rollback fired). Anything else = FAIL, reported with the message.
 *
 * Usage:
 *   node scripts/smoke/run-smoke.mjs --list
 *   node scripts/smoke/run-smoke.mjs --spec <rpc> [--spec <rpc> ...]
 *   node scripts/smoke/run-smoke.mjs --area <area> [--area <area> ...]
 *   node scripts/smoke/run-smoke.mjs --all
 *
 * --spec <rpc> matches a spec key OR any entry in a spec's "covers" array,
 * so `--spec receive_return` selects the return-credit chain.
 * --area <area> selects every spec tagged with that business area in its
 * "area" array (see scripts/test-areas.json for the area vocabulary).
 *
 * Exit codes: 0 = all PASS (or list/print-only mode), 1 = any FAIL,
 *             2 = usage / selection / spec-registry error.
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SMOKE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SPECS_PATH = path.join(SMOKE_DIR, 'smoke-specs.json');
const AREAS_PATH = path.join(SMOKE_DIR, '..', 'test-areas.json');
const PASS_TOKEN = 'SMOKE_PASS_ROLLBACK';

/** Area vocabulary comes from scripts/test-areas.json so the two files can't drift. */
const VALID_AREAS = (() => {
  try {
    return new Set(Object.keys(JSON.parse(readFileSync(AREAS_PATH, 'utf8')).areas || {}));
  } catch {
    return new Set(); // missing/broken manifest -> every tag reports as unknown, loudly
  }
})();

function fail(msg, code = 2) {
  console.error(`run-smoke: ${msg}`);
  process.exit(code);
}

function loadSpecs() {
  if (!existsSync(SPECS_PATH)) fail(`spec registry not found: ${SPECS_PATH}`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(SPECS_PATH, 'utf8'));
  } catch (e) {
    fail(`smoke-specs.json is not valid JSON: ${e.message}`);
  }
  const specs = parsed.specs;
  if (!specs || typeof specs !== 'object' || Object.keys(specs).length === 0) {
    fail('smoke-specs.json has no "specs" entries');
  }
  for (const [key, spec] of Object.entries(specs)) {
    if (!spec.chain) fail(`spec "${key}" is missing "chain"`);
    if (!Array.isArray(spec.covers) || spec.covers.length === 0) {
      fail(`spec "${key}" is missing a non-empty "covers" array`);
    }
    if (!Array.isArray(spec.area) || spec.area.length === 0 ||
        spec.area.some((a) => typeof a !== 'string' || !a.trim())) {
      fail(`spec "${key}" is missing a non-empty "area" array (business-area tags; see scripts/test-areas.json)`);
    }
    // A typo'd tag ("billng") would pass here but silently vanish from every
    // area slice (Codex P2 on PR #191) — validate against the manifest vocabulary.
    const badAreas = spec.area.filter((a) => !VALID_AREAS.has(a));
    if (badAreas.length) {
      fail(`spec "${key}" has unknown area tag(s): ${badAreas.join(', ')} (valid: ${[...VALID_AREAS].join(', ')})`);
    }
    // A chain that seeds its own customer/order fixtures cannot run against the
    // live database. Marking that in prose only is not a guard (CodeRabbit, PR
    // #384): --all and --area would still select it. Must be a real boolean.
    if ('container_only' in spec && typeof spec.container_only !== 'boolean') {
      fail(`spec "${key}" has a non-boolean "container_only" (expected true/false)`);
    }
    if (spec.container_only && !spec.container_prover) {
      fail(`spec "${key}" is container_only but names no "container_prover" to run instead`);
    }
    const file = path.join(SMOKE_DIR, spec.chain);
    if (!existsSync(file)) fail(`spec "${key}" points at a missing chain file: ${spec.chain}`);
    if (spec.container_prover) {
      const prover = path.join(SMOKE_DIR, spec.container_prover);
      if (!existsSync(prover)) {
        fail(`spec "${key}" points at a missing container prover: ${spec.container_prover}`);
      }
    }
  }
  return specs;
}

/**
 * Drop container-only chains from any selection that can include them. Naming
 * one by key is handled separately: that should fail before reaching this skip.
 */
function dropContainerOnly(selected) {
  const skipped = [];
  for (const [key, spec] of [...selected]) {
    if (spec.container_only) {
      selected.delete(key);
      skipped.push([key, spec]);
    }
  }
  return skipped;
}

function parseArgs(argv) {
  const args = { list: false, all: false, specs: [], areas: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list' || a === '-l') args.list = true;
    else if (a === '--all' || a === '-a') args.all = true;
    else if (a === '--spec' || a === '-s') {
      const v = argv[++i];
      if (!v) fail('--spec requires an RPC name');
      args.specs.push(v);
    } else if (a === '--area') {
      const v = argv[++i];
      if (!v) fail('--area requires an area name');
      args.areas.push(v);
    } else if (a === '--help' || a === '-h') args.help = true;
    else if (!a.startsWith('-')) args.specs.push(a); // bare positional = spec name
    else fail(`unknown flag: ${a}`);
  }
  return args;
}

function selectSpecs(specs, names) {
  const selected = new Map(); // key -> spec (dedup: one chain covers many RPCs)
  const misses = [];
  for (const name of names) {
    let hit = false;
    for (const [key, spec] of Object.entries(specs)) {
      if (key === name || spec.covers.includes(name)) {
        selected.set(key, spec);
        hit = true;
      }
    }
    if (!hit) misses.push(name);
  }
  return { selected, misses };
}

function printList(specs) {
  console.log('Smoke-chain registry (scripts/smoke/smoke-specs.json)\n');
  for (const [key, spec] of Object.entries(specs)) {
    console.log(`  ${key}`);
    console.log(`    chain:  ${spec.chain}`);
    console.log(`    covers: ${spec.covers.join(', ')}`);
    console.log(`    area:   ${spec.area.join(', ')}`);
    if (spec.container_only) {
      console.log(`    NOTE:   CONTAINER ONLY — not run by --all/--area; use node scripts/smoke/${spec.container_prover}`);
    }
    console.log(`    ${spec.description}\n`);
  }
  console.log(
    'HARD RULE: a migration-touched RPC is "fixed"/"done" only when a chain\n' +
    'covering it passes end-to-end (error text = SMOKE_PASS_ROLLBACK).'
  );
}

/** PASS iff the error text contains the pass token; otherwise FAIL + message. */
function interpretResult(outputText) {
  if (outputText.includes(PASS_TOKEN)) return { pass: true };
  const lines = outputText.split(/\r?\n/).filter((l) => l.trim());
  const errLine =
    lines.find((l) => /SMOKE_FAIL|SMOKE_SETUP/.test(l)) ||
    lines.find((l) => /ERROR:|FATAL:/.test(l)) ||
    lines[lines.length - 1] ||
    '(no output)';
  return { pass: false, message: errLine.trim() };
}

function runViaPsql(key, spec, dbUrl) {
  const file = path.join(SMOKE_DIR, spec.chain);
  // -1: single transaction (belt-and-braces; the DO block is one statement
  // anyway). ON_ERROR_STOP so the expected terminal RAISE ends the run.
  const res = spawnSync(
    'psql',
    [dbUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', file],
    { encoding: 'utf8' }
  );
  if (res.error) {
    return { pass: false, message: `psql could not be spawned: ${res.error.message}` };
  }
  return interpretResult(`${res.stdout || ''}\n${res.stderr || ''}`);
}

function printForClaude(key, spec) {
  const file = path.join(SMOKE_DIR, spec.chain);
  const sql = readFileSync(file, 'utf8');
  const bar = '='.repeat(74);
  console.log(bar);
  console.log(`SMOKE SPEC: ${key}   (${spec.chain})`);
  console.log(`COVERS:     ${spec.covers.join(', ')}`);
  console.log(bar);
  console.log('EXECUTE the SQL below as ONE statement via Supabase MCP execute_sql');
  console.log('(project rhyzpcqhnizqbxphqdkr). Interpret the result:');
  console.log(`  * error message contains '${PASS_TOKEN}'  -> PASS (rollback fired)`);
  console.log('  * ANY other error (or no error at all)      -> FAIL: report the message');
  console.log(`${bar}\n`);
  console.log(sql);
  console.log(`\n--- end of ${spec.chain} ---\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const specs = loadSpecs();

  if (args.help || (!args.list && !args.all && args.specs.length === 0 && args.areas.length === 0)) {
    console.log(
      'Usage: node scripts/smoke/run-smoke.mjs --list | --spec <rpc> [...] | --area <area> [...] | --all\n\n' +
      'Modes: SUPABASE_DB_URL set -> executes via psql and reports PASS/FAIL;\n' +
      '       otherwise prints each chain with banners for Claude/MCP execution.\n\n' +
      `PASS contract: chain error text contains '${PASS_TOKEN}'.`
    );
    process.exit(args.help ? 0 : 2);
  }

  if (args.list) {
    printList(specs);
    return;
  }

  let selected;
  if (args.all) {
    selected = new Map(Object.entries(specs));
  } else {
    selected = new Map();
    if (args.specs.length) {
      const { selected: sel, misses } = selectSpecs(specs, args.specs);
      if (misses.length) {
        fail(
          `no spec covers: ${misses.join(', ')}\n` +
          'If this RPC was touched by a migration, a chain spec is REQUIRED before\n' +
          'declaring it fixed - add one (see scripts/smoke/README.md).'
        );
      }
      // Naming a container-only chain BY ITS KEY is a mistake worth stopping on.
      // Reaching it only through the covers array is not: `--spec check_idempotency`
      // legitimately means "run the chains that exercise this RPC", and two
      // runnable chains also cover it — hard-failing there would refuse the whole
      // run over a chain the caller never asked for. Those get the bulk skip below.
      for (const [k, v] of sel) {
        if (v.container_only && args.specs.includes(k)) {
          fail(
            `spec "${k}" is container-only and cannot run against a live database:\n` +
            `${v.chain} seeds its own fixture rows, which the LIVE-DATA GUARD refuses.\n` +
            `Run it with:  node scripts/smoke/${v.container_prover}`
          );
        }
        selected.set(k, v);
      }
    }
    for (const areaName of args.areas) {
      let hit = false;
      for (const [key, spec] of Object.entries(specs)) {
        if (spec.area.includes(areaName)) {
          selected.set(key, spec);
          hit = true;
        }
      }
      if (!hit) fail(`no spec is tagged with area "${areaName}" (see scripts/test-areas.json for the vocabulary)`);
    }
  }

  // This runner never runs a container-only chain. Announce every skip:
  // a silently shrunk run reads as "everything passed" when it did not.
  const skipped = dropContainerOnly(selected);
  for (const [key, spec] of skipped) {
    console.log(
      `[smoke] ${key} SKIPPED — container-only; run: node scripts/smoke/${spec.container_prover}`
    );
  }
  if (selected.size === 0) {
    fail(
      'nothing ran: every selected smoke chain was skipped because it is container-only.\n' +
      'Run the skipped chain(s) in their disposable containers instead:\n' +
      skipped.map(([key, spec]) => `  ${key}: node scripts/smoke/${spec.container_prover}`).join('\n')
    );
  }

  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    // Claude-first mode: emit the chains for MCP execution.
    for (const [key, spec] of selected) printForClaude(key, spec);
    console.log(
      `Printed ${selected.size} chain(s). Execute each as ONE statement and apply\n` +
      `the PASS contract above. (Set SUPABASE_DB_URL to run via psql instead.)`
    );
    return;
  }

  let failures = 0;
  for (const [key, spec] of selected) {
    process.stdout.write(`[smoke] ${key} (${spec.chain}) ... `);
    const result = runViaPsql(key, spec, dbUrl);
    if (result.pass) {
      console.log('PASS (rolled back)');
    } else {
      failures++;
      console.log('FAIL');
      console.log(`        ${result.message}`);
    }
  }
  console.log(`\n${selected.size - failures}/${selected.size} chain(s) passed.`);
  if (failures > 0) {
    console.log('A failing chain means the fix is NOT fixed - do not declare it done.');
    process.exitCode = 1;
  }
}

main();
