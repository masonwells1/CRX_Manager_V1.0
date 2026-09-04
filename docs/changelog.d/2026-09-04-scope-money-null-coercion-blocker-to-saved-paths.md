## 2026-09-04 - Scope the money null-coercion BLOCKER to saved paths, without opening a hole

- Qualified CHECK 1 in `.claude/agents/compliance-reviewer.md` so the "coercing `null` to `0`
  (`?? 0`, `|| 0`) is a BLOCKER" rule applies to **saved or authoritative** money paths — a value
  that is persisted, passed to an RPC, or used to gate or compute a saved amount. Applied the same
  qualification to the duplicated rule text in `.claude/hooks/session-context-reminder.mjs`, which
  is the copy that has to survive context compaction. Both copies were changed in this commit; a
  guard that pins one half of a pairing is satisfied by the bug.
- Why: Codex flagged (P2, review comment `3931208132` on PR #588) that the unconditional wording
  classified every `?? 0` as a BLOCKER, including the deliberate display-only preview at
  `src/pages/NewVendorBill.tsx:237`. That preview is safe and the finding is correct — verified in
  source, not assumed: the save path parses the same fields at `:157` and `:160` and refuses `null`
  by name with `MONEY_PRECISION_MESSAGE`, returning at `:158` and `:161` before anything is sent.
  Left unqualified, a future review or a compacted session could demand an incorrect change to an
  acknowledged-safe preview.
- The exception is written as a **verified pair, not a shape**. A preview may coerce with `?? 0`
  only when a reviewer can cite a line for each half: (a) the coerced value never reaches a save,
  and (b) the SAME field's save path refuses `null` by name and returns before sending. The rule
  states explicitly that the `?? 0` shape alone, a nearby comment claiming "display only", and a
  preview whose save path checks a *different* field are all still BLOCKERs, and that a reviewer who
  cannot point at the refusing lines must report the finding.

### Mutation test — the narrowed rule still DENIES

A widened guard can end up accepting something that can no longer fire, so the qualification was
tested against a canary containing one legitimate case and two violations, by running the real
`compliance-reviewer` agent against the edited rule (not by inspection):

| Case | Shape | Required | Observed |
|---|---|---|---|
| A | Genuine display-only preview; same-field refusal in the save path | cleared | **cleared**, both halves cited (`:23` preview consumed only by the render, `:14` same-field refusal returning before the send) |
| B | `?? 0` on a value passed straight to an RPC, no `null` check | BLOCKER | **BLOCKER** at `:34` |
| C | Commented "Display-only preview", but gates the save at `:55`, is persisted at `:57`, and the only refusal (`:53-54`) names a **different** field | BLOCKER | **BLOCKER** at `:65` |

Case C is the load-bearing one: it is the exact shape the narrowing could have opened, and it was
still refused, with the reviewer naming the wrong-field refusal as the reason. Verdict:
2 BLOCKER / 0 HIGH / 0 MED. Had the rule been widened to "display-only previews are allowed", Case C
would have passed.

- No application code changed. `src/pages/NewVendorBill.tsx` is untouched by this commit — the
  preview was already correct; only the rule that mis-described it changed.
