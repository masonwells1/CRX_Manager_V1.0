## 2026-09-07 - migration-apply-guard tests: allow-assertions now print the guard's own refusal text

Test-only change to `.claude/hooks/migration-apply-guard.test.mjs`. No guard, hook,
permission, or production behavior changed.

### Why

`migration-apply-lib.mjs` fails CLOSED by construction: it caps every git call at
`GIT_CALL_TIMEOUT_MS = 1_500` and converts any throw — a timeout included — into one of
its ~30 distinct `return block(...)` sites. The overwhelming majority of this suite's
assertions expect a deny, and a *spurious* fail-closed block satisfies every one of them
for the wrong reason. The handful of allow-assertions are therefore the suite's entire
detection surface for a guard that has started refusing when it should not.

Those assertions were written as a bare negated deny predicate with a label and no
diagnostics, so a failure reported that an allow was expected and a deny arrived — and
nothing about *which* block fired. The one signal the suite has was the one signal that
could not be read.

Observed 2026-09-07: `Phase 3C Containment (Windows)` on PR #592 at `4cb4cb674` failed
the "ARMED run: restored fresh proofs allow again (sanity)" case, then passed on a re-run
of the identical commit. Branch content (9 changed files, none under the Claude hooks
directory), every expiry window (53s step against 30-minute proof/ref windows and a
24-hour snapshot window), leftover fixture state, and local slowness (10 concurrent local
Windows runs, all green) were ruled out. The mechanism was never proven, because no deny
reason was printed.

### What changed

- Added `describeHookRun(r)` and `okAllow(r, label)`. On failure the assertion message now
  carries the hook's exit status, any signal, any spawn error, and the full `stdout` and
  `stderr` — so the guard's own refusal text names the `block(...)` that fired. The
  diagnostics are built only on the failing path.
- Converted all ten allow-assertions in the file to `okAllow`, not only the two named in
  the report — the same reasoning applies to every one of them.
- Added a self-scan at the end of the suite that reads its own source and fails, naming
  the line, if the bare form reappears. A comment asking the next author to remember is
  soft scaffolding; this makes the convention enforced. The scan runs with no exclusions,
  so nothing in the file may carry an unenforced example of the shape it forbids.

### Proof observed

- `node .claude/hooks/migration-apply-guard.test.mjs` → `113 assertions passed`
  (112 pre-existing plus the self-scan).
- Mutation 1 — temporarily bound the restored Codex proof to different SQL, so the
  "restored fresh proofs allow again (sanity)" assertion genuinely failed. The failure
  printed the real deny: `MIGRATION APPLY GUARD (hands-free run): the Sol high-effort gate
  is not satisfied ... (queryHash does not match the transmitted SQL)`, plus
  `hook exit status: 0` and an empty stderr. Reverted.
- Mutation 2 — temporarily restored one bare allow-assertion. The self-scan failed with
  `unconverted assertion(s) at line(s): 465`. Reverted.
- `npm run test:agent-workflows` and `npm run agent-health` both green.

### Not verified

The intermittent CI failure itself is still unexplained. This change does not fix it and
does not claim to; it guarantees the next occurrence names its own cause instead of
requiring another round of elimination.
