# Section 15 Refresh — Documentation Drift

Date: 2026-07-28  
Audit baseline: `origin/main` / `bf0cbced`  
Publication baseline: `origin/main` / `68b47bf4`  
Mode: read-only repository, generated-map, migration-index, schema-registry, and live-ledger inspection

## Verdict

**FOLLOW-UP REQUIRED — 0 BLOCKER / 0 HIGH / 0 MED / 1 LOW**

## Resolved During Refresh — Migration history index

The audit initially found that `docs/reference/migration-history.md` omitted:

`20260728193000_revoke_anon_execute_non_policy_functions.sql`

PR #263 then landed on `origin/main` as `d64c6926` while this refresh was open. Its authoritative migration-history update indexes both `20260728193000` and the newly merged `20260728193100_revoke_anon_execute_rls_role_helpers.sql`. The isolated audit branch was subsequently fast-forwarded through `68b47bf4`; `npm run check:docs` now passes with 834 migration files and 834 indexed.

## LOW — Workflow-map narrative is stale

The generated route analysis now shows five intentional redirect-only “orphans,” while the hand-maintained narrative still describes an older set of three actionable issues. The generated map itself is reproducible and unchanged by `npm run generate-map`; the prose interpretation needs refresh or the detector needs a redirect category.

## Verified Safe

- `AGENTS.md` and `CLAUDE.md` remain lean and synchronized with deterministic guidance checks.
- Agent workflow adapters and hook manifests pass their parity tests.
- Migration-history sequence and completeness, pages/routes, hooks, and manual-doc freshness checks pass.
- Live migration ledger contains 916 entries; latest observed live entry was version `20260728182141`, name `20260728123224_secdef_pricing_reads_office_only`.
- The newer disk migration was not applied or changed during this read-only audit.

## Limitations

The live-versus-disk high-water difference is recorded, not classified as a deployment defect: a merged migration may be intentionally awaiting its governed apply. No migration or live data was changed.

## Recommended Next Action

No migration-history work remains. Improve the workflow-map redirect classification when touching that generator.
