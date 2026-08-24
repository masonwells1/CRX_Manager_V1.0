---
name: deploy-check
description: Pre-merge checklist for CRX Manager — verifies a branch is safe to land. Since `main` is protected (2026-07-14), landing means branch → PR → checks → CodeRabbit → merge, and the merge is what deploys production via Vercel. Use before opening or merging a PR, or before applying migrations to Supabase.
---

# Pre-Deployment Check

A final gate before landing work on `main`. Checks code quality, unapplied migrations,
environment safety, and production readiness.

**How production actually deploys (updated 2026-07-14).** `main` is protected by the GitHub
`protect-main` ruleset, so **direct pushes to `main` are impossible for everyone** — Claude,
Codex, and Mason alike. The landing path is:

**push a branch → open a PR → checks pass (Vercel is a required check) → read and resolve
CodeRabbit's automated review → merge.** The **merge** is what deploys production via Vercel's
git integration; Vercel's one-click rollback is the accepted safety net.

Run this skill on the branch **before** opening the PR (and again before merging if the branch
moved).

## Step 1: Git Status

```bash
git status && git log --oneline -5
```

```bash
git fetch origin && git rev-list --left-right --count origin/main...HEAD
```

Check:
- Are there uncommitted changes? (WARN — should commit first)
- Are we on a **feature branch**? Being on `main` is the problem case here, not the goal — work
  cannot land from `main` because direct pushes are blocked. If HEAD is `main`, tell the user to
  branch first.
- Is the branch behind `origin/main`? (WARN — rebase or merge before opening the PR, or the
  reviewed diff and the Vercel check will not reflect what actually lands.)
- What was the last commit? (Show it to the user)

## Step 2: Code Quality Gate

Run these in sequence:

```bash
npm run lint && npm run typecheck && npm run build
```

ALL THREE must pass. If any fail, stop and report — do not proceed to deployment.

## Step 3: Unit Tests

```bash
npm run test -- --reporter=verbose 2>&1 | tail -20
```

Must have 0 failures. Report test count and any failures.

## Step 4: Check for Unapplied Migrations

```bash
# Count local migration files
echo "Local migrations: $(ls supabase/migrations/*.sql | wc -l)"
```

Compare against the live database (Supabase MCP `list_migrations`). If there are NEW migrations that haven't been applied to the live database yet, WARN the user:

```
⚠️  You have X new migration(s) not yet applied to production.
    Apply them through /migration-review → apply_migration BEFORE
    deploying (interactive: Mason's in-chat OK required), or the app
    will reference tables/columns/functions that don't exist yet.
    NEVER `supabase db push` — it bypasses the review gate and is blocked.
```

## Step 5: Environment Check

Verify no secrets are exposed:

```bash
# Check for .env in git tracking
git ls-files | grep -i "\.env"
# Check for hardcoded keys in source
grep -r "service_role" src/ --include="*.ts" --include="*.tsx" -l
grep -r "sk_live\|sk_test\|SUPABASE_SERVICE" src/ --include="*.ts" --include="*.tsx" -l
```

If any results, BLOCK deployment and report.

## Step 6: Bundle Size Check

```bash
# Build already ran in step 2, check the output size
ls -lh dist/assets/*.js 2>/dev/null | head -5
```

Report the largest JS chunks. Warn if any single chunk is > 500KB.

## Step 7: Deployment Summary

```
╔══════════════════════════════════════════╗
║     PRE-DEPLOYMENT CHECK COMPLETE        ║
╠══════════════════════════════════════════╣
║                                          ║
║  Branch:          <feature branch>       ║
║  Behind origin/main: X commits           ║
║  Clean working tree: YES / NO            ║
║  Last commit:     <hash> <message>       ║
║                                          ║
║  Lint:            PASS                   ║
║  TypeScript:      PASS                   ║
║  Build:           PASS                   ║
║  Tests:           X/Y passed             ║
║  Secrets exposed: NONE                   ║
║  Unapplied migrations: X                 ║
║  Largest bundle:  XXX KB                 ║
║                                          ║
║  Verdict: READY FOR PR / BLOCKED         ║
╚══════════════════════════════════════════╝
```

If ready, state the remaining landing steps explicitly — this skill does **not** land anything:

