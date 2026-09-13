## 2026-09-13 - Reconcile Claude's invoice adversarial review

Claude CLI completed VERIFIED on `dd3ce212` / base `6c128a79`, Opus 5/high,
zero permission denials, with `FINAL_VERDICT: NEEDS-WORK`. No clean proof or
merge clearance was issued. Its HIGH was reproduced by the real disposable
public preview: BOTH prior-season job and blend invoices were refused at their
unchanged CURRENT_DATE. The earlier creation-only control missed that path.

Add a new migration, preserving all previous migration bytes, to permit each
existing invoice's unchanged stored date and unchanged-date restoration.
Retain immutable filed season, each-member filed-season pricing, NEW date/type
validation (including restoration), and split-group enforcement. Extend the
existing network-isolated PostgreSQL prover, not a new live test lane, with
both source creators, pricing, supported generic save, restoration, and later
date/season refusal. Corrected source/proof is not yet final-candidate clearance.

The two rendered regressions for unchanged divergent dates and the hidden
unsaved-changes prompt failed before their fixes. Keep the shared Stay/Leave
prompt in the loading state; do not clear dirty state to bypass navigation
protection. Map the three exact exhausted cutover refusals and generic field
creation refusal to plain-English guidance. Retain the identical retry key,
frozen payload, maximum three requests, and no transport/unknown-SQL replay.

The future actor-detector-name regression failed before binding on the row's
suspect_param shape; its corrected matcher passes 484 executable assertions
without widening any allowlist or changing unrelated data exceptions.

Clarify mandatory total database transaction quiescence for phase two. Recheck
the exact original recommendation/continuation exchange rather than treating
"continue 599" as an isolated quote. Preserve legitimate source-season creation;
no re-seasoning or changed business pricing policy is introduced.

All FOUR migrations remain UNAPPLIED. No live SQL/data changes, merge,
production rollout, or gate waiver occurred. Required final app checks, fresh
Sol/high and Claude CLI clearance, native PR provenance, current CI and actual
exact-head CodeRabbit APPROVED review remain required. Rollback before apply is
preserving/parking the candidate; a later apply needs separate Mason approval.
