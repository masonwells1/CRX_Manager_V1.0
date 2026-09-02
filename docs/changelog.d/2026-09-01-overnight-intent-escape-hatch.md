## 2026-09-01 - Stop the overnight handshake advertising an escape hatch that never worked

**Class:** guard deadlock + false-assurance test. **Outcome:** documentation and tests
corrected; a proposed code-execution escape was built, reviewed, and **deliberately rejected**.

## What was broken

`unattended-autopilot.mjs` pauses building/mutating tool calls when
`.claude/session-state/OVERNIGHT-INTENT.flag` is fresh and autopilot is not armed. Its deny
message told the agent that if this is *not* a hands-free run, the fix is to "delete
`.claude/session-state/OVERNIGHT-INTENT.flag` and continue normally".

That command has never worked. `review-proof-guard.mjs` (registered on `matcher: "*"`) refuses
every destructive shell command touching `.claude/session-state` or its parent. Reproduced live
on 2026-09-01 in worktree `xenodochial-cori-d985ff`, in both the absolute and repo-relative forms.

The latch fires on a prompt *heuristic*, so it also fires on prompts that merely **discuss**
autopilot — such as a task to fix these very hooks. When that happened the session was fully
wedged:

- `Bash` — paused by the handshake (only read-only leading tokens pass)
- `Write` / `Edit` — paused by the handshake for any path outside `session-state`
- `rm` of the flag — refused by `review-proof-guard`
- `Read` of the flag — also refused by `review-proof-guard`

leaving **arming autopilot as the only unblocked path** — precisely the failure the handshake
exists to prevent, and something Mason has repeatedly instructed agents never to do as an escape.

`autopilot-lib.test.mjs:58` asserted the `rm` form returned `allow-through` and passed the whole
time. It was testing one hook of seven; a PreToolUse chain denies if **any** member denies. This
is the "mutation tests can silently no-op" class: green, and measuring nothing.

## What changed

- **`unattended-autopilot.mjs`** — the deny message no longer advertises a command the stack
  refuses. It now states the two remedies that actually work (the 45-minute self-expiry; Mason
  deleting the file himself, with the **worktree** path called out), warns that the latch fires on
  prompts that merely discuss autopilot, and says explicitly not to arm autopilot to get unblocked.
- **`autopilot-lib.mjs`** — the loose `/OVERNIGHT-INTENT\.flag/` substring allowance is removed
  outright, with the review history recorded inline so it is not reintroduced. The arm command is
  now the only command allowance.
- **`autopilot-lib.test.mjs`** — the false assertion now states reality (`deny-until-armed`).
- **New `.claude/hooks/overnight-intent-clear.test.mjs`** — reads the real `.claude/settings.json`,
  spawns **every** PreToolUse hook whose matcher covers `Bash`, and holds the deny message to its
  contract: no advertised shell remedy that the chain refuses, both true remedies stated, the
  removed script escape not reintroduced, a fresh latch really gating and an expired one really
  releasing.

## Why no escape hatch was shipped

A sanctioned `scripts/clear-overnight-intent.mjs` was built, then **removed on Mason's decision**
after two rounds of exact-SHA `gpt-5.6-sol` review returned BLOCKERS both times — four HIGH
findings in total:

1. The allowance matched only **basenames**, so `node attacker/clear-overnight-intent.mjs
   --not-a-hands-free-run` ran an arbitrary planted file. Re-running the end-to-end test against
   that regex confirmed **nothing in the entire hook chain denied it**.
2. Tightened to an exact-string allowlist, it was still **unbound to the project root** — a planted
   `scripts/clear-overnight-intent.mjs` under a different working directory ran instead.
3. The helper was **not protected machinery**, so its body could be edited locally and then invoked
   through the allowance.
4. The tests only exercised sanctioned commands, so they probed none of the above.

Each fix was another text rule over a command string — the shape this repo has already proven does
not converge (the `git clean` carve-out closed after six rounds; see
`[[a-command-text-guard-never-converges]]`). The trade was rejected on its merits: the disease is a
session paused for at most 45 minutes; the cure was a fresh way to **execute code** during exactly
the window when execution is meant to be paused.

**Accepted residual:** a mis-latched session waits out the 45-minute expiry, or Mason deletes the
flag himself. That is the status quo minus the misleading documentation.

## Verification

`node .claude/hooks/overnight-intent-clear.test.mjs` — 9 checks pass against the real hook binaries,
and each new contract check was **mutation-proved load-bearing**:

| Mutation | Check that went red |
|---|---|
| Restore the pre-fix "delete the flag" deny message | "advertises no shell delete" + "states the two remedies" |
| Make `intentFresh` never expire | "PROOF OF REMEDY: an expired latch stops gating" |
| (during development) restore the basename regex | all 6 end-to-end bypass checks |

Registered in `npm run test:correction-guards`.

## Open findings, deliberately not fixed here

- `review-proof-guard.mjs` denies the **Read** tool on `.claude/session-state`, though its message
  only claims to block content being "created, moved, or deleted". An agent cannot inspect its own
  state files (only `cat` via Bash works).
- The handshake's write-redirect check (`/>|\btee\b/`) treats a discard redirect like `2>/dev/null`
  as a file write, so it pauses harmless read-only commands.
- The `autopilot-arm.mjs` allowance is a loose substring match and can ride as a prefix on a chained
  command. Left alone deliberately: it is the arming path, not the clearing path, and this change
  set is about not making that surface bigger.
