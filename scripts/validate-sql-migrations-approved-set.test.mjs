#!/usr/bin/env node
/**
 * Mutation tests for the APPROVED-SET BINDING block in
 * scripts/validate-sql-migrations.sh.
 *
 * A guard nobody has tried to break is decoration. Every case below is a real
 * bypass someone could write; the test asserts the guard actually stops it.
 * Written after an adversarial review found the first cut of this guard
 * fail-open in three separate ways (see the 2026-08-10 DECISION_LOG entry).
 *
 * Each fixture is a synthetic migration written into a scratch directory, run
 * through the real script, and classified by what the script printed for it.
 */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'validate-sql-migrations.sh');
const HEX = 'a'.repeat(64);
const OTHER_HEX = 'b'.repeat(64);

/** A digest block that is genuinely fail-closed: computed, compared, aborts. */
const GOOD_DIGEST_BLOCK = `DO $$
DECLARE actual text;
BEGIN
  SELECT md5(string_agg(id::text, ',' ORDER BY id)) INTO actual FROM public.orders WHERE stale;
  IF actual <> '${HEX}' THEN
    RAISE EXCEPTION 'APPROVED_SET_DRIFTED: expected ${HEX}, got %', actual;
  END IF;
END $$;`;

const CASES = [
  // ── must VIOLATE ────────────────────────────────────────────────────────
  {
    name: 'multiline UPDATE with the table on the next line',
    expect: 'violation',
    sql: `DO $$\nBEGIN\n  UPDATE\n    public.orders\n  SET total_profit = 0;\nEND $$;\n`,
  },
  {
    name: 'quoted identifiers: "public"."order_items"',
    expect: 'violation',
    sql: `UPDATE "public"."order_items" SET profit = 0;\n`,
  },
  {
    name: 'UPDATE ONLY',
    expect: 'violation',
    sql: `UPDATE ONLY public.commissions SET commission_amount = 0;\n`,
  },
  {
    name: 'DELETE FROM a business table',
    expect: 'violation',
    sql: `DELETE FROM public.invoice_items WHERE id IS NOT NULL;\n`,
  },
  {
    name: 'digest present only in a comment',
    expect: 'violation',
    sql: `-- APPROVED_SET_DIGEST: ${HEX}\nUPDATE public.orders SET total_profit = 0;\n`,
  },
  {
    name: 'digest compared AFTER the write',
    expect: 'violation',
    sql: `-- APPROVED_SET_DIGEST: ${HEX}\nUPDATE public.orders SET total_profit = 0;\n${GOOD_DIGEST_BLOCK}\n`,
  },
  {
    name: 'digest mentioned in executable SQL but never compared',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\nDECLARE v text;\nBEGIN\n  SELECT '${HEX}' INTO v;\nEND $$;\n` +
      `UPDATE public.orders SET total_profit = 0;\n`,
  },
  {
    name: 'digest compared against another literal, nothing computed',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\nBEGIN\n  IF '${HEX}' <> '${OTHER_HEX}' THEN\n` +
      `    RAISE EXCEPTION 'drift';\n  END IF;\n  UPDATE public.orders SET total_profit = 0;\nEND $$;\n`,
  },
  {
    name: 'comparison with no RAISE in its own IF block (unrelated RAISE nearby)',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: ${HEX}\nDO $$\nDECLARE actual text;\nBEGIN\n` +
      `  SELECT md5(string_agg(id::text, ',' ORDER BY id)) INTO actual FROM public.orders;\n` +
      `  IF actual <> '${HEX}' THEN\n    RAISE NOTICE 'drifted, carrying on';\n  END IF;\n` +
      `  IF false THEN\n    RAISE EXCEPTION 'unreachable';\n  END IF;\n` +
      `  UPDATE public.orders SET total_profit = 0;\nEND $$;\n`,
  },
  {
    name: 'waiver that does not name the table it waives',
    expect: 'violation',
    sql:
      `-- APPROVED_SET_DIGEST: NOT-REQUIRED (invoices) - column added by this migration\n` +
      `UPDATE public.orders SET total_profit = 0;\n`,
  },
  {
    name: 'inventory is covered, not just the ordering tables',
    expect: 'violation',
    sql: `UPDATE public.inventory SET quantity_on_hand = 0;\n`,
  },
  {
    name: 'vendor_payments is covered',
    expect: 'violation',
    sql: `UPDATE public.vendor_payments SET amount_cents = 0;\n`,
  },

  // ── must WARN (accepted, but never silent) ──────────────────────────────
  {
    name: 'waiver naming every table it waives',
    expect: 'warning',
    sql:
      `-- APPROVED_SET_DIGEST: NOT-REQUIRED (orders) - backfills a column this migration adds\n` +
      `UPDATE public.orders SET total_profit = 0;\n`,
  },

  // ── must PASS silently ──────────────────────────────────────────────────
  {
    name: 'correct fail-closed digest: computed, compared, aborts, before the write',
    expect: 'silent',
    sql: `-- APPROVED_SET_DIGEST: ${HEX}\n${GOOD_DIGEST_BLOCK}\nUPDATE public.orders SET total_profit = 0;\n`,
  },
  {
    name: 'rewrite inside a function body is runtime logic, not a data migration',
    expect: 'silent',
    sql:
      `CREATE OR REPLACE FUNCTION public.f_fixture()\nRETURNS void AS $$\nBEGIN\n` +
      `  UPDATE public.orders SET total_profit = 0;\nEND;\n$$ LANGUAGE plpgsql;\n`,
  },
  {
    name: 'the words "update orders" inside a string literal are not a rewrite',
    expect: 'silent',
    sql: `DO $$\nBEGIN\n  RAISE NOTICE 'about to update orders and delete from invoices';\nEND $$;\n`,
  },
  {
    name: 'a non-business table is not in scope',
    expect: 'silent',
    sql: `UPDATE public.app_settings SET value = 'x';\n`,
  },
];

// A stamp at/after the cutoff, so the guard is in force.
const IN_FORCE = 29990101;
// A stamp before the cutoff: history, never retro-checked.
const PRE_CUTOFF = '20260101000001_pre_cutoff.sql';

function classify(output, fileName) {
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(fileName)) continue;
    if (lines[i].startsWith('VIOLATION:')) return 'violation';
    if (lines[i].startsWith('WARNING:')) return 'warning';
  }
  return 'silent';
}

function run() {
  const dir = mkdtempSync(join(tmpdir(), 'crx-approved-set-'));
  const migrations = join(dir, 'supabase', 'migrations');
  mkdirSync(migrations, { recursive: true });

  const names = [];
  CASES.forEach((c, i) => {
    const name = `${IN_FORCE}${String(i).padStart(6, '0')}_case_${i}.sql`;
    writeFileSync(join(migrations, name), c.sql, 'utf8');
    names.push(name);
  });
  // The same rewrite, stamped before the cutoff, must stay silent: applied
  // history cannot be edited, so retro-checking it would only produce noise.
  writeFileSync(join(migrations, PRE_CUTOFF), `UPDATE public.orders SET total_profit = 0;\n`, 'utf8');

  const res = spawnSync('bash', [SCRIPT, '--max-violations=999'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env },
  });
  const out = `${res.stdout || ''}\n${res.stderr || ''}`;

  const failures = [];
  CASES.forEach((c, i) => {
    const got = classify(out, names[i]);
    if (got !== c.expect) failures.push(`  ${c.name}\n    expected ${c.expect}, got ${got}`);
  });
  const preGot = classify(out, PRE_CUTOFF);
  if (preGot !== 'silent') {
    failures.push(`  pre-cutoff migration is history\n    expected silent, got ${preGot}`);
  }

  rmSync(dir, { recursive: true, force: true });

  if (failures.length > 0) {
    console.error(`❌ approved-set guard: ${failures.length} case(s) behaved wrong\n`);
    console.error(failures.join('\n'));
    console.error('\n--- validator output ---\n');
    console.error(out);
    process.exit(1);
  }
  console.log(`✅ approved-set guard: ${CASES.length + 1} mutation cases behaved correctly`);
}

run();
