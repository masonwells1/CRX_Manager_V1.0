## 2026-08-26 — an impossible date is not a date, and the #401 merge kept one fixture

`ENTRY_RE` matched any `\d{4}-\d{2}-\d{2}`, so `2026-13-01`, `2026-01-32` and `2026-02-31`
all read as valid entry filenames. The month and day are now range-checked in the pattern
itself, and because a regex cannot know how long February is, the well-shaped-but-
nonexistent dates are caught by a calendar round-trip: JS normalises Feb 31 to Mar 3, so
the fields stop matching. Leap years fall out correctly — `2024-02-29` is accepted and
`2025-02-29` is not. The stop hook imports `ENTRY_RE`, so it inherits the range check
without a second copy to keep in step.

**Merge resolution worth recording.** Landing #401 conflicted here, in the one file both
branches touched. Both sides had independently routed the rename fixture through
`scratchHookEnvironment` — the corruption fix — but at different points in the file, and
the merge produced two declarations of `fixtureEnv`. Kept main's, which sits inside the
`try` where it is used and whose comment already reconciles the #486 landing; dropped this
branch's top-level copy. Two correct fixes for the same bug arriving from two directions is
a duplicate to resolve, not a regression to fix, and the wrong resolution here would have
been shadowing rather than a visible error.

111 assertions (was 103). The calendar check is mutation-tested: replacing its condition
with `false` turns the February 31st case red. Every entry already in this folder was
re-checked against the tightened pattern and none regressed.
