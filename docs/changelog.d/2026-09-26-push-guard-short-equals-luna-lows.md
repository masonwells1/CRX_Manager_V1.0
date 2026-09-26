## 2026-09-26 - push guard: report `-q=o`'s stray `=` like git does; drop an unread field

Follow-up to `2026-09-23-push-guard-bundled-short-option-cluster.md`, on the same branch, after
merging current `main` (the GPT-6 review routing, #796/#797).

The first `gpt-6-luna` xhigh review round on the merged head returned two LOW findings and no
BLOCKER, HIGH or MED. Both were accurate and both are fixed:

- **`unknownPushOptions` missed the `=` in a boolean short.** For `git push -q=o <repo> HEAD:main`
  git refuses the command (``error: unknown switch `='``, measured 2026-09-24), but the guard
  scanned only the `-q` before the `=` and reported nothing unknown. Not a bypass — git refuses
  before pushing — but the guard's option set disagreed with git's. With no value-taking letter
  in the word, the scan now covers the whole word, so `-=` is reported and the guard refuses,
  matching git. `-o=ci.skip` is unaffected: the cluster walk still reads it as an attached value.
- **`pushShortCluster` returned `letter` and `value` that no caller read**, and `value` was empty
  for a detached `-o ci.skip`, which made it misleading as well as dead. It now returns only
  `index` and `attached`.

### Proof — the real hook process, current `main` vs this branch

The scratchpad probe from the original entry, re-pointed so its base hook tree is `origin/main`
after the merge, now runs 19 cases. Every verdict matches expectation and three differ from main:

| case | main | branch |
|---|---|---|
| `-ou <CRX URL> HEAD:main` (repo whose own remotes are unrelated) | **ALLOWED** | **DENIED** |
| `-oci.skip origin HEAD:feature` (app repo) | DENIED (over-refusal) | ALLOWED |
| `-q=o origin HEAD:feature` (app repo) | ALLOWED | DENIED — a command git itself refuses |

`-q=o <CRX URL> HEAD:main` is denied on both. `codex-push-lib.test.mjs` gained two assertions
(`-q=o` reports `-=`; `-o=ci.skip` reports nothing). `npm run test:correction-guards` and
`npm run test:agent-workflows` pass.
