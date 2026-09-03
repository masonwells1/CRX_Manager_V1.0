# Actor-forgery sweep predicate — triage of the 56 reported rows, and the checker fix

**Date:** 2026-09-02
**Scope:** `scripts/db-invariant-sweeps/predicates/actor-forgery.sql` and
`actor-forgery-fin-audit.sql`, starting from the PR #449 rewrite (blob
`a8e192daa7be301117ee7276084d6fd6c4b17f5d`, byte-identical on the split branch
`claude/actor-forgery-sweeps-20260902`).
**Method:** read-only live introspection of `rhyzpcqhnizqbxphqdkr` via a respelled MCP form, plus a
disposable PostgreSQL 17 container for the regression fixtures. No live data was mutated and no
live routine was changed.

## Headline

**All 56 rows the PR #449 predicate reported are false positives. Zero real actor-forgery holes.**
The predicate was not surfacing a security backlog — it demanded one house style that live code does
not follow. Per Mason's 2026-09-02 decision ("fix checker, don't add exceptions") the predicate was
fixed rather than allowlisted. **Live rows: 56 → 21.**

## Measured baseline

| Predicate version | Rows | Distinct routines | Sweep |
|---|---|---|---|
| `main` (`ac71d1c2b…`) | 1 | 1 (`cancel_delivery`, allowlisted) | GREEN, but see caveat |
| PR #449 (`a8e192daa…`) | 56 | 55 | RED — 53 unallowlisted |
| This branch | 21 | 21 | 20 unallowlisted |

Population: 131 authenticated-executable `SECURITY DEFINER` routines carry an actor-shaped
parameter; 96 mention `ACTOR_MISMATCH`. `allowlist.json` holds 2 actor-forgery entries.

**Caveat on `main`'s green.** `main` excludes any routine whose source merely *mentions*
`ACTOR_MISMATCH` — 96 of 131 — so a routine that raises the token in unreachable or commented-out
code clears it without trying. The 1-row green is weaker than it looks.

## Why the 56 fired

| # | Cause | Safe? |
|---|---|---|
| 17 | Canonical token, actor bound in the **DECLARE initializer** (`v_actor uuid := auth.uid();`); the bound-local rule required a separate assignment statement. | Yes |
| 10 | Canonical token and assignment binding, but a **null-tolerant** refusal (`IF p_x IS NOT NULL AND p_x IS DISTINCT FROM v_actor`); the `IS NOT NULL AND` prefix broke the required regex. | Yes |
| 13 | **Thin dispatch wrapper** — `PERFORM <lock/precheck>; RETURN public._<impl>(… p_performed_by …);`. The guard lives in the callee. | Yes |
| 6 | Prose message `'p_performed_by does not match authenticated user'`. | Yes |
| 5 | **Prefixed** `'ACTOR_MISMATCH: …'` rather than the bare literal. | Yes |
| 3 | **Not an actor parameter** — `p_group_by` is a text grouping mode; `get_receiving_log.p_received_by` is a read filter. | Yes |
| 2 | Prose message `'Actor mismatch'`. | Yes |

Live code uses **four** refusal-message spellings, **two** actor-binding forms, and both
`IS DISTINCT FROM` and `<>`. The predicate accepted exactly one combination.

### Wrapper chain, verified

The 13 wrappers forward to `_section9_*_serialized` / `_*_below_cost_impl_20260810`. **None of those
callees is executable by `authenticated` or `anon`**, so the forwarded actor cannot be supplied
directly. Three callees carry no `ACTOR_MISMATCH` token but do bind `v_actor := auth.uid()`, require
authentication, and raise `'Actor mismatch'` — a spelling variant, not a missing guard. The
below-cost wrappers additionally call `_begin_below_cost_money_write(…, p_performed_by, …)`, which
carries the canonical guard, before the impl runs.

## What changed in the checker

