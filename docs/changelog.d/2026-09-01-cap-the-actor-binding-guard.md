## 2026-09-01 — the write-time actor-binding guard is capped as best-effort, and says so

Mason asked for at least two more adversarial rounds on PR #449's actor-binding guard, then to park it
if issues remained. Both rounds ran, both found real bypasses, and the decision is to **cap** the guard
rather than fund a round 4. This entry records the cap and corrects the documents that overstated it.

**What the guard is for.** CRX records who performed each action, and some of those entries reach the
immutable `financial_audit_log`. A `SECURITY DEFINER` routine that accepts a caller-supplied actor and
writes it unchecked lets any signed-in user attribute a write to somebody else — which is exactly what
`link_blend_ticket_to_order` / `unlink_blend_ticket_from_order` did until migration `20260617171500`.
`.claude/hooks/actor-binding-check.mjs` moves that check to write time so the forgery is refused rather
than detected after it ships.

**What changed.** Nothing in the hook, on this branch. What changed is the claim made about it. It is now
documented as a **speed bump, not a boundary**, with its gaps enumerated and the load-bearing protections
named — but **not uniformly**, because they differ by residual. For the **lexical** gaps the compensating
controls are the post-apply sweep predicates against the live catalog, the exact-SHA `gpt-5.6-sol` proof,
and the CodeRabbit review. For the **re-binding and laundering** gaps and the **naming-scope gap**
(`p_target_id`-shaped parameters) the sweeps are **not** a compensating control — they are gated on
`prosrc !~* 'ACTOR_MISMATCH'` and key on the same actor-name pattern, so they share those blind spots
rather than covering them; only the Codex proof and the CodeRabbit review stand there. See the review
round below, which is where that correction came from.

That distinction was itself a CodeRabbit finding on the first draft of this entry: the draft claimed the
residual required clearing the sweep, which is false for the naming-scope path. Worth recording, because it
is precisely the failure this change exists to document — a compensating control asserted rather than
verified, in a document about asserting controls rather than verifying them.

**Why capping is the right call, from evidence rather than fatigue.** Two independent agents closed **19
laundering channels** across two rounds, each reproduced by running the real hook and each fix
mutation-tested red-then-green. Round 1 closed 12, then probed its own repair and found 4 more — one it
had introduced with its own fix. Round 2 probed round 1's repair with 87 payloads and found 7 more across
4 previously-unseen root causes. Open findings on the PR went 10 → **23** (16 dated 2026-09-01, i.e. new
objections to the fixes). The guard genuinely improved while the finding count went backwards.

The decisive finding: PostgreSQL needs no whitespace before a quoted identifier, so
`CREATE OR REPLACE FUNCTION"public"."f"(` is valid SQL the guard **never matched** — a ~3,000-line security
check that never ran on the routine at all. One lexical fact defeated **eight** independent regexes written
across three careful passes. That is a tool mismatch, not inattention: a regex encodes a guess about
tokenization, and a wrong guess in one place is wrong everywhere. A second root cause is structural — the
guard proves a **name**, and a PL/pgSQL parameter is an ordinary local, so `p_performed_by := p_target_id;`
after a passing check re-forges the actor.

**Also corrected here:** `KNOWN_ISSUES.md` still carried a 978-row ledger header. Two Section 9 AP
migrations were applied live on 2026-09-01 under Mason's explicit approval and through the full apply gate,
taking the ledger to **980 rows** with effective ordering high-water `20260826222000`. Verified post-apply
against the live catalog: one `get_ap_aging` overload, `days_1_30` present, buckets keyed on `due_date`,
`SECURITY DEFINER` and `search_path` intact.

**The generalisable lesson, recorded because it recurred seven times in ~24 hours.** Seven guard comments
were found asserting safety properties their code did not have, and **every one overclaimed** — none
understated. Three were in this hook alone, including *"Non-mutating functions are never flagged"*, which a
test in the same file already disproved. Overclaiming a control is worse than having no control, because it
stops the next reader checking and stops anyone building the real one. The ratchet worth writing: **for each
guard, assert its refusal text and header comments do not claim a safety property the test suite has not
demonstrated.**

