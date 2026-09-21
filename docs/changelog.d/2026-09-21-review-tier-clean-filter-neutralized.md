## 2026-09-21 — Luna advisory diff: neutralize git clean/smudge filters

Codex GitHub App finding on #750 (P1), after Sol pass 5 was clean. A `.gitattributes` in the diff
under review can select `filter=<name>`, and `git diff HEAD` (the `--uncommitted` scope) runs that
filter's `clean` program on working-tree files before the reviewer's read-only sandbox exists.
`--no-textconv` does not stop it — a second door to the same class as the textconv finding.

`codex-review` Step 3A now enumerates every filter configured at any git config level and overrides
its `clean` / `smudge` / `process` commands to empty (and `required` to false) for the diff build.

**Proof (executed):** a scratch repo with a configured `filter.pwn.clean` helper and an attacker
`.gitattributes` — the previous flags ran the helper; the shipped recipe (extracted from the skill
file by script) runs it **0** times and still captures both changed files. On this repository, whose
only configured filter is the system-wide Git LFS one, `--base origin/main` extraction still
captures all 21 changed files.
