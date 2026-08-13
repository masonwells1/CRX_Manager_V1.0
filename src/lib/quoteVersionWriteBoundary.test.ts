import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * CRX-SEC-1 — quote_versions write boundary.
 *
 * public.quote_versions.snapshot_data became an AUTHORITATIVE cost source in
 * 20260812115236: restoring a version stamps quote_items.cost_at_quote_cents
 * from snapshot_data.sections[].items[].current_cost, convert_quote_to_order copies that
 * into the order's immutable cost snapshot, and profit and commissions derive
 * from there. So a client-writable path into this table is a path into
 * commission money.
 *
 * 20260813080000 makes writes RPC-owned. This suite is the shape guard for the
 * three artifacts that enforce that, in the same pattern as
 * returnWriteBoundary.test.ts: the migration, the standing drift predicate, and
 * the behavioural smoke. It reads files — it does NOT prove live state. The
 * predicate proves live privileges; the smoke proves live behaviour.
 */

const root = process.cwd();
const read = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');

const migration = read(
  'supabase',
  'migrations',
  '20260813080000_lock_quote_versions_writes_to_rpc.sql',
);
const predicate = read(
  'scripts',
  'db-invariant-sweeps',
  'predicates',
  'quote-versions-rpc-owned.sql',
);
const smoke = read('scripts', 'smoke', 'smoke-quote-version-write-boundary.sql');

/**
 * Statements with comment lines stripped and whitespace collapsed.
 *
 * The leading `[ \t]*` matters: both DO blocks in the migration are full of
 * INDENTED `--` comments, and a column-0-only strip leaves every one of them in
 * the text handed to the `;` split. None contains a semicolon today, so the
 * exact-match assertions below pass — but the first indented comment that ever
 * mentions one would cut a statement in half and fail this suite for a reason
 * that has nothing to do with the write boundary.
 */
const statements = (sql: string) =>
  sql
    .replace(/^[ \t]*--.*$/gm, '')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

/**
 * The migration with `--` comment lines removed, for assertions that a given
 * SQL shape is ABSENT. Matching absence against the raw text is a trap this
 * file has already hit once: the migration explains in prose why a filter was
 * removed, so banning the shape outright also bans its own explanation.
 */
const migrationCode = migration.replace(/^[ \t]*--.*$/gm, '');

const tableRevokes = statements(migration).filter(
  (statement) => /^REVOKE/i.test(statement) && /ON TABLE public\.quote_versions/i.test(statement),
);