**Left open deliberately.** PR #449 is parked, not abandoned — it holds the 19 closed bypasses and is worth
landing after one clean review round, as an improvement to a capped control rather than a resumed hardening
programme. A third, unpushed regex attempt exists locally at `codex/actor-binding-guard-recut-20260831`
(no PR) and duplicates one of #449's fixes; it should be deleted rather than continued. If the guard is ever
rebuilt, use PostgreSQL's own grammar (`libpg_query`) rather than more patterns — that removes the lexical
category entirely, though it still does not solve the naming-scope limit.

### Review round — the cap was itself overclaiming

Four live review findings, all the same defect the entry exists to fix: the first draft credited the
post-apply sweep predicates with catching residuals they do not catch. Every claim below was verified
against `scripts/db-invariant-sweeps/predicates/actor-forgery.sql`, `-fin-audit.sql`, and the running
`.claude/hooks/actor-binding-check.mjs` before editing.

1. **Re-binding is invisible to the sweeps, not merely to the hook.** Both predicates select only where
   `prosrc !~* 'ACTOR_MISMATCH'`. A routine that performs a legitimate-looking binding check and then runs
   `p_performed_by := p_target_id;` is therefore excluded from both sweeps *by the presence of the check it
   defeated*. The draft listed re-binding among the residuals the sweep compensates for. It does not.
2. **Temp-table laundering evades both predicates for a second, independent reason.** `actor-forgery.sql`
   requires the actor parameter near `coalesce`/`auth.uid`/role text; `-fin-audit.sql` requires it after
   `financial_audit_log` *before the next semicolon*. Stashing the parameter in a temp table in one
   statement and inserting it into the audit log in another satisfies neither sink test.
3. **The `hasMutation` trigger is not in the running hook.** The active guard is **213 lines** and contains
   no `hasMutation` logic; that trigger — and the incidental `EXECUTE … USING` / `INSERT … RETURNING … INTO`
   coverage attributed to it — exists only in **parked PR #449**, whose hardened rewrite is the ~3,000-line
   version (3,172 lines) the entry refers to elsewhere. Three documents credited the *active* guard with
   *parked* behavior, which is precisely the failure this change was written to stop.
4. **The ordinary incremental-`Edit` path is not covered at all.** The hook reads
   `tool_input.content || tool_input.new_string` and analyses that fragment alone; unlike `sql-safety.mjs`,
   `idempotency-body-check.mjs` and `status-enum-check.mjs`, it does not reconstruct the full post-edit file
   via `edit-splice-lib.mjs`. An `Edit` inserting an unsafe write *inside* an existing function presents no
   function header, no parameter list and no `SECURITY DEFINER` attribute, so the guard finds no candidate
   and allows. The hook's own Edit-coverage test passes a whole function as `new_string`, so it never
   exercises the normal editing path. Added as a gap row; the claim "catches every ordinary spelling" was
   withdrawn, because this *is* the ordinary path.

The residual list is now three items rather than two — lexical, re-binding/laundering, naming-scope — with
the compensating controls stated per item instead of collectively.

### Second review round — the same partial-fix pattern, twice more

Codex and CodeRabbit independently reported the SAME defect, which is the strongest signal available that
it was real: the gap table's cross-routine row had been corrected to say neither sweep predicate follows a
helper call, while the control-mapping bullet directly below it still grouped that row with the
sweep-covered ones. The row and the mapping that cites the row disagreed inside one section.

That is the third instance in this PR of one pattern: **the cited line gets fixed and its siblings do not.**
It is worth naming as the operative lesson, because partial compliance reads as compliance — a reader who
stops at the summary, the header, or the mapping takes away a protection that the detail below explicitly
denies. The fix discipline is to sweep the CLAIM across every document, not to patch the line the reviewer
pointed at.

