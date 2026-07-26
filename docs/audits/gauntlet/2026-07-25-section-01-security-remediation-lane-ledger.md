# Section 1 Security Remediation Lane Ledger

Status: ROUND 2 SOL FIX REMEDIATION IMPLEMENTED LOCALLY — PENDING fresh exact-SHA Sol adversarial review, fresh read-only live predicate proof, and owner-approved guarded migration apply.

## Scope and non-interference boundary

- Worktree/branch: `codex/section1-security-hardening-20260725`, based on `25363345` / current `origin/main` at lane start.
- Owns only the Section 1 number-generator grant/role gates, `save_field` activity attribution, their invariant/smoke coverage, migration-history entry, and this ledger.
- Does not touch Supplier Pricing Phase 3 B1/B2 files, Product presentation/types/generated schema, Phase 3 plan documents, the dirty gauntlet index/summary, production, or live data.

## Delivered local artifacts

- `20260725234503_harden_section1_number_and_field_actor.sql`: six zero-argument number generators now require `AUTH_REQUIRED` plus their active allowed-role matrix; PUBLIC and anon execution are revoked and authenticated/service_role grants are explicit. `save_field` binds `auth.uid()`, rejects a non-null mismatched caller actor, and always writes the bound actor to `activity_feed`.
- `save-field-actor-binding.sql`: narrow standing predicate for the exact audited `save_field(uuid,jsonb,jsonb,uuid,text)` regression. It requires `v_actor=auth.uid()` before any write/idempotency action, the real `p_performed_by` mismatch guard before writes, and an `activity_feed.performed_by=v_actor` sink with no caller attribution. `save-field-actor-binding-predicate.test.mjs` proves token/comment-only and post-write-guard bodies still fail, then applies exact migration `20260725234503` and requires zero rows.
- `smoke-section1-number-and-field-actor.sql`: registered rollback-only proof of ACL/search-path/overload contracts; every advertised allowed role; active wrong-role and inactive otherwise-allowed denial; exact next-number output after valid current-format plus safely ignored malformed/out-of-scope fixtures; and `save_field` no-partial-write/truthful-actor/null-actor/replay behavior. It deliberately preserves captured generator bodies: the commission malformed fixture is other-year because its current LIKE-plus-cast body cannot safely parse a same-year malformed suffix.

## Gates and evidence

- Local source baseline: fresh Section 1 audit dated 2026-07-19 found six PUBLIC/anon number generators and a forgeable `save_field` activity actor.
- Sol exact-SHA review `a2e8cede`: FIX. Remediation closes its token-only predicate false-positive/false-negative concern and broadens the disposable smoke to all allowed roles, inactive allowed actors, and exact-number/malformed-fixture coverage without changing captured number-generation business bodies.
- Sol round-2 exact-SHA review `8b6c1ad2`: FIX. It rejected token-only `ACTOR_MISMATCH` acceptance and required proof of the actual actor guard, ordering, and sink attribution. This round-2 remediation is local pending a fresh exact-SHA review and read-only live predicate execution.
- Round-2 control correction: the generalized catalog parser still returned live false positives, so it was retired before acceptance. The replacement is intentionally scoped to the audited `save_field` signature and does not purport to classify unrelated PL/pgSQL actor patterns.
- Sol round-3 exact-SHA review `72b0837f`: FIX. The narrow predicate now strips multiline block comments, line comments, and quoted strings before every bind/guard/write/sink positional check. The disposable proof includes full fake bind-and-guard bodies in a block comment and in a dead string, plus a post-write guard; all remain violations before the exact migration and zero afterward (`SAVE_FIELD_ACTOR_BINDING_PREDICATE_TEST_PASS`).
- Sol round-4 exact-SHA review `8b7430c`: FIX. Cross-form dollar tokens can make lexical-regex acceptance erase executable text, so lexical acceptance was retired. The standing control now fails closed unless the exact signature exists with migration `20260725234503`'s reviewed PostgreSQL 17 `pg_proc.prosrc` SHA-256 (`10a53c6b4c218a3836b0a5269fc558cc214eb8741a2df6669133885919f50ff2`). Missing/drifted bodies violate and require fresh review plus an intentional pin update; comment/string dollar-token bracket attacks and altered secure bodies are regression fixtures.
- Sol-FIX local proof: `ACTOR_FORGERY_ACTIVITY_FEED_PREDICATE_TEST_PASS` and `SECTION1_NUMBER_AND_FIELD_ACTOR_PROOF_PASS`; `test:security` (10 files / 263 tests), focused `rpcContracts` (82 tests), and `check:docs` all PASS. The `test:security` live-DB layers remained correctly skipped; no live predicate or smoke is claimed.
- Root read-only live proof for the narrow replacement: PASS — pre-apply returned exactly `save_field(uuid, jsonb, jsonb, uuid, text)`. Post-apply expectation remains zero rows. The generalized actor-forgery predicate was retired as too brittle for live PL/pgSQL bodies; no live mutation, push, deploy, or apply occurred.
- Full local pipeline: PASS — typecheck; lint (0 errors / 3 pre-existing warnings); tests (286 files / 3,888 passed / 118 skipped); build; `test:agent-workflows`; schema baseline (`pending=47`); `check:docs`; and changed-only SQL audit (0 blockers / 0 highs).
- Exact migration-and-smoke disposable PostgreSQL 17 proof: PASS — `SECTION1_NUMBER_AND_FIELD_ACTOR_PROOF_PASS`.
- Trusted write-apply-proofs wrapper: completed despite the parent timeout and minted clean content-bound query hash `c3849f783ff30ddd7bba3a3e2f1b1b1268bf5da83cd2128c7c44aa4792939275`; both `migration-drift` and `rls-security` reviewers reported CLEAN (0 blocker / 0 high / 0 medium).
- Live/deployment state: migration `20260725234503` remains pending and not live. No push, deploy, or apply was performed.
- Remaining gate: fresh exact-SHA independent Sol adversarial review and fresh read-only live predicate proof of this remediation. After that, owner approval, guarded apply, the registered rollback-only smoke, and live invariant sweep remain required before acceptance.
