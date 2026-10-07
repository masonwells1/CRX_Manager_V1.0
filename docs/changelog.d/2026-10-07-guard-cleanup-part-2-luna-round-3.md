## 2026-10-07 — guard cleanup, part 2: Luna round 3 fix

Follows `2026-10-06-guard-cleanup-part-2-file-deletions.md`.

**Fixed (Luna round 3, head e35f85a79)**

- `live-testdata-lib.mjs`: the `auth.uid()` allowance matched any quoted schema ending in `auth` (`"evil.auth".uid()`). The schema must now be exactly `auth` or `"auth"`. `"evil.auth"`, `"x auth"`, `evil.auth` and bare `uid()` are blocked, with regression cases in `guards.test.mjs`.

**Proof observed**

- Round 3 probes ran 35 shapes through the real merge and push hooks, comparing this head with the part-1 head. The only command allowed here that part 1 denies is the read-only `while read` loop. `npm run test:correction-guards` and `npm run check:docs` exit 0.

**Pre-existing gaps, open (allowed on main and the part-1 head as well, not touched here)**

- The local merge and push guards do not recognize two run-time program shapes: `trap '$P pr merge …' EXIT`, and a `$P` merge inside a Bash `case` arm within `$( … )` (the splitter ends the substitution at the case pattern's `)`). GitHub's `protect-main` ruleset still refuses any merge without green required checks and approval.
