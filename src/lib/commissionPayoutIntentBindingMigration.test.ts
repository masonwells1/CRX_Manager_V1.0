import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getIdempotencyBindingRejection } from './idempotency';
import { functionHeaderPattern, lexed } from './sqlSourceLexer';

/**
 * Source guard for the Section 07 gauntlet HIGH finding: the commission payout
 * RPCs keyed their idempotency receipts on [operation, user] only, so a
 * retained browser key could replay a DIFFERENT payout's cached success.
 * 20260810170000 binds each receipt to the acting user and a hash of the exact
 * request. These assertions keep both halves — the SQL wrappers and their
 * page-level callers — from silently losing that binding.
 *
 * Behaviour is proved separately, against a real Postgres, by
 * scripts/smoke/prove-commission-payout-intent-binding.mjs. This file only
 * guards the structure those runtime proofs depend on.
 */
const MIGRATION_PATH =
  'supabase/migrations/20260810170000_bind_commission_payout_idempotency_to_intent.sql';

const migration = readFileSync(MIGRATION_PATH, 'utf8').replace(/\r\n/g, '\n');
const page = readFileSync('src/pages/CommissionPayments.tsx', 'utf8').replace(/\r\n/g, '\n');
const reports = readFileSync('src/pages/Reports.tsx', 'utf8').replace(/\r\n/g, '\n');

const PAYOUT_RPCS = [
  {
    name: 'create_commission_payment',
    signature: 'uuid[], text, text, date, text, uuid, text',
    impl: '_create_commission_payment_intent_impl_20260809',
    // Every field the admin can edit has to be inside the hash. A field left out
    // is a field an edited retry can change while still replaying the old
    // receipt — which is the exact bug this migration exists to close.
    fingerprintFields: [
      'actor_id', 'commission_ids', 'payment_method', 'reference', 'payment_date', 'notes',
    ],
    // Values normalized once in DECLARE, then shared by the hash and the call.
    normalized: ['v_payment_method', 'v_reference', 'v_notes'],
  },
  {
    name: 'post_commission_payment',
    signature: 'uuid, uuid, text',
    impl: '_post_commission_payment_intent_impl_20260809',
    fingerprintFields: ['actor_id', 'payment_id'],
    normalized: [],
  },
  {
    name: 'void_commission_payment',
    signature: 'uuid, text, uuid, text',
    impl: '_void_commission_payment_intent_impl_20260809',
    fingerprintFields: ['actor_id', 'payment_id', 'reason'],
    normalized: ['v_reason'],
  },
] as const;

function wrapperBody(name: string): string {
  // Every definition, not the first one. Reading the first was unsound in the
  // one direction that matters: a SECOND definition of the same signature later
  // in this file is the one Postgres keeps, so a copy that dropped the binding
  // check and delegated straight to the private implementation would run in
  // production while every assertion below still read the intact first copy —
  // and the overload count would still be one, so that test would not catch it
  // either. Requiring exactly one definition is stronger than reading the last:
  // there is no legitimate reason for this migration to define a wrapper twice,
  // so a second one should stop the suite and be looked at, not be silently
  // preferred.
  //
  // Found through the shared lexer rather than a literal string search. A plain
  // `indexOf('CREATE OR REPLACE FUNCTION public.<name>(')` sees only one of the
  // several spellings Postgres treats identically: a bare `CREATE FUNCTION`, an
  // unqualified name, `public."<name>"`, or a comment sitting between the
  // keywords all define the same live function and all slipped past it — so a
  // second definition written any of those ways left this "exactly once" check
  // green. It also could not tell a real definition from one quoted inside a
  // string literal.
  const { masked, spans } = lexed(migration);
  const header = functionHeaderPattern(name);
  const starts: number[] = [];
  for (let m = header.exec(masked); m; m = header.exec(masked)) starts.push(m.index);

  expect(starts.length, `${name} wrapper is defined ${starts.length} times, expected exactly once`)
    .toBe(1);
  const start = starts[0];
  const body = spans.find((s) => s.kind === 'body' && s.start > start);
  expect(body, `${name} wrapper is unterminated`).toBeDefined();
  return migration.slice(start, body!.end);
}

/** The jsonb_build_object that feeds the SHA-256 digest, and nothing else. */
function fingerprintBlock(body: string): string {
  const start = body.indexOf('v_fingerprint := encode(');
  expect(start, 'wrapper never computes a fingerprint').toBeGreaterThan(-1);
  const end = body.indexOf("'hex'", start);
  expect(end).toBeGreaterThan(start);
  return body.slice(start, end);
}

/** The guard that refuses a caller who sent no usable idempotency key. */
function missingKeyGuard(body: string): string {
  const start = body.indexOf('IF p_idempotency_key IS NULL');
  expect(start, 'wrapper does not check for a missing idempotency key').toBeGreaterThan(-1);
  return body.slice(start, body.indexOf('END IF;', start));
}

