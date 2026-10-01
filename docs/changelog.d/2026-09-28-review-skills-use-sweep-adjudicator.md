## 2026-09-28 - review skills route live sweeps through the adjudicator

Codex on the field-season delivery PR (#838) found that the `codex-review` and
`codex-cross-review` skills still told agents to classify Supabase MCP sweep rows against
`scripts/db-invariant-sweeps/allowlist.json` by hand. The release commands (`ship`,
`codex-gauntlet`, `preflight`) already required `run-sweeps.mjs --adjudicate`, so a review
launched through either skill skipped the `suspect_param` and `function_contracts` checks: an
actor function whose body, owner, dependency or grants had drifted could keep its violation key
and be reported clean.

Both skills now capture each `sweep_result` packet (`predicate`, `rows`, `function_contracts`)
and run `node scripts/db-invariant-sweeps/run-sweeps.mjs --adjudicate <capture.json>`, and they
refuse key-only allowlisting. `scripts/sync-agent-workflows.test.mjs` applies the release
commands' adjudication contract and its semantic-reversal mutations to both skills; it fails on
each old skill text and passes on the new one. The `.agents/` mirrors were regenerated with
`node scripts/sync-agent-workflows.mjs --write`.
