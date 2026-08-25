# Patrol classifier contract — v1

Versioned definition of every term and every rule the patrol classifier applies.
`CONTRACT_VERSION` in `patrol-classify.mjs` must equal the version in this heading.
Changing a rule means bumping the version and updating the expected corpus (§10 of the plan).

Patrol is **read-only** and makes **negative claims only**: it reports blockers it can see. It
never asserts that a pull request is ready to merge — a complete readiness predicate would have to
model every current and future GitHub ruleset, so any such claim would eventually be confidently
wrong. GitHub's merge button remains the authority.

## 1. Dispositions

| Disposition | Meaning |
|---|---|
| `NEEDS_MASON` | an owner decision is genuinely required |
| `AGENT_OWNS` | needs a coding session, not a decision |
| `WAITING_EXTERNAL` | no Mason action currently required; something else is in flight |
| `INDETERMINATE` | not computed by GitHub, reads disagreed, or state unresolved |
| `SCAN_ERROR` | patrol failed to look |
| `IDLE` | fully observed, conclusively nothing to do |

**`IDLE` is never a fallback.** It requires complete successful observation, empty `blockers`, and
empty actionable `alerts`. Every condition combination not explicitly matched by a rule below
resolves to `INDETERMINATE` (rule `*.fallback`).

## 2. Terms

| Term | Exact definition |
|---|---|
| **stable merge state** | two reads, at least `MIN_STABLE_INTERVAL_MS` apart, agreeing on `headRefOid`, `baseRefOid`, `mergeable`, and `mergeStateStatus`, accompanied by an independent compare observation. Anything else is not stable. |
| **checks green** | every required context resolved from the base ref's applicable rulesets has a successful conclusion at `headRefOid`, from a validated producer App identity. |
| **checks failing** | at least one required context concluded failure/timeout/action-required at `headRefOid`. |
| **checks pending** | at least one required context is queued or in progress and none is failing. |
| **checks unknown** | a required context is missing, skipped, neutral, cancelled, duplicated, or ambiguous, or the required-context set could not be resolved. Fails closed — never treated as green. |
| **CodeRabbit complete** | a status at `commits/<headRefOid>/statuses` with the exact expected context, created by the expected GitHub App id, in a terminal state. The chat-comment stamp is forgeable and is never accepted. |
| **valid Sol proof** | the fail-closed validator accepts a record from the canonical proof registry binding repo, PR, `headRefOid`, the reviewed base OID, diff fingerprint, verdict `CLEAN`, reviewer identity, and freshness. A proof whose reviewed base OID differs from the live `baseRefOid` is **stale**, even when the head is unchanged. File existence is never evidence. |
| **human activity** | a commit, review, or comment whose actor is not in `TRUSTED_BOT_ACTORS`. An actor that cannot be resolved is `ambiguous` and is **not** counted as human. |
| **stale** | no human activity for `STALE_DAYS` days. |

## 3. Constants

| Name | Value | Rationale |
|---|---|---|
| `STALE_DAYS` | 14 | two weeks with no human touch is an abandonment question |
| `MIN_STABLE_INTERVAL_MS` | 2000 | two reads inside this window can be served from one cache |
| `LEDGER_ARCHIVED_MS` | 604800000 (7 days) | a ledger untouched this long is history in `docs/loops/`, not a loop that just died |
| `SNAPSHOT_TTL_MS` | 900000 (15 min) | a report older than this may misdescribe a moving queue |
| `HEARTBEAT_OVERDUE_MS` | 5400000 (90 min) | 3× the intended 30-minute cadence |

## 4. Pull request rules (ordered; first match wins)

| # | Rule id | Condition | Disposition |
|---|---|---|---|
| 1 | `pr.scan_error` | this PR's observation carries an error | `SCAN_ERROR` |
| 2 | `pr.not_open` | `state !== 'OPEN'` | `IDLE` |
| 2a | `pr.parked` | a `hold`/`parked`/`on-hold`/`do-not-merge`/`blocked` **label** | `WAITING_EXTERNAL` |
| 3 | `pr.unstable` | merge state not stable, or `mergeStateStatus === 'UNKNOWN'` after bounded retry | `INDETERMINATE` |
| 4 | `pr.conflicted` | `mergeStateStatus === 'DIRTY'` | `AGENT_OWNS` |
| 5 | `pr.draft_stale` | `isDraft` and stale | `NEEDS_MASON` |
| 6 | `pr.draft_active` | `isDraft` | `AGENT_OWNS` |
| 7 | `pr.checks_failing` | checks failing | `AGENT_OWNS` |
| 8 | `pr.checks_pending` | checks pending | `WAITING_EXTERNAL` |
| 9 | `pr.review_pending` | CodeRabbit not complete and a review is in flight | `WAITING_EXTERNAL` |
| 10 | `pr.checks_unknown` | checks unknown | `INDETERMINATE` |
| 11 | `pr.behind` | `mergeStateStatus === 'BEHIND'` | `NEEDS_MASON` |
| 12 | `pr.blocked` | `mergeStateStatus === 'BLOCKED'` | `NEEDS_MASON` |
| 13 | `pr.stale` | stale | `NEEDS_MASON` |
| 14 | `pr.no_blockers_found` | `mergeStateStatus === 'CLEAN'` | `NEEDS_MASON` |
| 15 | `pr.fallback` | anything else | `INDETERMINATE` |