Three shape fixes, applied to both predicates. **Candidacy is unchanged from `main` — there is no
type gate.** Two drafts added one (uuid + user-defined types; then "…or the body casts it to uuid or
compares it to `auth.uid()`") and BOTH were rejected as HIGH false negatives by the exact-SHA Codex
reviews: the second still missed `CAST(x AS uuid)`, a text actor forwarded to a text-accepting
helper, a cast inside dynamic SQL, and a plain `role … p_user_id` lookup. A gate built by
enumerating the spellings of "is really an identity" reopens on the next spelling, so candidacy stays
the region `main` defines and a static CI assertion now fails if anyone reintroduces one. The cost is
the three name-pattern collisions (`p_group_by` ×2, `p_signed_by`) reported below.

1. **Refusal credited by shape, not message text.** `RAISE EXCEPTION` + any message, instead of the
   bare `'ACTOR_MISMATCH'` literal. Safe because the lexer masks string literals first, so a
   semicolon inside a message cannot derail the statement match.
2. **DECLARE-initializer binding accepted** alongside the assignment statement. Ordering is still
   enforced (binding must precede the refusal) by comparing match positions.
3. **Null-tolerant refusals and `<>`/`!=` accepted.** On a `NOT NULL`-guarded operand these are
   equivalent to `IS DISTINCT FROM`.
4. **Coverage restored where the lexer had removed it**, after Codex rounds 2 and 3: a raw-source
   fallback for routines with no credited refusal (a masked `EXECUTE … USING <actor>` is invisible to
   every lexed arm), the financial predicate's dynamic-ledger-write arm, `INTO` treated as an
   assignment path, and quoted identifiers blanked before the control-flow balance is counted — the
   last being the one review thread that was still open on PR #449 itself.
5. **A null actor backfilled from another parameter is reported**, after Codex round 4. Crediting a
   null-tolerant refusal truncates the body, which is sound only while a NULL actor is harmless;
   `coalesce(p_actor_source, p_target_id)` makes it harmful, and the fallback parameter does not
   match the actor name pattern, so nothing else reports the routine. Narrow by design — the safe
   house form `coalesce(p_performed_by, auth.uid())` stays clear, and zero live routines match, so
   the live count is unchanged.

Four performance changes were required to keep the sweep runnable at all; each is commented at its
site. Removing the fixed literal removed the anchor that made most match attempts fail immediately,
and the predicate went from completing to timing out against the live catalog:

- whitespace runs collapsed once in `lexed` (the lexer masks literals to equal-length whitespace);
- ordering enforced by match position rather than a quadratic `.*?` bridge;
- the two operator arms use `~*` instead of `EXISTS (SELECT 1 FROM regexp_matches(…, 'gi'))`, which
  enumerated every match before EXISTS could stop;
- `OFFSET 0` fences on `lexed` / `guarded` / `analyzed`, because a plain CTE is inlined and
  `pre_refusal_src` was being recomputed once per WHERE arm. `AS MATERIALIZED` is the clearer
  spelling but the live-data read guard parses `MATERIALIZED (` as a function call and refuses the
  statement.

## Test coverage added

`scripts/db-invariant-sweeps/actor-forgery-predicates.test.mjs`, real PostgreSQL 17:

- **Four ALLOW fixtures**, one per live guard style, pinned so a future tightening cannot silently
  retake the sweep from 1 row to 56.
- **Thirteen must-report fixtures added across the four review rounds.** The ones that matter most are
  the near-misses of rules this change newly accepts — a guard that *cannot fire*:
  `actor_notice_not_exception_forward` (compares correctly but only `RAISE NOTICE`),
  `actor_selfbound_declare_init_forward` (initializer bound to the *parameter*),
  `actor_bare_inequality_forward` (`<>` against a NULL actor yields NULL, so the `IF` never fires),
  `actor_poisoned_local_before_refusal` (local overwritten after binding),
  `actor_null_tolerant_wrong_identity_forward` (compared against a random uuid),
  `actor_into_rebound_param_forward` (`INTO` as an assignment path), and
  `actor_quoted_identifier_block_spoof` (`"END IF"` balancing the control-flow counts), and
  `actor_null_fallback_to_other_param` (a NULL actor backfilled from another caller-controlled
  parameter after a credited null-tolerant guard — declined in round 3 on reasoning that was wrong,
  and fixed in round 4).
  Plus five restoring base coverage the lexer had removed: `actor_dynamic_audit_sink_only`,
  `actor_visible_probe_plus_dynamic_write`, `actor_text_cast_audit_forward`,
  `actor_text_role_lookup`, `actor_dynamic_role_authorization`.
- The pre-existing 22 must-report fixtures still report.

**Every fix was mutation-tested individually** — disabling it turns its own canary red and nothing
else. That includes the static CI guard, which is itself mutation-tested: adding a forwarding call to
the isolated dynamic-sink fixture fails it by name.

### A CI guard that passed on its own comment

Worth stating separately, because it is the failure mode this whole change exists to remove. The
first version of the static guard asserted an expression that, after a later revision, existed **only
inside a comment describing the rejected draft** — one raw match, zero executable-code matches. It
would have passed forever while pinning nothing. Comments are now stripped before every structural
assertion, and the suite still passes, which is what confirms the remaining assertions match real
code rather than prose about it.

## What still reports — 21 rows, four classes, none a forgery

| n | Class | Why it still fires |
|---|---|---|
| 13 | Thin dispatch wrappers | The guard is one call hop away. Clearing these needs the predicate to follow a call into a non-`authenticated`-executable callee and verify the callee's own refusal. That is a real extension, not a regex tweak. |
| 3 | `EXCEPTION WHEN OTHERS` later in the body (`complete_job`, `create_application_record_from_blend_ticket`, `unapply_credit_memo`) | The **pre-existing** fail-closed rule: a handler can catch a refusal, and PR #449 deliberately declined to prove PL/pgSQL block nesting in SQL. All three are correctly guarded at the top of the body. |
| 3 | **Name-pattern collisions** — `get_profitability_report.p_group_by`, `get_sales_summary_report.p_group_by` (text grouping modes checked against `'customer'`/`'product'`/`'month'`), `complete_delivery.p_signed_by` (a signature name) | Not identities at all. They return because removing the type gate was forced by two HIGH false negatives; three rows of honest noise beat a blind spot. |
| 1 | `get_receiving_log.p_received_by` | A uuid read filter in a routine that writes nothing. Needs a "no write sink" rule to clear. |
| 1 | `cancel_delivery` | Already allowlisted; unchanged. |

**These are not recommended for allowlisting and were not allowlisted.** Each needs a specific
checker capability, and two of them (exception-block nesting, delegate-following) are analyses where
a wrong simplification produces a false negative in a security control. That is a scoping decision
for Mason, not something to improvise inside a triage.

## Separate finding — attribution gap, not forgery

Three routines take `p_performed_by`, **never reference it**, and record no actor at all:

- `link_fields_to_parent` (UPDATE)
- `save_field_polygons` (UPDATE + INSERT)
- `unlink_field_from_parent` (UPDATE)

There is nothing to forge because nothing is attributed, so they are correctly absent from both
predicates. They are **properly authorized** — each calls `require_admin_or_sales_rep()` — and each
**does enforce** `p_idempotency_key` via `check_idempotency` / `save_idempotency`, so the CRX
mutating-RPC rule is satisfied. The defects are narrower and worth tracking separately: field
boundary and parent/child link mutations record no actor, and the API advertises a `p_performed_by`
it silently ignores. Both predicates are blind to this class by construction, since both key on the
actor parameter reaching a sink.

## Residual, stated plainly

This triage confirms the 56 reported rows are safe and the 21 that remain are safe. It does **not**
re-audit the routines the predicates never report. The 2026-09-01 cap entry's residuals stand
unchanged except for the `INTO`-target rebinding form, which this change closes, and the three
classes in the table above remain reported rather than resolved.

A null-tolerant refusal still truncates the body. Round 4 closed the one exploitable consequence of
that (a null actor backfilled from another caller-controlled parameter); the truncation itself is an
accepted limit, because the form is the house pattern and refusing to credit it would return the
sweep to ~31 rows. These predicates are over-broad heuristics, not proofs of safety.

## Status: MERGED 2026-09-02, carrying two known gaps

PR #564 **merged to `main` as `fdfba4ec5`**, merged by Mason himself, and the production deploy for
that commit succeeded. This section is the record of what shipped unfixed — read it before treating
either gap below as a new discovery.

Mason capped the review loop at one final round. The round-5 exact-SHA `gpt-5.6-sol` proof on
`b4f2b567a` returned **BLOCKERS**, and `pr-merge-guard.mjs` requires a fresh clean proof for any
diff `contentIsRisky` flags — which this one is, because a checker for forged actors necessarily
quotes the very identifiers that classifier looks for. No agent could merge it. Mason used the
owner escape hatch the gate is built around, after being shown the two open findings below.

### Round-5 findings, and their disposition

**HIGH — the null-tolerant truncation has more spellings than round 4 closed.** Round 4 added a
whole-body arm for `coalesce(<actor>, p_*)`. Codex correctly notes that
`CASE WHEN p_actor IS NULL THEN p_target_id ELSE p_actor END`, a quoted parameter, and a positional
`$2` fallback all reach the same place and none is detected. **Real, and SHIPPED UNFIXED.** It is also
the shape of problem this repo has settled twice: enumerating spellings of a hazard reopens on the
next spelling. Closing it properly means not truncating at a null-tolerant guard at all, which
returns the sweep to ~31 rows, or real PL/pgSQL dataflow analysis, which the 2026-09-01 cap entry
declined to fund. That is a scoping decision for Mason, not something to improvise.

**HIGH — a credited refusal disables the raw dynamic-SQL arm.** Both raw-source arms are gated on
*no* credited refusal, so `EXECUTE … set_config(…) USING <actor>` before an otherwise-sound
`auth.uid()` comparison is invisible. **Real, and SHIPPED UNFIXED.** The gate exists because an
ungated raw arm reported `actor_safe_refusal_forward` — closing the false negative reopened a false
positive. A correct fix needs the raw scan restricted to the pre-refusal region of the *raw* source,
which the lexer's offsets do not currently carry across.

**HIGH — "deletes approved money-risk tracking" is a FALSE POSITIVE.** `TODO.md` and
`docs/changelog.d/2026-09-02-todo-pricing-preseason-test-deadline.md` were **added to `main` by
PR #566 after this branch's last sync**; this branch never touched either file
(`git log HEAD..origin/main` showed exactly that one commit). The stale base has since been merged
in, so the finding cannot recur. This is the recurring "main moved" artifact, not a regression.

### Why it merged anyway

Measured, not asserted. Against the predecessor predicates it closes three inherited bypasses —
including the one review thread PR #449 left open — and adds a real-PostgreSQL regression suite plus
a Docker-free CI guard where there was none. It reports strictly *more* on the live catalog (21 rows
vs 1, `cancel_delivery` included in both), so **no routine the old version reported is cleared by
it**. The theoretical regression Codex raises against the base financial predicate — that accepting a
prose refusal message could clear something the literal-matching version caught — does not appear on
live code. Holding it back would have left a strictly weaker checker in place.

### What is still open

The two gaps above are tracked residuals, not resolved. Neither is a hole in the application: both
are places this *checker* can still be fooled, and the live catalog contains no routine matching
either shape as of 2026-09-02.

Closing gap (a) properly is an **owner scoping decision, not a regex tweak** — it means no longer
truncating at a null-tolerant guard, which takes the live sweep from 21 rows back to ~31 and gives
back most of the noise reduction this change bought. Do not decide that unilaterally. Gap (b) needs
the pre-refusal region of the *raw* source, which the lexer's collapsed offsets do not carry; that is
real work, not a patch.

No CodeRabbit review ran on this candidate. The gate that requests one has been failing repo-wide
since it landed in #516 — it lacks `administration: read`, so it fails on its collaborator-permission
check before doing anything and cannot even clear its own labels. The fix was already written in open
PR #563 at the time of this merge.
