# Agent guardrails — hooks & review subagents (CRX Manager)

> Extracted from `CLAUDE.md` on 2026-06-15 to keep the always-loaded file lean. This is the full reference for the
> automated safety net; `CLAUDE.md` keeps only a short summary + a pointer here. Regenerate the schema registry the
> hooks read after schema changes: `node scripts/regenerate-schema-registry.mjs`.
>
> Last reconciled against `.claude/settings.json` and `.codex/hooks.json` hook wiring on 2026-08-18 (hook-performance pass: PreToolUse
> matchers narrowed on the Claude side for `migration-apply-guard`, `mcp-tool-guard`, and `live-testdata-guard`
> (still `*` in `.codex/hooks.json`), and for `pr-merge-guard` (not wired for Codex at all — Codex has its own
> separate merge guard, `production-action-guard.mjs`); SessionStart hooks matcher-gated by source so the heavy ones stop
> re-running on every compact — also Claude-side only, since `.codex/hooks.json`'s SessionStart group has no `matcher`
> key, so its three hooks are not source-gated there;
> the two dead `"type": "prompt"` hooks (PreCompact re-anchor + SessionStart onboarding) replaced by the
> `session-context-reminder.mjs` command hook — prompt-type hooks only work in the interactive REPL — though only
> the PreCompact hook's rules half was carried forward (plus one added rule, see its row below); its
> summarizer-steering half was dropped with no replacement;
> `worktree-cleanup`'s network fetch rate-limited to once per 30 min; `eslint-autofix` switched from `npx` to the
> project's local eslint binary — `--cache` is still passed but never
> helps, since this hook only ever runs on a file just edited. No guard logic changed.) Previous reconciliation 2026-08-07 (Governed
> Software Factory removal: the three factory hooks — `factory-state-integrity`, the factory lane guard, and
> `factory-owner-input` — were deregistered from both manifests; `ship-intent-reminder` and every pre-factory
> guard remain wired exactly as before). Previous reconciliation 2026-07-16 (scaffolding-review pass: `pr-merge-guard.mjs` added — the PR-merge twin of `codex-push-guard` for the post-2026-07-14 branch-protection landing path; `bash-safety-lib.mjs` db-push pattern made npx-optional and `supabase migration up` added; `write-apply-proofs.mjs` proof stamping made unconditionally machine-minted: every stamp executes EACH required reviewer charter as its own trusted-Codex machine-verdict run; the caller-supplied `--codex-verdict` form and the say-so reviewer-only stamp were both removed). Previous pass 2026-07-13 (guard-hardening: `mcp-tool-guard.mjs` and `review-proof-guard.mjs` added; `bash-safety.mjs`, `hold-latch-lib.mjs`, `codex-push-lib.mjs`, `live-testdata-lib.mjs`, `idempotency-body-check.mjs` broadened — see their rows below).

---

### Schema-Aware PreToolUse Hooks (`.claude/hooks/`)
These mostly run when Claude Code tries to Write or Edit a file — they refuse the write if it violates a known bug pattern. They read `.claude/schema-registry.json` (regenerate via `node scripts/regenerate-schema-registry.mjs`). Matcher wiring (narrowed 2026-08-18 to cut per-tool-call process spawns; every guard ALSO gates on tool name in-script, so the matcher is a performance filter, not the safety boundary): `migration-apply-guard.mjs`, `mcp-tool-guard.mjs`, and `live-testdata-guard.mjs` run on the `mcp__.*` matcher (they only ever act on MCP tools); `pr-merge-guard.mjs` runs on `Bash|PowerShell|mcp__.*` (merges happen via `gh` commands or GitHub MCP tools); `review-proof-guard.mjs`, `hold-latch-guard.mjs`, and `unattended-autopilot.mjs` remain on `*` (all tools) because they legitimately inspect every call. This narrowing is Claude-side only — each of the seven hooks named in this paragraph that Codex wires still runs on `*` in `.codex/hooks.json`. (That applies to these seven only, not to the whole table: Codex wires the `Write|Edit` write guards below on `Write|Edit`, as Claude does.) Every per-hook matcher note below describes `.claude/settings.json`.

