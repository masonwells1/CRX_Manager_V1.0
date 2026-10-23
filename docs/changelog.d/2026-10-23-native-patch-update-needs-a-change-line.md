## 2026-10-23 - native patch: an Update section must add or remove a line

Follow-up to `2026-10-23-native-apply-patch-command-envelope.md` (first Luna review round). The
strict patch parser accepted an `Update File` section holding only context lines, which edits
nothing and which the real patch applier rejects. It now requires at least one added (`+`) or
removed (`-`) line, and the guard suite pins the context-only and end-of-file-marker-only cases.
The same round also checked that the exact tool-name match (`apply_patch`) does not accept a name
with a trailing newline or space; tests for those spellings were added.
