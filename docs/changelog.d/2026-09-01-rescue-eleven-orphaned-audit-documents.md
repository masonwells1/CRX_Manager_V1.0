## 2026-09-01 — Eleven audit and handoff documents recovered from two unmerged branches

Eleven documents existed **only** on branches with no pull request and no path to one. Both branches
are on the deletion list in `docs/audits/2026-09-01-no-pr-branch-disposition-plan.md`; deleting them
first would have destroyed the documents. This lands them so the branches can go.

The absence was verified rather than assumed: `git ls-tree -r --name-only origin/main` finds none of
these paths, and `git diff --name-status <merge-base> <branch>` reports all eleven as `A`. Codex
`gpt-5.6-sol` independently searched `origin/main` for the four handoff **blob ids** — not just their
paths — and also found nothing, which rules out the same content living under a different name.

### From `claude/rescue-unique-docs-20260807` (9)

Four 2026-07-29 overnight handoffs, one 2026-07-27 session handoff, one 2026-08-02 gauntlet Section 02
report, and three superseded local gauntlet snapshots under
`docs/audits/gauntlet/superseded-local-snapshots-2026-08-07/`.

### From `claude/zealous-agnesi-aa7423` (2)

`docs/audits/2026-08-19-chem-unit-findings-and-plan.md` and
`docs/audits/2026-08-19-codex-verdict-chem-unit.md`. The **code** on that branch is superseded —
`main` and the branch diverged into different designs (`main` has `chemUnitUnspecifiedSides` /
`chemLineBillingHazard`; the branch has `chemQuantityFactor` / `chemRowUnitChange` /
`chemLineUnitMismatch`) after the chem-unit work went catalogue-wide. Only the documents are landed.
The second is a `gpt-5.6-sol` adversarial verdict on a money path and is worth keeping on that basis
alone.

### The four handoffs carry a SUPERSEDED banner

A handoff document reads as an instruction to do something. All four describe work that has since
shipped — #280 (inventory net position backlog), #287 (supplier pricing operator workflows), #290
(stale Quote/Customer saves), #291 (vendor-bill accounting-period close race), each confirmed merged
by title, not by branch-name inference. Landing them unmarked would have put four live-looking task
documents into `docs/handoffs/` for completed work. Each now opens with a banner naming the PR that
closed it, the date it was written, the branch it was recovered from, and an explicit
"do not execute the instructions below". The bodies are preserved verbatim.

### Deliberately not landed

`docs/app-workflow-map.html` is the tenth unique path on `claude/rescue-unique-docs-20260807`. It is
generated output and the branch's copy is stale, so it is excluded. This was Codex's one surviving
correction to the round-1 disposition of these documents; its accompanying claim — that four of the
handoffs were already on `main` — was withdrawn in round 2.
