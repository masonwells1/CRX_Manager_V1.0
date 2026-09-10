## 2026-09-04 - Role membership and escaped configuration gate

- Made SECURITY DEFINER migration review fail closed when the same migration mutates database role membership, which can restore anonymous execution indirectly.
- Made escape-string `set_config` names fail closed rather than relying on incomplete PostgreSQL escape decoding.
- Added regressions for both bypasses.
