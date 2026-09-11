## 2026-09-10 - PR #612: cover cwd/workdir in the malformed-input refusal, and stop two over-blocks

An independent read-only review (Claude Opus) of `e4dd7bbb5` returned seven findings, none a blocker.
This change addresses the ones that were real:

- **Malformed `cwd` / `workdir` still crashed the hook (MEDIUM, pre-existing on main).** The refusal
  added in `3b77cbc67` ran AFTER the hook had already converted the payload's `cwd` and the tool's
  `cwd`/`workdir` to text, so an object whose `toString` is null still threw, exited 1 with no
  decision, and let the read through. The refusal now runs first and covers the payload's `cwd` and
  `tool_name` too. The earlier changelog and `KNOWN_ISSUES.md` said the refusal applied "for every
  tool, before anything reads it" when it did not; both now describe what the code does.
- **Over-block: any argument carrying a `toString` key (LOW, new in #612).** The refusal inspected
  every top-level tool argument, so an unrelated MCP argument such as `{ data: { toString: "hello" } }`
  (or an array nested tens of thousands deep) was refused. It now inspects only the fields this hook
  actually converts to text: `cwd`, `workdir`, `patch`, `diff`, `input`, `changes`, the path fields and
  `command`/`cmd`.
- **Over-block: a stream on any `.json` file (LOW, new in #612, Windows).** Outside the state
  directory the stream rule now refuses only a review-proof base name, so an ordinary JSON file's
  `Zone.Identifier` marker (for example on a downloaded `package.json`) stays readable. The message
  now says what is refused and why.
- **Silent skips (LOW).** Three 8.3-alias branches that dropped cases without recording them now call
  `skipAliasCase`, so the summary line counts every skipped case.
- **Changelog accuracy (LOW).** The Windows-only entry no longer claims POSIX behaviour "returns to
  exactly" `855020270`; only the stream rule is inert there.

Not changed, reported and left as documented residuals: a Windows short (8.3) directory name plus a
trailing dot or space is allowed by main and by this PR — native `Read` and Node `fs` report the file
missing, but a reader that applies Windows path normalization (for example `cmd /c type`) opens it.

**Verified by execution** (Windows): the guard's test suite, including new cases for a malformed
payload `cwd`, a malformed nested `cwd`/`workdir`, unrelated `toString`-keyed MCP arguments (allowed),
and a real `Zone.Identifier` stream on JSON outside the state directory (allowed); the side-by-side
probe against `origin/main`'s guard; `test:correction-guards`; `check:docs`; `lint`; `tsc`. CI on
`e4dd7bbb5` (Linux and Windows) passed in full before this change.