describe('commission payout intent-binding migration', () => {
  it('gates cached receipts on both the actor and the exact request', () => {
    const start = migration.indexOf('CREATE OR REPLACE FUNCTION public.check_idempotency_intent(');
    expect(start).toBeGreaterThan(-1);
    const body = migration.slice(start, migration.indexOf('$function$;', start));

    // The lock is the only thing serializing two sessions that hit the same key
    // at the same instant; without it both can read "no receipt" and both pay.
    expect(body).toContain('pg_advisory_xact_lock');
    expect(body).toContain("hashtextextended('crx:idempotency:' || p_key, 0)");
    expect(body).toContain('v_existing.request_actor_id IS DISTINCT FROM p_actor');
    expect(body).toContain("RAISE EXCEPTION 'IDEMPOTENCY_ACTOR_MISMATCH'");
    expect(body).toContain('v_existing.request_fingerprint IS DISTINCT FROM p_fingerprint');
    expect(body).toContain("RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH'");
    expect(body).toContain('SET search_path = public, pg_temp');

    // The wrapper reaches this check before the implementation's own
    // check_idempotency does, so the caller must still see the SAME formatted
    // text as before — a bare code here would be a silent error-surface change.
    expect(body).toContain(
      "'IDEMPOTENCY_CROSS_OP_KEY_REUSE: idempotency_key % is already in use for operation %; cannot reuse it for operation %',\n      p_key, v_existing.operation, p_operation",
    );

    // Receipts written before this migration carry neither binding column and
    // their original intent is unknowable, so they must fail closed rather than
    // replay as the current request.
    const legacyBridge = body.indexOf('v_existing.request_actor_id IS NULL');
    const actorGate = body.indexOf('v_existing.request_actor_id IS DISTINCT FROM p_actor');
    expect(legacyBridge).toBeGreaterThan(-1);
    expect(legacyBridge).toBeLessThan(actorGate);
    expect(body.slice(legacyBridge, actorGate)).toContain(
      'AND v_existing.request_fingerprint IS NULL',
    );

    // A blank key is a caller bug, not a missing key: check_idempotency raises
    // here, and losing that parity would let '   ' silently skip idempotency.
    expect(body).toContain("IF btrim(p_key) = '' THEN");
    expect(body).toContain("RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'");
  });

  it.each(PAYOUT_RPCS)('$name fingerprints its own request before touching a receipt', (rpc) => {
    const body = wrapperBody(rpc.name);

    expect(body).toContain('extensions.digest(');
    expect(body).toContain("'sha256'");
    expect(body).toContain(
      `public.check_idempotency_intent(\n    p_idempotency_key, '${rpc.name}', v_actor, v_fingerprint\n  )`,
    );
    // The fingerprint has to be computed from THIS call's arguments before the
    // receipt lookup, otherwise the lookup has nothing to compare against.
    expect(body.indexOf('v_fingerprint := encode(')).toBeLessThan(
      body.indexOf('check_idempotency_intent('),
    );

    // Exact field set, not a spot-check: an extra field is as wrong as a missing
    // one, because it makes retries that SHOULD replay look like new requests.
    const hashed = [...fingerprintBlock(body).matchAll(/^\s*'([a-z_]+)',/gm)].map((m) => m[1]);
    expect(hashed).toEqual([...rpc.fingerprintFields]);
  });

  it.each(PAYOUT_RPCS)('$name hashes and stores the identical normalized values', (rpc) => {
    if (rpc.normalized.length === 0) return;
    const body = wrapperBody(rpc.name);
    const hash = fingerprintBlock(body);
    // lastIndexOf, not indexOf: earlier mentions of the implementation name are
    // prose in the comments, and only the real call persists anything.
    const call = body.slice(body.lastIndexOf(`public.${rpc.impl}(`));

    for (const local of rpc.normalized) {
      // Normalize once, use twice. Hashing a trimmed value while persisting the
      // raw one would let ' REF-1 ' replay REF-1's receipt while claiming to
      // have stored different metadata.
      expect(hash, `${rpc.name} hashes a value it did not normalize`).toContain(local);
      expect(call, `${rpc.name} persists a value it did not hash`).toContain(local);
    }
  });

  it.each(PAYOUT_RPCS)('$name refuses a caller who sent no idempotency key', (rpc) => {
    const body = wrapperBody(rpc.name);
    const guard = missingKeyGuard(body);

    // A missing key used to delegate straight to the implementation, which ran
    // the payout with no receipt and therefore no intent binding at all — an
    // authenticated admin calling the RPC directly (PostgREST lets a defaulted
    // argument be omitted) reached the money path unbound. It must now RAISE.
    expect(guard, `${rpc.name} does not reject a whitespace-only key`).toContain(
      "p_idempotency_key !~ '[^[:space:]]'",
    );
    // [[:space:]] follows the database collation, so whether NBSP counts as
    // blank is not the same answer on every cluster. Demanding one printable
    // ASCII character makes the refusal deterministic wherever it runs — but
    // only with COLLATE "C" on it. Round-7 finding: Postgres resolves a bracket
    // RANGE through the active collating sequence too, so without the collation
    // pin [!-~] is exactly as locale-dependent as the predicate it was added to
    // backstop, and both could pass for a key with no printable ASCII at all.
    expect(guard, `${rpc.name} accepts a key with no printable ASCII character`).toContain(
      `p_idempotency_key COLLATE "C" !~ '[!-~]'`,
    );
    expect(guard).toContain(`RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: ${rpc.name}`);
    // And it must refuse rather than fall through to the payout.
    expect(guard, `${rpc.name} still delegates on a missing key`).not.toContain(
      `public.${rpc.impl}(`,
    );

    // The guard has to run BEFORE the implementation is ever called, or an
    // un-keyed request would pay out and only then be told it was invalid.
    expect(body.indexOf('IF p_idempotency_key IS NULL')).toBeLessThan(
      body.indexOf(`public.${rpc.impl}(`),
    );
  });

  it.each(PAYOUT_RPCS)('$name replays the committed receipt instead of re-running the payout', (rpc) => {
    const body = wrapperBody(rpc.name);
    const replayStart = body.indexOf('IF v_replay IS NOT NULL THEN');
    expect(replayStart).toBeGreaterThan(-1);
    const replayBlock = body.slice(replayStart, body.indexOf('END IF;\n\n', replayStart));

    // Delegating on replay would re-enter the implementation's operation-only
    // check_idempotency, which reads a NULL stored result as "never happened"
    // and would pay out a second time.
    expect(replayBlock).not.toContain(`public.${rpc.impl}(`);
    expect(replayBlock).toContain("jsonb_typeof(v_replay -> 'result') = 'null'");
    expect(replayBlock).toContain("RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID'");
  });

  it.each(PAYOUT_RPCS)('$name stamps the binding columns after doing real work', (rpc) => {
    const body = wrapperBody(rpc.name);
    const update = body.indexOf('UPDATE public.idempotency_keys');
    expect(update).toBeGreaterThan(-1);
    // lastIndexOf, not indexOf: a wrapper names its implementation more than
    // once, and comparing against the FIRST mention would pass even if the
    // binding UPDATE ran before the call that actually moves the money.
    expect(update).toBeGreaterThan(body.lastIndexOf(`public.${rpc.impl}(`));
    const updateBlock = body.slice(update);
    expect(updateBlock).toContain('SET request_fingerprint = v_fingerprint');
    expect(updateBlock).toContain('request_actor_id = v_actor');
    expect(updateBlock).toContain(`AND operation = '${rpc.name}'`);
    expect(updateBlock).toContain("RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'");
  });

  it.each(PAYOUT_RPCS)('$name renames its implementation re-runnably', (rpc) => {
    // A bare ALTER ... RENAME aborts on a second run because the target name
    // already exists, which would strand any recovery that replays this file.
    expect(migration).toContain(
      `IF to_regprocedure('public.${rpc.impl}(${rpc.signature})') IS NULL THEN`,
    );
    // …and refuse to install a wrapper over nothing if the original is absent.
    expect(migration).toContain(
      `IF to_regprocedure('public.${rpc.name}(${rpc.signature})') IS NULL THEN`,
    );
    expect(migration).toContain(
      `    ALTER FUNCTION public.${rpc.name}(${rpc.signature})\n      RENAME TO ${rpc.impl};`,
    );
  });

  it.each(PAYOUT_RPCS)('$name refuses to rename its own wrapper onto the implementation', (rpc) => {
    // The dangerous replay is not "everything is already installed" — that one
    // is handled by the re-runnability check above. It is the half-state: the
    // implementation has been dropped but the wrapper survived. Renaming the
    // wrapper onto the implementation name then gives it a body that calls
    // itself, and every postcondition in this migration (the name exists, one
    // overload, grants correct) still passes while every payout call recurses
    // until the stack blows. The rename must fail closed instead.
    const block = migration.slice(
      migration.indexOf(`IF to_regprocedure('public.${rpc.impl}(${rpc.signature})') IS NULL THEN`),
    );
    const rename = block.indexOf(`RENAME TO ${rpc.impl};`);
    expect(rename, `${rpc.name} rename block not found`).toBeGreaterThan(0);
    const beforeRename = block.slice(0, rename);
    // Read the stored body straight out of pg_proc. pg_get_functiondef() would
    // read more naturally here but is banned in migrations by the SQL commit
    // guard, and prosrc holds the body — which is where the call to the
    // implementation appears — so it answers the same question.
    const probe = `WHERE p.oid = to_regprocedure('public.${rpc.name}(${rpc.signature})');`;
    expect(beforeRename).toContain(probe);
    const guard = beforeRename.slice(beforeRename.indexOf(probe));
    expect(guard).toContain(`LIKE '%${rpc.impl}%' THEN`);
    // …and the guard has to ABORT, not warn.
    expect(guard).toContain('RAISE EXCEPTION');

    // Absence of the wrapper marker is not proof of identity: a public function
    // of the same name that is NOT this payout body would sail past that check
    // and be renamed into the implementation slot, so the guard also demands the
    // two contract markers the wrapper actually depends on.
    expect(guard, `${rpc.name} renames on absence alone, without an identity check`).toContain(
      "v_code NOT LIKE '%check_idempotency(%'",
    );
    expect(guard).toContain("v_code NOT LIKE '%commission_payment_items%'");

    // …and the markers are matched against the body reduced to CODE, not
    // against raw prosrc. prosrc keeps the comments AND every literal, so a body
    // that only NAMES check_idempotency() in a comment — or raises it inside a
    // RAISE NOTICE — would satisfy a plain LIKE while doing nothing of the kind.
    //
    // Round-8 finding: this used to be a chain of regexp_replace() strips, and a
    // regex chain is unsound in the UNSAFE direction. A dollar-quoted literal is
    // invisible to a '…' pattern; a '--' inside a literal deletes that literal's
    // closing quote and strands the rest; and because Postgres block comments
    // NEST while a non-greedy /\*.*?\*/ stops at the first close, a fully
    // commented body could FABRICATE a marker. The reduction is now a
    // character-loop lexer that knows each construct's real terminator and
    // RAISEs on anything it cannot terminate, so a body it cannot read
    // confidently is a refusal rather than a pass.
    const strip = guard.slice(0, guard.indexOf('v_code NOT LIKE'));
    expect(strip, `${rpc.name} matches the identity markers against raw source`).toContain(
      `v_code := public._crx_payout_code_only_20260809(v_src, 'public.${rpc.name}');`,
    );
    // The wrapper-marker check above stays on the RAW source on purpose: there,
    // any mention at all — comment included — must stop the rename, because
    // renaming the wrapper onto itself is the unrecoverable outcome.
    expect(guard.slice(0, guard.indexOf(`LIKE '%${rpc.impl}%' THEN`))).not.toContain('v_code');
  });

  it('reduces a candidate body to code with a lexer that fails closed', () => {
    const create = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public._crx_payout_code_only_20260809(p_src text, p_what text)',
    );
    expect(create, 'the identity-check helper is not defined').toBeGreaterThan(-1);
    const helper = migration.slice(create, migration.indexOf('$code_only$;', create));

    // The whole point of replacing the regex chain: every construct that can
    // hide a marker has to be recognised by its own real terminator, and an
    // unterminated one has to ABORT rather than be silently tolerated.
    for (const unterminated of [
      'unterminated block comment',
      'unterminated string literal',
      'unterminated dollar-quoted string',
      'unterminated quoted identifier',
    ]) {
      expect(helper, `the lexer does not refuse an ${unterminated}`).toContain(
        `RAISE EXCEPTION '% has an ${unterminated}, so its source cannot be read reliably; refusing to rename it', p_what`,
      );
    }
    // Nesting is the direction that could fabricate a marker, so the block
    // comment scan has to count depth rather than stop at the first close.
    expect(helper, 'the lexer does not count nested block comments').toContain(
      'depth := depth + 1',
    );
    // A body may be prefixed E'…\'…', where a backslash escapes the quote.
    expect(helper, 'the lexer ignores E-string backslash escapes').toContain('is_e');

    // It runs before the first rename that uses it, and it is not reachable
    // from the browser while it exists.
    expect(create).toBeLessThan(
      migration.indexOf("DO $rename_create$"),
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public._crx_payout_code_only_20260809(text, text)\n  FROM PUBLIC, anon, authenticated, service_role;',
    );

    // …and it does not outlive the migration: a leftover SECURITY INVOKER
    // helper is one more public function for a later caller to reach, so it is
    // dropped and the post-conditions refuse to pass if it survived.
    const drop = migration.indexOf(
      'DROP FUNCTION IF EXISTS public._crx_payout_code_only_20260809(text, text);',
    );
    expect(drop, 'the identity-check helper is left behind').toBeGreaterThan(
      migration.lastIndexOf('v_code := public._crx_payout_code_only_20260809('),
    );
    const verify = migration.slice(migration.indexOf('DO $verify$'));
    expect(verify).toContain(
      "IF to_regprocedure('public._crx_payout_code_only_20260809(text, text)') IS NOT NULL THEN",
    );
    expect(verify).toContain(
      "RAISE EXCEPTION 'the identity-check helper _crx_payout_code_only_20260809 was left behind'",
    );
  });

  it.each(PAYOUT_RPCS)('$name keeps its renamed implementation out of the browser', (rpc) => {
    expect(migration).toContain(
      `REVOKE ALL ON FUNCTION public.${rpc.impl}(${rpc.signature})\n  FROM PUBLIC, anon, authenticated, service_role;`,
    );
    expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${rpc.name}(${rpc.signature})`);
    expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${rpc.name}(${rpc.signature})`);
  });

  it('verifies overload uniqueness and the full deny matrix in the same transaction', () => {
    const verify = migration.slice(migration.indexOf('DO $verify$'));
    expect(verify).toContain('overload count = % (expected 1)');
    expect(verify).toContain('anonymous execution must remain revoked');
    expect(verify).toContain('authenticated execution grant missing');
    expect(verify).toContain('internal payout implementations must not be browser-executable');

    // Checking anon+authenticated only would let a service_role grant put the
    // unguarded implementation back on a PostgREST-reachable surface.
    expect(verify).toContain("ARRAY['anon', 'authenticated', 'service_role']");
    for (const rpc of PAYOUT_RPCS) {
      // has_function_privilege targets are written without spaces in the block.
      expect(verify).toContain(`'public.${rpc.impl}(${rpc.signature.replace(/ /g, '')})'`);
    }
    expect(verify).toContain("'public.check_idempotency_intent(text,text,uuid,text)'");
  });

  it('leaves no idempotency error code unaccounted for in the UI', () => {
    // Codes the UI deliberately does NOT treat as "retire the key". Each one has
    // to stay deliberate: a new code added to the migration without a decision
    // here would reach the admin as a raw database string.
    const INTENTIONALLY_UNCLASSIFIED = new Set([
      // The key belongs to a different operation — resetting it would mask a
      // caller bug rather than help the admin.
      'IDEMPOTENCY_CROSS_OP_KEY_REUSE',
      // These three are wrapper-programming errors, not admin-recoverable
      // states; the browser never sends a blank key or a missing fingerprint.
      'IDEMPOTENCY_KEY_REQUIRED',
      'IDEMPOTENCY_OPERATION_REQUIRED',
      'IDEMPOTENCY_FINGERPRINT_REQUIRED',
    ]);

    const raised = new Set(
      [...migration.matchAll(/RAISE EXCEPTION\s+'(IDEMPOTENCY_[A-Z_]+)/g)].map((m) => m[1]),
    );
    expect(raised.size).toBeGreaterThan(0);

    for (const code of raised) {
      const classified = getIdempotencyBindingRejection({ message: code }) !== null;
      expect(
        classified || INTENTIONALLY_UNCLASSIFIED.has(code),
        `${code} is raised by the migration but neither classified by `
          + 'getIdempotencyBindingRejection nor listed as intentionally unclassified',
      ).toBe(true);
    }
  });
});

