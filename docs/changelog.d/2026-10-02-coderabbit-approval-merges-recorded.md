## 2026-10-02 — Record that PRs merge on CodeRabbit's approval (after #841 landed)

- **What changed (docs only).** `docs/manual/DECISION_LOG.md` (the 2026-09-26 "Fewer permission prompts" entry)
  and `docs/reference/agent-guardrails.md` (item 3 of "Fewer prompts, automatic CodeRabbit, fail-closed merge
  guard") said no PR had yet merged on a CodeRabbit approval under the `protect-main` ruleset. That was already
  false when it was written. Both now record the merges.
- **Evidence (2026-10-02).** The ruleset's `updated_at` is 2026-09-27 13:05:59Z
  (`gh api repos/masonwells1/CRX_Manager_V1.0/rulesets/18904218`). Every PR merged into `main` after that
  (`gh pr list --state merged --base main`) has `coderabbitai[bot]`'s APPROVED review on its exact merged head
  (`gh api .../pulls/<n>/reviews`, matching `commit_id` to the head):

  | PR | Merged (UTC) | Head |
  |---|---|---|
  | #830 | 2026-09-28 01:45 | `b4702bfc9` |
  | #834 | 2026-09-29 01:24 | `d8b1ed998` |
  | #839 | 2026-09-29 03:07 | `48784046c` |
  | #826 | 2026-09-29 11:45 | `b36605d23` |
  | #823 | 2026-09-29 23:33 | `1d0f86eca` |
  | #825 | 2026-09-30 12:47 | `c47648b65` |
  | #844 | 2026-09-30 14:43 | `6dd9fad4e` |
  | #850 | 2026-09-30 18:39 | `acf1ddb28` |
  | #855 | 2026-10-01 02:57 | `9704220f3` |
  | #856 | 2026-10-01 03:42 | `e35584c7b` |
  | #857 | 2026-10-01 22:23 | `528a11d5f` |
  | #864 | 2026-10-01 23:08 | `51f91cd5e` |
  | #841 | 2026-10-02 17:39 | `7926fe2ce` |

  #804 and #820 merged earlier on 2026-09-27 (06:47Z and 12:57Z), before that update, with no approval on their
  heads.
- **#841 landed** as `acdc794b2`. It had CodeRabbit APPROVED on `7926fe2ce`, every required check green, and a clean
  exact-head Sol proof (head `7926fe2ce`, base `337128efa`), and merged with `gh pr merge --match-head-commit`.
  Vercel's production deploy of `acdc794b2` reported success at 17:40:39Z, and croprxsolutions.app answered HTTP 200.
  Mason chose to land it before the field-season install ("merge 841 first"), knowing the install PR (#865) would
  then need another review round.
- **Left as written:** `2026-09-27-fewer-prompts-coderabbit-auto-review.md` says "#841 is the first". Entries are
  not edited after the fact (`docs/changelog.d/README.md`), so this entry is the correction: the first merge on such an approval found here is #830.
- **Not verified:** that the 13:05Z update is the one that added the approval requirement. `updated_at` shows only
  the latest change. The absence of approvals on #804 and #820 fits that reading but does not prove it.
