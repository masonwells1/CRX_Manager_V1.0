## 2026-09-02 — an imported guard module was editable while the guard importing it was not

Found by the exact-SHA `gpt-5.6-sol` review of PR #563's own head
(`VERDICT: BLOCKED`, one HIGH). The PR added
`.claude/hooks/codex-bot-review-lib.mjs` and wired it into both merge guards —
but never added it to the protected-harness list.

**Files:** `.codex/hooks/production-action-guard.mjs`, `.codex/hooks/production-action-guard.test.mjs`, `scripts/apply-live-testdata-maintenance-20260812.mjs`, `docs/changelog.d/2026-09-02-codex-guard-app-check-was-unreachable.md`

### HIGH — the hole

`PROTECTED_HARNESS_SOURCE` listed `codex-push-lib.mjs`, `review-proof-guard.mjs`
and friends, but not the new module. Codex demonstrated the asymmetry directly:
an `apply_patch` targeting `codex-bot-review-lib.mjs` returned `blocked:false`,
while the identical patch against `production-action-guard.mjs` returned
`blocked:true`.

That gap matters far more than the feature it was attached to. Both merge guards
**import the module at startup**, so it runs before the guard has seen a single
byte of input. An allowed edit could keep every export intact — satisfying any
shape check — while terminating or subverting the hook during import. Silent
completion is read as ALLOW, so the blast radius is **every production-action
restriction**, not just the Codex App review check.

It is in `codex-push-lib`'s trust class and is now listed alongside it.

### Regression coverage

Protection is asserted on every write channel rather than the one Codex used:
all four file tools (`Write`, `Edit`, `NotebookEdit`, `apply_patch`), three path
spellings (backslashes, `./` prefix, uppercase), the shell write path, and the
push path.

One deliberate **negative** test keeps the fix honest: the module's *test* file
must stay editable. Nothing imports it at runtime, so it is not guard-critical,
and a blanket ban on `.claude/hooks/**` would have passed every positive
assertion above while quietly locking the directory.

### MEDIUM — contradictory policy documentation

The PR's earlier changelog asserted that main's required approval still exists
and is merely admin-bypassed. Canonical `AGENTS.md` says the opposite — removed,
with the surviving sub-resource treated as phantom state. Two documents making
opposite claims about a production merge control is worse than either one being
wrong.

That entry now reports both readings as readings, defers to `AGENTS.md` as
canonical, and records the disagreement as **unresolved**, naming the test that
would actually settle it: whether a **non-admin** merge is refused. Three
sessions have now reached three answers from three different endpoints, which is
a withdraw-the-claim situation rather than a pick-your-endpoint one.

### Verification

- `production-action-guard.test.mjs` green with the new cases; removing the
  module from `PROTECTED_HARNESS_SOURCE` turns them red.
- `test:correction-guards` and `test:agent-workflows` green.
- Codex guard protected-blob pins re-pinned (input `70430875…`, output
  `ceb77bd0…`).
