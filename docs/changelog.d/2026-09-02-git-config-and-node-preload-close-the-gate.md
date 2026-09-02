## 2026-09-02 — `git config` could switch off every husky gate, and `node` could preload code against a protected file

Two guard closures in `review-proof-guard.mjs`, both from CodeRabbit's review of PR #530 head
`39921016`, plus four defects in the checking machinery around them.

**1. `git config` was allowlisted as read-only, and it writes.** The write that matters does not
touch a guarded file at all — it decides whether the guards RUN. `git config core.hooksPath
<elsewhere>` disables every husky gate in one ordinary command, and `config` sat in
`ENFORCEMENT_READ_ONLY_GIT`, so the guard permitted it. Probe-confirmed ALLOW before the fix, for the
plain, `--global` and `--unset` forms.

This is not a hypothetical. It already has its own `KNOWN_ISSUES` entry as a live weakness on `main`,
and it is the mechanism that left a worktree **created minutes earlier in this same session**
running a foreign checkout's hooks — the foreign `pre-push` hashing `ecbfa558` against the tracked
`663b2d18`, different code, so any local "the pre-push checks passed" claim from that tree was
describing hooks nobody had read.

Worth recording why seven adversarial rounds missed it: every earlier bypass needed an exotic flag to
smuggle an executor past a reader (`rg --pre`, `git -c`, `git grep -O`, `--ext-diff`, `node -r`,
`GIT_EXTERNAL_DIFF`, `gh -D`). Reviewers hunting that shape kept finding more of it. This one is a
command anybody might type for an innocent reason, and it takes down the entire gate rather than one
file.

Reads stay allowed. The **one** permitted write is repointing `core.hooksPath` at the tracked
`.husky` — the documented repair, which a fresh worktree needs precisely because it is seeded
pointing elsewhere. Denying that too would strand the repair, which is the deadlock this file's
history has already paid for twice.

Matched as an **exact whole-segment shape**, not by searching for `.husky` somewhere in the line. The
first attempt did the latter and accepted `git config --unset core.hooksPath .husky`, which removes
the setting and drops hooks back to `.git/hooks` — disabling husky just as thoroughly as repointing
it. `--type` is likewise not treated as a read flag, because a SET takes it too and
`git config --type=path core.hooksPath /evil/.husky` would otherwise have passed.

**2. `node` injects code through three channels, not one.** The eval flags were covered; PRELOAD
(`-r`, `--require`, `--import`) and LOADER hooks were not, and both run **before** the entrypoint, so
`node -r ./payload.cjs .husky/pre-push` executed the payload against the named hook. The old regex
also missed bundled short forms: `\b` after `-p` does not match inside `-pe`, so the eval check it
was written for did not fire. Now any short-option cluster containing `e`, `p` or `r` is refused,
which closes the bundling gap without a spelling list — node's other short flags (`-c`, `-i`, `-v`)
contain none of those letters, so `node script.mjs`, which is how this suite runs, still works.

**3. The ratchet grandfathered ANNOTATED claims.** `--update-baseline` baselined every claim it
found, annotated ones included, but the check already exempts anything annotated — so those entries
did nothing except outlive the annotation. Delete a claim's `@proven-by` later and the baseline still
vouched for it: the ratchet stayed green while the evidence it named was gone. That is the exact
failure this script exists to prevent, sitting inside the script. Baseline regenerated at 163, net
unchanged because three annotated `review-proof-guard` claims dropped out as three genuinely
unannotated `autopilot-lib` claims arrived with the #548 merge.

**4. A test proved a workaround without exercising it.** The bracket-class assertion passed a plain
literal containing neither a bracket class nor the quoting that triggers the over-block it documents.
It would have stayed green if the workaround broke.

Also corrected: the ratchet changelog claimed 159 baseline entries against a file holding 163; two
fenced blocks lacked a language identifier; ordered-list markers in the handoff audit were renumbered
with the historical finding numbers preserved in the item text.

**Verification.** A 33-case probe against the real hook, zero mismatches: nine ways of disabling the
gate refused, seven legitimate config and repair forms allowed, seven node injection channels
refused, `node script.mjs` and `node --check` allowed, plus every regression canary from the earlier
rounds and four false-positive canaries. `npm run test:correction-guards` passes end to end and the
audit reports no new unbacked claims.
