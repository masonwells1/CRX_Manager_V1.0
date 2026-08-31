## 2026-08-31 — recognize every Git false boolean and anchor the `requireForce` check

Two corrections to the `clean.requireForce` override detection added earlier the same day, both
raised by the CodeRabbit follow-up review of PR #527.

**P1 — false booleans.** Git accepts `false`, `no`, `off`, `0`, and an empty value as false. The
first version matched only the literal `false`, so this walked straight through:

```bash
git -c clean.requireForce=0 clean -e '*.tmp'
```

All five spellings now match, case-insensitively. A boundary lookahead keeps `=true` — and any other
value — from matching, since a truthy setting leaves `git clean`'s own refusal in effect.

**P2 — anchoring.** The override alternative was not tied to a `git … clean` invocation, so any
command merely *containing* the text was denied. Both of these were blocked:

```bash
rg -n "clean.requireForce=false" .
grep -rn clean.requireForce=false docs
```

That was a new false positive introduced while fixing false positives — the same defect class the
parent change exists to remove. The alternative now requires `git`, then the override, then a `clean`
subcommand matched *after* the value, so `git -c clean.requireForce=false status` and
`git config --get clean.requireForce` stay allowed.

**Verification.** Through the live hook stack, not only by tests:
`grep -rn "clean.requireForce=false" docs/changelog.d/` now runs and returns matches; it was denied
by the previous version of this pattern.

`bash-safety` suite 450 → 460 assertions, pinning both directions — every false-boolean spelling
blocked, and `=true`, config reads, an override with no `clean` subcommand, and text searches all
allowed.

No product code, migration, database, money, inventory, RLS, or customer-visible change.
