## 2026-09-19 - Codex reviewer sandbox: deny credentials under an inherited HOME

**What changed.** `codexReviewerEnvironment()` passes `HOME` and `USERPROFILE` through to the reviewer, and Git Bash can set a `HOME` that differs from `os.homedir()`. The deny list only covered `os.homedir()`, so credential stores under an alternate home stayed readable under the Windows `:root = read` profile. `codexReviewDenyReadPaths()` now walks every home the reviewer can resolve.

Found by the Codex connector on PR #725 at head 87be5b5f1, after the earlier `CODEX_HOME` fix.

**Proof.** `node scripts/write-codex-push-proof.test.mjs` covers a Git Bash home that differs from `os.homedir()` and both appear in the deny list. `node scripts/write-apply-proofs.test.mjs` passes. On this machine `HOME` and `USERPROFILE` resolve to the same folder, so the real deny list is unchanged at 14 paths.
