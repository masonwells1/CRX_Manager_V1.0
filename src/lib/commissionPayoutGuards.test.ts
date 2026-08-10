import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrationsDir = join(repoRoot, 'supabase', 'migrations');

function migrationFiles() {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      content: readFileSync(join(migrationsDir, name), 'utf8'),
    }));
}

/**
 * 20260810170000 RENAMED the payout bodies out from under their public names and
 * put a thin intent-binding wrapper on top. The stale-selection guards below did
 * not move — they are still the only thing that runs the payout — but they now
 * live under the implementation name. Scanning past this migration would find
 * the wrapper and wrongly report the guards as deleted.
 */
const PAYOUT_RENAME_MIGRATION =
  '20260810170000_bind_commission_payout_idempotency_to_intent.sql';

type Span = { start: number; end: number; kind: 'body' | 'string' };

/** The dollar-quote tag opening at `i`, or null. `$1` is a parameter, not a tag. */
function dollarTagAt(sql: string, i: number): string | null {
  if (sql[i] !== '$') return null;
  let j = i + 1;
  if (j < sql.length && /[A-Za-z_]/.test(sql[j])) {
    j += 1;
    while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j += 1;
  }
  return sql[j] === '$' ? sql.slice(i, j + 1) : null;
}

/**
 * Lexes the file once so the scan below reads SQL rather than text.
 *
 * Returns a MASK the same length as the input — every offset found in the mask
 * indexes straight back into the original — with two substitutions:
 *
 *  - Comments become spaces, everywhere. Postgres treats a comment exactly as
 *    whitespace, so a block comment sitting between CREATE and OR REPLACE still
 *    leaves a real definition that a whitespace-only regex walks straight past;
 *    and, in the other direction, a commented-out copy of a guarded definition
 *    must not be able to stand in as the file's "last definition" while the live
 *    one below it dropped the guard.
 *  - Single-quoted literals OUTSIDE a function body become spaces, so a string
 *    containing the text of a definition cannot impersonate one. Literals INSIDE
 *    a body are kept: the guards under test raise their error codes as string
 *    literals, and blanking those would blind the assertions.
 *
 * `spans` records where the dollar-quoted bodies and the blanked top-level
 * literals are, so a definition's body can be bounded to its own statement.
 */
function lexSql(sql: string): { masked: string; spans: Span[] } {
  const out = sql.split('');
  const spans: Span[] = [];
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < out.length; i += 1) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  };

  const openTags: string[] = [];
  const bodyStarts: number[] = [];
  let i = 0;
  while (i < sql.length) {
    const inBody = openTags.length > 0;

    if (sql[i] === '-' && sql[i + 1] === '-') {
      let end = sql.indexOf('\n', i);
      if (end === -1) end = sql.length;
      blank(i, end);
      i = end;
      continue;
    }

    if (sql[i] === '/' && sql[i + 1] === '*') {
      // Postgres block comments nest, unlike C's.
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth += 1; j += 2; } else if (sql[j] === '*' && sql[j + 1] === '/') { depth -= 1; j += 2; } else j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }

    if (sql[i] === "'") {
      const escaped = i > 0 && /[Ee]/.test(sql[i - 1]) && !/\w/.test(sql[i - 2] ?? ' ');
      let j = i + 1;
      while (j < sql.length) {
        if (escaped && sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j += 1; break; }
        j += 1;
      }
      if (!inBody) {
        spans.push({ start: i, end: j, kind: 'string' });
        blank(i, j);
      }
      i = j;
      continue;
    }

    const tag = dollarTagAt(sql, i);
    if (tag) {
      if (inBody && openTags[openTags.length - 1] === tag) {
        openTags.pop();
        spans.push({ start: bodyStarts.pop()!, end: i + tag.length, kind: 'body' });
      } else {
        openTags.push(tag);
        bodyStarts.push(i);
      }
      i += tag.length;
      continue;
    }

    i += 1;
  }

  spans.sort((a, b) => a.start - b.start);
  return { masked: out.join(''), spans };
}

// ~900 migration files are rescanned once per protected RPC per test; lexing
// each file once instead of nine times keeps the suite inside its timeout.
const lexCache = new Map<string, { masked: string; spans: Span[] }>();
function lexed(sql: string) {
  let hit = lexCache.get(sql);
  if (!hit) {
    hit = lexSql(sql);
    lexCache.set(sql, hit);
  }
  return hit;
}

