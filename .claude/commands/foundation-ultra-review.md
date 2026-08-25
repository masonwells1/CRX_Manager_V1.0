Run the **foundation ultra review** — an orchestrated, read-only, dynamic multi-agent audit of the layers no other tool checks: live-data integrity, disk-vs-live drift, edge-function bundle drift, deferred-ledger reconciliation, frontend runtime safety, and authorization & exposure surface.

It is **read-only**: it analyzes and writes ONE report file. It does not edit code, apply migrations, deploy, or commit.

## The single source of truth

The full, canonical instructions live in **`docs/audits/foundation-ultra-review-prompt.md`** — read that file and execute it exactly. Do NOT paraphrase or duplicate its steps here (a second copy would drift).

In summary, that prompt runs **5 phases**:

0. **Recon** — risk-weight the targets from git delta, advisors, migration/edge-function version parity, and the deferred ledger.
1. **Parallel fan-out** — 6 read-only agents (A: live-data invariant probes · B: disk-vs-live function/constraint drift · C: deployed-vs-repo edge bundles · D: deferred-claim verification · E: frontend route-guard/error-path safety · F: authorization & exposure surface — anon/PUBLIC read grants, RLS read-policies, Storage buckets, pg_cron) + delta-scoped standing reviewers, all in ONE message.
2. **Dynamic escalation** — findings spawn targeted deep-dives (data anomaly → causal trace; drift → blast radius; undeployed guard → exposure check). Max 2 waves.
3. **Adversarial verification gate** — every BLOCKER/HIGH must survive an independent refutation attempt before it reaches the report.
4. **Synthesis** — ONE dated report: `docs/audits/<YYYY-MM-DD>-foundation-ultra-review.md` (real clock — never fabricate), including the refuted appendix and the reconciled deferred ledger.

## Hard rules (from the prompt)

- **Read-only.** SELECT-only SQL. No `Edit`/`Write` except the one report file. No `apply_migration`, no `deploy_edge_function`, no `git commit` inside the audit itself.
- **A clean / "SOLID" result is valid** — do not manufacture findings.
- **Stay in lane.** Workflow correctness is `/review-workflow`; fragility is `/architecture-weakness-audit`; map consistency is `/map-drift-audit`. Recommend them if stale; don't re-run them inline.

## After the report

Give Mason a 5-line summary — verdict, counts by severity, the single most dangerous finding (or "solid"), whether anything blocks feature work, and the next step — and remind him nothing was changed (read-only). Actionable findings get remediated via `/ship` one at a time, with a `/codex-review` run for the batch (`/codex-cross-review` is the paste-doc fallback only when the Codex CLI is broken).
