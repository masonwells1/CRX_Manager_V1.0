import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codeOnly, functionHeaderPattern, lexed } from './sqlSourceLexer';

/**
 * Source guard for CRX-MONEY-001, the blocking HIGH the exact-SHA gpt-5.6-sol
 * review raised on PR #371: `create_order_from_blend_ticket` accumulated
 * `price * qty` and `cost * qty` per line WITHOUT rounding and then overwrote
 * the order header with those raw sums. A fractional converted quantity makes
 * that a sub-cent value, which the live `orders_total_cost_whole_cents_chk` /
 * `orders_total_profit_whole_cents_chk` constraints reject — rolling the whole
 * order back — and which, when it happened to fit, replaced the canonical
 * sum-of-rounded-lines the order_items triggers had already written.
 *
 * 20260811190000 deletes that write and re-reads the trigger-written header.
 * These assertions keep the delta from being undone and keep the surrounding
 * authorization, idempotency and locking clauses from being lost with it.
 *
 * BEHAVIOUR IS NOT PROVED HERE. It is proved end to end against real
 * PostgreSQL 17 by scripts/smoke/prove-blend-ticket-fractional-cents.mjs, which
 * reproduces the check_violation on the pre-fix body, applies this migration
 * verbatim, and then gets SMOKE_PASS_ROLLBACK out of
 * scripts/smoke/smoke-blend-ticket-fractional-cents.sql. This file only guards
 * the structure those runtime proofs depend on.
 */
const MIGRATION_PATH =
  'supabase/migrations/20260811190000_blend_ticket_order_totals_whole_cents.sql';
const CHAIN_PATH = 'scripts/smoke/smoke-blend-ticket-fractional-cents.sql';
const PROVER_PATH = 'scripts/smoke/prove-blend-ticket-fractional-cents.mjs';
const SPECS_PATH = 'scripts/smoke/smoke-specs.json';

const RPC = 'create_order_from_blend_ticket';

const migration = readFileSync(MIGRATION_PATH, 'utf8').replace(/\r\n/g, '\n');

/**
 * The one definition of the RPC, found through the shared lexer rather than a
 * literal `indexOf`. A second definition later in the file is the one Postgres
 * keeps, so a copy that put the raw header overwrite back would run in
 * production while a first-match search still read the intact original — and
 * the migration's own single-overload precondition would not catch it either,
 * because two `CREATE OR REPLACE`s of the same signature still leave one
 * overload. There is no legitimate reason to define it twice.
 */
function rpcDefinition(): string {
  const { masked, spans } = lexed(migration);
  const header = functionHeaderPattern(RPC);
  const starts: number[] = [];
  for (let m = header.exec(masked); m; m = header.exec(masked)) starts.push(m.index);

  expect(starts.length, `${RPC} is defined ${starts.length} times, expected exactly once`).toBe(1);
  const start = starts[0];
  const body = spans.find((s) => s.kind === 'body' && s.start > start);
  expect(body, `${RPC} is unterminated`).toBeDefined();
  return migration.slice(start, body!.end);
}

/**
 * The definition with comments AND string literals blanked. Every assertion
 * about what the function does runs against this: the migration's own §1
 * self-verify block quotes several of these same phrases inside `LIKE '%…%'`
 * literals, and its header comment narrates the removed UPDATE in prose, so an
 * assertion on raw source could be satisfied by text that never executes.
 */
const definition = rpcDefinition();
const definitionCode = codeOnly(definition);

/**
 * The same definition with comments blanked but string literals INTACT. The
 * authorization gates are `RAISE EXCEPTION 'AUTH_REQUIRED'` — the thing that
 * has to survive IS a literal, so those assertions cannot run against
 * `definitionCode`.
 */
const definitionNoComments = lexed(definition).masked;

/**
 * The whole migration with comments blanked but string literals intact, for
 * assertions that COUNT occurrences: §0b's prose narrates the very predicates
 * it enforces, so counting on raw source double-counts the explanation as code.
 */
const migrationNoComments = lexed(migration).masked;

