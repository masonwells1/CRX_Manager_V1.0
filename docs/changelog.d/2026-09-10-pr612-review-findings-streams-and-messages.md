## 2026-09-10 - PR #612: close the named-stream read, refuse malformed input, and make every refusal say why

An independent read-only review of PR #612 at `855020270` (gpt-5.6-luna, max effort) returned seven
findings. This change addresses them in `.claude/hooks/review-proof-guard.mjs`:

- **Named NTFS streams (MEDIUM, introduced by #612).** `realpathSync.native` keeps a `:stream`
  suffix, so `<state>\x.json:stream` stopped ending in `.json`, the shape rule missed it, and the
  native-read exception allowed it — while `origin/main` denied it through its whole-directory rule.
  A stream-qualified path is now refused when it enters the state directory, or when its base name
  is a review-proof name anywhere (Windows only; narrowed by the two later 2026-09-10 #612 entries).
- **Own-state membership through an external junction (LOW).** Membership is now "the recorded state
  directory or anything beneath it", not "the parent directory equals it", so a file in a
  subdirectory of a junctioned state directory's real location is recognised.
- **Truthful denial messages (LOW, two findings).** Proof, JSON-by-shape, multi-link, stream and
  malformed refusals each carry their own reason; a failed native read of a missing target no longer
  receives the mutation-only "cannot be created, moved, or deleted" message.
- **Malformed input (MEDIUM, pre-existing on main).** A tool-input field whose text conversion throws
  used to crash the hook with no decision, which the harness treats as no objection. Any such field
  is now refused for every tool, before anything reads it. A native `Read` whose `tool_input` is a
  bare string is examined like the object form. Unparseable stdin JSON still passes with no decision —
  the convention every other hook in `.claude/hooks` follows — and a test records that convention.
- **Docs (LOW).** `KNOWN_ISSUES.md` and `agent-guardrails.md` now say the exemption covers non-JSON
  single-link regular files, not only flags and `.txt` captures, and describe the stream and
  malformed-input rules.
- **Skipped test cases (LOW).** Every skipped alias case is collected and printed in one summary
  line, and the Windows 8.3 short-name probe fails the test instead of silently skipping when `dir /x`
  itself errors.

Part of this work was started by a Codex (gpt-5.6-terra) run that was stopped half-way at the owner's
request to stop spending Codex credits; the remainder, the tests for the own-state stream, malformed
fields and the acknowledgement valve, and the verification were done in Claude.

**Verified by execution:** a side-by-side probe of `origin/main`'s guard and this one, driven with
real PreToolUse payloads against real fixtures including real named NTFS streams, returned the
expected decision in 15 of 15 cases (ordinary reads outside the state directory, through a junction,
and of real own-state flags and captures allow; own-state JSON, named streams on JSON and on text,
`::$DATA`, the directory, a missing target, Grep over the directory, and a string `tool_input` naming
state JSON deny). The guard's own test suite, `npm run test:correction-guards`, `npm run check:docs`,
`npm run lint` and `npx tsc --noEmit` were run before commit.

**Not changed, still open (documented in KNOWN_ISSUES.md):** the pre-tool check-then-open race
(alias retargeting, directory-to-junction and file-to-hard-link replacement after inspection),
interpreter and constructed-path reads, and outside-state hard links. No production, database, or
remote verification was performed.
