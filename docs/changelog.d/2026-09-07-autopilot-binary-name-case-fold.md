## 2026-09-07 — one capital letter defeated the whole armed-mode deny set (PR #607)

`.claude/hooks/autopilot-lib.mjs`'s `bin()` helper built its pattern from a
**lowercase literal** name inside a **case-sensitive** RegExp. Windows resolves
command names case-insensitively, so a single capital letter ran the same program
and defeated the entire deny set. Raised by CodeRabbit on PR #607 and reproduced by
**running** `autopilotDecision` against the library at `6600a825b` — not by reading
the regex:

| command | at `6600a825b` |
|---|---|
| `git push origin HEAD` (control) | deny |
| `GIT push origin HEAD` | **allow** |
| `Git push origin HEAD` | **allow** |
| `Git.exe push --force origin HEAD` | **allow** |
| `GIT.EXE push origin HEAD` | **allow** |
| `GIT reset --hard origin/main` | **allow** |
| `GH pr merge 625 --squash` | **allow** |
| `Gh.cmd pr merge 625 --squash` | **allow** |
| `GIT -C "C:/CRX Manager/wt" push origin HEAD` | **allow** |
| `DROPDB crx` | **allow** |
| `echo S >> .ENV` | **allow** |

While armed, this meant unattended mode did not actually prevent pushing,
force-pushing, merging, hard-resetting, dropping a database, or writing a secret to
`.env`. This is the fourth axis of the same binary-anchoring bug found on this
branch (global options, then the `.exe` extension, then the quoted path, now case).

## The fix

`foldCase(name)` rewrites each letter of the name as a two-character class
(`git` -> `[gG][iI][tT]`), and `bin()` uses that. The three deny rules that do not
route through `bin()` — the bare-word `dropdb`/`createdb` binary names and the two
`.env` **filename** patterns — take the same rule rather than a second,
differently-shaped fix.

**Only the NAME is folded, and that boundary is the point.** The binary name is
resolved by the case-insensitive Windows filesystem; the subcommand and the options
are parsed by `git`/`gh`/`supabase` themselves and are case-**sensitive**
everywhere. `git PUSH` and `--NO-VERIFY` are not commands, so a whole-pattern `i`
flag would claim catches that do not exist — and would additionally collapse `-C`
with `-c` inside `GLOBAL_OPTS`' nested quantifiers, which is the measured ReDoS this
pattern family already has. Inline `(?i:…)` is unsupported by this Node's engine.

It is a **rule, not a list**: the classes are derived from whatever name `bin()` is
given, so spellings written nowhere in the source or the tests are covered.
Verified by execution against the fixed library — `gIT push origin HEAD`,
`giT.CoM push --force origin HEAD`, `GIt.WhAtEvEr reset --hard origin/main`,
`sUpAbAsE.CmD db reset` and `gH.pS1 -R "o/r name" pr merge 625` all deny, while
`gIt status --short` stays allowed.

Every benign control still passes: `GIT status --short`, `GIT-crypt unlock`,
`gitfoo push`, `npm run gitpush`, `gh-dash pr merge 1`,
`git commit -m "fix the push bug"`.

## Timing

No regression. The character classes cost the same per position as the literals they
replace and add no branch point to give back. Measured on the pathological inputs
that caught the earlier 414ms quadratic:

| input | decided in |
|---|---|
| 20k-char `git.` repeat | 0.35 ms |
| 20k-char `GiT.` repeat | 0.35 ms |
| 20k-char `GIT.` repeat | 0.35 ms |
| 100k-char quoted `…/git.exe` path | 0.20 ms |
| 100k-char quoted `…/GIT.EXE` path | 0.21 ms |
| 400 global options + `status` | 0.23 ms |

The two 100 ms budgets in `autopilot-lib.test.mjs` are raised to 250 ms (also
CodeRabbit on #607). `Date.now()` is wall clock and this file runs in
`test:correction-guards` on shared Ubuntu and Windows runners, so it absorbs
scheduling pauses that have nothing to do with the regex. What the assertion detects
is a quadratic — 414 ms against ~0.3 ms — so 250 ms still fails the regression by a
wide margin while no longer flaking on runner noise.

## Known residual, NOT changed here

`rm -Rf build` still returns **allow** (`rm -rf build` denies). The `rm` rule spells
its recursive flag as a literal lowercase `r`, and GNU/BSD `rm` accepts `-R` as an
equivalent of `-r`. This is a different axis — an option-letter **alias**, not a
case-insensitive filesystem lookup, so `foldCase` is the wrong instrument for it and
folding options generally is the thing this change deliberately refuses to do. Left
for a separate, deliberate change rather than widened inside a CodeRabbit fix round.

## Files

- `.claude/hooks/autopilot-lib.mjs`
- `.claude/hooks/autopilot-lib.test.mjs` (34 new case assertions in both directions,
  plus mixed-case timing measurements)
