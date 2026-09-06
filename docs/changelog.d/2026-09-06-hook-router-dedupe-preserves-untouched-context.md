## 2026-09-06 - The hook router's block deduplication leaves untouched contexts byte-for-byte

CodeRabbit's review of PR #613 at ebebfc34d found that `dedupeContextBlocks`
trimmed every routed hook context and collapsed its runs of blank lines even when
no configured block was replaced, including when no block was configured at all.
`mergeOutputs` calls the helper for every router output, so every hook module's
`additionalContext` was being normalised, contrary to the helper's own comment
that nothing else in a module's text is rewritten.

The helper now records whether a replacement happened in a given context and
returns the context unchanged otherwise. The blank-line collapse and trim run only
on a context that was rewritten, to close the gap the removed block leaves.

Regression cases pin the no-block path, the block-configured-but-absent path, and
the first-occurrence path with a context carrying leading and trailing whitespace
and a run of four newlines (each must come back identical), and pin that the
replaced context alone is trimmed and collapsed. Run against the previous helper,
the three preservation cases fail.
