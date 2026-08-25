# Live SQL guard maintenance — build-to-review handoff

## WHERE

- Checkout: repository root in the isolated owning worktree (local workstation path intentionally omitted)
- Branch: `codex/harness-maintenance-producer-20260812`
- Base verified before build: `origin/main` at `2837263d2a22eca71142bf77e449acbe2512e232`;
  current `origin/main` `a44fc2f52a95d815e2873536a6ff4204d84851c2` is contained in the branch.
- Repository: `masonwells1/CRX_Manager_V1.0`
- Production Supabase project: `rhyzpcqhnizqbxphqdkr` (no live write is part of this producer change)

## GOAL

Restore a governed way to repair the protected live SQL classifier without disabling or bypassing
its direct-write guard. Done means the one-use producer is independently reviewed at its exact head,
passes the protected PR pipeline, and lands before the classifier repair is activated on a new branch.

## PROVEN

- The producer constants pin the complete artifact mapping: input blob `c8bec70830c643e474831985f5e6c3bd16630386`; output blob `7bca8dce4fe2f58afabdbd09d1b31ecef61ce520`; constants SHA-256 `53c658d7eb8aab2a60b4314f533f61b7472f8d686f4b81d483d57b20950022a9`; helpers SHA-256 `8fa108c52b4423b7d269d94d19b91726fe880b6d2ea403c5c9665c686b532398`; classifier SHA-256 `41dea42c28a47e47892dbf1da05144a4dac0dfa30045eba99789090905411d00`.
- `node scripts/apply-live-testdata-maintenance-20260812.mjs --verify` produced pinned output blob
  `7bca8dce4fe2f58afabdbd09d1b31ecef61ce520`, matched all three snippet SHA-256 values, and passed a
  Node module syntax check without changing the repository target.
- `node scripts/apply-live-testdata-maintenance-20260812.test.mjs` executed 87 classifier assertions
  against the generated module plus 308 counted producer assertions, including cross-platform line-ending
  normalization and all classifier defect classes found through the latest automated and Sol reviews.
- The focused producer harness also passes after the exact pinned protections are installed, and the standard
  production-guard suite executes it while separately proving that an invocation without exact-head proof is denied.
- Before those generated protections are installed, the already-wired Bash/PowerShell and MCP process guards
  independently allow only the four exact repository-relative producer commands. Chaining, wrappers, alternate
  spellings, unknown arguments, npm indirection, and the original pre-bootstrap rewrite reproduction are denied.
- The write mode refused the dirty build worktree even with Mason's dated token.
- Current recovery proof passed ESLint, TypeScript typecheck, production build, all agent-workflow tests,
  agent health, the focused producer harness (87 classifier and 308 producer assertions), the 411-case
  shell-safety suite, the owning production-action-guard suite, and `git diff --check`.
- Historical snapshot as of August 12, 2026 (America/Chicago): `check-doc-drift.mjs` reported only
  the pre-existing `origin/main` mismatch between two live manual docs stamped 2026-08-12 and two
  deliberately parked, unapplied migration filenames stamped 20260813 (the next calendar day relative
  to that snapshot). The hook treats this check as non-blocking; the migrations remain parked and the
  docs were not given a false later live-verification date.

## WRITTEN, NOT PROVEN

- The checked-in producer can write only the assembled protected target on a clean non-protected
  branch after exact hash checks and the dated approval token. Detached HEAD and detached worktree
  states are rejected and are not approved branch states. Its real write mode has intentionally not
  run; it must not run until this producer itself is reviewed and merged.
- The producer also contains a one-time, exact-blob `--protect-producer` bootstrap for the outer Codex
  direct-edit guard and shared risky-path classifier. That mode must receive its own clean exact-head
  review before it runs. Its only outputs are the two pinned guard blobs; once installed, later edits
  to this producer are directly blocked, every producer change requires exact-head review, and any
  producer execution requires a fresh proof matching the current committed HEAD and base.
- The fourth exact command, `--retire-producer`, removes only this producer file after the same clean-worktree,
  exact-blob, dated-token, and fresh exact-head proof gates pass. This keeps the later activation lane capable
  of deleting the one-use tool without reopening a generic protected-file write path.

## NOT STARTED

