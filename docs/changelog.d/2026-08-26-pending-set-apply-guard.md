## 2026-08-26 — the apply guard now asks whether an OLDER migration is still waiting

`checkMigrationOrdering()` only ever compared a candidate against what was ALREADY APPLIED.
Nothing looked at what was WAITING, so an apply could legally advance the live ledger's
high-water past a tracked, unapplied migration and the guard raised no objection — the
refusal surfaced later, aimed at the innocent party. That is exactly what happened this
morning: `20260826150000_fix_save_job_comment_refusal_count` applied at 20:59:35Z while
`20260825190000_quote_version_restore_trust_boundary` was merged to main and still unapplied,
which pushed the security migration below the high-water and made it mechanically
unappliable. It was the second time that file was stranded — it had already been renumbered
once from `20260813180000` for the same reason (PR #401). Renumbering is not a fix; it is the
cost of a check that runs too late.

New `.claude/hooks/migration-pending-lib.mjs` adds a pending-set preflight to
`evaluateMigrationApply()`, so both doors get it — the MCP `apply_migration` hook and
`scripts/apply-migration-file.mjs`. It refuses an apply while an older-stamped,
tracked-but-unapplied migration exists on origin/main, and fails closed on every unknown
(unreadable `origin/main`, empty tracked set, missing or malformed schema-baseline manifest,
untimestamped candidate) using the same abstain-and-let-the-caller-refuse contract as the
ordering check. The override is a DELIBERATELY separate marker —
`-- ordering-guard: ahead-of-pending <reason, 8+ chars>` — because "I am replaying an old
file" and "I am stepping over the queue" are different decisions, and one marker meaning both
degrades into "whatever unblocks the guard". The replay marker does not unlock it; that is a
pinned test.

Two scoping rules, both forced by measurement rather than taste. Against the real ledger
(977 rows) and origin/main (892 files), the naive definition of pending — a file whose
14-digit stamp is absent from the ledger — returns **448 files**, essentially all of them
applied. Renumbered migrations are recorded with the new stamp as the row `version` and the
OLD stamp inside the row `name`, and the snapshot keeps `name`, so their stamps can never
agree; the migration SLUG does, so a file counts as applied on stamp OR slug. Pre-baseline
history carries hand-written and impossible stamps (`20260332000000` — month 33) applied
under unrelated versions, so the scan starts above `migrations_high_water` from
`supabase/baselines/manifest.json`, the same floor `scripts/list-post-baseline-migrations.mjs`
already uses. With both rules the pending set on 2026-08-26 is exactly one file:
`20260825190000_quote_version_restore_trust_boundary.sql` — the correct answer, and the file
the incident stranded. Stated residual: a genuinely unapplied migration at or below the
baseline high-water is invisible to this check; the baseline asserts there are none.

**The queue is not just origin/main** (Codex P1). `.claude/commands/ship.md` applies a
migration at Step 5, while it is still uncommitted and unmerged, and does not
`git fetch origin` until Step 6. An origin/main-only listing therefore missed an older
sibling authored in the same checkout — the ship flow's own normal state — and anything
merged since the last fetch. Both return `allow` and recreate the stranding. The tracked
set is now the UNION of origin/main, the active branch's HEAD, and the working tree, and
main's freshness is CHECKED rather than hoped for: `originFetchAgeMs()` reads FETCH_HEAD's
mtime (resolving a linked worktree's `.git` file to the common dir), and a fetch older than
30 minutes — or one that cannot be dated at all — refuses with the command to fix it. That
window matches `PROOF_MAX_AGE_MS`, so it costs one `git fetch` inside a sequence the
operator is already performing. Proven live: with a stale ref the guard reported one pending
migration; after `git fetch origin` it reported the renumbered `20260826220000` that another
session had merged in the interim, which the stale ref could not see.

**Git calls must fit inside the hook's own budget** (CodeRabbit). The Codex harness allowed
this hook 5 seconds while its git calls were given 10s + 15s + 10s. A hook killed mid-call
emits nothing, and a PreToolUse hook that emits nothing does not deny — so an over-long git
timeout is a fail-OPEN on a live apply, not a courtesy. All git calls in the module now share
`GIT_CALL_TIMEOUT_MS` (1.5s), and the Codex hook budget is raised to 15s to match Claude's.

The slug fallback is sound only when a slug names exactly ONE tracked file (Codex P2 on the
PR). Two files sharing a slug with only one in the ledger makes "this slug is applied" true of
the pair and false of the individual, so an unconditional match marked the unapplied one as
applied and deleted it from the pending set — stranding it, the exact failure the guard
exists to prevent. Duplicate slugs are already real history here
(`20260718225511`/`20260718230000_supplier_price_evidence_phase1b` and two more pairs), all
below the baseline today, so this was latent rather than live.

Blanket-abstaining on any shared slug was the wrong correction, though, and Codex caught that
too on the next round: if one twin matched by its own exact stamp, that ledger row is spoken
for and the OTHER twin is *definitively* pending, not unknown. Abstaining there is both less
accurate and unfixable — renaming the candidate cannot resolve a pair the candidate is not
part of. So the check now ATTRIBUTES rather than answers yes/no: one ledger row bearing a slug
vouches for exactly one file, rows already claimed by an exact-stamp match are spent, and the
remainder is arithmetic — enough spare rows means applied, zero spare means definitively
pending, and only in between is it genuinely ambiguous. A real ambiguity abstains and names
the files; the `ahead-of-pending` marker deliberately does NOT unlock it, because that marker
states an intent about a queue the operator can see, and this queue cannot be seen. The remedy
the message gives is a distinct slug, not a marker.

Mutation-tested, not merely observed passing: removing the slug fallback, letting the replay
marker unlock the guard, and turning an abstention into a silent pass each turn the suite red,
and the incident sequence is reproduced end-to-end through the real gate in both
`migration-pending-lib.test.mjs` (41 assertions) and `migration-apply-lib.test.mjs`
(123 → 144 from this change alone; the suite totals 161 — 155 after merging `main`, which
added its own cases, plus 4 for the fetch-instruction directory and 2 for the failed-lookup
refusal below). The two subprocess fixtures now build a real `origin/main` with a
GIT_*-scrubbed env rather than stubbing the lookup, so the second door's git path is
genuinely exercised.

**A failed worktree lookup must refuse, not fall back** (Codex P1). `git worktree list` was
invoked twice — once for the proof directories, once for the pending-queue root — so the
FIRST call could succeed while the SECOND transiently failed. `resolveSessionWorktree()`
swallows its own errors and returns `null`, which is indistinguishable from "no worktree
matched", so the queue scan silently fell back to the PRIMARY checkout. The guard then
accepted the reviewer proof from the active worktree while scanning a different tree for the
queue: an older migration living only in the session worktree was invisible, and the apply
returned `allow` and stranded it — the exact failure this guard exists to prevent, reached
through the guard's own fallback. Codex reproduced the sequence.

The comment above that fallback claimed it "fails closed". It did not, and that is the part
worth remembering: **a guard whose comment asserts a safety property the code does not have is
worse than one with no comment**, because the next reader stops checking. Three guards drifted
this way in two sessions on 2026-08-31, and every drift overclaimed.

The listing is now memoised, so there is only one call and the two consumers cannot disagree —
the race is closed structurally rather than patched at one call site — and a listing failure is
recorded so the queue scan REFUSES. A clean listing that matches nothing still legitimately
means the primary checkout, which is the distinction the old code could not express. Fixed
without touching the blob-pinned shared library. Mutation-proven: disabling the check returns
`allow` on a failed listing, reproducing Codex's reported symptom exactly.

**The refusal must name the directory it measured** (CodeRabbit). Freshness is read from
`queueRoot` — the session's linked worktree when one resolves — but both fetch-age refusals,
and the origin/main listing failure, told the operator to run `git fetch origin` in
`projectDir`. `git fetch` inside a linked worktree writes THAT worktree's own `FETCH_HEAD`,
and `originFetchAgeMs()` prefers it over the common-dir copy. So an operator in a linked
worktree would fetch in the primary checkout, the measured `FETCH_HEAD` would stay old, and
the retry would return the identical refusal — forever, with nothing in the message to
explain why. A guard whose stated remedy does not work is worse than one that says nothing,
because it burns the operator's trust on the way to burning their time. All three messages
now name `queueRoot`. This was invisible to every existing test because they stub
`gitWorktreeList` to empty, which makes `queueRoot === projectDir`; the new cases build a
linked worktree so the two differ, and they fail against the old message.
Separately: `migration-ordering-lib.test.mjs` existed but was wired into no npm script and had
never run in CI — both it and the new suite are now in `test:correction-guards`.
