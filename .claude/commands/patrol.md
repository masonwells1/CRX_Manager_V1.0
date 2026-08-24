Answer "what needs Mason right now?" across every pull request and worktree — filtered, so he reads a handful of items instead of the whole queue.

Use this when Mason asks anything like: "what needs me", "anything waiting on me", "what's blocked", "keep an eye on things", "what should I look at". `/fleet` shows him everything; `/patrol` shows him only what is actionable and says plainly what it could not determine.

## Steps

1. Run the report:

```bash
node scripts/patrol/patrol-report.mjs
```

2. **Print its output verbatim, as a fenced block, before anything else you say.**

   This is not a stylistic preference. The lanes, the counts, the hidden-item totals, the
   emergency text, and the exact phrase `Nothing waiting on you` are produced by
   `patrol-render.mjs` — deterministic code with golden-output tests — precisely so that no
   language model can soften an error, drop a lane, or paraphrase an all-clear. Reformatting
   or summarizing that block instead of printing it defeats the mechanism.

3. Afterwards you may add **one** short plain-English paragraph for Mason, clearly separate
   from the block: what the top item means and what clicking it would do. Never restate the
   whole report, never re-rank it, and never describe the queue as clear unless the block
   itself printed the all-clear phrase.

4. If the command exits non-zero it printed an emergency message instead of a report. Relay
   it as-is and say plainly that patrol does not currently know what is waiting on him. Do
   not fall back to `/fleet` output and present it as if patrol had run.

## What patrol does and does not do

- **Read-only.** It performs GET requests and `git` queries. It has no write capability, so
  it never updates a branch, merges, comments, applies a migration, or restarts a loop.
- **Negative claims only.** It reports blockers it can see. It never says a pull request is
  ready to merge — GitHub's merge button is the authority.
- **It cannot see decisions that live outside GitHub.** A pull request held back by a
  judgement call looks unblocked to patrol unless the hold is marked on GitHub itself —
  a `hold` / `parked` / `do-not-merge` label, or `PARKED` in the title. When Mason parks
  something, add the marker, or patrol will keep raising it.
- **Not yet implemented in v1:** loop liveness, parked-migration state, and review-gate
  health. These report as visible "could not determine" items and deliberately suppress the
  all-clear. Use `/fleet` and `/parked` for those until they are built.

## Recurring use

To have it check on a schedule, run `/loop 30m /patrol`. Patrol writes a heartbeat to
`%LOCALAPPDATA%\crx-patrol\heartbeat.json` on every completed scan; the independent monitor
that alarms when that heartbeat goes stale is **not built yet**, so a silent death of the
loop would currently go unnoticed. Do not describe a scheduled patrol as a safety net until
that monitor exists.
