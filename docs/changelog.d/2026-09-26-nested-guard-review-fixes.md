## 2026-09-26 - Nested-command guards: fixes from the independent Opus review of PR #795

Mason chose an independent Opus 5.5 adversarial review in place of waiting for Codex credits. It
returned NOT CLEAN; every finding below was reproduced by the reviewer, fixed here, and re-measured
against a merge-ready fixture (approved, clean, green, valid Sol proof).

- **HIGH, regression — quadratic unwrap let the hook time out (and a timed-out hook allows).**
  `echo (x) a\b` + 12,000 × `start -x` + an admin merge took 34.5 s in the Codex guard (origin/main:
  0.6 s). Every per-program scan in `expandNestedCommands` now stops after `NESTED_SCAN_WINDOW` (64)
  words, a word starting with `-` never counts as a program, and the new here-document regex is bounded.
  Measured now: 64–330 ms for the review's inputs, under 0.5 s at 200 KB; a test pins < 3 s.
- **HIGH — Start-Process spellings.** `-ArgumentList 'pr', 'merge', …` (spaces after commas) and
  `-ArgumentList:'…'` / `-FilePath:gh` were misread. Start-Process is now read as one flat command:
  program plus every argument word, commas as separators, `-Name:value` honoured.
- **HIGH — `bash --rcfile x -c …` / `--init-file x`.** Those options now consume their value.
- **HIGH — wrappers hid a gh alias.** `timeout 30`, `nice`, `sudo -u root`, `env -u X` and similar now
  count: after a wrapper the first `gh` within six words is the program checked.
- **MED — commands fed on input.** `'…' | iex`, `| Invoke-Expression`, `echo … | bash`, `bash <<< …`,
  here-documents, `| xargs gh`, and `| xargs git … push` are refused when the command involves gh or git
  (`commandFedToInterpreter`, all three guards). `iex -Command:'…'` is now unwrapped.
- **MED — run-time text in a nested shell.** `bash -c '$0 pr merge 1 --admin' gh` is refused
  (`expandNestedCommands(...).computed`, all three guards).
- **HIGH — a program NAME built at run time** (found while checking round 2's code-reading note):
  `bash -c 'g$1 pr merge 1 --admin' x h`, `${P}h …`, `$P …`, `` `echo g`h … ``, `& $p …` never spell gh or
  git, so both Claude guards allowed all of them and the Codex guard allowed the backtick form. They are
  now refused when the inner command's program word itself is built at run time; a variable in an
  argument (`echo $HOME`, `ForEach-Object { $_.Name }`) still passes.
- **MED — PowerShell en/em dash parameters** (`pwsh –EncodedCommand …`) are read as `-`.
- **MED — over-blocks.** A bare word after `pwsh` is a command only when pwsh is the program
  (`which -a pwsh gh git node` passes). The gh-alias check skips fragments the naive reading cut out of
  a quoted string (`git commit -m 'x; gh mm …'` passes) while still splitting on separators that are
  escapes in one shell and not another (`\;`, `^&`).
- **LOW, not changed:** a merge written both plain and nested is gated twice; the shared deadline
  still bounds it.

**Proof:** 52-command differential probe (Codex guard in-process, both Claude guards as hook
subprocesses) — every reported bypass now denied by each guard responsible for it; no harmless command
refused. New assertions in `codex-push-lib.test.mjs`, `pr-merge-guard.test.mjs` and
`production-action-guard.test.mjs`. `test:correction-guards`, `test:agent-workflows` and
`eslint . --max-warnings=0` pass.

**Not verified:** PowerShell itself was not available, so the en-dash reading follows the PowerShell
parser's documented behaviour rather than a live run. A script file (`bash x.sh`, `pwsh -File`) still
runs text no guard can see. The review is same-model-family; the `gpt-5.6-sol` review has not run.