describe('quote_versions write boundary — migration', () => {
  it('drops the ownership-only INSERT policy', () => {
    expect(migration).toMatch(/DROP POLICY IF EXISTS qversions_insert ON public\.quote_versions;/i);
  });

  it('revokes every browser write privilege in exactly one statement', () => {
    expect(tableRevokes).toEqual([
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON TABLE public.quote_versions FROM PUBLIC, anon, authenticated',
    ]);
  });

  it('revokes TRUNCATE, which no RLS policy could ever have stopped', () => {
    // RLS policies do not apply to TRUNCATE at all, so before this migration the
    // raw grant alone let an authenticated caller empty the whole table.
    expect(tableRevokes[0]).toContain('TRUNCATE');
  });

  it('never touches SELECT — version history must keep rendering', () => {
    expect(tableRevokes[0]).not.toMatch(/\bSELECT\b/i);
    expect(migration).toContain(
      "has_table_privilege('authenticated', 'public.quote_versions', 'SELECT')",
    );
    expect(migration).toMatch(/POSTCOND: authenticated lost SELECT/);
    expect(migration).toMatch(/POSTCOND: qversions_select was removed/);
  });

  it('aborts if the owner can no longer bypass RLS or no longer holds INSERT', () => {
    // The entire safety argument is that the definer owner bypasses RLS and
    // holds its own grant. rolbypassrls bypasses POLICIES, not GRANTS — so both
    // halves are asserted, before and after the revoke.
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('rolbypassrls');
    expect(
      migration.match(/has_table_privilege\(v_owner, 'public\.quote_versions', 'INSERT'\)/g) ?? [],
    ).toHaveLength(2);
  });

  it('checks column-level privileges, which table-level checks cannot see', () => {
    // has_table_privilege reports only the TABLE-level ACL, so a column grant on
    // snapshot_data alone reopens the whole money path with every other
    // postcondition still passing. Not a leftover-catcher: PostgreSQL's REVOKE
    // reference states that revoking a privilege on a table automatically
    // revokes the corresponding column privileges on each of its columns, so the
    // migration's own revoke already cleared any that existed at apply time.
    expect(migration).toContain(
      "has_any_column_privilege('authenticated', 'public.quote_versions', 'INSERT')",
    );
    expect(migration).toContain(
      "has_any_column_privilege('anon', 'public.quote_versions', 'UPDATE')",
    );
    expect(migration).toMatch(/POSTCOND: a COLUMN-level write privilege/);
  });

  it('scopes its timeouts to the transaction, not the pooled connection', () => {
    // A session-level SET leaks onto whatever unrelated work reuses the
    // connection next. SET LOCAL ends with the transaction and needs no RESET.
    expect(migration).toContain("SET LOCAL statement_timeout = '60s'");
    expect(migration).toContain("SET LOCAL lock_timeout = '10s'");
    expect(migration).not.toMatch(/^SET\s+(statement|lock)_timeout/m);
    expect(migration).not.toMatch(/^RESET\s+(statement|lock)_timeout/m);
  });

  it('refuses to seal a forged snapshot inside the new boundary', () => {
    // The hole stays open until this file applies. A row inserted in the gap
    // would remain permanently restorable into cost_at_quote_cents, so the
    // exploitation check is a hard precondition, not just a header note.
    expect(migration).toMatch(/cost basis below half the product current cost/);
  });

  it('reads the forged cost the way the restore path does', () => {
    // Restore extracts with ->> and casts to numeric, so a forged
    // "current_cost": "0.01" — a quoted STRING rather than a JSON number —
    // restores identically. A jsonb_typeof(...) = 'number' filter would skip
    // precisely the payload an attacker would send.
    expect(migration).not.toMatch(/jsonb_typeof\([^)]*current_cost[^)]*\)\s*=\s*'number'/);
    expect(migration).toContain("nullif(itm.value ->> 'current_cost', '')");
  });

  it('counts snapshot lines it cannot evaluate instead of skipping them', () => {
    // An inner join to products silently DROPS a line pointing at a deleted or
    // zero-cost product — exactly where a forged line would hide. Restore never
    // consults the product row, so such a line is still fully restorable.
    expect(migration).toContain('LEFT JOIN public.products pr');
    expect(migration).toMatch(
      /PRECOND \(advisory, not blocking\): % existing quote_versions snapshot line\(s\) name a product that no longer exists/,
    );
  });

  it('blocks on every unevaluable class except the one the FK already protects', () => {
    // This replaces a single v_unknown bucket that was advisory for ALL of it.
    // The reasoning that produced that bucket was sound but too coarse: it
    // argued that a line nobody can classify is no less frozen without this
    // migration, so aborting on one would let routine catalog decay block a
    // SECURITY fix. True for exactly ONE of the classes it lumped together.
    //
    //   unrestorable — product row gone or product_id malformed. Advisory, and
    //     provably so: quote_items.product_id is NOT NULL REFERENCES
    //     products(id), so a restore of such a line dies on the foreign key
    //     before it can stamp any cost basis. Not a forgery vector.
    //   exotic — cost written as 0x../0o../0b../1_0. PostgreSQL 16+ parses
    //     these; JSON.stringify cannot emit them. Their presence is itself
    //     evidence the snapshot was hand-crafted. Must block.
    //   unchecked — restorable, but the cost is unreadable or the product
    //     carries no catalog cost to compare against. Restore does not consult
    //     the catalog, so sealing here freezes an unverified cost basis. Blocks.
    //
    // Measured read-only against live before this split was written: all three
    // buckets are empty, so blocking costs nothing at apply time and buys a
    // real assertion the day it stops being empty.
    const advisory = migration.match(/IF v_unrestorable > 0 THEN[\s\S]*?END IF;/);
    expect(advisory).not.toBeNull();
    expect(advisory![0]).toContain('RAISE NOTICE');
    expect(advisory![0]).not.toContain('RAISE EXCEPTION');

    for (const blocking of ['v_exotic', 'v_unchecked']) {
      const block = migration.match(new RegExp(`IF ${blocking} > 0 THEN[\\s\\S]*?END IF;`));
      expect(block, `${blocking} must have a reporting branch`).not.toBeNull();
      expect(block![0]).toContain('RAISE EXCEPTION');
      expect(block![0]).not.toContain('RAISE NOTICE');
    }

    // Disjointness is what makes those counts trustworthy. A chain of
    // independent boolean FILTERs would let one line land in two buckets and be
    // both advisory and blocking at once; a single CASE cannot.
    expect(migration).toContain('END AS bucket');
    expect(migration).toMatch(/count\(\*\) FILTER \(WHERE bucket = 'unrestorable'\)/);
  });

  it('still aborts on the forgery signature itself', () => {
    // The other half of that reversal, and the half that must NOT soften.
    // v_count is the below-half-cost signature — the thing this file exists to
    // refuse sealing in. Downgrading this one to a notice would turn the
    // exploitation check into decoration.
    // `v_count` is REUSED as a scratch counter by three separate blocks in the
    // precondition, so a bare .match() returns the FIRST one — the unrelated
    // mutation-policy check — and passes on its RAISE EXCEPTION while never
    // reading the forgery block at all. That is exactly how this assertion was
    // written originally, and it meant the one guard protecting the money check
    // would have stayed green through a downgrade to RAISE NOTICE. Collect every
    // block and select by the message text, which is unique to this one.
    const countBlocks = migration.match(/IF v_count > 0 THEN[\s\S]*?END IF;/g) ?? [];
    expect(
      countBlocks.length,
      'v_count is reused; if this drops to 1 the selection below is no longer load-bearing',
    ).toBeGreaterThan(1);

    const forgedBlock = countBlocks.find((block) => block.includes('forged-snapshot path'));
    expect(forgedBlock, 'the below-half-cost forgery block must still exist').toBeDefined();
    expect(forgedBlock!).toContain('RAISE EXCEPTION');
    expect(forgedBlock!).not.toContain('RAISE NOTICE');
  });

  // NOTE on the service_role token in the next test: it is SQL assertion text
  // being matched inside a migration file, never a credential this bundle
  // holds or sends. The frontend rule is unchanged — the browser uses the anon
  // key only, and nothing here reads or ships a service key.
  it('asserts the service key keeps its writes rather than claiming it in prose', () => {
    // REVOKE ... FROM PUBLIC removes only what PUBLIC held, but a role whose
    // privilege came THROUGH PUBLIC loses it as a side effect — surfacing weeks
    // later as a bare permission-denied in an edge function, with no migration
    // in the blame path. This is a BROWSER-role boundary and must not touch the
    // service key. Live reads it as a direct grant today, so the assertion is a
    // no-op that cannot quietly stop being one.
    expect(migration).toMatch(
      /has_table_privilege\(\s*'service_role',\s*'public\.quote_versions',\s*'INSERT'\s*\)/,
    );
    expect(migration).toContain('lost a write privilege on public.quote_versions');
  });

  it('fails closed if a writable view is ever layered over the table', () => {
    // Every other check here is table- and routine-scoped. An auto-updatable
    // VIEW without security_invoker evaluates base-table permissions AND RLS as
    // the VIEW OWNER, so `authenticated` holding INSERT on such a view keeps the
    // forged-snapshot path fully open with every other assertion passing. No
    // such object exists today; this closes the gap in the proof, not a hole.
    expect(migration).toContain('pg_rewrite');
    expect(migration).toContain('is writable by an external API role');

    // The scan must NOT narrow to relkind IN ('v','m'). A rewrite RULE can be
    // attached to an ordinary table ('r') or a partitioned one ('p'), and such a
    // write is permission-checked as the owner of the rule-carrying table —
    // the same hole a view opens, in an object the view filter walks straight
    // past. An earlier draft carried that filter; this pins its removal.
    expect(migrationCode).not.toMatch(/relkind\s*(=|IN\b)/);

    // Table-level has_table_privilege is not enough either: a grant of INSERT on
    // a SINGLE COLUMN of the rewriting relation is enough to drive the rewrite,
    // and the table-level test returns false for it.
    expect(migration).toMatch(/has_any_column_privilege\('authenticated', rr\.relid, 'INSERT'\)/);
    expect(migration).toMatch(/has_any_column_privilege\('anon', rr\.relid, 'INSERT'\)/);

    // And the walk must be RECURSIVE, not one hop. A view B over view A over
    // quote_versions carries its pg_depend edge to A, not to the table, so a
    // single hop never reaches B — while B can still be auto-updatable and a
    // write through it is permission-checked as B's owner. That is this check's
    // own hole one level further out, and an earlier draft had it. UNION rather
    // than UNION ALL is what makes the walk terminate on a rule cycle, so pin
    // that too: UNION ALL here would hang the apply instead of failing it.
    expect(migrationCode).toMatch(/WITH RECURSIVE rewrite_reachable AS/);
    expect(migrationCode).not.toMatch(/rewrite_reachable AS \([\s\S]{0,400}?UNION ALL/);
  });

  it('fails closed rather than open when it cannot see a routine body', () => {
    // A BEGIN ATOMIC body is stored parsed, not as source text, so such a
    // routine is invisible to the writer scan and the scan would then pass for
    // the wrong reason. prosqlbody is the marker; filtering on prokind = 'f'
    // would let a BEGIN ATOMIC *procedure* through both guard and scan.
    expect(migration).toContain('p.prosqlbody IS NOT NULL');
    // Asserted as the absence of a prokind PREDICATE rather than against one
    // specific historical draft. The previous form was pinned to an exact
    // multi-line shape, so a normally-written regression (`AND p.prokind = 'f'`
    // appended to the scan's WHERE clause) could never have matched it — the
    // guard documented the risk without covering it. A bare /prokind/ would not
    // work either: the migration's own comments explain why the filter is absent,
    // and banning the word would ban the explanation.
    expect(migration).not.toMatch(/p\.prokind/);
    expect(migration).not.toMatch(/prokind\s*(=|<>|!=|IN\b)/i);
    expect(migration).toMatch(/routine\(s\) have a BEGIN ATOMIC body/);
  });

  it('anchors the writer scan on statement shape, not a bare substring', () => {
    // An unanchored '%UPDATE%quote_versions%' also matches the substring
    // `updated_at` anywhere earlier in a body, aborting the apply on a routine
    // that merely reads the table.
    expect(migration).toContain(
      "p.prosrc ~* '(insert\\s+into|update|delete\\s+from|merge\\s+into)\\s+(only\\s+)?(\"?public\"?\\s*\\.\\s*)?\"?quote_versions\\M'",
    );
    expect(migration).not.toMatch(/ILIKE\s+'%UPDATE%quote_versions%'/i);
  });

  it('scans every non-system schema, not just public', () => {
    // A writer parked in another schema is still a writer.
    const scans =
      migration.match(/n\.nspname NOT IN \('pg_catalog', 'information_schema', 'pg_toast'\)/g) ?? [];
    expect(scans.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses a second RLS-bypassing writer rather than assuming it is benign', () => {
    // Such a routine cannot BREAK under this change, but it is an additional
    // authoritative writer of a table whose contents become trusted, and this
    // migration's reasoning accounts for exactly one.
    expect(migration).toMatch(
      /PRECOND: a second RLS-bypassing routine writes public\.quote_versions/,
    );
  });

  it('pins every signature it revokes, and refuses a surprise overload', () => {
    for (const signature of [
      'public.create_quote_version(uuid,uuid,text,text,bigint)',
      'public.restore_quote_version(uuid,uuid,uuid,text,bigint,text)',
      'public._create_quote_version_owner_impl(uuid,uuid,text,text)',
    ]) {
      expect(migration).toContain(signature);
    }
    // Every REVOKE names one signature; a second overload would silently escape.
    for (const name of [
      'create_quote_version',
      'restore_quote_version',
      '_create_quote_version_owner_impl',
    ]) {
      expect(migration).toMatch(new RegExp(`expected exactly 1[^\\n]*${name}`));
    }
  });

  it('carries the caller-analysis markers the grant-change guard requires', () => {
    expect(migration).toMatch(/-- caller-analysis: create_quote_version ::/);
    expect(migration).toMatch(/-- caller-analysis: restore_quote_version ::/);
    expect(migration).toMatch(/-- caller-analysis: _create_quote_version_owner_impl ::/);
  });

  it('keeps the owner-side writer uncallable from the browser', () => {
    expect(migration).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\._create_quote_version_owner_impl\(uuid, uuid, text, text\)\s+FROM PUBLIC, anon, authenticated;/,
    );
  });
});

