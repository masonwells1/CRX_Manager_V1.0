## 2026-08-26 — the stop hook and the safety guide now point at fragments, not the shared file

Three findings from Codex, all confirmed against the running code before being fixed.

- **The stop hook was undoing the whole change.** `.claude/hooks/stop-wrap.mjs` checks
  whether a session touched a ledger, and its `LEDGER_RES` list did not include
  `docs/changelog.d/`. So a session that followed the new rule exactly — committing a
  dated fragment — was told at the end that it had touched no ledger, and pointed back at
  `docs/CHANGELOG.md` via `log-session.mjs`. The convention would have been fought by the
  tooling on every single session. The hook now imports `ENTRY_RE` from the guard rather
  than re-expressing the pattern, so the hook and pre-commit cannot drift into
  contradicting each other, and its remediation text leads with the fragment path and
  says why: two sessions never write the same file.
- **The canonical safety guide still listed only the legacy ledgers.**
  `docs/workflows/SAFE_DEVELOPMENT_RULES.md` is the document a risky or multi-file session
  is required to read, and it named `CHANGELOG.md` / `manual/*.md` /
  `agent-guardrails.md` / `loops/` and not the new folder — aiming exactly the sessions
  this change targets back at the file they collide on. It now leads with the fragment
  path and states the added-file and heading requirements.
- **A hidden filename was not even an attempted entry.** The exclusion was "any dotfile",
  so `docs/changelog.d/.bad.md` was filtered out before the malformed-path check could
  refuse it. It is now an allowlist of the folder's own furniture by exact name —
  `README.md`, `.markdownlint.yaml`, `.gitkeep`. An allowlist is the right shape here: a
  list of forbidden spellings has to be reopened every time someone finds a new way to
  hide a file.

The first two are the same mistake as the last two rounds wearing different clothes — the
change was enforced but not adopted. A convention that the tooling actively argues with is
not a convention, and no amount of guard hardening would have surfaced this, because the
guard was working correctly the whole time.

103 assertions (was 98). The dotfile fix is mutation-tested: restoring `!rest.startsWith(".")`
turns it red. The shipped CLI refuses a real staged `.bad.md`, and the real stop hook was
executed end-to-end to prove the new cross-tree import resolves and does not fire the
guard's CLI as a side effect.