describe('commission payout intent-binding callers', () => {
  it('imports the shared refusal classifier rather than matching raw codes', () => {
    expect(page).toContain(
      "import { getIdempotencyBindingRejection } from '../lib/idempotency';",
    );
  });

  it.each([
    ['create_commission_payment', 'createPaymentIdem', 'nothing was created'],
    ['post_commission_payment', 'postPaymentIdem', 'nothing was posted'],
    ['void_commission_payment', 'voidPaymentIdem', 'nothing was voided'],
  ])('%s handles a refused key and retires it', (rpcName, idemHandle, nothingHappened) => {
    const call = page.indexOf(`supabase.rpc('${rpcName}'`);
    expect(call, `${rpcName} caller is missing`).toBeGreaterThan(-1);
    const nextCatch = page.indexOf('} catch (err: unknown) {', call);
    expect(nextCatch).toBeGreaterThan(call);
    const catchBlock = page.slice(nextCatch, page.indexOf('\n  };', nextCatch));

    expect(catchBlock).toContain('getIdempotencyBindingRejection(err)');
    expect(catchBlock).toContain(`${idemHandle}.resetKey();`);
    expect(catchBlock).toContain("toast('warning'");
    // Awaited AND ordered: the toast tells the admin to check the list below it,
    // so the refresh has to have finished before that claim is true. Asserting
    // only that `await fetchPayments()` appears would still pass if the refresh
    // were moved below the toast, which is the bug this guards.
    //
    // Quietly, too: fetchPayments() raises its own 'Failed to load commission
    // payments' toast, and stacking that on top of a message that ALREADY
    // reports the stale list gives the admin two toasts for one event, the
    // generic one reading as though the payout itself failed.
    const refreshAt = catchBlock.indexOf('await fetchPayments({ quiet: true });');
    expect(refreshAt, 'refusal branch does not await a quiet refresh').toBeGreaterThan(-1);
    const warnAt = catchBlock.indexOf("toast('warning'");
    expect(
      refreshAt,
      'the refusal toast points the admin at the list, so the refresh must finish first',
    ).toBeLessThan(warnAt);
    // All three refusal kinds must reach the admin with their OWN wording. The
    // unusable-receipt case is the one that would otherwise trap them in a dead
    // retry, and telling them "another user owns this" instead would be false.
    // Whitespace-collapsed so re-indentation does not break it, but the branch
    // ORDER is asserted: widening the actor test to also swallow 'receipt' would
    // leave the receipt message present in the file yet permanently unreachable.
    // The receipt/intent messages are template literals because they end by
    // admitting a failed refresh; the actor message is a plain string because
    // it sends the admin to reload rather than to read the list.
    expect(catchBlock.replace(/\s+/g, ' ')).toContain(
      "toast('warning', rejection === 'actor'"
      + ` ? 'That retry belongs to another user, so ${nothingHappened}. Reload the page and try again.'`
      + " : rejection === 'receipt'"
      + ` ? \`The database could not confirm the outcome of this request, so ${nothingHappened} now.`,
    );
    // The admin must never be shown the raw database code.
    expect(catchBlock).not.toContain('IDEMPOTENCY_INTENT_MISMATCH');
    expect(catchBlock).not.toContain('IDEMPOTENCY_ACTOR_MISMATCH');
    // Unrelated failures must still reach Sentry and the error toast.
    expect(catchBlock).toContain(`context: '${rpcName}'`);
    expect(catchBlock).toContain("toast('error'");
  });

  it('never claims the retry belonged to a different request', () => {
    // A pre-migration receipt proves only that the key is spent, not that the
    // earlier request DIFFERED. Wording that asserts a difference would be a
    // statement the database cannot back up.
    expect(page).not.toContain('a different payment');
    // A 'receipt' refusal covers BOTH an unreadable stored result and no stored
    // result at all, so the wording must not assert the retry did anything —
    // only that its outcome cannot be confirmed.
    expect(page).not.toContain('what this retry already did');
    // IDEMPOTENCY_RECEIPT_MISSING is raised by the CURRENT attempt's binding
    // UPDATE and rolls that statement back, so a 'receipt' refusal does not
    // imply an earlier attempt ever happened. Wording that names one is a claim
    // the database cannot support.
    expect(page).not.toContain('outcome of the earlier attempt');
    expect(page).toContain('already used by an earlier commission payment');
    expect(page).toContain('already used by an earlier posting');
    expect(page).toContain('already used by an earlier void');
  });

  it('derives the key the way the server derives the fingerprint, not with String.trim()', () => {
    // Postgres btrim(text) with no character set strips the ASCII space and
    // nothing else; String.trim() also strips tabs, newlines and Unicode spaces
    // such as NBSP. Building the key with trim() therefore collapsed pairs of
    // values the server hashes apart — "REF" and "REF\t" shared one key but
    // produced two fingerprints — so the retry came back as
    // IDEMPOTENCY_INTENT_MISMATCH on a request the admin never changed. The
    // client-side normalizer has to mirror btrim exactly.
    expect(page).toContain("function pgBtrim(value: string): string {");
    expect(page).toContain("return value.replace(/^ +/, '').replace(/ +$/, '');");

    // The create fields are sent RAW, so btrim runs on the untouched string and
    // the scope must too.
    const scope = page.slice(page.indexOf('const selectionScope = JSON.stringify(['));
    const body = scope.slice(0, scope.indexOf(']);'));
    expect(body).toContain('pgBtrim(payMethod)');
    expect(body).toContain('pgBtrim(payRef)');
    expect(body).toContain('pgBtrim(payNotes)');
    expect(body, 'the create scope still normalizes with String.trim()').not.toContain('.trim()');

    // p_reason is the one field sent already JS-trimmed, so its scope mirrors
    // btrim on that same trimmed value rather than on the raw textarea.
    expect(page).toContain('p_reason: voidReason.trim(),');
  });

  it('keeps the post and void keys per target instead of resetting on row click', () => {
    // handlePost closes its own dialog before the RPC returns, so EVERY retry
    // goes back through the row button. Resetting the key there discarded the
    // one thing that could replay an uncertain post: the retry arrived with a
    // fresh key, the server refused it as already posted, and committed work was
    // reported to the admin as a failure. Scoping the key to the target id gives
    // a different row its own key without throwing this row's key away.
    expect(page).toContain(
      "useIdempotencyKey('post_commission_payment', profile?.id || '', postTargetId || '')",
    );
    // The void key also has to move with the REASON, because the server's void
    // fingerprint covers btrim(p_reason). Keyed on the row alone, an admin who
    // retried after editing the reason reused a key the server then refused as
    // IDEMPOTENCY_INTENT_MISMATCH — a dead end on a genuinely new request.
    expect(page).toContain(
      "`${voidTarget?.id || ''}|${pgBtrim(voidReason.trim())}`",
    );

    // And the row buttons must not reset. Scoped to the JSX handlers so the
    // legitimate resets — after a confirmed success and after a refusal — stay.
    for (const [handle, setter] of [
      ['postPaymentIdem', 'setPostTargetId(r.id);'],
      ['voidPaymentIdem', 'setVoidTarget(r);'],
    ]) {
      let at = page.indexOf(setter);
      expect(at, `${setter} is missing`).toBeGreaterThan(-1);
      while (at > -1) {
        const handlerStart = page.lastIndexOf('e.stopPropagation();', at);
        expect(handlerStart).toBeGreaterThan(-1);
        expect(
          page.slice(handlerStart, at),
          `the row button that runs ${setter} still discards the retained ${handle} key`,
        ).not.toContain(`${handle}.resetKey();`);
        at = page.indexOf(setter, at + 1);
      }
    }
  });

  it('never reports an ordinary void failure over a list it did not refresh', () => {
    // Round-7 finding. Only the BINDING refusals refreshed the list; every other
    // way a void can fail fell through to a flat "Failed to void payment" over
    // whatever the page happened to be showing. That is the dangerous case: the
    // RPC may have committed and lost its reply, and the activity-log write that
    // runs after it can throw on its own with the void already done. An admin
    // reading a flat failure over a list that still shows the payment as posted
    // reasonably reaches for something else.
    const start = page.indexOf("context: 'void_commission_payment'");
    expect(start, 'the generic void failure branch is missing').toBeGreaterThan(-1);
    const end = page.indexOf('setVoiding(false);', start);
    expect(end).toBeGreaterThan(start);
    const generic = page.slice(start, end);

    expect(generic, 'the ordinary void failure must refresh before it reports')
      .toContain('const voidFailListIsCurrent = await fetchPayments({ quiet: true });');
    expect(generic, 'the ordinary void failure must not claim the void did not happen')
      .toContain('the void may still have gone through');
    // And it must admit when even that refresh failed, rather than pointing the
    // admin at a list that is itself stale.
    expect(generic).toContain("${voidFailListIsCurrent ? '' : STALE_LIST_NOTE}");

    // The key stays. Retiring it here would turn the safe replay ("retry the
    // same void, get the same outcome") into a second, brand-new void request.
    expect(generic, 'an ordinary void failure must keep the key that makes a retry a replay')
      .not.toContain('voidPaymentIdem.resetKey();');
  });

  it('never leaves a payout button disabled after a failed recovery', () => {
    // Round-8 finding. Each handler cleared its busy flag on the line AFTER the
    // try/catch, so the flag was only cleared if the catch block itself ran to
    // completion. Every catch block on this page awaits fetchPayments() and
    // toast(), and a throw from either — a network error inside the refresh is
    // the obvious one — skipped the clear and left the button disabled until the
    // admin reloaded, on the exact path where they most need to retry.
    for (const clear of ['setCreating(false);', 'setPosting(null);', 'setVoiding(false);']) {
      const at = page.indexOf(clear);
      expect(at, `${clear} is missing`).toBeGreaterThan(-1);
      expect(page.indexOf(clear, at + 1), `${clear} appears more than once`).toBe(-1);
      const before = page.slice(0, at);
      expect(
        before.slice(before.lastIndexOf('} catch (err: unknown) {')),
        `${clear} runs after the catch instead of in a finally`,
      ).toContain('} finally {');
    }
  });

  it('reports a failed recovery refresh once, not twice', () => {
    // Round-8 finding. fetchPayments() raises its own generic 'Failed to load
    // commission payments' toast, and every recovery path here already reports
    // the same failure in its own wording — either by appending STALE_LIST_NOTE
    // or by telling the admin outright to reload. Two toasts for one event is
    // noise, and the generic one reads as though the payout itself failed.
    const fetchStart = page.indexOf('const fetchPayments = useCallback(');
    expect(fetchStart).toBeGreaterThan(-1);
    const fetchFn = page.slice(fetchStart, page.indexOf('}, [', fetchStart));
    expect(fetchFn).toContain('async ({ quiet = false } = {})');
    expect(fetchFn, 'the load-failure toast is not suppressible').toContain(
      "if (!quiet) toast('error', 'Failed to load commission payments');",
    );
    // The suppression must not cost the caller the fact itself: the refusal
    // wording is driven by the RETURN value, so quiet still has to report false.
    expect(fetchFn.slice(fetchFn.indexOf('if (!quiet)'))).toContain('return false;');

    // And every recovery path uses it. A catch block that refreshes loudly is
    // the double toast this fixes.
    for (const [from, to] of [
      ["const rejection = getIdempotencyBindingRejection(err);", '\n  };'],
    ]) {
      let at = page.indexOf(from);
      while (at > -1) {
        const block = page.slice(at, page.indexOf(to, at));
        expect(
          block,
          'a recovery path refreshes loudly, stacking a second toast on its own message',
        ).not.toContain('await fetchPayments();');
        at = page.indexOf(from, at + 1);
      }
    }
  });
});