1. Push the **branch** (never `main` — the `protect-main` ruleset rejects it).
2. Open a PR.
3. Wait for checks; **Vercel is a required check**.
4. **Read CodeRabbit's automated review and fix every real issue it raises** (standing policy,
   Mason 2026-07-17). CodeRabbit reviews every PR on the public repo, is advisory rather than
   blocking, and its nitpicks may be dismissed with a one-line reason. It is the broad every-PR
   pass; a separate exact-SHA `gpt-5.6-sol` high-effort proof remains the hard gate for risky
   money/RLS/migration diffs — both run, neither replaces the other.
5. **Confirm the review actually covered the FINAL commit.** Auto-review pauses after 2 reviewed
   commits (`.coderabbit.yaml`), and a rate-limited PR can silently skip a review entirely — PR
   #429 (21 commits) and PR #434 both posted "Review limit reached". A review of an earlier commit
   is **not** a review of what you are about to merge. Bind the proof to the **head SHA**. Nothing
   else counts — see "What never counts" below.

   **Refresh a stale branch BEFORE requesting the review, never after.** If `mergeStateStatus` is
   `BEHIND`, the merge guard refuses the merge outright (it requires `CLEAN`), so `gh pr
   update-branch <n>` is not optional — and it creates a merge commit that MOVES the head, voiding
   any review you already paid for. Order: check state → update-branch if behind → re-read the head
   → only then `@coderabbitai review`. Reversing those two steps burns a review attempt against the
   allowance for nothing. Learned on PR #441 and FarmRx #26, 2026-08-20.

   ```bash
   gh pr view <n> --repo masonwells1/CRX_Manager_V1.0 --json headRefOid,mergeStateStatus --jq '.'
   ```

   **The merge-only head has no stamp and never will.** When `update-branch` contributes no new PR
   changes, CodeRabbit answers "No files to review." and emits no range line for that SHA, so a
   SHA-bound gate can never pass no matter how often you re-trigger it. In that one case, prove
   **tree identity** instead — that the merge commit contributed nothing of its own, so the reviewed
   commit's content is exactly what lands. Three checks, all fail-closed:

   Each check **asserts** and fails closed — none of them merely prints a value for you to eyeball.
   Substitute the reviewed SHA, the head SHA, and the base SHA; all are 40-char hex from the GitHub
   API, never PR-authored text. Take the base from the PR itself, and `git fetch origin` first so
   the SHA exists locally:

   ```bash
   gh pr view <n> --repo masonwells1/CRX_Manager_V1.0 --json baseRefName,baseRefOid --jq '.'
   ```

   All three checks must print their marker.

   **Do not compare the parent to a SHA you typed in — and do not retype it between commands
   either.** Derive it and consume it inside the *same* command, so the value the review gate is
   checked against is mechanically the value `git rev-parse` produced, with no step in the middle
   where a different SHA could be substituted. Shell state does not survive between commands here,
   so each check re-derives the parent rather than relying on an earlier one:

   ```bash
   PARENT1="$(git rev-parse <HEAD>^1)" && echo "parent: $PARENT1" && gh api --paginate repos/masonwells1/CRX_Manager_V1.0/pulls/<n>/reviews --jq ".[] | select(.user.login==\"coderabbitai[bot]\" and .submitted_at != null and .state != \"DISMISSED\" and .commit_id == \"$PARENT1\") | \"REVIEW_OBJECT_BINDS_PARENT \(.id)\""
   ```

   ```bash
   PARENT1="$(git rev-parse <HEAD>^1)" && gh api --paginate repos/masonwells1/CRX_Manager_V1.0/issues/<n>/comments --jq '.[] | select(.user.login=="coderabbitai[bot]") | select(.body | contains("<!-- This is an auto-generated comment: summarize by coderabbit.ai -->")) | select((.body | contains("auto-generated reply by CodeRabbit")) | not) | .body' | grep -oE "^> [A-Za-z ]*[Ff]iles that changed from the base of the PR and between [0-9a-f]{40} and $PARENT1\.$"
   ```

   ```bash
   PARENT1="$(git rev-parse <HEAD>^1)" && gh api repos/masonwells1/CRX_Manager_V1.0/commits/$PARENT1/statuses --jq '[.[] | select(.context=="CodeRabbit")] | first | "\(.state) \(.created_at)"'
   ```

   **The parent's status must be SETTLED by the same rule as the head — a single `success` is not
   terminal for it either.** Run that command, wait 90s, run it again, and require identical
   `success <timestamp>` both times; then run it once more immediately before merging and require
   that *same* `created_at`. A bare one-shot `success` check on the parent is exactly the
   intermediate-success hole the head procedure exists to close: the parent already carries its
   walkthrough stamp during that window, because the stamp is written when a review STARTS, so a
   no-op merge could pass every tree check and land before CodeRabbit finished generating findings.
   Codex flagged this as High on PR #441 and was right — an earlier revision tested the parent with
   one `= "success"` while the file two hundred lines below documented why that is not terminal.
   Observed live on this very branch the same day: heads `30e6cbee` and `26bc5e0f` each got a
   `success` "Review completed" within ~20 seconds of the push, on a branch whose auto-review was
   paused — no review had run at all, and the real one only started minutes later.

   **And the parent needs the completed-review check too** — the stamp and a settled status can both
   sit on top of a review that failed, which is as true of a parent as of a head. Codex caught the
   asymmetry: an earlier revision ran only the stamp and the settled status against the parent and
   then called that the "full" gate, which was simply false. Same fail-closed structure, same markers,
   scoped to the parent's own review cycle, with the parent derived in the same command:

   ```bash
   PARENT1="$(git rev-parse <HEAD>^1)"; SINCE="$(gh api repos/masonwells1/CRX_Manager_V1.0/commits/$PARENT1/statuses --jq '[.[] | select(.context=="CodeRabbit" and .state=="pending")] | first | .created_at')"; if ! printf '%s' "$SINCE" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'; then echo BLOCKED_CANNOT_DETERMINE_PARENT_CYCLE_START; elif ! BODIES="$(gh api --paginate repos/masonwells1/CRX_Manager_V1.0/issues/<n>/comments --jq ".[] | select(.user.login==\"coderabbitai[bot]\") | select(.created_at >= \"$SINCE\") | .body")"; then echo BLOCKED_COMMENTS_FETCH_FAILED; elif printf '%s' "$BODIES" | grep -qE "Review failed|Review rate limited|Review limit reached"; then echo BLOCKED_PARENT_REVIEW_DID_NOT_COMPLETE; else echo NO_FAILURE_MARKER_PARENT_CYCLE; fi
   ```

   Only `NO_FAILURE_MARKER_PARENT_CYCLE` permits the merge; every `BLOCKED_…` marker stops it.
   ("No files to review" is deliberately absent from *this* pattern — it is the expected answer for
   the merge-only head that sent you down this path, and this scan covers the parent's cycle.)

   Together those run the *full* review gate against the derived parent — the canonical walkthrough
   stamp naming it, its own settled status, **and** proof its review actually completed — the same
   standard any head has to meet. The exception is then "a no-op merge of a parent that independently
   passes the normal gate", which is fail-closed, rather than "a no-op merge of whatever the operator
   calls reviewed".

   A placeholder the operator fills in is the weak form of this, whatever it is called. An earlier
   revision printed the parent in one block and looked it up as `<PARENT1>` in the next, which reads
   as derivation but is still two values joined by whoever is typing. CodeRabbit flagged it on
   PR #441 and was right — the binding has to be the shell's, not the reader's.

   An earlier revision wrote this as `test "$(git rev-parse <HEAD>^1)" = "<REVIEWED_SHA>"`, with
   `<REVIEWED_SHA>` supplied by whoever ran the procedure. Codex flagged that as High on PR #441 and
   was right: an unreviewed parent labelled `<REVIEWED_SHA>` passes all three tree checks, and since
   the merge commit itself deliberately carries no stamp, that path lands unreviewed code on `main`
   while looking like deterministic proof. A check whose input is an unverified human claim is not a
   proof — it is the claim, restated in shell.

   ```bash
   git merge-base --is-ancestor <HEAD>^2 <BASE_SHA> && echo ANCESTOR_OF_BASE
   ```

   Bind that check to the PR's exact `baseRefOid`, **not** to `origin/main`. `origin/main` is only
   as current as your last fetch, and it is the wrong ref entirely for a PR whose base is some other
   branch — the check would then pass against a branch the PR is not merging into. `baseRefOid` is
   the commit GitHub will actually merge onto, and it is the same base the merge guard binds its
   Codex proof to. Verified live on PR #441, 2026-08-20: base `af96e9b3`, `db41b6e6` confirmed as
   an ancestor of it.

   ```bash
   test "$(git merge-tree --write-tree <HEAD>^1 <HEAD>^2)" = "$(git rev-parse <HEAD>^{tree})" && echo MERGE_ADDED_NOTHING
   ```

   `^1` must be the exact reviewed commit; `^2` must already be an ancestor of the PR's base (so it
   introduces nothing unreviewed); and a clean merge of those two parents must reproduce
   `<HEAD>^{tree}` exactly, proving the merge commit smuggled in no edits of its own. A silent
   command is a FAILED check, never a passed one — if any marker is missing, stop.

   Both outcomes were verified live on PR #441, 2026-08-20. **Passing:** head `d0341104`, parents
   `497621f1` / `db41b6e6`, both trees `fc59b0f4` — a true no-op merge. **Failing:** head
   `f19a0af9`, whose merge hand-resolved a `DECISION_LOG.md` conflict; `MERGE_ADDED_NOTHING` did not
   print and the check correctly refused it. That is the whole point — a merge commit carrying human
   edits is not a no-op merge and must go back through a normal stamped review.

   Compare **trees, never filenames**. An earlier draft of this fallback listed changed filenames
   and compared per-file blob hashes; Codex flagged it as BLOCKED on two counts and was right on
   both. A blob hash says nothing about file **mode or type**, so a mode-only commit could turn a
   regular file into a symlink and still pass; and substituting a PR-controlled `<FILE>` into a
   shell command is a command-injection vector on a public repo, where any fork can choose the
   filename. `<HEAD>^{tree}` covers every path, mode, type, and object ID in one comparison and
   interpolates no attacker-controlled text.

   This applies **only** when the head moved solely by a no-op merge — a head carrying any real new
   commit still needs a real stamped review, and using it anywhere else is self-certifying.

   First capture the head, and capture it *before* requesting any review:

   ```bash
   gh pr view <n> --repo masonwells1/CRX_Manager_V1.0 --json headRefOid --jq .headRefOid
   ```

   CodeRabbit stamps every review with the exact range it examined — `between <base> and <head>` —
   and that line is the only SHA-bound proof it emits. It lands in **one of two places** depending
   on whether the review found anything, so check both and accept the head if either prints it
   (substitute the real 40-character SHA for `<HEAD>`):

   ```bash
   gh api --paginate repos/masonwells1/CRX_Manager_V1.0/pulls/<n>/reviews --jq '.[] | select(.user.login=="coderabbitai[bot]" and .submitted_at != null and .state != "DISMISSED" and .commit_id == "<HEAD>") | "REVIEW_OBJECT_BINDS_HEAD \(.id)"'
   ```

   ```bash
   gh api --paginate repos/masonwells1/CRX_Manager_V1.0/issues/<n>/comments --jq '.[] | select(.user.login=="coderabbitai[bot]") | select(.body | contains("<!-- This is an auto-generated comment: summarize by coderabbit.ai -->")) | select((.body | contains("auto-generated reply by CodeRabbit")) | not) | .body' | grep -oE "^> [A-Za-z ]*[Ff]iles that changed from the base of the PR and between [0-9a-f]{40} and <HEAD>\.$"
   ```

   **Read structured identity where it exists, and anchor hard where it does not.** The reviews
   query matches on `.commit_id`, a GitHub-populated field naming the commit the review was
   submitted against — it is not prose and a PR cannot influence it. An earlier revision matched
   `.body` against a bare `and <HEAD>` instead, and Codex returned High on that, correctly: review
   and walkthrough bodies are AI-generated text summarising **public PR content**, so a PR that
   contains the target SHA in a changed file could get that string echoed into a body and satisfy
   an unanchored grep with no review of that head having happened. Verified live on PR #441:
   `commit_id` is populated on all six CodeRabbit reviews and tracks the head each ran against.

   A clean review creates no review object at all, so the comments query is the only path for it
   and cannot use `commit_id`. It is anchored instead to the **entire canonical stamp line** —
   fixed prose, a 40-hex base, then the head, `^`/`$` bound — so a loose mention of the SHA
   anywhere in the body no longer matches. If CodeRabbit ever changes that wording the match stops
   and the gate blocks, which is the safe direction.

   **The two `select` filters on the comments query are a security control, not tidiness.** An
   earlier revision accepted the range line from *any* `coderabbitai[bot]` comment. `chat.auto_reply`
   is enabled in `.coderabbit.yaml`, and this is a public repo where anyone may comment on a PR — so
   a PR author could ask the bot to echo `and <head-sha>` back, and that chat reply would satisfy the
   gate with no review having happened. Codex returned BLOCKED on exactly this and was right. The
   filters keep only the canonical walkthrough comment, which carries the `summarize by
   coderabbit.ai` marker, and drop every conversational reply, which carries `auto-generated reply by
   CodeRabbit`. Measured live on PR #441, 2026-08-20: 9 bot comments on the PR, exactly 1 survives
   the filter.

   A review **with findings** creates a review object, so the range line is in the first. A **clean**
   review creates no review object at all — its range line exists only in the walkthrough comment,
   so the second is the one that matches. Both forms were verified live on 2026-08-20: CRX PR #441
   head `4e080bef` matched via `/pulls/.../reviews`, and FarmRx PR #26's clean head `9abaf18`
   matched via `/issues/.../comments`. Checking only one endpoint reports a reviewed head as
   unreviewed.

   **The comment stamp alone does not mean the review finished.** CodeRabbit writes the walkthrough
   range line when it *starts* on a SHA, so the `/issues/.../comments` match can appear while the
   review is still running — observed on this very PR at head `b0428b2d`, where the stamp was
   present, the `CodeRabbit` check still read `pending`, and six inline findings landed afterwards.
   A match on that endpoint therefore proves **identity only**; pair it with completion:

   ```bash
   test "$(gh api repos/masonwells1/CRX_Manager_V1.0/commits/<HEAD>/statuses --jq '[.[] | select(.context=="CodeRabbit")] | first | .state')" = "success" && echo CODERABBIT_COMPLETED_THIS_HEAD
   ```

   **Query the statuses of the head COMMIT, not the PR's check list.** `gh pr checks` reports
   whatever is current for the pull request; `commits/<HEAD>/statuses` returns only statuses GitHub
   has bound to that exact SHA, posted by CodeRabbit under its own credentials. A PR author cannot
   write one. That makes it the unforgeable half of the pair, and it fails closed — the assertion is
   silent unless the newest CodeRabbit status on that commit is `success`. Verified live on PR #441,
   2026-08-20 (statuses are returned newest-first, hence `first`).

   Do **not** use `gh pr checks <n> | grep -i coderabbit`: the grep prints the CodeRabbit row whether
   it says `pass` or `pending`, so skimming for the word reads a running review as a finished one.
   Even `--json name,bucket` for the bucket alone is weaker than the per-commit form, because it is
   not bound to the SHA you are about to merge.

   Two caveats keep this honest, and both were observed on PR #441 itself.

   **A `success` status proves CodeRabbit *processed* that SHA, not that it read anything.** FarmRx
   head `3beb6407`, where CodeRabbit answered "No files to review", still carries `Review completed /
   success`. Worse, an **auto-paused** branch stamps `success` on heads it never reviewed: at head
   `5a12433f` the status read `success` while the canonical walkthrough said **"Reviews paused"** and
   its newest range still ended at the previous head, `a649c484`. Trusting the status alone would
   have merged code CodeRabbit never opened.

   **`success` is not terminal — the status sequence is not monotonic.** CodeRabbit posts several
   statuses per run, and a `success` can sit *between* two `pending` ones. Measured on `5a12433f`:
   `queued 22:51:41 → in progress 22:51:43 → success 22:51:50 → in progress 22:51:54 → success
   22:59:14`. A poll that lands on the 22:51:50 entry reads a finished review that is still eight
   minutes from finishing.

   The stamp does not rescue this on its own: CodeRabbit writes the walkthrough range line when it
   **starts** on a SHA, so during that window the stamp names the head *and* the newest status reads
   `success` while findings are still being generated. Codex raised this as High on PR #441 and is
   right — an intermediate `success` must never authorize a merge.

   **Therefore require the status to be SETTLED, not merely successful.** Poll the newest exact-head
   status twice, at least **90 seconds apart**, and require `success` **both** times with the same
   `created_at`. The observed intermediate window was 4 seconds, so 90 gives ~20x margin; if
   CodeRabbit resumed, a newer `pending` will have displaced the `success` by the second poll.

   ```bash
   gh api repos/masonwells1/CRX_Manager_V1.0/commits/<HEAD>/statuses --jq '[.[] | select(.context=="CodeRabbit")] | first | "\(.state) \(.created_at)"'
   ```

   Run it, wait 90s, run it again; identical `success <timestamp>` on both is the settled signal.
   **Write that timestamp down.**

   Then re-read it once more immediately before merging — and the final read must show `success` at
   **that same `created_at`**, not merely "success now". A bare success check would pass on a
   *different* run that started and completed between your settle window and the merge, whose
   findings you have never read. Same state **and** same timestamp, or the merge does not proceed.

   **A stable `success` can sit on top of a review that FAILED. Check for that explicitly.** This is
   recorded, not theoretical: on PR #411 the check row read `CodeRabbit pass — Review completed`
   while CodeRabbit's own comment said "**Review failed** — An error occurred during the review
   process", and no findings were ever submitted; PR #402 showed the milder "Review rate limited"
   with the same green row (`docs/reference/gotchas.md`). The walkthrough stamp does not save you
   here either, because it is written when the review **starts** — so a review that stamps the head
   and then dies leaves every other check in this section passing. Scope the search to this head's
   own review cycle, using the OLDEST CodeRabbit status on the commit as the start of that cycle:

   ```bash
   SINCE="$(gh api repos/masonwells1/CRX_Manager_V1.0/commits/<HEAD>/statuses --jq '[.[] | select(.context=="CodeRabbit" and .state=="pending")] | first | .created_at')"; if ! printf '%s' "$SINCE" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'; then echo BLOCKED_CANNOT_DETERMINE_CYCLE_START; elif ! BODIES="$(gh api --paginate repos/masonwells1/CRX_Manager_V1.0/issues/<n>/comments --jq ".[] | select(.user.login==\"coderabbitai[bot]\") | select(.created_at >= \"$SINCE\") | .body")"; then echo BLOCKED_COMMENTS_FETCH_FAILED; elif printf '%s' "$BODIES" | grep -qE "Review failed|Review rate limited|No files to review|Review limit reached"; then echo BLOCKED_REVIEW_DID_NOT_COMPLETE; else echo NO_FAILURE_MARKER_THIS_HEAD; fi
   ```

   **Only `NO_FAILURE_MARKER_THIS_HEAD` permits the merge.** Every other outcome — including one that
   is nobody's fault, like a network blip or an expired token — prints a `BLOCKED_…` marker and stops
   the merge. That structure is the whole point of the command, and the first version got it exactly
   backwards: it ended `... | grep -qE "…" || echo NO_FAILURE_MARKER_THIS_HEAD`, so **any** failure of
   any stage fell through to the clean marker. It also passed `--arg` to `gh api`, which is a
   standalone `jq` flag that `gh api` rejects outright (`accepts 1 arg(s), received 4`) — so the probe
   never ran at all and unconditionally reported clean. CodeRabbit and Codex each flagged it
   independently. **A fail-open check is worse than no check, because it also reports success.**

   The second version fixed the fail-open but piped through a standalone `jq`, which **is not
   installed on this machine** — running it printed `BLOCKED_COMMENT_PARSE_FAILED`. That is the
   correct behaviour and proved the fail-closed structure works, but a check that can never pass is
   not a usable gate either. So the timestamp is interpolated into `gh api --jq` instead, and the
   `grep -qE '^[0-9]{4}-…Z$'` guard in front is doing double duty: it fails closed when `$SINCE` is
   empty or malformed, **and** it is what makes the interpolation safe. That does not weaken the
   "never interpolate into a shell command" rule — `$SINCE` is an API-derived ISO-8601 timestamp
   proven to match that anchored pattern, not PR-authored text. Verify a probe by running it, not by
   reading it; both broken versions looked correct.

   **`$SINCE` is the newest `pending`, which is neither the oldest nor the newest status.** Statuses
   come back newest-first, and a commit accumulates several review cycles. The oldest status reaches
   back into a *previous* cycle, so one failed attempt would keep the gate shut forever even after a
   clean retry. The newest status is the **completion** of the current cycle, so anchoring there
   skips the very window the probe exists to search — a "Review failed" comment posted seconds
   before its status would go unseen. The newest `pending` is the start of the latest attempt, which
   is exactly the window wanted. Real timeline from this PR's own head `c0490ce9`:

   ```text
   success 04:33:33   <- newest status: anchoring here misses a failure at 04:33:30 (fail-open)
   pending 04:26:00   <- the latest cycle starts HERE
   success 04:25:11
   pending 04:24:41
   pending 04:24:38   <- oldest status: reaches into the previous cycle (blocks forever)
   ```

   CodeRabbit flagged the oldest-status bug correctly and proposed the newest status as the fix; that
   half was wrong, and the timeline above is why. If no `pending` exists at all the value is empty and
   the probe blocks, which is the right answer for a commit whose review never started.

   Two deliberate exclusions. **"Reviews paused" is not a failure** — `auto_pause_after_reviewed_commits: 2`
   makes that notice a permanent fixture of the walkthrough on any active branch, so matching it would
   block every merge forever; the pause is handled by triggering the review explicitly. And the search
   is bounded by `$SINCE` rather than scanning the whole PR, because a failure marker from an earlier
   head is history, not a statement about this commit — an unbounded search would wedge the gate shut
   on any PR that ever had one failed review. (Codex CRX-SEC-002, High, PR #441.)

   **Known limitation, tracked.** This is a stability heuristic, not a terminal artifact — CodeRabbit
   publishes no "review finished" marker bound to a SHA, and the walkthrough's HTML markers
   (`walkthrough_start`, `recent_review_start`, …) are structural and present throughout. Closing it
   properly means enforcing the whole check inside `.claude/hooks/pr-merge-guard.mjs`, which today
   verifies neither the CodeRabbit artifacts nor `--match-head-commit`. That is tracked follow-up
   work. Until it lands, this procedure narrows the race but does not eliminate it, and no one should
   describe it as airtight.

   That is why the status never stands alone. It is paired with the canonical walkthrough stamp
   above; for a merge-only head with no stamp, the tree-identity proof carries the weight; and **the
   stamp is the stronger of the two signals** — where they disagree, believe the stamp.

   The comments path passes only when the canonical walkthrough stamp names the head **and**
   `CODERABBIT_COMPLETED_THIS_HEAD` prints for that exact SHA. The reviews-endpoint path needs no
   such pairing — a review object only exists once the review is submitted, and a PR author cannot
   author one as `coderabbitai[bot]`.

   Neither signal is sufficient alone, and each covers a different attack: the status without the
   stamp read green on FarmRx while the head was unreviewed, and again on a head with nothing to
   review; the stamp without the status passed mid-review here at `b0428b2d`; and an *unfiltered*
   stamp is forgeable outright by asking the bot to echo a SHA in chat. Only the pair — canonical
   walkthrough plus SHA-bound status — resists all three.

   The `submitted_at != null` and `state != "DISMISSED"` filters on the reviews query are
   load-bearing, not decoration: the endpoint returns `PENDING` reviews (with `submitted_at: null`)
   and dismissed ones, and both still carry the range line in their body — so without the filters an
   unsubmitted or withdrawn review would satisfy the gate. Raised on PR #441 by both reviewers after
   an earlier revision switched the query from `.commit_id` to `.body` and dropped them.

   `--paginate` matters: results page at 30, so an unpaginated lookup can miss the relevant entry on
   a long-lived PR. Do **not** add `--slurp` — CodeRabbit recommended exactly that on PR #441 and
   the command does not run: `gh` rejects `--slurp` together with `--jq` ("the `--slurp` option is
   not supported with `--jq` or `--template`"), and piping to a standalone `jq` fails too because
   `jq` is not installed on this machine. Both were tested before this note was written.

   **Re-read `headRefOid` immediately before merging**, and then make GitHub enforce it rather than
   trusting that you looked:

   ```bash
   gh pr merge <n> --repo masonwells1/CRX_Manager_V1.0 --squash --match-head-commit <HEAD>
   ```

   `--match-head-commit <SHA>` is "Commit SHA that the pull request head must match to allow merge"
   (gh manual). Without it, a push landing between your check and your merge is merged unreviewed
   and nothing objects; with it, GitHub refuses the merge outright. Always pass it — the reviewed
   SHA is the only SHA that may land.

   **What never counts as proof:** a green `CodeRabbit` entry in `gh pr checks` (it read green on
   FarmRx PR #26 while the head was *not* among the reviewed commits); a `submitted_at` newer than
   the final push (any reviewer's timestamp satisfies it, and a review of the previous commit can
   start before the push and finish after it); a "Review finished" reply (it names no SHA); a review
   whose state is `DISMISSED`; or **the range line taken from any bot comment without the canonical
   walkthrough filters** — chat auto-reply is on, so that text can be solicited by whoever opened the
   PR. Timestamps are not identity, and bot authorship alone is not authenticity — only the SHA, in
   an artifact a PR author cannot manufacture, is.

   If neither command prints the head SHA, comment `@coderabbitai review` on the PR
   (that runs **one** incremental review of the current commit; `@coderabbitai resume` is a
   different command that restarts automatic review), wait for it to complete, and read it
   before merging. "Review rate limited" is temporary and refills — re-check rather than treating
   it as a clean pass. A re-review often posts as a summary-only review whose findings live in the
   review **body** under "Outside diff range comments", so listing `/pulls/<n>/comments` alone can
   look falsely clean.
6. Merge. **The merge is the deploy.**

Landing regular reversible code with the full pipeline green is covered by Mason's standing push
policy (2026-06-16, mechanics updated 2026-07-30); report that explicitly rather than assuming it. A direct `vercel --prod` deploy outside the push path or an Edge Function deploy still needs Mason's explicit yes. A live migration apply follows the settled 2026-07-13 rule: interactive session = Mason's in-chat OK; pre-authorized armed hands-free run = migration-apply-guard's full proof gate (hash-bound dual-reviewer proof + hash-bound Codex proof, both fresh ≤30 min); destructive migrations never apply autonomously.
If blocked: List every issue that needs fixing first.

## Rules

- NEVER push a branch, open a PR, or merge if lint, typecheck, or build fails
- NEVER merge if tests have new failures
- NEVER push/merge if secrets are found in source code
- NEVER merge with unapplied migrations pending without surfacing them (warn — Mason decides the ordering)
- NEVER attempt to push directly to `main`; the ruleset blocks it and the attempt is a bug in the plan
- NEVER merge a PR without reading CodeRabbit's review on it first
- NEVER merge on the strength of a review that predates the final commit — auto-review pauses after
  2 commits and rate limits can skip a run. Prove coverage by matching the exact `headRefOid`
  against the `between <base> and <head>` stamp in the review body, never by its `submitted_at`
  (that field is only a filter for unsubmitted reviews, never evidence of which commit was read).
  Re-trigger with `@coderabbitai review` and read the fresh review
- ALWAYS merge with `--match-head-commit <HEAD>` naming the reviewed SHA, so GitHub — not your own
  diligence — rejects the merge if the head moved after you checked
- If no fresh review can be obtained (CodeRabbit down, rate limited past the window), the merge stays
  **BLOCKED** until one can be. There is no waiver — not by an agent, and not by Mason's in-chat OK.
  Writing "the final commit went unreviewed" in a summary is a description of the gate failing, never
  a substitute for passing it. The **one** exception is the merge-only head documented in step 5,
  where CodeRabbit itself reports "No files to review" and the three tree-identity checks pass; that
  is deterministic proof, not disclosure, and it does not extend to a head carrying any real new
  commit.

  **"Advisory" does not mean optional.** AGENTS.md says whoever lands the work *reads CodeRabbit's
  review and fixes any real issue it raises*, and that reading is mandatory; "advisory" describes only
  what happens to the **findings** — they may be weighed, and nitpicks dismissed with a one-line
  reason — never whether the review happens at all. An earlier revision of this file carried a clause
  letting Mason approve a merge with no review, on the strength of that word. Codex flagged it twice,
  the second time as High, and was right both times: it contradicted "NEVER merge a PR without reading
  CodeRabbit's review on it first" three lines above, and it opened a path for an unreviewed final
  commit — possibly touching auth, permissions, or deploy guards, none of which trip the money/RLS
  proof — to reach production during any outage. The clause is gone. If Mason ever wants that
  trade-off, it is a policy change he records in `AGENTS.md` and the decision log, not a standing
  escape hatch pre-authorized inside the procedure it would bypass.
- If a local guard blocks the merge and its required proof harness does not exist in that repo (as
  on FarmRx, which has no `scripts/write-codex-push-proof.mjs`), PARK and ask Mason. Never satisfy a
  guard by borrowing another repo's proof script — CRX's reviews against CRX's rules and would mint
  an official-looking verdict under the wrong rubric
- Edge Function deploys and direct Vercel CLI deploys always need Mason's explicit approval; only the regular push-to-`main` path is covered by the standing authorization. Live migration applies need his in-chat OK in an interactive session — the one exception is a pre-authorized armed hands-free run passing migration-apply-guard's full proof + Codex gate (destructive migrations: never autonomous)