/**
 * Every definition of <rpc> in one migration file, in file order.
 *
 * This deliberately does NOT use String.match(): a non-global match returns only
 * the FIRST definition in the file, so a migration that defines the same RPC
 * twice — keeping the guards in the first and dropping them from the second,
 * effective one — would leave the assertions below green while production ran
 * the unguarded body.
 *
 * The header is matched against the lexed mask, so comments count as whitespace
 * and no comment or literal can pose as a definition. The schema qualifier is
 * OPTIONAL because an unqualified `CREATE FUNCTION post_commission_payment(...)`
 * resolves to public through search_path and is the same live function. Both
 * legal body forms are accepted — `$tag$…$tag$` and `AS '…'` — and the body has
 * to open before this statement's semicolon, so a dollar quote belonging to a
 * LATER statement can no longer be adopted as this definition's body.
 */
function functionDefinitions(sql: string, functionName: string): string[] {
  const { masked, spans } = lexed(sql);
  const header = new RegExp(
    String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:(?:public|"public")\s*\.\s*)?(?:${functionName}|"${functionName}")\s*\(`,
    'gi',
  );
  const bodies: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = header.exec(masked)) !== null) {
    const after = header.lastIndex;

    // The statement ends at the first semicolon that is not swallowed by a body
    // or a literal. A body that opens after it belongs to some later statement.
    let stmtEnd = -1;
    for (let at = masked.indexOf(';', after); at !== -1; at = masked.indexOf(';', at + 1)) {
      if (spans.some((s) => at > s.start && at < s.end)) continue;
      stmtEnd = at;
      break;
    }

    // Anchored on this definition's own AS. Taking the next quoted run outright
    // would grab a routine-level literal instead — `SET search_path = ''` and a
    // `DEFAULT ''` argument both sit between the header and the body.
    const asToken = /\bAS\b/gi;
    asToken.lastIndex = after;
    const as = asToken.exec(masked);
    const span = as ? spans.find((s) => s.start >= as.index) : undefined;

    expect(as, `${functionName} definition has no AS clause`).not.toBeNull();
    expect(span, `${functionName} definition has no body`).toBeDefined();
    expect(
      stmtEnd === -1 || span!.start < stmtEnd,
      `${functionName} definition is unterminated, or its body belongs to a later statement`,
    ).toBe(true);

    // A dollar-quoted body is read from the mask, which keeps its code and its
    // error-code literals but has already dropped its comments — so no assertion
    // below can be satisfied by a commented-out guard. A single-quoted body is
    // blanked in the mask, so it is read from the source instead.
    bodies.push(span!.kind === 'body'
      ? masked.slice(match.index, span!.end)
      : sql.slice(match.index, span!.end));
    header.lastIndex = span!.end;
  }
  return bodies;
}

function latestFunctionDefinition(functionName: string, stopBefore?: string): string {
  let latest = '';

  for (const file of migrationFiles()) {
    if (stopBefore && file.name >= stopBefore) break;
    // Last definition in the file wins — that is the one Postgres ends up with.
    const definitions = functionDefinitions(file.content.replace(/\r\n/g, '\n'), functionName);
    if (definitions.length > 0) latest = definitions[definitions.length - 1];
  }

  return latest;
}

function finalPolicyStatements(): Map<string, string> {
  const policies = new Map<string, string>();
  const policyAction =
    /DROP POLICY IF EXISTS\s+"([^"]+)"\s+ON\s+(?:public\.)?([a-z_]+)\s*;|CREATE POLICY\s+"([^"]+)"\s+ON\s+(?:public\.)?([a-z_]+)\b[\s\S]*?;/gi;

  for (const file of migrationFiles()) {
    let match: RegExpExecArray | null;
    while ((match = policyAction.exec(file.content))) {
      if (match[1] && match[2]) {
        policies.delete(`${match[2]}.${match[1]}`);
      } else if (match[3] && match[4]) {
        policies.set(`${match[4]}.${match[3]}`, match[0]);
      }
    }
  }

  return policies;
}

/**
 * The scanner is the only thing standing between a later migration and the
 * silent removal of a money guard, so it gets tested against the evasions a
 * text-matching version could not see. Every case below is legal SQL that
 * Postgres would accept.
 */
describe('migration scanner', () => {
  const guarded = (extra = '') => `$fn$\nBEGIN\n  ${extra}RAISE EXCEPTION 'GUARD_PRESENT';\nEND;\n$fn$`;

  it('reads a comment as whitespace inside the DDL keywords', () => {
    const sql = `CREATE /* re-issued 2026-08-10 */ OR REPLACE FUNCTION public.pay(p_id uuid)\nRETURNS void LANGUAGE plpgsql AS ${guarded()};`;
    expect(functionDefinitions(sql, 'pay')).toHaveLength(1);
  });

  it('finds an UNQUALIFIED definition, which search_path resolves to public', () => {
    const sql = `CREATE OR REPLACE FUNCTION pay(p_id uuid)\nRETURNS void LANGUAGE plpgsql AS ${guarded()};`;
    expect(functionDefinitions(sql, 'pay')).toHaveLength(1);
  });

  it('does not let a COMMENTED-OUT definition pose as the last one', () => {
    // The evasion: drop the guard from the live definition, then paste a
    // guarded copy below it as a comment. A text scan takes the comment as the
    // file's final word and stays green over an unguarded production body.
    const sql = [
      `CREATE OR REPLACE FUNCTION public.pay(p_id uuid) RETURNS void LANGUAGE plpgsql AS $fn$\nBEGIN\n  NULL;\nEND;\n$fn$;`,
      `-- CREATE OR REPLACE FUNCTION public.pay(p_id uuid) RETURNS void LANGUAGE plpgsql AS ${guarded()};`,
      `/* CREATE OR REPLACE FUNCTION public.pay(p_id uuid) RETURNS void LANGUAGE plpgsql AS ${guarded()}; */`,
    ].join('\n');
    const found = functionDefinitions(sql, 'pay');
    expect(found).toHaveLength(1);
    expect(found[0]).not.toContain('GUARD_PRESENT');
  });

  it('does not let a definition inside a STRING LITERAL count as one', () => {
    const sql = `INSERT INTO audit_log(note) VALUES ('CREATE OR REPLACE FUNCTION public.pay(p_id uuid) RETURNS void LANGUAGE plpgsql AS ${guarded()};');`;
    expect(functionDefinitions(sql, 'pay')).toHaveLength(0);
  });

  it('does not mistake a routine-level literal for the body', () => {
    // `SET search_path = ''` sits between the header and the body, and so does
    // a defaulted text argument. Taking the next quoted run outright would
    // return an empty "body" and every guard assertion would fail on a
    // perfectly correct migration.
    const sql = `CREATE OR REPLACE FUNCTION public.pay(p_id uuid, p_note text DEFAULT '')\nRETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS ${guarded()};`;
    const found = functionDefinitions(sql, 'pay');
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('GUARD_PRESENT');
  });

  it('does not adopt a dollar quote belonging to a LATER statement', () => {
    // The old helper searched the whole remainder of the file for the next
    // dollar quote, so a single-quoted body left it consuming unrelated SQL.
    const sql = [
      `CREATE OR REPLACE FUNCTION public.pay(p_id uuid) RETURNS void LANGUAGE sql AS 'SELECT 1';`,
      `DO $do$ BEGIN RAISE NOTICE 'unrelated'; END; $do$;`,
    ].join('\n');
    const found = functionDefinitions(sql, 'pay');
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("'SELECT 1'");
    expect(found[0], 'the body swallowed the next statement').not.toContain('$do$');
  });

  it('still returns EVERY definition in file order', () => {
    const sql = [
      `CREATE OR REPLACE FUNCTION public.pay(p_id uuid) RETURNS void LANGUAGE plpgsql AS ${guarded()};`,
      `CREATE OR REPLACE FUNCTION public.pay(p_id uuid) RETURNS void LANGUAGE plpgsql AS $fn$\nBEGIN\n  NULL;\nEND;\n$fn$;`,
    ].join('\n');
    const found = functionDefinitions(sql, 'pay');
    expect(found).toHaveLength(2);
    expect(found[0]).toContain('GUARD_PRESENT');
    expect(found[1]).not.toContain('GUARD_PRESENT');
  });
});

// Each test rescans every file in supabase/migrations/ (~900 files); under
// full-suite CPU load that exceeds vitest's 5s default and flakes the commit.
describe('commission payout gauntlet guards', { timeout: 60_000 }, () => {
  const activeAdminPolicyPattern = /USING\s*\(\s*\(*\s*(?:SELECT\s+)?(?:public\.)?is_admin\(\)\s*\)*\s*\)/i;

  it('create_commission_payment rejects stale selections instead of inserting a pending subset', () => {
    const definition = latestFunctionDefinition(
      'create_commission_payment',
      PAYOUT_RENAME_MIGRATION,
    );

    expect(definition).toContain('v_locked_count <> v_selected_count');
    expect(definition).toContain('v_non_pending_count > 0');
    expect(definition).toContain('GET DIAGNOSTICS v_item_count = ROW_COUNT');
    expect(definition).toContain('v_item_count <> v_selected_count');
    expect(definition).toContain('COMMISSION_PAYMENT_SELECTION_STALE');
    expect(definition).toMatch(/SELECT DISTINCT id\s+FROM unnest\(p_commission_ids\)/i);
    expect(definition).toMatch(/FOR UPDATE OF c/i);
  });

  it('the guarded payout body is still what every live call reaches', () => {
    // The assertion above is only meaningful if the renamed body is still on the
    // call path. If any definition of the public RPC stopped delegating to it,
    // the stale-selection guards would be dead code and that test would be
    // asserting against a function nothing invokes.
    //
    // Scoped to the wrapper's own body, not to end-of-file: the ACL post-
    // conditions at the bottom of the rename migration name the implementation
    // too, so a slice that ran to EOF would pass on that mention alone even if
    // the wrapper never called it.
    // All THREE payout RPCs, not just create. post and void carry the same
    // operation-only receipt lookup the migration exists to replace, so a guard
    // that watched create alone would let a later migration silently restore the
    // wrong-result risk for posting or voiding.
    const bound = [
      { rpc: 'create_commission_payment', impl: '_create_commission_payment_intent_impl_20260809' },
      { rpc: 'post_commission_payment', impl: '_post_commission_payment_intent_impl_20260809' },
      { rpc: 'void_commission_payment', impl: '_void_commission_payment_intent_impl_20260809' },
    ];

    // functionDefinitions() at the top of this file is deliberately NOT an
    // indexOf on one exact literal, and is shared with the stale-selection test
    // above so both scan the same way.
    const rename = migrationFiles().find((f) => f.name === PAYOUT_RENAME_MIGRATION);
    expect(rename, `${PAYOUT_RENAME_MIGRATION} is missing`).toBeDefined();
    const renameSql = rename!.content.replace(/\r\n/g, '\n');

    for (const { rpc, impl } of bound) {
      expect(renameSql, `${rpc} is never renamed out of the way`).toContain(`RENAME TO ${impl};`);
      const wrappers = functionDefinitions(renameSql, rpc);
      expect(wrappers.length, `${PAYOUT_RENAME_MIGRATION} does not define public.${rpc}`).toBeGreaterThan(0);
      for (const wrapper of wrappers) {
        expect(
          wrapper,
          `the ${rpc} wrapper does not delegate to ${impl}`,
        ).toContain(`public.${impl}(`);
      }
    }

    // And nothing since has quietly reinstated a self-contained public body. A
    // later migration re-creating any of the three with the old operation-only
    // idempotency logic would leave every migration-specific test above green
    // while removing intent binding from production.
    for (const file of migrationFiles()) {
      if (file.name <= PAYOUT_RENAME_MIGRATION) continue;
      const sql = file.content.replace(/\r\n/g, '\n');
      for (const { rpc, impl } of bound) {
        for (const body of functionDefinitions(sql, rpc)) {
          expect(
            body,
            `${file.name} redefines public.${rpc} without delegating to the intent-bound implementation`,
          ).toContain(`public.${impl}(`);
        }
      }
    }
  });

  it('commission payment tables expose no direct authenticated write policies', () => {
    const policies = finalPolicyStatements();
    const removedWritePolicies = [
      'commission_payment_items.commission_payment_items_insert_admin',
      'commission_payment_items.commission_payment_items_admin_delete',
      'commission_payments.commission_payments_insert_admin',
      'commission_payments.commission_payments_update_admin',
      'commission_payments.commission_payments_admin_delete',
    ];

    for (const policy of removedWritePolicies) {
      expect(policies.get(policy), `${policy} should not be recreated`).toBeUndefined();
    }

    expect(policies.get('commission_payment_items.commission_payment_items_select_admin')).toMatch(activeAdminPolicyPattern);
    expect(policies.get('commission_payments.commission_payments_select_admin')).toMatch(activeAdminPolicyPattern);
  });

  it('commissions SELECT policy no longer authorizes by legacy full-name text', () => {
    const commSelect = finalPolicyStatements().get('commissions.comm_select');

    expect(commSelect).toBeDefined();
    expect(commSelect).not.toMatch(/full_name/i);
    expect(commSelect).not.toMatch(/recipient\s*=\s*p\.full_name/i);
    expect(commSelect).toMatch(/recipient_user_id\s*=\s*\(SELECT auth\.uid\(\)\)/i);
  });
});