/**
 * Reports has its OWN quick-pay path into create_commission_payment, and it is
 * the harder one: a single click loops once per recipient, so it cannot use the
 * shared useIdempotencyKey hook (one key would collide with itself across
 * recipients). It keeps a Map of retained keys instead, and these assertions
 * pin the three properties that make that safe.
 */
describe('Reports quick-pay idempotency scope', () => {
  const markPaid = (() => {
    const start = reports.indexOf('const handleMarkPaid = async () => {');
    expect(start, 'handleMarkPaid is missing from Reports').toBeGreaterThan(-1);
    const end = reports.indexOf('\n  };', start);
    expect(end).toBeGreaterThan(start);
    return reports.slice(start, end);
  })();

  it('does not derive the key from the commission ids alone', () => {
    // The original bug: `reports-commission-pay-${ids.join('-')}` is a pure
    // function of the selection, so the SAME key returns after a void reopens
    // those commissions — replaying the voided payment's receipt and reporting
    // success for a batch that was never created.
    expect(reports).not.toContain('reports-commission-pay-');
    expect(markPaid).toContain("generateIdempotencyKey('create_commission_payment'");
  });

  it('scopes the retained key to actor and the sorted selection, and freezes the date with it', () => {
    // The scope has to match what the server fingerprints. If it were narrower
    // than the fingerprint, a changed field would reuse the key and the server
    // would hard-refuse a retry the admin cannot escape.
    expect(markPaid).toContain('const scope = `${profile!.id}|${[...new Set(ids)].sort().join(\'-\')}`');
    expect(markPaid).toContain('markPaidKeys.current.get(scope)');
    expect(markPaid).toContain('markPaidKeys.current.set(scope, entry)');

    // Round-6 finding: the payment DATE must travel WITH the retained key, not
    // sit in the enclosing scope where it is recomputed on every click. The
    // server fingerprints the date, so a click at 23:59 whose reply was lost
    // could not replay after midnight if the date were recomputed — the retry
    // would look like a different request, mint a new key, and create a SECOND
    // batch for commissions the first click may already have paid.
    expect(markPaid).toContain('date: today');
    expect(markPaid).toContain('p_payment_date: entry.date');
    expect(markPaid, 'the retained key must carry its own date')
      .not.toContain('p_payment_date: today');
  });

  it('retires this click\'s keys only AFTER every recipient landed', () => {
    // The retirement must sit outside the loop. Retiring inside it strands a
    // partial batch: recipient A succeeds, recipient B times out, and dropping
    // A's key means the retry sends A a NEW key — the server refuses A (already
    // in a non-voided payment), the loop throws, and B is never reached.
    const loopStart = markPaid.indexOf('for (const [, ids] of byRecipient) {');
    const loopEnd = markPaid.indexOf('\n      }', loopStart);
    expect(loopStart, 'the per-recipient loop is missing').toBeGreaterThan(-1);
    expect(loopEnd).toBeGreaterThan(loopStart);
    const loopBody = markPaid.slice(loopStart, loopEnd);
    expect(loopBody, 'keys must not be retired inside the per-recipient loop')
      .not.toContain('markPaidKeys.current.delete(');

    const retire = markPaid.indexOf('for (const done of scopesThisClick) markPaidKeys.current.delete(done);');
    expect(retire, 'this click\'s keys are never retired').toBeGreaterThan(loopEnd);

    // Round-6 finding: "after the loop" is not far enough. The status read-back
    // below the loop can fail, and the catch block it lands in tells the admin
    // the keys were kept and that clicking again will replay the original
    // request. Retiring before that read made the promise false — the next
    // click would mint brand-new keys and pay the same commissions twice.
    const readBack = markPaid.indexOf(".select('id,status')");
    expect(readBack, 'the created batches are never read back').toBeGreaterThan(loopEnd);
    expect(retire, 'keys are retired before the status read-back that can throw')
      .toBeGreaterThan(readBack);

    // Round-7 finding: a binding refusal used to clear the WHOLE map, which
    // undid the partial-batch protection above. Recipient A lands, recipient B
    // is refused, and clearing throws away A's key too — so the retry sends A a
    // new key, the server refuses A because its commissions are already in a
    // live payment, and the loop dies before it ever reaches B. Drop only the
    // key that was actually refused: that unblocks the admin (a poisoned key is
    // never reused) without discarding the receipts that make a retry safe, and
    // without touching keys from unrelated earlier clicks.
    expect(markPaid, 'a binding refusal must not clear every retained key')
      .not.toContain('markPaidKeys.current.clear();');
    expect(markPaid, 'a binding refusal must drop the key it refused')
      .toContain('if (scopeInFlight) markPaidKeys.current.delete(scopeInFlight);');
    // The refused scope has to be recorded before the call, or the catch has
    // nothing to drop.
    expect(markPaid.indexOf('scopeInFlight = scope;'))
      .toBeLessThan(markPaid.indexOf(".rpc('create_commission_payment'"));
    expect(markPaid).toContain('getIdempotencyBindingRejection(err)');
  });

  // Anchored on the catch block, not on the first `toast('warning'` in the whole
  // handler: the success path now carries a warning of its own (the voided-batch
  // replay), and slicing from the first match silently pointed these assertions
  // at the SUCCESS path, where they passed no matter what the failure branches
  // did. A mutation that deleted the failure refresh went unnoticed.
  const catchBlock = markPaid.slice(markPaid.indexOf('} catch (err: unknown) {'));
  const refusalBranch = catchBlock.slice(
    catchBlock.indexOf('if (rejection) {'),
    catchBlock.indexOf('\n      } else {'),
  );
  const genericBranch = catchBlock.slice(catchBlock.indexOf('\n      } else {'));

  it('refreshes before the refusal toast and never overstates what was skipped', () => {
    expect(refusalBranch, 'the refusal branch is missing').toContain("toast('warning'");
    const refreshAt = refusalBranch.indexOf('await fetchCommissions();');
    expect(refreshAt, 'the refusal branch does not await a refresh').toBeGreaterThan(-1);
    expect(refreshAt).toBeLessThan(refusalBranch.indexOf("toast('warning'"));
    // One click makes one call per recipient. Recipients processed before the
    // refusal really were paid, so the message must be conditional on how many
    // actually landed — a flat "no payment batch was created" invites a
    // duplicate batch.
    expect(markPaid.replace(/\s+/g, ' ')).toContain("toast('warning', totalBatched > 0");
    expect(markPaid).toContain('were already added to a payment batch before it stopped');
  });

  it('also refreshes and reports partial progress on an ORDINARY failure', () => {
    // A binding refusal is the rare path. The common one is a timeout on the
    // third recipient, and that lands in the generic branch — which used to show
    // a bare error over a stale list, reading as "nothing happened" to an admin
    // who had in fact just paid two people.
    expect(genericBranch, 'the generic failure branch is missing').toContain("toast('error'");
    const refreshAt = genericBranch.indexOf('await fetchCommissions();');
    expect(refreshAt, 'the generic failure branch does not await a refresh').toBeGreaterThan(-1);
    expect(refreshAt).toBeLessThan(genericBranch.indexOf("toast('error'"));
    expect(genericBranch.replace(/\s+/g, ' ')).toContain("toast('error', totalBatched > 0");
  });

  it('counts an attempted recipient BEFORE the call, not after it returns', () => {
    // `totalBatched` only rises once a response comes back. On a single-recipient
    // click whose payment commits but whose response is lost, it stays at zero —
    // so a counter read after the fact cannot tell "a batch may exist" from
    // "nothing happened", and the admin is told the latter.
    const loopStart = markPaid.indexOf('for (const [, ids] of byRecipient) {');
    const loopBody = markPaid.slice(loopStart, markPaid.indexOf('\n      }', loopStart));
    const counted = loopBody.indexOf('attempted += 1;');
    expect(counted, 'nothing counts the attempt before the RPC').toBeGreaterThan(-1);
    expect(counted, 'the attempt is counted after the call, which proves nothing')
      .toBeLessThan(loopBody.indexOf("await supabase.rpc('create_commission_payment'"));
    expect(markPaid).toContain('let attempted = 0;');
    // …and the failure wording has to use it, otherwise counting is decoration.
    expect(genericBranch.replace(/\s+/g, ' ')).toContain(': attempted > 0');
  });

  it('confirms every batch it created is still live before claiming success', () => {
    // A retained key does not create anything on a retry — it replays the
    // ORIGINAL outcome. If that payment was voided in between, an unchecked
    // success message reports a batch that no longer holds the commissions.
    expect(markPaid).toContain("createdPaymentIds.push(assertRpcResult<string>(data, 'create_commission_payment'));");
    const check = markPaid.indexOf(".in('id', createdPaymentIds)");
    expect(check, 'nothing re-reads the payment rows this click points at').toBeGreaterThan(-1);
    expect(markPaid).toContain("from('commission_payments')");

    const successToast = markPaid.indexOf("toast('success'");
    expect(successToast, 'the success toast is missing').toBeGreaterThan(check);
    const guard = markPaid.indexOf('if (voidedCount > 0 || unverifiedCount > 0) {');
    expect(guard, 'the voided/unverified batch guard is missing').toBeGreaterThan(check);
    expect(guard).toBeLessThan(successToast);
    // The activity-feed entry has to sit on the same side of the guard as the
    // success toast, or a voided replay writes a "batch created" event anyway.
    expect(markPaid.indexOf("event: 'commission_payment_batch_created'")).toBeGreaterThan(guard);
  });

  it('keeps "voided" and "could not be read" apart', () => {
    // Round-6 finding. A batch that came back VOIDED is a proven reversal. A
    // batch that did not come back — because the read failed, or because the
    // row was not returned — proves nothing. Counting the second as a void
    // tells the admin a payout was reversed when it may be sitting there
    // perfectly intact, and an admin told that goes and pays it again.
    expect(markPaid).toContain("const voidedCount = createdPaymentIds.filter((id) => statusById.get(id) === 'voided').length;");
    expect(markPaid).toContain('const unverifiedCount = createdPaymentIds.filter((id) => !statusById.has(id)).length;');

    // A missing row must not fall into the voided bucket by default: the map
    // is keyed by the ids that actually came back, never pre-seeded.
    expect(markPaid).toContain('const statusById = new Map<string, string>();');
    expect(markPaid).toContain('if (r?.id) statusById.set(r.id, String(r.status ?? \'\'));');

    // A failed read is classified, not thrown — but it must still be reported,
    // or the only trace of a read that never worked is a vague warning.
    expect(markPaid, 'a failed status read must not abort into the catch block, which would blame the RPC')
      .not.toContain('if (statusError) throw new Error(statusError.message);');
    expect(markPaid).toContain("context: 'mark_commissions_paid_status_readback'");

    // …and the two counts must reach the admin as distinct sentences.
    expect(markPaid).toContain('since been voided, so those commissions are still unpaid');
    expect(markPaid).toContain('could not be read back just now');
  });

  it('admits when the list behind the recovery message is stale', () => {
    // Round-6 finding. Every uncertain-outcome message ends by sending the
    // admin to the commission list to decide what to do. If the refresh that
    // was supposed to make that list current failed, the page is showing the
    // state from BEFORE the click — so "check the list" points at stale money.
    expect(reports).toContain('const STALE_COMMISSION_LIST_NOTE');
    expect(markPaid).toContain('const listIsCurrent = await fetchCommissions();');
    expect(markPaid).toContain('${listIsCurrent ? \'\' : STALE_COMMISSION_LIST_NOTE}');
    // The refresh has to be able to say it failed, which means reporting a
    // boolean rather than swallowing the error.
    expect(reports).toContain('const fetchCommissions = useCallback(async (): Promise<boolean> => {');
    // Both failure branches carry the same admission.
    expect(refusalBranch).toContain('STALE_COMMISSION_LIST_NOTE');
    expect(genericBranch).toContain('STALE_COMMISSION_LIST_NOTE');
  });
});

