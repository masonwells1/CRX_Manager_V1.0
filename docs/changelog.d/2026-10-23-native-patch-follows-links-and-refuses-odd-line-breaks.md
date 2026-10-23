## 2026-10-23 - native patch: follow links, refuse odd line breaks

Third Luna review round on the native `apply_patch` envelope repair (`2026-10-23-native-apply-patch-command-envelope.md`).

- **Link targets.** A destination is now resolved through symlinks and junctions (including a
  directory junction in the middle of the path) and judged by where the write would really land.
  A link whose target does not resolve is refused, because a write through it would create the
  file at the target. Before this change the spelled path was the only thing checked, so a link
  named `src/notes.ts` pointing at a guard file passed. The older bare-string and `patch`-field
  routes still do not follow links; that gap is recorded as a follow-up.
- **Line breaks.** The strict parser reads only LF and CRLF as line ends. A patch that contains any
  other line break (lone CR, vertical tab, form feed, NEL, U+2028, U+2029) is refused, so a
  parser that treats one as a line end cannot be shown a header this parser never saw.
- Tests: junction fixtures for a linked guard directory, a linked proof directory and a dangling
  junction (file symlinks need a Windows privilege this account lacks, so those two cases run only
  where it exists), plus each line-break kind. Each safeguard was disabled in a scratch copy in
  turn and the suite failed.
