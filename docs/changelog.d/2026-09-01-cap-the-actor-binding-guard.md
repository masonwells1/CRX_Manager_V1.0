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
documented as a **speed bump, not a boundary**, with its gaps enumerated, and the load-bearing protections
named in order: the post-apply sweep predicates against the live catalog, the exact-SHA `gpt-5.6-sol`
proof on migration diffs, and the CodeRabbit final review.

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

### Proof observed

- Live ledger re-read at cap time: 980 rows, ordering high-water `20260826222000`.
- Live catalog: `select count(*) … pg_proc where proname='get_ap_aging'` → 1 overload; `prosrc` contains
  `days_1_30` and `due_date`; `prosecdef = true`; `proconfig = {search_path=public, pg_temp}`.
- PR #449 finding census via the GraphQL `reviewThreads` query filtered on
  `isResolved==false AND isOutdated==false`: 23 live, of which 16 created 2026-09-01.
- `npm run check:docs` passes.
