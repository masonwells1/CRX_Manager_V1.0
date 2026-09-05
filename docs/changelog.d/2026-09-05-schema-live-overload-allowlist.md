## 2026-09-05 — Fix the live schema-integrity overload check (both halves were failing)

`src/lib/schemaIntegrityLive.test.ts` carried a stale `KNOWN_OVERLOADED_FUNCTIONS` list. The known
report was that one test failed; checking live showed **two** of its tests fail the moment anyone
runs the suite with live credentials. It stays latent only because the live half sits behind
`describe.skipIf(!isLiveDB)`, `isLiveDB` is false without credentials, and no workflow runs
`test:schema-live`.

The list is read by **three** tests, not the two previously recorded:

| test | uses the list as | live credentials? |
| --- | --- | --- |
| `no public function has more than 1 overload` | allowlist — an in-scope overloaded function *missing* from it fails | yes |
| `known overloaded functions actually have overloads` | asserts each entry has `count(*) > 1` — a *stale* entry fails | yes |
| `known overloaded functions list is small (<=2 entries)` | caps its length | **no — always runs** |

### Defect 1 — the two listed names have no overloads

Live `pg_proc` has exactly one version of each: `next_invoice_number` (`pronargs` 1) and
`check_rate_limit` (`pronargs` 4). The second test asserts `toBeGreaterThan(1)` per entry, so it
failed on both. Its own error message prescribed the fix: remove them.

The comment above the list was also wrong on its own terms. It claimed `next_invoice_number` had a
"no-args version (column default) + type-aware version". `invoices.invoice_number` defaults to
`next_invoice_number('field_application'::text)`, which passes an argument, and migration
`20260526151856` dropped the zero-arg form.

### Defect 2 — not previously recorded: the first test was failing too

Live carries **8** overloaded functions in `public`, none of them listed:

```
__plpgsql_show_dependency_tb           plpgsql_coverage_statements
plpgsql_check_function                 plpgsql_profiler_function_statements_tb
plpgsql_check_function_tb              plpgsql_profiler_function_tb
plpgsql_coverage_branches              plpgsql_show_dependency_tb
```

All 8 are owned by the `plpgsql_check` extension (version 2.7, installed into `public`), 2 overloads
each. So `unexpected` was 8 and the first test failed as well.

### The fix, and why not the obvious one

The obvious fix — add all 8 to the list — is wrong. It would push the list to 8 entries, breaking the
`<=2` cap, and that cap is the one test that runs without credentials. More importantly the cap
encodes a real signal ("overloads should be rare"); padding it with extension functions destroys it.

Instead the 8 are excluded **at the query**, because they are not the drift this guard is for. The
guard exists to catch accidental overloads introduced by our own migrations — the bug class behind
40+ March 2026 issues. An extension's functions are never created by a migration and cannot be that
drift. `KNOWN_OVERLOADED_FUNCTIONS` is now empty, which is the correct live state, and stays
available for a genuine app exception.

### Proof

The live half cannot run here (it needs a service-role key this session does not handle), so both
predicates were evaluated directly against live `pg_proc` read-only:

```
test1_unexpected_must_be_0 : 0
test2_stale_must_be_0      : 0
live_overloaded_fns        : 8   (all extension-owned)
```

And the exclusion was mutation-checked so it cannot be a filter that silently disables the guard:

```
total public functions           : 634
excluded as extension-owned      :  24
STILL IN SCOPE after the filter  : 610
```

610 app functions remain checked. The offline suite passes: 74 passed, 78 skipped, and the `<=2` cap
is satisfied at 0. Typecheck clean.
