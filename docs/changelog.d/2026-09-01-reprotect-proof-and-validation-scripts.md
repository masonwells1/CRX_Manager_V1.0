## 2026-09-01 — the proof-minting and validation scripts go back into the guarded set

Closes the one outstanding CodeRabbit finding on PR #530, which asked that Bash not be able to modify
"protected hooks, manifests, configuration, workflows, or **validation/proof scripts**". Everything
in that list was covered except the last item, because those paths were narrowed out earlier the same
day.

**Why the narrowing was right for some paths and wrong for these.** Dropping `package.json` and
`package-lock.json` fixed real breakage — an unresolvable merge conflict and every `npm install`.
Dropping the scripts bought nothing comparable, and the exposure is worse than it looked:

- `scripts/write-codex-push-proof.mjs` mints the exact-SHA Codex approval proof.
- `scripts/run-claude-review.mjs` mints the Claude review proof.
- `scripts/remove-applied-ledger-entry.mjs` clears the C3 uncontained-apply alarm.

A shell write to any of those lets the thing being certified rewrite its own certifier. The
`check|validate|verify-*` scripts matter for a second reason: **CI runs the branch's own copies**, so
a rewritten validator passes CI as well as the local gate.

Back in the guarded set: `scripts/(check|validate|verify)-*`, `write-codex-push-proof.mjs`,
`run-claude-review.mjs`, `remove-applied-ledger-entry.mjs`, `agent-manifest-parity.mjs`,
`sync-agent-workflows.mjs`. **`package.json` and `package-lock.json` stay out** — that part of the
narrowing was correct and is not being reversed.

Friction stays near zero because the allowlist judges the command, not the path: RUNNING these
scripts (`node scripts/verify-deps.mjs`), reading them, and staging them are all still allowed. Only
a shell WRITE is refused, and a deliberate change still goes through `Edit`/`Write` under the `ask`
tier. Tests pin both directions, including `npm run verify-deps`, whose script NAME resembles a
guarded path but is not one.

Verified live against the real hook, not only in tests: `cp /dev/null
scripts/write-codex-push-proof.mjs` is refused, while `node scripts/agent-manifest-parity.mjs` runs
and reads still reach the filesystem.
