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

- **Read-only against everything that matters, and precise about what that means.** Patrol
  issues only read requests to GitHub and non-mutating `git` queries: it never updates a
  branch, merges, comments, labels, applies a migration, deploys, or restarts a loop, and
  it never writes to the repository or the database. It *does* write its own local state —
  the per-run snapshot, a heartbeat, a lock, and rotated logs, all under
  `%LOCALAPPDATA%\crx-patrol\`, outside every Git worktree. If a request is "run nothing
  that writes anything at all", say that, rather than calling patrol write-free.
- **Negative claims only.** It reports blockers it can see. It never says a pull request is
  ready to merge — GitHub's merge button is the authority.
- **It cannot see decisions that live outside GitHub.** A pull request held back by a
  judgement call looks unblocked to patrol unless the hold is marked on GitHub itself —
  a `hold` / `parked` / `do-not-merge` label, or `PARKED` in the title. When Mason parks
  something, add the marker, or patrol will keep raising it.
- **Parked migrations come from the same library `/fleet` uses**, so the two never
  disagree. When that library reports parked state as unknown for a worktree, patrol marks
  the source incomplete rather than reporting a clean zero.
- **It reports gates, it does not run them.** "Codex gate down" means reviews cannot run —
  a different thing from a review finding problems.

## Recurring use and the dead-man alarm

To have it check on a schedule, run `/loop 30m /patrol`.

Patrol cannot report its own death: if the loop stops, the laptop sleeps, or auth expires,
it just goes quiet — and quiet looks exactly like "nothing needs you". `patrol-monitor.mjs`
is the independent check. It reads the heartbeat patrol writes on every **completed** scan
and alarms when it is missing, stale, malformed, or future-dated.

Check it any time:

```bash
node scripts/patrol/patrol-monitor.mjs
```

For it to work while nobody is at the machine it must run from the **OS scheduler**, not
from an agent session — a session-triggered check cannot fire when no session starts, which
is precisely the case it exists to catch. Registering a scheduled task changes system
settings, so **Mason runs this himself**, once, in an elevated PowerShell:

```powershell
schtasks /Create /TN "CRX Patrol Monitor" /SC MINUTE /MO 60 /TR "node C:\CRX_Manager\scripts\patrol\patrol-monitor.mjs" /F
```

Until that task exists, a scheduled patrol is **not** a safety net — say so plainly rather
than implying the queue is being watched.
