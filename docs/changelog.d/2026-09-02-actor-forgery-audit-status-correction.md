## 2026-09-02 — correct the actor-forgery audit's status section, which said "parked, not merged"

`docs/audits/2026-09-02-actor-forgery-predicate-triage.md` shipped in PR #564 with a status section
written while the branch was still expected to park. It then merged, so the document that lives on
`main` describes its own work as **"PARKED at round 5 — not merged"** and tells the reader the branch
is "pushed, green, and left open". Both statements are false on `main`, and this is the file a future
session is pointed at to learn what shipped unfixed.

Corrected to record what actually happened:

- PR #564 merged as `fdfba4ec5`; production deploy for that commit succeeded.
- Mason merged it by hand. No agent could: the round-5 exact-SHA `gpt-5.6-sol` proof returned
  BLOCKERS, and `pr-merge-guard.mjs` demands a fresh clean proof for anything `contentIsRisky` flags
  — which a *checker for forged actors* always trips, because it quotes the identifiers that
  classifier looks for. The owner escape hatch is the intended path there; an agent must not take it.
- The two open findings are relabelled from "not fixed here" to **SHIPPED UNFIXED**, with the
  scoping consequence stated: closing the first one means no longer truncating at a null-tolerant
  guard, which returns the live sweep from 21 rows to ~31. That is Mason's call, not a regex tweak.
- Records that no CodeRabbit review ran on the candidate, and why — the requesting gate has been
  failing repo-wide since #516 for want of `administration: read`.

Documentation only. No predicate, test, or application code changed; the checker on `main` is
untouched.
