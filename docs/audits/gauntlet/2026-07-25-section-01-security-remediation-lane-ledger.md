# Section 1 Security Remediation Lane Ledger

Status: IMPLEMENTED LOCALLY — REVIEW WRAPPER CLEAN; PENDING independent exact-SHA Sol adversarial review and owner-approved guarded migration apply.

## Scope and non-interference boundary

- Worktree/branch: `codex/section1-security-hardening-20260725`, based on `25363345` / current `origin/main` at lane start.
- Owns only the Section 1 number-generator grant/role gates, `save_field` activity attribution, their invariant/smoke coverage, migration-history entry, and this ledger.
- Does not touch Supplier Pricing Phase 3 B1/B2 files, Product presentation/types/generated schema, Phase 3 plan documents, the dirty gauntlet index/summary, production, or live data.

## Delivered local artifacts

- `20260725234503_harden_section1_number_and_field_actor.sql`: six zero-argument number generators now require `AUTH_REQUIRED` plus their active allowed-role matrix; PUBLIC and anon execution are revoked and authenticated/service_role grants are explicit. `save_field` binds `auth.uid()`, rejects a non-null mismatched caller actor, and always writes the bound actor to `activity_feed`.
- `actor-forgery-activity-feed.sql`: zero-tolerance live-catalog predicate for authenticated SECURITY DEFINER functions that accept actor-shaped parameters and write `activity_feed.performed_by` without `ACTOR_MISMATCH`.
- `smoke-section1-number-and-field-actor.sql`: registered rollback-only proof of ACL/search-path/overload contracts, number role gates, and `save_field` no-partial-write/truthful-actor/null-actor/replay behavior.

## Gates and evidence

- Local source baseline: fresh Section 1 audit dated 2026-07-19 found six PUBLIC/anon number generators and a forgeable `save_field` activity actor.
- Full local pipeline: PASS — typecheck; lint (0 errors / 3 pre-existing warnings); tests (286 files / 3,888 passed / 118 skipped); build; `test:agent-workflows`; schema baseline (`pending=47`); `check:docs`; and changed-only SQL audit (0 blockers / 0 highs).
- Exact migration-and-smoke disposable PostgreSQL 17 proof: PASS — `SECTION1_NUMBER_AND_FIELD_ACTOR_PROOF_PASS`.
- Trusted write-apply-proofs wrapper: completed despite the parent timeout and minted clean content-bound query hash `c3849f783ff30ddd7bba3a3e2f1b1b1268bf5da83cd2128c7c44aa4792939275`; both `migration-drift` and `rls-security` reviewers reported CLEAN (0 blocker / 0 high / 0 medium).
- Live/deployment state: migration `20260725234503` remains pending and not live. No push, deploy, or apply was performed.
- Remaining gate: fresh exact-SHA independent Sol adversarial review. After that, owner approval, guarded apply, the registered rollback-only smoke, and live invariant sweep remain required before acceptance.
