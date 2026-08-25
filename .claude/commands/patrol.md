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
  judgement call looks unblocked to patrol unless the hold is marked on GitHub itself.
  Use a **label** — `hold`, `parked`, `on-hold`, `do-not-merge`, or `blocked`. A `PARKED`
  title is deliberately NOT honoured: a title is written by the PR author, so honouring it
  would let any contributor hide their own pull request from the report, while applying a
  label requires write access and is therefore an authorization signal.
- **Parked migrations come from the same library `/fleet` uses**, so the two never
  disagree. When that library reports parked state as unknown for a worktree, patrol marks
  the source incomplete rather than reporting a clean zero.
- **It reports gates, it does not run them.** "Codex gate down" means reviews cannot run —
  a different thing from a review finding problems.

## Interactive only — do NOT schedule this (Mason's decision, 2026-08-24)

Run `/patrol` when Mason asks. **Do not** register it as an OS scheduled task, and do not
set it running unattended with `/loop`.

That is a deliberate scoping decision, not an oversight. Three consecutive adversarial
review rounds each found a *new* hole in the previous round's fix of the unattended
execution surface — PATH-resolved binaries, repository-local content filters, a missed
`execFileSync`, check producers failing open, an unguarded `git status`, per-worktree Git
config. Every fix was correct; every one was incomplete by one step. All of those findings
matter *only because* the tool would run hourly under Mason's account with no one watching.
Run by hand inside a session, patrol carries no more risk than any other script here — and
by hand is where its value already is, since he reads the report when he sits down.

The hardening in `trusted-exec.mjs` stays (fixed executables, minimal environment, and a
fixed `core.fsmonitor=false` override on every Git call). It is defence in depth, not a
licence to schedule. Note what it does **not** do: the config scanner that refused
worktrees whose local config could execute a filter was deliberately removed on 2026-08-25
after failing open three review rounds running. Repository-local `filter.*.clean/smudge`
has no generic off switch, so that exposure is accepted interactive-only baseline risk —
the same risk `scripts/fleet-status.mjs` already carries on every run.

**If scheduling is ever wanted, it needs its own design pass on the execution surface —
not another patch.** See `docs/manual/KNOWN_ISSUES.md`.

### The heartbeat and the monitor

Patrol still writes a heartbeat on every completed scan, and `patrol-monitor.mjs` reports
whether one is recent:

```bash
node scripts/patrol/patrol-monitor.mjs
```

Interactively that is a convenience — "is the last scan I ran still current?" — **not** a
dead-man alarm. Nothing fires it while nobody is at the machine, which is exactly the case
a real dead-man switch exists to cover. Never describe patrol as watching the queue for
him; it reports when he runs it.
