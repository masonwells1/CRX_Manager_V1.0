import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly, functionHeaderPattern, lexed, lexSql } from './sqlSourceLexer';

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
  const { masked, spans, idents } = lexed(sql);
  const inIdent = (at: number) => idents.some((d) => at > d.start && at < d.end);

  // An unqualified definition resolves through search_path, and this scan reads
  // it as public. That is only true while nothing in the file has repointed
  // search_path at the session level — `SET search_path = private, public;` as
  // a statement of its own would make a later unqualified definition land in
  // `private`, and this scan would then report ITS guards while the live public
  // function kept whatever it had. A routine-level `SET search_path` inside a
  // CREATE FUNCTION is a different thing entirely and must not trip this, so a
  // hit only counts when the statement it sits in is not a CREATE FUNCTION.
  const topLevelSearchPath: number[] = [];
  const setSearchPath = /\bSET\s+search_path\b/gi;
  for (let m = setSearchPath.exec(masked); m; m = setSearchPath.exec(masked)) {
    if (inIdent(m.index) || spans.some((s) => m!.index > s.start && m!.index < s.end)) continue;
    let stmtStart = 0;
    for (let at = masked.lastIndexOf(';', m.index); at !== -1; at = masked.lastIndexOf(';', at - 1)) {
      if (inIdent(at) || spans.some((s) => at > s.start && at < s.end)) continue;
      stmtStart = at;
      break;
    }
    if (!/\bCREATE\b[\s\S]*\bFUNCTION\b/i.test(masked.slice(stmtStart, m.index))) {
      topLevelSearchPath.push(m.index);
    }
  }

  const header = functionHeaderPattern(functionName);
  const bodies: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = header.exec(masked)) !== null) {
    const after = header.lastIndex;

    expect(
      topLevelSearchPath.every((at) => at > match!.index) || /\bpublic\b/i.test(match[0]),
      `${functionName} is defined unqualified after a top-level SET search_path, so which schema it lands in cannot be read from this file`,
    ).toBe(true);

    // The statement ends at the first semicolon that is not swallowed by a body
    // or a literal. A body that opens after it belongs to some later statement.
    let stmtEnd = -1;
    for (let at = masked.indexOf(';', after); at !== -1; at = masked.indexOf(';', at + 1)) {
      if (spans.some((s) => at > s.start && at < s.end) || inIdent(at)) continue;
      stmtEnd = at;
      break;
    }

    // Anchored on this definition's own AS. Taking the next quoted run outright
    // would grab a routine-level literal instead — `SET search_path = ''` and a
    // `DEFAULT ''` argument both sit between the header and the body. Quoted
    // identifiers are skipped: `"as"` is a legal argument name, and matching it
    // would anchor the body on the next literal after it — which, for an
    // argument like `"as" text DEFAULT 'GUARD_PRESENT'`, is a string the author
    // chose, so the scan would read guards out of a default value while the
    // real body ran unguarded.
    const asToken = /\bAS\b/gi;
    asToken.lastIndex = after;
    let as = asToken.exec(masked);
    while (as && inIdent(as.index)) as = asToken.exec(masked);
    const span = as ? spans.find((s) => s.start >= as!.index) : undefined;

    expect(as, `${functionName} definition has no AS clause`).not.toBeNull();
    expect(span, `${functionName} definition has no body`).toBeDefined();
    expect(
      stmtEnd === -1 || span!.start < stmtEnd,
      `${functionName} definition is unterminated, or its body belongs to a later statement`,
    ).toBe(true);

    // A dollar-quoted body is read from the mask, which keeps its code and its
    // error-code literals but has already dropped its comments — so no assertion
    // below can be satisfied by a commented-out guard.
    //
    // A single-quoted body is blanked in the mask, and reading it from the raw
    // source instead put the comments straight back: a body could comment out
    // `FOR UPDATE` and the stale-selection count check, and every assertion
    // below still found the text and passed while the live function was
    // unguarded. Decode it the way Postgres does ('' is one quote) and lex the
    // result, wrapped in a dollar tag so the sub-lex treats it as body text and
    // keeps the error-code literals the assertions look for.
    if (span!.kind === 'body') {
      bodies.push(masked.slice(match.index, span!.end));
    } else {
      // A prefix changes how the literal decodes: E'…' makes backslash an
      // escape, U&'…' adds \0041 unicode escapes. Decoding either with the
      // plain ''-is-one-quote rule would mis-read the body — and a mis-read
      // body can invent guard text as easily as it can lose it. Refuse.
      const prefix = sql.slice(Math.max(0, span!.start - 2), span!.start);
      expect(
        /(?:^|[^\w$])[EeUu]&?$/.test(prefix),
        `${functionName} has a prefixed (E''/U&'') function body, which this scan cannot decode`,
      ).toBe(false);

      const raw = sql.slice(span!.start + 1, span!.end - 1).replace(/''/g, "'");
      // The wrapper tag must not occur in the decoded text. A body containing
      // the tag would close the wrapper early, and everything after it would
      // then be lexed as TOP-LEVEL text — which turns that body's literals into
      // code, so `RAISE NOTICE $crx_decoded$FOR UPDATE$crx_decoded$` could
      // satisfy an assertion the live function does not.
      let tag = '$crx_decoded$';
      for (let n = 0; raw.includes(tag); n += 1) tag = `$crx_decoded_${n}$`;
      bodies.push(masked.slice(match.index, span!.start)
        + lexSql(`${tag}${raw}${tag}`).masked.slice(tag.length, -tag.length));
    }
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
    // Decoded, so the body reads as the SQL it is rather than as the literal
    // that carried it — the outer quotes are gone.
    expect(found[0]).toContain('SELECT 1');
    expect(found[0], 'the body swallowed the next statement').not.toContain('$do$');
  });

  it('reads a single-quoted body as CODE, not as raw text', () => {
    // `AS '…'` bodies used to be returned straight from the source, comments and
    // all, so a body could comment its guard out and still satisfy a
    // .toContain() check while the live function ran unguarded. Postgres decodes
    // '' to one quote inside such a body, so decode it the same way and lex it.
    const sql = [
      `CREATE OR REPLACE FUNCTION public.pay(p_id uuid) RETURNS void LANGUAGE plpgsql AS`,
      `'BEGIN -- GUARD_PRESENT`,
      `  RAISE EXCEPTION ''KEPT_LITERAL'';`,
      `END';`,
    ].join('\n');
    const found = functionDefinitions(sql, 'pay');
    expect(found).toHaveLength(1);
    expect(found[0], 'a commented-out guard was read as live code').not.toContain('GUARD_PRESENT');
    // …while the error-code literals the real assertions look for survive.
    expect(found[0]).toContain("'KEPT_LITERAL'");
  });

  it('does not let a single-quoted body collide with the decoder tag', () => {
    // The decode wraps the body in a dollar tag so the sub-lex treats it as body
    // text. A body carrying that exact tag CLOSES the wrapper early, and
    // everything after it is then lexed as TOP-LEVEL SQL — where the rules are
    // inverted: literals get blanked and dollar-quoted text stops being a
    // literal. Both directions are wrong. Here the error code the real
    // assertions look for silently disappears; a body could equally use it to
    // promote printed text into apparent code.
    const sql = [
      `CREATE OR REPLACE FUNCTION public.pay(p_id uuid) RETURNS void LANGUAGE plpgsql AS`,
      `'BEGIN`,
      // The error code sits BETWEEN the colliding tags, which is the only place
      // the collision is observable: valid SQL always spells the tag in pairs,
      // so the text after the pair lands back inside the wrapper either way —
      // but the text between them is lexed top-level, where literals are blanked.
      `  RAISE NOTICE $crx_decoded$ ''KEPT_LITERAL'' $crx_decoded$;`,
      `END';`,
    ].join('\n');
    const found = functionDefinitions(sql, 'pay');
    expect(found).toHaveLength(1);
    expect(
      found[0],
      'the decoder tag collided with the body and the rest was lexed top-level',
    ).toContain("'KEPT_LITERAL'");
  });

  it('reads a dollar-quoted literal inside a body as text, not as code', () => {
    const sql = [
      `CREATE OR REPLACE FUNCTION public.pay(p_id uuid) RETURNS void LANGUAGE plpgsql AS $fn$`,
      `BEGIN`,
      `  RAISE NOTICE $msg$GUARD_PRESENT$msg$;`,
      `END;`,
      `$fn$;`,
    ].join('\n');
    const [definition] = functionDefinitions(sql, 'pay');
    expect(definition, 'the raw body keeps what it prints').toContain('GUARD_PRESENT');
    expect(
      codeOnly(definition),
      'a dollar-quoted RAISE argument was read as executable SQL',
    ).not.toContain('GUARD_PRESENT');
  });

  it('refuses a prefixed E-string body instead of mis-decoding it', () => {
    // E'…' makes backslash an escape, so the ''-is-one-quote rule reads the body
    // wrong — and a wrongly-decoded body can invent guard text as easily as lose
    // it. Nothing in supabase/migrations/ uses this form; refusing is the only
    // answer that cannot be silently wrong.
    const sql = [
      `CREATE OR REPLACE FUNCTION public.pay(p_id uuid) RETURNS void LANGUAGE plpgsql AS`,
      `E'BEGIN RAISE EXCEPTION \\'GUARD_PRESENT\\'; END';`,
    ].join('\n');
    expect(() => functionDefinitions(sql, 'pay')).toThrow(/E''\/U&''/);
  });

  it('agrees with the database on what counts as an identifier character', () => {
    // Round-9 finding. The E-string test is "a quote preceded by e/E that is not
    // itself the tail of an identifier". This side used the JS \w class, which
    // omits $ and every non-ASCII letter; the migration's own PL/pgSQL lexer
    // uses [A-Za-z0-9_$]. Where the two disagree, this scanner refuses a body
    // the database accepts — so a guard change would look unreviewable rather
    // than unsafe, and the two lexers must be held to one rule.
    const sql = [
      `CREATE OR REPLACE FUNCTION public.pay(p_id uuid) RETURNS void LANGUAGE plpgsql AS $fn$`,
      `BEGIN`,
      `  PERFORM x$e'a\\' || 'GUARD_PRESENT';`,
      `END;`,
      `$fn$;`,
    ].join('\n');
    const [definition] = functionDefinitions(sql, 'pay');
    // The e belongs to the identifier x$e, so this is an ordinary literal: the
    // backslash is just a character and the quote after it closes the literal.
    // Read as an E-string instead, that quote is escaped, the literal runs on
    // through the concatenation, and GUARD_PRESENT falls out of the mask and is
    // counted as executable code — a guard the function does not actually have.
    expect(codeOnly(definition)).not.toContain('GUARD_PRESENT');
  });

  it('reads a dollar-quote tag the database would accept, including a non-ASCII one', () => {
    // Same round-9 split, in the other lexer rule. Postgres allows any
    // non-digit, non-dollar, non-whitespace character in a dollar-quote tag;
    // an ASCII-only tag pattern leaves $café$…$café$ unrecognised, and the
    // literal's contents then read as executable code — which is how a hidden
    // marker gets counted as a real guard.
    const sql = [
      `CREATE OR REPLACE FUNCTION public.pay(p_id uuid) RETURNS void LANGUAGE plpgsql AS $fn$`,
      `BEGIN`,
      `  RAISE NOTICE $café$GUARD_PRESENT$café$;`,
      `END;`,
      `$fn$;`,
    ].join('\n');
    const [definition] = functionDefinitions(sql, 'pay');
    expect(definition, 'the raw body keeps what it prints').toContain('GUARD_PRESENT');
    expect(
      codeOnly(definition),
      'a non-ASCII dollar-quoted literal was read as executable SQL',
    ).not.toContain('GUARD_PRESENT');
  });

  it('codeOnly() strips the literals a dollar-quoted body keeps', () => {
    const sql = [
      `CREATE OR REPLACE FUNCTION public.pay(p_id uuid) RETURNS void LANGUAGE plpgsql AS $fn$`,
      `BEGIN`,
      `  RAISE NOTICE 'FOR UPDATE OF c';`,
      `  PERFORM 1 FROM c FOR UPDATE OF c;`,
      `END;`,
      `$fn$;`,
    ].join('\n');
    const [definition] = functionDefinitions(sql, 'pay');
    expect(definition, 'the raw body keeps its literals').toContain("'FOR UPDATE OF c'");
    // One occurrence left — the real lock, not the RAISE NOTICE.
    expect(codeOnly(definition).match(/FOR UPDATE OF c/g)).toHaveLength(1);
  });

  it('codeOnly() does not read executable SQL out of a quoted alias in a body', () => {
    // The other half of the literal problem. A later migration could delete the
    // real lock and leave `AS "FOR UPDATE OF c"` behind as a column alias; the
    // guard assertions at the bottom of this file would still find their text
    // and stay green over a body that no longer locks anything.
    const sql = [
      `CREATE OR REPLACE FUNCTION public.pay(p_id uuid) RETURNS void LANGUAGE plpgsql AS $fn$`,
      `BEGIN`,
      `  PERFORM 1 AS "FOR UPDATE OF c" FROM c;`,
      `END;`,
      `$fn$;`,
    ].join('\n');
    const [definition] = functionDefinitions(sql, 'pay');
    expect(definition, 'the raw body keeps the alias').toContain('"FOR UPDATE OF c"');
    expect(
      codeOnly(definition),
      'a quoted alias was read as the lock it merely spells',
    ).not.toMatch(/FOR UPDATE OF c/i);
  });

  it('refuses to guess the schema of an unqualified definition after a session SET search_path', () => {
    // An unqualified CREATE FUNCTION is read as public, which is true only while
    // search_path still points there. A statement-level `SET search_path` puts a
    // later unqualified definition somewhere else entirely, and this scan would
    // then report ITS guards while the live public function kept whatever it
    // had. Refuse rather than guess.
    const sql = [
      `SET search_path = private, public;`,
      `CREATE OR REPLACE FUNCTION pay(p_id uuid) RETURNS void LANGUAGE plpgsql AS ${guarded()};`,
    ].join('\n');
    expect(() => functionDefinitions(sql, 'pay')).toThrow(/top-level SET search_path/);
  });

  it('is not tripped by a ROUTINE-level SET search_path', () => {
    // The clause every SECURITY DEFINER function in this repo carries. It is
    // part of the CREATE FUNCTION statement, not a session setting, so it must
    // not make the scan refuse a perfectly ordinary migration.
    const sql = `CREATE OR REPLACE FUNCTION pay(p_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS ${guarded()};`;
    const found = functionDefinitions(sql, 'pay');
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('GUARD_PRESENT');
  });

  it('does not read a SQL keyword out of a quoted identifier', () => {
    // `"as"` is a legal argument name. Matching it as the AS clause anchored the
    // body on the next literal — here a DEFAULT the author picked — so the scan
    // reported a guard the real body does not have.
    const sql = `CREATE OR REPLACE FUNCTION public.pay("as" text DEFAULT 'GUARD_PRESENT')\nRETURNS void LANGUAGE plpgsql AS $fn$ BEGIN NULL; END $fn$;`;
    const found = functionDefinitions(sql, 'pay');
    expect(found).toHaveLength(1);
    expect(found[0], 'a DEFAULT literal was read as the body').not.toContain('GUARD_PRESENT');
    expect(found[0]).toContain('BEGIN NULL; END');
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

    // Executable SQL is asserted against the literal-free view, so none of
    // these can be satisfied by a `RAISE NOTICE 'FOR UPDATE OF c'`.
    const code = codeOnly(definition);
    expect(code).toContain('v_locked_count <> v_selected_count');
    expect(code).toContain('v_non_pending_count > 0');
    expect(code).toContain('GET DIAGNOSTICS v_item_count = ROW_COUNT');
    expect(code).toContain('v_item_count <> v_selected_count');
    expect(code).toMatch(/SELECT DISTINCT id\s+FROM unnest\(p_commission_ids\)/i);
    expect(code).toMatch(/FOR UPDATE OF c/i);
    // The error code IS a literal, so it is asserted against the full body.
    expect(definition).toContain('COMMISSION_PAYMENT_SELECTION_STALE');
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
