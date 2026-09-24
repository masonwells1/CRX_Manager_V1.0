## 2026-09-21 - `--disable-auto` no longer stands the merge gate down

A merge command that only cancels a pending auto-merge lands nothing, so the
guards used to skip their checks for it. That shortcut was the one place these
guards were looser than a plain merge, and each of its spellings became a way
around the gate. Codex found three on PR #630: the flag sitting in another
option's value position, a quote-spliced spelling reached through a substitution,
and repeated flags — `--disable-auto=true --disable-auto=false` performs a real
merge, because gh keeps the last value, while a flat "is it present?" scan saw a
cancellation.

Mason chose to remove the shortcut rather than model every spelling. A command
carrying `--disable-auto` is now gated like any other merge, in both guards.
Cancelling an auto-merge is rare and being checked costs nothing, and the change
deletes the special case instead of adding more of them. This is stricter than
main, whose Claude-side guard stands down on any bare `--disable-auto`.

Locked in by assertions in `.claude/hooks/codex-push-lib.test.mjs` and
`.claude/hooks/pr-merge-guard.test.mjs`, hook-process denials in
`.claude/hooks/guards.test.mjs`, and end-to-end denials for five spellings in
`.codex/hooks/production-action-guard.test.mjs`. Checked through both real guard
processes with gh unreachable.

Found by the `gpt-5.6-sol` exact-SHA review of `633dc326f` (HIGH) on PR #630.
