## 2026-09-08 - pin js-yaml past GHSA-2883-xcg3-v3hh, which turned every PR's required CI check red

**Why:** a new HIGH advisory against `js-yaml` 4.0.0-4.3.1
(GHSA-2883-xcg3-v3hh, "maxTotalMergeKeys does not limit CPU use for empty
merge sources") landed on 2026-09-08. The lockfile carried 4.3.1, so the
`Check for vulnerable dependencies` step in `Lint, Type Check, Test, Build`
started failing everywhere. Confirmed repo-wide, not branch-specific: run
34301529018 on `main` at `8deb2e48a` failed that job, and so did PR #639.
Since that job is a required check, nothing in the repo could merge.

No Dependabot PR had opened for it, and `npm audit fix` reported "up to date"
without changing anything -- `@eslint/eslintrc` asks for `js-yaml@^4.1.0`, and
npm was content to keep resolving that to the vulnerable 4.3.1.

**What changed:** one `overrides` entry, matching the existing
`brace-expansion` / `minimatch` / `uuid` precedent in the same block:

```json
"js-yaml": "^4.3.2"
```

`^4.3.2` deliberately, not `>=4.3.2`. The open range resolves to 5.4.1, whose
bin is `bin/js-yaml.mjs` -- an ESM-only major that `@eslint/eslintrc` was never
written against. Staying inside the 4.x line takes the fix without the API
risk.

The lockfile now holds exactly one `js-yaml`, 4.3.2, nested under
`@eslint/eslintrc`; the vulnerable top-level entry is gone.

**Proof.** `npm ci` from the regenerated lockfile installs 873 packages and
`npm audit` reports **0 vulnerabilities** (was: 1 high). `js-yaml`'s only
consumer here is eslint, so the real-path check is eslint itself:
`npm run lint` (`eslint . --max-warnings=0`) runs clean on 4.3.2.
