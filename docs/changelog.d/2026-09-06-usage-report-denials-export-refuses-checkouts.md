## 2026-09-06 - The usage report's denial export refuses to write inside a git checkout

The Codex GitHub App reviewed PR #613 at 1097d85e6 and flagged the documented
`node scripts/claude-usage-report.mjs --denials out.json` form: run from the
repository root it wrote the refused tool calls, which quote denied command text
verbatim, into an unignored worktree file that a later broad `git add` could
commit.

The export now resolves its destination and walks up from its parent directory;
if any ancestor owns a `.git` entry (a directory or a worktree's `.git` file) the
script exits 2 with a message naming that checkout root and nothing is written.
The rule is decided by that shape rather than by this checkout's name, so a
sibling worktree or an unrelated repository is refused the same way. Destinations
under a scratch directory keep working.

The Codex App's follow-up at 18c2faf17 showed the walk could be led past the
checkout by a parent that is a symlink or junction into it (`/tmp/export ->
<repo>/docs`): the spelled chain never reaches `.git` while the file lands inside
the repository. The export now canonicalises the nearest existing ancestor with
`realpathSync.native`, re-attaches the missing tail, and walks both the real and
the spelled chain; either one reaching `.git` refuses.

Regression cases cover a destination in the script's own checkout, one under a
temporary directory carrying a `.git` file, a relative path resolved against such
a checkout as the working directory, and a destination under a directory symlink
that points into the checkout; each must exit 2, print the reason, and leave no
file behind. A scratch destination must still receive the denials. Run before the
fix, the first case exited 0 and wrote the file into the checkout; the symlinked
case did the same against the lexical-only walk.
