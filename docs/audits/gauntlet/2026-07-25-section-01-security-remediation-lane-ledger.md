# Section 1 Security Remediation Lane Ledger

Status: SOL FIX REMEDIATION IMPLEMENTED LOCALLY — PENDING fresh independent exact-SHA Sol adversarial review and owner-approved guarded migration apply.

## Scope and non-interference boundary

- Worktree/branch: `codex/section1-security-hardening-20260725`, based on `25363345` / current `origin/main` at lane start.
- Owns only the Section 1 number-generator grant/role gates, `save_field` activity attribution, their invariant/smoke coverage, migration-history entry, and this ledger.
- Does not touch Supplier Pricing Phase 3 B1/B2 files, Product presentation/types/generated schema, Phase 3 plan documents, the dirty gauntlet index/summary, production, or live data.

## Delivered local artifacts

- `20260725234503_harden_section1_number_and_field_actor.sql`: six zero-argument number generators now require `AUTH_REQUIRED` plus their active allowed-role matrix; PUBLIC and anon execution are revoked and authenticated/service_role grants are explicit. `save_field` binds `auth.uid()`, rejects a non-null mismatched caller actor, and always writes the bound actor to `activity_feed`.
- `actor-forgery-activity-feed.sql`: zero-tolerance live-catalog predicate for authenticated SECURITY DEFINER functions that accept actor-shaped parameters and write `activity_feed.performed_by` without either the established canonical `ACTOR_MISMATCH` guard or a semantic `auth.uid()`-bound noncanonical mismatch guard. `actor-forgery-activity-feed-predicate.test.mjs` proves canonical-safe, noncanonical-semantic-safe, and unsafe fixtures; its pre-apply fixture returns only unsafe `save_field`, while production pre-apply is expected to return exactly current unsafe `save_field` until migration `20260725234503` applies.
- `smoke-section1-number-and-field-actor.sql`: registered rollback-only proof of ACL/search-path/overload contracts; every advertised allowed role; active wrong-role and inactive otherwise-allowed denial; exact next-number output after valid current-format plus safely ignored malformed/out-of-scope fixtures; and `save_field` no-partial-write/truthful-actor/null-actor/replay behavior. It deliberately preserves captured generator bodies: the commission malformed fixture is other-year because its current LIKE-plus-cast body cannot safely parse a same-year malformed suffix.

## Gates and evidence

- Local source baseline: fresh Section 1 audit dated 2026-07-19 found six PUBLIC/anon number generators and a forgeable `save_field` activity actor.
- Sol exact-SHA review `a2e8cede`: FIX. Remediation closes its token-only predicate false-positive/false-negative concern and broadens the disposable smoke to all allowed roles, inactive allowed actors, and exact-number/malformed-fixture coverage without changing captured number-generation business bodies.
- Sol-FIX local proof: `ACTOR_FORGERY_ACTIVITY_FEED_PREDICATE_TEST_PASS` and `SECTION1_NUMBER_AND_FIELD_ACTOR_PROOF_PASS`; `test:security` (10 files / 263 tests), focused `rpcContracts` (82 tests), and `check:docs` all PASS. The `test:security` live-DB layers remained correctly skipped; no live predicate or smoke is claimed.
- Root read-only exact live predicate rerun after the semantic matcher correction: PASS for the intended pre-apply contract — exactly one row, `save_field(uuid, jsonb, jsonb, uuid, text)`; the eight known safe noncanonical functions are excluded. Expected post-apply result is zero rows. No live mutation, push, deploy, or apply occurred.
- Full local pipeline: PASS — typecheck; lint (0 errors / 3 pre-existing warnings); tests (286 files / 3,888 passed / 118 skipped); build; `test:agent-workflows`; schema baseline (`pending=47`); `check:docs`; and changed-only SQL audit (0 blockers / 0 highs).
- Exact migration-and-smoke disposable PostgreSQL 17 proof: PASS — `SECTION1_NUMBER_AND_FIELD_ACTOR_PROOF_PASS`.
- Trusted write-apply-proofs wrapper: completed despite the parent timeout and minted clean content-bound query hash `c3849f783ff30ddd7bba3a3e2f1b1b1268bf5da83cd2128c7c44aa4792939275`; both `migration-drift` and `rls-security` reviewers reported CLEAN (0 blocker / 0 high / 0 medium).
- Live/deployment state: migration `20260725234503` remains pending and not live. No push, deploy, or apply was performed.
- Remaining gate: fresh exact-SHA independent Sol adversarial review of this remediation. After that, owner approval, guarded apply, the registered rollback-only smoke, and live invariant sweep remain required before acceptance.
