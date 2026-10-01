## 2026-09-29 - Nested-command guards: Codex Luna round 3 findings fixed (PR #795)

Mason resumed PR #795 ("resume pr795") after parking it at the round-3 cap. Round 3's findings, fixed or
dispositioned:

- **Finding 2 (raw REST merge inside another shell):** the exact form quoted
  (`bash -c 'curl -X PUT …/pulls/123/merge'`) was already refused, because the outer text names the
  endpoint. Three disguised forms passed both merge guards, measured with the real hooks before the fix:
  a base64 `pwsh -EncodedCommand` carrying `Invoke-RestMethod`, `mer^ge` inside `cmd /c`, and `mer\ge`
  inside `bash -c`. Inner commands that mention a merge are now returned for scanning, and the
  merge-endpoint and `mergePullRequest` checks also read the text with shell quoting and escapes removed.
- **Finding 3 (newline after `|`):** a line ending in `|` now carries the pipe to the next line, as bash
  and PowerShell do, including after a comment.
- **Finding 4 (`$'EOF'` here-document delimiter):** `$'…'` is decoded as bash decodes it (so `$'E\x4fF'`
  ends at `EOF`), and `$"…"` reads as `"…"`. A here-document whose closing line never appears is now
  refused, so a delimiter the lexer misreads can no longer hide the commands after it.
- **Finding 5 (MED, `echo 'x | bash'` refused):** cmd's reading now splits words on cmd's own rules
  (only `"` quotes and `^` escapes), so its stage `bash'` is not read as bash. The test that asserted the
  refusal now asserts the command passes.
- **Finding 1:** the 2026-09-28 DECISION_LOG entry's last paragraph was reworded as a plain record.
- **Deferred (over-refusals only, fail-safe):** `env -u gh echo ok`, `(( x = 1 | bash ))`, and round 2's
  `bash -c 'echo gh $HOME'`.
- **Known limit, pre-existing and not new here:** a raw REST merge whose URL is built at run time
  (`curl …/pulls/1/$m`) is not text any guard can read. The server-side backstop (no admin override on
  `main`) is Mason's decision.
- **Proof:** the three real guard hooks, run as subprocesses on 41 commands: every round-1, round-2 and
  round-3 attack is refused by the guard responsible for it, and the harmless controls pass (the Codex
  guard's pre-existing `node -e` ban aside). Each answer took 40–65 ms. Bash 5.3 was run on each
  here-document and pipe form to confirm how a real shell reads it. `test:correction-guards` and the
  Codex production-guard tests pass.
