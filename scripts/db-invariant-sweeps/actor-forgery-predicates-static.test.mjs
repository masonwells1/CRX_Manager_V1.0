#!/usr/bin/env node
/**
 * Fast, Docker-free guard for the two actor-forgery sweep predicates.
 *
 * The disposable PostgreSQL proof (`actor-forgery-predicates.test.mjs`, run via
 * `npm run proof:actor-forgery`) is what actually exercises detection behaviour,
 * but it needs Docker and therefore cannot run in ordinary correction-guard CI.
 * The exact-SHA Codex review of c1beab619 raised that as a MEDIUM: a 750-line
 * regression suite wired into nothing means "the security detector can regress
 * without failing routine verification". Vitest only collects
 * `src/**` + `*.test.{ts,tsx}`, so a `.test.mjs` here is discovered by nothing.
 *
 * This guard closes that gap the way `save-field-actor-binding-static.test.mjs`
 * does for its migration: it pins the load-bearing ARMS of both predicates, so
 * deleting or weakening one fails CI on a machine with no Docker. It asserts
 * structure, never behaviour — behaviour stays the container proof's job.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'scripts', 'db-invariant-sweeps');
const GENERAL = path.join(DIR, 'predicates', 'actor-forgery.sql');
const FIN_AUDIT = path.join(DIR, 'predicates', 'actor-forgery-fin-audit.sql');
const CONTAINER_PROOF = path.join(DIR, 'actor-forgery-predicates.test.mjs');

// COMMENTS ARE STRIPPED BEFORE EVERY STRUCTURAL ASSERTION, and that is the whole
// point rather than tidiness. The first version of this guard tested the raw file
// text, so an assertion kept passing by matching a SQL comment that described a
// REJECTED earlier draft — the executable expression it claimed to pin no longer
// existed anywhere. Codex found it: "one raw match and zero executable-code
// matches". A guard that can be satisfied by its own documentation is worse than
// no guard, because it reports coverage it does not have.
const stripSqlComments = (text) => text.replace(/--[^\r\n]*/g, '');

const general = stripSqlComments(readFileSync(GENERAL, 'utf8'));
const finAudit = stripSqlComments(readFileSync(FIN_AUDIT, 'utf8'));
const proof = readFileSync(CONTAINER_PROOF, 'utf8');

// Each entry: [label, required regex, which files must contain it].
// The reason is stated so a future edit that removes one has to argue with a
// sentence rather than delete an anonymous assertion.
const REQUIRED = [
  [
    'refusal matched by SHAPE, not by the ACTOR_MISMATCH literal — live code uses four message spellings',
    /RAISE\\s\+EXCEPTION\\M\[\^;\]\*;/,
    [general, finAudit],
  ],
  [
    'null-tolerant refusal accepted (IS NOT NULL AND …), 10 live routines use it',
    /IS\\s\+NOT\\s\+NULL\\s\+AND/,
    [general, finAudit],
  ],
  [
    'the <> and != comparison spellings accepted alongside IS DISTINCT FROM',
    /<>\|!=/,
    [general, finAudit],
  ],
  [
    'DECLARE-initializer actor binding accepted alongside a separate assignment statement',
    /uuid\\M\\s\*\(\?:NOT\\s\+NULL\\s\*\)\?:=\\s\*auth/,
    [general, finAudit],
  ],
  [
    'raw-source fallback for a routine with no credited refusal — the lexer masks dynamic SQL, ' +
      'so EXECUTE … USING <actor> is invisible to every lexed arm',
    /pre_refusal_src IS NOT DISTINCT FROM executable_src/,
    [general, finAudit],
  ],
  [
    'USING correlation on raw source (Codex round 2: dynamic actor-dependent authorization)',
    /\\mUSING\\M\[\^;\]\{0,120\}/,
    [general],
  ],
  [
    'OFFSET 0 optimization fences — without them pre_refusal_src is recomputed per WHERE arm and the sweep times out on live',
    /OFFSET 0/,
    [general, finAudit],
  ],
  [
    'whitespace collapsed once in lexed — masked literals become equal-length runs that make the shape match backtrack',
    /regexp_replace\(l\.executable_src, '\\s\+', ' ', 'g'\)/,
    [general, finAudit],
  ],
];

