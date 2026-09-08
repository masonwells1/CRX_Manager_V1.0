## 2026-09-08 — pr-merge-guard: point agents at the CodeRabbit request path that actually works

`pr-merge-guard.mjs` told agents to request a CodeRabbit review by applying the
`ready-for-coderabbit` label, and specifically not to post `@coderabbitai review`
"by hand" because that "routes around the label gate." Both of its messages said so —
the `--admin` denial and the missing-approval notice.

That advice no longer matches measured behaviour, and it contradicted the automation
Mason actually runs.

**What is true (measured 2026-09-07):** CodeRabbit does not answer review commands
posted by `github-actions[bot]`, which is the identity the label path posts under.
Across roughly 24 uses that path produced zero reviews, while a command from Mason's
user account is answered in 5-11 seconds. The decisive case was #535, where the bot's
command sat unanswered for 104 minutes while a command from the user account on the
same PR was answered. An hourly scheduled task
(`crx-hourly-coderabbit-slot`) now requests one review per hour under that account.

**Why the old text was actively harmful, not merely stale:** an agent reading it would
conclude the hourly job was misbehaving and "correct" it back to the label path, which
yields no review at all and a red `final-review-gate`. The guard's own advice pointed
away from the only path that works.

Both messages now name the hourly job, state why the bot-authored path fails, and warn
that reviews are rationed to roughly one grant per hour fleet-wide — so posting a second
request collides with the job and wastes the slot for everyone.

**Text only. No control flow changed.** `--admin` is still denied, the
`CHANGES_REQUESTED` denial still fires, and the no-approval case is still a notice
rather than a gate. Verified by running the deny path and observing
`permissionDecision: "deny"` with the new wording, plus the guard's own suite
(97 assertions, all passing).

Deliberately NOT hard-coded as permanent: CodeRabbit documents no contract about
comment-author identity, so this is an expected-value choice, not a claim that a bot can
never be heard. The scheduled task re-tests the label path every 7 days and one
acknowledged bot-posted command reverses it.