| Hook | What it blocks | Bug it prevents |
|------|----------------|-----------------|
| `sql-safety.mjs` | `pg_get_functiondef`, wrong idempotency columns, `updated_at` on tables that lack it; also blocks ANY new migration-file write while `.claude/session-state/REGISTRY-STALE.flag` exists (see Registry-staleness lifecycle below) | March 2026 40-bug incident |
| `money-safety.mjs` | `parseFloat()` on `*_cents` variables | Float rounding in money math |
| `idempotency-body-check.mjs` | RPC declares `p_idempotency_key` but body doesn't read/write `idempotency_keys`; **and (2026-07-13) a lookup that reads `idempotency_keys`/`check_idempotency()` with NO operation-scoping condition** (`operation = '...'` literal or an operation-bearing parameter) — a correctly-WIRED lookup can still be incorrectly SCOPED | `9b36cd2` — `issue_return_credit` regression; restore_quote_version bug class (Codex 2026-06-08, fixed at scale by migration `20260611211058`) |
| `actor-binding-check.mjs` | (2026-08-07) SECURITY DEFINER migration function declaring a forgeable actor param (`p_performed_by`, `p_actor%`, `p_user%`) whose body never binds it to `auth.uid()` via an `ACTOR_MISMATCH` check — caught at Write/Edit time instead of post-write sweeps | Actor-forgery bug class (save_field 2026-07-29; sweep predicate (c)/(i) only catch it after the migration exists) |
| `rls-on-new-tables.mjs` | New table without `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY` | Prevents future RLS regressions |
| `status-enum-check.mjs` | Writing a status string that isn't in the DB CHECK constraint | `4a25aea` — `'void'` vs `'voided'` |
| `generated-column-check.mjs` | UPDATE on a GENERATED column (e.g. `invoices.balance_cents`) | `a419da8` — `reverse_write_off` |
| `env-guard.mjs` | Any write/edit of `.env*` files; hard-coded JWT-shaped literals or `service_role` references in `src/` | Service-role-key leakage into frontend / transcripts |
| `grant-change-guard.mjs` | Write/Edit to a migration with GRANT/REVOKE on a function — if a REVOKE target (`authenticated`/`anon`/`PUBLIC`) has known callers in `.claude/caller-graph.json` and the migration lacks a `-- caller-analysis: <fn> :: <disposition>` justification line, the write is denied | B10 — a REVOKE migration broke production because caller analysis covered only 2 of 6 functions |
| `migration-apply-guard.mjs` | Supabase MCP `apply_migration` calls — refused unless `.claude/session-state/migration-review-<name>.json` proof exists from a recent (<30 min) `rls-security-reviewer` + `migration-drift-reviewer` run, with `queryHash` binding the proof to the exact transmitted SQL. ALSO (settled 2026-07-13 policy), three flag-driven rule-sets: **flag absent** → interactive rules (Mason's in-chat OK is the prose gate). **`AUTOPILOT.on` active** → hands-free rules: (a) a DESTRUCTIVE migration — apply-time `DROP TABLE`, `DROP SCHEMA/DATABASE/OWNED`, `ALTER TABLE … DROP COLUMN`, `TRUNCATE`, ANY top-level `DELETE FROM`, or `MERGE INTO` (`destructiveMigrationCheck` in `live-testdata-lib.mjs`; function bodies exempt, `DO` blocks count, no table allowlist) — is refused even with a clean proof; (b) the reviewer proof must carry a nonempty `queryHash` exactly matching the transmitted SQL; (c) a separate content-bound Codex proof `codex-review-mig-<safe-name>.json` must exist with `queryHash` matching the transmitted SQL, `verdict` in clean/ship/ship-with-followups, and a fresh (<30 min) `timestamp` — the second-model gate must have actually run and PASSED on this exact SQL. **Flag exists but expired/malformed** → the authorization LAPSED: ALL applies blocked until Mason re-arms or disarms (`--off` deletes the flag) | B7/B8/B9 class — applying migrations without parallel-session review; plus unattended data loss (no PITR on the free plan), Codex-gate skips, edited-after-review SQL, and lapsed-authorization applies in hands-free runs |
| `applied-snapshot-invalidate.mjs` | **PostToolUse**, not a blocker — deletes `.claude/session-state/applied-migrations.json` after EVERY Supabase MCP `apply_migration` call (successful or not). `migration-apply-guard.mjs` accepts that snapshot as ordering evidence while it is under 24 hours old, but elapsed time cannot prove no migration ran in between: capture a snapshot, apply a newer migration, then attempt an older one in the same session, and the still-"fresh" snapshot omits the newer row and lets the older migration through. An apply — not the clock — is the real invalidator. The next apply then blocks on missing evidence and demands a fresh capture (`node scripts/refresh-applied-migrations.mjs`). Fail-loud-ish: errors surface in `additionalContext` and never throw, and it only ever removes a regenerable cache file. **Since 2026-08-18 it also records every apply that carries a non-empty migration name** (name + timestamp + session + a normalized content hash of the transmitted SQL) into `.claude/session-state/applied-source-ledger.json`, the input to `stop-wrap.mjs`'s C3 source-containment check; recording is fail-open and never breaks an apply, and the read-modify-write is serialized by a cross-process lock (`ledger-lock-lib.mjs`), which greatly reduces — but does not eliminate — the window for overlapping parallel applies to lose entries: on a lock timeout the recorder appends anyway, because dropping the record would disarm the guard (CodeRabbit PR #423 round 4). An apply whose tool response carries the explicit `isError` marker IS still recorded, flagged `failed: true` — an error response cannot prove nothing landed, since non-transactional or multi-statement SQL can change live state before the call errors (Opus review 2026-08-19, round 4; an earlier revision skipped these). A re-apply of the same name AND same content-hash replaces the older entry instead of duplicating it (dedup keys on name + `sqlHash`, so a same-name apply with DIFFERENT SQL — a distinct change that hit live — is retained, not evicted; Opus review 2026-08-19 round 5); a genuinely stale entry is cleared only through `scripts/remove-applied-ledger-entry.mjs --name <name> --i-verified-against-live`, which refuses without that flag and first prints the live `supabase_migrations.schema_migrations` query to confirm against. The ledger is written atomically (temp file + rename) so a mid-write crash cannot leave truncated JSON that would disarm the stop-wrap check (Opus review 2026-08-19). | Codex P1 on PR #348 — an out-of-order live apply sneaking past a stale-but-"fresh" snapshot, the same class that silently reverted the `batch_apply_prepayments` actor guard on 2026-07-15 |
| `review-proof-guard.mjs` | Native Write/Edit, MCP filesystem paths, or shell commands that directly name `.claude/session-state/claude-review-push.json` or `codex-review-*.json`; wired for both Claude and Codex. Legitimate review wrappers — `scripts/run-claude-review.mjs` (Claude proof), `scripts/write-codex-push-proof.mjs` (Codex push proof), and `scripts/write-apply-proofs.mjs` (migration proof pair — machine-minted 2026-07-16: every stamp executes EACH required reviewer charter, `rls-security-reviewer` + `migration-drift-reviewer`, as its own trusted-Codex machine-verdict run and mints only when ALL return CLEAN; the caller-supplied `--codex-verdict <v>` form and the say-so reviewer-only stamp were both removed) — derive the path internally and never name it in the tool command, so they pass. Shell `cd`/`pushd`/`Set-Location` gating checks the **actual cd target** (2026-08-18 — the old "any cd token + any state-dir mention" conjunction denied legitimate commands like `cd <worktree-root> && ls .claude/session-state`); a target that enters the state dir, or a component step (`cd .claude` then `cd session-state`), or an unresolvable `$VAR`/`%VAR%` target in a command that mentions the state dir still denies (fail closed). The parser resolves the target past option tokens (`cd --`, `cd -P`, `Set-Location -Path <dir>` and attached `-Path:<dir>`), strips shell-joined quoting (`.claude/"session-state"`), and also matches the Bash-escape-decoded form (`session-\state` executes as `session-state`) alongside the raw form that covers Windows `\` separators (CodeRabbit PR #423). Since the Opus review 2026-08-19: newline-separated cd invocations are each checked independently (the old whitespace separator swallowed line breaks, so only the FIRST cd's target was ever resolved — `cd /tmp` then `cd .claude/session-state` on the next line passed); adjacent quoted/unquoted segments join into one token the way the shell joins them (`".claude/session"-state`); PowerShell's `Push-Location` counts as a cd verb; and glob/brace metacharacters (`* ? [ ] { }`) make a target statically unresolvable, which fails closed whenever the command also mentions the state directory. Since round 4 of that review: the cd scan also sees through a quoted, escaped, eval-wrapped, or composed verb (`"cd"`, `'cd'`, `\cd`, `c"d"`, `eval "cd …"`), PowerShell's default `sl` alias (with a lookahead so `sleep` doesn't match), an expansion glued to the verb (`cd$IFS…` fails closed), backslash line continuations spliced into one invocation, and ANSI-C `$'…'` quoting decoded before scanning. A destructive verb (`rm`, `Remove-Item`, `mv`, `del`, and friends) in any shell command that also mentions the state directory is denied outright — the directory holds the applied-source ledger and every wrapper-owned proof — and the ledger's own basename joined the proof-file name guard on every channel (Write/Edit/MCP/shell). Since round 5 of that review: the cd scan de-glues a cmd.exe verb fused to its target (`cd/d …`, `cd.claude\session-state`, composed `c"d".claude\…`) before resolving; a location verb left with an EMPTY target run by a move/pipe (`… | sl`) is treated as statically unresolvable and fails closed when the state dir is named elsewhere; and the destructive-verb deny now also fires when the command names the `.claude` PARENT directory itself (`rm -rf .claude`, `mv .claude /tmp`), not only the `session-state` subpath — while a `.claude`-PREFIXED but distinct path (`.claude-cache`, `.clauderc`) stays allowed. Since round 6 of that review: the destructive-verb net and the proof-path/ledger-name matcher run over the SAME normalized views the cd-scanner already used — raw, quote-stripped, and backslash-dropped (`shellCommandViews`) — so a quote-composed verb (`r"m" -rf …`), a backslash-dropped `.claude` ancestor (`rm -rf .clau\de`, which the shell runs as `.claude`), and a quote/backslash-split ledger or proof filename (`applied-source"-"ledger.json`, `codex-review"-"forged.json` — either would disarm C3 or forge a proof) are denied in whichever view the shell would actually execute; and `find` paired with a delete/exec action (`find .claude/session-state -delete`, `-exec rm`, `-execdir rm`) is treated as a destructive verb, since `find` deletes by traversal and never names the basename (a `find … -delete` on an unrelated `.claudex` glob stays allowed). The literal filesystem-path predicates (`file_path`, patch destinations, `cwd`) stay RAW — they are real paths, not shell syntax, so quote-stripping them would be wrong. The sanctioned path for clearing a stale ledger entry is `node scripts/remove-applied-ledger-entry.mjs --name <name> --i-verified-against-live` (round 5): the script REFUSES to remove anything without that explicit flag and first prints the `supabase_migrations.schema_migrations` query to run, so the C3 alarm can't be cleared by reflex — only after a human confirms against the live ledger. The allowed shape stays a LITERAL unrelated cd target (`cd <worktree-root> && ls .claude/session-state` passes); any variable or otherwise unresolvable target in a command that mentions the state dir fails closed by design. Since round 7 of that review: the destructive-verb/path net is component-aware and fails closed on a GLOB whose literal prefix could expand to a protected component — `rm -rf .clau*/session-state`, `rm -rf .clau*/sess*`, `find .clau*/session-state -delete`, `mv .clau*/session-state/applied-source-ledger.jso* …` are all denied, while a bare-`*` glob with no protected prefix (`rm dist/*.js`) still passes; a `>`/`>>` redirect that writes INTO the state dir is its own deny trigger even with a non-destructive verb and a globbed basename (`printf "[]" > .claude/session-state/x.jso*`), since an overwrite disarms C3 or forges a proof just as a delete would; and `git clean`, `rsync --delete`, and `truncate` join the destructive-verb net (each denies only when it also names the state dir, so `git clean -fdx dist`, `rsync --delete /tmp/a/ /tmp/b/`, and `truncate -s0 /tmp/log` stay allowed). Each round-7 detector was mutation-proved load-bearing: neutering it lets its exploit through, and the shipped guard denies it. CodeRabbit re-review of round 7 (finding 3813087972, its auto-"addressed" marker overturned by an empirical test) closed a partially-hidden cd target: `part=state; cd .claude/session-$part` resolves to the state dir but never spells the contiguous `.claude/session-state` string, so the second-literal-reference test missed it — the unresolvable-target branch now also fails closed when the target's OWN literal skeleton hits a protected component (`segmentsHitStateDir` on the target and its Bash-escape-decoded form), so `cd .claude/session-$part`, `X=session-state; cd .claude/$X`, and `cd .clau[d]e/session-state` deny, while `.claude`-prefixed siblings (`cd .claude-cache/$sub`, `cd $HOME/session-state-notes`) stay allowed; this detector was mutation-proved load-bearing too. Since round 8 of that review (two fresh blind Opus reviewers): the component-aware glob floor is dotted-aware — a glob segment's literal lead must be ≥2 chars when it starts with `.` (was a flat ≥3), because the only protected name starting with `.` is `.claude` and `.c*` is already a real glob for it, so `rm -rf .c*/s*`, `rm -rf .c*`, `mv .c*/s* /tmp/x`, `find .c*/s* -delete`, and `cd .c*/s* && …` all deny while ordinary deletes whose lead is a bare `s`/`a` (`rm s*.o`, `rm a*.log`) stay allowed; and a native or MCP file-mutation tool (`Write`/`Edit`, `move_file`, `delete_directory`) whose path field is the state DIRECTORY itself — not a protected basename — is now denied via `cdTargetEntersStateDir` over every `pathCandidate`, closing `move_file source=".claude/session-state"`, `move_file source=".claude"`, `delete_directory path=".claude/session-state"`, and a forge-by-move whose DESTINATION lands in the state dir, while an edit to a file inside `.claude` but outside `session-state` (`.claude/settings.json`, `.claude/hooks/*.mjs`, a hook-file move) stays allowed. The one deliberate exception INSIDE `session-state` is `stop-wrap-ack.json` — the designed session-end acknowledgment valve (`stop-wrap.mjs` instructs the agent to write `{"signature": …}` there to confirm ordinary loose ends are intentional): it is exempted basename-exact from this whole-dir deny (`isAckValveWrite`, 2026-08-19), restoring the carve-out `reviewProofPathMentioned` already kept on purpose but the round-8 `pathCandidate` deny had accidentally re-broken. Safe because `stop-wrap.mjs` never honors an ack while any live-applied migration lacks committed source (`appliedUncontained.length === 0` gate), so the C3 alarm still cannot be self-acknowledged; the proof files, the applied-source ledger, a lookalike (`stop-wrap-ack.json.bak`), and every OTHER `session-state` basename still deny — mutation-proved in `review-proof-guard.test.mjs`. CodeRabbit (PR #430) narrowed the exemption to exactly its intent: it opens ONLY for a Write/Edit shape — a move/delete-shaped call (both `source` and `destination` present, or a `move`/`rename`/`delete`/`remove`/`unlink`/`trash`/`copy`-named tool) is denied even when it names only the ack file (closing the MCP `delete_file`/`move_file` `path`-field reuse), the safety floor stays that EVERY state-dir-entering candidate must be the ack path (so a move/delete whose other operand is a protected file still denies), and the path match is CASE-SENSITIVE since the valve path is canonical lowercase. Both round-8 detectors were mutation-proved load-bearing. A cd or destructive target hidden ENTIRELY from the command text (a pure-`*` glob naming no protected prefix, a whole path hidden in a variable like `cd "$X"`, or interpreter indirection) remains an accepted residual gap — a verb/path denylist cannot be completed by enumeration; the wrapper-owned files are still name-guarded and the durable boundary is branch protection plus C3 tamper-evidence, below. **Honest scope:** this is a string-matching guard over the tool command. It stops NAMED destruction and accidental self-certification, not a determined agent that hides the target from the command text — running an interpreter that writes-then-runs a script, or base64/`node -e`-style indirection where the ledger path never appears literally, is outside what any command-text guard can catch. The durable boundary is GitHub `protect-main` branch protection plus the C3 tamper-EVIDENCE (an uncontained live apply blocks session end and pins the worktree), not command-string prevention. | Prevents accidental or one-line self-certification of the second-model review gate. |
| `pr-merge-guard.mjs` (+ shared `codex-push-lib.mjs`) | PR merges into `main` — `gh pr merge`, `gh api PUT .../pulls/N/merge`, or a GitHub-MCP `merge_pull_request` tool call (GraphQL `mergePullRequest` is denied outright as unresolvable). Added 2026-07-16: the 2026-07-14 `protect-main` ruleset moved the landing action from `git push` to PR merge, and `codex-push-guard`'s Codex gate never followed. Raw REST merges outside gh (`curl`/`wget`/`Invoke-RestMethod`/fetch naming `.../pulls/<n>/merge`) are denied outright — the guard cannot resolve their PR context, so they fail closed (Codex finding on this guard's own PR, 2026-07-16). Resolves the PR via `gh pr view` (fail closed if unresolvable), denies merges into `master`/`production`, requires a fully green pipeline (`mergeStateStatus` CLEAN + every check successful; for a NON-risky diff `--auto` is exempt from the green requirement because GitHub itself enforces the required checks; for a RISKY diff `--auto` is denied outright — auto-merge lands later-pushed commits after this gate has run, with a stale proof — Codex round-4 finding on this guard’s own PR), classifies the PR diff with the SAME risky-path/risky-content rules as the push gate, and — for risky diffs — requires the same fresh (<30 min), head- and base-bound `codex-review-<sha>.json` proof minted only by `scripts/write-codex-push-proof.mjs`. Non-risky green merges pass (the standing 2026-06-16 landing authorization stays intact). Tests: `.claude/hooks/pr-merge-guard.test.mjs`. | A Claude session one-click-merging un-Codex-reviewed money/RLS/migration code to production — the post-branch-protection twin of the "has codex reviewed all of these?" gap. |

**Landing helper (not a hook): `scripts/land-pr.mjs <n>`.** Companion to `pr-merge-guard.mjs`, added 2026-08-08 after PR #345 stalled overnight: branch protection requires the PR branch to be up to date with `main`, so a sibling merge flips a fully green PR to `mergeStateStatus=BEHIND` and auto-merge never fires — and every watcher that polls only checks misses it. The helper watches STATE, runs `gh pr update-branch` whenever the PR falls behind (re-running if main moves again), and exits 0 only on MERGED. It deliberately NEVER merges: merging stays with the gated `gh pr merge` (arming `--auto` for non-risky diffs; for risky diffs the helper waits for green/current and prints the proof-and-merge steps). Do not add a merge call to it — that would bypass the merge gate.

### Bash/PowerShell PreToolUse Hook (`.claude/hooks/`)
Runs on the `Bash|PowerShell` matcher, before a shell command executes. Deterministic regex, hard-blocking (not advisory).

| Hook | What it blocks |
|------|----------------|
| `bash-safety.mjs` (+ shared `bash-safety-lib.mjs`) | Force push, `git reset --hard`, discard-all (`git checkout .` / `git restore .`), `git clean -f`, `--no-verify`, recursive `rm -rf` targeting `src`/`supabase`/`docs`, uninstalling a core dependency, staging `.env` for commit, shell-redirect writes to `.env*` (e.g. `echo X > .env`, added 2026-07-13), `supabase db push` (any spelling — npx-optional since 2026-07-16) / `migration repair` / `migration up` / `db reset`, `dropdb`/`createdb`, force-deleting `main`/`master`/`production`, `git push --mirror`/`--prune`, `git filter-branch`/`filter-repo`, `rm -rf /<path>` outside known scratch dirs, suspicious `npm run reset/nuke/wipe`, `DROP TABLE`/`DROP SCHEMA`/`TRUNCATE` via `psql`/`supabase sql`, Bash-based modification (redirect or `sed`/`perl`/`awk -i`) of an EXISTING file under `supabase/migrations/` (creating new migration files is allowed), **and (2026-07-13, npm-script indirection) the RESOLVED body of any `npm run <script>` target from `package.json`** — recursing into scripts it calls, max depth 3, so a dangerous command hidden behind an innocuous script name is still caught. The whole pattern table now lives in `bash-safety-lib.mjs`, shared with `mcp-tool-guard.mjs` below (one source of truth, no drift) |

Two more Bash-matcher PreToolUse guards — `active-area-guard.mjs` and `codex-push-guard.mjs` — are documented in the Correction-mined guards table further down this page.

While the protected 2026-08-12 maintenance producer exists, the shared shell
classifier also fails closed on opaque inline interpreters and launchers that
could assemble its command indirectly. Coverage includes AWK-family programs
launched directly or through WSL and multi-call tools, plus Node preloads
introduced through token-parsed assignment, `env`, or `command env` wrapper
chains; empty/quoted assignments, multi-variable exports, LF/CRLF command
boundaries, `command --`, process wrappers (`exec`, `nohup`, `nice`, `timeout`,
`setsid`, and `stdbuf`), and attached `env -S`/`--split-string` bodies are
included. WSL, BusyBox/Toybox, file-search execution operands, `xargs`, and
privilege wrappers are followed into their executable operands, while quoted search text and
terminal help/version modes remain data. Escaped grouping/terminator tokens and
multiple file-search actions retain their runner context. Executable command-string bodies are
recursively inspected for `cmd /c` or `/k`, PowerShell command modes, and POSIX
shell `-c` wrappers. Backslash-prefixed separators are evaluated under both
POSIX and PowerShell semantics; normalization is bounded at the shared recursion
limit and fails closed beyond it. Backslash-LF and backslash-CRLF payloads are
inspected in two views: a POSIX-continuation view with the pair removed and a
PowerShell-boundary view that removes only the backslash while retaining the
line break as a command separator. Deny and approval-required checks run over
both views, including through MCP process tools; this prevents a dangerous
second PowerShell line from disappearing into the preceding token during POSIX
normalization. Standard short and long `xargs` options are
consumed; GNU optional-argument long forms preserve the following executable
unless their value is attached with `=`, and unknown option shapes fail closed
when an opaque target remains. Empty quoted option values stay tokenized, so
`xargs -E ''` cannot shift the parser past an opaque or preload target. Bash
execution keywords and the `time` prefix
are also traversed, including conditional and loop-body command positions.
Bash append assignments (`NAME+=value`) retain assignment context in command
prefixes, environment wrappers, and export builtins. `sudo`/`doas` environment
assignments are inspected before the privilege wrapper consumes them, including
when nested through WSL. CMD caret escapes are normalized before assignment
matching, and named Bash coprocesses are followed into their launched command.
The `watch` runner is inspected recursively through WSL and BusyBox/Toybox;
unknown option shapes fail closed and terminal help/version modes remain data.
Linux `unshare` required-value, optional-value, and flag options are consumed
before its child program is inspected, including compact short-flag clusters.
Bash `declare`/`typeset`/`local`/`readonly` variable mutations and the `builtin`
wrapper are also parsed, so alternate builtin export forms cannot hide a
`NODE_OPTIONS` preload.
Recursive command-string bodies reapply opaque-interpreter detection, split
`env -S` bodies retain their option context, and POSIX-escaped wrapper and
assignment names are checked alongside their raw spellings.
Static `eval` bodies are inspected recursively, while dynamic evaluation and
source operations fail closed; GNU Parallel is parsed as an indirect runner,
including recursively inspected quoted command bodies. Dynamic environment-name
construction cannot hide `NODE_OPTIONS` before a Node-backed executable: POSIX
`env` command substitutions, concatenated PowerShell environment paths, and CMD
delayed-expansion assignments fail closed. Node-backed runner names are matched
after shell escape normalization, so POSIX backslashes and CMD carets cannot
disguise a package runner. A quoted Node-backed name is executable when it is in
command position, but quoted search arguments remain data. Recursively inspected PowerShell
command bodies also recognize ordinary `$env:NODE_OPTIONS` assignments,
environment-provider item/content cmdlets, their standard short aliases, aliases
created inside the same command body, and .NET `SetEnvironmentVariable` calls
before Node-backed runners. Copy, move, and rename provider operations and their
PowerShell aliases inspect quoted source/destination operands too, so a safe
environment item cannot be staged and later transferred into `NODE_OPTIONS`.
Those mutations are denied independently of whether
Node execution appears in the same payload. Dynamic provider targets such as
`Env:$target` fail closed, and the protected producer itself is never allowed
through `interact_with_process`; it must launch in a fresh process with no
retained shell state. That boundary is latched rather than inferred from the
current checkout: removing, relocating, or untracking the file does not reopen
process interaction or signal tools, and retirement requires a separately
reviewed guard change. MCP whole-directory mutations of `scripts` are blocked,
and shell path operands are glob-matched against the protected repository path
so wildcard/pathspec forms cannot target it indirectly. Matching uses bounded
state propagation instead of a generated regular expression, preventing long
wildcard runs from consuming the hook timeout; actual Bash and MCP hook timing
regressions enforce that boundary. That includes content
writers, in-place editors, truncation, and output redirects. An exact allowlisted
producer launch is still denied unless an independent Git-blob hash of the
worktree bytes matches exact `HEAD`. On a feature branch it also requires the
fresh exact-head Sol review proof used by the production gate; this is the final boundary
for fully dynamic targets that command-text inspection cannot resolve.
File-backed interpreters require their entry script to be repository-local,
tracked and byte-identical at exact `HEAD`; the entire tracked worktree and
index must also match that same commit so an unchanged entry cannot import a
modified helper. The same independent proof is required when the head differs
from protected `origin/main`. This blocks ignored, external, untracked,
worktree-divergent, dependency-divergent, and unreviewed wrappers before they
can launch the producer or a preload as an uninspected child; Bash and MCP
regressions use a real ignored spawning wrapper, modify a helper imported by an
unchanged reviewed entry, and cover Node's `--` option terminator before the
script operand. A local commit alone remains denied; a regression proves the
wrapper does not become trusted without fresh independent exact-SHA review. The
proof producer is the only bootstrap exception and must still byte-match its
protected-main blob. Protected-main identity comes from a sanitized
`git ls-remote` call to the canonical GitHub repository, not the mutable local
tracking ref or hook environment. Unit fixtures can inject a SHA only through a
direct function argument that neither production hook entrypoint accepts.
Before the bootstrap exception is granted, bare `git` must resolve to the fixed
trusted installation; dangerous `GIT_CONFIG_*`, repository/index/object,
replacement, executable-path, and external-diff environment overrides must be
absent; effective `core.fsmonitor` and `diff.external` settings
must be inert; and replacement refs must be absent. Command-local Git control
environment assignments are denied through both Bash and MCP process routes.
Local tree reads disable Git replacement objects, strip object-database and
alternate-object environment redirects, and deny both `git replace` and
`refs/replace/**` updates, including opaque `git update-ref --stdin` batches. A
replacement-commit regression proves an attacker cannot keep the authoritative
SHA while substituting a hostile wrapper tree.
Every provenance read invokes Git through a fixed trusted installation path and
a minimal sanitized environment. Repository-local and PATH-injected Git shims
are planted in regressions and proven not to execute before trust is established.
**Where the boundary actually is.** Blocking every way to *create* an alias is
unbounded — `mklink /H`, `ln`, `cp -l`/`--link`, `link`, BusyBox, PowerShell
`New-Item`, `fsutil`, and any language runtime with a `link()` binding. Blocking
every way to *write through* one is bounded: MCP file tools and the native
Write/Edit tools. So file identity is enforced at the write boundary by both
`mcp-tool-guard.mjs` and `protected-identity-guard.mjs` (Claude's `Write|Edit`
matcher, sharing `protected-identity-lib.mjs`), and the shell classifier's
link-creation denials are defence in depth rather than the boundary itself. That
list of creators is deliberately not exhaustive and must not be read as such.

Protected-path matching is no longer name-shaped only. A hard link gives a
protected file a second, innocuous pathname that `realpath` cannot resolve away,
so an alias write would edit the real file while every pattern missed. MCP file
targets are now also compared by filesystem identity (device plus inode/file-ID)
against the protected set. Matching the protected path in the command text was
not sufficient on its own: a directory junction launders it out of the text, so
`mklink /J alias .claude\hooks` followed by a hard link through `alias\` names
nothing protected. Hard-link **creation** is therefore denied outright, whatever
the operands — `mklink /H`, non-symbolic `ln`, and the `HardLink` token in any
spelling (PowerShell `New-Item -ItemType HardLink`, its `ni`/`-Type` forms, and
`fsutil hardlink create`). Nothing in this project's workflows needs one, and
with no alias there is nothing to launder. Junctions and symbolic links remain
available except when aimed at a protected location, which closes the laundering
hop itself. A regression drives each step of the junction→hard-link→write chain
separately, because the steps need not arrive in one command.

Matching the literal `HardLink` token is not sufficient for PowerShell, which
evaluates an expression in that position: `-ItemType ("Hard"+"Link")` never spells
the word, and a variable hides it entirely. Enumerating the ways to compute a
string is unwinnable, so the test is inverted — a `New-Item` item type must be a
recognized safe literal (`File`, `Directory`, `SymbolicLink`, `Junction`) or the
command is denied. Computed expressions, variables, abbreviated parameter
spellings, the `-Param:Value` colon form, and unknown future item types all fail
closed, while ordinary file and directory creation is unaffected. Symbolic links and
junctions stay allowed because canonicalization already resolves them. A real
hard-link regression proves the write, edit, and creation routes all deny.

The proof wrapper uses that same fixed executable and minimal environment for
repository discovery, clean-tree status, ref binding, tree/blob enumeration,
candidate listing, and packet diffing. Global/system Git configuration and
system attributes are disabled throughout, while repository-local executable
filters/attribute overrides still fail closed. A hostile global attributes file
plus process filter is planted in Bash, MCP, and packet-construction regressions
and proven not to execute.
After provenance succeeds, ordinary Node entrypoints receive a transitive static
runtime-closure audit. Relative JavaScript dependencies must resolve to tracked
exact-HEAD files; bare package imports, ignored or untracked dependencies,
dynamic module/code loaders, native binding escapes, and process/evaluation
builtins such as `child_process`, `worker_threads`, and `vm` fail closed. This
prevents a reviewed script such as an area runner from delegating execution to
modified ignored `node_modules` bytes. The exact maintenance producer and its
exact-review proof bootstrap are the two explicit audited exceptions. Bash and
MCP regressions plant a hostile ignored package shim and prove a tracked child
runner is denied before that shim executes.
Node startup options also fail closed against a small explicit non-loading
allowlist for every entrypoint. Custom test reporters, environment files,
snapshot/SEA inputs, and unknown future options cannot load ignored code before
the exact-HEAD script operand; Bash and MCP regressions exercise both known and
unknown option shapes.
Package execution is recognized only in command position, so read-only
arguments that mention `npx`, `npm exec`, or `vite` remain ordinary data. A real
local package executable fails closed because ignored `node_modules` bytes are
not part of exact HEAD and can change after review; verification that needs the
installed toolchain runs inside the repository's reviewed commit/preflight gate.
npm package exploration/editing and `config edit` are denied because they launch
ignored package code or an arbitrary editor. `--editor`, `--shell`, matching
environment overrides, and persisted editor/shell/Node-startup configuration
also fail closed, preventing these subcommands from becoming alternate process
dispatchers outside exact-HEAD inspection.
Package-manager `--userconfig`/`--globalconfig` and startup-setting overrides
are denied, as are inherited or command-local Node/npm/Python preload and
search-path environment controls. Default npm config files fail closed when
they contain executable `node-options` or `script-shell` settings. Command-local
npm home/config and shell relocation through `HOME`,
`USERPROFILE`, `XDG_CONFIG_HOME`, `COMSPEC`, or `SHELL` is also denied across
POSIX, PowerShell, CMD, `env`, and `command env` spellings, so an ignored
alternate-home `.npmrc` cannot redirect lifecycle execution. Reviewed
Python script launches require both `-I` and `-S`, excluding environment search
paths, user-site modules, and automatic site initialization before exact-HEAD
code runs. Bash and MCP regressions cover npm user-config injection and an
untracked Python `sitecustomize` preload.
File-backed execution still fails closed if the canonical remote cannot be
verified; no mutable on-disk SHA cache is trusted. Output-target parsing also
recognizes adjacent redirects and Bash's
`>|` noclobber override before selecting the protected target. Because relative
executor identity also depends on the effective directory, the shared Bash/MCP
classifier denies file-backed or package execution after `cd`,
`Set-Location`/`Push-Location`, a nested directory-changing shell body,
or recognized wrapper/package working-directory options. A directory change
followed only by a Git read remains allowed.
Git cannot be used as an alternate executable dispatcher: inline `alias.*`
configuration, persisted alias configuration, and invoked subcommands that are
not known Git built-ins fail closed. This blocks `!` shell aliases and external
`git-*` helpers from launching ignored wrappers outside exact-HEAD inspection;
real Bash and MCP hook regressions exercise the hostile inline-alias command.
Inline, attached, environment-backed, and persisted Git configuration also
fails closed for executable settings including external diffs, fsmonitor,
filters, text converters, pagers, editors, credential helpers, and SSH command
overrides. Git cannot use those settings to dispatch an ignored wrapper.
The exact-review bootstrap itself has a one-command grammar: repository-relative
`node` plus the proof producer path, with no runtime options or extra arguments.
This prevents Node startup loaders from executing ignored code before review.
Its complete-tree comparison reads index metadata and worktree bytes directly;
it never invokes Git's clean/smudge/process pipeline. Effective executable
filters and unreviewed attribute overrides fail closed first. Tracked PowerShell,
batch, shell, and other non-JavaScript wrappers remain denied because their
child-runtime closure cannot be proven; preload controls apply to indirect
wrapper commands as well as literal Node/npm/Python commands.
Index entries must match both the exact-HEAD blob ID and Git mode, and disk
object types are validated from the reviewed HEAD mode rather than the mutable
index. Runtime entrypoints and their JavaScript dependency closure reject
symlinks, preventing a same-blob regular-file-to-symlink substitution from
redirecting the closure reader to unreviewed external bytes.
The provenance check also applies when a path-backed script or binary is the
command itself rather than an interpreter operand. Direct `.bat`, `.cmd`,
`.ps1`, shebang/executable paths, and nested shell dispatches must be tracked,
byte-identical to exact HEAD, and independently reviewed on feature branches.
Real Bash and MCP regressions deny ignored, worktree-modified, and locally
committed but unreviewed direct executables.
On Windows, bare command names are checked against current-directory executable
extensions before PATH lookup, so `cmd /c name` cannot hide `name.cmd` or
`name.bat`. Command-local `PATH` or `PATHEXT` mutations fail closed before bare
executable dispatch, including nested and unescaped CMD forms, so an ignored
subdirectory cannot replace the reviewed command resolution. Nested CMD
`call`/`@call`, `if` command operands, and `for ... do` bodies are replayed
through the exact-HEAD executor check. Static PowerShell
alias definitions are provenance-checked and
replayed through the full classifier, preventing an alias from hiding either a
path-backed wrapper or an interpreter plus unsafe operand.
MCP file-tool targets are resolved through the deepest existing ancestor before
matching protected paths. This collapses Windows 8.3 short names, junctions,
and symlink aliases back to the real producer path instead of treating the same
file as an unprotected spelling.
Implicit code loaders fail closed too, including PowerShell module/type loading,
Make build files, Java archives/classes, .NET execution, and Windows script/DLL
launchers. These commands can execute ignored inputs without placing that input
in command position, so manifest-only inspection is not a sufficient boundary.
Alias definitions and unknown commands
targeting `Env:NODE_OPTIONS` fail closed, as do standalone CMD mutations.
Recursively inspected CMD bodies fail closed
when `call`/`@call`, an `if` condition, or a `for … do` body precedes an explicit
`NODE_OPTIONS` assignment and Node-backed execution. Parameter-expanded `env` assignment
names fail closed before Node-backed executables. Bash `printf -v` and `read`
variable targets are inspected too, including dynamic target names, and
`set -a`/`set -o allexport` state is tracked across segments so a Node-backed
command fails closed until `set +a`/`set +o allexport` disables it. Dynamic
PowerShell process launchers (`Start-Process`, `saps`, and `start`) fail closed
in command position for both static and dynamic arguments. Dynamic
operands and command/process substitutions passed to `export`, `declare`,
`typeset`, `local`, or `readonly` fail closed before Node-backed execution.
Active `declare`/`typeset`/`local -n` nameref declarations fail closed there as
well, preventing an alias from exporting or mutating `NODE_OPTIONS` indirectly.
Escaped `find` action names
are normalized before matching `-exec`/`-execdir`/`-ok`/`-okdir`. A
16,384-character budget denies oversized payloads before tokenization, and a
512-token budget denies token-dense payloads before recursive runner analysis.
Together they prevent adversarial wrapper chains from exhausting the hook's
five-second execution window; real-hook Bash and MCP timing regressions include
a hostile at-limit repeated-runner payload and require completion in under 1.5
seconds.
Nested `eval`, `cmd /c`, PowerShell command-mode, and POSIX shell bodies re-enter
the complete runner policy, including PowerShell process launchers, `watch`, and
GNU Parallel, instead of receiving a reduced recursive subset. The caller's
recursion depth is preserved across that re-entry; a real-hook 450-level nested
`eval` regression remains below both parser budgets and must deny in under 1.5
seconds, comfortably inside the 15-second configured timeout.

Codex's hook adapter resolves and launches the requested hook under
`.claude/hooks/`, through which Codex uses the shared classifier. Codex also has
a distinct generated maintenance-execution matcher owned by its checked-in
maintenance generator; changes to one layer do not implicitly regenerate the
other.

### MCP Tool Guard (`.claude/hooks/`)
Runs on Claude's `mcp__.*` PreToolUse matcher (narrowed 2026-08-18; still the `*` all-tools matcher in `.codex/hooks.json`). Added 2026-07-13 to close the "Desktop Commander blind spot": `bash-safety.mjs` only gates the `Bash|PowerShell` tool matcher, but Desktop Commander's MCP tools can run the exact same shell commands, or touch the exact same protected paths, without ever going through the Bash or Write/Edit matchers those other hooks are wired to.

| Hook | What it blocks |
|------|----------------|
| `mcp-tool-guard.mjs` (+ shared `bash-safety-lib.mjs`) | Desktop Commander `start_process`/`interact_with_process`: the extracted command/input text against the SAME dangerous-command + migration-modify patterns `bash-safety.mjs` enforces (shared table, so a fix landed in one hook is a fix landed in both). Desktop Commander `write_file`/`edit_block`/`move_file`/`create_directory`: denies a target path that is `.env*`, an EXISTING file under `supabase/migrations/`, `.claude/settings.json`, or any `.claude/hooks/*.mjs` file — message: "use the native Edit/Write tools so the guard hooks can inspect this change." `kill_process`/`set_config_value` are matched by the tool-name regex but not specifically gated (no command/path signal to check against these patterns; `set_config_value` already requires "ask" approval in `settings.json`) — a deliberate, documented judgment call, not an oversight |

> **Current behavior (2026-08-20 correction; the table's older pass-through
> clause is historical):** while the reviewed maintenance-executor protection
> is latched, persistent-process input and process-signal tools are denied even
> when its worktree path is absent. File tools also deny that executor path and
> repository ignore controls. This supersedes the older `kill_process`
> pass-through judgment in the table above.

File-backed executors no longer trust the mutable local `origin/main` ref. The
guard resolves the protected SHA from the canonical GitHub repository with
local/system Git configuration disabled, then requires exact worktree bytes and
either that authoritative merged SHA or a fresh exact-head proof. Opaque package
resolvers are denied. Reviewed package-script bodies and local package binaries
bind their manifest and repository-root configuration files through the same
inspector; generic explicit config operands are bound too. This closes both
local-ref forgery and ignored/untracked package-config execution paths.

### Codex Production-Action Guard (`.codex/hooks/`)
Runs on Codex's `*` (all-tools) PreToolUse matcher through portable POSIX and Windows commands in `.codex/hooks.json`. The shared `.claude/hooks/codex-push-lib.mjs` is the single source of truth for main-target parsing, risky paths/content, and proof freshness.

| Hook | What it blocks / allows |
|------|--------------------------|
| `production-action-guard.mjs` | Non-risky diffs may target `main` only through the ordinary protected-branch flow (Husky pre-push still enforces typecheck/build). Risky diffs require the same `.claude/session-state/codex-review-<sha>.json` proof as the Claude-side push and PR-merge guards: `{ "codex_ran": true, "verdict": "clean", "model": "gpt-5.6-sol", "reasoning_effort": "high", "head_sha": "<exact pushed commit>", "base_sha": "<origin/main at review time>", "timestamp": "<ISO-8601>" }`. The proof must be 0–30 minutes old and bound to both the exact HEAD and current `origin/main`; missing, stale, future-dated, moved-base, wrong-model, wrong-effort, wrong-verdict, malformed, or BOM-corrupted proof denies closed. Only a successful clean-worktree `node scripts/write-codex-push-proof.mjs` run may mint it. That wrapper pins `gpt-5.6-sol` and high reasoning explicitly, disables user configuration, runs ephemerally in a read-only sandbox, requires one terminal `CODEX_PROOF_VERDICT: CLEAN`, and refuses dirty or shifted repository state. Force intent on any branch and bulk push modes (`--all`, `--branches`, `--mirror`, `--prune`) deny before target/diff classification. Both guards recognize `git`/`git.exe`/quoted paths, resolve `git -C`, inspect chained pushes, reject in-command cwd/git-environment overrides, use the actual per-call working directory, and fail closed on unresolved refs/diffs. Server-side routes (`gh pr merge`, relative/full-URL direct REST merges, GitHub MCP `merge_pull_request`) additionally require `mergeStateStatus=CLEAN` plus a non-empty rollup where every check is completed success/neutral/skipped. GraphQL merges, unrecognized mutating `gh api` calls, direct GitHub write tools, `node_repl`, Node eval/print/stdin launches, and recognized direct write/shell routes targeting critical harness files deny closed; ordinary reviewed scripts remain available. `execute_sql` accepts only one read-only SELECT/WITH/EXPLAIN/SHOW statement and a narrow allowlist of read-only PostgreSQL functions; common parenthesized WHERE/JOIN/GROUP/ORDER expressions work, while custom/application RPC calls deny. `git push origin :main`, protected `master`/`production` routes, deploy/live-migration commands, non-read-only SQL, and edge-function/live-service mutation remain blocked. Allow emits no hook output; deny emits structured JSON; the manifest grants this heavier guard 15 seconds. Repository hooks are defense-in-depth, not a cryptographic boundary against an agent with arbitrary local process/file access; GitHub's required-PR + passing-check rule is the external hard boundary. |

### UserPromptSubmit Hooks (`.claude/hooks/`)
These run when Mason submits a prompt, BEFORE Claude reads it. They inject extra context via `additionalContext` — they don't block — so Mason's intent is preserved while Claude is forced to slow down on risky wording or nudged toward the right workflow.

| Hook | What it warns on / reminds | Why |
|------|------------------|-----|
| `dangerous-phrase-warning.mjs` | "drop/delete migration", "drop/truncate table", "force push", "no-verify", "service_role in frontend", "disable RLS", "rebase published", "auto-commit/push/deploy", "bypass check_period_open", "edit financial_audit_log" | Forces Claude to explain consequences + offer safer alternative + get explicit confirmation before acting on phrasing that has caused incidents |
| `codex-gauntlet-reminder.mjs` | Plain-English review/ship/push wording where the object is the code change itself (domain-word-aware — "is the herbicide safe" doesn't false-trigger) | Reminds Claude to route through the Codex Review Gauntlet instead of self-certifying |
| `agent-pair-review-reminder.mjs` | Requests for Claude and Codex to both review the same work | Reminds Claude to route through `/agent-pair-review` |
| `codex-to-claude-handoff-reminder.mjs` | Plain-English requests for Claude to review or continue Codex's work | Reminds Claude that direct review is preferred, with durable handoff as the continuation fallback |
| `ship-intent-reminder.mjs` | Build/fix/ship/push/"go live"/"do it" intent | Reminds Claude to drive the work through the `/ship` pipeline rather than requiring Mason to know slash commands |

`hold-latch-prompt.mjs` and `autopilot-intent-reminder.mjs` are also UserPromptSubmit hooks — see the Correction-mined guards table below for what they do.

### SessionStart Hooks (`.claude/hooks/`)
Run when a session begins. Inject `additionalContext` so Claude sees state-drift warnings up front. **Matcher-gated by source since 2026-08-18, in `.claude/settings.json` only** (SessionStart fires with source `startup`, `resume`, `clear`, or `compact`; before the gating, every hook that then existed re-ran on EVERY auto-compact — 1,228 compact firings across the last 50 session transcripts in all projects, with p90 ~11s and a 14% timeout rate; `session-context-reminder` postdates that audit, so it is not part of those measured firings): `session-heartbeat` and `session-context-reminder` run on all sources; `session-snapshot`, `session-staleness`, and `worktree-awareness` run on `startup|resume|clear` only (re-running `session-snapshot` on compact also OVERWROTE the pre-session dirty-file baseline mid-session, degrading `stop-wrap`'s comparison); `worktree-cleanup` runs on `startup` only. **No source gating is declared on the Codex side**: `.codex/hooks.json`'s SessionStart group has no `matcher` key, so the three hooks it wires (`session-snapshot`, `session-staleness`, `worktree-awareness`) are not source-gated there.

| Hook | What it surfaces |
|------|------------------|
| `session-context-reminder.mjs` | On source `compact`: the money/idempotency/RLS rule re-anchor. On other sources: the session-onboarding reminder (read AGENTS.md etc.; Mason has zero coding experience). Replaces the two former `"type": "prompt"` hooks (PreCompact re-anchor + SessionStart onboarding), which only work in the interactive REPL and were silently dead in the desktop/SDK harness ("Prompt stop hooks are not yet supported outside REPL", observed live 2026-08-18) — but carries forward only the PreCompact hook's rules-re-anchor half — not verbatim: the old "Always include these reminders:" lead-in became a "POST-COMPACT RULE RE-ANCHOR" header, `.update/.delete` gained parentheses, one semicolon became a period, and it adds one rule with no ancestor in the old prompt ("treat files changed before the compact as UNVERIFIED unless the summary says they were run and observed"). The old prompt's other half asked the summarizer to cover "files modified this session; migrations created (and whether src/types/index.ts was updated); current task and next step; last build/test status" — that half was dropped with no replacement. Reasoning (not measured): `additionalContext` on a SessionStart `source === "compact"` fires after the compact has run, so it cannot shape the summary; the repo records no test of whether a PreCompact *command* hook could have carried it. Fail-open. |
| `session-snapshot.mjs` | Git porcelain snapshot (so Stop hook can tell session-scoped changes from prior WIP) |
| `session-staleness.mjs` | Schema registry behind registry-relevant migrations (without false alarms for cron/data-only migrations); uncommitted files from a prior session; weekly DB backup missing or older than 8 days. Backup evidence, newest wins (2026-08-18): the local `backups/LATEST-OK.json` marker (stamped only by a locally-run `scripts/backup-db.mjs`, so per-checkout) AND the "Off-site DB backup" workflow in `masonwells1/CRX_Backups`, where the scheduled backup actually runs — before this, every fresh worktree false-alarmed "backup died". `gh` is consulted only when the marker alone would alarm, with a 1.5s timeout and a cache in the user's home directory (`~/.crx-offsite-backup-check.json`, owner-only mode, 6h TTL on success, 10min on failure) so the hook stays under ~2s; if `gh` is unreachable the marker-only warning still fires, labeled unverified. Linked worktrees also check the main checkout reported by `git worktree list --porcelain` so the canonical checkout's gitignored backup marker stays visible. Tests: `session-staleness.test.mjs` (in `test:correction-guards`). |
| `worktree-cleanup.mjs` (+ `-lib`) | Auto-removes FINISHED worktrees/branches so they stop piling up (Mason 2026-07-13). A session can't delete its own active worktree, so each new session sweeps the PREVIOUS finished ones. Removes an item ONLY when the pure classifier (`worktree-cleanup-lib.mjs`, `git cherry`-based so squash/rebase merges count) proves it is fully merged into `origin/main` AND clean AND unlocked AND not the active session AND **not touched within the 3h activity window** (`recently-active` — git index/HEAD/reflog or `.claude/session-state` mtime, incl. the `SESSION-HEARTBEAT` marker below; added 2026-07-16 after a sibling session's sweep deleted an in-use unlocked checkout) AND not a protected branch AND (for worktrees) under `.claude/worktrees/`. Anything with unmerged commits, uncommitted changes, a lock, recent activity, or a manual long-lived checkout is KEPT and reported. Prints a recovery SHA for every deletion. Fail-open (stale/missing `origin/main` → does nothing). Its `git fetch origin` is rate-limited to once per 30 min (2026-08-18, via FETCH_HEAD mtime) — a stale `origin/main` only makes the classifier MORE conservative, never less. "Clean" ignores a harness-touched `.claude/settings.local.json` as the SOLE dirt (2026-08-18 — that machine-local permissions file kept 11 fully-merged agent worktrees unsweepable forever); at removal time the porcelain is re-checked, and only when the ignorable file is still the only dirt is it restored from HEAD (or deleted if untracked) before ONE plain-`remove` retry — never `--force`, so any real dirt still makes git itself refuse; if that retry still fails, the untracked file's saved content is written back so the failed sweep doesn't destroy the machine-local permissions file (Opus 2026-08-19). A worktree whose `.claude/session-state/applied-source-ledger.json` holds any real entry is KEPT (`applied-ledger`) even when merged+clean — the gitignored ledger is invisible to the merged/clean gates, and sweeping it would destroy the only record that live SQL lacks committed source (Opus 2026-08-19). This is a PRESENCE check, not a containment check (round 4): the classifier cannot cheaply prove an entry is satisfied by committed source, so the worktree stays kept until `stop-wrap.mjs` prunes the entry or `scripts/remove-applied-ledger-entry.mjs` clears it — even if the source is in fact already committed. Junk-only rows (no usable name) do not pin a worktree, but an UNREADABLE or MALFORMED ledger does keep it (CodeRabbit 2026-08-19): only a provably-absent ledger (`ENOENT`) is sweepable — a read error (EACCES/EISDIR/I/O) or unparseable JSON fails toward keep, since a read/parse failure is exactly when the worktree can least be proven safe to destroy. The whole read-result → keep decision is the pure `ledgerKeepsWorktree` in `worktree-cleanup-lib.mjs`, unit-tested for every branch (absent / unreadable / malformed / real-entry / empty / junk-only). Dry-run: `node .claude/hooks/worktree-cleanup.mjs --report`. Tests: `worktree-cleanup-lib.test.mjs` (in `test:correction-guards`). |

### Stop Hooks (`.claude/hooks/`)
Run when a session ends. Block until Claude addresses loose ends.

| Hook | What it surfaces |
|------|------------------|
| `stop-verify.mjs` | Code files changed this session — forces `npm run build` + `npm run test` before declaring done |
| `stop-wrap.mjs` | Uncommitted files, written-but-unapplied migrations, edited-but-undeployed Edge Functions, learning-capture prompt on substantive sessions. **Since 2026-08-18 also the C3 source-containment check:** any migration recorded in `.claude/session-state/applied-source-ledger.json` (written by `applied-snapshot-invalidate.mjs` on every `apply_migration`) with NO matching `supabase/migrations/*.sql` **committed to HEAD** (`git ls-tree`, not `ls-files` — an intent-to-add or staged-only filename cannot satisfy the guard; CodeRabbit PR #423) blocks session end — live SQL with no source in the repo reached production 3× in 30 days. An entry recorded with a `sqlHash` (every recorder entry since round 4) is contained ONLY by a committed candidate file whose EOL-normalized content hash matches the applied SQL — a same-named file with different content still blocks, because name-only matching let an empty or unrelated committed file both satisfy AND prune the guard (Opus review 2026-08-19, round 4). Legacy hashless entries keep the name rules: exact stamped basename, or stamp-stripped slug **time-gated to the recorded apply** (the slug must belong to a committed file stamped within 7 days before the apply or later — the repo has duplicate slugs across years, and an old same-named migration must not contain a fresh apply; an entry whose timestamp can't be parsed stays blocked on a slug-only match, fail closed; a candidate stamp with impossible date fields — month 99, hour 99 — satisfies NO window instead of parsing as garbage). Entries persist across sessions and are pruned only at a stop-hook run whose containment check they actually satisfy (committed alone isn't the trigger — the check must see the match); pruning happens under the same `ledger-lock-lib.mjs` lock the recorder holds (on a lock timeout the recorder still appends — dropping the record would disarm the guard — but the prune skips its rewrite, since an unlocked rewrite could erase a concurrent append; CodeRabbit PR #423 round 4). Malformed ledger rows (no usable name) are pruned without masking real entries beside them. Unresolved entries fold into the ack signature AND the ack valve is hard-gated: a signature-matching acknowledgment can never end the session while any apply is uncontained (Opus 2026-08-19) — entry names AND timestamps are sanitized/truncated before they reach the signature or the block message, so a hostile ledger value can't inject fake resolved-issue lines (round 4 extended this to the `ts` field). The block message names `scripts/remove-applied-ledger-entry.mjs --i-verified-against-live` as the sanctioned way to clear a verified-stale entry — the script refuses without that flag and prints the live-ledger query to confirm against first (Opus review 2026-08-19 round 5). If a git call itself fails — the work-tree probe or the `ls-tree` listing (binary missing, timeout, not a repository) — the check is skipped for that stop instead of phantom-blocking on an empty listing; an unborn HEAD (verified by its specific git error, not assumed from any failure) still blocks, because nothing committed is exactly the uncontained case (CodeRabbit PR #423 rounds 2–3; discriminator tightened Opus 2026-08-19). Tests: `applied-source-containment.test.mjs` (in `test:correction-guards`). |

### PostToolUse Hooks (`.claude/hooks/`)
These run AFTER a tool call completes. The Write|Edit-matched pair below can't block (the file is already written) but surfaces issues back to Claude immediately; `registry-freshness.mjs` runs on the `*` matcher (all tools) and specifically watches for Supabase MCP `apply_migration` calls.

| Hook | What it does | Why |
|------|--------------|-----|
| `posttooluse-migration.mjs` | Reminds Claude to update migration-history.md + regenerate schema registry after a migration edit | Prevents doc drift |
| `eslint-autofix.mjs` | Runs eslint `--fix` on edited `.ts`/`.tsx` files in `src/` (skips tests, migrations, edge functions). Since 2026-08-18 it invokes the project's local `node_modules/eslint/bin/eslint.js` directly instead of through `npx` — the npx re-resolve made this the slowest hook (p90 ~15.5s in the 2026-08-18 audit; the post-change figure recorded in PR #413, 1.1–1.2s, was taken on a warm cached run, so real-path latency is unmeasured). `--cache` is also passed but can't hit on this hook's actual path: the hook only ever runs right after the file it checks was just edited, and `--cache-strategy` defaults to `metadata` (size + mtime), so the just-written file never matches its cache entry, and `--cache` cannot reduce latency on this hook's real path. If the local install is missing it skips silently — the old npx fallback was removed on CodeRabbit review (it interpolated the file path into a shell string, an injection surface); the hook mkdir's the cache file's parent directory defensively, though ESLint's flat-cache creates it too; a 15s-timeout kill stays silent instead of reporting a fake lint failure (pre-commit lint is the real gate). | Catches import-order/local-rules/lint issues at edit time instead of at pre-commit |
| `session-heartbeat.mjs` | Stamps `.claude/session-state/SESSION-HEARTBEAT` with the current time on every tool call (and at SessionStart) | Keeps an ACTIVE session's worktree from being swept by `worktree-cleanup`'s activity window even during a long read-only session — the marker git timestamps alone would miss (Codex review, 2026-07-16) |
| `registry-freshness.mjs` | Watchdog (A8, 2026-07-04): after a live `apply_migration` call, scans the applied SQL for registry-relevant DDL (`CREATE`/`DROP TABLE`, `ADD`/`DROP`/`RENAME COLUMN`, `ALTER TABLE ... ADD`, `ADD CONSTRAINT`, `CHECK (...)`, `ALTER COLUMN`, `GENERATED ALWAYS`, `CREATE TYPE ... AS ENUM`). On a match, writes `.claude/session-state/REGISTRY-STALE.flag` and injects a reminder to refresh the registry. Fail-open (never breaks the session on error). | Stops the 4 schema-aware PreToolUse hooks (`sql-safety`, `status-enum-check`, `generated-column-check`, `rls-on-new-tables`) from silently validating against a schema snapshot that a live change just made stale |

**Registry-staleness lifecycle:** `registry-freshness.mjs` writes the flag the moment a live `apply_migration` contains registry-relevant DDL. While the flag exists, `sql-safety.mjs` (PreToolUse) blocks any new migration-file write (escape hatch: `-- sql-safety: exempt-registry` with a justification comment). The flag is cleared only by running the `/regen-schema-registry` skill's LIVE-INTROSPECTION refresh — querying live Supabase (Q1-Q5 in `scripts/regenerate-schema-registry.mjs`'s header) via MCP `execute_sql`, then `node scripts/regenerate-schema-registry.mjs --from-introspection <file.json>` — and confirming the registry's `_meta.generated_at` and content hash actually changed before deleting `.claude/session-state/REGISTRY-STALE.flag`. The script's no-argument default mode only re-stamps the timestamp; that does **not** count as a refresh and does not justify clearing the flag.

### Subagents (`.claude/agents/`)
Specialized reviewers invoked via the `Agent` tool. They run in their own context window and return only a summary — perfect for parallel review without polluting the main session.

| Agent | When to invoke | Bug class it prevents |
|-------|----------------|-----------------------|
| `rls-security-reviewer` | After writing any migration, BEFORE `apply_migration` | B7/B8/B9 (2026-05-26) — anon-EXECUTE-able SECDEF DML, missing `search_path`, missing RLS on new tables, actor-forgery anti-pattern |
| `migration-drift-reviewer` | After writing any migration that touches an existing table/function | March 2026 (40-bug incident) — CHECK-constraint regression, function-overload collision, column-name drift |
| `typescript-types-drift-reviewer` | After applying any migration that adds/changes columns; or sprint-cadence health check | Silent type drift between `src/types/index.ts` and live DB schema (code "works" until a real query hits a missing field) |
| `pdf-output-reviewer` | After editing any file under `src/` that imports `jspdf` / `jspdf-autotable` | Off-brand colors, page overflow, missing image assets, undivided cents in customer-facing PDFs (tank labels, invoices, statements) |
| `compliance-reviewer` | After editing `src/` or a migration — auto-dispatched by `/ship` and available to `/preflight` | CLAUDE.md red-line drift the other 4 don't cover — float money, missing `assertRpcResult` / `checkMutationResult`, `confirm()`/`alert()`, `@sentry/react` import, service_role in frontend, lifecycle violations |

**Rule:** Dispatch both subagents in parallel via a single message with two `Agent` tool calls. They are independent — running them sequentially is wasted time.

To exempt a specific file from a PreToolUse hook, add the marker comment named in the hook's error message.

### Correction-mined guards (added 2026-07-01)

Built from a workflow that mined the last 50 sessions (524 Mason-typed messages → 70 corrections → 12 recurring themes). Each targets something Mason repeatedly had to correct. All are **fail-open / off-by-default** — a read error or missing state file never blocks work. Lessons also live as auto-loading `memory/` files. Tests: `npm run test:correction-guards` (99 assertions across `stop-verify-lib.test.mjs`, `worktree-awareness-lib.test.mjs`, `autopilot-lib.test.mjs`, `guards.test.mjs`).

| Hook | Event | What it does | Correction it prevents / escape hatch |
|------|-------|--------------|----------------------------------------|
| `stop-verify.mjs` (+ `stop-verify-lib.mjs`) | Stop | When session code changed, BLOCKS "done" unless the transcript shows real verification (a `PROOF —` block, or a preview/WebFetch/prod-fetch/`execute_sql`). "Tests pass" is no longer accepted as proof. Bounded to 2 blocks/change-set (fails open). | #1 correction (16×): "is it really live?", "the icons still aren't there", "are the branches merged?". Escape: post `PROOF — Ran: … · Saw: … · Not verified: …`. |
| `worktree-awareness.mjs` (+ `-lib`) | SessionStart | Injects the list of sibling worktrees, each with branch + merged-into-origin/main + dirty count. Silent when solo. | "I have another session working on that", "is it already merged?" — claiming done blind to parallel work. |
| `codex-push-guard.mjs` (+ `-lib`) | PreToolUse(Bash) | Blocks `git push` from `main` when the diff (`origin/main...HEAD`) touches `supabase/migrations|functions` (or RLS/policy files, or — 2026-07-13 — `src/lib/db.ts`/`src/lib/sentry.ts`, the app's single Supabase-client and Sentry choke points) unless a fresh, HEAD-and-base-bound Codex proof (`.claude/session-state/codex-review-<sha>.json`, <30 min, `codex_ran:true`, clean verdict, `base_sha` = current `origin/main`) exists. As of 2026-07-14 the proof also records `base_sha` — the `origin/main` it was reviewed against — and the guard requires it to still match the current `origin/main`, so a base that moved after review (a sibling merge fetched locally, HEAD/worktree untouched) forces a fresh review instead of gating a diff that was never reviewed. Also (2026-07-13) flags a push as risky by CONTENT — the full diff text matching `_cents`/`balance_cents`/`financial_audit_log`/`allocate_payment`/`apply_prepay` — even when no changed file's PATH looked risky. Non-risky pushes pass. The **only** sanctioned producer of that proof is `scripts/write-codex-push-proof.mjs` (2026-07-14): it resolves the newest trusted `codex.exe` (fixed install dir, no PATH shim), then runs a read-only `codex exec` review (`--sandbox read-only`, so no side effects even when the workstation default is `danger-full-access`) driven by a FIXED prompt that pins the base to `origin/main...HEAD`, treats all diff content as untrusted data, and REQUIRES Codex to end with exactly one machine token `CODEX_PROOF_VERDICT: CLEAN|BLOCKERS` (mirroring `run-claude-review.mjs`'s terminal `FINAL_VERDICT:` — `codex review`'s free-form prose has no machine verdict, and any heuristic over it fails open/over-refuses). It writes the HEAD-bound proof ONLY when exit 0, exactly one verdict token appears, it is the LAST non-empty line, it is CLEAN, and the worktree/HEAD is stable — never a caller-supplied verdict. It derives the proof path internally, so `review-proof-guard.mjs` (which blocks any tool call naming a proof file) does not obstruct it; a BLOCKERS verdict, a missing/duplicate/non-terminal token, empty stdout, or a dirty/shifted worktree mints nothing (fail closed). The producer is itself protected like `run-claude-review.mjs` — in `codex-push-lib.mjs`'s `RISKY_PATH_RES` and the Codex `PROTECTED_HARNESS` set — and both this guard's deny message and the `/codex-review` skill point at it as the way to mint the proof. Tests: `scripts/write-codex-push-proof.test.mjs` (in `test:agent-workflows`), including a cross-check that the minted shape passes the guard's own `proofValid`. | "has codex reviewed all of these?" — shipping risky code with the Codex gate skipped or treated as queued. |
| `unattended-autopilot.mjs` (+ `-lib`, `autopilot-arm.mjs`) | PreToolUse(*) | OFF unless an unexpired `.claude/session-state/AUTOPILOT.on` flag exists. When armed, auto-approves tool calls EXCEPT a hard deny-set (push, deploy, destructive delete, secret write) so an overnight loop never stalls on prompts. `apply_migration`/`execute_sql` are deliberately NOT in the deny-set (Mason 2026-07-10, reaffirmed as settled policy 2026-07-13): in an armed run a migration may apply hands-free because `migration-apply-guard.mjs` still hard-requires the same-session proof, and destructive migrations are refused regardless. Arm: `node .claude/hooks/autopilot-arm.mjs --hours N`; disarm: `--off`. The armed flag is also the durable record of Mason's pre-authorization for hands-free applies. | "it keeps asking for permission… I'm going to bed" — reassurance instead of actually granting hands-free permission. |
| `autopilot-intent-reminder.mjs` | UserPromptSubmit | On "run it overnight / never ask / going to bed", tells Claude to ARM autopilot, not just reassure. | Same as above — makes the complaint drive an action. |
| `hold-latch-prompt.mjs` + `hold-latch-guard.mjs` (+ `-lib`) | UserPromptSubmit + PreToolUse(*) | "stop / pause / cancel background / just scoping" latches `hold.json`; the guard then blocks build/commit/migrate/deploy tools (reads, tests, and session-state/SCOPE.md writes stay allowed). Any next message clears it — can't stick across turns. Its mutate-tool set is (2026-07-13) a SUPERSET of `autopilot-lib.mjs`'s deny set — shared via import, so it covers `push_files`/`create_or_update_file`/`merge_pull_request`/`delete_file`/`delete_branch`/`rebase_branch`/the Desktop Commander mutating tools too, plus hold-latch-only additions (`apply_migration`/`create_directory`/`kill_process`) that autopilot deliberately allows unattended but a mid-session "stop" should still pause; `guards.test.mjs` asserts the superset property against the live import so the two lists can't drift apart. | "lets just stop here, cancel all background work" — momentum past an explicit stop. |
| `live-testdata-guard.mjs` (+ `live-testdata-lib.mjs`) | PreToolUse(`mcp__.*`; narrowed 2026-08-18, still `*` in `.codex/hooks.json`) | Blocks `execute_sql` that INSERTs into a live business table without `[E2E]`, or DELETE/void of a financial table. Also (2026-07-13) blocks ANY OTHER UPDATE against a live business table without `[E2E]` — the same standard already applied to INSERT (previously only money-column UPDATEs and cancel/void status UPDATEs were caught; a plain `UPDATE customers SET phone = ...` with no marker used to sail through). Override: create `.claude/session-state/REAL-DATA-OK`. | "use only fake fields/customers… delete them after"; cancel/void of real financial records is Mason's job. |
| `active-area-guard.mjs` | PreToolUse(Bash) | Blocks destructive ops (`rm -rf`, `git worktree remove`, `git branch -D`, `git clean -f`, force-push) against a folder/branch listed in `.claude/active-areas.json`. Inert when that file is absent. | "we're working in beyond-parity now, don't mess with it" — sweeping a folder marked active. |

### Conditionally-wired guards

These two are not always "on" for a given session — one is only *registered* in specific worktrees, the other is registered everywhere but only *active* when armed.

**`loop-guard.mjs`** — a hard PreToolUse guard, but it is **not** in the shared `.claude/settings.json` above. It's registered only in specific autonomous-loop worktrees' own `.claude/settings.local.json` (e.g. `C:\CRX_MainDebug`, for the unattended Codex-driven bug-hunt loop). Where it is registered, it hard-blocks: any `git push`, `git commit` off the designated loop branch, `apply_migration`/deploy tools, and live-DB write SQL (read-only `SELECT` and a strict `BEGIN…ROLLBACK` validation stay allowed) — turning the loop's prose gates into locked doors so a misbehaving or prompt-injected loop session physically cannot ship or mutate live data. Self-gated to its own worktree path, so it is inert (not present at all) in Mason's normal sessions and the main checkout.

**`unattended-autopilot.mjs`** — registered in every session (shared PreToolUse(*) matcher, table above), but a no-op unless `.claude/session-state/AUTOPILOT.on` is present and unexpired. Its hard deny-set (push, deploy, destructive delete, secret write) applies even when armed — autopilot only removes prompt friction for otherwise-safe calls, backstopped by `settings.json` `permissions.deny` and `bash-safety.mjs`/`migration-apply-guard.mjs`. Live migration applies are NOT in its deny-set: in an armed (Mason-pre-authorized) run they proceed through `migration-apply-guard.mjs`'s proof gate alone — the settled 2026-07-13 policy (`docs/manual/DECISION_LOG.md`); destructive migrations stay blocked by the guards regardless.

**Ledger guard (pre-commit, HARD — Mason 2026-07-13; migrations added 2026-07-16):** `scripts/check-ledger-update.mjs` runs FIRST in `.husky/pre-commit` and BLOCKS any commit that stages agent-surface/policy files (`.claude/commands|skills|hooks|workflows|settings.json`, any `.codex/` file, `AGENTS.md`, `CLAUDE.md`, `.husky/`, `scripts/check-*|validate-*|verify-*`, `sync-agent-workflows.mjs`, `run-claude-review.mjs`, `write-codex-push-proof.mjs`) **or a new `supabase/migrations/*.sql` file** without also staging at least one ledger update (`docs/CHANGELOG.md`, any `docs/manual/*.md`, this file, `docs/reference/migration-history.md`, or a `docs/loops/` ledger). Converts the "record every command/policy/schema change in the same commit" prose rule into a hard gate — migrations were added because the manual layer went stale within 48h of shipping. Tests: `scripts/check-ledger-update.test.mjs` (in `test:correction-guards`). Never bypass with `--no-verify`; never satisfy it with a throwaway line.

**Manual-freshness gate (HARD — 2026-07-16 scaffolding review):** `scripts/check-doc-drift.mjs` (`npm run check:docs`, run in pre-commit) now FAILS when `docs/manual/CURRENT_STATE.md` or `KNOWN_ISSUES.md` carries a "Last verified" stamp OLDER than the newest `supabase/migrations/` date-prefix. This converts the manual layer's freshness *promise* into a checked fact: a migration dated after the stamp means the live-state docs weren't re-verified against the change. Fix by actually re-reading the doc against live state (`list_migrations` / the live schema) and correcting anything stale BEFORE bumping the stamp — never bump the date alone. Pairs with the ledger-guard migration trigger above.

**Phase 3C private-artifact containment (HARD — 2026-07-27):** `.husky/pre-commit` invokes the checker with `--pre-commit`, which scans tracked, staged, modified, and untracked content but skips the ordinary ignored-local sweep for fast commits. A forced-added ignored file is Git-visible and is still scanned. If Git supplies an alternate `GIT_INDEX_FILE`, pre-commit preserves that one authoritative index while stripping every other inherited Git redirect; a real alternate-index commit fixture proves a packet staged only there is blocked. `.husky/commit-msg` separately scans the exact Git message file, so encoded packets in both `git commit -m` and `git commit -F` fail before a commit object is created while benign messages pass. The normal checker, pre-push, and CI retain the full ignored-file sweep. The multi-minute packet regression suite runs explicitly in CI, not in pre-commit, the every-commit correction bundle, or pre-push; local pre-push still hard-gates containment, typecheck, and build. Archive-only ignored-file exemptions are limited to explicit top-level generated roots (for example `node_modules/`); any nested operator-controlled `private/node_modules/` path is inspected normally. Every Git `-z` path reader requests bytes and requires fatal UTF-8 decoding plus an exact byte round trip before deduplication/keying; invalid UTF-8 path bytes fail closed in the index, candidate tree, history, first-push, and PR-target lanes, while valid Unicode names retain byte identity. Semantic private-artifact readers use the same fatal/exact UTF-8 rule instead of accepting replacement characters and reject descriptors above 64 MiB before either identity-read allocation. Hex transfer scanning retains complete bytes before an odd nibble, checks both nibble phases, and supports bounded whitespace-wrapped tokens without recursive transfer decoding. Embedded Base64 uses fixed byte batches across all four quartet phases, retains at most 4 KiB of whitespace before failing closed, decodes non-canonical padding bits so they cannot hide equivalent private bytes, finalizes open PEM bodies at EOF, and does not recursively decode transfer output. ZIP requires a complete plausible fixed header. Gzip uses a tri-state parser: incomplete bounded headers remain benign, reserved/invalid headers do not match, and a recognized optional field that exceeds its bound fails closed; the stream overlap is the exact maximum header size minus one byte. Short magic values and standalone ZIP data descriptors stay benign. A linked worktree of this same repository under the ignored `.claude/worktrees/` is exempt from the embedded-repository rule (2026-08-09): it is this checkout seen twice, its contents cannot be committed from here, and it runs this identical guard on its own push. The exemption requires both signals and fails closed on either — `git worktree list --porcelain` must report the directory, and its `.git` marker must be a regular pointer file holding exactly one `gitdir:` line resolving into this repository's own `.git/worktrees/` directory. A `.git` directory, a symlink, extra lines, or a pointer aimed at another repository's administration directory is still an embedded Git repository, so another repository's worktree checked out inside this one remains blocked.

`b30769b3` and `ce16574b` are rejected evidence, not accepted releases. The
recorded `b30769b3` containment proof checked 51,841 paths, 58 commits, 52,264
candidates, and 823,721,338 logical bytes. A later literal Opus 5 exact-SHA
review ran as `2026-07-27T23-29-35-252Z-3ef35b3a`; older ledger statements that
no Opus 5 review had run describe earlier historical cycles only. Literal Opus
5 later reviewed exact `fa78c4f7` as `SHIP-WITH-FOLLOWUPS`; subsequent
transfer-alignment and bounded-read corrections superseded that head.
Acceptance remains bound to a fresh exact-SHA proof/review cycle for the
current commit containing all bounded successor corrections.

**Full audit (manual):** `scripts/validate-sql-migrations.sh` — scans ALL migration files. Run with `--idempotency-only` for focused check.

**Refresh schema registry after schema changes:** `node scripts/regenerate-schema-registry.mjs` (or ask Claude Code to do it via Supabase MCP).

**Shared guidance:** edit `AGENTS.md` intentionally. `CLAUDE.md` imports it and contains only Claude-specific routing. Verify with `npm run check:agent-guidance`.

**Refresh architecture map:** `npm run generate-map` (or `node scripts/generate-workflow-map.mjs`). Auto-runs in pre-commit hook and stages `docs/app-workflow-map.html` automatically.

**Migration version responsibility (2026-07-18):** `migration-drift-reviewer` checks disk timestamp ordering and reminds the orchestrator to run the mandatory live `list_migrations` check. Because that isolated reviewer cannot call Supabase MCP itself, unavailable or missing live high-water evidence is emitted as a **HIGH** finding; the orchestrator must supply/complete the live `list_migrations` check and clear that finding before `apply_migration`. Migration-history coverage accepts either the full filename or its unique timestamp prefix.