describe('every payout call site supplies an idempotency key', () => {
  // Round-6 finding. The wrappers now REFUSE a missing key, but nothing in the
  // type system says so: src/types/supabase.ts is generated from the database,
  // where p_idempotency_key still carries a DEFAULT and so comes back optional.
  // A new caller that omits it compiles cleanly and fails at runtime, on the
  // money path. Hand-editing the generated file would not survive the next
  // `generate_typescript_types`, so the durable guard is this scan of the real
  // call sites.
  const sourceRoot = 'src';

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return sourceFiles(path);
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
      return [path];
    });
  }

  // The three wrapped RPCs. Reports' "mark paid" button is not a fourth RPC —
  // it calls create_commission_payment in a loop, and only its Sentry context
  // strings say mark_commissions_paid.
  const KEYED_RPCS = [
    'create_commission_payment',
    'post_commission_payment',
    'void_commission_payment',
  ];

  /**
   * Blanks comments so a commented-out `p_idempotency_key:` cannot satisfy the
   * assertions below, and so a commented-out `.rpc(` cannot pose as a call site.
   *
   * Quote-aware, because a naive stripper eats the rest of the line at the `//`
   * inside a URL literal. Every failure mode here DELETES text, and deleting
   * text can only make a required marker vanish or a call site disappear — both
   * of which turn the pinned-call-site list below red rather than green.
   */
  function blankComments(source: string): string {
    const out = source.split('');
    const blank = (from: number, to: number) => {
      for (let i = from; i < to && i < out.length; i += 1) if (out[i] !== '\n') out[i] = ' ';
    };
    let i = 0;
    while (i < source.length) {
      const c = source[i];
      if (c === '/' && source[i + 1] === '/') {
        let end = source.indexOf('\n', i);
        if (end === -1) end = source.length;
        blank(i, end);
        i = end;
      } else if (c === '/' && source[i + 1] === '*') {
        let end = source.indexOf('*/', i + 2);
        end = end === -1 ? source.length : end + 2;
        blank(i, end);
        i = end;
      } else if (c === "'" || c === '"' || c === '`') {
        let j = i + 1;
        while (j < source.length) {
          if (source[j] === '\\') { j += 2; continue; }
          if (source[j] === c) { j += 1; break; }
          if (c !== '`' && source[j] === '\n') break;
          j += 1;
        }
        i = j;
      } else {
        i += 1;
      }
    }
    return out.join('');
  }

  const sources = sourceFiles(sourceRoot).map((path) => ({
    path,
    code: blankComments(readFileSync(path, 'utf8').replace(/\r\n/g, '\n')),
  }));

  const callSites = sources.flatMap(({ path, code }) => {
    return KEYED_RPCS.flatMap((rpc) => {
      // Was the exact text `.rpc('name', {`, which five separate rewrites of the
      // same call would have slipped past: double quotes, a backtick, a newline
      // between the arguments, extra spacing, or a `as never` cast on the name
      // (which real call sites in this repo do carry — see FieldProfitability).
      // Any of those made a new caller invisible to this scan and therefore
      // silently exempt from it. The cast form allowed here is exactly the one
      // the literal-name test below allows, so a name spelled any other way
      // turns that test red rather than quietly dropping out of this one.
      const open = new RegExp(
        String.raw`\.rpc\(\s*(['"\x60])${rpc}\1\s*(?:as\s+[A-Za-z_][A-Za-z0-9_]*\s*)?,\s*\{`,
        'g',
      );
      const found: { path: string; rpc: string; args: string }[] = [];
      let match: RegExpExecArray | null;
      while ((match = open.exec(code)) !== null) {
        // Brace-matched rather than regexed to the next '}': the argument object
        // contains nested template literals and objects, and stopping at the
        // first '}' would truncate the very argument being looked for.
        let depth = 0;
        let i = match.index + match[0].length - 1;
        for (; i < code.length; i += 1) {
          if (code[i] === '{') depth += 1;
          else if (code[i] === '}') {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        found.push({ path, rpc, args: code.slice(match.index, i + 1) });
        open.lastIndex = i;
      }
      return found;
    });
  });

  it('finds the payout call sites at all', () => {
    // A scanner that matches nothing passes every assertion below it. Pin the
    // count so a rename that hides the call sites fails here instead of quietly
    // making this whole describe vacuous.
    expect(callSites.map((c) => `${c.path}:${c.rpc}`).sort()).toEqual([
      'src/pages/CommissionPayments.tsx:create_commission_payment',
      'src/pages/CommissionPayments.tsx:post_commission_payment',
      'src/pages/CommissionPayments.tsx:void_commission_payment',
      'src/pages/Reports.tsx:create_commission_payment',
    ]);
  });

  it('every .rpc() call in src names its RPC with a string literal', () => {
    // The remaining way past the scan above is to stop naming the RPC where a
    // scanner can see it — `supabase.rpc(name, args)` behind a helper. That is
    // already the house rule (assertRpcCoverage.test.ts depends on it too), so
    // pin it here as well: this scan is only as good as the guarantee that a
    // payout call cannot hide behind a computed name.
    // Round-8 finding: this used to look at the single character after `.rpc(`
    // and accept anything that opened a quote. `supabase.rpc('create_' + suffix,
    // args)` opens a quote, so it passed here — while being invisible to the
    // payout scan above, which needs the WHOLE name spelled out. The name has to
    // be a complete literal that ENDS the argument, so read to the closing quote
    // and require a ',' or ')' next.
    const computed: string[] = [];
    for (const { path, code } of sources) {
      const call = /\.rpc\(\s*/g;
      let match: RegExpExecArray | null;
      while ((match = call.exec(code)) !== null) {
        const open = match.index + match[0].length;
        const line = code.slice(0, match.index).split('\n').length;
        const reject = (why: string) => computed.push(`${path}:${line} (${why})`);
        const quote = code[open];
        if (quote !== "'" && quote !== '"' && quote !== '`') {
          reject('name is not a string literal');
          continue;
        }
        let j = open + 1;
        let closed = false;
        for (; j < code.length; j += 1) {
          if (code[j] === '\\') { j += 1; continue; }
          // `${…}` makes a backtick literal a computed name however it ends.
          if (quote === '`' && code[j] === '$' && code[j + 1] === '{') break;
          if (code[j] === quote) { closed = true; break; }
        }
        if (!closed) {
          reject('name is not a complete string literal');
          continue;
        }
        if (!/^[A-Za-z0-9_]+$/.test(code.slice(open + 1, j))) {
          reject('name is not a plain identifier');
          continue;
        }
        // A bare `as never` cast is allowed — the generated RPC types do not
        // know about migrations that have not shipped yet, so real call sites
        // carry one — but only in the exact form the payout scan above also
        // accepts. Anything else here (`+`, `.concat(`, a ternary, a generic
        // cast) means the literal is only PART of the name, or is spelled in a
        // way the payout scan cannot see, and both are the unsafe direction.
        const after = code.slice(j + 1);
        if (!/^\s*(?:as\s+[A-Za-z_][A-Za-z0-9_]*\s*)?[,)]/.test(after)) {
          reject('name is built from an expression');
        }
      }
    }
    expect(computed, 'an RPC named by a variable cannot be checked by this scan').toEqual([]);
  });

  it.each(KEYED_RPCS)('%s is never called without p_idempotency_key', (rpc) => {
    const sites = callSites.filter((c) => c.rpc === rpc);
    expect(sites.length, `no call sites found for ${rpc}`).toBeGreaterThan(0);
    for (const site of sites) {
      expect(site.args, `${site.path} calls ${rpc} without p_idempotency_key`).toContain(
        'p_idempotency_key:',
      );
      // …and not with a literal null/undefined, which the wrapper refuses just
      // as hard as an omitted argument.
      expect(site.args).not.toMatch(/p_idempotency_key:\s*(null|undefined)\b/);
    }
  });

  it('passes a key expression that is known to produce one', () => {
    // `not null/undefined` is all a text scan can prove on its own, and it does
    // not prove the value is USABLE: a variable that happens to be undefined at
    // runtime reads exactly like a good one here, and the generated types call
    // the argument optional so the compiler will not object either. So pin the
    // expressions themselves. Every one of these is a key minted by
    // generateIdempotencyKey (directly, or through useIdempotencyKey.getKey()),
    // and changing any of them has to come back through this list.
    const KEY_EXPRESSIONS = new Set([
      'createKey',
      'postKey',
      'voidKey',
      'entry.key',
    ]);
    for (const site of callSites) {
      const value = /p_idempotency_key:\s*([^,\n}]+)/.exec(site.args)?.[1]?.trim();
      expect(
        value && KEY_EXPRESSIONS.has(value),
        `${site.path} passes an unrecognised idempotency-key expression to ${site.rpc}: ${value}`,
      ).toBe(true);
    }
  });
});
