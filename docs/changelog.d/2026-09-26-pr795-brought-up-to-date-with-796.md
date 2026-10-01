## 2026-09-26 - PR #795 brought up to date with main at bf32063 (#796)

PR #795 merged `main` at `bf32063` (#796, GPT-6 review routing). The one conflict
(`docs/reference/agent-guardrails.md`, the same table row) kept main's `gpt-6-sol` text and re-added
#795's push-budget sentence. GitHub had not started the main CI run for `d7b330e`; the merge push
started it.

Not verified: the full CI suite ran on the merge push, not locally; only the conflicted file was
checked by hand.