- A clean exact-head `gpt-5.6-sol` high verdict for this branch.
- Push, pull request, CodeRabbit/check review, merge, and post-merge verification.
- Follow-up branch that runs the producer, preserves the existing red-to-green classifier regressions,
  removes the temporary producer, and completes its own exact-head review/pipeline.
- Before activation, replace or deliberately reroute the existing `DO`-based rollback smoke chains:
  the fail-closed classifier correctly rejects raw `DO` because transaction rollback cannot undo
  sequence side effects, while the current smoke workflow sends those chains through the classified
  MCP `execute_sql` path. Activation is blocked until a reviewed safe execution route preserves the
  required `SMOKE_PASS_ROLLBACK` real-path proof without reopening raw `DO`.
- Separate reconciliation of the two 20260813-stamped, parked and unapplied migration sources with
  the schema registry, plus the six stale Wave A migration timestamps. This description is the
  August 12, 2026 historical snapshot and is not evidence that either parked migration was applied.

## APPROVAL STATE

Mason approved remediation of all weekly-audit findings on 2026-08-12. This handoff does not convey
permission to weaken a guard or apply a live migration. Normal reviewed PR delivery remains authorized;
any later live migration apply still requires the repository's current explicit apply gate.

## GATES AND BLOCKERS

- Direct file writes to the protected classifier remain correctly blocked.
- The producer branch must receive an exact-head clean Sol proof before push/merge.
- The first exact-head Sol review returned blockers (unsafe transaction control in a `DO` smoke and
  safe E2E writes re-blocked by the final deny loop); both were repaired and require a fresh review.
- The second exact-head Sol review returned four more blockers (conditional/caught aborts,
  literal-only E2E predicates, `VALUES`-invoked mutators, and CTE `SELECT INTO`); all four were
  reproduced, repaired, and require another fresh exact-head review.
- The third exact-head Sol review returned two more blocker classes (negated/misbound E2E identity
  and multiple DML operations hidden in one statement). The persistent raw-SQL E2E exemption was
  removed, every DML target is now enumerated, and a fresh exact-head review remains required.
- The fourth exact-head Sol review found that PostgreSQL escape strings could hide a following
  mutation from the scanner. Escape-string parsing and six destructive regressions were added; a
  fresh exact-head review remains required.
- The fifth exact-head Sol review found mutating RPCs nested in allowed `EXPLAIN ANALYZE`, temporary
  table creation, and `pg_temp` writes. Function scanning now runs for every executable statement;
  a fresh exact-head review remains required.
- The sixth exact-head Sol review found that PostgreSQL sequence changes survive transaction rollback,
  so even a structurally valid aborting `DO` block was not safe. Raw `DO` blocks now fail closed
  categorically, the obsolete marker parser was removed, and four sequence reproductions were added;
  a fresh exact-head review remains required.
- The seventh exact-head Sol review found that both line-comment scanners recognized `\n` but not a
  lone `\r`, allowing destructive SQL after that PostgreSQL line ending to remain hidden. Both now
  stop at the earliest `\r` or `\n`, with five destructive/DML/RPC reproductions; a fresh exact-head
  review remains required.
- The eighth exact-head Sol review found that the new escape-aware statement scanner still delegated
  dollar-body removal to the legacy non-escape-aware scanner, so ordinary strings could manufacture a
  fake dollar span around a CTE `DELETE`. The classifier now uses one escape-aware scanner path for
  splitting, dollar bodies, comments, and DML discovery, with the exact exploit pinned. The same pass
  saw stale Wave A names only because current main advanced during review; merging current main
  restored its already-reviewed `20260813…` names. A fresh exact-head review remains required.
- The ninth exact-head Sol review found that `END` can commit the outer transaction and an intermediate
  `ROLLBACK` can end it before later SQL, while a decoy final transaction still satisfied the wrapper
  shape. Rollback proof now rejects every intermediate transaction boundary or alias, with both exact
  RLS-disabling payloads pinned. A fresh exact-head review remains required.
- The tenth exact-head Sol review found that the trivia skipper ignored a lone `\r` line-comment
  terminator and that `$tag$` embedded inside an unquoted identifier was mistaken for a dollar-body
  delimiter. The lexer paths now share the carriage-return boundary, dollar tags require a valid token
  boundary and PostgreSQL identifier grammar, and four exact destructive payloads are pinned. A fresh
  exact-head review remains required.
