## 2026-10-08 - Sol exemption mutation check works on a Windows checkout (test only)

The Windows CI job (`Phase 3C Containment (Windows)`) failed on PR #888. Its checkout stores files
with Windows line endings, so the mutation check in `.claude/hooks/sol-exempt-lib.test.mjs` could
not find the text it mutates and stopped before running. The test now reads the module with one
line-ending form. No guard logic changed.

### Proof observed

- The test passes in this checkout and in a fresh clone checked out with Windows line endings
  (`core.autocrlf=true`), the same setting that made the CI job fail.
