## 2026-09-09 - Compose review-proof read narrowing with raw patch normalization

Merged the raw Codex `apply_patch` destination normalization from main with the
native single-file read classifier. Read classification retains each tool path's
raw spelling so POSIX symlink-then-`..` resolution still matches the file the OS
opens, while patch and state-directory mutation checks use normalized targets.

The review-proof guard suite passed with the merged behavior, including a
raw-string patch to a real review proof denied alongside a native read of a real
non-proof state-directory flag allowed. No production behavior or database state
was checked by this merge change.
