## 2026-09-08 — PR #605: native edits of a protected path through a non-canonical spelling deny in every mode

GitHub Codex (P1 on `ac5758f03`, thread on `settings.json:216`), probe-confirmed: the native editors
are gated by the settings `ask` globs, and a glob matches the spelling it is given, so
`MultiEdit $ROOT/.github/scripts/../workflows/ci.yml` prompted nothing while the filesystem landed on
`ci.yml`. `review-proof-guard.mjs` exempted the native editors because the prompt is their boundary,
and only armed autopilot canonicalised (the previous commit); under the default `acceptEdits` mode
every registered PreToolUse hook answered allow or stayed silent.

Fix by class: the exemption is sound only when the spelling IS the canonical path. `review-proof-guard`
now denies a native Write/Edit/MultiEdit/NotebookEdit whose path is non-canonical (a `.`/`..` segment,
a repeated or trailing separator) and whose canonical form is on the enforcement surface, or which still
escapes the tree after resolution, in every mode; the message says to re-issue with the canonical path so
the prompt fires. Backslashes are not counted as non-canonical (Windows spellings are what the editors
send here and the globs are measured against them). The resolver and the enforcement regex the
path-field rule already used are hoisted and shared, so both rules judge the same surface.

Proof: seven deny cases and four allow cases in `review-proof-guard.test.mjs`;
`protected-surface-parity.test.mjs` runs the real hook on a `./` prefix, a `zz/../` traversal and a
doubled separator for every protected sample and requires the canonical spelling to stay silent. The
previous hook, swapped in place, fails at the Windows `..` spelling of `ci.yml`.
