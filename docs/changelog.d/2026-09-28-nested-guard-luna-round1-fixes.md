## 2026-09-28 - Nested-command guards: fixes for Codex Luna round 1 on PR #795

Codex `gpt-6-luna` (xhigh) reviewed PR #795 on 2026-09-26 and reported 12 findings. Mason chose
"fix and accept" (see `docs/manual/DECISION_LOG.md`, 2026-09-28).

- **Inner-command cap (finding 2).** The one-level scan stopped quietly at 32 entries. Segments that
  differ only in spacing carry the same harmless inner command, which the caller de-duplicated below its
  own cap, so an admin merge after them was never read. The stop is now reported and refused (`tooDeep`).
- **Interpreter-fed input (findings 3 and 4).** `commandFedToInterpreter` no longer requires the text to
  name gh or git, so `Get-Content payload.txt | iex` and `bash < payload.txt` are refused. The bounded
  regexes are replaced by a linear lexer that reads the command as POSIX and PowerShell do (and as cmd
  does for a nested command). It follows quotes, `$( )` and backtick substitutions, here-document
  bodies and comments. A wrapper between the pipe and the interpreter (`| env bash`, `| sudo -u root sh`)
  is read through. So are `xargs -a file gh` and `Start-Process … -RedirectStandardInput`. An inner
  command that feeds an interpreter is returned by `expandNestedCommands` whatever it mentions, so
  `cmd /c "type payload.txt | bash"` is refused too.
- **Wrapper program (findings 8 and 9).** The six-word window after a wrapper is replaced by
  `programCandidates`. After a wrapper, each option is read both as a switch and as taking the next word.
  So `sudo -u root -g staff -H -n -E gh mm` is refused, and `timeout 30 echo gh mm` is not.
- **One nested-push policy (finding 10).** The Codex guard now refuses a push carried by another program,
  as Claude's push guard already did, instead of evaluating it.
- **Hook-level tests (finding 12).** Nested admin merges, the padded and capped forms, fed interpreters
  and wrapper aliases now run through the real `pr-merge-guard.mjs` hook, with controls.
- **Self-review of the new lexer (before Luna round 2):** four more ways to feed an interpreter are
  refused. A shell keyword before the command (`then bash < payload.txt`, `! bash < …`). A redirection
  before or glued to the program (`< payload.txt bash`, `bash<payload.txt`). `exec < payload.txt`,
  which replaces the shell's own input for every later line. And a language runtime reading its
  program from input (`… | node`, `python3 - < payload.py`), while `node script.mjs < data.json` still
  passes. `<<` inside `(( … ))` or `let` is a shift, not a here-document, so the lines after it are
  still read.
- **Luna round 2 (on `398e560`, 7 findings).** Every command now gets cmd.exe's reading too, not only
  nested ones: there `#` is not a comment and `'` is not a quote, so `type payload.txt # note | bash`
  feeds bash. cmd's reading stops at the first line, since cmd runs one line and has no
  here-documents. A single-quoted pipe into a shell is therefore refused; double quotes pass.
  A top-level program held in a `$` variable (`$p='gh'; & $p pr merge …`, `P=gh; $P pr merge …`) is
  refused when the command names gh, git, merge, push, api or alias. A PowerShell assignment
  (`$b = git branch`) is not a program. The run-time program check now finds the program behind a
  wrapper's options (`timeout 30 $P push …`). `sudo -- echo gh mm` and `echo -RedirectStandardInput bash`
  are no longer refused. `<<< "…" bash` was already covered by the self-review fixes. **Deferred
  (LOW):** `bash -c 'echo gh $HOME'` is still refused as computed text. The rule errs on the side of
  refusing, and narrowing it risks reopening the `bash -c '$0 …' gh` bypass it was written for.
- **Accepted residuals (findings 5, 6, 7):** script files; run-time program names in PowerShell or cmd
  syntax; the Codex guard not re-checking a non-gh decoded payload against its other rules. Finding 11
  (the pre-existing quadratic push parser) is tracked separately.
- **Proof:** `test:correction-guards`, `test:agent-workflows` and `eslint . --max-warnings=0` pass. Each
  new scan reads 200 KB of adversarial input in well under the hook limit.
