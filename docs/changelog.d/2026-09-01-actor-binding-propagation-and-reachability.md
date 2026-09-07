## 2026-09-01 — The taint direction nobody was testing

The write-time actor-binding guard tracked a caller-supplied actor through four binding forms:
`:=`/`=`, `DECLARE ... DEFAULT`, `SELECT ... INTO <first target>`, and `ALIAS FOR`. FOR/FOREACH,
`GET DIAGNOSTICS` and `FETCH INTO` were already handled in the same file — but only inside
`stableAuthUidBindings()`, which uses them to **invalidate** an already-trusted `auth.uid()` local.
That is the opposite direction. Three existing test blocks assert the invalidation direction and
passed the entire time the propagation direction was open, which is why the gap survived.

Eight ways to launder an actor into a trusted-looking local and forward it to a helper, each
reproduced as an `allow` verdict against the pre-fix hook and re-run as `deny` after:

- pre-list `SELECT INTO v_id p_performed_by`
- `FOREACH v_id IN ARRAY ARRAY[p_performed_by]`, and `FOR v_row IN SELECT p_performed_by`
- `OPEN c FOR SELECT p_performed_by; FETCH c INTO v_id`
- `SELECT 1, p_performed_by INTO v_dummy, v_id` — the reader captured the FIRST target, so the
  actor's actual destination was never tainted. Output expressions are now correlated with targets
  **positionally**; the uncorrelated sibling stays clean, which is separately asserted.
- `GET STACKED DIAGNOSTICS v_id = MESSAGE_TEXT` after raising the actor
- `SELECT p_performed_by INTO v_rec.actor` then forwarding the whole `v_rec` — the field was
  tainted and the composite was not
- `v_id := CASE\n WHEN true THEN p_performed_by\n END` — the assigned expression was read only to
  the end of the LINE, so any multi-line right-hand side escaped

`cast` was also listed as a non-callable parenthesis keyword, so
`RETURN CAST(p_performed_by AS public.actor_token)` — and the `::` spelling — read as an ordinary
expression. A cast to a user-defined type runs that type's cast or input function with the actor as
its argument; that is the same boundary as `helper(p_actor)`. Casts to `pg_catalog` types stay
transparent, which is asserted in both directions.

### The live predicates

`predicates/actor-forgery.sql` credited any matching `IF ... IS DISTINCT FROM auth.uid() ... RAISE
EXCEPTION 'ACTOR_MISMATCH'` and then stripped everything after it. Nothing required that refusal to
execute, so `IF false THEN <refusal> END IF;` truncated the whole scanned body. Because `[^;]*`
reaches across any semicolon-free header, the match even *started* at the outer `IF`, leaving a
balanced-looking prefix — so the fix needs two checks, not one: the text before the match must
close every block it opens, and the matched statement itself must contain exactly one `IF` and no
loop or `CASE` opener.

The length-preserving lexer applied the `\\.` escape branch to every string form. A trailing
backslash is data in an ordinary SQL string, so `'ends with \'` closes at its own quote; treating it
as an escape swallowed that quote, ran to the next one, and masked the executable statements in
between. This did **not** fail closed — the routine was silently cleared. Escapes are now honoured
only inside `E'...'`, and only when the `E` is not word-adjacent, so `LIKE'x\'` is lexed as an
ordinary string too. Both spellings are pinned by fixtures that fail against the pre-fix regex.

The same pass rewrote the recursive lexer to consume maximal ordinary-character runs and dropped
`prosrc` from recursive state (it now joins back per step), and lexes each routine once rather than
once per actor-shaped parameter.

### Two prose claims that were false

- The sweeps README said the lexer's "unreadable residue fails closed". For the trailing-backslash
  input it failed **open**. The paragraph now says which residue actually fails closed, names the
  fixtures that prove it, and states that the block-counting reachability rule reads a `CASE`
  *expression* as unclosed — an extra finding, never a hidden one.
- The hook header said "non-mutating functions are never flagged". They are: `hasMutation` also
  covers call, operator and cast boundaries, so a read-only `WHERE created_by = p_user_id` is
  flagged because `=` is overloadable. There was already an assertion demonstrating this; the
  comment simply contradicted it. The comment now matches the test.

### Proof observed

- Each bypass run through the real hook with a crafted Write payload before and after the fix:
  `allow` then `deny`. Controls: a properly bound routine, an uncorrelated INTO sibling, and both
  `pg_catalog` cast spellings all stay `allow`.
- `node .claude/hooks/actor-binding-check.test.mjs` — 463 assertions, up from 447.
- `node scripts/db-invariant-sweeps/actor-forgery-predicates.test.mjs` — `ACTOR_FORGERY_PREDICATES_TEST_PASS`
  in disposable PostgreSQL 17. The three new fixtures fail against the pre-fix predicates
  (`actor_backslash_guard_forward`, `actor_word_adjacent_escape_forward`,
  `actor_unreachable_refusal_forward` are all absent from the pre-fix result set), and
  `actor_closed_block_then_refusal` confirms a closed block before a top-level refusal still ends
  the scan.
- `npm run typecheck`, `npm run lint`, `npm run test:agent-workflows` clean.
