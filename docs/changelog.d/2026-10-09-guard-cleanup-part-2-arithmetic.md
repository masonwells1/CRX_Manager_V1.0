## 2026-10-09 — guard cleanup, part 2: arithmetic is not a command

Follows `2026-10-07-guard-cleanup-part-2-luna-round-3.md`.

**Fixed (Codex connector review of head f0340762e)**

- `codex-push-lib.mjs`: the new `$( … )` split read an arithmetic `$(( … ))` as a command, so `i=$(($i+1)); git status` was refused by both the merge and push guards (main allows it). An arithmetic `$(( … ))` is now left in place and read exactly as main reads it; only a `$( … )` nested inside it is taken out and checked. Regression cases in `codex-push-lib.test.mjs`.

**Proof observed**

- A probe of 17 shapes against main's library and this head gives the same answer for every shape except the read-only `while read` loop, which part 2 already allows. `x=$(( $($P pr merge 1 --admin) + 1 ))`, `$(($P pr merge 1 --admin))` and `x=$((cd sub; $P pr merge 1 --admin) )` are still refused. `npm run test:correction-guards` and `npm run test:agent-workflows` exit 0.

**Luna round (head 0ef017083): one LOW, fixed.** Luna said two test cases were not runnable attacks. Checked in bash 5.3: `x=$((cd /; $P …) )` does run its command (a subshell, not arithmetic), so that case stays, now labelled; `$(($P pr merge …))` is an arithmetic syntax error that runs nothing, so it was dropped from the refusal list.

**Pre-existing, open (refused on main as well, not touched here)**

- Arithmetic written with spaces, such as `i=$(( $i + 1 ))` beside a git command, is still refused as a run-time program. Fixing it means hiding arithmetic text from the program check, which the 30-day guard freeze leaves for later.
