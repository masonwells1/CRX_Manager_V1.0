## 2026-08-26 — the heading now needs a real separator and a real description

The heading pattern ended in `\s*\S+`, which asks for one non-whitespace character after
the date and nothing more. So `## 2026-08-26x` passed with no separator at all, and
`## 2026-08-26 -` passed with a dash and nothing after it — both violating the format the
folder README promises. Same class as the bug fixed one commit earlier: the guard was
advertising a rule it did not enforce. Found by Codex on this PR and reproduced against
the running code before being fixed, not taken on the reviewer's word.

The pattern now requires whitespace, a dash, whitespace, and at least one more character,
and each failure gets its own message so the refusal names the actual problem rather than
restating the format.

The separator class is deliberately WIDE — hyphen, en dash and em dash all pass. Checking
first was the point: seven of the eight entries already in this folder use an em dash, so
requiring a literal `-` would have refused the convention's own history on the commit that
introduced the rule. A guard that rejects the repository it is guarding gets switched off,
and then it protects nothing.

98 assertions (was 90). Two mutations, both confirmed red before the fix was restored:
loosening the pattern back to `\s*\S+` breaks the malformed-heading tests, and narrowing
the separator to `[-]` breaks the en-dash and em-dash tests — so the wide class is covered
by tests rather than by a comment asserting it.
