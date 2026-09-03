## 2026-09-02 — the guards' recovery messages stop routing operators around the gate this PR builds

Codex P2 `PRRT_kwDORKRmnc6efXn-`, and an unusual shape worth naming: **the text never changed, its
truth value did.**

Three refusal messages — `.claude/hooks/pr-merge-guard.mjs:132` and `:200`, and
`.codex/hooks/production-action-guard.mjs:656` — tell a blocked operator to post
`@coderabbitai review` by hand. On `main` today that is **correct**: no label gate exists, so
hand-posting genuinely is the sanctioned path. This PR introduces the gate, and the moment it lands
the same sentence tells an operator to bypass it.

Confirmed rather than assumed, against `origin/main` vs head:

- `.github/workflows/coderabbit-final-review.yml` and `.github/scripts/` are **absent from
  `origin/main`** — the gate is new here.
- Both guard files are **byte-identical** across `origin/main` and this PR's head
  (`fe551d2bb54764e463d73a4f0c46917827e3beb5`, `1c921605467e613f820bc3413d5bff255296c4ec`), and
  neither appears in the PR's file list.

So the defect is caused entirely by this diff even though the diff does not touch the file. The gate
and the guidance describing it have to ship together, or the PR ships a documented bypass of its own
gate — the same shape #547 found in its restore instructions.

All three now direct the operator to apply `ready-for-coderabbit` and let the default-branch workflow
revalidate the exact head and post the command once, and say explicitly that hand-posting routes
around the label gate. **Message text only; no guard logic changed** — the conditions deciding
whether to refuse are untouched, and no test asserts on the old wording.

Edited on both sides deliberately: `agent-manifest-parity.mjs` fails on a one-sided guard change.

### Deliberately not fixed here

Codex P1 `PRRT_kwDORKRmnc6ef0lW` — both merge guards accept a generic `reviewDecision === "APPROVED"`
without reading the marker or the approver identity. The blob comparison above proves this PR
introduces no regression there; it is pre-existing on `main` and splits into its own focused change.

**That comparison proves the behaviour is *unchanged*, not that it is *correct*.** Neither guard was
executed against a must-DENY canary in this session. The split-out PR starts with that behavioural
run as a requirement, so "identical" is not inherited as if it meant "checked."
