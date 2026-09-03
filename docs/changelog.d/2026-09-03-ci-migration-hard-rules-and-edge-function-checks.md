## 2026-09-03 — CI: deterministic migration hard rules, Edge Function checks, zero-warning lint

Mason asked for a review of the GitHub checks every PR gets, with the brief
"catch what we can without over-engineering or clamping down". The review found
the pipeline already strong (lint, typecheck, 347 unit-test files with ratcheted
coverage floors, SQL anti-pattern audit, dependency audit, CodeQL, secret
scanning, CodeRabbit hard-rule checks). Four gaps were approved and closed here.

### 1. Two CRX Hard Rules now have a deterministic CI check

`scripts/check-migration-hard-rules.mjs` runs inside the required
**SQL Migration Validation** job on every PR and push. It enforces:

- **Never edit an applied migration.** Any migration that exists at the PR's
  merge-base and is not newer than the applied high-water mark in the BASE
  tree's `.claude/schema-registry.json` may not be modified, deleted, or
  renamed. A migration newer than the high-water mark is in the pending band
  (landed on `main`, nothing newer applied yet) and may still be revised; the
  check prints a notice. The registry is read from the base tree so a PR cannot
  widen the band by editing it. If the registry cannot be read, every base
  migration is treated as applied (fail closed).
- **New tables carry RLS and a policy in the same file.** Every non-temporary
  `CREATE TABLE` in an added migration must have a matching
  `ALTER TABLE … ENABLE ROW LEVEL SECURITY` and at least one
  `CREATE POLICY … ON <table>` in that file. Names compare lowercase, unquoted,
  schema-qualified. The same `-- rls-check: exempt` marker the local
  `rls-on-new-tables` hook honors is honored here (one use in 900 migrations),
  and an exempt file is printed as a warning so the reason gets reviewed.

Until now both rules were enforced only by CodeRabbit (an AI reviewer whose
failed checks the author can override) and by local Claude hooks that fire only
when Claude is the writer.

**Why the registry's `applied_migration_names` list is NOT used:** measured on
2026-09-03, it matched only 252 of the 900 migration files on disk by name, so
membership proves nothing in either direction. The high-water version is the
only field that maps cleanly.

**Owner escape, deliberately narrow:** if a genuinely unapplied migration older
than the high-water mark must be changed (the renumber-a-wedged-migration case),
this check goes red. That is an owner call: Mason writes the reason in the PR
and merges it himself. No agent may use an admin merge; there is no label or
allowlist bypass.

### 2. Edge Functions are type-checked and tested when they change

Two Deno test files (EPA lookup, blend-ticket guards; 22 tests) existed but
nothing ran them, and no step type-checked `supabase/functions/`. The main CI
job now detects changes under `supabase/functions/` against the merge-base and,
only then, installs Deno and runs `deno check` on every function entry point
plus `deno test`. The `--node-modules-dir=none` flag is required because the
repo root has a `package.json`, which otherwise makes Deno look for `npm:`
packages in `node_modules`. When nothing changed the steps are skipped
(visibly, not passed vacuously).

### 3. Lint warnings now fail the build

`npm run lint` gained `--max-warnings=0`. Verified before the change: the
current tree produces zero warnings, so nothing goes red today; this stops
accessibility and console warnings accumulating silently.

### 4. Orphan test wired

`scripts/apply-live-testdata-maintenance-20260812.test.mjs` (395 assertions)
was tracked but run by nothing. It now runs as its own CI step. Verified it
also passes against PR #563's pending revision of the script it covers.

### Proof observed

- `node scripts/check-migration-hard-rules.test.mjs`: 66 assertions, 15
  throwaway-repository scenarios plus matcher unit tests, every acceptance
  rule with a near-miss DENY canary. One canary earned its keep during the
  build: the exemption marker regex copied from the local hook also accepted
  `-- rls-check: exemption requested`; the CI copy now requires the exact
  word.
- `--audit-all` over all 900 migrations: 163 `CREATE TABLE` statements, only 2
  historical files (2026-02-21 rate limiting, 2026-05-13 rebate counters) would
  fail — both have RLS but no policy, both pre-date this gate, neither is
  touched here.
- Diff check across the last 60 commits on `main`: passes.
- `deno check` on all 7 function entry points and `deno test` (22 passed)
  locally with Deno 2.9.4.
- A temporary commit on the PR branch touching an Edge Function proved the
  Deno steps run in CI; it was reverted before the candidate was frozen. The
  clean run before it showed the same steps as SKIPPED, not passed.

### Not verified

- The Deno steps against a future Edge Function type error in CI (only the
  green path ran there; the red path was proven locally).
- The migration hard-rules check going red on a live CI run. The local
  `rls-on-new-tables` hook refused to write the no-RLS canary migration, which
  is that hook working as designed; the CI red path is proven by the checker's
  own end-to-end tests, which run the real script against throwaway git
  repositories and assert exit code 1 and the exact message.