`blockers` accumulate independently of which rule matched — a missing or stale Sol proof, an
incomplete CodeRabbit review, or unknown checks are recorded on the item even when an earlier rule
determined the disposition. Because `IDLE` requires empty blockers, a blocker can never coexist
with an all-clear.

Rule 14 is phrased as a negative claim: "no blockers found — the merge decision is yours." It is
not an assertion of readiness.

**Rule 2a is labels only, and that is a security property — not a style choice.** A pull
request title is written by whoever opened the pull request, so honouring `PARKED` in a title
would let any contributor move their own pull request out of the actionable lane. Applying a
label requires write access, so it carries authorization a self-authored title does not. Do not
"align" this rule by re-adding title matching.

## 5. Loop rules

| # | Rule id | Condition | Disposition |
|---|---|---|---|
| 1 | `loop.scan_error` | observation error | `SCAN_ERROR` |
| 2 | `loop.dead` | ledger claims active, no matching process, heartbeat overdue | `NEEDS_MASON` |
| 3 | `loop.stalled` | matching process, ledger not advancing beyond threshold | `NEEDS_MASON` |
| 4 | `loop.orphaned` | process matches no known ledger | `INDETERMINATE` |
| 5 | `loop.progressing` | ledger advancing | `WAITING_EXTERNAL` |
| 6 | `loop.alive` | process alive, advance not yet observable | `WAITING_EXTERNAL` |
| 7 | `loop.finished` | ledger marked complete, nothing claims to run | `IDLE` |
| 7a | `loop.archived` | ledger untouched for over `LEDGER_ARCHIVED_MS` | `IDLE` |
| 8 | `loop.fallback` | anything else | `INDETERMINATE` |

`loop.archived` is decided before any process evidence. A ledger nobody has touched in a
week is history sitting in `docs/loops/`, not a loop that just died; without this window
the first live run put twelve ledgers from July in front of Mason as "stalled".

A process is attributed to the **longest** worktree path it names, at a path boundary.
The main checkout is a prefix of every nested worktree, so a bare substring test credits
every nested process to the parent and marks all of the parent's ledgers as live.

A dead or stalled loop is reported, never restarted — restarting is Mason's call after he sees
what it was doing.

## 6. Worktree rules

| # | Rule id | Condition | Disposition |
|---|---|---|---|
| 1 | `worktree.scan_error` | observation error | `SCAN_ERROR` |
| 2 | `worktree.dirty` | uncommitted changes present | `AGENT_OWNS` |
| 3 | `worktree.unmerged_stale` | not merged, no open PR, stale | `NEEDS_MASON` |
| 3a | `worktree.unmerged_active` | not merged, no open PR, recently worked on | `AGENT_OWNS` |
| 4 | `worktree.merged_clean` | merged into origin/main, clean | `IDLE` (cleanup alert, non-actionable) |
| 5 | `worktree.unmerged_tracked` | not merged, has an open PR | `IDLE` (the PR item carries it) |
| 6 | `worktree.fallback` | anything else | `INDETERMINATE` |

Rule 4 raises a **non-actionable** cleanup alert only. Cleanup deletions while work is in flight
are forbidden, so merged worktrees are batched into one deliberate pass, never surfaced as urgent.

## 7. Parked migrations

Reported as **one aggregate item**, never one item per migration — 17 individual entries would
flood the report and none of them is independently actionable from patrol's evidence.

| # | Rule id | Condition | Disposition |
|---|---|---|---|
| 1 | `parked.scan_error` | observation error | `SCAN_ERROR` |
| 2 | `parked.present` | count > 0 | `NEEDS_MASON` |
| 3 | `parked.none` | count === 0 | `IDLE` |

Patrol reports the count and names only. It never reports a migration as ready to apply — that
requires ledger, exact SQL hash, review, ordering, and rollback proof it does not collect.

## 8. Gate health

| # | Rule id | Condition | Disposition |
|---|---|---|---|
| 1 | `gate.scan_error` | probe failed | `SCAN_ERROR` |
| 2 | `gate.down` | probe reports exhausted credits, rate limit, or spend cap | `NEEDS_MASON` |
| 3 | `gate.unknown` | probe inconclusive or stale | `INDETERMINATE` |
| 4 | `gate.healthy` | probe fresh and healthy | `IDLE` |

"Gate down" and "gate says no" are different outcomes; only one means there is something to fix.

## 9. Severity

Used solely to rank hidden items so nothing starves. Higher is more urgent.

| Band | Value | Applies to |
|---|---|---|
| critical | 90 | `SCAN_ERROR`, dead loop, **stalled loop**, gate down |
| high | 70 | conflicted PR, failing checks |
| normal | 50 | behind, blocked, no-blockers-found, parked migrations |
| low | 30 | stale abandonment questions, dirty worktrees |
| info | 10 | `IDLE` with a non-actionable alert |

Ties break by `firstSeenAt` ascending, then by item id, so ordering is deterministic. Items hidden
by the display cap gain +1 severity per full day hidden.

## 10. All-clear condition

The renderer emits the exact phrase `Nothing waiting on you` only when **all** hold:

1. snapshot `complete === true` and every source `OK`
2. snapshot not expired at emission time
3. zero `NEEDS_MASON` items
4. zero `SCAN_ERROR` items
5. zero `INDETERMINATE` items
6. zero hidden items
7. zero actionable blockers and zero actionable alerts, globally

Any other state prints what could not be determined. The phrase is produced by the renderer alone;
no language model can emit, alter, or suppress it.
