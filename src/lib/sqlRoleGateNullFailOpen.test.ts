/**
 * SQL role-gate NULL fail-open scanner (gauntlet H1 class).
 *
 * THE BUG (gauntlet sections 2–6, confirmed HIGH H1, fixed 2026-07-18 in
 * 20260718124500_harden_prepay_and_payment_role_gate.sql):
 *   IF v_actor_role NOT IN ('admin','sales_rep') THEN RAISE ...
 * A deactivated or profile-less caller yields v_actor_role = NULL, and in SQL
 * `NULL NOT IN (...)` evaluates to NULL — not TRUE — so the RAISE never fires
 * and the gate FAILS OPEN. apply_prepay_to_invoice and record_invoice_payment
 * let a deactivated user move money on live prod because of exactly this.
 *
 * THE RULE: in the LATEST on-disk definition of every function, any
 * `<role-variable> NOT IN (...)` gate must carry NULL protection in the same
 * IF condition — `<var> IS NULL OR ... NOT IN (...)` (the canonical repo
 * pattern) or a COALESCE around the variable.
 *
 * Scan style mirrors rpcIdempotencyScope.test.ts: newest migration first, the
 * first definition seen per function is its latest disk truth, so a future
 * migration that re-emits a function WITHOUT the NULL guard fails this test
 * the moment it lands on disk — before any review round, before any apply.
 *
 * KNOWN_UNGUARDED may only SHRINK. Add to it only when a gate is proven safe
 * (e.g. the variable is declared NOT NULL / defaulted before the check) and
 * say why inline.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'supabase',
  'migrations'
);

interface DiskFnDef {
  file: string;
  body: string;
}

function latestDiskDefinitions(): Map<string, DiskFnDef> {
  const latest = new Map<string, DiskFnDef>();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .reverse(); // newest first
  const defRe = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi;
  for (const file of files) {
    const content = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    let m: RegExpExecArray | null;
    while ((m = defRe.exec(content)) !== null) {
      const fnName = m[1].toLowerCase();
      if (latest.has(fnName)) continue;
      const after = content.slice(m.index);
      const bodyMatch = after.match(/AS\s+\$([A-Za-z_]*)\$([\s\S]*?)\$\1\$/);
      latest.set(fnName, { file, body: bodyMatch ? bodyMatch[2] : after });
    }
  }
  return latest;
}

/** Strip SQL comments so a commented-out gate can't trip (or satisfy) the scan,
 *  and `END IF` so the IF-condition matcher can't start a match at a block end. */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\bEND\s+IF\b/gi, 'ENDIF');
}

interface GateHit {
  fn: string;
  file: string;
  variable: string;
  condition: string;
}

/**
 * Find every IF condition containing `<role-ish var> NOT IN (...)` and return
 * the ones WITHOUT NULL protection in the same condition. Role-ish variables:
 * anything whose name contains "role" (v_actor_role, v_role, v_caller_role...).
 */
function unguardedRoleGates(defs: Map<string, DiskFnDef>): GateHit[] {
  const hits: GateHit[] = [];
  for (const [fn, def] of defs) {
    const body = stripSqlComments(def.body);
    // Each IF/ELSIF ... THEN condition, non-greedy to the first THEN.
    const ifRe = /\b(?:IF|ELSIF)\b([\s\S]*?)\bTHEN\b/gi;
    let m: RegExpExecArray | null;
    while ((m = ifRe.exec(body)) !== null) {
      const cond = m[1];
      const gateRe = /([A-Za-z_][A-Za-z0-9_]*role[A-Za-z0-9_]*)\s+NOT\s+IN\s*\(/gi;
      let g: RegExpExecArray | null;
      while ((g = gateRe.exec(cond)) !== null) {
        const variable = g[1];
        const guarded =
          new RegExp(`${variable}\\s+IS\\s+NULL`, 'i').test(cond) ||
          new RegExp(`COALESCE\\s*\\(\\s*${variable}\\b`, 'i').test(cond) ||
          // COALESCE at assignment is invisible here, but a gate written as
          // COALESCE(v_role,'') NOT IN (...) is matched by the variable regex
          // only via the raw name — also accept an inline COALESCE wrapper.
          new RegExp(`COALESCE\\s*\\([^)]*\\b${variable}\\b`, 'i').test(cond);
        if (!guarded) {
          hits.push({ fn, file: def.file, variable, condition: cond.trim().slice(0, 160) });
        }
      }
    }
  }
  return hits;
}

/**
 * Functions with a role gate that intentionally has no IS NULL in the same
 * condition. Every entry needs a reason. This list may only SHRINK.
 */
const KNOWN_UNGUARDED: Record<string, string> = {
  // Safe: v_actor_role is loaded with `WHERE id = v_actor AND is_active = true`
  // followed by `IF NOT FOUND THEN RAISE NOT_AUTHORIZED` — an active profile is
  // pinned before the gate, so the role can only be NULL if profiles.role is
  // NULL, and the gate is a secondary owner-mismatch check, not the auth gate.
  get_offline_action_status: 'active-profile pinned upstream (NOT FOUND raise) before the gate',
  // Safe BY DESIGN: `new_role IS NOT NULL AND new_role NOT IN (...)` — NULL
  // means "caller is not changing the role", so skipping the value check on
  // NULL is fail-closed for this validation (nothing is written).
  admin_update_profile: 'NULL new_role means no role change; the NOT IN is a value whitelist, not an auth gate',
  // LATENT H1 in a PARKED migration (parked_010, inventory-hold shelved with the
  // earmark engine 2026-06-14, never applied live). If this migration is ever
  // revived, add `v_role IS NULL OR` BEFORE applying — then delete this entry.
  create_inventory_hold: 'parked/shelved migration, not live; must be NULL-guarded before any future apply',
};

describe('SQL role gates fail CLOSED on NULL role (H1 class)', () => {
  const defs = latestDiskDefinitions();

  it('scanned a realistic number of function definitions', () => {
    expect(defs.size).toBeGreaterThan(100);
  });

  it('every `<role var> NOT IN (...)` gate carries NULL protection in the same condition', () => {
    const hits = unguardedRoleGates(defs).filter((h) => !(h.fn in KNOWN_UNGUARDED));
    const report = hits
      .map((h) => `  ${h.fn} (${h.file}) — ${h.variable} NOT IN without IS NULL/COALESCE:\n    IF ${h.condition}`)
      .join('\n');
    expect(
      hits,
      `NULL role fails OPEN in these gates (NULL NOT IN (...) = NULL, RAISE never fires — the H1 deactivated-user-moves-money bug).\n` +
        `Fix: \`IF <var> IS NULL OR <var> NOT IN (...) THEN\` like 20260718124500.\n${report}`
    ).toEqual([]);
  });

  it('KNOWN_UNGUARDED only names functions that still exist and still have a gate', () => {
    const allHits = unguardedRoleGates(defs);
    for (const fn of Object.keys(KNOWN_UNGUARDED)) {
      expect(
        allHits.some((h) => h.fn === fn),
        `${fn} no longer has an unguarded gate — remove it from KNOWN_UNGUARDED`
      ).toBe(true);
    }
  });
});
