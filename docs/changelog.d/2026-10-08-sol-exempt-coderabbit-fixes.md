## 2026-10-08 - Sol exemption: CodeRabbit's two fixes on PR #888

- **`AGENTS.md` names every condition of the exemption.** The sentence listed only CodeRabbit
  APPROVED on the exact head and green checks, then said "Its proof", which an exempt change does
  not have. It now also names the `--match-head-commit` pin and a head that contains GitHub's real
  base, as the guards already enforce, and says "The Sol proof".
- **Root-level files are looked up in the root folder.** In `.claude/hooks/sol-exempt-lib.mjs`,
  the file-kind lookup built a broken folder name for a file with no `/`. No root file can reach
  that lookup today, because the allow-list holds only `docs/` folders, so nothing was ever wrongly
  allowed. The lookup now uses the root folder, so a future list change cannot turn it into a
  misleading denial.

### Proof observed

- `npm run test:correction-guards` passes, including all 48 mutants in `sol-exempt-lib.test.mjs`.
