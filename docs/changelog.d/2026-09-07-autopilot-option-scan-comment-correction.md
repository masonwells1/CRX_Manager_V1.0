## 2026-09-07 - Correct an over-claim in the autopilot option-scan comment

**Class:** a source comment asserting a verdict nobody re-measured. **Outcome:** comment
corrected to the claim that actually holds; no behavior change.

The option-scan comment added earlier the same day
(`docs/changelog.d/2026-09-07-autopilot-recursive-delete-aliases.md`) illustrated "this is not
a general case-fold of option letters" with the example `rm --recursive -F`, claiming it stays
`allow`. Re-measured against the real `autopilotDecision`: it **denies** — correctly, and for
a reason the sentence got wrong. `--recursive` is present, so the command is a recursive
delete regardless of what `-F` means.

The claim that does hold, and the one `autopilot-lib.test.mjs` actually asserts, is
`rm -F build` → `allow`: the undocumented uppercase letter **on its own** is not treated as a
force alias, because inventing an alias `rm` does not document would over-deny. The comment
now says that, and notes explicitly why the `--recursive -F` combination denies.

Worth recording rather than silently amending: the wrong example was the one sentence in the
change whose whole job was to stop a future reader from reaching for a case-fold, and it
illustrated the rule with a case the rule does not decide.

**Files:** `.claude/hooks/autopilot-lib.mjs` (comment only).
