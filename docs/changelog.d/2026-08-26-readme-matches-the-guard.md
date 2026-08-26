## 2026-08-26 — the README now lists every rule the guard actually enforces

Three review findings, two of them my own carelessness and one that mattered.

- **The README claimed two rules were enforced; the guard enforces seven.** It described
  the filename and added-status requirements and stopped there, while
  `scripts/check-ledger-update.mjs` also refuses renames, empty bodies, a bare date
  heading with no description, a heading date disagreeing with the filename, a heading
  with no detail beneath it, and unreadable staged content — and applies all of it even
  on commits with no agent-surface trigger. Under-documenting a guard is its own defect:
  the next person hits a refusal the instructions never mentioned and reasonably concludes
  the tool is broken. The section now lists all of them, and says content is judged from
  the staged blob rather than the working tree.
- A duplicate `env` key in the rename fixture, introduced when resolving the merge against
  PR #486. Both copies held the same value so behaviour was unaffected, but Biome flags it
  and a duplicated key in a test that exists to prove environment isolation is a bad look.
- A doubled word ("the new new git-spawning test") from an earlier sed edit.

83 assertions still pass.