describe('quote_versions write boundary — standing predicate', () => {
  it('covers every branch of the boundary', () => {
    for (const key of [
      'quote_versions:external-mutation-policy',
      'quote_versions:browser-mutation-privilege',
      'quote_versions:read-path-regressed',
      'quote_versions:rls-disabled',
      'quote_versions:force-rls-enabled',
      'quote_versions:column-mutation-privilege',
      '_create_quote_version_owner_impl(uuid, uuid, text, text)',
      '_create_quote_version_owner_impl:external-execute',
      '_create_quote_version_owner_impl:lost-insert-grant',
      'create_quote_version(uuid, uuid, text, text, bigint)',
      'restore_quote_version(uuid, uuid, uuid, text, bigint, text)',
      // The overload counts are not redundant with the signature-pinned branches
      // above them. A NEW overload of either entry point is born EXECUTE-able by
      // the API roles, and the pinned branches keep reporting clean on the old
      // signature while it happens. The migration checks this once, as a
      // PRECOND, because its REVOKEs each name one signature.
      'create_quote_version:overload-count',
      'restore_quote_version:overload-count',
      // The restore path's owner-side implementation. Nothing pinned its EXECUTE
      // anywhere: the global anon-exec-secdef predicate tests only `anon`, so
      // `authenticated` — the role a logged-in browser session carries — was
      // unwatched on this signature by every predicate in the sweep.
      '_restore_quote_version_owner_impl:external-execute',
      // ...and its own overload count, for the same reason the two entry points
      // have one: the branch above names ONE signature, so a second overload of
      // this name is unwatched by it, and on this project a new function is born
      // EXECUTE-able by the API roles.
      '_restore_quote_version_owner_impl:overload-count',
      // One layer further in than the entry point: 20260812115237 renamed the old
      // restore_quote_version to this and rebuilt the public name as a wrapper
      // that runs the below-cost approval check FIRST. The gate lives in the
      // wrapper, so anything able to call this directly restores a stored cost
      // basis with that check skipped.
      '_restore_quote_version_below_cost_impl_20260810:external-execute',
      // These six mirror assertions the migration makes exactly once, at apply
      // time. Without them the predicate describes only the table and its three
      // named routines, and a NEW writer or a NEW rewrite path could reopen the
      // boundary afterwards without disturbing anything the other branches
      // watch. Pinned here so the standing guard cannot quietly shrink back to
      // the one-shot set.
      'quote_versions:rewrite-path-writable',
      'quote_versions:writer-scan-blinded',
      'quote_versions:non-bypassing-writer',
      'quote_versions:second-authoritative-writer',
      'quote_versions:inheritance-path',
      'quote_versions:service-role-write-lost',
    ]) {
      expect(predicate).toContain(`'${key}' AS violation_key`);
    }
  });

  it('watches the two conditions the migration itself treats as load-bearing', () => {
    // The migration aborts on either.
    // FORCE RLS is a DRIFT TRIPWIRE, not an outage predictor: rolbypassrls is a
    // role attribute that bypasses policies with or without FORCE, so turning
    // FORCE on would NOT break the owner-side writer. What it would mean is that
    // this table's security model was deliberately reshaped after the boundary
    // was reasoned about. (An earlier version of this comment claimed the
    // outage; it was wrong, and the same wrong claim was corrected in the
    // migration and the predicate.)
    // The owner INSERT grant is the genuine load-bearing one: rolbypassrls
    // bypasses POLICIES, not GRANTS, so losing that grant really does kill
    // version creation while every other branch still reads healthy.
    expect(predicate).toContain('relforcerowsecurity');
    expect(predicate).toMatch(/has_table_privilege\(\s*r\.rolname,\s*'public\.quote_versions',\s*'INSERT'\s*\)/);
  });

  it('stays in lockstep with every privilege the migration revokes', () => {
    // If a later migration revokes one more privilege and nobody updates the
    // predicate, the sweep would keep passing while drifting.
    const revoked = tableRevokes[0]
      .replace(/^REVOKE\s+/i, '')
      .replace(/\s+ON TABLE[\s\S]*$/i, '')
      .split(',')
      .map((privilege) => privilege.trim().toUpperCase());

    expect(revoked).toContain('TRUNCATE');
    for (const privilege of revoked) {
      for (const role of ['authenticated', 'anon']) {
        expect(predicate).toContain(
          `has_table_privilege('${role}', 'public.quote_versions', '${privilege}')`,
        );
      }
    }
  });

  it('cannot be satisfied by breaking version history instead', () => {
    expect(predicate).toContain(
      "NOT has_table_privilege('authenticated', 'public.quote_versions', 'SELECT')",
    );
    expect(predicate).toContain("p.polname = 'qversions_select'");
  });

  it('is a read-only SELECT, as the sweep runner requires', () => {
    // run-sweeps.mjs refuses a predicate that is not a plain read.
    // Same indented-comment allowance as `statements()` above, so the two
    // parsers in this file cannot disagree about what counts as a comment.
    const body = predicate.replace(/^[ \t]*--.*$/gm, '').trim();
    expect(body.startsWith('SELECT')).toBe(true);
    expect(body.endsWith(';')).toBe(true);
    for (const line of body.split('\n')) {
      expect(line.trimStart()).not.toMatch(
        /^(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|GRANT|REVOKE|TRUNCATE)\b/i,
      );
    }
    expect(predicate).toContain('EXPECT ZERO rows');
  });
});

