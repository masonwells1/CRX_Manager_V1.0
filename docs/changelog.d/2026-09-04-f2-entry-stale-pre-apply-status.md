## 2026-09-04 - the F2 entry no longer claims both APPLIED LIVE and NOT YET APPLIED

Answers the second CodeRabbit review of PR #594, on commit `f99200f31` — one actionable comment,
accepted. The two findings from the first review are fixed and were not re-raised.

`docs/manual/KNOWN_ISSUES.md`'s F2 entry is headed
**RESOLVED 2026-09-04 (migration `20260903160000` APPLIED LIVE as ledger version `20260904023121`)**,
but two paragraphs further down still read **"Status 2026-09-03 — FIX WRITTEN AND PROVEN, NOT YET
APPLIED"** and **"Not applied live and not merged … This item stays OPEN until that lands."** One
entry, two contradictory statuses, and the false half is the one a reader acts on: an agent that
scrolls to the detail rather than the heading concludes the live gate is not in place and may try to
apply it again.

Both paragraphs are now explicitly framed as **historical pre-apply notes**, with the current status
named as the heading. The derivation is kept — it is the record of how the role sets were chosen —
but it can no longer be read as a live status:

- The pre-apply block opens with a note saying everything below it describes the state before the
  2026-09-04 apply, and that "not applied" there means "not applied *yet, as of 2026-09-03*".
- The closing precondition paragraph now records that all three requirements (Mason's in-chat
  approval, a same-session apply-guard proof, the exact-SHA `gpt-5.6-sol` verdict) **were satisfied**
  on 2026-09-04, quoting the superseded wording rather than asserting it.
- The branch-retention instruction for `codex/section1-security-hardening-20260725` is preserved
  and restated on its own terms, since it was previously bundled into the same sentence as the
  now-false status and would otherwise have been lost with it.

This is the failure mode already recorded in memory as *point-in-time labels protect NUMBERS, not
state claims*: dating a paragraph does not stop "NOT APPLIED" from going false. A status sentence
inside a long entry needs superseding, not merely dating.

## Verification

- `grep` for `NOT YET APPLIED` / `stays OPEN until` / `Not applied live` in the file: the only
  remaining hit is inside the explicitly quoted historical text.
- `npm run test:agent-workflows` and `npm run test:correction-guards` — both pass.
