## 2026-10-23 - native patch: refuse control characters

Fifth Luna review round on the native `apply_patch` envelope repair. The line-break check only named
a few separators; the FS, GS, RS and US control characters (U+001C to U+001F) were missed, so a
parser that read one as a line end could see a protected-file header hidden inside what the guard
saw as one content line. The check is now general: any control character other than tab, LF and the
CR of a CRLF pair, and U+2028/U+2029, refuses the patch. Tests cover each separator, DEL and bell,
and confirm a tab in content stays allowed.

Recorded, not fixed: the time between the guard's check and the patch tool's write (a process that
swaps a destination for a link in that gap) is not closable from a pre-tool hook and applies to every
route; and the suite cannot call the real patch applier, so the real-applier proof stays the live
Codex run noted in the first entry. Both are noted in `docs/reference/agent-guardrails.md`.
