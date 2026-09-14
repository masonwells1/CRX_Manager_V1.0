## 2026-09-10 — Reset-order scanner masks comments before excusing a reset

CodeRabbit's review of PR #638 at `0e7ee9d4b` found that `classify()` in
`src/__tests__/idempotency-reset-order.test.ts` read its three look-back windows as RAW
source. The per-line `stripNoise()` cannot see a multi-line `/* … */` block, so comment
or string text could supply a recovery marker, `.throwOnError()` or `onClick=` and excuse
a reset that has no executable guard.

Its review at `00993da04` found the same hole through two more routes. The first fix
still blanked strings one line at a time and never blanked a regex literal, so a regex
on the line above a reset, or a template literal spanning lines, could supply that text.

`classify()` now reads every window through a new `maskNonCode()`. It masks comments,
string contents, template-literal text and regex-literal bodies across the whole file
prefix up to the reset, keeping line breaks, so a block or template opened above a window
still counts. A template's `${…}` interpolation stays code. A `/` opens a regex only where
an expression can start (after `(`, `=`, `,`, `=>`, `return` and similar), so division and
JSX closing tags stay code. An unclosed quote ends at the line break, so JSX text such as
`Don't` cannot mask the lines after it. The recovery, fire-and-forget and intent-rotation
windows, plus the same-line guard check, all read that masked text. Test-only: no
application code changed. `docs/manual/KNOWN_ISSUES.md` residual (h) and the scanner's own
comments say that only `aliasNames()` still reads raw source.

Proof observed:

- First fix: seven negative cases (four recovery-marker, one `.throwOnError()`, two
  intent-rotation, including a block comment opened above the 8-line window). Each one
  failed separately against the unfixed scanner in a soft-assert run.
- Second fix: seven more negative cases. There is a regex literal above the reset for
  each of the three excuses, a quote inside a regex followed by a block comment, and a
  multi-line template for each excuse. In a soft-assert run against the first fix's mask,
  all seven failed and nothing else did. Five positive controls pass on both masks:
  division with a second `/` on the line, code inside a template interpolation, an
  apostrophe in JSX text, a handler between two JSX closing tags, and a mutating call
  after a regex on the same line.
- After the fix, all 21 tests in the file pass. That includes the repo-wide sweep
  (no new offenders), the exact pins for known-unfixed files, and the stale-allowlist
  check. So no current site was being excused only by comment, string, template or regex
  text.
- `eslint --max-warnings=0` on the file and `npm run typecheck` are clean.

Not verified here: the full `vitest` suite, which CI runs. The mask is still a scanner,
not a lexer:

- a `/` after `]`, `}` or `<` is read as division, so a regex literal written there stays
  visible, which is the old behaviour. A `/` after `)` is masked only when that `)` closes an
  `if`, `for` (including `for await`), `while`, `switch` or `catch` head — the third- and
  fourth-round fixes below
- a `//` inside JSX text masks the rest of its line

Third round — CodeRabbit's review at `fb1c7cd0f` found the `)` half of that limitation was
exploitable: `regexCanStart()` rejected `/` after any `)`, so a regex written as a control
statement's BODY (`if (ready) /getIdempotencyBindingRejection/.test(value);`) stayed visible and
`classify()` read the marker inside it as executable recovery evidence. `maskNonCode()` now tracks
which `(` opened a control head and masks a regex after that head's `)` only. Proof observed: the
three new negative cases (an `if`, a `while` and a `for` body) were added FIRST and the `if` case
failed against the unfixed mask with `expected 'recovery' to be null`; after the fix all 22 tests in
the file pass, including the repo-wide sweep and the exact pins, so no current site was excused this
way. Three positive controls hold: division after an ordinary `)`, division inside a control
statement's body, and an executable recovery call as that body.

Fourth round — CodeRabbit's review of delivery PR #663 at `392415f64` found that the head check read
only the word immediately before `(`, which in `for await (const v of values)` is `await`, so a
regex written as that loop's body stayed visible and excused a reset. `opensControlHead()` now
accepts `await` when the word before it is `for`, and nothing else. Proof observed: the new
`for await` negative case was added FIRST and failed against the unfixed check with
`expected 'recovery' to be null`; a new positive control keeps a bare `await (a + b) / 2` read as
division, so a lone `await` still opens no control head.

Fifth round — CodeRabbit's review of delivery PR #668 at `e00f5870f` found that both keyword checks
read a property NAME as a keyword. In `obj.return / 2 + supabase.rpc('save') / 3` the `/` after
`return` opened a false regex that masked the rest of the line, including the mutating call. That
call is what stops `classify()` from accepting an intent-rotation excuse, so the reset was excused.
`helpers.if(a) / 2 + …` did the same through the control-head check. `maskNonCode()` now treats a
word whose nearest non-space character before it is `.` (which covers `?.`) as a property: it is not
a keyword and does not open a control head. The `for await` and bare-`await` behaviour is unchanged.
Proof observed: the new test (four negative cases, two positive controls, and two keyword controls)
was added FIRST. It failed against the unfixed mask with `expected 'intent-rotation' to be null`.
After the fix, all 23 tests in the file pass, including the repo-wide sweep and the exact pins.

Sixth round — CodeRabbit's review of delivery PR #684 at `9ea5e7b3e` found that
`findResetBeforeAssert()`, which chooses the reset sites `classify()` then judges, still stripped
each line on its own, so a multi-line comment could pose as a call followed by a reset. It now scans
the same whole-file `maskNonCode()` text as `classify()`. The same review's Major, a regex written
after a statement-block `}`, is the documented `}` limitation above; Mason deferred it on 2026-09-14
and it is tracked in issue #686.

Seventh round — the Codex App review of delivery PR #687 at `8b587e76e` (P1) found the repo-wide
checks could exceed Vitest's 5-second timeout. `classify()` re-masked the source prefix for every
reset it judged, and `findResetBeforeAssert()` masked every scanned file once per check, three
checks in all. One full `maskNonCode()` pass over the 409 swept files (7.6 MB) measured 856 ms
locally, so a machine several times slower reached the limit. Each file is now masked once per run:
`classify()` reuses one whole-file mask per `lines` array, `findResetBeforeAssert()` caches per path,
and the three repo-wide checks carry an explicit 30-second timeout for slower machines. Reusing the
whole-file mask is equivalent because `maskNonCode()` never looks back and only looks ahead past a
construct already opened; a throwaway test compared the prefix mask with the whole-file mask at every
`resetKey` line under `src/` and found zero mismatches.

Eighth round — CodeRabbit's review of delivery PR #690 at `1fcbaabf0` found that `regexCanStart()`
read the second `+` or `-` of a postfix `++`/`--` as an expression start, so in
`count++ / 2 + supabase.rpc('save') / 3` the text between the slashes, including the mutating call,
was masked and an intent-rotation excuse could pass. A doubled `+` or `-` directly before `/` now
reads as division. Proof observed: the new negative cases were added FIRST and failed with
`expected 'intent-rotation' to be null`; positive controls keep evidence after a postfix operator
visible and still let a regex start after a binary `+`. CodeRabbit noted no current `src` site was
affected. The same review asked for direct coverage that `assertTransferResultForJob()` accepts a
`job_id` differing only in letter case; `src/lib/db.test.ts` now has that case.
