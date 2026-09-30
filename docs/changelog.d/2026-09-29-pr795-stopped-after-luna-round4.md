## 2026-09-29 - PR #795 guard fixes stopped after Codex Luna round 4

Mason agreed before round 4: if it still found serious holes, stop fixing the parser and put the
server-side alternative (no administrator bypass on `main`) to him. Round 4 (`gpt-6-luna` xhigh, on
`eb1d166`) reported 7 findings. The PR stays a draft.

- **Three BLOCKERs, each confirmed with the real guard hooks (all three guards allowed each one):**
  1. `python3 -W ignore -` reading its program from a pipe: `runtimeReadsProgramFromInput` treats
     `-W`'s value as the script.
  2. `! powershell.exe "<admin merge>"`: `isCommandPosition` does not know the `!` keyword, so the
     positional PowerShell command is never unwrapped.
  3. A backslash-newline line continuation inside a nested raw REST merge URL (`…/mer\` + newline +
     `ge`): quote removal leaves the newline, so neither the nested filter nor the endpoint check sees
     `merge`.
- **Two MEDs and two LOWs, all over-refusals:** `if ($true) { gh pr view 12 }`, `echo bash -c "…"`,
  `echo x | node --version`, and `Start-Process findstr … -RedirectStandardInput … -ArgumentList bash`.
- **Trend:** 12, 7, 7, 7 findings over four rounds, each round in places the previous one did not
  reach. Every fix held, but reading every shell's syntax from text keeps turning up new cases.
- **Next:** Mason's decision on the server-side backstop. Nothing in this PR loosens a guard; every
  round's fixes only add refusals.
