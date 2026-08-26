## 2026-08-26 - a legacy ledger update no longer launders a malformed entry

The malformed-entry check sat inside the `triggers.length === 0` branch, so it only ran on
commits that touched nothing else. A commit that changed the agent surface **and** updated
`docs/CHANGELOG.md` satisfied `hasLedger` and returned `ok` before the check was ever
reached — carrying an unreadable fragment such as `docs/changelog.d/notes.md` in with it.
The folder README stated the refusal was unconditional. It was not. Found by CodeRabbit on
this PR, and confirmed against the code rather than taken on the reviewer's word.

The check now runs ahead of the trigger branch, so a malformed ADDED entry is refused no
matter what else the commit stages: not a trigger, not a legacy ledger update, and not a
well-formed sibling entry. Everything previously accepted is still accepted — this narrows
the pass, it does not rewrite the rules.

The earlier entry describing that round is left as written. It is an accurate record of
what that round did, and the fix for its limitation belongs in its own entry rather than in
a rewrite of history. That is the whole point of the convention.

90 assertions (was 83). The seven new ones were mutation-tested: restoring the old
`triggers.length === 0 &&` condition turns them red, so they cover the hole rather than
restating the fix. The shipped CLI was also exercised on a real staged commit, not just the
exported function.
