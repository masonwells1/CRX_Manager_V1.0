## 2026-09-03 — CI migration hard rules honor the `rls-check: exempt` marker (follow-up to the same-day CI checks entry)

While proving the new `scripts/check-migration-hard-rules.mjs` on a live PR
run, the local `.claude/hooks/rls-on-new-tables.mjs` hook refused to write the
no-RLS canary migration. That hook honors one documented exemption, a
`-- rls-check: exempt` comment, used once in 900 migrations for a counter
table reached only through a SECURITY DEFINER RPC. The CI check did not, so
the two layers would have disagreed on a legitimately exempt system table.

### Changed

- The CI RLS rule now honors the same marker. An exempt file is never silent:
  the check prints a warning naming the file and the table so the written
  reason gets reviewed by CodeRabbit and by whoever merges.
- The marker regex requires the exact word. The hook's own pattern,
  `/rls-check:\s*exempt/`, also matches `-- rls-check: exemption requested`;
  the DENY canary in the test file caught that on the first run, and the CI
  copy uses `exempt\b`. The local hook is unchanged here.
- `--audit-all` now reports how many files carry the marker (currently 1; the
  historical would-fail count drops from 2 to 1 because that file is exempt).
- The temporary Edge Function comment that proved the Deno steps run in CI is
  reverted in the same commit.

### Proof observed

- `node scripts/check-migration-hard-rules.test.mjs`: 66 assertions across 15
  throwaway-repository scenarios, including the marker pass, the misspelled
  marker DENY canary, and a marker outside a `--` comment DENY canary.
- `npm run check:migration-hard-rules` over 900 migrations: 1 would-fail
  file (2026-02-21 rate limiting, RLS but no policy), 1 exempt.
- Diff check across the last 60 commits on `main`: PASS.

### Not verified

- The hard-rules check going red on a live CI run. The local hook blocks
  writing such a migration from a Claude session (that is the hook working);
  the red path is proven by the checker's end-to-end tests, which execute the
  real script against throwaway git repositories and assert exit code 1.
