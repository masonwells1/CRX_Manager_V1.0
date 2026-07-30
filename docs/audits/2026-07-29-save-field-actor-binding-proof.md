# save_field Actor-Binding Proof

Status: **APPLIED LIVE AND VERIFIED**

## Scope

Migration `20260729222311_bind_save_field_actor.sql` changes only the existing
five-argument `public.save_field` body and its explicit grants. It does not
change the signature, frontend call sites, field or billing-default schema,
idempotency operation, return type, or Supplier Pricing files.

This migration supersedes only the `save_field` half of the older parked
Section 1 branch `codex/section1-security-hardening-20260725`. That branch's
combined `20260725234503_harden_section1_number_and_field_actor.sql` and
duplicate actor-binding predicate files must be narrowed before rebase or
apply; only its number-generator hardening remains open. Applying the old
combined function replacement would overwrite the reviewed live body and make
the standing hash-pinned invariant fail closed. The gauntlet index, protected-
PR readiness packet, and changelog record that reconciliation.

## Live preflight

Read-only catalog inspection on 2026-07-29 found:

- one overload: `save_field(uuid,jsonb,jsonb,uuid,text)`;
- `SECURITY DEFINER` with `search_path=public, pg_temp`;
- execution for `authenticated` and `service_role`, not anon;
- an active role gate through `require_admin_or_sales_rep()`;
- caller-supplied `p_performed_by` written directly to `activity_feed`;
- initial live migration high-water `20260729163243`;
- refreshed high-water `20260729213733` after Supplier Pricing applied during
  review; the local file was renamed from `20260729213523` to
  `20260729220000` with its SQL body unchanged;
- production assigned `20260729222311` at apply; the disk file was B7-renamed
  again with its SQL bytes unchanged.

## Intended invariant

- No authenticated user can attribute a field save to another profile.
- Authentication and mismatch checks occur before replay lookup or writes.
- Existing callers that pass `NULL` remain compatible and are attributed to
  the authenticated user.
- Passing `NULL` now intentionally records the signed-in user instead of a
  nullable caller value; that attribution correction is the only write-output
  delta.
- The existing `service_role` EXECUTE grant is retained for ACL compatibility,
  but a direct service-role call without a user JWT now fails `AUTH_REQUIRED`;
  no current application caller uses that unsupported shape.
- A replay returns the original field and does not duplicate field/activity
  rows.
- Any drift from the independently reviewed function body fails the standing
  database predicate, and a Docker-free correction guard keeps the shipped
  migration body synchronized with that predicate in ordinary CI.

## Proof ledger

| Proof | Result |
|---|---|
| Graphify refresh + targeted `save_field` queries | PASS — historical migration edge found; current UI call sites verified directly |
| Automatic body-fingerprint correction guard | PASS — checked-in migration body matches the standing predicate; cosmetic drift fails closed without Docker |
| Disposable PostgreSQL 17 body-fingerprint predicate | PASS — unsafe and altered bodies fail; exact migration returns zero violations |
| Disposable PostgreSQL 17 rollback behavior smoke | PASS — production same-actor call and replay, NULL compatibility, rejection paths, and truthful attribution; `SAVE_FIELD_ACTOR_BINDING_PROOF_PASS` |
| Changed-only SQL audit | PASS — 0 violations, 0 warnings |
| Repository verification | PASS — docs, 229 drift tests, typecheck, lint, 4,009 full tests, production build, and agent workflow guards |
| Live invariant sweep | PASS WITH EXPECTED FAIL-FIRST — 19 predicates clean after documented allowlists; only `save-field-actor-binding` returns the intended pre-fix violation |
| Live rollback smoke before apply | EXPECTED FAIL-FIRST — current body lacks `AUTH_REQUIRED`; transaction rollback confirmed zero smoke customers and fields |
| Fresh RLS-security review (`gpt-5.6-sol`) | CLEAN — 0 BLOCKER/HIGH/MED |
| Fresh migration-drift review (`gpt-5.6-sol`) | CLEAN — 0 BLOCKER/HIGH/MED; filename is above live high-water `20260729213733` |
| Governed proof binding | CLEAN — exact SQL query hash `49ec7ef286dbfd028a07979c63aacd4f21f368f4901b29369ec31986746dc4e7` |
| Governed live apply | PASS — Supabase accepted `bind_save_field_actor`; ledger assigned `20260729222311` |
| Live catalog contract | PASS — one overload, reviewed body hash, fixed search path, anon denied, authenticated/service-role allowed |
| Rollback-only live smoke | PASS — terminal `SMOKE_PASS_ROLLBACK`; zero smoke rows remained |
| Post-apply standing invariants | PASS — all 20 predicates have zero unallowlisted violations |
| Supabase advisors | PASS FOR THIS DELTA — expected authenticated-SECDEF warning only; no `save_field` performance finding |

## Production state

Migration `20260729222311_bind_save_field_actor` is live. No existing business
row was rewritten, and the rollback smoke left zero fixtures. Future field
saves reject forged actor IDs and attribute activity to the signed-in profile.