for (const [label, pattern, files] of REQUIRED) {
  for (const file of files) {
    assert.ok(pattern.test(file), `actor-forgery predicate lost a load-bearing arm: ${label}`);
  }
}

// The dynamic-audit-sink arm lives only in the financial predicate. It restores
// coverage the lexer removed in PR #449 — a masked `EXECUTE 'INSERT INTO
// financial_audit_log …' USING p_performed_by` is invisible to every lexed arm.
assert.ok(
  /pre_refusal_src IS NOT DISTINCT FROM executable_src\s*\n?\s*AND raw_src ~\* \('financial_audit_log/
    .test(finAudit),
  'financial predicate lost the dynamic-audit-sink arm: a masked EXECUTE write into the ' +
    'immutable ledger would go unreported. NOTE the shape pinned here is the CURRENT one ' +
    '(no-credited-refusal gate); the earlier global-absence spelling was itself rejected as a HIGH',
);

// The operator arms must not regress to the set-returning form: `EXISTS (SELECT 1
// FROM regexp_matches(…, 'gi'))` enumerates every match before EXISTS can stop,
// which is what timed the sweep out against the live catalog.
//
// `general` and `finAudit` are already comment-stripped at read time.
for (const [name, text] of [['general', general], ['fin-audit', finAudit]]) {
  assert.ok(
    !/FROM regexp_matches\(/.test(text),
    `${name} predicate reintroduced set-returning regexp_matches in a boolean test — use ~*`,
  );
}

// Fixtures the container proof must keep. Naming them here means deleting a
// canary fails CI even when Docker is unavailable — a canary nothing enforces is
// the failure mode this whole change exists to leave behind.
const REQUIRED_FIXTURES = [
  // The four legitimate live guard styles — must NOT be reported.
  'actor_declare_init_refusal_forward',
  'actor_null_tolerant_refusal_forward',
  'actor_prose_message_refusal_forward',
  'actor_prefixed_message_refusal_forward',
  // Deny canaries for the loosening — must STILL be reported.
  'actor_notice_not_exception_forward',
  'actor_selfbound_declare_init_forward',
  'actor_null_tolerant_wrong_identity_forward',
  // Codex c1beab619 regressions.
  'actor_dynamic_audit_sink_only',
  'actor_text_cast_audit_forward',
  'actor_bare_inequality_forward',
  'actor_poisoned_local_before_refusal',
  // Codex round 2 on 39a3d817f: base coverage the rewrite had lost.
  'actor_text_role_lookup',
  'actor_visible_probe_plus_dynamic_write',
  'actor_dynamic_role_authorization',
];

// No type gate on candidacy. Two drafts narrowed it and both were rejected as
// HIGH false negatives; a gate built by enumerating the spellings of "is really
// an identity" reopens on the next spelling. Candidacy is the name pattern, full
// stop, exactly as the base predicate defines it.
for (const [name, text] of [['general', general], ['fin-audit', finAudit]]) {
  assert.ok(
    !/argtype = 'pg_catalog\.uuid'::regtype\s*\n?\s*OR/.test(text),
    `${name} predicate reintroduced a parameter-type gate on candidacy — every narrowing of ` +
      `this so far has been a HIGH false negative; suppress proven non-actors after sink ` +
      `analysis instead`,
  );
}

for (const fixture of REQUIRED_FIXTURES) {
  assert.ok(
    proof.includes(fixture),
    `container proof lost required fixture ${fixture} — an ALLOW pin or a DENY canary was deleted`,
  );
}

// The isolated dynamic-sink fixture must stay isolated. The pre-existing
// actor_dynamic_audit_sink_forward carries an unrelated forward_actor() call
// that satisfies the callable-forwarding arm, so it kept passing while the
// dynamic-sink hole was open. If actor_dynamic_audit_sink_only ever gains a
// second statement it stops proving anything.
const isolated = proof.match(
  /CREATE FUNCTION public\.actor_dynamic_audit_sink_only[\s\S]*?\$body\$;/,
);
assert.ok(isolated, 'actor_dynamic_audit_sink_only fixture is missing');
assert.ok(
  !/forward_actor/.test(isolated[0]),
  'actor_dynamic_audit_sink_only gained a forwarding call — it would then pass via the ' +
    'callable arm and stop proving dynamic-sink detection',
);

console.log('ACTOR_FORGERY_PREDICATES_STATIC_TEST_PASS');
