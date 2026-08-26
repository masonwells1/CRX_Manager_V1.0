import { createHash } from 'node:crypto';
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
const restoreTrustMigration = read(
  'supabase',
  'migrations',
  '20260825190000_quote_version_restore_trust_boundary.sql',
);
const predicate = read(
  'scripts',
  'db-invariant-sweeps',
  'predicates',
  'quote-versions-rpc-owned.sql',
);
const smoke = read('scripts', 'smoke', 'smoke-quote-version-write-boundary.sql');
const restoreTrustSmoke = read('scripts', 'smoke', 'smoke-quote-version-restore-trust.sql');
const quoteBuilder = read('src', 'pages', 'QuoteBuilder.tsx');
const db = read('src', 'lib', 'db.ts');
const testAreas = read('scripts', 'test-areas.json');

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

/**
 * Same treatment for the standing predicate. The migration is a ONE-SHOT check
 * that runs once and is gone; the predicate is what re-checks this boundary on
 * every sweep from then on. Any shape worth pinning in the migration is worth
 * pinning here too, or the durable half of the guard can drift while the
 * throwaway half stays green.
 */
const predicateCode = predicate.replace(/^[ \t]*--.*$/gm, '');

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

  it('locks quote_versions against concurrent writes before scanning and sealing it', () => {
    // The forgery precondition is only useful if an authenticated INSERT cannot
    // commit after its scan but before the direct-write boundary is removed.
    // The migration wrapper keeps this lock through the later DROP/REVOKE.
    const lock = migration.indexOf('LOCK TABLE public.quote_versions IN EXCLUSIVE MODE;');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(migration.indexOf('FROM public.quote_versions qv'));
    expect(lock).toBeLessThan(migration.indexOf('DROP POLICY IF EXISTS qversions_insert'));
  });

  it('refuses to seal a forged snapshot inside the new boundary', () => {
    // The hole stays open until this file applies. A row inserted in the gap
    // would remain permanently restorable into cost_at_quote_cents, so the
    // exploitation check is a hard precondition, not just a header note.
    expect(migration).toMatch(
      /stored cost basis that is not EXACTLY the live products\.current_cost/,
    );

    // And it must stay EXACT. Review finding CRX-QV-001 (2026-08-14) killed an
    // earlier revision that only flagged a line below HALF the catalog cost: a
    // basis forged at 60% of a $100 cost cleared that band, so the lockdown
    // would have sealed a forged snapshot in place permanently. A percentage
    // band cannot prove provenance — assert the comparison itself, so a future
    // edit cannot quietly reintroduce a tolerance.
    expect(migration).toMatch(/AND cost_num <> current_cost\)/);
    expect(migration).not.toMatch(/cost_num\s*<\s*current_cost\s*\/\s*2/);
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
    // zero-cost product — exactly where a forged line would hide. The LEFT JOIN
    // keeps it and lets the CASE classify it explicitly.
    //
    // An earlier revision justified this by saying restore never consults the
    // product row. It does, twice over: quote_items.product_id is NOT NULL
    // REFERENCES products(id), and the live below-cost trigger reads the catalog
    // row. The join shape is right regardless — what changes is that a line whose
    // product is gone is advisory because it CANNOT be restored, not because
    // nobody would look.
    expect(migration).toContain('LEFT JOIN public.products pr');
    expect(migration).toMatch(
      /PRECOND \(advisory, not blocking\): % existing quote_versions snapshot line\(s\) carry a product_id that cannot be read as a uuid at all, or one that reads fine but names a product row that no longer exists/,
    );
  });

  it('classifies a product_id the way the restore path casts it, not more strictly', () => {
    // The forgery scan and the restore path must agree on what resolves. Restore
    // casts with a bare (v_item->>'product_id')::uuid, and uuid_in accepts far
    // more than the canonical dashed form — brace-wrapped, hyphen-free and
    // irregularly hyphenated all parse and compare EQUAL to the canonical value.
    //
    // Classifying on the canonical pattern alone therefore sent a REAL product id
    // written without hyphens into the advisory 'unrestorable' bucket, whose
    // NOTICE the Supabase apply channel does not surface — while restore would
    // have resolved it happily and stamped its cost basis into canonical profit
    // and commission money. It blocks, and the reason is server-side rather than
    // a claim about the browser: snapshot_data is built by
    // _create_quote_version_owner_impl with jsonb_build_object from the typed
    // quote_items.product_id UUID column, and PostgreSQL renders a uuid in
    // exactly one form. A non-canonical spelling cannot come out of the
    // legitimate writer whatever a client sent in.
    expect(migration).toContain('AS product_id_exotic');
    expect(migration).toContain('p.cost_exotic OR p.product_id_exotic');
    // Normalize-then-test: strip braces and hyphens before checking for 32 hex
    // digits. A scan that only tested the canonical pattern would miss the exact
    // forms uuid_in accepts.
    expect(migration).toMatch(
      /replace\(replace\(replace\(btrim\(product_id_text\), '\{', ''\), '\}', ''\), '-', ''\)/,
    );
    // The blocking message has to name the product side too, or a hit reads as a
    // cost-literal problem and gets investigated in the wrong place.
    const exoticBlock = migration.match(/IF v_exotic > 0 THEN[\s\S]*?END IF;/);
    expect(exoticBlock).not.toBeNull();
    expect(exoticBlock![0]).toContain('product_id');
  });

  it('keeps the uuid canonical test case-SENSITIVE and the 32-hex test case-insensitive', () => {
    // These two choices are opposite ON PURPOSE and a "consistency" fix in either
    // direction reopens a hole, so both are pinned here.
    //
    // The stated invariant is that uuid_out renders lowercase, dashed, canonical.
    // An earlier revision tested the canonical pattern with `~*`, so an uppercase
    // 'A0EEBC99-...' was read as canonical, resolved to a real product, and
    // treated as legitimately written — contradicting the invariant three
    // paragraphs above it in the same file.
    //
    // But tightening the 32-hex-digit test too would be WORSE than the original
    // bug: an uppercase id would then fail both tests, leaving product_uuid NULL
    // with product_id_exotic false, which lands it in the ADVISORY 'unrestorable'
    // bucket — whose NOTICE the Supabase apply channel does not surface — instead
    // of the BLOCKING 'exotic' one. Case-insensitive there is what CATCHES it.
    const canonical = String.raw`\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$`;
    // Case-sensitive operators only on the canonical pattern: `~` and `!~`, never
    // `~*` or `!~*`. Asserted as "no case-insensitive operator precedes it".
    expect(migration).not.toMatch(new RegExp(`~\\*\\s*'${canonical}'`));
    expect(migration).toMatch(new RegExp(`(?<!\\*)\\s~\\s*'${canonical}'`));
    expect(migration).toMatch(new RegExp(`!~\\s*'${canonical}'`));
    // And the normalized 32-hex test stays case-insensitive.
    expect(migration).toMatch(/~\*\s*'\^\[0-9a-f\]\{32\}\$'/);
  });

  it('blocks on every unevaluable class except the one the FK already protects', () => {
    // This replaces a single v_unknown bucket that was advisory for ALL of it.
    // The reasoning that produced that bucket was sound but too coarse: it
    // argued that a line nobody can classify is no less frozen without this
    // migration, so aborting on one would let routine catalog decay block a
    // SECURITY fix. True for exactly ONE of the classes it lumped together.
    //
    //   unrestorable — product row gone, or a product_id that cannot be read as
    //     a uuid AT ALL. Advisory, and provably so: quote_items.product_id is
    //     NOT NULL REFERENCES products(id), so a restore of such a line dies on
    //     the foreign key before it can stamp any cost basis. Not a forgery
    //     vector. A product_id that is non-canonical but still castable does NOT
    //     land here — see the classification test above.
    //   exotic — a cost written as 0x../0o../0b../1_0, or a product_id in a
    //     non-canonical-but-castable form. PostgreSQL parses both and restore
    //     would accept both. Neither can come out of the legitimate writer:
    //     _create_quote_version_owner_impl builds snapshot_data server-side with
    //     jsonb_build_object from the typed current_cost and product_id columns,
    //     so the rendering is plain decimal and canonical dashed uuid. Their
    //     presence is itself evidence the row was written around that function.
    //     Must block.
    //   unchecked — the cost string is unreadable, or the product carries no
    //     catalog cost to compare against. Neither can be cleared by the scan,
    //     and sealing here would freeze an unverified cost basis inside the new
    //     boundary. Blocks. (An earlier revision justified this by saying restore
    //     does not consult the catalog — it does; the live below-cost trigger
    //     reads the product row and already refuses on the no-catalog-cost case.
    //     The block stays for the narrower contract reason.)
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
    expect(predicateCode).not.toMatch(/relkind\s*(=|IN\b)/);

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
    //
    // Both are pinned against the STANDING PREDICATE as well, not the migration
    // alone. The migration runs once; the predicate is what re-checks this
    // boundary on every sweep afterwards, so a one-hop regression there would
    // outlive the one it cannot happen in.
    for (const [label, sql] of [
      ['migration', migrationCode],
      ['predicate', predicateCode],
    ] as const) {
      expect(sql, `${label} must walk rewrite dependencies recursively`).toMatch(
        /WITH RECURSIVE rewrite_reachable AS/,
      );
      // Slice the CTE body out and test THAT, rather than a fixed-width window
      // after the opening paren: the predicate joins its branches with UNION ALL,
      // so a window wide enough to cover the CTE would also swallow the next
      // branch separator and fail for the wrong reason.
      const cte = sql.match(/WITH RECURSIVE rewrite_reachable AS \(([\s\S]*?)\n\s*\)\n/);
      expect(cte, `${label} must contain a readable recursive CTE body`).not.toBeNull();
      expect(
        cte![1],
        `${label} must use UNION, not UNION ALL, so the walk terminates on a rule cycle`,
      ).not.toMatch(/UNION ALL/);
    }
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
    // All FIVE revoked signatures, not the three this covered originally. The
    // two restore-side ones were added to the migration in a later round and the
    // list was not extended with them, so a typo in either REVOKE's signature —
    // the exact failure this test exists to catch — would have shipped green
    // under a title that claims "every signature".
    for (const signature of [
      'public.create_quote_version(uuid,uuid,text,text,bigint)',
      'public.restore_quote_version(uuid,uuid,uuid,text,bigint,text)',
      'public._create_quote_version_owner_impl(uuid,uuid,text,text)',
      'public._restore_quote_version_owner_impl(uuid,uuid,uuid,text)',
      'public._restore_quote_version_below_cost_impl_20260810(uuid,uuid,uuid,text,bigint)',
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
    // The restore-side pair is counted TOGETHER, so it is pinned by a combined
    // count of 2 rather than two counts of 1. Asserted in its own shape here
    // instead of being forced into the loop above: a single count of 2 admits
    // "two of one name and none of the other", which is why the migration also
    // requires both pinned signatures to resolve. Both halves are pinned.
    expect(migration).toMatch(/expected exactly 2 restore-side implementations/);
    expect(migration).toMatch(
      /to_regprocedure\('public\._restore_quote_version_owner_impl\(uuid,uuid,uuid,text\)'\) IS NULL/,
    );
    expect(migration).toMatch(
      /to_regprocedure\('public\._restore_quote_version_below_cost_impl_20260810\(uuid,uuid,uuid,text,bigint\)'\) IS NULL/,
    );
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

  it('seals the restore side, not only the write side', () => {
    // Sealing quote_versions against forged WRITES while a browser role can call
    // a restore implementation directly would close the front door and leave the
    // back one ajar: the public restore_quote_version is a thin wrapper that runs
    // the below-cost approval check and then delegates, so the gate lives in the
    // wrapper and anything reaching an implementation directly restores a stored
    // cost basis with that check skipped.
    //
    // The whole block was previously unpinned — it could have been deleted
    // wholesale and this suite would still have gone green.
    const precond = migration.match(
      /-- Overload counts first[\s\S]*?RAISE EXCEPTION 'PRECOND: a browser role can execute a restore-side implementation[\s\S]*?END IF;/,
    );
    expect(precond).not.toBeNull();
    const block = precond![0];

    // Exactly two implementations, counted BEFORE the signature-pinned checks —
    // an overload would sit outside every assertion that follows.
    expect(block).toContain("'_restore_quote_version_owner_impl',");
    expect(block).toContain("'_restore_quote_version_below_cost_impl_20260810'");
    expect(block).toMatch(/IF v_count <> 2 THEN/);

    // Both signatures must resolve, or the privilege checks below silently
    // evaluate against nothing.
    expect(block).toContain(
      "to_regprocedure('public._restore_quote_version_owner_impl(uuid,uuid,uuid,text)') IS NULL",
    );
    expect(block).toContain(
      "to_regprocedure('public._restore_quote_version_below_cost_impl_20260810(uuid,uuid,uuid,text,bigint)') IS NULL",
    );

    // Four privilege checks: two roles across two implementations. `anon` alone
    // is what the global anon-exec-secdef predicate already covers, so dropping
    // `authenticated` here would silently reduce this to a duplicate of it —
    // and `authenticated` is the role a logged-in browser session carries.
    expect(block.match(/has_function_privilege\('authenticated'/g) ?? []).toHaveLength(2);
    expect(block.match(/has_function_privilege\('anon'/g) ?? []).toHaveLength(2);
  });

  it('pins the defensive restore-side revokes, and reads both of them back', () => {
    // These do NOT "correct" a live browser grant, and an earlier version of this
    // test asserted that they did. The precondition ~500 lines earlier raises
    // unconditionally if either browser role holds EXECUTE on either routine, and
    // it runs before the first write — so if there were anything to correct the
    // apply would already have aborted and these statements would never be
    // reached. They are unreachable-as-a-fix by construction. What they buy is
    // that the revoked state is written down as an executable statement, so it
    // survives the precondition being narrowed or this file being copied.
    expect(migration).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\._restore_quote_version_owner_impl\(uuid, uuid, uuid, text\)\s+FROM PUBLIC, anon, authenticated;/,
    );
    expect(migration).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\._restore_quote_version_below_cost_impl_20260810\(uuid, uuid, uuid, text, bigint\)\s+FROM PUBLIC, anon, authenticated;/,
    );
    // service_role must NOT appear in either revoke. It holds EXECUTE on the
    // owner-side implementation today and this file's declared scope is the
    // browser roles; sweeping it up here would be an undeclared behaviour change.
    const restoreRevokes =
      migration.match(/REVOKE EXECUTE ON FUNCTION public\._restore_quote_version[\s\S]*?;/g) ?? [];
    expect(restoreRevokes).toHaveLength(2);
    for (const stmt of restoreRevokes) {
      expect(stmt).not.toContain('service_role');
    }

    // Both revokes must be READ BACK in the postcondition. REVOKE silently
    // no-ops when the grant was issued by a role the executing role is not a
    // member of, so "the statement ran" proves nothing on its own — which is
    // exactly why the create-side revoke has always had a read-back. The
    // restore-side pair did not, leaving the one failure mode these statements
    // can actually have unobserved. Asserted inside the postcond block only, so
    // that moving the check back into the precondition cannot satisfy this.
    const postcond = migration.match(/DO \$postcond\$[\s\S]*?\$postcond\$;/)?.[0] ?? '';
    expect(postcond).not.toBe('');
    for (const signature of [
      "'public._restore_quote_version_owner_impl(uuid,uuid,uuid,text)', 'EXECUTE'",
      "'public._restore_quote_version_below_cost_impl_20260810(uuid,uuid,uuid,text,bigint)', 'EXECUTE'",
    ]) {
      // Both browser roles, for each implementation.
      expect(postcond).toContain(`'authenticated', ${signature}`);
      expect(postcond).toContain(`'anon', ${signature}`);
    }
  });

  it('pins both public entry points as search_path-pinned SECURITY DEFINER', () => {
    // The hinge the whole fix swings on. After the REVOKEs, `authenticated` holds
    // no direct write privilege on quote_versions, so the only remaining path is
    // these two wrappers running as their privileged owner. Two ways that breaks:
    //   * SECURITY INVOKER rebuild — the default, and therefore what an incomplete
    //     CREATE OR REPLACE silently produces — runs with the caller's revoked
    //     privileges and breaks create/restore for every user. Loud.
    //   * DEFINER rebuild that drops SET search_path — the same incomplete
    //     replace, one clause further along. Quiet, and worse: the wrapper keeps
    //     running as an RLS-bypassing owner while resolving its unqualified
    //     references through whatever schema the caller put first.
    // Both reviewers flagged, independently, that this assertion originally
    // covered only the first. The owner-side check twenty lines down in the
    // migration has always asserted both; there is no reason the two routines
    // that BECOME the only write path get held to the weaker half.
    const secdef = migration.match(/AND p\.proname IN \('create_quote_version', 'restore_quote_version'\)[\s\S]*?END IF;/);
    expect(secdef).not.toBeNull();
    expect(secdef![0]).toContain('NOT p.prosecdef');
    // The search_path half. Matched on the space-stripped comparison the
    // migration actually uses, so a rewrite that drops the `replace()` and
    // compares the raw proconfig value — which carries a space after the comma
    // on live and would therefore never match — fails here rather than silently
    // asserting nothing.
    expect(secdef![0]).toContain("replace(config.value, ' ', '') = 'search_path=public,pg_temp'");
    expect(secdef![0]).toContain('PRECOND:');
  });
});

describe('quote_versions restore trust boundary — prerequisite', () => {
  it('fails closed unless the earlier RPC-only write boundary is fully live', () => {
    const precond = restoreTrustMigration.match(/DO \$precond\$[\s\S]*?\$precond\$;/)?.[0] ?? '';
    expect(precond).not.toBe('');
    expect(precond).toContain("p.polcmd IN ('a', 'w', 'd', '*')");
    for (const role of ['authenticated', 'anon']) {
      for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES']) {
        expect(precond).toContain(`has_table_privilege('${role}', 'public.quote_versions', '${privilege}')`);
      }
      for (const privilege of ['INSERT', 'UPDATE', 'REFERENCES']) {
        expect(precond).toContain(`has_any_column_privilege('${role}', 'public.quote_versions', '${privilege}')`);
      }
    }
    expect(precond).toContain('refuse to create a forgeable trust marker');
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
      // ...and its overload count, the last one in this chain to get one. The
      // branch above names ONE signature, (uuid,uuid,uuid,text,bigint), so a
      // second overload of this name sits outside it — born EXECUTE-able by the
      // API roles, and sitting BELOW the below-cost approval gate exactly as the
      // pinned one does. Both independent reviewers found this gap on the same
      // round; it is the B9 shape, where a guard stayed green while the hole it
      // watched was reopened one signature over.
      '_restore_quote_version_below_cost_impl_20260810:overload-count',
      // These six mirror assertions the migration makes exactly once, at apply
      // time. Without them the predicate describes only the table and its five
      // named routines, and a NEW writer or a NEW rewrite path could reopen the
      // boundary afterwards without disturbing anything the other branches
      // watch. Pinned here so the standing guard cannot quietly shrink back to
      // the one-shot set.
      'quote_versions:rewrite-path-writable',
      'quote_versions:writer-scan-blinded',
      'quote_versions:non-bypassing-writer',
      'quote_versions:second-authoritative-writer',
      'create_quote_version:trusted-marker-writer-contract',
      '_restore_quote_version_below_cost_impl_20260810:trust-check-contract',
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

  it('allows the post-boundary marker update only through its exact guarded writer contract', () => {
    expect(predicateCode).toContain("to_regprocedure('public.create_quote_version(uuid,uuid,text,text,bigint)')");
    expect(predicateCode).not.toContain("'public.create_quote_version(uuid,uuid,text,text,bigint)'::regprocedure");
    expect(predicateCode).toContain("WHEN to_regprocedure('public.create_quote_version(uuid,uuid,text,text,bigint)') IS NULL THEN true");
    expect(predicateCode).toContain("'create_quote_version:trusted-marker-writer-contract' AS violation_key");
    expect(predicateCode).toContain("'search_path=public,pg_temp'");
    expect(predicateCode).toContain("'authenticated', 'public.create_quote_version(uuid,uuid,text,text,bigint)', 'EXECUTE'");
    expect(predicateCode).toContain("'anon', 'public.create_quote_version(uuid,uuid,text,text,bigint)', 'EXECUTE'");
    expect(predicateCode).toContain('restore_trusted_at');
    expect(predicateCode).toContain('regexp_count(');
    expect(predicateCode).toContain("'\\mupdate\\s+(only\\s+)?(\"?public\"?\\s*\\.\\s*)?\"?quote_versions\\M'");

    // CodeRabbit rounds 4 and 5 (2026-08-25/26). Round 4 replaced a blocklist of
    // assignment spellings with a CLOSED allowlist over the guarded region.
    // Round 5 showed the allowlist was anchored in the wrong place: it started
    // at the `v_version_id` assignment, leaving the interval between the owner
    // impl RETURNING and that assignment unchecked. A body that slipped
    //   v_result := jsonb_build_object('status','created','version_id', <legacy>)
    // into that gap passed every check and stamped an arbitrary legacy row.
    // The region now starts at the owner call, which also pins its ARGUMENTS.
    const trustRegion =
      "v_result := public._create_quote_version_owner_impl" +
      "( p_quote_id, p_performed_by, p_method, p_idempotency_key ); " +
      "v_version_id := nullif(v_result->>'version_id', '')::uuid; " +
      "if v_result->>'status' is distinct from 'created' or v_version_id is null then " +
      "raise exception 'quote_version_trust_mark_failed'; end if;";
    const createBody =
      restoreTrustMigration.match(
        /CREATE OR REPLACE FUNCTION public\.create_quote_version\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/,
      )?.[1] ?? '';
    expect(createBody).not.toBe('');
    const loweredBody = createBody.toLowerCase();
    const normalizeRegion = (body: string) => {
      const from = body.indexOf('v_result := public._create_quote_version_owner_impl');
      const to = body.indexOf('update public.quote_versions');
      if (from < 0 || to < 0 || to <= from) return null;
      return body.slice(from, to).replace(/\s+/g, ' ').trim();
    };
    // The migration's real body must normalize to exactly the pinned text. This
    // ties the shipped function to the sweep that polices it — a toContain() on
    // the predicate alone pins a string while the function drifts away from it.
    expect(normalizeRegion(loweredBody)).toBe(trustRegion);
    // ...and the predicate must compare against that same text, SQL-escaped.
    // CodeRabbit 2026-08-26: asserting the concatenation's fragments separately
    // proves nothing about their ORDER — reorder them, move one into another
    // branch, or splice an extra term between them and three toContain checks
    // still pass, which silently voids the paired claim that the predicate
    // pins the same region the migration ships. Collapse SQL string
    // concatenation (`' || '` joins adjacent literals) and assert the single
    // assembled literal instead.
    const predicateAssembled = predicateCode.replace(/\s+/g, ' ').split("' || '").join('');
    expect(predicateAssembled).toContain(`= '${trustRegion.replace(/'/g, "''")}'`);
    // The region is extracted from the owner call, not from a later derived
    // variable — that mis-anchoring was round 5's bypass.
    expect(predicateAssembled).toContain(
      "FROM strpos(lower(p.prosrc), 'v_result := public._create_quote_version_owner_impl')",
    );
    // Round 5's actual bypass: a forged v_result in the gap ahead of the anchor
    // must not normalize to the pinned region.
    const gapAttack = loweredBody.replace(
      "  v_version_id := nullif(v_result->>'version_id'",
      "  v_result := jsonb_build_object('status','created','version_id', v_legacy_id);\n" +
        "  v_version_id := nullif(v_result->>'version_id'",
    );
    expect(gapAttack).not.toBe(loweredBody);
    expect(normalizeRegion(gapAttack)).not.toBe(trustRegion);
    // ...as must a retargeting query after the anchor (round 4's bypass).
    const afterAnchorAttack = loweredBody.replace(
      '  update public.quote_versions',
      '  select id into v_version_id from public.quote_versions limit 1;\n  update public.quote_versions',
    );
    expect(afterAnchorAttack).not.toBe(loweredBody);
    expect(normalizeRegion(afterAnchorAttack)).not.toBe(trustRegion);
    // Whitespace is collapsed BEFORE trimming. The reverse order lets the
    // region's trailing newline collapse into a single space, and the real body
    // then fails its own guard — verified against live PostgreSQL 17.6.
    expect(predicateCode).toMatch(/AND btrim\(\s*regexp_replace\(/);
    expect(predicateCode).not.toMatch(/regexp_replace\(\s*btrim\(/);

    // Codex round 8 (2026-08-26): the region pin ends at the marker UPDATE, so
    // everything after it was unpinned — an appended EXCEPTION handler passed
    // the region pin, the sole-owner-call count, and the sole-UPDATE count
    // while quietly changing what a "successful" create means. The predicate
    // and the migration postcondition now pin the ENTIRE normalized body, in
    // BOTH branches that bless this function (the writer-scan exemption and
    // the named contract), so the two cannot drift apart.
    const createWholeBody = createBody.replace(/\s+/g, ' ').trim();
    expect(createWholeBody.length).toBe(3972);
    expect(createHash('md5').update(createWholeBody, 'utf8').digest('hex')).toBe(
      '3723acbbf1821e9d5d212c3aea983f86',
    );
    expect(
      (predicateCode.match(/= 3972\b/g) ?? []).length,
      'whole-body length pin must appear in both create branches of the predicate',
    ).toBe(2);
    expect((predicateCode.match(/= '3723acbbf1821e9d5d212c3aea983f86'/g) ?? []).length).toBe(2);
    expect(restoreTrustMigration).toMatch(/= 3972\b/);
    expect(restoreTrustMigration).toContain("= '3723acbbf1821e9d5d212c3aea983f86'");
    // The attack the pre-round-8 checks missed: append a handler, leave the
    // pinned region byte-identical. The region pin still passes on it; only
    // the whole-body pin refuses it.
    const handlerAttack = createBody.replace(
      /END;\s*$/,
      "EXCEPTION\n  WHEN raise_exception THEN\n    RETURN jsonb_build_object('status', 'created');\nEND;\n",
    );
    expect(handlerAttack).not.toBe(createBody);
    expect(normalizeRegion(handlerAttack.toLowerCase())).toBe(trustRegion);
    const handlerAttackNorm = handlerAttack.replace(/\s+/g, ' ').trim();
    expect(
      handlerAttackNorm.length === 3972 &&
        createHash('md5').update(handlerAttackNorm, 'utf8').digest('hex') ===
          '3723acbbf1821e9d5d212c3aea983f86',
    ).toBe(false);
  });

  it('pins the restore trust rejection before the only owner-side restore call', () => {
    expect(predicateCode).toContain("'_restore_quote_version_below_cost_impl_20260810:trust-check-contract' AS violation_key");
    expect(predicateCode).toContain("'QUOTE_VERSION_LEGACY_UNTRUSTED'");
    expect(predicateCode).toContain("regexp_count(p.prosrc, '_restore_quote_version_owner_impl\\s*\\(', 1, 'i') = 1");
    const predicateComparator =
      "strpos(lower(p.prosrc), 'raise exception ''quote_version_legacy_untrusted''')\n          < strpos(lower(p.prosrc), 'v_result := public._restore_quote_version_owner_impl')";
    const predicateDmlGuard =
      "!~* '(insert\\s+into|update\\s+(only\\s+)?[a-z_\\\"]|delete\\s+from|merge\\s+into|truncate\\s+(table\\s+)?[a-z_\\\"]|execute\\s+|perform\\s+|call\\s+)'";
    const predicatePrefixLength = ') = 2730';
    const predicatePrefixDigest = "= '62440ea5c855d1366808c5a2098177d7'";
    const predicateProtectsPrefix = (source: string) =>
      source.includes(predicateComparator) &&
      source.includes(predicateDmlGuard) &&
      source.includes(predicatePrefixLength) &&
      source.includes(predicatePrefixDigest);
    expect(predicateProtectsPrefix(predicateCode)).toBe(true);
    expect(restoreTrustMigration).toContain(predicatePrefixLength);
    expect(restoreTrustMigration).toContain(predicatePrefixDigest);
    expect(predicateProtectsPrefix(predicateCode.replace(predicatePrefixLength, ') = 2729'))).toBe(false);
    expect(predicateProtectsPrefix(predicateCode.replace(predicatePrefixDigest, "= '00000000000000000000000000000000'"))).toBe(false);

    const body = restoreTrustMigration.match(
      /CREATE OR REPLACE FUNCTION public\._restore_quote_version_below_cost_impl_20260810\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/,
    )?.[1];
    expect(body).toBeDefined();
    const trustCheck = "IF v_restore_trusted_at IS NULL THEN\n    RAISE EXCEPTION 'QUOTE_VERSION_LEGACY_UNTRUSTED';\n  END IF;";
    const trustRaise = "RAISE EXCEPTION 'QUOTE_VERSION_LEGACY_UNTRUSTED'";
    const ownerCall = 'v_result := public._restore_quote_version_owner_impl(';
    const hasSafeOrder = (source: string) =>
      source.indexOf(trustCheck) >= 0 &&
      source.indexOf(ownerCall) >= 0 &&
      source.indexOf(trustCheck) < source.indexOf(ownerCall);
    const hasReadOnlyPrefix = (source: string) => {
      const prefix = source.slice(0, source.indexOf(trustRaise));
      const normalizedPrefix = prefix.replace(/\s+/g, ' ').trim();
      return normalizedPrefix.length === 2730 &&
        createHash('md5').update(normalizedPrefix, 'utf8').digest('hex') === '62440ea5c855d1366808c5a2098177d7';
    };
    expect(hasSafeOrder(body!)).toBe(true);
    expect(hasReadOnlyPrefix(body!)).toBe(true);

    // Mutation proof: moving the exact rejection below the owner call must fail
    // the same ordering contract the standing SQL predicate enforces live.
    const movedAfterOwner = body!.replace(trustCheck, '').replace(ownerCall, `${ownerCall}\n${trustCheck}`);
    expect(hasSafeOrder(movedAfterOwner)).toBe(false);

    const predicateComparatorMutant = predicateCode.replace(predicateComparator, predicateComparator.replace(/</g, '<>'));
    expect(predicateProtectsPrefix(predicateComparatorMutant)).toBe(false);

    const predicateDmlGuardMutant = predicateCode.replace(predicateDmlGuard, "!~* '(delete\\s+from)' ");
    expect(predicateProtectsPrefix(predicateDmlGuardMutant)).toBe(false);

    const inlineUpdateMutant = body!.replace(trustCheck, `UPDATE public.quotes SET status = status;\n  ${trustCheck}`);
    expect(hasReadOnlyPrefix(inlineUpdateMutant)).toBe(false);

    const selectListHelperMutant = body!.replace(
      trustCheck,
      `SELECT 1, public.some_mutator() INTO v_cache_rows;\n  ${trustCheck}`,
    );
    expect(hasReadOnlyPrefix(selectListHelperMutant)).toBe(false);

    const conditionalHelperMutant = body!.replace(
      trustCheck,
      `IF public.some_mutator() THEN NULL; END IF;\n  ${trustCheck}`,
    );
    expect(hasReadOnlyPrefix(conditionalHelperMutant)).toBe(false);

    const quotedHelperMutant = body!.replace(
      trustCheck,
      `PERFORM "public"."some_mutator"();\n  ${trustCheck}`,
    );
    expect(hasReadOnlyPrefix(quotedHelperMutant)).toBe(false);

    const dollarIdentifierMutant = body!.replace(
      trustCheck,
      `PERFORM public.some_mutator$coalesce();\n  ${trustCheck}`,
    );
    expect(hasReadOnlyPrefix(dollarIdentifierMutant)).toBe(false);

    // Codex round 8 (2026-08-26): every check above pins the PREFIX — nothing
    // pinned the tail after the rejection. The bypass: keep the prefix
    // byte-identical, move the sole owner call into an appended EXCEPTION
    // handler, and raise into it deliberately. Catching
    // QUOTE_VERSION_LEGACY_UNTRUSTED then restores legacy snapshots while the
    // ordering check, the prefix pin, the exact-IF count and the
    // sole-owner-call count ALL still pass. Prove the miss, then prove the
    // whole-body pin is what catches it.
    const wholeBodyLength = 3720;
    const wholeBodyDigest = 'b864c261854b760ff22f1f24e87ae22f';
    const normalizeWhole = (source: string) => source.replace(/\s+/g, ' ').trim();
    const hasWholeBodyPin = (source: string) => {
      const normalized = normalizeWhole(source);
      return normalized.length === wholeBodyLength &&
        createHash('md5').update(normalized, 'utf8').digest('hex') === wholeBodyDigest;
    };
    expect(hasWholeBodyPin(body!)).toBe(true);

    const exceptionHandlerAttack = body!
      .replace(
        `  v_result := public._restore_quote_version_owner_impl(\n    p_quote_id, p_version_id, p_performed_by, p_idempotency_key\n  );`,
        `  RAISE EXCEPTION 'ROUTE_TO_HANDLER';`,
      )
      .replace(
        /END;\s*$/,
        "EXCEPTION\n  WHEN raise_exception THEN\n" +
          "    v_result := public._restore_quote_version_owner_impl(\n" +
          "      p_quote_id, p_version_id, p_performed_by, p_idempotency_key\n" +
          "    );\n    RETURN v_result;\nEND;\n",
      );
    expect(exceptionHandlerAttack).not.toBe(body!);
    // The attack passes every pre-round-8 check: prefix untouched, rejection
    // still present exactly once and still textually before the (relocated)
    // owner call, still exactly one owner call.
    expect(hasSafeOrder(exceptionHandlerAttack)).toBe(true);
    expect(hasReadOnlyPrefix(exceptionHandlerAttack)).toBe(true);
    expect(
      (exceptionHandlerAttack.match(/_restore_quote_version_owner_impl\s*\(/g) ?? []).length,
    ).toBe(1);
    // Only the whole-body pin refuses it.
    expect(hasWholeBodyPin(exceptionHandlerAttack)).toBe(false);

    // And the pin is mirrored where it is enforced: the standing predicate and
    // the migration postcondition.
    expect(predicateCode).toMatch(/= 3720\b/);
    expect(predicateCode).toContain(`= '${wholeBodyDigest}'`);
    expect(restoreTrustMigration).toMatch(/= 3720\b/);
    expect(restoreTrustMigration).toContain(`= '${wholeBodyDigest}'`);
  });

  it('keeps the new legacy-restore refusal intelligible in the quote UI', () => {
    expect(db).toContain("QUOTE_VERSION_LEGACY_UNTRUSTED: 'QUOTE_VERSION_LEGACY_UNTRUSTED'");
    expect(quoteBuilder).toContain('RpcErrorCodes.QUOTE_VERSION_LEGACY_UNTRUSTED');
    expect(quoteBuilder).toContain('This older saved version cannot be restored');
  });

  it('keeps the post-boundary predicate in the scoped security gate', () => {
    // This is deliberately red until both quote migrations apply. Excluding it
    // would make every later `test:security -- --with-db` silently omit the
    // trust-marker and restore-routing drift checks after deployment.
    const security = JSON.parse(testAreas).areas.security as { sweeps: string[] };
    expect(security.sweeps).toContain('quote-versions-rpc-owned');
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

describe('quote_versions restore trust boundary — rollback smoke', () => {
  it('is registered as a psql-only security/regression/lifecycle chain', () => {
    const specs = JSON.parse(read('scripts', 'smoke', 'smoke-specs.json')) as {
      specs: Record<string, { chain?: string; covers?: string[]; area?: string[]; psql_only?: boolean }>;
    };
    const entry = specs.specs.restore_quote_version_trust_boundary;
    expect(entry?.chain).toBe('smoke-quote-version-restore-trust.sql');
    expect(entry?.psql_only).toBe(true);
    expect(entry?.covers).toEqual(expect.arrayContaining(['create_quote_version', 'restore_quote_version']));
    expect(entry?.area).toEqual(expect.arrayContaining(['security', 'regression', 'lifecycle']));
  });

  it('refuses to run before the trust migration is deployed', () => {
    expect(restoreTrustSmoke).toContain("a.attname = 'restore_trusted_at'");
    expect(restoreTrustSmoke).toContain('SMOKE_PREREQ: 20260825190000 quote-version restore trust boundary is not deployed');
  });

  it('creates both an RPC-trusted version and an owner-only unmarked fixture', () => {
    expect(restoreTrustSmoke).toContain('SELECT public.create_quote_version(');
    expect(restoreTrustSmoke).toMatch(/restore_trusted_at IS NOT NULL/);
    expect(restoreTrustSmoke).toMatch(/INSERT INTO public\.quote_versions[\s\S]*restore_trusted_at[\s\S]*NULL/);
  });

  it('requires the exact legacy refusal before any quote state changes', () => {
    expect(restoreTrustSmoke).toContain("IF SQLERRM <> 'QUOTE_VERSION_LEGACY_UNTRUSTED' THEN");
    expect(restoreTrustSmoke).not.toMatch(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|TRIGGER)/i);
    expect(restoreTrustSmoke).toMatch(/to_jsonb\(q\), q\.row_version[\s\S]*FOR UPDATE/);
    expect(restoreTrustSmoke).toMatch(/v_quote_after IS DISTINCT FROM v_quote_before/);
    expect(restoreTrustSmoke).toMatch(/v_sections_after IS DISTINCT FROM v_sections_before/);
    expect(restoreTrustSmoke).toMatch(/v_items_after IS DISTINCT FROM v_items_before/);
  });

  it('chooses a quote that satisfies cost and drawn-ledger restore preconditions', () => {
    expect(restoreTrustSmoke).toMatch(/qi\.current_cost IS NULL OR qi\.current_cost <= 0/);
    expect(restoreTrustSmoke).toMatch(/qpd\.quantity_drawn > 0/);
    expect(restoreTrustSmoke).toContain('no restorable live quote with positive item costs, no drawn ledger');
  });

  it('also restores the marked version and proves the N+1 token', () => {
    expect(restoreTrustSmoke).toContain('v_trusted_version_id');
    expect(restoreTrustSmoke).toMatch(/v_restore_result->>'status', ''\) <> 'restored'/);
    expect(restoreTrustSmoke).toContain("(v_restore_result->>'row_version')::bigint <> v_expected_row_version + 1");
    expect(restoreTrustSmoke).toContain("RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK quote-version restore trust boundary'");
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
      specs: Record<string, { chain?: string; covers?: string[]; area?: string[]; psql_only?: boolean }>;
    };
    const entry = Object.values(specs.specs).find(
      (spec) => spec.chain === 'smoke-quote-version-write-boundary.sql',
    );
    expect(entry).toBeDefined();
    expect(entry?.covers).toContain('create_quote_version');
    expect(entry?.area).toContain('security');
    expect(entry?.psql_only).toBe(true);
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

  it('counts row-count movement in the one direction that proves a leak', () => {
    // This smoke runs against the live database while real sessions are working.
    // A strict before/after equality therefore fails whenever a legitimate
    // create_quote_version lands in another session between the two counts —
    // office traffic, not a boundary failure. Every write attempted in the
    // denial steps is a DELETE, an UPDATE, a TRUNCATE or an INSERT that must have
    // been refused, so the only count movement that is evidence of a leak is a
    // count that FELL; the forged INSERT succeeding is already caught by its own
    // SMOKE_FAIL the moment the statement fails to raise.
    //
    // Pinned because the asymmetry is the kind of thing a later reader "tidies"
    // back to <> for looking sloppy, reintroducing the flake — and because a
    // slip in the other direction (> instead of <) would make the assertion
    // vacuous while still looking deliberate.
    expect(smoke).toContain('IF v_after < v_before THEN');
    expect(smoke).not.toContain('IF v_after <> v_before THEN');
    expect(smoke).toMatch(/SMOKE_FAIL: quote_versions row count FELL/);
  });
});
