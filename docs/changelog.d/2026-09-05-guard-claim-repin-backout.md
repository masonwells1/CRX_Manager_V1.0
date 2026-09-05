## 2026-09-05 — Back out a guard blob re-pin, and withdraw a wrong "pre-existing failure" claim

The exact-SHA `gpt-5.6-sol` review of the guard-claim annotation branch returned two findings. Both
were correct. This records what they were and what the second one revealed about a claim this branch
had already made.

### HIGH — the blob re-pin created a false green on a production guard

To annotate 11 safety claims in `.codex/hooks/production-action-guard.mjs` and 1 in
`.claude/hooks/codex-push-lib.mjs`, comment-only edits changed both files. Both are blob-pinned by
`scripts/apply-live-testdata-maintenance-20260812.mjs`, so `EXPECTED_PROTECTED_OUTPUT_BLOBS` was
re-pinned to the new hashes, citing the constant's own precedent of earlier re-pins.

That reasoning was wrong, and the direction of the pin is why. The producer transforms only when the
on-disk blob matches `EXPECTED_PROTECTED_INPUT_BLOBS`; when it matches the OUTPUT pin it returns
early as "already protected". `origin/main`'s guard blob **is** the input pin (`a1ba52df7…`), so on
`main` the transform genuinely runs and injects `maintenanceProducerInvocationAllowed` and its
enforcement check. Pinning the OUTPUT to the un-transformed candidate made the producer report
success **without installing that protection**.

That is a false green on a live security control, bought to make a **local advisory** audit look
better — `guard-claim-audit.mjs` is run by no workflow and no git hook. Backed out: all three files
are byte-identical to `origin/main` again, and the annotation scope is now the two guard files that
carry no blob pin.

### MEDIUM — the overload query could hide mixed application/extension collisions

The extension exclusion filtered rows out **before** grouping. An application migration that created
a function sharing an extension function's name would leave only its own row, count 1, and the
collision would pass undetected. Now groups all public functions and suppresses only names whose
overloads are entirely extension-owned. Verified against live: all 8 `plpgsql_check` names report
`has_app_owned_overload = false` and are suppressed; a mixed name would surface.

### WITHDRAWN — "`production-action-guard.test.mjs` fails on main, proven pre-existing"

That claim, made in an earlier revision of `2026-09-05-guard-claim-annotations.md` and in a commit
message, is **false**. The test passes on `main` and passes here now. It failed only while the bad
re-pin was in place — the early return handed the assertions un-transformed sources.

The reasoning error is recorded because it produced a confident wrong answer that looked like proof:
`maintenanceProducerCommandMentioned` was extracted from the **on-disk** guard, compared against the
producer's copy, found different, and read as drift. But the test asserts against the **transform's
output**, not the on-disk file. The on-disk guard is the transform's *input* and is *supposed* to
lack those functions. Checking "identical at HEAD and in the working tree" only confirmed the same
wrong measurement twice.

**The general lesson:** when a guard has an input form and a generated output form, verify against
whichever one the test actually consumes. Comparing the input against the expected output will
always look like drift.
