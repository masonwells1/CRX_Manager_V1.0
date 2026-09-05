---
# Read-only report: faster model at low effort (docs/reference/claude-model-tuning.md).
model: sonnet
effort: low
---

Show Mason the status of ALL his parallel work at once — every worktree, every loop, every parked migration — so he doesn't have to ask "where are we at?" in each window separately.

Use this when Mason asks anything like: "where are we", "status", "progress", "catch me up", "what's going on across everything", "how's the other work going".

## Steps

1. Run the fleet report:
   ```
   node scripts/fleet-status.mjs
   ```
   Add `--fetch` only if merge-state freshness matters right now (e.g. Mason just merged something in another window) — it costs one network round-trip; the plain run is faster and usually good enough.

2. If the script fails (git error, missing file), fall back to `git worktree list` + the SessionStart parallel-work snapshot and say plainly that the full report wasn't available.

2b. **Liveness probe — answer "is anything stalled?", not just "what exists?"** Mason's most common fleet worry is a loop or Codex run that silently died. For each loop/agent that claims to be running:
   - **Ledger freshness:** check the last-modified time of its ledger/output file (PowerShell: `(Get-Item <ledger>).LastWriteTime`). An "active" loop whose ledger hasn't moved in ~30+ minutes is suspect.
   - **Process check** (proven form 2026-07-29 — from Git Bash, single-quote the whole `-Command` or the parent shell eats `$_` and the probe fails open reporting "nothing running"):
     ```powershell
     powershell -NoProfile -Command 'Get-CimInstance Win32_Process | Where-Object { $_.Name -match "^(codex|claude|node|powershell)\.exe$" } | Select-Object ProcessId, Name, CommandLine'
     ```
     Judge by **CommandLine** (Get-Process's `.Path` misses the arguments that tell you which worktree/loop a process belongs to). `claude.exe` is in the match on purpose — a Claude-owned loop sitting in a long step would otherwise show no process and get mislabelled STALLED (CodeRabbit on #283). `powershell.exe` is in it as the probe's **own self-check**: the probe is itself a `powershell.exe`, so at least one such row must always come back. Zero rows means the probe broke, not that nothing is running — fix the probe before reporting a finding. Judge loops only by the `codex`/`claude`/`node` rows.
   - Verdict per loop: **RUNNING** (fresh ledger or matching process), **IDLE** (finished, nothing claims to be running), or **STALLED** (claims running, stale ledger, no matching process). Say which evidence produced the verdict.
   - A stalled Codex run is reported, never auto-restarted — restarting is Mason's call after he sees what it was doing.

2c. If Mason asks to "keep an eye on it" / "ping every N minutes": don't hand-roll reminders — run `/loop <N>m /fleet` so the check repeats itself, and tell him that's what you set up.

3. Present it **lead-with-status** style for Mason (no jargon, no wall of raw output):
   - **Plain status first** — one short paragraph: how many worktrees are active, which ones have unmerged/unfinished work, which are done and merged. Translate: "MERGED into origin/main" = already in the live app's main branch; "changed files" = uncommitted work in progress; a "ledger" = that loop's running logbook.
   - **ONE recommended next step** — the single most useful thing to do now (e.g. "the StructureFix worktree has finished work that isn't merged yet — I recommend we merge that next"). Not a menu.
   - **Decisions that need Mason** — each as a question WITH a recommendation (e.g. "2 parked migrations are waiting for your OK to apply live — I recommend we review the per-acre one first because it fixes visible prices. Want me to walk you through it with /parked?"). If the report says "Nothing waiting on you", say exactly that.

4. Remember worktrees churn — this is a snapshot. If Mason then asks to act inside a specific worktree, re-verify it live (`git worktree list`, that branch's log) before claiming anything is done or already shipped there.

This command reads and reports only — it never merges, pushes, applies migrations, or deletes anything.
