## 2026-09-06 - The denials export keeps the whole command and the whole reason

The Codex GitHub App's review of PR #613 at 65f0a8458 found that the
`--denials` export of `scripts/claude-usage-report.mjs` clipped the two strings
it exists to preserve: the refused command was stored at 300 characters and the
guard's reason at 160. The reviewer reproduced it with a 400-character Bash
command and a long review-proof reason, and neither ended up complete in the
export.

That defeats the feature. The export is an adjudication record, so a reader has
to see the exact invocation that was refused and the guard's complete
explanation. Neither string is ever printed to the console, so the clipping
bought nothing.

Both are now stored whole. The one remaining bound is the 400-character `head`
slice, which is unchanged because it only feeds the classification regexes that
decide which guard refused the call; the stored reason no longer derives from
it.

The regression fixture now refuses a command well past 300 characters and a
reason well past 400, each ending in a sentinel, and asserts both sentinels
survive into the exported JSON. On the previous code the run fails on the
command sentinel, with the 300- and 160-character prefixes visible in the
assertion output.
