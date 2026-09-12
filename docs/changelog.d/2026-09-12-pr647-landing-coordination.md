## 2026-09-12 — Complete the native CodeRabbit review-delivery repair

Mason authorized the introducing PR's one-time review bootstrap and asked Codex to finish PR #624 afterward. PR #647 has been integrated with current main in a separate landing checkout, preserving its original checkout and branch history.

The repair requests a final review through CodeRabbit's configured positive label after the trusted default-branch workflow validates the frozen candidate. A real authenticated review of the exact candidate is required for delivery; skipped statuses and label writes are insufficient. Pending or uncertain delivery preserves deduplication state. Existing independent-review, CI, resolved-finding, and exact-head merge requirements remain in force.

Independent review identified an old-review reuse gap when a PR is retargeted without changing its head. Normal native dispatch now records both commits with its original trusted Actions run; an earlier review cannot satisfy the request, and a changed base or retained same-head attempt requires a fresh candidate. Focused cases exercise retargeting, base changes during observation, original-run provenance, pre-request reviews and late delivery without a second dispatch.

The run validator supports both base-commit and PR-head forms of Actions REST metadata while requiring the associated PR's exact head and base. A live repository run confirmed the PR-head form; 174 transport cases cover both supported forms and reject an unrelated workflow commit.

An observed outside-diff-only CodeRabbit report omitted its usual actionable-comments header. Recognition now accepts its authenticated exact-head record with unquoted run/range metadata and the terminal review stamp; quoted or incomplete lookalikes stay pending.

GitHub Codex's subsequent P2 findings were corrected before the paid review bootstrap. All controlled and unexpected failures before the provider call share verified unspent-state recovery, including blockers before receipt creation. A verified receipt belonging to the current run is removed and its absence confirmed; unknown cleanup or an observed provider label retains deduplication state. Once the provider call has been attempted, recovery never removes that receipt. Polling and final delivery validation reset invalid candidates and removed native labels directly, preserving receipts without depending on a queued reset. There are 194 focused transport cases.

The introducing PR's bootstrap and the first normal request after merge are observed separately under `docs/reference/coderabbit-native-review.md`. This work changes no live database data and does not apply PR #624's parked migration. Rollback is a protected revert of the review-delivery repair.
# Native attempt history follow-up


Independent review identified that a late review from an out-of-band label
request could otherwise satisfy a newer receipt for the same head and a
different base. Persistent label history now excludes untracked, duplicate,
unsettled and retargeted attempts before dispatch and review acceptance.
Verified, completed earlier-head native attempts still permit normal follow-up
reviews. Focused regressions exercise late delivery and the allowed follow-up.
