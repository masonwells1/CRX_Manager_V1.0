## 2026-09-26 - autonomous landing: keep the "edit to an applied migration" CodeRabbit check blocking

**Sol HIGH, round 4 on PR #804.** The PR had turned CodeRabbit's pre-merge check "Edit to an
already-applied migration" from `error` into `warning`, leaning on the required CI check
`scripts/check-migration-hard-rules.mjs` as the hard gate. Sol showed that CI check reads the applied
boundary from `.claude/schema-registry.json`, which can lag a live apply (this repository's registry
was last generated 2026-09-20 while migrations applied on 2026-09-21 and 2026-09-22). During such a lag
an applied migration sits "above the boundary", so a later PR could edit it with green CI and only a
CodeRabbit warning — and under the autonomous-landing rule migrations are applied before their PR
merges, which makes that window routine rather than rare.

The check is restored to `error`, and the `supabase/migrations/**` path instruction flags edits to
applied migrations again. The trade-off is the original annoyance: a false positive on a parked,
never-applied draft still needs Mason's "Ignore failed checks" override in the walkthrough. Item B of
the landing plan stays **deferred** until a required check can prove from current ledger evidence that
a migration never ran.
