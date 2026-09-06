## 2026-09-06 - The denials export canonicalises before collapsing, and writes what it checked

The Codex GitHub App's review of PR #613 at 1e529b3ca defeated the export's
git-checkout refusal with a symlink followed by `..`.

`path.resolve` collapses `..` lexically, before any link is followed. So for a
destination like `<scratch>/alias/../out.json`, where `alias` points into a
checkout, the guard evaluated `<scratch>/out.json` and approved it, while the
operating system applied `..` to the link's *target* and put the file at the
checkout root. The reviewer reproduced an exit-0 export landing inside a fake
checkout, and so did we before fixing it.

Two changes close it.

The destination is now canonicalised one segment at a time, resolving each
existing segment with realpath before descending into the next. Because the
walk always stands on the real directory, `..` applies to the true parent and
neither a symlinked parent nor a `..` after one survives. A segment that does
not exist cannot be a link, so the lexical join is already canonical there.

The canonical path is also the path written to. Previously the checks ran on a
resolved path while the write used the raw input string, which is what allowed
the check and the write to follow different chains. Checking one path and
writing another is the underlying defect; the lexical collapse only exposed it.

The regression fixture builds the evasion by string concatenation rather than
`path.join`, because `path.join` would normalise the `..` away and the case
would prove nothing. It asserts the run is refused and that no file appears at
the location the operating system would have resolved. On the previous code the
run exits 0 and the export appears inside the fake checkout.
