## 2026-10-10 — guard cleanup, part 2: CodeRabbit review of 0bbf6f8bb

Follows `2026-10-09-guard-cleanup-part-2-arithmetic.md`.

CodeRabbit raised three Major findings. Each was checked against `main`'s guards and this head through the real hook scripts before any change.

**Fixed**

- `codex-push-lib.mjs`, depth limit: past `NESTED_MAX_DEPTH` a `$( … )` was read as plain words, so the assignment `x=$($P` was skipped and `P=gh; x=$(x=$(x=$(x=$(x=$($P pr merge 1 --admin)))))` was allowed. A substitution or backtick still left at the limit now counts as built at run time.
- `codex-push-lib.mjs`, unclosed `$(`: a quoted `'$('` later in a command made the splitter give up on the whole text, which dropped an earlier `$($P pr merge 1 --admin)`. The substitutions before an unclosed `$(` are now kept and checked.
- `live-testdata-lib.mjs`: a built-in name such as `pg_get_triggerdef` or `count` was exempt whatever its schema, so `public.pg_get_triggerdef(…)` (an application function, if one existed) passed as a catalog read. Only an unqualified or `pg_catalog`-qualified name is a built-in now; the `pg_stat`/`pg_ls` prefixes follow the same rule.

**Not regressions.** `main` allows all six merge and push shapes above, and the simpler `P=gh; x=$($P pr merge 1 --admin)` as well; this PR refuses all of them. The schema-blind exemption also exists on `main` for the older built-in names. They are fixed here because they reach a merge or push to `main` or a live database call, which the 2026-10-02 rule keeps blocked.

**Proof observed**

- The real `pr-merge-guard.mjs` and `codex-push-guard.mjs`, run from `main`, from 0bbf6f8bb and from this head: the four depth-limit and unclosed-`$(` shapes go from allow to deny; `i=$(($i+1)); git status` and `git status; echo '$('` stay allowed.
- `classifySql` before and after: `public.`/`evil.`-qualified built-in names go from allow to block; unqualified and `pg_catalog` catalog reads stay allowed.
- `npm run test:correction-guards` exits 0 with regression cases in `codex-push-lib.test.mjs` and `guards.test.mjs`.

**Luna round on the fixes (1 HIGH fixed, 3 LOW accepted)**

- HIGH, fixed: the `auth.uid()` and new `pg_catalog` checks matched case-insensitively, so a quoted `"AUTH".uid()` or `"PG_CATALOG".fn()` (other schemas in PostgreSQL) passed as the vouched-for object. Unquoted names still fold to lower case (`AUTH.uid()` is `auth.uid()`); a quoted schema must be exactly `"auth"` or `"pg_catalog"`. A quoted function name with capitals, such as `"COUNT"(*)`, is no longer treated as the built-in either.
- LOW, accepted: a balanced single-quoted literal such as `printf '%s' '$( $P pr merge 1 --admin)'` is refused (quote blanking was dropped after two Luna rounds because shells disagree on where quotes end); a harmless substitution nested past the depth limit is refused (fail closed at that depth is the CodeRabbit fix itself); `extensions.uuid_generate_v4()` is refused (below).

**Known side effect.** `SELECT extensions.uuid_generate_v4()` is now treated as an application call (the `extensions` schema is not `pg_catalog`). Use the unqualified name.