describe('blend-ticket order totals migration (CRX-MONEY-001)', () => {
  it('no longer overwrites the order header with the raw accumulators', () => {
    // The regression itself. `v_total_price` / `v_total_cost` are summed without
    // rounding in the loop; assigning them straight into the constrained columns
    // is what raised check_violation.
    expect(definitionCode).not.toContain('SET total_price = v_total_price');
    expect(definitionCode).not.toContain('total_cost = v_total_cost');
    expect(definitionCode).not.toContain('total_profit = v_total_price - v_total_cost');

    // And no other spelling of a header write survives either: after the fix the
    // function must not UPDATE `orders` at all.
    expect(definitionCode).not.toMatch(/UPDATE\s+(?:public\s*\.\s*)?orders\b/i);
    expect(definitionCode).not.toMatch(/\btotal_margin_pct\s*=/);
  });

  it('re-reads the canonical trigger-written header instead', () => {
    // Without this the RPC would return the raw accumulators to the caller while
    // the database held the trigger's rounded values — a silent disagreement
    // between the toast the user sees and the row that was stored.
    expect(definitionCode).toMatch(
      /SELECT\s+o\.total_price,\s*o\.total_cost\s+INTO\s+v_total_price,\s*v_total_cost\s+FROM\s+orders\s+o\s+WHERE\s+o\.id\s*=\s*v_order_id/i,
    );
  });

  it('proves at run time that the trigger really wrote the header', () => {
    // The re-read alone trades a LOUD failure for a SILENT one. §0b can only
    // prove the order_items triggers exist at apply time; if
    // trg_recalc_order_totals were dropped afterwards the re-read would hand back
    // the 0/0/0/0 the INSERT seeded and the RPC would report success on a
    // zero-value order. The postcondition is the only thing covering run time, so
    // it has to survive as executable code, not as a comment.
    expect(definitionNoComments).toMatch(
      /RAISE\s+EXCEPTION\s+'BLEND_TICKET_HEADER_NOT_RECALCULATED/,
    );

    // It must compare against the canonical sum of the ROUNDED lines, computed
    // with the same expressions the live trigger uses. Comparing against the raw
    // accumulators, or against a bare `> 0` heuristic, would either re-introduce
    // the sub-cent bug or false-pass an order whose whole value rounds to zero.
    expect(definitionCode).toMatch(/SUM\(\s*ROUND\(\s*oi\.total_price,\s*2\s*\)\s*\)/i);
    expect(definitionCode).toMatch(
      /SUM\(\s*ROUND\(\s*COALESCE\(oi\.cost_per_unit,\s*0\)\s*\*\s*COALESCE\(oi\.total_units_needed,\s*0\),\s*2\s*\)\s*\)/i,
    );
    expect(definitionCode).toContain('FROM order_items oi');
    expect(definitionCode).toMatch(/o\.total_price\s+IS\s+NOT\s+DISTINCT\s+FROM/i);
    expect(definitionCode).toMatch(/o\.total_cost\s+IS\s+NOT\s+DISTINCT\s+FROM/i);

    // total_profit carries the other of the two validated whole-cent CHECKs this
    // migration exists to stop tripping. Verifying only price and cost would pass
    // a trigger that derived profit wrongly from two correct inputs.
    expect(definitionCode).toMatch(
      /o\.total_profit\s+IS\s+NOT\s+DISTINCT\s+FROM\s+ROUND\(\s*canonical\.canonical_price\s*-\s*canonical\.canonical_cost,\s*2\s*\)/i,
    );

    // IF NOT EXISTS, never PERFORM + IF NOT FOUND: FOUND belongs to whichever
    // statement ran last, so the PERFORM form silently disarms the moment anyone
    // inserts a statement between the probe and the test — and the §1 self-verify
    // below, which greps for the error string, would still be satisfied.
    expect(definitionCode).toMatch(/IF\s+NOT\s+EXISTS\s*\(/i);
    expect(definitionNoComments).not.toMatch(/PERFORM\s+1\s+FROM\s+\(/i);

    // And the migration's own in-database self-verify has to refuse a body that
    // lost it, so a later CREATE OR REPLACE cannot quietly drop the guard.
    expect(migration).toContain(
      "v_src NOT LIKE '%BLEND_TICKET_HEADER_NOT_RECALCULATED%'",
    );
  });

  it('keeps every authorization, idempotency and locking clause', () => {
    // The delta is one block. If any of these went missing with it, the fix
    // traded a money bug for an access-control bug.
    expect(definitionNoComments).toContain("RAISE EXCEPTION 'AUTH_REQUIRED'");
    expect(definitionNoComments).toContain("RAISE EXCEPTION 'ACTOR_MISMATCH'");
    expect(definitionNoComments).toContain("RAISE EXCEPTION 'INSUFFICIENT_ROLE");
    expect(definitionCode).toContain('is_admin() OR is_sales_rep()');
    expect(definitionNoComments).toContain(`check_idempotency(p_idempotency_key, '${RPC}')`);
    expect(definitionCode).toMatch(/save_idempotency\(\s*p_idempotency_key/);
    expect(definitionCode).toContain('FOR UPDATE');

    // Posture the RPC runs under, unchanged from live.
    expect(definitionCode).toContain('SECURITY DEFINER');
    // The search_path values sit in the CREATE header, outside any body, so the
    // lexer blanks them as ordinary string literals. Assert the keyword through
    // the mask (proving it is real code, not a comment) and the values on the
    // raw slice.
    expect(definitionCode).toMatch(/SET\s+search_path\s+TO\s/i);
    expect(definition).toMatch(/SET\s+search_path\s+TO\s+'public',\s*'pg_temp'/i);
    expect(definitionCode).toMatch(/p_idempotency_key\s+text\s+DEFAULT\s+NULL/i);
  });

  it('refuses to apply against a body this delta was not written against', () => {
    // §0. Replacing a drifted body wholesale is how a sibling session's fix gets
    // silently reverted. Compared LF-normalized so CRLF checkouts still match.
    expect(migration).toContain("md5(replace(p.prosrc, chr(13) || chr(10), chr(10)))");
    expect(migration).toContain('c056d2bf1200fd0fb73a0da54941a8d9');
    expect(migration).toMatch(/expected exactly 1 public\.create_order_from_blend_ticket overload/);
  });

  it('refuses to apply unless both order_items money triggers are live and enabled', () => {
    // §0b. Deferring the header to the triggers is only safe while the triggers
    // exist. This precondition must fail CLOSED — proved by stage D of
    // prove-blend-ticket-fractional-cents.mjs, which drops the rounding trigger
    // and requires the apply to be refused.
    expect(migration).toContain('trg_order_items_round_money');
    expect(migration).toContain('after_order_items_change');
    expect(migration).toContain('BLEND_TICKET_TOTALS_PRECONDITION');

    // Enabled is not a boolean. `tgenabled` is one of O/D/R/A, and 'R' (replica
    // only) does not fire for an ordinary origin session — so a `<> 'D'` test
    // would pass while the header silently went unwritten. Both halves must name
    // the two values that DO fire, and neither may regress to the loose form.
    expect(migrationNoComments).not.toMatch(/tgenabled\s*<>\s*'D'/);
    expect(migrationNoComments.match(/tgenabled\s+IN\s*\(\s*'O',\s*'A'\s*\)/g)).toHaveLength(2);

    // Name and timing alone don't prove the trigger still does the work this
    // delta hands to it: a deferred constraint trigger fires after the re-read, a
    // WHEN clause makes it skip rows, and a repointed tgfoid runs something else.
    expect(migrationNoComments.match(/tgconstraint\s*=\s*0/g)).toHaveLength(2);
    expect(migrationNoComments.match(/tgqual\s+IS\s+NULL/g)).toHaveLength(2);
    expect(migration).toContain(
      "tgfoid = 'public._round_money_to_whole_cents()'::regprocedure",
    );
    expect(migration).toContain(
      "tgfoid = 'public.trg_recalc_order_totals()'::regprocedure",
    );

    // tgfoid pins WHICH function the trigger calls, not WHAT it computes — and the
    // run-time postcondition copies that function's summation expressions verbatim.
    // The formula has already been rewritten twice; a third rewrite would leave
    // every bit test above green and turn every blend-ticket order creation into a
    // production failure. Pin the body so the two can only change together.
    expect(migrationNoComments).toContain(
      "'b1d61412adb90325b2a8599a52d929b6'",
    );
    expect(migrationNoComments).toMatch(/md5\(p\.prosrc\)[\s\S]{0,200}trg_recalc_order_totals/i);
  });

  it('leaves the grant posture at authenticated-only, never anon or PUBLIC', () => {
    expect(migration).toMatch(new RegExp(`REVOKE\\s+EXECUTE[\\s\\S]{0,200}${RPC}[\\s\\S]{0,200}FROM\\s+PUBLIC,\\s*anon`, 'i'));
    expect(migration).toMatch(new RegExp(`GRANT\\s+EXECUTE[\\s\\S]{0,200}${RPC}[\\s\\S]{0,200}TO\\s+authenticated`, 'i'));
    expect(migration).not.toMatch(new RegExp(`GRANT\\s+EXECUTE[\\s\\S]{0,200}${RPC}[\\s\\S]{0,200}TO\\s+anon`, 'i'));

    // The B10 marker the grant-change hook requires for a REVOKE migration.
    expect(migration).toContain('-- caller-analysis:');
  });

  it('ships with the runtime proof the hard rule requires', () => {
    // A migration-touched RPC is only "fixed" once a chain covering it passes
    // end to end. Both files, and the registry row that makes `--spec
    // create_order_from_blend_ticket` find them, have to exist.
    expect(existsSync(CHAIN_PATH), `${CHAIN_PATH} is missing`).toBe(true);
    expect(existsSync(PROVER_PATH), `${PROVER_PATH} is missing`).toBe(true);

    const chain = readFileSync(CHAIN_PATH, 'utf8').replace(/\r\n/g, '\n');
    expect(chain).toContain("RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'");

    const specs = JSON.parse(readFileSync(SPECS_PATH, 'utf8')) as {
      specs: Record<string, { chain: string; covers?: string[] }>;
    };
    const spec = specs.specs[RPC];
    expect(spec, `${RPC} is not registered in ${SPECS_PATH}`).toBeDefined();
    expect(spec.chain).toBe('smoke-blend-ticket-fractional-cents.sql');
    expect(spec.covers).toContain(RPC);
  });
});
