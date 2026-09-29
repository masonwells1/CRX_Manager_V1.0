## 2026-09-29 — PR #836 drops its own subagent-report fix in favour of #826

PR #836 carried a fix for handoff item 5 (a subagent's `<agent-message>` hand-back report being
read as if Mason typed it): three commits (`acbde927`, `52916091`, `03ad0616`) that stripped the
envelope by tag pairing in `.claude/hooks/prompt-source-lib.mjs` and pointed the hold latch and six
reminder hooks at it.

While #836 was open, `main` merged #826 ("a subagent's hand-back report is not read as Mason's
words"), an independent fix for the same problem. #826 recognises a hand-back by the harness's exact
line structure (preamble, column-zero tags, indented body), has been through Luna and Sol review,
and covers cases the tag-pairing approach did not. The two conflicted in all seven prompt-hook
files.

**Resolution.** The three #836 commits are reverted (`git revert`, so the history keeps them), and
#826's implementation stands unchanged. #826's structure-based recognition does not have the
quoted-tag problem that the Codex GitHub App found in #836's version (P2 on `03ad0616`), because
a tag Mason mentions is never preceded by the harness preamble.

**Kept from the reverted work:** the real GitHub status object for PR #820's head, pinned in
`.claude/hooks/pr-merge-guard.test.mjs` as evidence against the Codex P1 on #836 (a status's `url`
ends in the commit SHA, not a status id). That test belongs to #836's CodeRabbit follow-up rule,
which is unaffected.

**Proof.** After the revert, no `.claude/hooks` file references `withoutOtherAgentText` or an
`"agent-message"` tag entry; the merge of `main` then applies #826 cleanly, and the prompt-hook,
correction-guard and agent-workflow suites pass on the merged result.