Corrected in this round:

- **Cross-routine / cross-migration helpers moved out of the sweep-covered category entirely.** Verified
  rather than assumed: `actor-forgery.sql` needs actor/`auth.uid`/role proximity inside the *wrapper's own*
  `prosrc` and `-fin-audit.sql` needs the parameter and the `financial_audit_log` sink in that same source,
  but the wrapper only passes the parameter onward — and a private helper is not even a candidate, because
  both predicates require `has_function_privilege('authenticated', ...)`. Only the Codex proof and the
  CodeRabbit review cover this path.
- **The status paragraph no longer credits the ACTIVE hook with PR #449's strength.** It read as though the
  running guard were "materially stronger after PR #449's two rounds" and then said those rounds are parked.
  Now: the active 213-line guard is unchanged; the parked #449 rewrite is the stronger one.
- Swept the two sibling documents for the same claim and closed the gap in both — `agent-guardrails.md` had
  left cross-routine unmapped to any control, and `DECISION_LOG.md` had no cross-routine note at all.

Three findings from the previous round were re-listed against this head by line-anchor drift
(`CURRENT_STATE.md` header, `migration-history.md` rows 901–902, the Section 9 narrative). All three were
verified as already fixed in the current head before being set aside — the anchors moved, the claims did not
survive.

### Reconciled the applied-live state everywhere, not just here

Recording the two Section 9 migrations as applied left `docs/manual/CURRENT_STATE.md` and
`docs/reference/migration-history.md` (rows 901, 902) still saying **PENDING — NOT APPLIED LIVE**, while
`KNOWN_ISSUES.md` itself says the source documents win on disagreement. A rollout session reading the
canonical pair would have planned against the wrong production state.

Re-verified read-only on 2026-09-01 before editing, rather than copying this PR's own prose:

- `list_migrations` → **980 rows**, with `20260826221000_bind_section9_ap_receiving_intent_and_month_dashboard`
  and `20260826222000_correct_ap_aging_due_date_buckets` as the two newest entries. Searching by `version`
  finds neither: the ledger's version column carries the apply-time stamp (`max(version)` `20260901045346`),
  so ordering must be read from the authored NAME.
- Live catalog → `get_ap_aging` has exactly one overload taking `p_as_of_date` and returning the five-bucket
  due-date contract (`current_amount`, `days_1_30`, `days_31_60`, `days_61_90`, `over_90`,
  `total_outstanding`, `bill_count`), `SECURITY DEFINER`, `search_path=public, pg_temp`;
  `get_ap_dashboard_summary` takes `p_idempotency_key` and keys on `due_date`. The prior claim that both
  "remain" the four-column bill-date and rolling-30-day implementations is false as of the apply.

Dated changelog and audit-handoff files that describe the pre-apply state were left alone — they are
point-in-time records, not current-state documents.

### Proof observed

- Live ledger re-read at cap time: 980 rows, ordering high-water `20260826222000`.
- Live catalog: `select count(*) … pg_proc where proname='get_ap_aging'` → 1 overload; `prosrc` contains
  `days_1_30` and `due_date`; `prosecdef = true`; `proconfig = {search_path=public, pg_temp}`.
- PR #449 finding census via the GraphQL `reviewThreads` query filtered on
  `isResolved==false AND isOutdated==false`: 23 live, of which 16 created 2026-09-01.
- `npm run check:docs` passes.
- Review-round verification (2026-09-01): `grep -c hasMutation .claude/hooks/actor-binding-check.mjs` → 0
  and `wc -l` → 213, against 3,172 lines on PR #449's head `7a38e9eb`; `actor-binding-check.mjs:111` reads
  `payload?.tool_input?.content || payload?.tool_input?.new_string` with no `edit-splice-lib` import; both
  sweep predicates carry `WHERE prosrc !~* 'ACTOR_MISMATCH'`.