- The eleventh exact-head Sol review found that a rollback-wrapped temporary `get_*` function could
  hide and execute a non-transactional `setval()`/`nextval()` call in its dollar body. Raw function and
  procedure definitions now fail closed categorically, and the exact sequence payload is pinned as the
  56th generated-module assertion. A fresh exact-head review remains required.
- The twelfth exact-head Sol review found two more fail-open paths: PostgreSQL accepts non-ASCII
  characters in unquoted identifiers, so a Unicode identifier could manufacture a fake dollar-body
  span; and an updatable `pg_temp` view can forward DML into a persistent table. Dollar-tag boundaries
  now conservatively treat every non-ASCII predecessor as identifier text. Temporary DML is exempted
  only after the batch creates that exact base temp table, and any intervening schema operation clears
  every exemption. The exact Unicode, temp-view, standalone-temp-target, and table-to-view replacement
  payloads are pinned. A fresh exact-head review remains required.
- The thirteenth exact-head Sol review found that the remaining blanket rollback exemption admitted
  `COPY ... TO PROGRAM` and server-file export even though transaction rollback cannot undo their
  external effects. `COPY` now fails closed categorically, and the blanket exemption is replaced by
  an object-specific allowlist of transaction-safe schema and `SET LOCAL` smoke statements. Both
  exact `COPY` forms plus an unrecognized rollback-wrapped command are pinned. A fresh exact-head
  review remains required.
- The fourteenth exact-head Sol review found that `CREATE TEMP TABLE ... LIKE ... INCLUDING DEFAULTS`
  could clone a production column default whose later temp-table insert advances a persistent invoice
  sequence. Same-batch temp DML is now exempted only for a direct CTAS scratch table; cloned or declared
  tables receive no later-write exemption. The function-call view also removes the DDL object declaration
  without hiding expressions inside its column body, so a table name plus `(` is no longer mistaken for
  an RPC. The exact cloned-default batch and declared-table follow-up are pinned. A fresh exact-head
  review remains required.
- The fifteenth exact-head Sol review found that PostgreSQL `U&"..."` identifiers are decoded only by
  the database parser, allowing an encoded built-in or application mutator to evade raw-text function
  classification. Unicode-escaped identifiers now fail closed categorically on this maintenance
  surface, with encoded `lo_create` and `cancel_order` calls pinned. A fresh exact-head review remains
  required.
- The sixteenth exact-head Sol review found that `CREATE TEMP TABLE IF NOT EXISTS` can be a no-op when
  a same-named temporary view already exists, yet the classifier still granted that name a later DML
  exemption. Only unconditional direct CTAS creation now earns the exemption, and the exact updatable
  view collision is pinned. A fresh exact-head review remains required.
- The seventeenth exact-head Sol review found that `EXPLAIN ANALYZE` executes its wrapped command even
  though the classifier treated every `EXPLAIN` statement as read-only. This maintenance surface now
  rejects all `EXPLAIN` statements rather than approximating PostgreSQL's option grammar. Table CTAS,
  materialized-view CTAS, option-bearing, and prepared-command forms are pinned. A fresh exact-head
  review remains required.
- The eighteenth exact-head Sol review found that PostgreSQL permits `MERGE` without optional `INTO`,
  so a `WITH` statement could hide a persistent `WHEN MATCHED THEN DELETE` from the target scanner.
  The matcher now recognizes both grammar forms, the persistent-merge classifier handles both captured
  verbs, and the exact customer-delete payload is pinned. A fresh exact-head review remains required.
- The nineteenth exact-head Sol review was clean after the optional-`INTO` correction. The twentieth
  review then found the governance bootstrap gap: the producer could reach a protected target while
  remaining outside outer direct-edit and risky-path enforcement. The exact-blob protection mode now
  installs both outer controls and requires current committed-head proof before future execution. A
  fresh exact-head review of that bootstrap producer remains required before it runs.
- GitHub checks and CodeRabbit must be complete and acceptable on the exact PR head.

## FIRST ACTION

Refresh `origin/main`, confirm this branch contains it and is clean, and capture the current HEAD as
`review_sha`. Run the repository's Sol-high proof writer, require its reported `head_sha` to equal
`review_sha` before push or merge, and repeat the full exact-head cycle after any head change.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.