describe('quote_versions write boundary — behavioural smoke', () => {
  it('proves the denial under a real browser role, and rolls itself back', () => {
    expect(smoke).toContain("current_user <> 'authenticated'");
    expect(smoke).toMatch(
      /SET LOCAL ROLE authenticated;[\s\S]*current_user <> 'authenticated'[\s\S]*BEGIN\s+INSERT INTO public\.quote_versions[\s\S]*WHEN insufficient_privilege THEN[\s\S]*END;\s+RESET ROLE;/i,
    );
    expect(smoke).toContain("RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'");
  });

  it('checks UPDATE, DELETE and TRUNCATE, not just INSERT', () => {
    expect(smoke).toMatch(/UPDATE public\.quote_versions\s+SET snapshot_data = v_forged/i);
    expect(smoke).toMatch(/DELETE FROM public\.quote_versions/i);
    expect(smoke).toMatch(/TRUNCATE public\.quote_versions;/i);
    expect(smoke.match(/WHEN insufficient_privilege THEN/g) ?? []).toHaveLength(4);
  });

  it('forges the exact payload the money attack needs, in the shape restore walks', () => {
    // 0.01 passes the restore path's only validation (current_cost <= 0 raises
    // COST_BASIS_REQUIRED) and would understate COGS on every line it restores.
    expect(smoke).toContain("'current_cost', 0.01");
    // restore iterates snapshot_data -> 'sections' then section -> 'items'. A
    // flat top-level items[] payload is never read, so forging one would make
    // this file advertise a proof it was not performing.
    expect(smoke).toMatch(/'sections',\s*jsonb_build_array\([\s\S]*'items',\s*jsonb_build_array\(/);
    expect(smoke).toContain("'product_id', v_product_id");
    expect(smoke).toMatch(/SMOKE_FAIL: the forged snapshot reached quote_versions/);
  });

  it('refuses to run until the boundary exists, so it cannot write live data', () => {
    // Steps 1-4 are real write statements. Pre-fix they would SUCCEED, and
    // TRUNCATE would hold an ACCESS EXCLUSIVE lock on a money-authoritative
    // table for the length of the block.
    expect(smoke).toMatch(/SMOKE_PREREQ: % still holds % on public\.quote_versions/);
    expect(smoke).toMatch(/has_table_privilege\(v_role, 'public\.quote_versions', v_priv\)/);
  });

  it('asserts the privilege directly, not only the behavioural denial', () => {
    // An RLS WITH CHECK violation raises SQLSTATE 42501 too, so a 42501 alone
    // cannot distinguish "grant revoked" from "policy rejected this row".
    // Column-level grants survive REVOKE ... ON TABLE and are checked too.
    expect(smoke).toMatch(/has_any_column_privilege\(v_role, 'public\.quote_versions', v_priv\)/);
    expect(smoke).toMatch(/SMOKE_PREREQ: % holds a COLUMN-level %/);
  });

  it('picks a quote create_quote_version will actually accept', () => {
    // The RPC looks the quote up WHERE deleted_at IS NULL. The oldest quote in
    // production is the one most likely to be soft-deleted, and step 5 would
    // then report "the fix broke version creation" when nothing is broken.
    expect(smoke).toMatch(/FROM public\.quotes\s+WHERE deleted_at IS NULL/);

    // The status filter is the sharper trap and MUST be asserted here, not just
    // described in the smoke's comments. create_quote_version ends in an
    // unconditional UPDATE quotes SET status = 'sent', and the lifecycle trigger
    // admits 'sent' only from these four. On 2026-08-13 the oldest live quote
    // was 'cancelled', so an unfiltered pick chose exactly the row that
    // false-fails and blamed the security fix for a lifecycle rule. Without this
    // assertion, deleting the filter leaves the suite green.
    expect(smoke).toMatch(
      /status IN \('draft', 'revised', 'accepted', 'sent'\)/,
    );
    expect(smoke).toMatch(/SMOKE_SETUP: no live quote in draft\/revised\/accepted\/sent/);
  });

  it('is registered in smoke-specs.json, or run-smoke.mjs never runs it', () => {
    // run-smoke.mjs loads its work exclusively from smoke-specs.json; it does
    // not discover scripts/smoke/*.sql from disk the way run-sweeps.mjs
    // discovers predicates. An unregistered chain is dead code.
    const specs = JSON.parse(read('scripts', 'smoke', 'smoke-specs.json')) as {
      specs: Record<string, { chain?: string; covers?: string[]; area?: string[] }>;
    };
    const entry = Object.values(specs.specs).find(
      (spec) => spec.chain === 'smoke-quote-version-write-boundary.sql',
    );
    expect(entry).toBeDefined();
    expect(entry?.covers).toContain('create_quote_version');
    expect(entry?.area).toContain('security');
  });

  it('also proves the legitimate path still works', () => {
    // A boundary that broke version creation would pass every negative check.
    expect(smoke).toContain('SELECT public.create_quote_version(');
    expect(smoke).toMatch(/SMOKE_FAIL: create_quote_version RPC no longer works/);
    expect(smoke).toMatch(/SMOKE_FAIL: authenticated SELECT on quote_versions was refused/);
  });

  it('proves the legitimate path by OUTCOME, not by "it did not raise"', () => {
    // Two distinct vacuity traps, both of which the smoke passed at one point.
    //
    // 1. The read-back must be COUNTED. Under RLS a policy that stops matching
    //    returns zero rows rather than raising, so a bare PERFORM inside an
    //    exception handler passes just as happily against a table the browser
    //    can no longer read.
    expect(smoke).toMatch(/SELECT count\(\*\) INTO v_visible/);
    expect(smoke).toMatch(/v_visible < v_ver_before \+ 1/);
    expect(smoke).toMatch(/SELECT count\(\*\) INTO v_ver_before/);

    // 2. The RPC returning without raising is not proof it wrote anything:
    //    _create_quote_version_owner_impl short-circuits with status "duplicate"
    //    on an idempotency-key hit, writing nothing and raising nothing.
    expect(smoke).toMatch(/v_result ->> 'status', ''\) <> 'created'/);

    // And the freshness re-read that stops a concurrent bump to row_version from
    // surfacing as "the fix broke version creation".
    expect(smoke).toMatch(/SELECT row_version INTO v_row_version\s+FROM public\.quotes\s+WHERE id = v_quote_id;/);
  });

  it('never lets a SMOKE_FAIL be swallowed by its own handler', () => {
    expect(smoke.match(/IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;/g) ?? []).toHaveLength(4);
  });
});
