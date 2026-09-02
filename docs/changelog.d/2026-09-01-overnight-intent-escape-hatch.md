## 2026-09-01 - Fix the overnight-intent handshake's unusable escape hatch

**Class:** guard deadlock + false-assurance test.

## What was broken

`unattended-autopilot.mjs` pauses building/mutating tool calls when
`.claude/session-state/OVERNIGHT-INTENT.flag` is fresh and autopilot is not armed.
Its deny message told the agent that if this is *not* a hands-free run, the fix is to
"delete `.claude/session-state/OVERNIGHT-INTENT.flag` and continue normally".

That command has never worked. `review-proof-guard.mjs` (registered on `matcher: "*"`)
refuses every destructive shell command touching `.claude/session-state` or its parent.
Reproduced live on 2026-09-01 in worktree `xenodochial-cori-d985ff`, in both the
absolute and repo-relative forms.

The latch fires on a prompt *heuristic*, so it also fires on prompts that merely
**discuss** autopilot — such as a task to fix these very hooks. When that happened the
session was fully wedged:

- `Bash` — paused by the handshake (only read-only leading tokens pass)
- `Write` / `Edit` — paused by the handshake for any path outside `session-state`
- `rm` of the flag — refused by `review-proof-guard`
- `Read` of the flag — also refused by `review-proof-guard`

leaving **arming autopilot as the only unblocked path** — precisely the failure the
handshake exists to prevent, and something Mason has repeatedly instructed agents never
to do as an escape.

`autopilot-lib.test.mjs:58` asserted the `rm` form returned `allow-through` and passed
the whole time. It was testing one hook of seven; a PreToolUse chain denies if **any**
member denies. This is the "mutation tests can silently no-op" class: green, and
measuring nothing.

## What changed

- **New `scripts/clear-overnight-intent.mjs`** — the sanctioned way out. It builds the
  flag path internally and never names it in the tool command, exactly like the existing
  `scripts/remove-applied-ledger-entry.mjs`, so it passes `review-proof-guard` **without
  that guard being changed at all**. It requires an explicit
  `--not-a-hands-free-run` assertion and takes no target argument, so it can only ever
  remove that one filename.
- **`autopilot-lib.mjs`** — the loose `/OVERNIGHT-INTENT\.flag/` substring allowance
  (which advertised a command the real stack denied) is replaced by an **exact-string
  allowlist** (`CLEAR_INTENT_ALLOWED_COMMANDS`, a `Set`), the same shape
  `bash-safety-lib.mjs` uses for `MAINTENANCE_PRODUCER_ALLOWED_COMMANDS`.
- **`codex-push-lib.mjs`, `.codex/hooks/production-action-guard.mjs`, `.claude/settings.json`** —
  the new script is registered as protected machinery alongside `run-claude-review.mjs` and
  `write-codex-push-proof.mjs`, so its body cannot be edited without the review gate.
- **`unattended-autopilot.mjs`** — the deny message now names the working command, warns
  that the latch also fires on prompts that merely discuss autopilot, and says explicitly
  not to arm autopilot to get unblocked.
- **`autopilot-lib.test.mjs`** — the false assertion now states reality (`deny-until-armed`)
  and explains why, plus coverage for the anchoring.
- **New `.claude/hooks/overnight-intent-clear.test.mjs`** — reads the real
  `.claude/settings.json`, spawns **every** PreToolUse hook whose matcher covers `Bash`,
  and fails if any one denies the sanctioned command. Registering a new hook that blocks
  the escape hatch breaks this test.

## Why a script and not a guard carve-out

Teaching `review-proof-guard` to permit `rm <this one file>` requires parsing shell
arguments exactly, or `rm OVERNIGHT-INTENT.flag applied-source-ledger.json` rides through
on one allowed word. That is command-spelling enumeration — the shape that failed across
six rounds on the `git clean` carve-out and five on the worktree-prefix carve-out. The
allowlist here is **one file, not a command grammar**.

## Why the explicit flag

Commit `c352fec6` (2026-08-08) removed a blanket `rm -f OVERNIGHT-INTENT.flag`
permission after CodeRabbit flagged it as a guard-bypass risk; the settled intent was
that clearing stays possible but **deliberate**, never a reflex. `--not-a-hands-free-run`
restores that intent without restoring the blanket grant. Clearing the latch **grants
nothing** — it removes a pause, after which the normal permission flow, every other hook,
and the autopilot deny-set all still apply. Arming is the dangerous direction; clearing is
the safe one.

## Verification

`node .claude/hooks/overnight-intent-clear.test.mjs` — 11 checks pass, and each new guard
was **mutation-proved load-bearing** (break it, watch the right check go red):

| Mutation | Check that went red |
|---|---|
| Remove the allowance from `autopilot-lib` | "the sanctioned clear command survives the ENTIRE Bash hook chain" |
| Un-anchor the regex to a loose substring | "the allowance cannot be used as a prefix to smuggle a chained command" |
| Drop the `--not-a-hands-free-run` requirement | "without the explicit assertion the script refuses" |
| Make the delete a no-op | "PROOF OF EFFECT: the latch is actually gone" (+2 more) |
| Restore the pre-review regex | all 6 "PROVEN BYPASS stays gated end-to-end" checks |

Registered in `npm run test:correction-guards`.

## Codex review — two HIGH bypasses found and fixed

The first draft of this change was **BLOCKED** by the exact-SHA `gpt-5.6-sol` review. Both
findings were real and are fixed here:

1. **HIGH — the allowance validated BASENAMES, not the script.** The original anchored regex
   matched the command *shape*, so `node attacker/clear-overnight-intent.mjs
   --not-a-hands-free-run` and `"C:\attacker\node.exe" "C:\attacker\clear-overnight-intent.mjs"
   --not-a-hands-free-run` both returned `allow-through`. Bash is globally allowed and the other
   hooks inspect the visible command rather than the JavaScript it executes, so any
   pre-existing attacker-controlled file with that basename was arbitrary code execution during
   the very pause the latch enforces. Re-running the end-to-end test against the old regex
   confirms **nothing in the entire hook chain denied it**. The code contradicted its own
   comment, which claimed "the allowlist is ONE FILE, not a command grammar" — it was a grammar.
   Fixed by making it literally a set of exact strings.
2. **HIGH — the new script was not protected machinery.** It was absent from `RISKY_PATH_RES`,
   the Codex `PROTECTED_HARNESS` set, and the `settings.json` protected-path rules, so its body
   could be edited without review and then invoked through the allowance. Now registered in all
   three.
3. **MEDIUM — the test only tried sanctioned commands**, so it probed neither bypass. Seven
   negative cases added (alternate directory, alternate interpreter + absolute path, traversal,
   UNC, glob, shell expansion, `NODE_OPTIONS` module injection) at both the unit and full-chain
   levels.

## Open findings, deliberately not fixed here

- `review-proof-guard.mjs` denies the **Read** tool on `.claude/session-state`, though its
  message only claims to block content being "created, moved, or deleted". An agent cannot
  inspect its own state files (only `cat` via Bash works). Widening a guard's read behavior
  deserves its own reviewed change rather than riding along on this one.
- The handshake's write-redirect check (`/>|\btee\b/`) treats a discard redirect like
  `2>/dev/null` as a file write, so it pauses harmless read-only commands.
- The `autopilot-arm.mjs` allowance beside the new one is still a loose substring match, so
  it can be ridden as a prefix on a chained command. Left alone here to avoid touching the
  arming path in a fix aimed at the clearing path.
