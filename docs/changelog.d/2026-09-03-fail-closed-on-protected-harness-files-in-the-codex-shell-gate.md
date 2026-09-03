## 2026-09-03 - The Codex shell gate now fails closed on protected harness files

**PR:** #563 (Codex round 12, exact-SHA `gpt-5.6-sol` proof of `312f4a9f0`) · **Files:** `.codex/hooks/production-action-guard.mjs`, its test, `scripts/apply-live-testdata-maintenance-20260812.mjs` (blob re-pin)

## What was wrong

Every shell rule in the Codex production-action guard decided "is this a write?" by
recognising the verb (`SHELL_MUTATION_RE`). A writer the list did not know was, by
construction, not a write. Codex showed by execution that all of these returned
`blocked:false` while overwriting the module the guard imports at startup:

```
Write-Output forged | Tee-Object -FilePath .claude/hooks/codex-bot-review-lib.mjs
echo forged | tee .claude/hooks/codex-bot-review-lib.mjs
install -m 644 forged.mjs .claude/hooks/codex-bot-review-lib.mjs
dd if=forged.mjs of=.claude/hooks/codex-bot-review-lib.mjs
cp forged.mjs .claude/hooks/{codex-bot-review-lib,x}.mjs
cp forged.mjs .claude/hooks/codex-bot-review-l*.mjs
```

The same six pass on `origin/main`'s guard today (probed from an extracted copy), and
`main` does not even catch the plain `cp` to that module. The gap predates this PR; the
PR had narrowed it and this round closes it.

## What changed

- **Fail closed on protected files.** A shell segment that names a protected harness
  file must start with a recognised read-only command word (cat/type/head/tail/grep/rg/
  Get-Content/Select-String/Get-Item/Test-Path/diff/hash tools/ls, the read-only git
  subcommands including `add` and `commit`, or `node <that protected script>`).
  Any other head — a writer, an interpreter, an editor, an unknown tool — is treated as
  a writer and refused. Shell wrappers (`cmd /c`, `bash -c`, `powershell -Command`) are
  unwrapped so a wrapped read stays a read. Commands that name no protected file are
  untouched. This is the stance the Claude-side `review-proof-guard.mjs` has always taken.
- **Brace- and glob-aware matcher.** `{a,b}` groups are expanded before tokenising, and
  a wildcard token is matched against the concrete protected names segment by segment
  from the right, with the same suffix semantics the literal matcher uses.
- `sed`, `perl`, `awk`, `python` are deliberately **not** readers: each has an in-place
  flag the verb list can miss (`sed --in-place`). Read through `cat <file> | sed -n …`.

## Cost, stated plainly

Codex can no longer name a hook file from an unrecognised command, and a wildcard delete
whose pattern could expand to a protected root file (`Remove-Item build\*` → could be
`build/package.json` under the suffix rule) is refused; spell the directory instead.
Both are pinned in the test so nobody "fixes" them back open.

## Proof

Reproduced the six bypasses by execution before the fix; all six deny after. 60-odd
new assertions: the payloads, the classifier on its own, the glob matcher both ways,
brace expansion, the protected-file list pinned against the regex (15 entries, each
also denied through `Write`), 30 read/sanctioned-run canaries. Mutation-checked on a
scratch copy, one rule at a time: with the fail-closed rule disabled all six `tee`-family
payloads return to `allow`; with the glob matcher disabled only the wildcard form does;
with brace expansion disabled only the brace form does; with wrapper unwrapping disabled
the `cmd /c "type …"` read canary flips to deny and nothing else moves. Guard blob
re-pinned from the protection test's printed candidate.
